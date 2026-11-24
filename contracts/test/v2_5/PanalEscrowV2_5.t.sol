// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../src/v2_5/PanalEscrowV2_5.sol";
import "../../src/v2_5/PanalReputationV2_5.sol";
import "../../src/v2/PanalRegistryV2.sol";
import "../../src/PanalReputation.sol";
import "../../src/PanalBans.sol";
import "./mocks/MockPermitToken.sol";

/// @notice Lo común: registro real del v2, reputación del v2 con historial (la
///         «anterior») y la reputación v2.5 que la lee, $PANAL y USDC de prueba.
abstract contract EscrowV2_5Base is Test {
    PanalEscrowV2_5 escrow;
    PanalReputationV2_5 rep;
    PanalReputation repV2;
    PanalRegistryV2 registry;
    PanalBans bans;
    MockPermitToken panal;
    MockPermitToken usdc;

    address owner = makeAddr("multisigDueno");
    address treasury = makeAddr("tesoreria");
    address arbitrator = makeAddr("jueces");
    address worker = makeAddr("agente");
    address worker2 = makeAddr("agente2");
    address rando = makeAddr("cualquiera");
    address oldEscrow = makeAddr("escrowV2");
    uint256 clientKey = 0xC11E;
    address client;

    bytes32 constant TASK = keccak256("lo acordado");
    bytes32 constant RESULT = keccak256("lo entregado");
    address constant MON = address(0);

    function setUp() public virtual {
        client = vm.addr(clientKey);
        panal = new MockPermitToken("PANAL", "PANAL", "1", 18);
        usdc = new MockPermitToken("USDC", "USDC", "2", 6);
        registry = new PanalRegistryV2(address(panal));

        // La reputación del v2, con historial propio, como la de mainnet.
        repV2 = new PanalReputation();
        repV2.setEscrow(oldEscrow);
        vm.startPrank(oldEscrow);
        repV2.recordCompletion(worker, 5, 1 ether);
        repV2.recordCompletion(worker, 4, 1 ether);
        vm.stopPrank();

        rep = new PanalReputationV2_5(address(repV2));
        bans = new PanalBans(owner);
        escrow = new PanalEscrowV2_5(address(registry), address(rep), address(bans), owner, treasury, arbitrator, address(panal), address(usdc));
        rep.setEscrow(address(escrow));

        vm.prank(worker);
        registry.registerAgent("ipfs://agente", 1 ether, MON);
        vm.prank(worker2);
        registry.registerAgent("ipfs://agente2", 1 ether, MON);

        vm.deal(client, 1_000 ether);
        vm.deal(rando, 10 ether);
        panal.mint(client, 1_000_000e18);
        usdc.mint(client, 1_000_000e6);
        vm.startPrank(client);
        panal.approve(address(escrow), type(uint256).max);
        usdc.approve(address(escrow), type(uint256).max);
        vm.stopPrank();
    }

    function _p(address w, address currency, uint256 amount) internal view returns (PanalEscrowV2_5.NewTask memory p) {
        p.worker = w;
        p.taskHash = TASK;
        p.deadline = uint64(block.timestamp + 1 days);
        p.acceptWindow = 1 hours;
        p.reviewWindow = 72 hours;
        p.currency = currency;
        p.amount = amount;
    }

    function _create(PanalEscrowV2_5.NewTask memory p) internal returns (uint256 id) {
        vm.prank(client);
        id = escrow.createTask{value: p.currency == MON ? p.amount : 0}(p);
    }

    function _createMon(uint256 amount) internal returns (uint256) {
        return _create(_p(worker, MON, amount));
    }

    function _delivered(uint256 amount) internal returns (uint256 id) {
        id = _createMon(amount);
        vm.prank(worker);
        escrow.deliverResult(id, RESULT);
    }

    function _status(uint256 id) internal view returns (PanalEscrowV2_5.Status) {
        return escrow.getTask(id).status;
    }

    function _reason(uint256 id) internal view returns (PanalEscrowV2_5.Close) {
        return escrow.getTask(id).closeReason;
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function _ids(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory r) {
        r = new uint256[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }
}

contract PanalEscrowV2_5Test is EscrowV2_5Base {
    // ─────────────────────────────────────────────────────────── despliegue

    function test_ConstructorSetsRolesAndDeployerHasNone() public view {
        assertEq(escrow.owner(), owner);
        assertEq(escrow.treasury(), treasury);
        assertEq(escrow.arbitrator(), arbitrator);
        assertEq(escrow.PANAL_TOKEN(), address(panal));
        assertEq(escrow.USDC_TOKEN(), address(usdc));
        assertTrue(escrow.owner() != address(this), "quien despliega no es dueno");
    }

    function test_ConstructorRejectsLinkedReputation() public {
        vm.expectRevert("PanalEscrowV2_5: reputation already linked");
        new PanalEscrowV2_5(address(registry), address(rep), address(bans), owner, treasury, arbitrator, address(panal), address(usdc));
    }

    function test_ConstructorRejectsTokenMismatch() public {
        PanalReputationV2_5 r = new PanalReputationV2_5(address(0));
        vm.expectRevert("PanalEscrowV2_5: token mismatch");
        new PanalEscrowV2_5(address(registry), address(r), address(bans), owner, treasury, arbitrator, address(usdc), address(usdc));
    }

    function test_ConstructorRejectsUsdcEqualToPanal() public {
        PanalReputationV2_5 r = new PanalReputationV2_5(address(0));
        vm.expectRevert("PanalEscrowV2_5: invalid usdc");
        new PanalEscrowV2_5(address(registry), address(r), address(bans), owner, treasury, arbitrator, address(panal), address(panal));
    }

    // ─────────────────────────────────────────────────────────── contratar

    function test_CreateNativeStoresEverything() public {
        PanalEscrowV2_5.NewTask memory p = _p(worker, MON, 1 ether);
        vm.expectEmit(true, true, true, true);
        emit PanalEscrowV2_5.TaskCreated(
            0, client, worker, MON, 1 ether, TASK, p.deadline, uint64(block.timestamp + 1 hours), 72 hours
        );
        uint256 id = _create(p);

        PanalEscrowV2_5.Task memory t = escrow.getTask(id);
        assertEq(t.client, client);
        assertEq(t.worker, worker);
        assertEq(t.amount, 1 ether);
        assertEq(t.deadline, p.deadline);
        assertEq(t.acceptBy, block.timestamp + 1 hours);
        assertEq(t.reviewWindow, 72 hours);
        assertEq(t.taskHash, TASK);
        assertEq(uint8(t.status), uint8(PanalEscrowV2_5.Status.Open));
        assertEq(address(escrow).balance, 1 ether);
        assertEq(escrow.getTaskCount(), 1);
    }

    function test_CreateValidations() public {
        PanalEscrowV2_5.NewTask memory p;

        p = _p(worker, makeAddr("otroToken"), 1 ether);
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: unsupported currency");
        escrow.createTask(p);

        p = _p(worker, MON, 1 ether);
        p.taskHash = bytes32(0);
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: empty task");
        escrow.createTask{value: 1 ether}(p);

        p = _p(client, MON, 1 ether);
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: no self-task");
        escrow.createTask{value: 1 ether}(p);

        p = _p(rando, MON, 1 ether);
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: worker not active agent");
        escrow.createTask{value: 1 ether}(p);

        p = _p(worker, MON, 1 ether);
        p.deadline = uint64(block.timestamp);
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: invalid deadline");
        escrow.createTask{value: 1 ether}(p);

        p = _p(worker, MON, 1 ether);
        p.deadline = uint64(block.timestamp + 366 days);
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: too long");
        escrow.createTask{value: 1 ether}(p);

        p = _p(worker, MON, 1 ether);
        p.acceptWindow = 4 minutes;
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: accept window too short");
        escrow.createTask{value: 1 ether}(p);

        p = _p(worker, MON, 1 ether);
        p.acceptWindow = 2 days;
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: accept window past deadline");
        escrow.createTask{value: 1 ether}(p);

        p = _p(worker, MON, 1 ether);
        p.reviewWindow = 23 hours;
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: invalid review window");
        escrow.createTask{value: 1 ether}(p);

        p.reviewWindow = 7 days + 1;
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: invalid review window");
        escrow.createTask{value: 1 ether}(p);

        p = _p(worker, MON, 1 ether);
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: amount mismatch");
        escrow.createTask{value: 0.5 ether}(p);

        p = _p(worker, MON, 0.0009 ether);
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: below minimum");
        escrow.createTask{value: 0.0009 ether}(p);

        p = _p(worker, address(usdc), 9_999);
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: below minimum");
        escrow.createTask(p);

        p = _p(worker, address(panal), 0.5e18);
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: below minimum");
        escrow.createTask(p);

        p = _p(worker, address(usdc), 1e6);
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: unexpected native value");
        escrow.createTask{value: 1}(p);
    }

    function test_ReviewWindowBoundsAreInclusive() public {
        PanalEscrowV2_5.NewTask memory p = _p(worker, MON, 1 ether);
        p.reviewWindow = 24 hours;
        _create(p);
        p.reviewWindow = 7 days;
        _create(p);
        assertEq(escrow.getTaskCount(), 2);
    }

    function test_CreateUsdcWithApprove() public {
        uint256 id = _create(_p(worker, address(usdc), 25e6));
        assertEq(usdc.balanceOf(address(escrow)), 25e6);
        assertEq(escrow.getTask(id).amount, 25e6);
        assertEq(escrow.getTask(id).currency, address(usdc));
    }

    function _permitSig(MockPermitToken token, uint256 value, uint256 deadline)
        internal
        view
        returns (PanalEscrowV2_5.Permit memory s)
    {
        bytes32 structHash =
            keccak256(abi.encode(token.PERMIT_TYPEHASH(), client, address(escrow), value, token.nonces(client), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (s.v, s.r, s.s) = vm.sign(clientKey, digest);
        s.deadline = deadline;
    }

    function test_CreateUsdcWithPermitInOneTransaction() public {
        vm.prank(client);
        usdc.approve(address(escrow), 0);
        PanalEscrowV2_5.Permit memory s = _permitSig(usdc, 10e6, block.timestamp + 1 hours);
        vm.prank(client);
        uint256 id = escrow.createTaskWithPermit(_p(worker, address(usdc), 10e6), s);
        assertEq(escrow.getTask(id).amount, 10e6);
        assertEq(usdc.balanceOf(address(escrow)), 10e6);
    }

    function test_PermitFrontRunStillWorks() public {
        vm.prank(client);
        panal.approve(address(escrow), 0);
        PanalEscrowV2_5.Permit memory s = _permitSig(panal, 50e18, block.timestamp + 1 hours);
        // Alguien ve la firma y la usa antes: la autorización ya está puesta.
        panal.permit(client, address(escrow), 50e18, s.deadline, s.v, s.r, s.s);
        vm.prank(client);
        uint256 id = escrow.createTaskWithPermit(_p(worker, address(panal), 50e18), s);
        assertEq(escrow.getTask(id).amount, 50e18);
    }

    function test_PermitNeedsAToken() public {
        PanalEscrowV2_5.Permit memory s;
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: permit needs a token");
        escrow.createTaskWithPermit(_p(worker, MON, 1 ether), s);
    }

    // ─────────────────────────────────────────────────────────── aceptar (B1)

    function test_AcceptWithinWindow() public {
        uint256 id = _createMon(1 ether);
        vm.expectEmit(true, true, false, false);
        emit PanalEscrowV2_5.TaskAccepted(id, worker);
        vm.prank(worker);
        escrow.acceptTask(id);
        assertEq(uint8(_status(id)), uint8(PanalEscrowV2_5.Status.Accepted));
    }

    function test_AcceptAfterWindowReverts() public {
        uint256 id = _createMon(1 ether);
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(worker);
        vm.expectRevert("PanalEscrowV2_5: accept window over");
        escrow.acceptTask(id);
    }

    function test_OnlyWorkerAccepts() public {
        uint256 id = _createMon(1 ether);
        vm.prank(rando);
        vm.expectRevert("PanalEscrowV2_5: not worker");
        escrow.acceptTask(id);
    }

    function test_DeliveringCountsAsAccepting() public {
        uint256 id = _createMon(1 ether);
        vm.expectEmit(true, true, false, false);
        emit PanalEscrowV2_5.TaskAccepted(id, worker);
        vm.prank(worker);
        escrow.deliverResult(id, RESULT);
        PanalEscrowV2_5.Task memory t = escrow.getTask(id);
        assertEq(uint8(t.status), uint8(PanalEscrowV2_5.Status.Delivered));
        assertEq(t.resultHash, RESULT);
        assertEq(t.deliveredAt, block.timestamp);
    }

    function test_DeliverWithoutAcceptingAfterWindowReverts() public {
        uint256 id = _createMon(1 ether);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(worker);
        vm.expectRevert("PanalEscrowV2_5: accept window over");
        escrow.deliverResult(id, RESULT);
    }

    function test_AcceptedCanDeliverAfterAcceptWindow() public {
        uint256 id = _createMon(1 ether);
        vm.prank(worker);
        escrow.acceptTask(id);
        vm.warp(block.timestamp + 20 hours);
        vm.prank(worker);
        escrow.deliverResult(id, RESULT);
        assertEq(uint8(_status(id)), uint8(PanalEscrowV2_5.Status.Delivered));
    }

    function test_DeliverAfterDeadlineReverts() public {
        uint256 id = _createMon(1 ether);
        vm.prank(worker);
        escrow.acceptTask(id);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(worker);
        vm.expectRevert("PanalEscrowV2_5: deadline passed");
        escrow.deliverResult(id, RESULT);
    }

    function test_DeliverValidations() public {
        uint256 id = _createMon(1 ether);
        vm.prank(rando);
        vm.expectRevert("PanalEscrowV2_5: not worker");
        escrow.deliverResult(id, RESULT);
        vm.prank(worker);
        vm.expectRevert("PanalEscrowV2_5: empty result");
        escrow.deliverResult(id, bytes32(0));
    }

    function test_ClaimOpenTask() public {
        uint256 id = _create(_p(address(0), MON, 1 ether));
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: no self-task");
        escrow.claimTask(id);
        vm.prank(rando);
        vm.expectRevert("PanalEscrowV2_5: not active agent");
        escrow.claimTask(id);

        vm.prank(worker2);
        escrow.claimTask(id);
        PanalEscrowV2_5.Task memory t = escrow.getTask(id);
        assertEq(t.worker, worker2);
        assertEq(uint8(t.status), uint8(PanalEscrowV2_5.Status.Accepted));

        vm.prank(worker);
        vm.expectRevert("PanalEscrowV2_5: not claimable");
        escrow.claimTask(id);
    }

    function test_ClaimAfterAcceptWindowReverts() public {
        uint256 id = _create(_p(address(0), MON, 1 ether));
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(worker);
        vm.expectRevert("PanalEscrowV2_5: accept window over");
        escrow.claimTask(id);
    }

    // ─────────────────────────────────────────────────────────── rechazar (B2) y cancelar

    function test_WorkerRejectsAndClientIsRefunded() public {
        uint256 id = _createMon(1 ether);
        vm.prank(worker);
        escrow.rejectTask(id);
        assertEq(uint8(_reason(id)), uint8(PanalEscrowV2_5.Close.Rejected));
        assertEq(escrow.pendingWithdrawals(MON, client), 1 ether);
    }

    function test_RejectAfterAcceptingWorks_AfterDeliveryDoesNot() public {
        uint256 a = _createMon(1 ether);
        vm.prank(worker);
        escrow.acceptTask(a);
        vm.prank(worker);
        escrow.rejectTask(a);
        assertEq(uint8(_reason(a)), uint8(PanalEscrowV2_5.Close.Rejected));

        uint256 b = _delivered(1 ether);
        vm.prank(worker);
        vm.expectRevert("PanalEscrowV2_5: cannot reject");
        escrow.rejectTask(b);
    }

    function test_ClientCannotCancelWhileWorkerCanAccept() public {
        uint256 id = _createMon(1 ether);
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: worker can still accept");
        escrow.cancelTask(id);

        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(client);
        escrow.cancelTask(id);
        assertEq(uint8(_reason(id)), uint8(PanalEscrowV2_5.Close.Cancelled));
        assertEq(escrow.pendingWithdrawals(MON, client), 1 ether);
    }

    function test_ClientCancelsOpenTaskWithoutWorkerAnytime() public {
        uint256 id = _create(_p(address(0), MON, 1 ether));
        vm.prank(client);
        escrow.cancelTask(id);
        assertEq(uint8(_reason(id)), uint8(PanalEscrowV2_5.Close.Cancelled));
    }

    function test_AcceptedTaskOnlyCancelsAfterDeadline() public {
        uint256 id = _createMon(1 ether);
        vm.prank(worker);
        escrow.acceptTask(id);
        vm.warp(block.timestamp + 12 hours);
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: cannot cancel");
        escrow.cancelTask(id);

        vm.warp(block.timestamp + 12 hours + 1);
        vm.prank(client);
        escrow.cancelTask(id);
        assertEq(uint8(_reason(id)), uint8(PanalEscrowV2_5.Close.Expired));
    }

    function test_OnlyClientCancels() public {
        uint256 id = _create(_p(address(0), MON, 1 ether));
        vm.prank(rando);
        vm.expectRevert("PanalEscrowV2_5: not client");
        escrow.cancelTask(id);
    }

    // ─────────────────────────────────────────────────────────── A1: devolver lo vencido

    function test_AnyoneRefundsExpired() public {
        uint256 abierto = _createMon(1 ether);
        uint256 aceptado = _createMon(2 ether);
        vm.prank(worker);
        escrow.acceptTask(aceptado);
        uint256 entregado = _delivered(3 ether);

        vm.prank(rando);
        assertEq(escrow.refundExpired(_ids(abierto, aceptado, entregado)), 0, "nada vencido todavia");

        vm.warp(block.timestamp + 1 days + 1);
        assertTrue(escrow.isRefundable(abierto));
        vm.prank(rando);
        uint256 n = escrow.refundExpired(_ids(abierto, aceptado, entregado));
        assertEq(n, 2, "lo entregado no se devuelve");
        assertEq(escrow.pendingWithdrawals(MON, client), 3 ether);
        assertEq(uint8(_reason(abierto)), uint8(PanalEscrowV2_5.Close.Expired));
        assertEq(uint8(_status(entregado)), uint8(PanalEscrowV2_5.Status.Delivered));
    }

    function test_RefundExpiredSkipsUnknownIdsAndRepeats() public {
        uint256 id = _createMon(1 ether);
        vm.warp(block.timestamp + 2 days);
        vm.startPrank(rando);
        assertEq(escrow.refundExpired(_ids(id, 999, id)), 1);
        assertEq(escrow.refundExpired(_ids(id)), 0);
        vm.stopPrank();
        assertEq(escrow.pendingWithdrawals(MON, client), 1 ether, "se devuelve una sola vez");
    }

    // ─────────────────────────────────────────────────────────── aprobar

    function test_ApprovePaysWorkerAndFee() public {
        uint256 id = _delivered(10 ether);
        vm.expectEmit(true, true, false, true);
        emit PanalEscrowV2_5.TaskClosed(id, PanalEscrowV2_5.Close.Approved, 9.75 ether, 0.25 ether, 0, 4);
        vm.prank(client);
        escrow.approveAndRelease(id, 4);
        assertEq(escrow.pendingWithdrawals(MON, worker), 9.75 ether);
        assertEq(escrow.pendingWithdrawals(MON, treasury), 0.25 ether);
        assertEq(uint8(_status(id)), uint8(PanalEscrowV2_5.Status.Closed));

        PanalReputationV2_5.Reputation memory r = rep.getOwnReputation(worker);
        assertEq(r.tasksCompleted, 1);
        assertEq(r.ratingSum, 4);
        assertEq(r.ratingCount, 1);
        assertEq(rep.earned(worker, MON), 9.75 ether);
    }

    function test_ApproveValidations() public {
        uint256 id = _delivered(1 ether);
        vm.prank(rando);
        vm.expectRevert("PanalEscrowV2_5: not client");
        escrow.approveAndRelease(id, 5);
        vm.startPrank(client);
        vm.expectRevert("PanalEscrowV2_5: invalid rating");
        escrow.approveAndRelease(id, 0);
        vm.expectRevert("PanalEscrowV2_5: invalid rating");
        escrow.approveAndRelease(id, 6);
        vm.stopPrank();
    }

    function test_LateApprovalStillAllowed() public {
        uint256 id = _delivered(1 ether);
        vm.warp(block.timestamp + 10 days);
        vm.prank(client);
        escrow.approveAndRelease(id, 5);
        assertEq(uint8(_reason(id)), uint8(PanalEscrowV2_5.Close.Approved));
    }

    function test_UsdcFeeMathWithSixDecimals() public {
        uint256 id = _create(_p(worker, address(usdc), 1e6));
        vm.prank(worker);
        escrow.deliverResult(id, RESULT);
        vm.prank(client);
        escrow.approveAndRelease(id, 5);
        assertEq(escrow.pendingWithdrawals(address(usdc), worker), 975_000);
        assertEq(escrow.pendingWithdrawals(address(usdc), treasury), 25_000);
        vm.prank(worker);
        escrow.withdraw(address(usdc));
        assertEq(usdc.balanceOf(worker), 975_000);
        assertEq(rep.earned(worker, address(usdc)), 975_000);
    }

    // ─────────────────────────────────────────────────────────── A2/A3: liberar por tiempo

    function test_ReleaseOnlyAfterReviewWindowAndWithoutRating() public {
        uint256 id = _delivered(1 ether);
        assertEq(escrow.reviewEndsAt(id), block.timestamp + 72 hours);

        vm.warp(block.timestamp + 72 hours - 1);
        assertFalse(escrow.isReleasable(id));
        vm.prank(rando);
        assertEq(escrow.release(_ids(id)), 0);

        vm.warp(block.timestamp + 1);
        assertTrue(escrow.isReleasable(id));
        vm.prank(rando);
        assertEq(escrow.release(_ids(id)), 1);
        assertEq(uint8(_reason(id)), uint8(PanalEscrowV2_5.Close.Timeout));
        assertEq(escrow.pendingWithdrawals(MON, worker), 0.975 ether);

        PanalReputationV2_5.Reputation memory r = rep.getOwnReputation(worker);
        assertEq(r.tasksCompleted, 1, "cuenta como completado");
        assertEq(r.ratingCount, 0, "pero sin nota: ya no regala cincos");
    }

    function test_ReviewWindowChosenByClient() public {
        PanalEscrowV2_5.NewTask memory p = _p(worker, MON, 1 ether);
        p.reviewWindow = 24 hours;
        uint256 id = _create(p);
        vm.prank(worker);
        escrow.deliverResult(id, RESULT);
        vm.warp(block.timestamp + 24 hours);
        assertTrue(escrow.isReleasable(id));
    }

    function test_ReleaseAndWithdrawManyInOneCall() public {
        uint256 a = _delivered(1 ether);
        uint256 b = _delivered(2 ether);
        uint256 c = _delivered(3 ether);
        vm.warp(block.timestamp + 72 hours);
        uint256 antes = worker.balance;
        vm.prank(worker);
        uint256 n = escrow.releaseAndWithdraw(_ids(a, b, c), MON);
        assertEq(n, 3);
        assertEq(worker.balance - antes, 5.85 ether);
        assertEq(escrow.pendingWithdrawals(MON, worker), 0);
    }

    function test_DisputeOnlyWithinReviewWindow() public {
        uint256 id = _delivered(1 ether);
        vm.warp(block.timestamp + 72 hours);
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: review window over");
        escrow.openDispute(id, keccak256("motivo"));
    }

    /// @notice La regla del fundador, de punta a punta: entregó en plazo, nadie
    ///         aprobó ni disputó a tiempo, y el pago es suyo sin que el cliente
    ///         pueda hacer nada.
    function test_FounderRule_DeliveredOnTimeIsPaid() public {
        uint256 id = _delivered(4 ether);
        vm.warp(block.timestamp + 72 hours);
        vm.startPrank(client);
        vm.expectRevert("PanalEscrowV2_5: review window over");
        escrow.openDispute(id, bytes32(0));
        vm.expectRevert("PanalEscrowV2_5: cannot cancel");
        escrow.cancelTask(id);
        assertEq(escrow.refundExpired(_ids(id)), 0);
        vm.stopPrank();
        vm.prank(worker);
        escrow.releaseAndWithdraw(_ids(id), MON);
        assertEq(worker.balance, 3.9 ether);
    }

    // ─────────────────────────────────────────────────────────── disputas

    function test_OpenDisputeRecordsReason() public {
        uint256 id = _delivered(1 ether);
        bytes32 motivo = keccak256("no es lo acordado");
        vm.expectEmit(true, true, false, true);
        emit PanalEscrowV2_5.TaskDisputed(id, client, motivo);
        vm.prank(client);
        escrow.openDispute(id, motivo);
        PanalEscrowV2_5.Task memory t = escrow.getTask(id);
        assertEq(uint8(t.status), uint8(PanalEscrowV2_5.Status.Disputed));
        assertEq(t.disputedAt, block.timestamp);
    }

    function test_DisputeValidations() public {
        uint256 abierto = _createMon(1 ether);
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: not delivered");
        escrow.openDispute(abierto, bytes32(0));

        uint256 id = _delivered(1 ether);
        vm.prank(rando);
        vm.expectRevert("PanalEscrowV2_5: not a party");
        escrow.openDispute(id, bytes32(0));
    }

    function test_ResolveAllToClientCountsAsDisputeLost() public {
        uint256 id = _delivered(1 ether);
        vm.prank(client);
        escrow.openDispute(id, bytes32(0));
        bytes32 decision = keccak256("decision");
        vm.expectEmit(true, false, false, true);
        emit PanalEscrowV2_5.DisputeResolved(id, 0, 1, decision);
        vm.prank(arbitrator);
        escrow.resolveDispute(id, 0, 1, decision);

        assertEq(escrow.pendingWithdrawals(MON, client), 1 ether);
        assertEq(escrow.pendingWithdrawals(MON, treasury), 0, "sin pago, sin comision");
        PanalReputationV2_5.Reputation memory r = rep.getOwnReputation(worker);
        assertEq(r.tasksCompleted, 0, "no cuenta como completado");
        assertEq(r.disputesLost, 1);
        assertEq(r.ratingSum, 1, "pero la nota de los jueces entra en la media");
        assertEq(r.ratingCount, 1);
    }

    function test_ResolveSplit() public {
        uint256 id = _delivered(10 ether);
        vm.prank(client);
        escrow.openDispute(id, bytes32(0));
        vm.prank(arbitrator);
        escrow.resolveDispute(id, 3_000, 3, bytes32(0));
        assertEq(escrow.pendingWithdrawals(MON, worker), 2.925 ether);
        assertEq(escrow.pendingWithdrawals(MON, treasury), 0.075 ether);
        assertEq(escrow.pendingWithdrawals(MON, client), 7 ether);
        assertEq(rep.getOwnReputation(worker).ratingSum, 3);
    }

    function test_ResolveValidations() public {
        uint256 id = _delivered(1 ether);
        vm.prank(arbitrator);
        vm.expectRevert("PanalEscrowV2_5: not disputed");
        escrow.resolveDispute(id, 0, 1, bytes32(0));
        vm.prank(client);
        escrow.openDispute(id, bytes32(0));
        vm.prank(rando);
        vm.expectRevert("PanalEscrowV2_5: not arbitrator");
        escrow.resolveDispute(id, 0, 1, bytes32(0));
        vm.startPrank(arbitrator);
        vm.expectRevert("PanalEscrowV2_5: invalid share");
        escrow.resolveDispute(id, 10_001, 1, bytes32(0));
        vm.expectRevert("PanalEscrowV2_5: invalid rating");
        escrow.resolveDispute(id, 0, 0, bytes32(0));
        vm.stopPrank();
    }

    function test_ExpiredDisputeSplitsHalfAndHalf() public {
        uint256 id = _delivered(10 ether);
        vm.prank(client);
        escrow.openDispute(id, bytes32(0));
        vm.warp(block.timestamp + 14 days - 1);
        vm.prank(rando);
        vm.expectRevert("PanalEscrowV2_5: too early");
        escrow.resolveExpiredDispute(id);

        vm.warp(block.timestamp + 1);
        vm.prank(rando);
        escrow.resolveExpiredDispute(id);
        assertEq(uint8(_reason(id)), uint8(PanalEscrowV2_5.Close.DisputeExpired));
        assertEq(escrow.pendingWithdrawals(MON, client), 5 ether);
        assertEq(escrow.pendingWithdrawals(MON, worker), 4.875 ether);
        assertEq(escrow.pendingWithdrawals(MON, treasury), 0.125 ether);
        PanalReputationV2_5.Reputation memory r = rep.getOwnReputation(worker);
        assertEq(r.tasksCompleted, 1);
        assertEq(r.ratingCount, 0, "sin decision, sin nota");
    }

    // ─────────────────────────────────────────────────────────── B3: mutuo acuerdo

    function test_MutualSettlement() public {
        uint256 id = _delivered(10 ether);
        vm.prank(client);
        escrow.proposeSettlement(id, 6_000);
        (address by, uint16 share) = escrow.proposals(id);
        assertEq(by, client);
        assertEq(share, 6_000);

        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: nothing to accept");
        escrow.acceptSettlement(id, 6_000);
        vm.prank(worker);
        vm.expectRevert("PanalEscrowV2_5: share changed");
        escrow.acceptSettlement(id, 7_000);

        vm.prank(worker);
        escrow.acceptSettlement(id, 6_000);
        assertEq(uint8(_reason(id)), uint8(PanalEscrowV2_5.Close.Mutual));
        assertEq(escrow.pendingWithdrawals(MON, worker), 5.85 ether);
        assertEq(escrow.pendingWithdrawals(MON, client), 4 ether);
        (by,) = escrow.proposals(id);
        assertEq(by, address(0), "la propuesta se borra al cerrar");
        assertEq(rep.getOwnReputation(worker).ratingCount, 0);
    }

    function test_MutualSettlementEndsADispute() public {
        uint256 id = _delivered(2 ether);
        vm.prank(client);
        escrow.openDispute(id, bytes32(0));
        vm.prank(worker);
        escrow.proposeSettlement(id, 0);
        vm.prank(client);
        escrow.acceptSettlement(id, 0);
        assertEq(escrow.pendingWithdrawals(MON, client), 2 ether);
        assertEq(rep.getOwnReputation(worker).disputesLost, 0, "un acuerdo no es una disputa perdida");
    }

    function test_CounterProposalReplacesTheFirst() public {
        uint256 id = _delivered(1 ether);
        vm.prank(client);
        escrow.proposeSettlement(id, 2_000);
        vm.prank(worker);
        escrow.proposeSettlement(id, 8_000);
        vm.prank(worker);
        vm.expectRevert("PanalEscrowV2_5: nothing to accept");
        escrow.acceptSettlement(id, 8_000);
        vm.prank(client);
        escrow.acceptSettlement(id, 8_000);
        assertEq(escrow.pendingWithdrawals(MON, client), 0.2 ether);
    }

    function test_SettlementValidations() public {
        uint256 abierto = _create(_p(address(0), MON, 1 ether));
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: no worker");
        escrow.proposeSettlement(abierto, 0);

        uint256 id = _delivered(1 ether);
        vm.prank(rando);
        vm.expectRevert("PanalEscrowV2_5: not a party");
        escrow.proposeSettlement(id, 0);
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: invalid share");
        escrow.proposeSettlement(id, 10_001);

        vm.prank(client);
        escrow.approveAndRelease(id, 5);
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: closed");
        escrow.proposeSettlement(id, 0);
    }

    // ─────────────────────────────────────────────────────────── B4: ampliar el plazo

    function test_ClientExtendsDeadline() public {
        uint256 id = _createMon(1 ether);
        vm.prank(worker);
        escrow.acceptTask(id);
        uint64 nuevo = uint64(block.timestamp + 3 days);
        vm.prank(client);
        escrow.extendDeadline(id, nuevo);
        vm.warp(block.timestamp + 2 days);
        vm.prank(worker);
        escrow.deliverResult(id, RESULT);
        assertEq(uint8(_status(id)), uint8(PanalEscrowV2_5.Status.Delivered));
    }

    function test_ExtendAfterDeadlineIfNobodyRefunded() public {
        uint256 id = _createMon(1 ether);
        vm.prank(worker);
        escrow.acceptTask(id);
        vm.warp(block.timestamp + 1 days + 60);
        vm.prank(client);
        escrow.extendDeadline(id, uint64(block.timestamp + 1 hours));
        vm.prank(worker);
        escrow.deliverResult(id, RESULT);
    }

    function test_ExtendValidations() public {
        uint256 id = _createMon(1 ether);
        uint64 deadline = escrow.getTask(id).deadline;
        vm.prank(rando);
        vm.expectRevert("PanalEscrowV2_5: not client");
        escrow.extendDeadline(id, deadline + 1);
        vm.startPrank(client);
        vm.expectRevert("PanalEscrowV2_5: only forward");
        escrow.extendDeadline(id, deadline);
        vm.expectRevert("PanalEscrowV2_5: too long");
        escrow.extendDeadline(id, uint64(block.timestamp + 366 days));
        vm.stopPrank();
        vm.prank(worker);
        escrow.deliverResult(id, RESULT);
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: not extendable");
        escrow.extendDeadline(id, deadline + 1);
    }

    // ─────────────────────────────────────────────────────────── cobrar

    function test_WithdrawEachCurrency() public {
        uint256 a = _delivered(1 ether);
        uint256 b = _create(_p(worker, address(panal), 100e18));
        vm.prank(worker);
        escrow.deliverResult(b, RESULT);
        vm.startPrank(client);
        escrow.approveAndRelease(a, 5);
        escrow.approveAndRelease(b, 5);
        vm.stopPrank();

        vm.startPrank(worker);
        escrow.withdraw(MON);
        escrow.withdraw(address(panal));
        vm.expectRevert("PanalEscrowV2_5: nothing to withdraw");
        escrow.withdraw(MON);
        vm.stopPrank();
        assertEq(worker.balance, 0.975 ether);
        assertEq(panal.balanceOf(worker), 98.5e18, "en $PANAL, 1,5 %");
    }

    function test_ReentrantReceiverCannotWithdrawTwice() public {
        Ladron l = new Ladron(escrow);
        vm.prank(address(l));
        registry.registerAgent("ipfs://ladron", 1 ether, MON);
        uint256 id = _create(_p(address(l), MON, 1 ether));
        vm.prank(address(l));
        escrow.deliverResult(id, RESULT);
        vm.prank(client);
        escrow.approveAndRelease(id, 5);
        vm.prank(address(l));
        vm.expectRevert("PanalEscrowV2_5: transfer failed");
        escrow.withdraw(MON);
        assertEq(address(escrow).balance, 1 ether);
    }

    // ─────────────────────────────────────────────────────────── dueño y árbitro

    function test_TwoStepOwnership() public {
        address nuevo = makeAddr("nuevoDueno");
        vm.prank(rando);
        vm.expectRevert("PanalEscrowV2_5: not owner");
        escrow.transferOwnership(nuevo);

        vm.prank(owner);
        escrow.transferOwnership(nuevo);
        assertEq(escrow.owner(), owner, "hasta que acepte, sigue el de antes");
        vm.prank(rando);
        vm.expectRevert("PanalEscrowV2_5: not pending owner");
        escrow.acceptOwnership();
        vm.prank(nuevo);
        escrow.acceptOwnership();
        assertEq(escrow.owner(), nuevo);
        assertEq(escrow.pendingOwner(), address(0));
    }

    function test_SetTreasuryOnlyOwner() public {
        vm.prank(rando);
        vm.expectRevert("PanalEscrowV2_5: not owner");
        escrow.setTreasury(rando);
        vm.prank(owner);
        escrow.setTreasury(rando);
        assertEq(escrow.treasury(), rando);
    }

    function test_ArbitratorChangeWaitsThreeDays() public {
        address nuevos = makeAddr("nuevosJueces");
        uint256 id = _delivered(1 ether);
        vm.prank(client);
        escrow.openDispute(id, bytes32(0));

        vm.prank(arbitrator);
        vm.expectRevert("PanalEscrowV2_5: not owner");
        escrow.proposeArbitrator(nuevos);

        vm.prank(owner);
        escrow.proposeArbitrator(nuevos);
        assertEq(escrow.arbitratorChangeAt(), block.timestamp + 3 days);

        // Los nuevos no pueden resolver en el mismo bloque.
        vm.prank(nuevos);
        vm.expectRevert("PanalEscrowV2_5: not arbitrator");
        escrow.resolveDispute(id, 10_000, 5, bytes32(0));
        vm.expectRevert("PanalEscrowV2_5: too early");
        escrow.applyArbitratorChange();

        vm.warp(block.timestamp + 3 days);
        vm.prank(rando);
        escrow.applyArbitratorChange();
        assertEq(escrow.arbitrator(), nuevos);
        vm.prank(nuevos);
        escrow.resolveDispute(id, 10_000, 5, bytes32(0));
    }

    function test_CancelArbitratorChange() public {
        vm.startPrank(owner);
        escrow.proposeArbitrator(rando);
        escrow.cancelArbitratorChange();
        vm.stopPrank();
        vm.warp(block.timestamp + 4 days);
        vm.expectRevert("PanalEscrowV2_5: no change pending");
        escrow.applyArbitratorChange();
        assertEq(escrow.arbitrator(), arbitrator);
    }

    // ─────────────────────────────────────────────────────────── reputación encadenada

    function test_ReputationAddsTheV2History() public {
        PanalReputationV2_5.Reputation memory antes = rep.getReputation(worker);
        assertEq(antes.tasksCompleted, 2, "los 2 del v2");
        assertEq(antes.ratingSum, 9);
        assertEq(rep.getScore(worker), 450);

        uint256 id = _delivered(1 ether);
        vm.prank(client);
        escrow.approveAndRelease(id, 3);

        PanalReputationV2_5.Reputation memory r = rep.getReputation(worker);
        assertEq(r.tasksCompleted, 3);
        assertEq(r.ratingSum, 12);
        assertEq(r.ratingCount, 3);
        assertEq(rep.getScore(worker), 400);

        // El v2 sigue sumando mientras terminan sus encargos.
        vm.prank(oldEscrow);
        repV2.recordCompletion(worker, 5, 1 ether);
        assertEq(rep.getReputation(worker).tasksCompleted, 4);
    }

    function test_ReputationOnlyWrittenByEscrow() public {
        vm.expectRevert("PanalReputationV2_5: not escrow");
        rep.recordCompletion(worker, 5, MON, 1);
        vm.expectRevert("PanalReputationV2_5: not escrow");
        rep.recordDisputeLost(worker, 1);
    }

    function test_ReputationSetEscrowOnlyOnceByDeployer() public {
        PanalReputationV2_5 r = new PanalReputationV2_5(address(0));
        vm.prank(rando);
        vm.expectRevert("PanalReputationV2_5: not deployer");
        r.setEscrow(address(escrow));
        r.setEscrow(address(escrow));
        vm.expectRevert("PanalReputationV2_5: escrow already set");
        r.setEscrow(address(escrow));
    }
}

/// @notice Un trabajador que intenta retirar dos veces desde su `receive`.
contract Ladron {
    PanalEscrowV2_5 immutable escrow;

    constructor(PanalEscrowV2_5 e) {
        escrow = e;
    }

    receive() external payable {
        escrow.withdraw(address(0));
    }
}

/// @notice Los jueces autónomos (decidido el 23-nov): proponen, a las 48 h es
///         firme salvo que los humanos corrijan antes; añadirlos espera 3 días,
///         quitarlos es inmediato.
contract PanalEscrowV2_5AutoJudgesTest is EscrowV2_5Base {
    address autonomos = makeAddr("juecesAutonomos");
    bytes32 constant IA = keccak256("decision de los jueces autonomos");

    function _activar(address quien) internal {
        vm.prank(owner);
        escrow.proposeAutoArbitrator(quien);
        vm.warp(block.timestamp + 3 days);
        escrow.applyAutoArbitratorChange();
    }

    function _enDisputa(uint256 amount) internal returns (uint256 id) {
        id = _delivered(amount);
        vm.prank(client);
        escrow.openDispute(id, keccak256("motivo"));
    }

    function _dictar(uint256 id, uint16 share, uint8 rating) internal {
        vm.prank(autonomos);
        escrow.proposeRuling(id, share, rating, IA);
    }

    function _finalAt(uint256 id) internal view returns (uint64 f) {
        (,, f,,) = escrow.rulings(id);
    }

    // ─────────────────────────────────────────────────────────── alta

    function test_OffByDefault() public {
        assertEq(escrow.autoArbitrator(), address(0));
        assertEq(escrow.autoArbitratorEpoch(), 0);
        uint256 id = _enDisputa(1 ether);
        vm.prank(autonomos);
        vm.expectRevert("PanalEscrowV2_5: not auto arbitrator");
        escrow.proposeRuling(id, 5_000, 3, IA);
        vm.prank(arbitrator);
        vm.expectRevert("PanalEscrowV2_5: not auto arbitrator");
        escrow.proposeRuling(id, 5_000, 3, IA);
    }

    function test_AddingTakesThreeDays() public {
        vm.prank(rando);
        vm.expectRevert("PanalEscrowV2_5: not owner");
        escrow.proposeAutoArbitrator(autonomos);
        vm.prank(owner);
        vm.expectRevert("PanalEscrowV2_5: zero arbitrator");
        escrow.proposeAutoArbitrator(address(0));

        vm.prank(owner);
        escrow.proposeAutoArbitrator(autonomos);
        assertEq(escrow.autoArbitratorChangeAt(), block.timestamp + 3 days);
        vm.warp(block.timestamp + 3 days - 1);
        vm.expectRevert("PanalEscrowV2_5: too early");
        escrow.applyAutoArbitratorChange();
        vm.warp(block.timestamp + 1);
        vm.prank(rando);
        escrow.applyAutoArbitratorChange();
        assertEq(escrow.autoArbitrator(), autonomos);
        assertEq(escrow.autoArbitratorEpoch(), 1);
        assertEq(escrow.autoArbitratorEpochStart(1), block.timestamp);
    }

    function test_CancelAutoArbitratorChange() public {
        vm.prank(rando);
        vm.expectRevert("PanalEscrowV2_5: not owner");
        escrow.cancelAutoArbitratorChange();
        vm.startPrank(owner);
        vm.expectRevert("PanalEscrowV2_5: no change pending");
        escrow.cancelAutoArbitratorChange();
        escrow.proposeAutoArbitrator(autonomos);
        escrow.cancelAutoArbitratorChange();
        vm.stopPrank();
        vm.warp(block.timestamp + 4 days);
        vm.expectRevert("PanalEscrowV2_5: no change pending");
        escrow.applyAutoArbitratorChange();
        assertEq(escrow.autoArbitrator(), address(0));
    }

    // ─────────────────────────────────────────────────────────── 48 h

    function test_RulingBecomesFinalAfter48Hours() public {
        _activar(autonomos);
        uint256 id = _enDisputa(10 ether);
        vm.expectEmit(true, true, false, true);
        emit PanalEscrowV2_5.RulingProposed(id, autonomos, 7_000, 4, IA, uint64(block.timestamp + 48 hours));
        _dictar(id, 7_000, 4);
        assertEq(uint8(_status(id)), uint8(PanalEscrowV2_5.Status.Disputed), "todavia no se reparte");
        assertFalse(escrow.isRulingFinalizable(id));

        vm.warp(block.timestamp + 48 hours - 1);
        vm.prank(rando);
        vm.expectRevert("PanalEscrowV2_5: too early");
        escrow.finalizeRuling(id);

        vm.warp(block.timestamp + 1);
        assertTrue(escrow.isRulingFinalizable(id));
        vm.expectEmit(true, false, false, true);
        emit PanalEscrowV2_5.DisputeResolved(id, 7_000, 4, IA);
        vm.prank(rando);
        escrow.finalizeRuling(id);
        assertEq(uint8(_reason(id)), uint8(PanalEscrowV2_5.Close.AutoArbitrated));
        assertEq(escrow.pendingWithdrawals(MON, worker), 6.825 ether);
        assertEq(escrow.pendingWithdrawals(MON, client), 3 ether);
        assertEq(escrow.pendingWithdrawals(MON, treasury), 0.175 ether);
        assertEq(rep.getOwnReputation(worker).ratingSum, 4);
        assertFalse(escrow.isRulingFinalizable(id), "ya cerrado");
    }

    function test_HumansCorrectWithin48Hours() public {
        _activar(autonomos);
        uint256 id = _enDisputa(2 ether);
        _dictar(id, 10_000, 5);
        vm.warp(block.timestamp + 47 hours);

        vm.expectEmit(true, true, false, false);
        emit PanalEscrowV2_5.RulingOverruled(id, arbitrator);
        vm.prank(arbitrator);
        escrow.resolveDispute(id, 0, 1, keccak256("los humanos corrigen"));
        assertEq(uint8(_reason(id)), uint8(PanalEscrowV2_5.Close.Arbitrated));
        assertEq(escrow.pendingWithdrawals(MON, client), 2 ether);
        assertEq(rep.getOwnReputation(worker).disputesLost, 1);

        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert("PanalEscrowV2_5: not disputed");
        escrow.finalizeRuling(id);
    }

    function test_HumansCannotCorrectAfter48Hours() public {
        _activar(autonomos);
        uint256 id = _enDisputa(1 ether);
        _dictar(id, 6_000, 3);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(arbitrator);
        vm.expectRevert("PanalEscrowV2_5: ruling final");
        escrow.resolveDispute(id, 0, 1, bytes32(0));
    }

    function test_HumansStillDecideWhenThereIsNoRuling() public {
        _activar(autonomos);
        uint256 id = _enDisputa(1 ether);
        vm.warp(block.timestamp + 5 days); // p. ej. los autónomos votaron 2 a 2
        vm.prank(arbitrator);
        escrow.resolveDispute(id, 5_000, 3, bytes32(0));
        assertEq(uint8(_reason(id)), uint8(PanalEscrowV2_5.Close.Arbitrated));
    }

    function test_OneRulingPerDispute() public {
        _activar(autonomos);
        uint256 id = _enDisputa(1 ether);
        _dictar(id, 6_000, 3);
        vm.prank(autonomos);
        vm.expectRevert("PanalEscrowV2_5: already ruled");
        escrow.proposeRuling(id, 1_000, 2, IA);
    }

    function test_RulingValidations() public {
        _activar(autonomos);
        uint256 entregado = _delivered(1 ether);
        vm.prank(autonomos);
        vm.expectRevert("PanalEscrowV2_5: not disputed");
        escrow.proposeRuling(entregado, 5_000, 3, IA);

        uint256 id = _enDisputa(1 ether);
        vm.startPrank(autonomos);
        vm.expectRevert("PanalEscrowV2_5: invalid share");
        escrow.proposeRuling(id, 10_001, 3, IA);
        vm.expectRevert("PanalEscrowV2_5: invalid rating");
        escrow.proposeRuling(id, 5_000, 0, IA);
        vm.expectRevert("PanalEscrowV2_5: invalid rating");
        escrow.proposeRuling(id, 5_000, 6, IA);
        vm.stopPrank();

        vm.expectRevert("PanalEscrowV2_5: no ruling");
        escrow.finalizeRuling(id);
    }

    function test_RulingAllToClientCountsAsDisputeLost() public {
        _activar(autonomos);
        uint256 id = _enDisputa(1 ether);
        _dictar(id, 0, 2);
        vm.warp(block.timestamp + 48 hours);
        escrow.finalizeRuling(id);
        PanalReputationV2_5.Reputation memory r = rep.getOwnReputation(worker);
        assertEq(r.disputesLost, 1);
        assertEq(r.tasksCompleted, 0);
        assertEq(r.ratingSum, 2);
        assertEq(escrow.pendingWithdrawals(MON, client), 1 ether);
    }

    function test_MutualSettlementStillPossibleWithARuling() public {
        _activar(autonomos);
        uint256 id = _enDisputa(1 ether);
        _dictar(id, 0, 1);
        vm.prank(worker);
        escrow.proposeSettlement(id, 5_000);
        vm.prank(client);
        escrow.acceptSettlement(id, 5_000);
        assertEq(uint8(_reason(id)), uint8(PanalEscrowV2_5.Close.Mutual));
    }

    // ─────────────────────────────────────────────────────────── 14 días

    function test_RulingOnlyWithin14Days() public {
        _activar(autonomos);
        uint256 id = _enDisputa(1 ether);
        vm.warp(block.timestamp + 14 days);
        vm.prank(autonomos);
        vm.expectRevert("PanalEscrowV2_5: dispute expired");
        escrow.proposeRuling(id, 5_000, 3, IA);
        escrow.resolveExpiredDispute(id);
        assertEq(uint8(_reason(id)), uint8(PanalEscrowV2_5.Close.DisputeExpired));
    }

    function test_ExpiredDisputeWaitsForAPendingRuling() public {
        _activar(autonomos);
        uint256 id = _enDisputa(1 ether);
        vm.warp(block.timestamp + 13 days);
        _dictar(id, 8_000, 4);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert("PanalEscrowV2_5: ruling pending");
        escrow.resolveExpiredDispute(id);
        vm.warp(block.timestamp + 1 days);
        escrow.finalizeRuling(id);
        assertEq(uint8(_reason(id)), uint8(PanalEscrowV2_5.Close.AutoArbitrated));
    }

    // ─────────────────────────────────────────────────────────── quitar y cambiar

    function test_RemovingIsImmediateAndVoidsRulingsNotYetFinal() public {
        _activar(autonomos);
        uint256 id = _enDisputa(1 ether);
        _dictar(id, 10_000, 5);

        vm.prank(rando);
        vm.expectRevert("PanalEscrowV2_5: not owner");
        escrow.removeAutoArbitrator();
        vm.prank(owner);
        escrow.removeAutoArbitrator();
        assertEq(escrow.autoArbitrator(), address(0));

        vm.warp(block.timestamp + 48 hours);
        assertFalse(escrow.isRulingFinalizable(id));
        vm.expectRevert("PanalEscrowV2_5: no ruling");
        escrow.finalizeRuling(id);
        vm.prank(arbitrator);
        escrow.resolveDispute(id, 0, 1, bytes32(0)); // vuelve a los humanos, sin «ruling final»
        assertEq(escrow.pendingWithdrawals(MON, client), 1 ether);

        vm.prank(owner);
        vm.expectRevert("PanalEscrowV2_5: no auto arbitrator");
        escrow.removeAutoArbitrator();
    }

    function test_RemovingKeepsRulingsThatWereAlreadyFinal() public {
        _activar(autonomos);
        uint256 id = _enDisputa(1 ether);
        _dictar(id, 10_000, 5);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(owner);
        escrow.removeAutoArbitrator();

        assertTrue(escrow.isRulingFinalizable(id), "firme es firme");
        vm.prank(arbitrator);
        vm.expectRevert("PanalEscrowV2_5: ruling final");
        escrow.resolveDispute(id, 0, 1, bytes32(0));
        escrow.finalizeRuling(id);
        assertEq(escrow.pendingWithdrawals(MON, worker), 0.975 ether);
    }

    function test_RemovedJudgesWithExpiredDisputeGoHalfAndHalf() public {
        _activar(autonomos);
        uint256 id = _enDisputa(1 ether);
        vm.warp(block.timestamp + 13 days);
        _dictar(id, 10_000, 5);
        vm.prank(owner);
        escrow.removeAutoArbitrator();
        vm.warp(block.timestamp + 1 days);
        escrow.resolveExpiredDispute(id);
        assertEq(escrow.pendingWithdrawals(MON, client), 0.5 ether);
    }

    function test_ReplacingJudgesVoidsTheirRecentRulings() public {
        _activar(autonomos);
        address nuevos = makeAddr("nuevosAutonomos");
        uint256 id = _enDisputa(1 ether);
        vm.prank(owner);
        escrow.proposeAutoArbitrator(nuevos); // entra a los 3 días
        vm.warp(block.timestamp + 2 days);
        _dictar(id, 10_000, 5); // sería firme al cuarto día
        vm.warp(block.timestamp + 1 days);
        escrow.applyAutoArbitratorChange();

        vm.prank(autonomos);
        vm.expectRevert("PanalEscrowV2_5: not auto arbitrator");
        escrow.proposeRuling(id, 0, 1, IA);
        vm.prank(nuevos);
        escrow.proposeRuling(id, 2_000, 2, IA); // la de antes ya no vale
        vm.warp(block.timestamp + 48 hours);
        escrow.finalizeRuling(id);
        assertEq(escrow.pendingWithdrawals(MON, client), 0.8 ether);
    }

    function test_ReAddingOldJudgesDoesNotReviveVoidedRulings() public {
        _activar(autonomos);
        uint256 id = _enDisputa(1 ether);
        _dictar(id, 10_000, 5);
        vm.prank(owner);
        escrow.removeAutoArbitrator();
        _activar(autonomos); // vuelven los mismos, 3 días después
        assertFalse(escrow.isRulingFinalizable(id), "lo anulado sigue anulado");
        vm.expectRevert("PanalEscrowV2_5: no ruling");
        escrow.finalizeRuling(id);
    }

    function test_AutoJudgesCannotDoAnythingElse() public {
        _activar(autonomos);
        uint256 id = _enDisputa(1 ether);
        vm.startPrank(autonomos);
        vm.expectRevert("PanalEscrowV2_5: not arbitrator");
        escrow.resolveDispute(id, 10_000, 5, IA);
        vm.expectRevert("PanalEscrowV2_5: not owner");
        escrow.proposeArbitrator(autonomos);
        vm.expectRevert("PanalEscrowV2_5: not owner");
        escrow.setTreasury(autonomos);
        vm.expectRevert("PanalEscrowV2_5: not owner");
        escrow.proposeAutoArbitrator(makeAddr("otros"));
        vm.stopPrank();
    }

    function test_IsRulingFinalizableOnUnknownTask() public view {
        assertFalse(escrow.isRulingFinalizable(999));
    }
}

/// @notice La comisión por moneda: 2,5 % en MON y USDC, 1,5 % en $PANAL.
contract PanalEscrowV2_5FeesTest is EscrowV2_5Base {
    function _aprobado(address currency, uint256 amount) internal returns (uint256 id) {
        id = _create(_p(worker, currency, amount));
        vm.prank(worker);
        escrow.deliverResult(id, RESULT);
        vm.prank(client);
        escrow.approveAndRelease(id, 5);
    }

    function test_FeePerCurrency() public view {
        assertEq(escrow.feeBpsFor(MON), 250);
        assertEq(escrow.feeBpsFor(address(usdc)), 250);
        assertEq(escrow.feeBpsFor(address(panal)), 150);
        assertEq(escrow.FEE_BPS(), 250);
        assertEq(escrow.FEE_BPS_PANAL(), 150);
    }

    function test_PanalPaysOnePointFive() public {
        uint256 id = _aprobado(address(panal), 100e18);
        assertEq(escrow.pendingWithdrawals(address(panal), worker), 98.5e18);
        assertEq(escrow.pendingWithdrawals(address(panal), treasury), 1.5e18);
        assertEq(rep.earned(worker, address(panal)), 98.5e18);
        assertEq(uint8(_reason(id)), uint8(PanalEscrowV2_5.Close.Approved));
    }

    function test_MonAndUsdcPayTwoPointFive() public {
        _aprobado(MON, 2 ether);
        _aprobado(address(usdc), 40e6);
        assertEq(escrow.pendingWithdrawals(MON, treasury), 0.05 ether);
        assertEq(escrow.pendingWithdrawals(address(usdc), treasury), 1e6);
    }

    function test_PanalFeeAlsoInDisputesAndTimeouts() public {
        // Reparto de los jueces: 60 % de 10 $PANAL → 6 brutos, 1,5 % de comisión.
        uint256 a = _create(_p(worker, address(panal), 10e18));
        vm.prank(worker);
        escrow.deliverResult(a, RESULT);
        vm.prank(client);
        escrow.openDispute(a, bytes32(0));
        vm.prank(arbitrator);
        escrow.resolveDispute(a, 6_000, 3, bytes32(0));
        assertEq(escrow.pendingWithdrawals(address(panal), worker), 5.91e18);
        assertEq(escrow.pendingWithdrawals(address(panal), client), 4e18);

        // Liberado por tiempo: lo mismo.
        uint256 b = _create(_p(worker, address(panal), 10e18));
        vm.prank(worker);
        escrow.deliverResult(b, RESULT);
        vm.warp(block.timestamp + 72 hours);
        escrow.release(_ids(b));
        assertEq(escrow.pendingWithdrawals(address(panal), treasury), 0.09e18 + 0.15e18);
    }

    /// Con cualquier importe y reparto, en las tres monedas, no se crea ni se pierde
    /// una unidad: lo que cobra quien trabaja + la comisión + lo que vuelve al
    /// cliente es exactamente lo bloqueado.
    function testFuzz_FeeNeverCreatesOrLosesUnits(uint96 cantidad, uint16 share, uint8 m) public {
        m = m % 3;
        address cur = m == 0 ? MON : (m == 1 ? address(panal) : address(usdc));
        uint256 min = m == 0 ? 0.001 ether : (m == 1 ? 1e18 : 1e4);
        uint256 amount = bound(cantidad, min, m == 2 ? 1_000_000e6 : 900e18);
        share = uint16(bound(share, 0, 10_000));
        uint256 id = _create(_p(worker, cur, amount));
        vm.prank(worker);
        escrow.deliverResult(id, RESULT);
        vm.prank(client);
        escrow.openDispute(id, bytes32(0));
        vm.prank(arbitrator);
        escrow.resolveDispute(id, share, 3, bytes32(0));
        uint256 w = escrow.pendingWithdrawals(cur, worker);
        uint256 f = escrow.pendingWithdrawals(cur, treasury);
        uint256 c = escrow.pendingWithdrawals(cur, client);
        assertEq(w + f + c, amount);
        uint256 bruto = amount * share / 10_000;
        assertEq(f, bruto * escrow.feeBpsFor(cur) / 10_000);
    }
}

/// @notice Las suspensiones (PanalBans, 23-nov): quien está suspendido no empieza
///         nada nuevo, pero retira siempre su saldo, y lo que ya estaba en marcha
///         termina con las reglas de siempre. Suspender nunca quita dinero.
contract PanalEscrowV2_5BansTest is EscrowV2_5Base {
    bytes32 constant PRUEBAS = keccak256("orden judicial 123");

    function _suspender(address a) internal {
        address[] memory l = new address[](1);
        l[0] = a;
        vm.prank(owner);
        bans.suspend(l, PRUEBAS);
    }

    function _rehabilitar(address a) internal {
        address[] memory l = new address[](1);
        l[0] = a;
        vm.prank(owner);
        bans.reinstate(l, keccak256("levantada"));
    }

    // ─────────────────────────────────────────────────────────── no empieza nada nuevo

    function test_SuspendedClientCannotHire() public {
        _suspender(client);
        PanalEscrowV2_5.NewTask memory p = _p(worker, MON, 1 ether);
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: suspended");
        escrow.createTask{value: 1 ether}(p);
    }

    function test_SuspendedAgentCannotBeHiredOrClaim() public {
        _suspender(worker);
        PanalEscrowV2_5.NewTask memory p = _p(worker, MON, 1 ether);
        vm.prank(client);
        vm.expectRevert("PanalEscrowV2_5: suspended");
        escrow.createTask{value: 1 ether}(p);

        uint256 abierto = _create(_p(address(0), MON, 1 ether)); // sin trabajador, sí
        vm.prank(worker);
        vm.expectRevert("PanalEscrowV2_5: suspended");
        escrow.claimTask(abierto);
        vm.prank(worker2);
        escrow.claimTask(abierto);
    }

    function test_SuspendedAgentCannotAcceptOrDeliver() public {
        uint256 abierto = _createMon(1 ether);
        uint256 aceptado = _createMon(1 ether);
        vm.prank(worker);
        escrow.acceptTask(aceptado);
        _suspender(worker);

        vm.startPrank(worker);
        vm.expectRevert("PanalEscrowV2_5: suspended");
        escrow.acceptTask(abierto);
        vm.expectRevert("PanalEscrowV2_5: suspended");
        escrow.deliverResult(abierto, RESULT);
        vm.expectRevert("PanalEscrowV2_5: suspended");
        escrow.deliverResult(aceptado, RESULT);
        vm.stopPrank();
    }

    function test_AgentsCannotTakeNewWorkFromSuspendedClient() public {
        uint256 abierto = _create(_p(address(0), MON, 1 ether));
        uint256 nombrado = _createMon(1 ether);
        _suspender(client);

        vm.prank(worker2);
        vm.expectRevert("PanalEscrowV2_5: suspended");
        escrow.claimTask(abierto);
        vm.startPrank(worker);
        vm.expectRevert("PanalEscrowV2_5: suspended");
        escrow.acceptTask(nombrado);
        vm.expectRevert("PanalEscrowV2_5: suspended");
        escrow.deliverResult(nombrado, RESULT);
        vm.stopPrank();

        // El cliente suspendido recupera su dinero con las reglas de siempre.
        vm.prank(client);
        escrow.cancelTask(abierto);
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(client);
        escrow.cancelTask(nombrado);
        uint256 antes = client.balance;
        vm.prank(client);
        escrow.withdraw(MON);
        assertEq(client.balance - antes, 2 ether);
    }

    function test_SuspendedCannotDisputeSettleOrExtend() public {
        uint256 enMarcha = _createMon(1 ether);
        uint256 entregado = _delivered(1 ether);
        vm.prank(worker);
        escrow.proposeSettlement(entregado, 5_000);
        _suspender(client);

        vm.startPrank(client);
        vm.expectRevert("PanalEscrowV2_5: suspended");
        escrow.openDispute(entregado, bytes32(0));
        vm.expectRevert("PanalEscrowV2_5: suspended");
        escrow.proposeSettlement(entregado, 1_000);
        vm.expectRevert("PanalEscrowV2_5: suspended");
        escrow.acceptSettlement(entregado, 5_000);
        vm.expectRevert("PanalEscrowV2_5: suspended");
        escrow.extendDeadline(enMarcha, uint64(block.timestamp + 2 days));
        vm.stopPrank();
    }

    function test_HonestPartyCanAcceptAProposalMadeBeforeTheSuspension() public {
        uint256 id = _delivered(1 ether);
        vm.prank(client);
        escrow.proposeSettlement(id, 7_000);
        _suspender(client);
        vm.prank(worker);
        escrow.acceptSettlement(id, 7_000);
        assertEq(uint8(_reason(id)), uint8(PanalEscrowV2_5.Close.Mutual));
        assertEq(escrow.pendingWithdrawals(MON, client), 0.3 ether);
    }

    // ─────────────────────────────────────────────────────────── lo que sí puede

    function test_SuspendedCanStillApproveAndReject() public {
        uint256 entregado = _delivered(1 ether);
        _suspender(client);
        vm.prank(client);
        escrow.approveAndRelease(entregado, 5); // solo le beneficia a la otra parte
        assertEq(escrow.pendingWithdrawals(MON, worker), 0.975 ether);

        _rehabilitar(client);
        uint256 abierto = _createMon(1 ether);
        _suspender(worker);
        vm.prank(worker);
        escrow.rejectTask(abierto); // le devuelve el dinero al cliente
        assertEq(escrow.pendingWithdrawals(MON, client), 1 ether);
    }

    function test_SuspendedAlwaysWithdraws() public {
        uint256 a = _delivered(1 ether);
        uint256 b = _delivered(2 ether);
        vm.prank(client);
        escrow.approveAndRelease(a, 5);
        _suspender(worker);
        _suspender(client);

        vm.prank(worker);
        escrow.withdraw(MON);
        assertEq(worker.balance, 0.975 ether);

        vm.warp(block.timestamp + 72 hours);
        vm.prank(worker);
        escrow.releaseAndWithdraw(_ids(b), MON);
        assertEq(worker.balance, 0.975 ether + 1.95 ether);
    }

    // ─────────────────────────────────────────────────────────── la otra parte

    function test_ClientCancelsAtOnceWhenTheAgentIsSuspended() public {
        uint256 abierto = _createMon(1 ether);
        uint256 aceptado = _createMon(2 ether);
        vm.prank(worker);
        escrow.acceptTask(aceptado);
        uint256 entregado = _delivered(4 ether);
        _suspender(worker);

        vm.startPrank(client);
        escrow.cancelTask(abierto); // sin esperar al tiempo para aceptar
        escrow.cancelTask(aceptado); // sin esperar al plazo
        vm.expectRevert("PanalEscrowV2_5: cannot cancel");
        escrow.cancelTask(entregado); // lo entregado sigue sus reglas
        vm.stopPrank();
        assertEq(uint8(_reason(abierto)), uint8(PanalEscrowV2_5.Close.Cancelled));
        assertEq(uint8(_reason(aceptado)), uint8(PanalEscrowV2_5.Close.Cancelled));
        assertEq(escrow.pendingWithdrawals(MON, client), 3 ether);
    }

    function test_WorkDeliveredBeforeTheSuspensionIsPaidByTheUsualRules() public {
        uint256 id = _delivered(1 ether);
        _suspender(worker);
        vm.prank(worker);
        vm.expectRevert("PanalEscrowV2_5: suspended");
        escrow.openDispute(id, bytes32(0));
        vm.warp(block.timestamp + 72 hours);
        escrow.release(_ids(id));
        vm.prank(worker);
        escrow.withdraw(MON);
        assertEq(worker.balance, 0.975 ether, "la regla del fundador no cambia");
    }

    function test_ClientCanStillDisputeWorkOfASuspendedAgent() public {
        uint256 id = _delivered(1 ether);
        _suspender(worker);
        vm.prank(client);
        escrow.openDispute(id, keccak256("entrega fraudulenta"));
        vm.prank(arbitrator);
        escrow.resolveDispute(id, 0, 1, bytes32(0));
        assertEq(escrow.pendingWithdrawals(MON, client), 1 ether);
    }

    function test_AcceptedWorkOfASuspendedClientIsDeliveredAndPaid() public {
        uint256 id = _createMon(1 ether);
        vm.prank(worker);
        escrow.acceptTask(id);
        _suspender(client);
        vm.prank(worker);
        escrow.deliverResult(id, RESULT);
        vm.warp(block.timestamp + 72 hours);
        vm.prank(worker);
        escrow.releaseAndWithdraw(_ids(id), MON);
        assertEq(worker.balance, 0.975 ether);
    }

    function test_JudgesAndAnyoneFunctionsIgnoreSuspensions() public {
        uint256 disputa = _delivered(2 ether);
        vm.prank(client);
        escrow.openDispute(disputa, bytes32(0));
        uint256 vencido = _createMon(1 ether);
        _suspender(worker);
        _suspender(client);

        vm.prank(arbitrator);
        escrow.resolveDispute(disputa, 5_000, 3, bytes32(0));
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(rando);
        assertEq(escrow.refundExpired(_ids(vencido)), 1);
        assertEq(escrow.pendingWithdrawals(MON, client), 2 ether);
    }

    function test_ReinstatedCanUsePanalAgain() public {
        _suspender(client);
        _rehabilitar(client);
        _createMon(1 ether);
        assertEq(escrow.getTaskCount(), 1);
    }

    function test_OnlyTheOwnerMultisigSuspends() public {
        address[] memory l = new address[](1);
        l[0] = worker;
        vm.prank(arbitrator);
        vm.expectRevert("PanalBans: not owner");
        bans.suspend(l, PRUEBAS);
        assertEq(address(escrow.bans()), address(bans));
    }
}
