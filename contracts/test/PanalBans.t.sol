// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PanalBans.sol";

contract PanalBansTest is Test {
    PanalBans bans;
    address dueno = makeAddr("multisigDueno");
    address a = makeAddr("a");
    address b = makeAddr("b");
    address extrano = makeAddr("extrano");
    bytes32 constant PRUEBAS = keccak256("orden judicial");
    bytes32 constant LEVANTA = keccak256("sobreseido");

    event AccountSuspended(address indexed account, bytes32 reasonHash);
    event AccountReinstated(address indexed account, bytes32 reasonHash);

    function setUp() public {
        bans = new PanalBans(dueno);
    }

    function _l(address x) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = x;
    }

    function _l(address x, address y) internal pure returns (address[] memory l) {
        l = new address[](2);
        (l[0], l[1]) = (x, y);
    }

    function test_Constructor() public {
        assertEq(bans.owner(), dueno);
        assertEq(bans.bannedCount(), 0);
        vm.expectRevert("PanalBans: zero owner");
        new PanalBans(address(0));
    }

    function test_SuspendRecordsDateAndEvidenceHash() public {
        vm.warp(1_800_000_000);
        vm.expectEmit(true, false, false, true);
        emit AccountSuspended(a, PRUEBAS);
        vm.prank(dueno);
        bans.suspend(_l(a), PRUEBAS);
        assertTrue(bans.isBanned(a));
        assertFalse(bans.isBanned(b));
        (uint64 since, bytes32 reason) = bans.getBan(a);
        assertEq(since, 1_800_000_000);
        assertEq(reason, PRUEBAS);
        assertEq(bans.bannedCount(), 1);
    }

    function test_SuspendSeveralAndSkipRepeats() public {
        vm.startPrank(dueno);
        bans.suspend(_l(a, b), PRUEBAS);
        bans.suspend(_l(a), keccak256("otra"));
        vm.stopPrank();
        assertEq(bans.bannedCount(), 2, "una vez cada una");
        (, bytes32 reason) = bans.getBan(a);
        assertEq(reason, PRUEBAS, "la primera huella no se pisa");
    }

    function test_SuspendValidations() public {
        vm.prank(extrano);
        vm.expectRevert("PanalBans: not owner");
        bans.suspend(_l(a), PRUEBAS);
        vm.startPrank(dueno);
        vm.expectRevert("PanalBans: reason required");
        bans.suspend(_l(a), bytes32(0));
        vm.expectRevert("PanalBans: zero address");
        bans.suspend(_l(address(0)), PRUEBAS);
        vm.stopPrank();
    }

    function test_Reinstate() public {
        vm.prank(dueno);
        bans.suspend(_l(a, b), PRUEBAS);
        vm.expectEmit(true, false, false, true);
        emit AccountReinstated(a, LEVANTA);
        vm.prank(dueno);
        bans.reinstate(_l(a, extrano), LEVANTA); // extrano no estaba: se salta
        assertFalse(bans.isBanned(a));
        assertTrue(bans.isBanned(b));
        assertEq(bans.bannedCount(), 1);
        (uint64 since, bytes32 reason) = bans.getBan(a);
        assertEq(since, 0);
        assertEq(reason, bytes32(0));
    }

    function test_ReinstateValidations() public {
        vm.prank(extrano);
        vm.expectRevert("PanalBans: not owner");
        bans.reinstate(_l(a), LEVANTA);
        vm.prank(dueno);
        vm.expectRevert("PanalBans: reason required");
        bans.reinstate(_l(a), bytes32(0));
    }

    function test_IsEitherBanned() public {
        vm.prank(dueno);
        bans.suspend(_l(b), PRUEBAS);
        assertTrue(bans.isEitherBanned(a, b));
        assertTrue(bans.isEitherBanned(b, address(0)));
        assertFalse(bans.isEitherBanned(a, address(0)));
    }

    function test_TwoStepOwnership() public {
        vm.prank(dueno);
        bans.transferOwnership(extrano);
        assertEq(bans.owner(), dueno);
        vm.prank(a);
        vm.expectRevert("PanalBans: not pending owner");
        bans.acceptOwnership();
        vm.prank(extrano);
        bans.acceptOwnership();
        assertEq(bans.owner(), extrano);
        vm.prank(dueno);
        vm.expectRevert("PanalBans: not owner");
        bans.suspend(_l(a), PRUEBAS);
    }

    /// Con cualquier secuencia de suspender y levantar, la cuenta cuadra.
    function testFuzz_CountMatches(uint256 semilla) public {
        address[4] memory gente = [a, b, extrano, makeAddr("d")];
        for (uint256 i; i < 24; i++) {
            uint256 r = uint256(keccak256(abi.encode(semilla, i)));
            vm.prank(dueno);
            if (r % 2 == 0) bans.suspend(_l(gente[r % 4]), PRUEBAS);
            else bans.reinstate(_l(gente[(r >> 8) % 4]), LEVANTA);
        }
        uint256 n;
        for (uint256 k; k < 4; k++) if (bans.isBanned(gente[k])) n++;
        assertEq(bans.bannedCount(), n);
    }
}
