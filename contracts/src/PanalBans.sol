// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PanalBans
/// @notice La lista de direcciones suspendidas de Panal: una sola para todo.
///         La leen el escrow v2.5, el tablón v2.5 y PanalPrices en la cadena, y
///         la web, la app, el MCP, el buzón y el indexador fuera de ella.
///
/// LA REGLA (decidida el 23-nov-2026): SUSPENDER NUNCA LE QUITA DINERO A NADIE.
///   Una dirección suspendida no puede empezar nada nuevo en Panal, pero puede
///   retirar siempre su saldo, y lo que ya estaba en marcha se termina con las
///   reglas de siempre. Así este poder no sirve para quedarse con fondos.
///
/// QUIÉN SUSPENDE: el dueño, que es el multisig dueño (2 de 3). Con efecto
///   inmediato, porque no mueve dinero, y se puede revertir.
///
/// QUÉ QUEDA EN LA CADENA: solo que la dirección está suspendida y la huella de
///   las pruebas (`reasonHash`). Ni el motivo ni las pruebas: señalar a alguien
///   como delincuente por error sería grave y no se podría borrar. Por qué se
///   suspende lo fija una política escrita (orden judicial o policial, listas de
///   sanciones, fraude demostrado en una disputa de Panal).
///
/// LO QUE NO PUEDE: el registro, los nombres y el escrow v2 se desplegaron antes
///   y no leen esta lista. La web y la app ocultan a los suspendidos y dejan de
///   ofrecer el v2, pero esos contratos se pueden seguir llamando directamente.
contract PanalBans {
    struct Ban {
        uint64 since;        // desde cuándo (0 = no está suspendida)
        bytes32 reasonHash;  // la huella de las pruebas
    }

    address public owner;
    address public pendingOwner;
    /// @notice Cuántas direcciones están suspendidas ahora mismo.
    uint256 public bannedCount;

    mapping(address => Ban) private _bans;

    event AccountSuspended(address indexed account, bytes32 reasonHash);
    event AccountReinstated(address indexed account, bytes32 reasonHash);
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "PanalBans: not owner");
        _;
    }

    /// @param owner_ el multisig dueño. Quien despliega no se queda con nada.
    constructor(address owner_) {
        require(owner_ != address(0), "PanalBans: zero owner");
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    // ─────────────────────────────────────────────────────────── suspender

    /// @notice Suspende varias direcciones por las mismas pruebas (por ejemplo, el
    ///         cliente y el agente de una misma persona). Se salta las que ya lo están.
    /// @param reasonHash la huella de las pruebas; obligatoria.
    function suspend(address[] calldata accounts, bytes32 reasonHash) external onlyOwner {
        require(reasonHash != bytes32(0), "PanalBans: reason required");
        for (uint256 i = 0; i < accounts.length; i++) {
            address a = accounts[i];
            require(a != address(0), "PanalBans: zero address");
            if (_bans[a].since != 0) continue;
            _bans[a] = Ban({since: uint64(block.timestamp), reasonHash: reasonHash});
            bannedCount += 1;
            emit AccountSuspended(a, reasonHash);
        }
    }

    /// @notice Levanta la suspensión. Se salta las que no lo están.
    /// @param reasonHash la huella de por qué se levanta; obligatoria.
    function reinstate(address[] calldata accounts, bytes32 reasonHash) external onlyOwner {
        require(reasonHash != bytes32(0), "PanalBans: reason required");
        for (uint256 i = 0; i < accounts.length; i++) {
            address a = accounts[i];
            if (_bans[a].since == 0) continue;
            delete _bans[a];
            bannedCount -= 1;
            emit AccountReinstated(a, reasonHash);
        }
    }

    // ─────────────────────────────────────────────────────────── lecturas

    function isBanned(address account) external view returns (bool) {
        return _bans[account].since != 0;
    }

    /// @notice true si alguna de las dos está suspendida (las dos partes de un encargo).
    function isEitherBanned(address a, address b) external view returns (bool) {
        return _bans[a].since != 0 || _bans[b].since != 0;
    }

    function getBan(address account) external view returns (uint64 since, bytes32 reasonHash) {
        Ban memory b = _bans[account];
        return (b.since, b.reasonHash);
    }

    // ─────────────────────────────────────────────────────────── dueño

    /// @notice Primer paso: el nuevo dueño tiene que aceptar.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner && msg.sender != address(0), "PanalBans: not pending owner");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
