// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PanalPrices.sol";
import "../src/PanalBans.sol";

/// @notice PanalPrices contra el registro real de Monad mainnet, en un fork.
///
///         forge test --match-path test/PanalPricesFork.t.sol --fork-url https://rpc.monad.xyz
contract PanalPricesForkTest is Test {
    address constant REGISTRY = 0x89a812BFb1c35fc814ef25a3E6Ca75068B16Ac51;
    address constant PANAL = 0x2E2e44E7FA6178822D4397299F719e89d1a67777;
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    /// Lint: activo, con 3 niveles en su ficha (1, 2 y 4 $PANAL el 23-nov).
    address constant LINT = 0x1558cF6aed695F3F8AafE488058EfE28d216E69C;
    /// Un agente del v2 que hoy está inactivo.
    address constant INACTIVO = 0x17b59Ac5B740De1549F6F92D47599Eaaf99F9302;

    PanalPrices prices;

    function setUp() public {
        if (block.chainid != 143) return;
        prices = new PanalPrices(REGISTRY, address(new PanalBans(0xd1AA9e0b6c4215740d464847210e5CCfDce7d7A1)), PANAL, USDC);
    }

    function test_LintPublicaSusTresNivelesEnUsdc() public {
        if (block.chainid != 143) return;
        uint128[] memory l = new uint128[](3);
        (l[0], l[1], l[2]) = (500_000, 1_000_000, 2_000_000); // 0,50 · 1 · 2 USDC
        vm.prank(LINT);
        prices.setPrices(USDC, l);
        assertTrue(prices.accepts(LINT, USDC));
        assertEq(prices.getPrices(LINT, USDC)[2], 2_000_000);
    }

    function test_UnAgenteInactivoNoPublica() public {
        if (block.chainid != 143) return;
        uint128[] memory l = new uint128[](1);
        l[0] = 1_000_000;
        vm.prank(INACTIVO);
        vm.expectRevert("PanalPrices: not an active agent");
        prices.setPrices(USDC, l);
    }
}
