// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Lo que se usa del registro de agentes (PanalRegistryV2).
interface IPricesRegistry {
    function isActiveAgent(address agent) external view returns (bool);
}

/// @notice Lo que se usa de la lista de suspendidos (PanalBans).
interface IPricesBans {
    function isBanned(address account) external view returns (bool);
}

/// @title PanalPrices
/// @notice Lo que cobra cada agente en cada moneda: MON, $PANAL y USDC.
///
/// POR QUÉ HACE FALTA. `PanalRegistryV2` guarda un precio y una moneda por
/// agente, y solo admite MON o $PANAL. El escrow v2.5 acepta además USDC, y un
/// agente puede querer cobrar en varias. Cambiar el registro obligaría a que
/// todos se dieran de alta otra vez y a desplegar otro contrato de nombres; este
/// contrato es puramente aditivo y no toca nada de lo que ya funciona.
///
/// QUÉ GUARDA. Por agente y por moneda, una lista de hasta 8 precios, de menor a
/// mayor, en unidades enteras del token (USDC tiene 6 decimales: 2,50 USDC son
/// 2_500_000).
///   - Si el agente publica niveles en su ficha (`nivel:<precio>|<nombre>|…`),
///     el precio i es el de su nivel i, en el mismo orden en que el SDK los lee
///     (`leerNivelesDeMetadata`, de menor a mayor). Si el número de precios no
///     coincide con el de niveles, quien lee no debe usar la lista: un precio
///     cambiado de nivel es peor que ninguno.
///   - Si no tiene niveles, la lista lleva un solo precio.
///   - Una lista vacía significa que no acepta esa moneda.
///
/// ES INFORMATIVO, COMO EL PRECIO DEL REGISTRO. El escrow no lo lee: el importe
/// lo fija el cliente al contratar. Tampoco comprueba los mínimos del escrow
/// (0,01 USDC, 1 $PANAL, 0,001 MON), que pueden cambiar de una versión a otra;
/// eso lo avisa la interfaz.
///
/// SUSPENDIDOS (PanalBans). Una dirección suspendida no publica precios y
/// `accepts` devuelve false; sí puede vaciar sus listas.
///
/// SIN DUEÑO. No hay nada que administrar ni comisiones. Si la política sale mal,
/// se despliega otro y se deja de leer este.
contract PanalPrices {
    /// @notice Precios por moneda, como máximo. El mismo tope de niveles que lee el SDK.
    uint256 public constant MAX_PRICES = 8;

    IPricesRegistry public immutable REGISTRY;
    IPricesBans public immutable BANS;
    address public immutable PANAL_TOKEN;
    address public immutable USDC_TOKEN;

    /// @dev agente => moneda => precios (address(0) = MON). Dos por slot.
    mapping(address => mapping(address => uint128[])) private _prices;
    /// @notice agente => moneda => cuándo los publicó por última vez.
    mapping(address => mapping(address => uint64)) public updatedAt;

    event PricesSet(address indexed agent, address indexed currency, uint128[] amounts);

    constructor(address registry_, address bans_, address panalToken_, address usdcToken_) {
        require(registry_.code.length > 0, "PanalPrices: registry not contract");
        require(bans_.code.length > 0, "PanalPrices: bans not contract");
        require(panalToken_.code.length > 0 && usdcToken_.code.length > 0, "PanalPrices: token not contract");
        require(panalToken_ != usdcToken_, "PanalPrices: same token");
        REGISTRY = IPricesRegistry(registry_);
        BANS = IPricesBans(bans_);
        PANAL_TOKEN = panalToken_;
        USDC_TOKEN = usdcToken_;
    }

    /// @notice Publica los precios de quien llama en una moneda; sustituye a los
    ///         que tenía. Lista vacía = deja de aceptar esa moneda (eso se puede
    ///         hacer aunque ya no esté activo en el registro).
    /// @param currency address(0) = MON, PANAL_TOKEN o USDC_TOKEN.
    /// @param amounts de menor a mayor (pueden repetirse), ninguno a 0.
    function setPrices(address currency, uint128[] calldata amounts) external {
        require(
            currency == address(0) || currency == PANAL_TOKEN || currency == USDC_TOKEN,
            "PanalPrices: unsupported currency"
        );
        require(amounts.length <= MAX_PRICES, "PanalPrices: too many prices");
        if (amounts.length > 0) {
            require(REGISTRY.isActiveAgent(msg.sender), "PanalPrices: not an active agent");
            require(!BANS.isBanned(msg.sender), "PanalPrices: suspended");
            for (uint256 i = 0; i < amounts.length; i++) {
                require(amounts[i] > 0, "PanalPrices: zero price");
                require(i == 0 || amounts[i] >= amounts[i - 1], "PanalPrices: not ascending");
            }
        }
        _prices[msg.sender][currency] = amounts;
        updatedAt[msg.sender][currency] = uint64(block.timestamp);
        emit PricesSet(msg.sender, currency, amounts);
    }

    /// @notice Los precios de un agente en una moneda (vacío si no la acepta).
    function getPrices(address agent, address currency) external view returns (uint128[] memory) {
        return _prices[agent][currency];
    }

    /// @notice Los precios de un agente en las tres monedas, en una sola lectura.
    function getAllPrices(address agent)
        external
        view
        returns (uint128[] memory mon, uint128[] memory panal, uint128[] memory usdc)
    {
        return (_prices[agent][address(0)], _prices[agent][PANAL_TOKEN], _prices[agent][USDC_TOKEN]);
    }

    /// @notice true si el agente está activo en el registro, no está suspendido y
    ///         publica precios en esa moneda.
    function accepts(address agent, address currency) external view returns (bool) {
        return _prices[agent][currency].length > 0 && REGISTRY.isActiveAgent(agent) && !BANS.isBanned(agent);
    }
}
