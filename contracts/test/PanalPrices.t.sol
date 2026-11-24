// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PanalPrices.sol";
import "../src/v2/PanalRegistryV2.sol";
import "../src/PanalBans.sol";
import "./v2_5/mocks/MockPermitToken.sol";

contract PanalPricesTest is Test {
    PanalPrices prices;
    PanalRegistryV2 registry;
    PanalBans bans;
    address dueno = makeAddr("dueno");
    MockPermitToken panal;
    MockPermitToken usdc;

    address agente = makeAddr("agente");
    address otro = makeAddr("otro");
    address constant MON = address(0);

    event PricesSet(address indexed agent, address indexed currency, uint128[] amounts);

    function setUp() public {
        panal = new MockPermitToken("PANAL", "PANAL", "1", 18);
        usdc = new MockPermitToken("USDC", "USDC", "2", 6);
        registry = new PanalRegistryV2(address(panal));
        bans = new PanalBans(dueno);
        prices = new PanalPrices(address(registry), address(bans), address(panal), address(usdc));
        vm.prank(agente);
        registry.registerAgent("ipfs://agente", 1 ether, MON);
    }

    function _lista(uint128 a, uint128 b, uint128 c) internal pure returns (uint128[] memory l) {
        l = new uint128[](3);
        (l[0], l[1], l[2]) = (a, b, c);
    }

    function _uno(uint128 a) internal pure returns (uint128[] memory l) {
        l = new uint128[](1);
        l[0] = a;
    }

    function test_Constructor() public view {
        assertEq(address(prices.REGISTRY()), address(registry));
        assertEq(prices.PANAL_TOKEN(), address(panal));
        assertEq(prices.USDC_TOKEN(), address(usdc));
        assertEq(prices.MAX_PRICES(), 8);
    }

    function test_ConstructorValidations() public {
        vm.expectRevert("PanalPrices: registry not contract");
        new PanalPrices(otro, address(bans), address(panal), address(usdc));
        vm.expectRevert("PanalPrices: bans not contract");
        new PanalPrices(address(registry), otro, address(panal), address(usdc));
        vm.expectRevert("PanalPrices: token not contract");
        new PanalPrices(address(registry), address(bans), otro, address(usdc));
        vm.expectRevert("PanalPrices: same token");
        new PanalPrices(address(registry), address(bans), address(usdc), address(usdc));
    }

    /// Tres niveles en USDC: 0,50, 2 y 5 USDC (6 decimales).
    function test_AgentPublishesTierPricesInUsdc() public {
        uint128[] memory l = _lista(500_000, 2_000_000, 5_000_000);
        vm.expectEmit(true, true, false, true);
        emit PricesSet(agente, address(usdc), l);
        vm.prank(agente);
        prices.setPrices(address(usdc), l);

        uint128[] memory leidos = prices.getPrices(agente, address(usdc));
        assertEq(leidos.length, 3);
        assertEq(leidos[0], 500_000);
        assertEq(leidos[2], 5_000_000);
        assertEq(prices.updatedAt(agente, address(usdc)), block.timestamp);
        assertTrue(prices.accepts(agente, address(usdc)));
        assertFalse(prices.accepts(agente, MON), "en MON no ha publicado nada");
    }

    function test_AllThreeCurrencies() public {
        vm.startPrank(agente);
        prices.setPrices(MON, _uno(0.5 ether));
        prices.setPrices(address(panal), _uno(40e18));
        prices.setPrices(address(usdc), _uno(1_000_000));
        vm.stopPrank();
        (uint128[] memory mon, uint128[] memory p, uint128[] memory u) = prices.getAllPrices(agente);
        assertEq(mon[0], 0.5 ether);
        assertEq(p[0], 40e18);
        assertEq(u[0], 1_000_000);
    }

    function test_NewListReplacesTheOld() public {
        vm.startPrank(agente);
        prices.setPrices(address(usdc), _lista(1, 2, 3));
        prices.setPrices(address(usdc), _uno(7));
        vm.stopPrank();
        uint128[] memory l = prices.getPrices(agente, address(usdc));
        assertEq(l.length, 1);
        assertEq(l[0], 7);
    }

    function test_EmptyListStopsAcceptingEvenIfInactive() public {
        vm.prank(agente);
        prices.setPrices(address(usdc), _uno(1_000_000));
        vm.prank(agente);
        registry.setActive(false);
        assertFalse(prices.accepts(agente, address(usdc)), "inactivo: no acepta aunque tenga precios");

        vm.prank(agente);
        prices.setPrices(address(usdc), new uint128[](0));
        assertEq(prices.getPrices(agente, address(usdc)).length, 0);
    }

    function test_OnlyActiveAgentsPublish() public {
        vm.prank(otro);
        vm.expectRevert("PanalPrices: not an active agent");
        prices.setPrices(address(usdc), _uno(1));
    }

    function test_Validations() public {
        vm.startPrank(agente);
        vm.expectRevert("PanalPrices: unsupported currency");
        prices.setPrices(makeAddr("otroToken"), _uno(1));

        vm.expectRevert("PanalPrices: zero price");
        prices.setPrices(address(usdc), _lista(1, 0, 3));

        vm.expectRevert("PanalPrices: not ascending");
        prices.setPrices(address(usdc), _lista(3, 2, 5));

        uint128[] memory nueve = new uint128[](9);
        for (uint256 i; i < 9; i++) nueve[i] = uint128(i + 1);
        vm.expectRevert("PanalPrices: too many prices");
        prices.setPrices(address(usdc), nueve);
        vm.stopPrank();
    }

    function test_EqualPricesAreAllowed() public {
        vm.prank(agente);
        prices.setPrices(address(usdc), _lista(5, 5, 5));
        assertEq(prices.getPrices(agente, address(usdc)).length, 3);
    }

    function test_EachAgentOnlyTouchesItsOwn() public {
        vm.prank(otro);
        registry.registerAgent("ipfs://otro", 1 ether, MON);
        vm.prank(agente);
        prices.setPrices(address(usdc), _uno(10));
        vm.prank(otro);
        prices.setPrices(address(usdc), _uno(20));
        assertEq(prices.getPrices(agente, address(usdc))[0], 10);
        assertEq(prices.getPrices(otro, address(usdc))[0], 20);
    }

    function testFuzz_AnyAscendingListRoundTrips(uint128[8] memory crudo, uint8 n) public {
        n = uint8(bound(n, 0, 8));
        uint128[] memory l = new uint128[](n);
        uint128 acumulado;
        for (uint256 i; i < n; i++) {
            uint128 paso = uint128(bound(crudo[i], 1, type(uint128).max / 16));
            acumulado += paso;
            l[i] = acumulado;
        }
        vm.prank(agente);
        prices.setPrices(address(usdc), l);
        uint128[] memory leidos = prices.getPrices(agente, address(usdc));
        assertEq(leidos.length, n);
        for (uint256 i; i < n; i++) assertEq(leidos[i], l[i]);
    }

    function test_SuspendedAgentCannotPublishButCanClear() public {
        vm.prank(agente);
        prices.setPrices(address(usdc), _uno(1_000_000));
        address[] memory l = new address[](1);
        l[0] = agente;
        vm.prank(dueno);
        bans.suspend(l, keccak256("pruebas"));

        assertFalse(prices.accepts(agente, address(usdc)), "suspendido: no acepta");
        vm.prank(agente);
        vm.expectRevert("PanalPrices: suspended");
        prices.setPrices(address(usdc), _uno(2_000_000));
        vm.prank(agente);
        prices.setPrices(address(usdc), new uint128[](0));
        assertEq(prices.getPrices(agente, address(usdc)).length, 0);
    }
}
