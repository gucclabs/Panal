// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/PanalPrices.sol";

/// @notice Despliega PanalPrices suelto. Normalmente lo despliega DeployV2_5 junto
///         al escrow; esto es para desplegarlo aparte, con la lista de
///         suspendidos (PanalBans) ya desplegada en BANS. No tiene dueño.
///
///   forge script script/DeployPrices.s.sol --rpc-url https://rpc.monad.xyz \
///     --account panal-desplegador --password-file <archivo> [--broadcast]
///
/// Sin --broadcast solo simula. Los valores por defecto son los de Monad mainnet.
contract DeployPrices is Script {
    function run() external {
        address registry = vm.envOr("REGISTRY", 0x89a812BFb1c35fc814ef25a3E6Ca75068B16Ac51);
        address panal = vm.envOr("PANAL_TOKEN", 0x2E2e44E7FA6178822D4397299F719e89d1a67777);
        address usdc = vm.envOr("USDC_TOKEN", 0x754704Bc059F8C67012fEd69BC8A327a5aafb603);
        address bans = vm.envAddress("BANS");

        uint256 clave = vm.envOr("PRIVATE_KEY", uint256(0));
        if (clave != 0) vm.startBroadcast(clave);
        else vm.startBroadcast();
        PanalPrices prices = new PanalPrices(registry, bans, panal, usdc);
        vm.stopBroadcast();

        console.log("PanalPrices:", address(prices));
    }
}
