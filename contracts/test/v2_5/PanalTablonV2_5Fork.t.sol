// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../src/v2_5/PanalEscrowV2_5.sol";
import "../../src/v2_5/PanalReputationV2_5.sol";
import "../../src/v2_5/PanalTablonV2_5.sol";
import "../../src/PanalBans.sol";

/// @notice Las funciones de congelar del USDC de Circle (FiatToken).
interface ICircleTablon {
    function blacklister() external view returns (address);
    function blacklist(address account) external;
    function unBlacklist(address account) external;
}

/// @notice Ensayo del despliegue del tablón v2.5 contra una copia de Monad mainnet.
///
///         Se despliegan aquí PanalBans, la reputación v2.5 (que suma la del v2
///         real), el escrow v2.5 y el tablón v2.5, con los contratos reales
///         alrededor: el registro del v2, $PANAL, el USDC de Circle, el multisig
///         dueño y el de los jueces. Un agente que existe de verdad (Lint) hace
///         encargos enteros en MON, $PANAL y USDC.
///
///         forge test --match-path test/v2_5/PanalTablonV2_5Fork.t.sol --fork-url https://rpc.monad.xyz
///
///         Sin fork (otra cadena) las pruebas no hacen nada.
contract PanalTablonV2_5ForkTest is Test {
    address constant REGISTRY = 0x89a812BFb1c35fc814ef25a3E6Ca75068B16Ac51;
    address constant REPUTATION_V2 = 0xAa15923A93B7A2261D051F9F4302ca05e9a16701;
    address constant PANAL_TOKEN = 0x2E2e44E7FA6178822D4397299F719e89d1a67777;
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant MULTISIG_DUENO = 0xd1AA9e0b6c4215740d464847210e5CCfDce7d7A1;
    address constant JUECES = 0xc384C1F5D6716571DA84329BeAaE6F064C6b1Fe0;

    /// Agente real, registrado y activo en mainnet.
    address constant LINT = 0x1558cF6aed695F3F8AafE488058EfE28d216E69C;

    PanalBans bans;
    PanalReputationV2_5 rep;
    PanalEscrowV2_5 escrow;
    PanalTablonV2_5 tablon;
    address client = makeAddr("cliente-fork");
    address client2 = makeAddr("cliente-fork-2");

    function setUp() public {
        if (block.chainid != 143) return;
        bans = new PanalBans(MULTISIG_DUENO);
        rep = new PanalReputationV2_5(REPUTATION_V2);
        escrow = new PanalEscrowV2_5(
            REGISTRY, address(rep), address(bans), MULTISIG_DUENO, MULTISIG_DUENO, JUECES, PANAL_TOKEN, USDC
        );
        rep.setEscrow(address(escrow));

        PanalTablonV2_5.Level[5] memory l;
        l[0] = PanalTablonV2_5.Level(5, 400, 1);
        l[1] = PanalTablonV2_5.Level(30, 420, 5);
        l[2] = PanalTablonV2_5.Level(100, 440, 15);
        l[3] = PanalTablonV2_5.Level(300, 450, 40);
        l[4] = PanalTablonV2_5.Level(1000, 460, 100);
        tablon = new PanalTablonV2_5(
            address(escrow),
            MULTISIG_DUENO,
            l,
            2,
            PanalTablonV2_5.Caps(500 ether, 1000 ether),
            PanalTablonV2_5.Caps(2_066_000e18, 4_133_000e18),
            PanalTablonV2_5.Caps(10_000e6, 20_000e6)
        );

        uint8[] memory cats = new uint8[](1);
        vm.prank(LINT);
        tablon.setCategories(cats);

        address[2] memory cs = [client, client2];
        for (uint256 i; i < 2; i++) {
            vm.deal(cs[i], 100 ether);
            deal(PANAL_TOKEN, cs[i], 1_000e18);
            deal(USDC, cs[i], 1_000e6);
            vm.startPrank(cs[i]);
            ITablonToken(PANAL_TOKEN).approve(address(tablon), type(uint256).max);
            ITablonToken(USDC).approve(address(tablon), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _params(address currency, uint256 amount) internal view returns (PanalTablonV2_5.PostParams memory p) {
        p.taskHash = keccak256("encargo de prueba");
        p.currency = currency;
        p.amount = amount;
        p.workDuration = 1 days;
        p.expiresAt = uint64(block.timestamp + 7 days);
        p.reviewWindow = 72 hours;
        p.mode = PanalTablonV2_5.Mode.Immediate;
    }

    function test_se_conecta_a_los_contratos_reales() public view {
        if (block.chainid != 143) return;
        assertEq(address(tablon.escrow()), address(escrow));
        assertEq(address(tablon.registry()), REGISTRY);
        assertEq(address(tablon.reputation()), address(rep));
        assertEq(address(tablon.bans()), address(bans));
        assertEq(tablon.PANAL_TOKEN(), PANAL_TOKEN);
        assertEq(tablon.USDC_TOKEN(), USDC);
        assertEq(tablon.MIN_NATIVE(), 0.001 ether);
        assertEq(tablon.MIN_PANAL(), 1e18);
        assertEq(tablon.MIN_USDC(), 1e4);
        assertEq(tablon.owner(), MULTISIG_DUENO);
    }

    function test_la_reputacion_del_v2_cuenta_para_el_nivel() public view {
        if (block.chainid != 143) return;
        PanalReputationV2_5.Reputation memory r = rep.getReputation(LINT);
        (uint8 level,) = tablon.levelOf(LINT);
        console.log("Lint: completadas", r.tasksCompleted, "nivel", level);
        assertGt(r.tasksCompleted, 0, "suma la del v2");
        if (r.tasksCompleted >= 5 && r.ratingCount > 0 && (r.ratingSum * 100) / r.ratingCount >= 400) {
            assertGe(level, 1);
        } else {
            assertEq(level, 0);
        }
    }

    function _deEntregaACobro(uint256 id, address currency, uint256 amount, uint256 feeBps) internal {
        PanalTablonV2_5.Job memory j = tablon.getJob(id);
        PanalEscrowV2_5.Task memory t = escrow.getTask(j.escrowTaskId);
        assertEq(t.client, address(tablon), "en el escrow el cliente es el tablon");
        assertEq(t.worker, LINT, "la tarea nace asignada");
        assertEq(t.amount, amount);

        uint256 antes = escrow.pendingWithdrawals(currency, LINT);
        vm.prank(LINT);
        escrow.deliverResult(j.escrowTaskId, keccak256("resultado"));
        vm.prank(j.client);
        tablon.approve(id, 5);
        assertEq(escrow.pendingWithdrawals(currency, LINT) - antes, amount - (amount * feeBps) / 10_000);
        assertEq(uint8(tablon.getJob(id).state), uint8(PanalTablonV2_5.State.Closed));
    }

    function test_un_agente_real_hace_un_encargo_en_MON() public {
        if (block.chainid != 143) return;
        vm.prank(client);
        uint256 id = tablon.post{value: 2 ether}(_params(address(0), 2 ether));
        vm.prank(LINT);
        tablon.take(id);
        _deEntregaACobro(id, address(0), 2 ether, 250);
    }

    function test_un_agente_real_hace_un_encargo_en_PANAL() public {
        if (block.chainid != 143) return;
        vm.prank(client);
        uint256 id = tablon.post(_params(PANAL_TOKEN, 100e18));
        vm.prank(LINT);
        tablon.take(id);
        assertEq(ITablonToken(PANAL_TOKEN).allowance(address(tablon), address(escrow)), 0, "aprobacion a cero");
        _deEntregaACobro(id, PANAL_TOKEN, 100e18, 150);
    }

    function test_un_agente_real_hace_un_encargo_en_USDC() public {
        if (block.chainid != 143) return;
        vm.prank(client);
        uint256 id = tablon.post(_params(USDC, 20e6));
        vm.prank(LINT);
        tablon.take(id);
        assertEq(ITablonToken(USDC).allowance(address(tablon), address(escrow)), 0, "aprobacion a cero");
        _deEntregaACobro(id, USDC, 20e6, 250);
    }

    function test_sin_entrega_se_devuelve_y_se_cobra() public {
        if (block.chainid != 143) return;
        vm.prank(client);
        uint256 id = tablon.post(_params(USDC, 5e6));
        vm.prank(LINT);
        tablon.take(id);
        vm.warp(block.timestamp + 1 days + 1);
        tablon.settle(id);
        uint256 antes = ITablonToken(USDC).balanceOf(client);
        vm.prank(client);
        tablon.claim(USDC);
        assertEq(ITablonToken(USDC).balanceOf(client) - antes, 5e6);
    }

    /// Si Circle congela a un cliente, ese cliente no puede cobrar sus USDC
    /// hasta que lo descongelen; los demás clientes cobran igual. Su deuda no
    /// se pierde: sigue apuntada.
    function test_un_cliente_congelado_por_Circle_no_bloquea_a_los_demas() public {
        if (block.chainid != 143) return;
        vm.prank(client);
        uint256 a = tablon.post(_params(USDC, 7e6));
        vm.prank(client2);
        uint256 b = tablon.post(_params(USDC, 9e6));
        vm.prank(client);
        tablon.withdrawJob(a);
        vm.prank(client2);
        tablon.withdrawJob(b);

        address blacklister = ICircleTablon(USDC).blacklister();
        vm.prank(blacklister);
        ICircleTablon(USDC).blacklist(client);

        vm.prank(client);
        vm.expectRevert(PanalTablonV2_5.TransferFailed.selector);
        tablon.claim(USDC);
        assertEq(tablon.owed(client, USDC), 7e6, "sigue apuntado");

        uint256 antes = ITablonToken(USDC).balanceOf(client2);
        vm.prank(client2);
        tablon.claim(USDC);
        assertEq(ITablonToken(USDC).balanceOf(client2) - antes, 9e6);

        vm.prank(blacklister);
        ICircleTablon(USDC).unBlacklist(client);
        vm.prank(client);
        tablon.claim(USDC);
        assertEq(tablon.owed(client, USDC), 0);
    }

    /// El multisig dueño real suspende a Lint: ya no coge encargos, y el
    /// encargo que tenía sin entregar vuelve al cliente sin esperar al plazo.
    function test_el_multisig_dueno_real_suspende_y_el_tablon_lo_respeta() public {
        if (block.chainid != 143) return;
        vm.prank(client);
        uint256 id = tablon.post{value: 1 ether}(_params(address(0), 1 ether));
        vm.prank(LINT);
        tablon.take(id);

        address[] memory l = new address[](1);
        l[0] = LINT;
        vm.prank(MULTISIG_DUENO); // como si ya hubiera firmado la propuesta
        bans.suspend(l, keccak256("ensayo"));

        tablon.settle(id);
        assertEq(uint8(escrow.getTask(tablon.getJob(id).escrowTaskId).closeReason), uint8(PanalEscrowV2_5.Close.Cancelled));
        assertEq(tablon.owed(client, address(0)), 1 ether);

        vm.prank(client);
        uint256 otro = tablon.post{value: 1 ether}(_params(address(0), 1 ether));
        (bool ok, string memory reason) = tablon.canTake(LINT, otro);
        assertFalse(ok);
        assertEq(reason, "account suspended");
    }
}
