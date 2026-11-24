// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../src/v2_5/PanalEscrowV2_5.sol";
import "../../src/v2_5/PanalReputationV2_5.sol";
import "../../src/v2_5/PanalTablonV2_5.sol";

interface INombres {
    function REGISTRY() external view returns (address);
    function nombreDe(address agente) external view returns (string memory);
    function resolver(string calldata nombre) external view returns (address);
}

interface IReputacionV2 {
    struct ReputationV2 {
        uint256 tasksCompleted;
        uint256 disputesLost;
        uint256 ratingSum;
        uint256 ratingCount;
    }

    function escrow() external view returns (address);
    function getReputation(address agent) external view returns (ReputationV2 memory);
}

/// @notice El v2.5 YA DESPLEGADO (24-nov-2026) con los contratos de antes que
///         reutiliza: el registro, la reputación v2 y los nombres. En una copia
///         de mainnet, un cliente contrata a Lint (un agente real) en el escrow
///         v2.5 y en el tablón v2.5, y se mira qué hace cada contrato de antes.
///
///         forge test --match-path test/v2_5/DesplegadosV2_5Fork.t.sol --fork-url https://rpc.monad.xyz
contract DesplegadosV2_5ForkTest is Test {
    address constant REGISTRY = 0x89a812BFb1c35fc814ef25a3E6Ca75068B16Ac51;
    address constant REPUTATION_V2 = 0xAa15923A93B7A2261D051F9F4302ca05e9a16701;
    address constant ESCROW_V2 = 0xe138A9A492CFe27A13f8b7A6D312DA831791bCe9;
    address constant NAMES = 0xc94a8107C87859cAd2E472e71BbE25c15cdD614A;
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;

    PanalEscrowV2_5 constant ESCROW = PanalEscrowV2_5(payable(0x1800225eac5cEF7798e2A926AE243F2a4a42D440));
    PanalReputationV2_5 constant REP = PanalReputationV2_5(0xc8f91E7718835cAEf5e36452705B8922c857624e);
    PanalTablonV2_5 constant TABLON = PanalTablonV2_5(payable(0x10aF8A30591Fcee56127692d7346476bc68CD656));

    address constant LINT = 0x1558cF6aed695F3F8AafE488058EfE28d216E69C;
    address client = makeAddr("cliente-de-prueba");

    function setUp() public {
        if (block.chainid != 143) return;
        deal(USDC, client, 100e6);
        vm.deal(client, 10 ether);
    }

    function test_los_desplegados_apuntan_a_los_contratos_de_antes() public view {
        if (block.chainid != 143) return;
        assertEq(address(ESCROW.registry()), REGISTRY, "el escrow v2.5 usa el registro de siempre");
        assertEq(address(REP.previous()), REPUTATION_V2, "la reputacion v2.5 suma la v2");
        assertEq(REP.escrow(), address(ESCROW));
        assertEq(address(TABLON.registry()), REGISTRY);
        assertEq(INombres(NAMES).REGISTRY(), REGISTRY, "los nombres leen el mismo registro");
        // La reputación v2 solo la escribe el escrow v2, y eso no se puede cambiar.
        assertEq(IReputacionV2(REPUTATION_V2).escrow(), ESCROW_V2);
    }

    function test_un_encargo_en_el_escrow_v2_5_con_lint() public {
        if (block.chainid != 143) return;
        string memory nombre = INombres(NAMES).nombreDe(LINT);
        console.log("Nombre de Lint en PanalNames:", nombre);
        assertEq(INombres(NAMES).resolver(nombre), LINT, "su nombre sigue siendo suyo");

        IReputacionV2.ReputationV2 memory v2Antes = IReputacionV2(REPUTATION_V2).getReputation(LINT);
        PanalReputationV2_5.Reputation memory antes = REP.getReputation(LINT);
        assertEq(antes.tasksCompleted, v2Antes.tasksCompleted, "hoy la v2.5 es exactamente la v2");

        // El registro de siempre dice que Lint es un agente activo: el escrow v2.5 le deja trabajar.
        PanalEscrowV2_5.NewTask memory p;
        p.worker = LINT;
        p.taskHash = keccak256("encargo de prueba");
        p.deadline = uint64(block.timestamp + 1 days);
        p.acceptWindow = 1 hours;
        p.reviewWindow = 72 hours;
        p.currency = USDC;
        p.amount = 10e6;
        vm.startPrank(client);
        ITablonToken(USDC).approve(address(ESCROW), 10e6);
        uint256 id = ESCROW.createTask(p);
        vm.stopPrank();
        vm.prank(LINT);
        ESCROW.deliverResult(id, keccak256("resultado"));
        vm.prank(client);
        ESCROW.approveAndRelease(id, 5);
        assertEq(ESCROW.pendingWithdrawals(USDC, LINT), 9.75e6);

        // La reputación v2.5 apunta el encargo y sigue sumando la v2; la v2 no cambia.
        PanalReputationV2_5.Reputation memory despues = REP.getReputation(LINT);
        assertEq(despues.tasksCompleted, antes.tasksCompleted + 1);
        assertEq(despues.ratingSum, antes.ratingSum + 5);
        assertEq(REP.getOwnReputation(LINT).tasksCompleted, 1, "lo nuevo, en la v2.5");
        assertEq(IReputacionV2(REPUTATION_V2).getReputation(LINT).tasksCompleted, v2Antes.tasksCompleted);
        console.log("Lint, completados (v2 + v2.5):", despues.tasksCompleted);
    }

    function test_un_encargo_en_el_tablon_v2_5_con_lint() public {
        if (block.chainid != 143) return;
        uint8[] memory cats = new uint8[](1);
        vm.prank(LINT);
        TABLON.setCategories(cats);

        PanalTablonV2_5.PostParams memory p;
        p.taskHash = keccak256("encargo del tablon");
        p.currency = address(0);
        p.amount = 1 ether;
        p.workDuration = 1 days;
        p.expiresAt = uint64(block.timestamp + 7 days);
        p.reviewWindow = 72 hours;
        vm.prank(client);
        uint256 jobId = TABLON.post{value: 1 ether}(p);

        // El nivel sale de la reputación v2 (vía la v2.5): Lint no llega como novato.
        (uint8 nivel,) = TABLON.levelOf(LINT);
        assertGe(nivel, 1);
        vm.prank(LINT);
        TABLON.take(jobId);
        uint256 tid = TABLON.getJob(jobId).escrowTaskId;
        vm.prank(LINT);
        ESCROW.deliverResult(tid, keccak256("resultado"));
        vm.prank(client);
        TABLON.approve(jobId, 5);
        assertEq(ESCROW.pendingWithdrawals(address(0), LINT), 0.975 ether);
    }
}
