// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Lo que el escrow usa del registro de agentes (PanalRegistryV2, se reutiliza).
interface IRegistryV2_5 {
    function isActiveAgent(address agent) external view returns (bool);
    function PANAL_TOKEN() external view returns (address);
}

/// @notice Lo que el escrow usa de la reputación (PanalReputationV2_5).
interface IReputationV2_5 {
    function escrow() external view returns (address);
    function recordCompletion(address agent, uint8 rating, address currency, uint256 amount) external;
    function recordDisputeLost(address agent, uint8 rating) external;
}

/// @notice Lo que el escrow usa de la lista de suspendidos (PanalBans).
interface IBansV2_5 {
    function isBanned(address account) external view returns (bool);
    function isEitherBanned(address a, address b) external view returns (bool);
}

interface IERC20V2_5 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IERC20PermitV2_5 {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

/// @title PanalEscrowV2_5
/// @notice El escrow de Panal, versión 2.5. Reglas y despliegue en contracts/V2_5.md.
///
/// LA REGLA (del fundador, 23-nov-2026):
///   Si quien trabaja no entrega en el plazo, el cliente recupera el dinero, y
///   cualquiera puede devolvérselo (A1). Si entrega en el plazo y el cliente no
///   aprueba ni disputa durante su ventana de revisión, el pago es de quien
///   trabajó: después de esa ventana ya no se puede disputar (A3), y cualquiera
///   puede acreditarlo (A2).
///
/// QUÉ CAMBIA RESPECTO AL V2:
///   A1 `refundExpired`: sin entrega en plazo, cualquiera devuelve el dinero.
///   A2 `release` / `releaseAndWithdraw`: acreditar y cobrar varios a la vez.
///   A3 La disputa, solo dentro de la ventana de revisión.
///   A4 La ventana de revisión la elige el cliente al contratar (24 h a 7 días).
///   B1 Aceptar el encargo; entregar cuenta como aceptar. Si no acepta a tiempo,
///      el cliente cancela sin esperar al plazo.
///   B2 `rejectTask`: quien trabaja rechaza y el cliente recupera el dinero.
///   B3 Reparto de mutuo acuerdo, sin jueces: uno propone y el otro acepta.
///   B4 `extendDeadline`: el cliente amplía el plazo, solo hacia adelante.
///   C1 El hash del motivo (al disputar) y de la decisión (al resolver).
///   C2 Cambiar de árbitro tarda 3 días.
///   D1 Liberar por tiempo cuenta como completado, sin nota.
///   D2 Cada cierre dice cómo se cerró (`Close`).
///   D3 Perder una disputa entera cuenta en la reputación.
///   E1 Contratar con `permit` ($PANAL y USDC): una sola transacción.
///   E2 Eventos completos y una estructura que ocupa 6 slots en vez de 11.
///   E3 Primero se acredita, después se llama a la reputación.
///   +  Comisión del 1,5 % en $PANAL (2,5 % en MON y USDC).
///   +  Suspensiones (PanalBans, 23-nov): una dirección suspendida no empieza
///      nada nuevo (contratar, coger, aceptar, entregar lo no aceptado, disputar,
///      acordar, ampliar), pero retira siempre su saldo y lo ya en marcha se
///      termina con las reglas de siempre. Suspender nunca quita dinero. Si
///      suspenden al agente antes de entregar, el cliente cancela en el acto.
///   +  USDC como tercera moneda. Disputa sin decisión a los 14 días: mitad y
///      mitad. Propiedad en dos pasos. El dueño se pasa en el constructor.
///   +  Jueces autónomos (opcionales, 23-nov): un multisig de 4 jueces de IA (3
///      de 4) propone la decisión; a las 48 h es firme salvo que los jueces
///      humanos la corrijan antes. Ver «jueces autónomos» más abajo.
///
/// LO QUE NO TIENE, A PROPÓSITO: pausa, vía de actualización, comisión
/// variable o monedas que se añadan después.
contract PanalEscrowV2_5 {
    // ─────────────────────────────────────────────────────────── tipos

    enum Status {
        Open,      // esperando a que lo acepten (o a que lo coja un agente, si no tiene trabajador)
        Accepted,  // aceptado, esperando la entrega
        Delivered, // entregado, en la ventana de revisión (o pasada, sin acreditar todavía)
        Disputed,  // en manos de los jueces
        Closed     // terminado; `closeReason` dice cómo
    }

    /// @notice Cómo terminó un encargo (D2).
    enum Close {
        None,
        Approved,       // el cliente aprobó
        Timeout,        // pasó la ventana de revisión sin aprobación ni disputa
        Arbitrated,     // resolvieron los jueces
        DisputeExpired, // los jueces no decidieron en 14 días: mitad y mitad
        Mutual,         // las dos partes acordaron el reparto
        Cancelled,      // el cliente canceló antes de que lo aceptaran
        Expired,        // venció el plazo sin entrega
        Rejected,       // quien trabaja lo rechazó
        AutoArbitrated  // decidieron los jueces autónomos y nadie lo corrigió en 48 h
    }

    /// @dev 6 slots. `amount` cabe en uint128 (3,4e38 unidades).
    struct Task {
        address client;       // slot 0
        uint64 deadline;
        Status status;
        Close closeReason;
        uint16 workerShareBps; // al cerrar: la parte de quien trabajó (0 en las devoluciones).
                               // La leen los contratos que contratan, como el tablón:
                               // lo que volvió al cliente es amount - amount * esto / 10.000.
        address worker;       // slot 1
        uint64 acceptBy;      // hasta cuándo puede aceptar (o entregar sin haber aceptado)
        uint32 reviewWindow;  // segundos que tiene el cliente para revisar tras la entrega
        address currency;     // slot 2 — address(0) = MON
        uint64 deliveredAt;
        uint128 amount;       // slot 3
        uint64 createdAt;
        uint64 disputedAt;
        bytes32 taskHash;     // slot 4 — la huella de lo acordado
        bytes32 resultHash;   // slot 5 — la huella de lo entregado
    }

    /// @notice Los datos de un encargo nuevo.
    struct NewTask {
        address worker;       // address(0) = abierto: lo coge el primer agente activo
        bytes32 taskHash;     // obligatoria: lo acordado queda escrito
        uint64 deadline;      // hasta cuándo se puede entregar
        uint32 acceptWindow;  // segundos para aceptar o entregar (mínimo 5 min)
        uint32 reviewWindow;  // segundos de revisión tras la entrega (24 h a 7 días)
        address currency;     // address(0) = MON, PANAL_TOKEN o USDC_TOKEN
        uint256 amount;       // lo que se bloquea
    }

    /// @notice Una firma EIP-2612 para no tener que hacer `approve` antes.
    struct Permit {
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @notice La decisión de los jueces autónomos sobre una disputa. 2 slots.
    struct Ruling {
        uint16 workerShareBps; // lo que se lleva quien trabaja, en puntos básicos
        uint8 rating;          // 1 a 5
        uint64 finalAt;        // desde cuándo es firme (0 = no hay decisión)
        uint32 epoch;          // con qué jueces autónomos se tomó (`autoArbitratorEpoch`)
        bytes32 decisionHash;  // la huella de la decisión
    }

    struct Proposal {
        address by;            // quién propuso (address(0) = no hay propuesta)
        uint16 workerShareBps; // lo que se lleva quien trabaja, en puntos básicos
    }

    // ─────────────────────────────────────────────────────────── constantes

    /// @notice La comisión, solo sobre lo que cobra quien trabaja: 2,5 % en MON y
    ///         USDC, 1,5 % en $PANAL (decidido el 23-nov, como prometía la v3: que
    ///         pagar en $PANAL tenga un motivo). Fijas: nadie puede cambiarlas.
    uint256 public constant FEE_BPS = 250;
    uint256 public constant FEE_BPS_PANAL = 150;
    uint256 public constant MIN_REVIEW_WINDOW = 24 hours;
    uint256 public constant DEFAULT_REVIEW_WINDOW = 72 hours; // la que proponen la web y la app
    uint256 public constant MAX_REVIEW_WINDOW = 7 days;
    uint256 public constant MIN_ACCEPT_WINDOW = 5 minutes;
    uint256 public constant MAX_DURATION = 365 days;
    uint256 public constant DISPUTE_TIMEOUT = 14 days;
    uint256 public constant ARBITRATOR_DELAY = 3 days;
    /// @notice Lo que espera la decisión de los jueces autónomos antes de ser firme.
    uint256 public constant RULING_DELAY = 48 hours;
    uint256 public constant MIN_AMOUNT_NATIVE = 0.001 ether;
    uint256 public constant MIN_AMOUNT_PANAL = 1e18; // 1 $PANAL (18 decimales)
    uint256 public constant MIN_AMOUNT_USDC = 1e4; // 0,01 USDC (6 decimales)

    IRegistryV2_5 public immutable registry;
    IReputationV2_5 public immutable reputation;
    IBansV2_5 public immutable bans;
    address public immutable PANAL_TOKEN;
    address public immutable USDC_TOKEN;

    // ─────────────────────────────────────────────────────────── estado

    address public owner;
    address public pendingOwner;
    address public treasury;
    address public arbitrator;
    address public pendingArbitrator;
    uint64 public arbitratorChangeAt;
    /// @notice Los jueces autónomos (address(0) = sin ellos, como al desplegar).
    address public autoArbitrator;
    address public pendingAutoArbitrator;
    uint64 public autoArbitratorChangeAt;
    /// @notice Sube cada vez que se añaden, cambian o quitan los jueces autónomos.
    uint32 public autoArbitratorEpoch;
    /// @notice epoch => cuándo empezó.
    mapping(uint32 => uint64) public autoArbitratorEpochStart;

    Task[] private _tasks;
    mapping(uint256 => Proposal) public proposals;
    /// @notice taskId => la decisión de los jueces autónomos (se queda como registro).
    mapping(uint256 => Ruling) public rulings;
    /// @notice token => cuenta => lo acreditado y aún sin retirar (token address(0) = MON).
    mapping(address => mapping(address => uint256)) public pendingWithdrawals;

    uint256 private _locked = 1;

    // ─────────────────────────────────────────────────────────── eventos

    event TaskCreated(
        uint256 indexed taskId,
        address indexed client,
        address indexed worker,
        address currency,
        uint256 amount,
        bytes32 taskHash,
        uint64 deadline,
        uint64 acceptBy,
        uint32 reviewWindow
    );
    event TaskAccepted(uint256 indexed taskId, address indexed worker);
    event TaskDelivered(uint256 indexed taskId, address indexed worker, bytes32 resultHash);
    event TaskDisputed(uint256 indexed taskId, address indexed openedBy, bytes32 reasonHash);
    event DisputeResolved(uint256 indexed taskId, uint16 workerShareBps, uint8 rating, bytes32 decisionHash);
    event SettlementProposed(uint256 indexed taskId, address indexed by, uint16 workerShareBps);
    event DeadlineExtended(uint256 indexed taskId, uint64 deadline);
    event TaskClosed(
        uint256 indexed taskId,
        Close indexed reason,
        uint256 workerPaid,
        uint256 fee,
        uint256 clientRefund,
        uint8 rating
    );
    event Withdrawal(address indexed to, address indexed token, uint256 amount);
    event TreasuryUpdated(address indexed treasury);
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ArbitratorChangeProposed(address indexed newArbitrator, uint64 effectiveAt);
    event ArbitratorChangeCancelled(address indexed newArbitrator);
    event ArbitratorChanged(address indexed previousArbitrator, address indexed newArbitrator);
    event RulingProposed(
        uint256 indexed taskId, address indexed by, uint16 workerShareBps, uint8 rating, bytes32 decisionHash, uint64 finalAt
    );
    event RulingOverruled(uint256 indexed taskId, address indexed by);
    event AutoArbitratorChangeProposed(address indexed newAutoArbitrator, uint64 effectiveAt);
    event AutoArbitratorChangeCancelled(address indexed newAutoArbitrator);
    event AutoArbitratorChanged(address indexed previousAutoArbitrator, address indexed newAutoArbitrator);

    // ─────────────────────────────────────────────────────────── modificadores

    modifier nonReentrant() {
        require(_locked == 1, "PanalEscrowV2_5: reentrant call");
        _locked = 2;
        _;
        _locked = 1;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "PanalEscrowV2_5: not owner");
        _;
    }

    /// @param owner_ el dueño desde el primer bloque (el multisig dueño). Quien
    ///        despliega no se queda con nada.
    /// @param usdcToken_ el USDC de Circle, o address(0) donde no exista.
    constructor(
        address registry_,
        address reputation_,
        address bans_,
        address owner_,
        address treasury_,
        address arbitrator_,
        address panalToken_,
        address usdcToken_
    ) {
        require(owner_ != address(0) && treasury_ != address(0) && arbitrator_ != address(0), "PanalEscrowV2_5: zero address");
        require(
            registry_.code.length > 0 && reputation_.code.length > 0 && bans_.code.length > 0,
            "PanalEscrowV2_5: not contracts"
        );
        require(panalToken_.code.length > 0, "PanalEscrowV2_5: token not contract");
        require(IRegistryV2_5(registry_).PANAL_TOKEN() == panalToken_, "PanalEscrowV2_5: token mismatch");
        if (usdcToken_ != address(0)) {
            require(usdcToken_.code.length > 0 && usdcToken_ != panalToken_, "PanalEscrowV2_5: invalid usdc");
        }
        // La reputación tiene que estar libre: si ya escribe otro escrow, esta quedaría huérfana.
        require(IReputationV2_5(reputation_).escrow() == address(0), "PanalEscrowV2_5: reputation already linked");

        registry = IRegistryV2_5(registry_);
        reputation = IReputationV2_5(reputation_);
        bans = IBansV2_5(bans_);
        PANAL_TOKEN = panalToken_;
        USDC_TOKEN = usdcToken_;
        owner = owner_;
        treasury = treasury_;
        arbitrator = arbitrator_;
        emit OwnershipTransferred(address(0), owner_);
        emit TreasuryUpdated(treasury_);
        emit ArbitratorChanged(address(0), arbitrator_);
    }

    // ─────────────────────────────────────────────────────────── contratar

    /// @notice Crea un encargo y bloquea el pago. En tokens hace falta `approve`
    ///         antes, o usar `createTaskWithPermit`.
    function createTask(NewTask calldata p) external payable nonReentrant returns (uint256) {
        return _create(p);
    }

    /// @notice Igual que `createTask`, con una firma EIP-2612 en lugar de `approve` (E1).
    ///         Si alguien adelanta el `permit`, se sigue adelante con la autorización ya puesta.
    function createTaskWithPermit(NewTask calldata p, Permit calldata s) external nonReentrant returns (uint256) {
        require(p.currency != address(0), "PanalEscrowV2_5: permit needs a token");
        try IERC20PermitV2_5(p.currency).permit(msg.sender, address(this), p.amount, s.deadline, s.v, s.r, s.s) {} catch {}
        return _create(p);
    }

    /// @notice Un agente activo coge un encargo abierto. Cogerlo es aceptarlo.
    function claimTask(uint256 taskId) external {
        Task storage t = _task(taskId);
        require(t.status == Status.Open && t.worker == address(0), "PanalEscrowV2_5: not claimable");
        require(block.timestamp <= t.acceptBy, "PanalEscrowV2_5: accept window over");
        require(msg.sender != t.client, "PanalEscrowV2_5: no self-task");
        require(registry.isActiveAgent(msg.sender), "PanalEscrowV2_5: not active agent");
        require(!bans.isEitherBanned(msg.sender, t.client), "PanalEscrowV2_5: suspended");
        t.worker = msg.sender;
        t.status = Status.Accepted;
        emit TaskAccepted(taskId, msg.sender);
    }

    /// @notice Quien trabaja acepta el encargo (B1).
    function acceptTask(uint256 taskId) external {
        Task storage t = _task(taskId);
        require(msg.sender == t.worker && t.worker != address(0), "PanalEscrowV2_5: not worker");
        require(t.status == Status.Open, "PanalEscrowV2_5: not open");
        require(block.timestamp <= t.acceptBy, "PanalEscrowV2_5: accept window over");
        require(!bans.isEitherBanned(t.worker, t.client), "PanalEscrowV2_5: suspended");
        t.status = Status.Accepted;
        emit TaskAccepted(taskId, msg.sender);
    }

    /// @notice Quien trabaja lo rechaza y el cliente recupera el dinero en el acto (B2).
    function rejectTask(uint256 taskId) external nonReentrant {
        Task storage t = _task(taskId);
        require(msg.sender == t.worker && t.worker != address(0), "PanalEscrowV2_5: not worker");
        require(t.status == Status.Open || t.status == Status.Accepted, "PanalEscrowV2_5: cannot reject");
        _refund(taskId, t, Close.Rejected);
    }

    /// @notice Entrega. Si aún no lo había aceptado, entregar cuenta como aceptar
    ///         (B1), siempre que no haya pasado el tiempo para aceptar.
    function deliverResult(uint256 taskId, bytes32 resultHash) external {
        Task storage t = _task(taskId);
        require(msg.sender == t.worker && t.worker != address(0), "PanalEscrowV2_5: not worker");
        require(resultHash != bytes32(0), "PanalEscrowV2_5: empty result");
        require(block.timestamp <= t.deadline, "PanalEscrowV2_5: deadline passed");
        if (t.status == Status.Open) {
            require(block.timestamp <= t.acceptBy, "PanalEscrowV2_5: accept window over");
            // Entregar sin haber aceptado es aceptar: algo nuevo, para los dos.
            require(!bans.isEitherBanned(msg.sender, t.client), "PanalEscrowV2_5: suspended");
            emit TaskAccepted(taskId, msg.sender);
        } else {
            require(t.status == Status.Accepted, "PanalEscrowV2_5: not accepted");
            // Lo aceptado antes de suspender al cliente se puede entregar y cobrar.
            require(!bans.isBanned(msg.sender), "PanalEscrowV2_5: suspended");
        }
        t.resultHash = resultHash;
        t.deliveredAt = uint64(block.timestamp);
        t.status = Status.Delivered;
        emit TaskDelivered(taskId, msg.sender, resultHash);
    }

    /// @notice El cliente amplía el plazo de entrega, solo hacia adelante (B4).
    function extendDeadline(uint256 taskId, uint64 newDeadline) external {
        Task storage t = _task(taskId);
        require(msg.sender == t.client, "PanalEscrowV2_5: not client");
        require(t.status == Status.Open || t.status == Status.Accepted, "PanalEscrowV2_5: not extendable");
        require(newDeadline > t.deadline, "PanalEscrowV2_5: only forward");
        require(newDeadline <= uint256(t.createdAt) + MAX_DURATION, "PanalEscrowV2_5: too long");
        require(!bans.isBanned(msg.sender), "PanalEscrowV2_5: suspended");
        t.deadline = newDeadline;
        emit DeadlineExtended(taskId, newDeadline);
    }

    // ─────────────────────────────────────────────────────────── cerrar

    /// @notice El cliente aprueba y paga, con una nota de 1 a 5. Vale también
    ///         pasada la ventana de revisión, mientras nadie haya acreditado el pago.
    function approveAndRelease(uint256 taskId, uint8 rating) external nonReentrant {
        Task storage t = _task(taskId);
        require(msg.sender == t.client, "PanalEscrowV2_5: not client");
        require(t.status == Status.Delivered, "PanalEscrowV2_5: not delivered");
        require(rating >= 1 && rating <= 5, "PanalEscrowV2_5: invalid rating");
        _settle(taskId, t, 10_000, rating, Close.Approved);
    }

    /// @notice Acredita a quien trabajó los encargos cuya ventana de revisión ya
    ///         pasó (A2). Cualquiera puede llamarlo; se salta los que no tocan.
    /// @return released cuántos acreditó.
    function release(uint256[] calldata taskIds) external nonReentrant returns (uint256 released) {
        return _release(taskIds);
    }

    /// @notice Acredita y retira en una sola llamada: para quien trabajó (A2).
    function releaseAndWithdraw(uint256[] calldata taskIds, address token)
        external
        nonReentrant
        returns (uint256 released)
    {
        released = _release(taskIds);
        _withdraw(msg.sender, token);
    }

    /// @notice El cliente cancela. Antes del plazo, solo si nadie lo aceptó y ya
    ///         pasó el tiempo para aceptar (o si no tenía trabajador). Pasado el
    ///         plazo sin entrega, siempre.
    function cancelTask(uint256 taskId) external nonReentrant {
        Task storage t = _task(taskId);
        require(msg.sender == t.client, "PanalEscrowV2_5: not client");
        if ((t.status == Status.Open || t.status == Status.Accepted) && block.timestamp > t.deadline) {
            _refund(taskId, t, Close.Expired);
            return;
        }
        // Suspendieron a quien trabaja antes de entregar: el cliente recupera todo ya.
        if (
            (t.status == Status.Open || t.status == Status.Accepted) && t.worker != address(0)
                && bans.isBanned(t.worker)
        ) {
            _refund(taskId, t, Close.Cancelled);
            return;
        }
        require(t.status == Status.Open, "PanalEscrowV2_5: cannot cancel");
        require(t.worker == address(0) || block.timestamp > t.acceptBy, "PanalEscrowV2_5: worker can still accept");
        _refund(taskId, t, Close.Cancelled);
    }

    /// @notice Devuelve el dinero al cliente de los encargos vencidos sin entrega
    ///         (A1). Cualquiera puede llamarlo; se salta los que no tocan.
    /// @return refunded cuántos devolvió.
    function refundExpired(uint256[] calldata taskIds) external nonReentrant returns (uint256 refunded) {
        uint256 n = _tasks.length;
        for (uint256 i = 0; i < taskIds.length; i++) {
            uint256 id = taskIds[i];
            if (id >= n) continue;
            Task storage t = _tasks[id];
            if ((t.status == Status.Open || t.status == Status.Accepted) && block.timestamp > t.deadline) {
                _refund(id, t, Close.Expired);
                refunded++;
            }
        }
    }

    // ─────────────────────────────────────────────────────────── disputas

    /// @notice Abre una disputa, solo dentro de la ventana de revisión (A3).
    /// @param reasonHash la huella del motivo (C1); puede ser 0.
    function openDispute(uint256 taskId, bytes32 reasonHash) external {
        Task storage t = _task(taskId);
        require(msg.sender == t.client || msg.sender == t.worker, "PanalEscrowV2_5: not a party");
        require(t.status == Status.Delivered, "PanalEscrowV2_5: not delivered");
        require(block.timestamp < uint256(t.deliveredAt) + t.reviewWindow, "PanalEscrowV2_5: review window over");
        require(!bans.isBanned(msg.sender), "PanalEscrowV2_5: suspended");
        t.status = Status.Disputed;
        t.disputedAt = uint64(block.timestamp);
        emit TaskDisputed(taskId, msg.sender, reasonHash);
    }

    /// @notice Los jueces humanos reparten y ponen nota (C1: con la huella de su
    ///         decisión). Si dan todo al cliente, la nota cuenta como disputa
    ///         perdida (D3). Si los jueces autónomos ya decidieron, los humanos
    ///         pueden corregirlos mientras su decisión no sea firme (48 h).
    function resolveDispute(uint256 taskId, uint16 workerShareBps, uint8 rating, bytes32 decisionHash)
        external
        nonReentrant
    {
        Task storage t = _task(taskId);
        require(msg.sender == arbitrator, "PanalEscrowV2_5: not arbitrator");
        require(t.status == Status.Disputed, "PanalEscrowV2_5: not disputed");
        require(workerShareBps <= 10_000, "PanalEscrowV2_5: invalid share");
        require(rating >= 1 && rating <= 5, "PanalEscrowV2_5: invalid rating");
        Ruling storage r = rulings[taskId];
        if (_isLiveRuling(r)) {
            require(block.timestamp < r.finalAt, "PanalEscrowV2_5: ruling final");
            emit RulingOverruled(taskId, msg.sender);
        }
        emit DisputeResolved(taskId, workerShareBps, rating, decisionHash);
        _settle(taskId, t, workerShareBps, rating, Close.Arbitrated);
    }

    /// @notice Si nadie decide en 14 días, cualquiera la cierra a mitad y mitad: lo
    ///         mismo que deciden los jueces cuando ninguna parte presenta pruebas.
    ///         Si los jueces autónomos decidieron a tiempo, se espera a que su
    ///         decisión sea firme (`finalizeRuling`).
    function resolveExpiredDispute(uint256 taskId) external nonReentrant {
        Task storage t = _task(taskId);
        require(t.status == Status.Disputed, "PanalEscrowV2_5: not disputed");
        require(block.timestamp >= uint256(t.disputedAt) + DISPUTE_TIMEOUT, "PanalEscrowV2_5: too early");
        require(!_isLiveRuling(rulings[taskId]), "PanalEscrowV2_5: ruling pending");
        _settle(taskId, t, 5_000, 0, Close.DisputeExpired);
    }

    // ─────────────────────────────────────────────────────────── jueces autónomos

    // CÓMO FUNCIONAN (decidido el 23-nov-2026):
    //   1. Los jueces autónomos (un multisig de 4 jueces de IA, 3 de 4) proponen
    //      una decisión con `proposeRuling`, dentro de los 14 días de la disputa.
    //      Una sola por disputa.
    //   2. Durante 48 h, los jueces humanos (`arbitrator`) pueden corregirla con
    //      `resolveDispute`. Pasadas las 48 h es firme: ya no se puede corregir y
    //      cualquiera la cumple con `finalizeRuling`.
    //   3. Si los jueces autónomos no deciden (por ejemplo, votan 2 a 2), deciden
    //      los humanos como siempre; y si nadie decide en 14 días, mitad y mitad.
    //   4. Añadirlos o cambiarlos tarda 3 días, como a los humanos. Quitarlos es
    //      inmediato: dar poder espera, quitarlo no. Al quitarlos o cambiarlos,
    //      sus decisiones que aún no eran firmes dejan de valer y la disputa
    //      vuelve a los humanos; las firmes se cumplen igual.

    /// @notice Los jueces autónomos proponen cómo repartir y la nota.
    function proposeRuling(uint256 taskId, uint16 workerShareBps, uint8 rating, bytes32 decisionHash) external {
        Task storage t = _task(taskId);
        require(msg.sender == autoArbitrator, "PanalEscrowV2_5: not auto arbitrator");
        require(t.status == Status.Disputed, "PanalEscrowV2_5: not disputed");
        require(block.timestamp < uint256(t.disputedAt) + DISPUTE_TIMEOUT, "PanalEscrowV2_5: dispute expired");
        require(!_isLiveRuling(rulings[taskId]), "PanalEscrowV2_5: already ruled");
        require(workerShareBps <= 10_000, "PanalEscrowV2_5: invalid share");
        require(rating >= 1 && rating <= 5, "PanalEscrowV2_5: invalid rating");
        uint64 finalAt = uint64(block.timestamp + RULING_DELAY);
        rulings[taskId] = Ruling({
            workerShareBps: workerShareBps,
            rating: rating,
            finalAt: finalAt,
            epoch: autoArbitratorEpoch,
            decisionHash: decisionHash
        });
        emit RulingProposed(taskId, msg.sender, workerShareBps, rating, decisionHash, finalAt);
    }

    /// @notice Cumple la decisión de los jueces autónomos cuando ya es firme. Cualquiera.
    function finalizeRuling(uint256 taskId) external nonReentrant {
        Task storage t = _task(taskId);
        require(t.status == Status.Disputed, "PanalEscrowV2_5: not disputed");
        Ruling memory r = rulings[taskId];
        require(_isLiveRuling(rulings[taskId]), "PanalEscrowV2_5: no ruling");
        require(block.timestamp >= r.finalAt, "PanalEscrowV2_5: too early");
        emit DisputeResolved(taskId, r.workerShareBps, r.rating, r.decisionHash);
        _settle(taskId, t, r.workerShareBps, r.rating, Close.AutoArbitrated);
    }

    // ─────────────────────────────────────────────────────────── mutuo acuerdo (B3)

    /// @notice Una parte propone cómo repartir. Sustituye a la propuesta anterior.
    function proposeSettlement(uint256 taskId, uint16 workerShareBps) external {
        Task storage t = _task(taskId);
        require(t.worker != address(0), "PanalEscrowV2_5: no worker");
        require(msg.sender == t.client || msg.sender == t.worker, "PanalEscrowV2_5: not a party");
        require(_isLive(t.status), "PanalEscrowV2_5: closed");
        require(workerShareBps <= 10_000, "PanalEscrowV2_5: invalid share");
        require(!bans.isBanned(msg.sender), "PanalEscrowV2_5: suspended");
        proposals[taskId] = Proposal({by: msg.sender, workerShareBps: workerShareBps});
        emit SettlementProposed(taskId, msg.sender, workerShareBps);
    }

    /// @notice La otra parte acepta la propuesta y se reparte en el acto. Repite
    ///         el reparto para que nadie pueda cambiarlo entre medias.
    function acceptSettlement(uint256 taskId, uint16 workerShareBps) external nonReentrant {
        Task storage t = _task(taskId);
        require(msg.sender == t.client || msg.sender == t.worker, "PanalEscrowV2_5: not a party");
        require(_isLive(t.status), "PanalEscrowV2_5: closed");
        Proposal memory p = proposals[taskId];
        require(p.by != address(0) && p.by != msg.sender, "PanalEscrowV2_5: nothing to accept");
        require(p.workerShareBps == workerShareBps, "PanalEscrowV2_5: share changed");
        require(!bans.isBanned(msg.sender), "PanalEscrowV2_5: suspended");
        _settle(taskId, t, workerShareBps, 0, Close.Mutual);
    }

    // ─────────────────────────────────────────────────────────── cobrar

    /// @notice Retira lo acreditado en una moneda (address(0) = MON).
    function withdraw(address token) external nonReentrant {
        _withdraw(msg.sender, token);
    }

    // ─────────────────────────────────────────────────────────── dueño

    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "PanalEscrowV2_5: zero address");
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    /// @notice Primer paso: el nuevo dueño tiene que aceptar (`acceptOwnership`).
    ///         Una dirección equivocada no se queda con el contrato.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner && msg.sender != address(0), "PanalEscrowV2_5: not pending owner");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @notice Propone un árbitro nuevo; entra a los 3 días (C2). Mientras, juzga
    ///         el de siempre y todos pueden ver el cambio que viene.
    function proposeArbitrator(address newArbitrator) external onlyOwner {
        require(newArbitrator != address(0), "PanalEscrowV2_5: zero arbitrator");
        pendingArbitrator = newArbitrator;
        arbitratorChangeAt = uint64(block.timestamp + ARBITRATOR_DELAY);
        emit ArbitratorChangeProposed(newArbitrator, arbitratorChangeAt);
    }

    function cancelArbitratorChange() external onlyOwner {
        require(pendingArbitrator != address(0), "PanalEscrowV2_5: no change pending");
        emit ArbitratorChangeCancelled(pendingArbitrator);
        pendingArbitrator = address(0);
        arbitratorChangeAt = 0;
    }

    /// @notice Cualquiera aplica el cambio de árbitro cuando han pasado los 3 días.
    function applyArbitratorChange() external {
        require(pendingArbitrator != address(0), "PanalEscrowV2_5: no change pending");
        require(block.timestamp >= arbitratorChangeAt, "PanalEscrowV2_5: too early");
        emit ArbitratorChanged(arbitrator, pendingArbitrator);
        arbitrator = pendingArbitrator;
        pendingArbitrator = address(0);
        arbitratorChangeAt = 0;
    }

    /// @notice Propone jueces autónomos (nuevos o los primeros); entran a los 3 días.
    function proposeAutoArbitrator(address newAutoArbitrator) external onlyOwner {
        require(newAutoArbitrator != address(0), "PanalEscrowV2_5: zero arbitrator");
        pendingAutoArbitrator = newAutoArbitrator;
        autoArbitratorChangeAt = uint64(block.timestamp + ARBITRATOR_DELAY);
        emit AutoArbitratorChangeProposed(newAutoArbitrator, autoArbitratorChangeAt);
    }

    function cancelAutoArbitratorChange() external onlyOwner {
        require(pendingAutoArbitrator != address(0), "PanalEscrowV2_5: no change pending");
        emit AutoArbitratorChangeCancelled(pendingAutoArbitrator);
        pendingAutoArbitrator = address(0);
        autoArbitratorChangeAt = 0;
    }

    /// @notice Cualquiera aplica el cambio de jueces autónomos a los 3 días.
    function applyAutoArbitratorChange() external {
        require(pendingAutoArbitrator != address(0), "PanalEscrowV2_5: no change pending");
        require(block.timestamp >= autoArbitratorChangeAt, "PanalEscrowV2_5: too early");
        address nuevo = pendingAutoArbitrator;
        pendingAutoArbitrator = address(0);
        autoArbitratorChangeAt = 0;
        _setAutoArbitrator(nuevo);
    }

    /// @notice Quita a los jueces autónomos en el acto. Sus decisiones que aún no
    ///         eran firmes dejan de valer y esas disputas vuelven a los humanos;
    ///         las que ya eran firmes se cumplen igual.
    function removeAutoArbitrator() external onlyOwner {
        require(autoArbitrator != address(0), "PanalEscrowV2_5: no auto arbitrator");
        _setAutoArbitrator(address(0));
    }

    function _setAutoArbitrator(address nuevo) internal {
        emit AutoArbitratorChanged(autoArbitrator, nuevo);
        autoArbitrator = nuevo;
        autoArbitratorEpoch += 1;
        autoArbitratorEpochStart[autoArbitratorEpoch] = uint64(block.timestamp);
    }

    // ─────────────────────────────────────────────────────────── lecturas

    function getTask(uint256 taskId) external view returns (Task memory) {
        return _task(taskId);
    }

    function getTaskCount() external view returns (uint256) {
        return _tasks.length;
    }

    /// @notice Hasta cuándo se puede disputar un encargo entregado (0 si no está entregado).
    function reviewEndsAt(uint256 taskId) public view returns (uint256) {
        Task storage t = _task(taskId);
        if (t.deliveredAt == 0) return 0;
        return uint256(t.deliveredAt) + t.reviewWindow;
    }

    /// @notice true si `release` lo acreditaría ahora.
    function isReleasable(uint256 taskId) external view returns (bool) {
        Task storage t = _task(taskId);
        return t.status == Status.Delivered && block.timestamp >= uint256(t.deliveredAt) + t.reviewWindow;
    }

    /// @notice true si `refundExpired` lo devolvería ahora.
    /// @notice La comisión de una moneda, en puntos básicos.
    function feeBpsFor(address currency) public view returns (uint256) {
        return currency == PANAL_TOKEN ? FEE_BPS_PANAL : FEE_BPS;
    }

    /// @notice true si la decisión de los jueces autónomos ya es firme y se puede cumplir.
    function isRulingFinalizable(uint256 taskId) external view returns (bool) {
        if (taskId >= _tasks.length || _tasks[taskId].status != Status.Disputed) return false;
        Ruling storage r = rulings[taskId];
        return _isLiveRuling(r) && block.timestamp >= r.finalAt;
    }

    function isRefundable(uint256 taskId) external view returns (bool) {
        Task storage t = _task(taskId);
        return (t.status == Status.Open || t.status == Status.Accepted) && block.timestamp > t.deadline;
    }

    // ─────────────────────────────────────────────────────────── internas

    function _create(NewTask calldata p) internal returns (uint256 taskId) {
        address currency = p.currency;
        require(
            currency == address(0) || currency == PANAL_TOKEN || (currency == USDC_TOKEN && USDC_TOKEN != address(0)),
            "PanalEscrowV2_5: unsupported currency"
        );
        require(p.taskHash != bytes32(0), "PanalEscrowV2_5: empty task");
        require(p.worker != msg.sender, "PanalEscrowV2_5: no self-task");
        require(!bans.isEitherBanned(msg.sender, p.worker), "PanalEscrowV2_5: suspended");
        if (p.worker != address(0)) {
            require(registry.isActiveAgent(p.worker), "PanalEscrowV2_5: worker not active agent");
        }
        require(p.deadline > block.timestamp, "PanalEscrowV2_5: invalid deadline");
        require(p.deadline <= block.timestamp + MAX_DURATION, "PanalEscrowV2_5: too long");
        require(p.acceptWindow >= MIN_ACCEPT_WINDOW, "PanalEscrowV2_5: accept window too short");
        uint256 acceptBy = block.timestamp + p.acceptWindow;
        require(acceptBy <= p.deadline, "PanalEscrowV2_5: accept window past deadline");
        require(
            p.reviewWindow >= MIN_REVIEW_WINDOW && p.reviewWindow <= MAX_REVIEW_WINDOW,
            "PanalEscrowV2_5: invalid review window"
        );

        uint256 amount = p.amount;
        if (currency == address(0)) {
            require(msg.value == amount, "PanalEscrowV2_5: amount mismatch");
            require(amount >= MIN_AMOUNT_NATIVE, "PanalEscrowV2_5: below minimum");
        } else {
            require(msg.value == 0, "PanalEscrowV2_5: unexpected native value");
            uint256 min = currency == USDC_TOKEN ? MIN_AMOUNT_USDC : MIN_AMOUNT_PANAL;
            require(amount >= min, "PanalEscrowV2_5: below minimum");
            // Se cuenta lo que llega de verdad, no lo declarado (por si el token cobra al mover).
            uint256 before = IERC20V2_5(currency).balanceOf(address(this));
            _safeTransferFrom(currency, msg.sender, address(this), amount);
            amount = IERC20V2_5(currency).balanceOf(address(this)) - before;
            require(amount >= min, "PanalEscrowV2_5: below minimum received");
        }
        require(amount <= type(uint128).max, "PanalEscrowV2_5: amount too large");

        taskId = _tasks.length;
        Task storage t = _tasks.push();
        t.client = msg.sender;
        t.deadline = p.deadline;
        t.worker = p.worker;
        t.acceptBy = uint64(acceptBy);
        t.reviewWindow = p.reviewWindow;
        t.currency = currency;
        t.amount = uint128(amount);
        t.createdAt = uint64(block.timestamp);
        t.taskHash = p.taskHash;
        emit TaskCreated(
            taskId, msg.sender, p.worker, currency, amount, p.taskHash, p.deadline, uint64(acceptBy), p.reviewWindow
        );
    }

    function _release(uint256[] calldata taskIds) internal returns (uint256 released) {
        uint256 n = _tasks.length;
        for (uint256 i = 0; i < taskIds.length; i++) {
            uint256 id = taskIds[i];
            if (id >= n) continue;
            Task storage t = _tasks[id];
            if (t.status == Status.Delivered && block.timestamp >= uint256(t.deliveredAt) + t.reviewWindow) {
                _settle(id, t, 10_000, 0, Close.Timeout);
                released++;
            }
        }
    }

    /// @dev Reparte el importe: `workerShareBps` para quien trabajó (menos la
    ///      comisión) y el resto para el cliente. Primero acredita y después
    ///      escribe la reputación (E3). `rating` 0 = sin nota.
    function _settle(uint256 taskId, Task storage t, uint256 workerShareBps, uint8 rating, Close reason) internal {
        uint256 amount = t.amount;
        address currency = t.currency;
        address worker = t.worker;
        uint256 workerGross = (amount * workerShareBps) / 10_000;
        uint256 fee = (workerGross * feeBpsFor(currency)) / 10_000;
        uint256 workerPaid = workerGross - fee;
        uint256 clientRefund = amount - workerGross;

        t.status = Status.Closed;
        t.closeReason = reason;
        t.workerShareBps = uint16(workerShareBps);
        delete proposals[taskId];

        if (fee > 0) _credit(currency, treasury, fee);
        if (workerPaid > 0) _credit(currency, worker, workerPaid);
        if (clientRefund > 0) _credit(currency, t.client, clientRefund);
        emit TaskClosed(taskId, reason, workerPaid, fee, clientRefund, rating);

        if (workerGross > 0) {
            reputation.recordCompletion(worker, rating, currency, workerPaid);
        } else if (reason == Close.Arbitrated || reason == Close.AutoArbitrated) {
            reputation.recordDisputeLost(worker, rating);
        }
    }

    function _refund(uint256 taskId, Task storage t, Close reason) internal {
        uint256 amount = t.amount;
        t.status = Status.Closed;
        t.closeReason = reason;
        delete proposals[taskId];
        _credit(t.currency, t.client, amount);
        emit TaskClosed(taskId, reason, 0, 0, amount, 0);
    }

    function _credit(address token, address to, uint256 amount) internal {
        pendingWithdrawals[token][to] += amount;
    }

    function _withdraw(address to, address token) internal {
        uint256 amount = pendingWithdrawals[token][to];
        require(amount > 0, "PanalEscrowV2_5: nothing to withdraw");
        pendingWithdrawals[token][to] = 0;
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            require(ok, "PanalEscrowV2_5: transfer failed");
        } else {
            _safeTransfer(token, to, amount);
        }
        emit Withdrawal(to, token, amount);
    }

    /// @dev Una decisión vale si la tomaron los jueces autónomos de ahora, o si ya
    ///      era firme cuando los quitaron o cambiaron: firme es firme.
    function _isLiveRuling(Ruling storage r) internal view returns (bool) {
        if (r.finalAt == 0) return false;
        if (r.epoch == autoArbitratorEpoch) return true;
        return r.finalAt <= autoArbitratorEpochStart[r.epoch + 1];
    }

    function _isLive(Status s) internal pure returns (bool) {
        return s == Status.Open || s == Status.Accepted || s == Status.Delivered || s == Status.Disputed;
    }

    function _task(uint256 taskId) internal view returns (Task storage) {
        require(taskId < _tasks.length, "PanalEscrowV2_5: invalid task");
        return _tasks[taskId];
    }

    /// @dev Acepta tokens que no devuelven bool.
    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20V2_5.transfer.selector, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "PanalEscrowV2_5: token transfer failed");
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20V2_5.transferFrom.selector, from, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "PanalEscrowV2_5: token transfer failed");
    }
}
