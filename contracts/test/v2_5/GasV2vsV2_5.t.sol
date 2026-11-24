// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../src/v2/PanalEscrowV2.sol";
import "../../src/v2/PanalRegistryV2.sol";
import "../../src/PanalReputation.sol";
import "../../src/v2_5/PanalEscrowV2_5.sol";
import "../../src/v2_5/PanalReputationV2_5.sol";
import "../../src/PanalBans.sol";
import "./mocks/MockPermitToken.sol";

/// @notice El gas del recorrido de siempre (contratar en MON, entregar, aprobar y
///         retirar) en el v2 y en el v2.5, para comprobar la propuesta E2. En Monad
///         se paga el límite de gas, así que esto es lo que paga cada uno.
///
///         forge test --match-contract GasV2vsV2_5 -vv
contract GasV2vsV2_5 is Test {
    address client = makeAddr("cliente");
    address worker = makeAddr("agente");

    function _medir(string memory que, uint256 gasV2, uint256 gasV2_5) internal pure {
        console.log(string.concat(que, "  v2: ", vm.toString(gasV2), "  v2.5: ", vm.toString(gasV2_5)));
    }

    function test_GasDelRecorridoComun() public {
        MockPermitToken panal = new MockPermitToken("PANAL", "PANAL", "1", 18);
        PanalRegistryV2 registry = new PanalRegistryV2(address(panal));
        vm.prank(worker);
        registry.registerAgent("ipfs://agente", 1 ether, address(0));
        vm.deal(client, 100 ether);

        PanalReputation r2 = new PanalReputation();
        PanalEscrowV2 e2 = new PanalEscrowV2(address(registry), address(r2), makeAddr("t"), makeAddr("a"), address(panal));
        r2.setEscrow(address(e2));

        PanalReputationV2_5 r25 = new PanalReputationV2_5(address(0));
        PanalEscrowV2_5 e25 = new PanalEscrowV2_5(
            address(registry), address(r25), address(new PanalBans(makeAddr("o"))), makeAddr("o"), makeAddr("t"), makeAddr("a"), address(panal), address(0)
        );
        r25.setEscrow(address(e25));

        // Un primer encargo en cada uno, para medir el caso normal (no el primero de todos).
        _recorridoV2(e2);
        _recorridoV2_5(e25);

        uint256[4] memory a = _recorridoV2(e2);
        uint256[4] memory b = _recorridoV2_5(e25);
        _medir("contratar ", a[0], b[0]);
        _medir("entregar  ", a[1], b[1]);
        _medir("aprobar   ", a[2], b[2]);
        _medir("retirar   ", a[3], b[3]);
        _medir("TOTAL     ", a[0] + a[1] + a[2] + a[3], b[0] + b[1] + b[2] + b[3]);
        assertLt(b[0], a[0], "contratar tiene que salir mas barato");
    }

    function _recorridoV2(PanalEscrowV2 e) internal returns (uint256[4] memory g) {
        uint256 x = gasleft();
        vm.prank(client);
        uint256 id = e.createTask{value: 1 ether}(worker, keccak256("t"), block.timestamp + 1 days, address(0), 1 ether);
        g[0] = x - gasleft();
        x = gasleft();
        vm.prank(worker);
        e.deliverResult(id, keccak256("r"));
        g[1] = x - gasleft();
        x = gasleft();
        vm.prank(client);
        e.approveAndRelease(id, 5);
        g[2] = x - gasleft();
        x = gasleft();
        vm.prank(worker);
        e.withdraw(address(0));
        g[3] = x - gasleft();
    }

    function _recorridoV2_5(PanalEscrowV2_5 e) internal returns (uint256[4] memory g) {
        PanalEscrowV2_5.NewTask memory p;
        p.worker = worker;
        p.taskHash = keccak256("t");
        p.deadline = uint64(block.timestamp + 1 days);
        p.acceptWindow = 1 hours;
        p.reviewWindow = 72 hours;
        p.amount = 1 ether;
        uint256 x = gasleft();
        vm.prank(client);
        uint256 id = e.createTask{value: 1 ether}(p);
        g[0] = x - gasleft();
        x = gasleft();
        vm.prank(worker);
        e.deliverResult(id, keccak256("r"));
        g[1] = x - gasleft();
        x = gasleft();
        vm.prank(client);
        e.approveAndRelease(id, 5);
        g[2] = x - gasleft();
        x = gasleft();
        vm.prank(worker);
        e.withdraw(address(0));
        g[3] = x - gasleft();
    }
}
