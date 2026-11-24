// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Lo que se lee de la reputación anterior (PanalReputation del v2).
interface IPanalReputationV2 {
    struct ReputationV2 {
        uint256 tasksCompleted;
        uint256 totalEarned;
        uint256 ratingSum;
        uint256 ratingCount;
    }

    function getReputation(address agent) external view returns (ReputationV2 memory);
}

/// @title PanalReputationV2_5
/// @notice Reputación on-chain del escrow v2.5, que SUMA la del v2 leyéndola
///         (lectura encadenada). Nadie copia números de una a otra: la del v2
///         solo la puede escribir el escrow v2, y esta solo el v2.5.
///
///         Qué cambia respecto a la del v2:
///           - Un encargo completado puede no tener nota (D1): liberado por
///             tiempo, de mutuo acuerdo o por una disputa sin decisión.
///             Cuenta como completado, pero no entra en la media.
///           - Perder una disputa entera también cuenta (D3): la nota de los
///             jueces entra en la media y suma una disputa perdida, sin contar
///             el encargo como completado.
///           - Lo ganado va por moneda (`earned(agent, token)`): MON, $PANAL y
///             USDC no se pueden sumar (USDC tiene 6 decimales).
///
///         No tiene dueño. Quien la despliega solo puede enlazarla a su escrow,
///         una vez (`setEscrow`), y después nadie puede cambiar nada.
contract PanalReputationV2_5 {
    struct Reputation {
        uint256 tasksCompleted; // completados, con o sin nota (incluye los del v2)
        uint256 ratingSum;      // suma de las notas de 1 a 5 (incluye las del v2)
        uint256 ratingCount;    // cuántas notas (incluye las del v2)
        uint256 disputesLost;   // disputas en las que los jueces dieron todo al cliente
    }

    /// @notice La reputación del v2, que se suma al leer. address(0) = ninguna.
    IPanalReputationV2 public immutable previous;
    /// @notice Quien la desplegó: solo puede llamar a `setEscrow`, una vez.
    address public immutable deployer;
    /// @notice El único que puede escribir.
    address public escrow;

    mapping(address => Reputation) private _own;
    mapping(address => mapping(address => uint256)) public earned;

    event EscrowSet(address indexed escrow);
    event CompletionRecorded(address indexed agent, uint8 rating, address indexed currency, uint256 earned);
    event DisputeLostRecorded(address indexed agent, uint8 rating);

    modifier onlyEscrow() {
        require(msg.sender == escrow, "PanalReputationV2_5: not escrow");
        _;
    }

    /// @param previous_ la reputación del v2 (en mainnet, 0xAa15…6701), o
    ///        address(0) para empezar de cero.
    constructor(address previous_) {
        if (previous_ != address(0)) {
            require(previous_.code.length > 0, "PanalReputationV2_5: previous not contract");
        }
        previous = IPanalReputationV2(previous_);
        deployer = msg.sender;
    }

    /// @notice Enlaza el escrow que la escribirá. Una sola vez.
    function setEscrow(address escrow_) external {
        require(msg.sender == deployer, "PanalReputationV2_5: not deployer");
        require(escrow == address(0), "PanalReputationV2_5: escrow already set");
        require(escrow_.code.length > 0, "PanalReputationV2_5: escrow not contract");
        escrow = escrow_;
        emit EscrowSet(escrow_);
    }

    /// @notice Un encargo completado. `rating` 0 = sin nota; si no, de 1 a 5.
    function recordCompletion(address agent, uint8 rating, address currency, uint256 amount) external onlyEscrow {
        require(rating <= 5, "PanalReputationV2_5: invalid rating");
        Reputation storage r = _own[agent];
        r.tasksCompleted += 1;
        if (rating != 0) {
            r.ratingSum += rating;
            r.ratingCount += 1;
        }
        earned[agent][currency] += amount;
        emit CompletionRecorded(agent, rating, currency, amount);
    }

    /// @notice Una disputa que los jueces dieron entera al cliente, con su nota.
    function recordDisputeLost(address agent, uint8 rating) external onlyEscrow {
        require(rating >= 1 && rating <= 5, "PanalReputationV2_5: invalid rating");
        Reputation storage r = _own[agent];
        r.ratingSum += rating;
        r.ratingCount += 1;
        r.disputesLost += 1;
        emit DisputeLostRecorded(agent, rating);
    }

    /// @notice La reputación total: la de esta versión más la del v2.
    function getReputation(address agent) public view returns (Reputation memory r) {
        r = _own[agent];
        if (address(previous) != address(0)) {
            IPanalReputationV2.ReputationV2 memory p = previous.getReputation(agent);
            r.tasksCompleted += p.tasksCompleted;
            r.ratingSum += p.ratingSum;
            r.ratingCount += p.ratingCount;
        }
    }

    /// @notice Solo lo de esta versión, sin el v2.
    function getOwnReputation(address agent) external view returns (Reputation memory) {
        return _own[agent];
    }

    /// @notice Nota media ×100 (487 = 4,87), sumando el v2. 0 si no hay notas.
    function getScore(address agent) external view returns (uint256) {
        Reputation memory r = getReputation(agent);
        if (r.ratingCount == 0) return 0;
        return (r.ratingSum * 100) / r.ratingCount;
    }
}
