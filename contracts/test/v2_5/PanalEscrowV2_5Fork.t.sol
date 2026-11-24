// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../src/v2_5/PanalEscrowV2_5.sol";
import "../../src/v2_5/PanalReputationV2_5.sol";
import "../../src/PanalBans.sol";

interface IPermitToken {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function nonces(address) external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @notice Las funciones de congelar del USDC de Circle (FiatToken).
interface ICircle {
    function blacklister() external view returns (address);
    function blacklist(address account) external;
    function unBlacklist(address account) external;
    function isBlacklisted(address account) external view returns (bool);
}

/// @notice El v2.5 contra los contratos reales de Monad mainnet, en un fork:
///         el registro del v2, la reputación del v2 (que se suma), $PANAL y el
///         USDC de Circle, con `permit` de verdad.
///
///         forge test --match-path test/v2_5/PanalEscrowV2_5Fork.t.sol --fork-url https://rpc.monad.xyz
///
///         Sin fork (otra cadena) las pruebas no hacen nada.
contract PanalEscrowV2_5ForkTest is Test {
    address constant REGISTRY = 0x89a812BFb1c35fc814ef25a3E6Ca75068B16Ac51;
    address constant REPUTATION_V2 = 0xAa15923A93B7A2261D051F9F4302ca05e9a16701;
    address constant PANAL = 0x2E2e44E7FA6178822D4397299F719e89d1a67777;
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant MULTISIG_DUENO = 0xd1AA9e0b6c4215740d464847210e5CCfDce7d7A1;
    address constant JUECES = 0xc384C1F5D6716571DA84329BeAaE6F064C6b1Fe0;
    /// Lint: un agente real, activo y con historial en el v2.
    address constant LINT = 0x1558cF6aed695F3F8AafE488058EfE28d216E69C;

    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    PanalEscrowV2_5 escrow;
    PanalReputationV2_5 rep;
    uint256 clientKey = 0xC11E;
    address client;
    PanalReputationV2_5.Reputation antes;

    function setUp() public {
        if (block.chainid != 143) return;
        client = vm.addr(clientKey);
        rep = new PanalReputationV2_5(REPUTATION_V2);
        escrow = new PanalEscrowV2_5(REGISTRY, address(rep), address(new PanalBans(MULTISIG_DUENO)), MULTISIG_DUENO, MULTISIG_DUENO, JUECES, PANAL, USDC);
        rep.setEscrow(address(escrow));
        antes = rep.getReputation(LINT);
        deal(USDC, client, 100e6);
        deal(PANAL, client, 1_000e18);
        vm.deal(client, 10 ether);
    }

    function _p(address currency, uint256 amount) internal view returns (PanalEscrowV2_5.NewTask memory p) {
        p.worker = LINT;
        p.taskHash = keccak256("encargo de prueba en el fork");
        p.deadline = uint64(block.timestamp + 1 days);
        p.acceptWindow = 1 hours;
        p.reviewWindow = 72 hours;
        p.currency = currency;
        p.amount = amount;
    }

    function _permit(address token, uint256 value) internal view returns (PanalEscrowV2_5.Permit memory s) {
        s.deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, client, address(escrow), value, IPermitToken(token).nonces(client), s.deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IPermitToken(token).DOMAIN_SEPARATOR(), structHash));
        (s.v, s.r, s.s) = vm.sign(clientKey, digest);
    }

    function test_SeConectaALosContratosReales() public view {
        if (block.chainid != 143) return;
        assertEq(escrow.USDC_TOKEN(), USDC);
        assertEq(IPermitToken(USDC).decimals(), 6);
        assertEq(escrow.owner(), MULTISIG_DUENO);
        assertEq(escrow.arbitrator(), JUECES);
        assertEq(address(rep.previous()), REPUTATION_V2);
        assertGt(antes.tasksCompleted, 0, "Lint trae su historial del v2");
    }

    /// Un encargo en USDC de verdad: firma `permit` de Circle, una sola
    /// transacción, entrega, pasan las 72 h y Lint cobra sin que nadie apruebe.
    function test_EncargoEnUsdcConPermitYLiberacionPorTiempo() public {
        if (block.chainid != 143) return;
        PanalEscrowV2_5.Permit memory s = _permit(USDC, 10e6);
        vm.prank(client);
        uint256 id = escrow.createTaskWithPermit(_p(USDC, 10e6), s);
        assertEq(IPermitToken(USDC).balanceOf(address(escrow)), 10e6);

        vm.prank(LINT);
        escrow.deliverResult(id, keccak256("entrega"));
        vm.warp(block.timestamp + 72 hours);

        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        uint256 saldo = IPermitToken(USDC).balanceOf(LINT);
        vm.prank(LINT);
        escrow.releaseAndWithdraw(ids, USDC);
        assertEq(IPermitToken(USDC).balanceOf(LINT) - saldo, 9_750_000, "97,5 % de 10 USDC");
        assertEq(escrow.pendingWithdrawals(USDC, MULTISIG_DUENO), 250_000, "2,5 % para el multisig");

        PanalReputationV2_5.Reputation memory r = rep.getReputation(LINT);
        assertEq(r.tasksCompleted, antes.tasksCompleted + 1, "suma el v2 y el v2.5");
        assertEq(r.ratingCount, antes.ratingCount, "liberado por tiempo: sin nota");
        assertEq(rep.earned(LINT, USDC), 9_750_000);
    }

    /// Un encargo en $PANAL con su `permit` real, aprobado con nota.
    function test_EncargoEnPanalConPermitAprobado() public {
        if (block.chainid != 143) return;
        PanalEscrowV2_5.Permit memory s = _permit(PANAL, 40e18);
        vm.prank(client);
        uint256 id = escrow.createTaskWithPermit(_p(PANAL, 40e18), s);
        vm.prank(LINT);
        escrow.deliverResult(id, keccak256("entrega"));
        vm.prank(client);
        escrow.approveAndRelease(id, 5);
        assertEq(escrow.pendingWithdrawals(PANAL, LINT), 39.4e18, "40 $PANAL menos el 1,5 %");
        assertEq(escrow.pendingWithdrawals(PANAL, MULTISIG_DUENO), 0.6e18);

        PanalReputationV2_5.Reputation memory r = rep.getReputation(LINT);
        assertEq(r.ratingSum, antes.ratingSum + 5);
        assertEq(r.ratingCount, antes.ratingCount + 1);
    }

    /// Circle congela a un agente: su USDC se queda acreditado sin poder salir,
    /// pero nadie más se queda atascado. El cliente cobra su parte, la comisión
    /// sale, y el resto de encargos en USDC siguen funcionando.
    function test_UsdcCongeladoNoAtascaANadieMas() public {
        if (block.chainid != 143) return;
        vm.prank(client);
        (bool ok,) = USDC.call(abi.encodeWithSignature("approve(address,uint256)", address(escrow), 20e6));
        assertTrue(ok);
        vm.prank(client);
        uint256 id = escrow.createTask(_p(USDC, 10e6));
        vm.prank(LINT);
        escrow.deliverResult(id, keccak256("entrega"));
        vm.prank(client);
        escrow.openDispute(id, bytes32(0));

        // Circle congela a Lint (con su propia cuenta de congelar, en el fork).
        vm.prank(ICircle(USDC).blacklister());
        ICircle(USDC).blacklist(LINT);
        assertTrue(ICircle(USDC).isBlacklisted(LINT));

        // Los jueces reparten igual: acreditar no mueve tokens.
        vm.prank(JUECES);
        escrow.resolveDispute(id, 5_000, 3, bytes32(0));

        vm.prank(LINT);
        vm.expectRevert();
        escrow.withdraw(USDC);
        assertEq(escrow.pendingWithdrawals(USDC, LINT), 4_875_000, "se queda acreditado, no se pierde");

        uint256 saldoCliente = IPermitToken(USDC).balanceOf(client);
        vm.prank(client);
        escrow.withdraw(USDC);
        assertEq(IPermitToken(USDC).balanceOf(client) - saldoCliente, 5_000_000, "el cliente cobra su mitad");

        // Otro encargo en USDC, con otro agente, sigue como siempre.
        address otro = 0x14cd0Db920360ca93FC3b3B2909D4B69872525C4;
        PanalEscrowV2_5.NewTask memory p = _p(USDC, 10e6);
        p.worker = otro;
        p.taskHash = keccak256("otro encargo");
        vm.prank(client);
        uint256 id2 = escrow.createTask(p);
        vm.prank(otro);
        escrow.deliverResult(id2, keccak256("entrega"));
        vm.prank(client);
        escrow.approveAndRelease(id2, 5);
        vm.prank(otro);
        escrow.withdraw(USDC);
        assertEq(IPermitToken(USDC).balanceOf(otro) >= 9_750_000, true);

        // Y si Circle lo descongela, Lint cobra lo suyo.
        vm.prank(ICircle(USDC).blacklister());
        ICircle(USDC).unBlacklist(LINT);
        vm.prank(LINT);
        escrow.withdraw(USDC);
        assertEq(escrow.pendingWithdrawals(USDC, LINT), 0);
    }

    /// En MON, y sin entrega: pasado el plazo cualquiera devuelve el dinero.
    function test_EncargoEnMonVencidoLoDevuelveCualquiera() public {
        if (block.chainid != 143) return;
        vm.prank(client);
        uint256 id = escrow.createTask{value: 1 ether}(_p(address(0), 1 ether));
        vm.warp(block.timestamp + 1 days + 1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(makeAddr("cualquiera"));
        assertEq(escrow.refundExpired(ids), 1);
        assertEq(escrow.pendingWithdrawals(address(0), client), 1 ether);
    }
}
