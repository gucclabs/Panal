// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/v2_5/PanalEscrowV2_5.sol";
import "../src/v2_5/PanalReputationV2_5.sol";
import "../src/PanalBans.sol";
import "../src/PanalPrices.sol";
import "../src/v2_5/PanalTablonV2_5.sol";

/// @notice El precio de MON/USD de Pyth en Monad (el mismo que usa el SDK).
interface IPythPrecio {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    function getPriceUnsafe(bytes32 id) external view returns (Price memory);
}

/// @notice Lo que se copia del tablón v2 en mainnet.
interface ITablonV2Config {
    function levels(uint256 i) external view returns (uint32 minCompleted, uint16 minRating, uint16 dailyCap);
    function newcomerJobs() external view returns (uint8);
    function caps(address currency) external view returns (uint256 perJob, uint256 total);
}

/// @notice Despliega el escrow v2.5 con todo lo suyo, y lo enlaza.
///
///   1. PanalBans, la lista de suspendidos, con el multisig dueño como dueño.
///   2. PanalReputationV2_5, que suma la reputación del v2 (lectura encadenada).
///   3. PanalEscrowV2_5, con el multisig dueño como dueño y tesorería desde el
///      primer bloque, los jueces de siempre como árbitro y sin jueces
///      autónomos (se añaden después, con 3 días de espera).
///   4. reputation.setEscrow(escrow): la reputación queda cerrada para siempre.
///   5. PanalPrices, los precios en MON, $PANAL y USDC, con la misma lista.
///   6. PanalTablonV2_5, delante del escrow, con el multisig dueño como dueño.
///      Copia del tablón v2 de mainnet la tabla de niveles, los encargos de
///      novato y los topes en MON y $PANAL. Los topes en USDC son los de MON
///      pasados a dólares con el precio de MON/USD de Pyth en ese momento
///      (decidido el 24-nov-2026), redondeados a la baja al céntimo. Si Pyth
///      tiene más de una hora o es poco preciso, el script se para: entonces se
///      fijan a mano con TABLON_USDC_POR_ENCARGO y TABLON_USDC_TOTAL (6 decimales).
///
/// Reutiliza el registro del v2: nadie tiene que darse de alta otra vez, y los
/// nombres (PanalNames) siguen igual. Quien despliega no se queda con ningún poder.
///
///   forge script script/DeployV2_5.s.sol --rpc-url https://rpc.monad.xyz \
///     --account panal-desplegador --password-file <archivo> --disable-code-size-limit [--broadcast]
///
/// --disable-code-size-limit hace falta porque el tablón pasa de los 24 KB de
/// Ethereum; Monad admite hasta 128 KB.
///
/// Sin --broadcast solo simula. Los valores por defecto son los de Monad mainnet,
/// comprobados el 23-nov-2026; cada uno se puede cambiar con su variable.
contract DeployV2_5 is Script {
    address constant PYTH = 0x2880aB155794e7179c9eE2e38200202908C17B43;
    bytes32 constant PYTH_MON_USD = 0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1;
    uint256 constant PRECIO_MAX_EDAD = 1 hours;

    /// @notice La configuración del tablón v2.5: la del v2 de mainnet, más los topes en USDC.
    struct TablonConfig {
        PanalTablonV2_5.Level[5] levels;
        uint8 newcomerJobs;
        PanalTablonV2_5.Caps mon;
        PanalTablonV2_5.Caps panal;
        PanalTablonV2_5.Caps usdc;
    }

    /// @dev Lee la configuración del tablón v2 tal como está hoy en la cadena.
    function _tablonConfig(address panal) internal view returns (TablonConfig memory c) {
        ITablonV2Config v2 = ITablonV2Config(vm.envOr("TABLON_V2", 0x2Cfc6803E269fa9BF728e202736a7bc0547ae149));
        for (uint256 i; i < 5; i++) {
            (uint32 completed, uint16 rating, uint16 daily) = v2.levels(i);
            c.levels[i] = PanalTablonV2_5.Level(completed, rating, daily);
        }
        c.newcomerJobs = v2.newcomerJobs();
        (c.mon.perJob, c.mon.total) = v2.caps(address(0));
        (c.panal.perJob, c.panal.total) = v2.caps(panal);
        c.usdc = _usdcCaps(c.mon);
    }

    /// @dev Los topes de MON en dólares, al precio de Pyth de ahora. 0 sigue
    ///      siendo «sin tope». Con TABLON_USDC_POR_ENCARGO se fijan a mano.
    function _usdcCaps(PanalTablonV2_5.Caps memory mon) internal view returns (PanalTablonV2_5.Caps memory u) {
        uint256 aMano = vm.envOr("TABLON_USDC_POR_ENCARGO", uint256(0));
        if (aMano != 0) {
            u = PanalTablonV2_5.Caps(aMano, vm.envUint("TABLON_USDC_TOTAL"));
            console.log("Topes en USDC fijados a mano");
        } else {
            IPythPrecio.Price memory p = IPythPrecio(vm.envOr("PYTH", PYTH)).getPriceUnsafe(PYTH_MON_USD);
            require(p.price > 0 && p.expo < 0 && p.expo >= -18, "precio de Pyth raro");
            require(p.publishTime + PRECIO_MAX_EDAD >= block.timestamp, "precio de Pyth de hace mas de 1 h");
            require(uint256(p.conf) * 100 <= uint256(uint64(p.price)), "precio de Pyth con mas de 1 % de margen");
            u.perJob = _enUsdc(mon.perJob, p);
            u.total = _enUsdc(mon.total, p);
            console.log("MON/USD de Pyth (precio, decimales):", uint256(uint64(p.price)), uint256(uint32(-p.expo)));
        }
        require((u.perJob == 0) == (mon.perJob == 0) && (u.total == 0) == (mon.total == 0), "topes de USDC sin sentido");
        require(u.total == 0 || u.total >= u.perJob, "tope total menor que el de un encargo");
        console.log("Tope USDC por encargo (6 decimales):", u.perJob);
        console.log("Tope USDC total (6 decimales):      ", u.total);
    }

    /// @dev MON (18 decimales) a USDC (6), a la baja al céntimo.
    function _enUsdc(uint256 monWei, IPythPrecio.Price memory p) internal pure returns (uint256 v) {
        v = (monWei * uint256(uint64(p.price)) * 1e6) / (1e18 * 10 ** uint256(uint32(-p.expo)));
        if (v >= 1e4) v -= v % 1e4;
    }

    function _deployTablon(address escrow, address owner, TablonConfig memory c) internal returns (PanalTablonV2_5) {
        return new PanalTablonV2_5(escrow, owner, c.levels, c.newcomerJobs, c.mon, c.panal, c.usdc);
    }

    function _comprobarTablon(
        PanalTablonV2_5 tablon,
        address escrow,
        address bans,
        address owner,
        address usdc,
        TablonConfig memory c
    ) internal view {
        require(address(tablon.escrow()) == escrow && tablon.owner() == owner, "tablon sin enlazar");
        require(address(tablon.bans()) == bans, "tablon sin la lista");
        (uint256 porEncargo, uint256 total) = tablon.caps(usdc);
        require(porEncargo == c.usdc.perJob && total == c.usdc.total, "topes de USDC distintos");
        (porEncargo, total) = tablon.caps(address(0));
        require(porEncargo == c.mon.perJob && total == c.mon.total, "topes de MON distintos");
    }

    function run() external {
        address registry = vm.envOr("REGISTRY", 0x89a812BFb1c35fc814ef25a3E6Ca75068B16Ac51);
        address previous = vm.envOr("REPUTATION_V2", 0xAa15923A93B7A2261D051F9F4302ca05e9a16701);
        address owner = vm.envOr("OWNER", 0xd1AA9e0b6c4215740d464847210e5CCfDce7d7A1); // PanalMultisigV2
        address treasury = vm.envOr("TREASURY", owner);
        address arbitrator = vm.envOr("ARBITRATOR", 0xc384C1F5D6716571DA84329BeAaE6F064C6b1Fe0); // jueces
        address panal = vm.envOr("PANAL_TOKEN", 0x2E2e44E7FA6178822D4397299F719e89d1a67777);
        address usdc = vm.envOr("USDC_TOKEN", 0x754704Bc059F8C67012fEd69BC8A327a5aafb603);
        TablonConfig memory config = _tablonConfig(panal);

        // El dueño y la tesorería tienen que ser el multisig de verdad, no una wallet.
        require(owner.code.length > 0, "OWNER no es un contrato");
        {
            (bool ok, bytes memory r) = owner.staticcall(abi.encodeWithSignature("REQUIRED()"));
            require(ok && r.length == 32 && abi.decode(r, (uint8)) == 2, "OWNER no es un multisig 2 de 3");
        }
        {
            uint256 clave = vm.envOr("PRIVATE_KEY", uint256(0));
            if (clave != 0) vm.startBroadcast(clave);
            else vm.startBroadcast();
        }
        PanalBans bans = new PanalBans(owner);
        PanalReputationV2_5 rep = new PanalReputationV2_5(previous);
        PanalEscrowV2_5 escrow =
            new PanalEscrowV2_5(registry, address(rep), address(bans), owner, treasury, arbitrator, panal, usdc);
        rep.setEscrow(address(escrow));
        PanalPrices prices = new PanalPrices(registry, address(bans), panal, usdc);
        PanalTablonV2_5 tablon = _deployTablon(address(escrow), owner, config);
        vm.stopBroadcast();

        require(rep.escrow() == address(escrow), "reputacion sin enlazar");
        require(escrow.owner() == owner && escrow.treasury() == treasury, "roles inesperados");
        require(bans.owner() == owner && address(escrow.bans()) == address(bans), "suspensiones sin enlazar");
        require(escrow.autoArbitrator() == address(0), "jueces autonomos inesperados");
        _comprobarTablon(tablon, address(escrow), address(bans), owner, usdc, config);

        console.log("PanalBans:           ", address(bans));
        console.log("PanalPrices:         ", address(prices));
        console.log("PanalReputationV2_5: ", address(rep));
        console.log("PanalEscrowV2_5:     ", address(escrow));
        console.log("PanalTablonV2_5:     ", address(tablon));
        console.log("owner / treasury:    ", owner);
        console.log("arbitrator:          ", arbitrator);
    }
}
