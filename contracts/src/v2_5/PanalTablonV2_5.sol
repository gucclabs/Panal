// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PanalEscrowV2_5.sol";
import "./PanalReputationV2_5.sol";

interface ITablonToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

/// @title PanalTablonV2_5
/// @notice El tablón con reglas, delante de PanalEscrowV2_5. Es el tablón v2
///         (BOARD.md) puesto sobre el escrow v2.5; lo que cambia está en
///         V2_5.md.
///
///         El dinero espera aquí, no en el escrow. Cuando un agente pasa las
///         reglas (nivel, cupo, categoría, faltas, campaña, suspensiones), este
///         contrato crea la tarea del escrow YA ASIGNADA a ese agente. Desde ahí
///         manda el escrow: entrega, ventana de revisión, disputas, reputación.
///
///         En el escrow, el cliente de estas tareas es este contrato. La persona
///         actúa a través de él y cobra sus devoluciones con `claim()`.
///
///         QUÉ CAMBIA RESPECTO AL TABLÓN V2:
///           - El escrow v2.5: la tarea nace con todo su plazo para aceptar, así
///             que entregar basta (el agente ya aceptó al coger el encargo).
///           - La ventana de revisión la elige quien publica (24 h a 7 días).
///           - El reparto de una disputa se lee del escrow (`workerShareBps`): ya
///             no hace falta que los jueces lo repitan aquí (`attestResolution`).
///           - USDC como tercera moneda, con su mínimo y sus topes.
///           - La lista de suspendidos (PanalBans): quien está suspendido no
///             publica, no coge, no oferta, no elige, no disputa ni acuerda; sí
///             retira lo suyo, aprueba y cobra sus devoluciones.
///           - El cliente puede acordar un reparto con el agente (mutuo acuerdo)
///             y darle más plazo si ya aceptó.
///           - Topes de 365 días para la vigencia y el plazo, y la cuenta de
///             volver a publicar en uint256 (auditoría interna, hallazgo 3).
///           - Dueño en dos pasos y sin pausa: los topes por moneda ya frenan
///             lo que entra.
///
///         La administración (el multisig dueño) ajusta niveles, novatos y topes
///         dentro de límites fijos. Nunca mueve dinero ni toca encargos.
contract PanalTablonV2_5 {
    // ─────────────────────────────────────────────────────────── tipos

    enum Mode { Immediate, Selection }
    enum State { Posted, Assigned, Closed, Withdrawn, Expired }

    struct Job {
        address client;
        Mode mode;
        State state;
        uint8 category;
        bool experiencedOnly;
        bool relist;
        uint32 reviewWindow; // la ventana de revisión de la tarea del escrow
        address currency;    // address(0) = MON
        uint256 amount;      // presupuesto mientras está publicado; precio una vez asignado
        bytes32 taskHash;    // keccak256 del encargo privado (el que se ancla)
        bytes32 advertHash;  // hash del anuncio público firmado (vive en el buzón)
        bytes32 campaignId;  // 0 = sin campaña
        uint64 postedAt;
        uint64 expiresAt;
        uint64 workDuration; // plazo de entrega desde la asignación
        uint64 applyWindow;  // selección: tiempo para ofertar
        uint64 chooseWindow; // selección: tiempo del cliente para elegir
        address agent;
        uint256 escrowTaskId;
    }

    /// @notice Los parámetros de `post()`.
    struct PostParams {
        bytes32 taskHash;
        bytes32 advertHash;
        uint8 category;
        address currency;
        uint256 amount;
        uint64 workDuration;
        uint64 expiresAt;
        Mode mode;
        uint64 applyWindow;
        uint64 chooseWindow;
        bool experiencedOnly;
        bool relist;
        bytes32 campaignId;
        uint8 campaignCapPerAgent;
        uint32 reviewWindow; // 24 h a 7 días; la web propone 72 h
    }

    struct Offer {
        address agent;
        uint8 level;         // al ofertar; solo para desplazar a la más débil
        uint64 workDuration;
        uint64 seq;          // orden de llegada; se renueva si cambia la oferta
        uint256 price;
    }

    /// @notice Un nivel de la tabla. El 0 no está: es el de los novatos.
    struct Level {
        uint32 minCompleted;
        uint16 minRating;    // media x100: 400 = 4,0 estrellas
        uint16 dailyCap;
    }

    struct Caps {
        uint256 perJob;      // 0 = sin tope
        uint256 total;       // 0 = sin tope
    }

    struct AgentStats {
        uint32 day;          // día UTC de `takenToday`
        uint16 takenToday;
        uint16 open;         // encargos del tablón en curso
        uint8 newcomerUsed;  // encargos cogidos siendo nivel 0
        uint64 suspendedUntil;
        uint64[3] strikes;   // las tres últimas faltas; [2] la más reciente
    }

    /// @notice Las cuentas de cada moneda.
    struct Books {
        uint256 posted;      // depósitos de encargos sin asignar
        uint256 inEscrow;    // precio de los asignados aún sin cerrar aquí
        uint256 owedTotal;   // devoluciones sin cobrar
    }

    // ─────────────────────────────────────────────────────────── errores

    error NotAllowed(string reason);
    error AccountSuspended();
    error NotClient();
    error NotOwner();
    error NotPendingOwner();
    error OnlyEscrow();
    error Reentrant();
    error InvalidJob();
    error WrongMode();
    error WrongState();
    error Expired();
    error NotExpired();
    error OffersOpen();
    error OffersClosed();
    error ClientChoosing();
    error NoOffer();
    error OffersFull();
    error NoValidOffer();
    error NotFinished();
    error NothingToClaim();
    error UnsupportedCurrency();
    error BelowMinimum();
    error OverPerJobCap();
    error OverTotalCap();
    error InvalidTimes();
    error TooSlow();
    error InvalidCategories();
    error AmountMismatch();
    error UnexpectedValue();
    error TransferFailed();
    error EscrowAmountMismatch();
    error InvalidCampaign();
    error InvalidLevels();
    error TooManyNewcomerJobs();
    error InvalidSetup();

    // ─────────────────────────────────────────────────────────── constantes

    /// @notice Nadie puede pedir entregar en menos de esto: con un plazo de un
    ///         segundo, cualquiera haría sancionar a un agente honrado.
    uint64 public constant MIN_WORK_DURATION = 1 hours;
    /// @notice Topes de la vigencia de un anuncio y del plazo de entrega
    ///         (auditoría interna, hallazgo 3; el escrow tampoco pasa de 365 días).
    uint64 public constant MAX_LISTING_DURATION = 365 days;
    uint64 public constant MAX_WORK_DURATION = 365 days;
    /// @notice Lo más que el cliente puede tardar en elegir, y el margen que
    ///         tiene después `autoAssign()`. Una oferta no ata para siempre.
    uint64 public constant MAX_CHOOSE_WINDOW = 7 days;
    uint64 public constant AUTO_ASSIGN_GRACE = 1 days;
    uint256 internal constant MAX_CATEGORIES = 3;
    uint256 internal constant MAX_OFFERS = 50;
    uint16 internal constant MAX_DAILY_CAP = 100;
    uint16 internal constant MIN_RATING_FLOOR = 350;
    uint8 internal constant MAX_NEWCOMER_JOBS = 5;
    uint256 internal constant SUSPENSION = 7 days;
    uint256 internal constant LONG_SUSPENSION = 30 days;
    uint256 internal constant STRIKE_WINDOW = 90 days;
    /// @notice Por debajo de esta parte, el agente ha perdido la disputa.
    uint256 internal constant LOST_DISPUTE_BPS = 5_000;

    // ─────────────────────────────────────────────────────────── estado

    PanalEscrowV2_5 public immutable escrow;
    IRegistryV2_5 public immutable registry;
    PanalReputationV2_5 public immutable reputation;
    IBansV2_5 public immutable bans;
    address public immutable PANAL_TOKEN;
    address public immutable USDC_TOKEN;
    uint256 public immutable MIN_NATIVE;
    uint256 public immutable MIN_PANAL;
    uint256 public immutable MIN_USDC;
    uint256 internal immutable _minReview;
    uint256 internal immutable _maxReview;
    uint256 internal immutable _disputeTimeout;

    address public owner;
    address public pendingOwner;
    uint8 public newcomerJobs;
    /// @notice La tabla de niveles: `levels(0)` es el nivel 1.
    Level[5] public levels;

    mapping(address => Caps) public caps;
    mapping(address => Books) public books;
    /// @notice Devoluciones por cobrar: cliente => moneda => cantidad.
    mapping(address => mapping(address => uint256)) public owed;

    Job[] internal _jobs;
    mapping(uint256 => Offer[]) internal _offers;
    uint64 internal _offerSeq;

    /// @notice Cupos, encargos abiertos, novato y sanción de cada agente.
    mapping(address => AgentStats) public agentStats;
    /// @notice Categorías de cada agente como mapa de bits.
    mapping(address => uint256) public categoryMask;

    /// @notice Tope por agente y encargos cogidos de cada campaña, por
    ///         `keccak256(abi.encode(publicador, campaignId))`.
    mapping(bytes32 => uint8) public campaignCap;
    mapping(bytes32 => mapping(address => uint8)) public campaignTaken;

    uint256 private _locked = 1;

    // ─────────────────────────────────────────────────────────── eventos

    event JobPosted(
        uint256 indexed jobId,
        address indexed client,
        uint8 indexed category,
        address currency,
        uint256 amount,
        Mode mode,
        bytes32 campaignId
    );
    event Applied(uint256 indexed jobId, address indexed agent, uint8 level, uint256 price, uint64 workDuration);
    event OfferWithdrawn(uint256 indexed jobId, address indexed agent);
    event JobAssigned(
        uint256 indexed jobId, address indexed agent, uint256 escrowTaskId, uint256 price, bool byClient
    );
    event JobWithdrawn(uint256 indexed jobId);
    event JobExpired(uint256 indexed jobId);
    event JobRelisted(uint256 indexed jobId);
    event JobSettled(uint256 indexed jobId, uint256 refundToClient, bool penalized);
    event Strike(address indexed agent, uint8 strikesIn90Days, uint64 suspendedUntil);
    event Credited(address indexed client, address indexed currency, uint256 amount);
    event Claimed(address indexed client, address indexed currency, uint256 amount);
    event CategoriesSet(address indexed agent, uint8[] categories);
    event LevelsChanged(Level[5] levels);
    event NewcomerJobsChanged(uint8 jobs);
    event CapsChanged(address indexed currency, uint256 perJob, uint256 total);
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ─────────────────────────────────────────────────────────── modificadores

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrant();
        _locked = 2;
        _;
        _locked = 1;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Quien está suspendido no empieza nada nuevo.
    modifier notSuspended(address account) {
        if (bans.isBanned(account)) revert AccountSuspended();
        _;
    }

    // ─────────────────────────────────────────────────────────── constructor

    /// @param escrow_ el PanalEscrowV2_5. Registro, reputación, suspensiones,
    ///        monedas, mínimos y plazos se leen de él: no pueden quedar desparejados.
    /// @param owner_ el multisig dueño, desde el primer bloque.
    constructor(
        address escrow_,
        address owner_,
        Level[5] memory levels_,
        uint8 newcomerJobs_,
        Caps memory monCaps_,
        Caps memory panalCaps_,
        Caps memory usdcCaps_
    ) {
        if (escrow_.code.length == 0 || owner_ == address(0)) revert InvalidSetup();
        PanalEscrowV2_5 e = PanalEscrowV2_5(payable(escrow_));
        escrow = e;
        registry = e.registry();
        reputation = PanalReputationV2_5(address(e.reputation()));
        bans = e.bans();
        PANAL_TOKEN = e.PANAL_TOKEN();
        USDC_TOKEN = e.USDC_TOKEN();
        MIN_NATIVE = e.MIN_AMOUNT_NATIVE();
        MIN_PANAL = e.MIN_AMOUNT_PANAL();
        MIN_USDC = e.MIN_AMOUNT_USDC();
        _minReview = e.MIN_REVIEW_WINDOW();
        _maxReview = e.MAX_REVIEW_WINDOW();
        _disputeTimeout = e.DISPUTE_TIMEOUT();

        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);

        _setLevels(levels_);
        _setNewcomerJobs(newcomerJobs_);
        _setCaps(address(0), monCaps_.perJob, monCaps_.total);
        _setCaps(PANAL_TOKEN, panalCaps_.perJob, panalCaps_.total);
        if (USDC_TOKEN != address(0)) _setCaps(USDC_TOKEN, usdcCaps_.perJob, usdcCaps_.total);
    }

    /// @notice Solo entra MON del escrow, al retirar devoluciones.
    receive() external payable {
        if (msg.sender != address(escrow)) revert OnlyEscrow();
    }

    // ─────────────────────────────────────────────────────────── cliente

    /// @notice Publica un encargo dejando el depósito aquí.
    function post(PostParams calldata p)
        external
        payable
        nonReentrant
        notSuspended(msg.sender)
        returns (uint256 jobId)
    {
        _requireCurrency(p.currency);
        if (p.amount < _minAmount(p.currency)) revert BelowMinimum();
        _requirePerJobCap(p.currency, p.amount);
        _requireTotalCap(p.currency, p.amount);
        if (p.workDuration < MIN_WORK_DURATION || p.workDuration > MAX_WORK_DURATION) revert InvalidTimes();
        if (p.expiresAt <= block.timestamp || p.expiresAt > block.timestamp + MAX_LISTING_DURATION) {
            revert InvalidTimes();
        }
        if (p.reviewWindow < _minReview || p.reviewWindow > _maxReview) revert InvalidTimes();
        if (p.mode == Mode.Selection) {
            if (p.applyWindow == 0 || p.chooseWindow > MAX_CHOOSE_WINDOW) revert InvalidTimes();
            if (uint256(p.expiresAt) < block.timestamp + p.applyWindow + p.chooseWindow) revert InvalidTimes();
        }
        if (p.campaignId != bytes32(0)) _joinCampaign(_campaignKey(msg.sender, p.campaignId), p.campaignCapPerAgent);

        jobId = _jobs.length;
        Job storage job = _jobs.push();
        job.client = msg.sender;
        job.mode = p.mode;
        job.category = p.category;
        job.experiencedOnly = p.experiencedOnly;
        job.relist = p.relist;
        job.reviewWindow = p.reviewWindow;
        job.currency = p.currency;
        job.amount = p.amount;
        job.taskHash = p.taskHash;
        job.advertHash = p.advertHash;
        job.campaignId = p.campaignId;
        job.postedAt = uint64(block.timestamp);
        job.expiresAt = p.expiresAt;
        job.workDuration = p.workDuration;
        if (p.mode == Mode.Selection) {
            job.applyWindow = p.applyWindow;
            job.chooseWindow = p.chooseWindow;
        }
        books[p.currency].posted += p.amount;
        // Cobrar al final: primero las cuentas, luego el token.
        _receive(p.currency, msg.sender, p.amount);

        emit JobPosted(jobId, msg.sender, p.category, p.currency, p.amount, p.mode, p.campaignId);
    }

    /// @notice Retira un encargo que nadie tiene todavía. Vuelve entero.
    function withdrawJob(uint256 jobId) external nonReentrant {
        Job storage job = _job(jobId);
        if (msg.sender != job.client) revert NotClient();
        if (job.state != State.Posted) revert WrongState();
        job.state = State.Withdrawn;
        _unpost(jobId, job);
        emit JobWithdrawn(jobId);
    }

    /// @notice Selección: el cliente elige una oferta. Si está por encima del
    ///         presupuesto, manda la diferencia exacta; si está por debajo, la
    ///         diferencia le queda para cobrar.
    function choose(uint256 jobId, address agent) external payable nonReentrant notSuspended(msg.sender) {
        Job storage job = _selectionJob(jobId);
        if (msg.sender != job.client) revert NotClient();
        if (block.timestamp < _applyEnd(job)) revert OffersOpen();
        if (block.timestamp > _applyEnd(job) + job.chooseWindow || block.timestamp > job.expiresAt) revert Expired();

        Offer[] storage list = _offers[jobId];
        uint256 i = _findOffer(list, agent);
        if (i == list.length) revert NoOffer();
        Offer memory o = list[i];
        uint8 level = _requireAllowed(agent, job);

        if (o.price > job.amount) {
            uint256 diff = o.price - job.amount;
            _requirePerJobCap(job.currency, o.price);
            _requireTotalCap(job.currency, diff);
            books[job.currency].posted += diff;
            job.amount = o.price;
            _receive(job.currency, msg.sender, diff);
        } else if (msg.value != 0) {
            revert UnexpectedValue();
        }
        _assign(jobId, job, agent, o.price, o.workDuration, level, true);
    }

    /// @notice El cliente aprueba la entrega y califica (1-5). Lo cierra a la vez.
    ///         Vale aunque esté suspendido: solo le beneficia al agente.
    function approve(uint256 jobId, uint8 rating) external nonReentrant {
        Job storage job = _clientJob(jobId);
        escrow.approveAndRelease(job.escrowTaskId, rating);
        _settle(jobId, job);
    }

    /// @notice El cliente abre una disputa sobre la entrega, con la huella del motivo.
    function dispute(uint256 jobId, bytes32 reasonHash) external nonReentrant notSuspended(msg.sender) {
        escrow.openDispute(_clientJob(jobId).escrowTaskId, reasonHash);
    }

    /// @notice El cliente propone un reparto al agente (mutuo acuerdo, sin jueces).
    function proposeSettlement(uint256 jobId, uint16 workerShareBps)
        external
        nonReentrant
        notSuspended(msg.sender)
    {
        escrow.proposeSettlement(_clientJob(jobId).escrowTaskId, workerShareBps);
    }

    /// @notice El cliente acepta el reparto que propuso el agente. Lo cierra a la vez.
    function acceptSettlement(uint256 jobId, uint16 workerShareBps)
        external
        nonReentrant
        notSuspended(msg.sender)
    {
        Job storage job = _clientJob(jobId);
        escrow.acceptSettlement(job.escrowTaskId, workerShareBps);
        _settle(jobId, job);
    }

    /// @notice El cliente da más plazo al agente. Solo si el agente ya aceptó en
    ///         el escrow: el escrow alarga el plazo de entrega pero no el de
    ///         aceptar, así que sin aceptar, pasado el plazo original, el agente
    ///         ya no podría entregar y el plazo nuevo solo le traería una falta.
    function extendDeadline(uint256 jobId, uint64 newDeadline) external nonReentrant notSuspended(msg.sender) {
        uint256 tid = _clientJob(jobId).escrowTaskId;
        if (escrow.getTask(tid).status != PanalEscrowV2_5.Status.Accepted) revert WrongState();
        escrow.extendDeadline(tid, newDeadline);
    }

    /// @notice Cobra las devoluciones de una moneda. Siempre, aunque esté suspendido.
    function claim(address currency) external nonReentrant {
        uint256 amount = owed[msg.sender][currency];
        if (amount == 0) revert NothingToClaim();
        owed[msg.sender][currency] = 0;
        books[currency].owedTotal -= amount;
        _ensureBalance(currency, amount);
        _send(currency, msg.sender, amount);
        emit Claimed(msg.sender, currency, amount);
    }

    // ─────────────────────────────────────────────────────────── agente

    /// @notice Declara hasta 3 categorías. Sustituye a las anteriores.
    function setCategories(uint8[] calldata categories) external {
        if (categories.length > MAX_CATEGORIES) revert InvalidCategories();
        uint256 mask;
        for (uint256 i; i < categories.length; i++) {
            uint256 bit = uint256(1) << categories[i];
            if (mask & bit != 0) revert InvalidCategories();
            mask |= bit;
        }
        categoryMask[msg.sender] = mask;
        emit CategoriesSet(msg.sender, categories);
    }

    /// @notice Inmediato: el primero que pasa las reglas se lo queda.
    function take(uint256 jobId) external nonReentrant {
        Job storage job = _postedJob(jobId);
        if (job.mode != Mode.Immediate) revert WrongMode();
        if (block.timestamp > job.expiresAt) revert Expired();
        uint8 level = _requireAllowed(msg.sender, job);
        _assign(jobId, job, msg.sender, job.amount, job.workDuration, level, false);
    }

    /// @notice Selección: oferta con precio y plazo. Volver a llamar la cambia.
    /// @param workDuration 0 = el plazo del encargo.
    function applyFor(uint256 jobId, uint256 price, uint64 workDuration) external {
        Job storage job = _selectionJob(jobId);
        if (block.timestamp >= _applyEnd(job)) revert OffersClosed();
        uint8 level = _requireAllowed(msg.sender, job);
        if (price < _minAmount(job.currency)) revert BelowMinimum();
        _requirePerJobCap(job.currency, price);
        if (workDuration == 0) workDuration = job.workDuration;
        if (workDuration > job.workDuration) revert TooSlow();
        if (workDuration < MIN_WORK_DURATION) revert InvalidTimes();

        Offer[] storage list = _offers[jobId];
        Offer memory o =
            Offer({agent: msg.sender, level: level, workDuration: workDuration, seq: ++_offerSeq, price: price});
        uint256 i = _findOffer(list, msg.sender);
        if (i < list.length) {
            list[i] = o;
        } else if (list.length < MAX_OFFERS) {
            list.push(o);
        } else {
            // Lleno: solo entra desplazando a la más débil (nivel más bajo; a
            // igualdad, precio más alto).
            uint256 w;
            for (uint256 j = 1; j < list.length; j++) {
                if (list[j].level < list[w].level || (list[j].level == list[w].level && list[j].price > list[w].price))
                {
                    w = j;
                }
            }
            if (!(level > list[w].level || (level == list[w].level && price < list[w].price))) revert OffersFull();
            emit OfferWithdrawn(jobId, list[w].agent);
            list[w] = o;
        }
        emit Applied(jobId, msg.sender, level, price, workDuration);
    }

    /// @notice Retira la oferta mientras la ventana sigue abierta.
    function withdrawOffer(uint256 jobId) external {
        Job storage job = _selectionJob(jobId);
        if (block.timestamp >= _applyEnd(job)) revert OffersClosed();
        Offer[] storage list = _offers[jobId];
        uint256 i = _findOffer(list, msg.sender);
        if (i == list.length) revert NoOffer();
        list[i] = list[list.length - 1];
        list.pop();
        emit OfferWithdrawn(jobId, msg.sender);
    }

    // ─────────────────────────────────────────────────────────── cualquiera

    /// @notice Selección sin elección del cliente: gana el nivel más alto; a
    ///         igualdad, el precio más bajo, el plazo más corto y el primero en
    ///         ofertar. Las ofertas por encima del presupuesto no cuentan, y se
    ///         salta a quien ya no pasa las reglas.
    function autoAssign(uint256 jobId) external nonReentrant {
        Job storage job = _selectionJob(jobId);
        if (block.timestamp < _applyEnd(job) + job.chooseWindow) revert ClientChoosing();
        if (block.timestamp > _lastAssign(job)) revert Expired();

        Offer[] storage list = _offers[jobId];
        uint256 n = list.length;
        uint256 best = n; // n = ninguna todavía
        uint8 bestLevel;
        for (uint256 i; i < n; i++) {
            if (list[i].price > job.amount) continue;
            (string memory reason, uint8 level) = _check(list[i].agent, job);
            if (bytes(reason).length != 0) continue;
            if (best == n || _better(level, list[i], bestLevel, list[best])) {
                best = i;
                bestLevel = level;
            }
        }
        if (best == n) revert NoValidOffer();
        Offer storage o = list[best];
        _assign(jobId, job, o.agent, o.price, o.workDuration, bestLevel, false);
    }

    /// @notice Cierra las cuentas de un encargo que ha terminado en el escrow.
    ///         Si el escrow se puede adelantar, lo adelanta: devuelve un encargo
    ///         sin entregar pasado el plazo (o cuyo agente está suspendido),
    ///         libera una entrega pasada su ventana de revisión, cumple una
    ///         decisión firme de los jueces autónomos y cierra a mitad y mitad
    ///         una disputa sin decisión en 14 días.
    function settle(uint256 jobId) external nonReentrant {
        _settle(jobId, _assignedJob(jobId));
    }

    /// @notice Devuelve el depósito si nadie lo cogió a tiempo: pasado
    ///         `expiresAt` o, en selección, pasado el último momento para asignar.
    function expire(uint256 jobId) external nonReentrant {
        Job storage job = _postedJob(jobId);
        if (block.timestamp <= _lastAssign(job)) revert NotExpired();
        job.state = State.Expired;
        _unpost(jobId, job);
        emit JobExpired(jobId);
    }

    // ─────────────────────────────────────────────────────────── administración

    function setLevels(Level[5] calldata levels_) external onlyOwner {
        _setLevels(levels_);
    }

    function setNewcomerJobs(uint8 jobs_) external onlyOwner {
        _setNewcomerJobs(jobs_);
    }

    /// @notice Topes por moneda (0 = sin tope). Solo afectan al dinero que entra
    ///         después: no tocan ningún encargo.
    function setCaps(address currency, uint256 perJob, uint256 total) external onlyOwner {
        _setCaps(currency, perJob, total);
    }

    /// @notice Primer paso: el nuevo dueño tiene que aceptar.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ─────────────────────────────────────────────────────────── lecturas

    function jobCount() external view returns (uint256) {
        return _jobs.length;
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _job(jobId);
    }

    function offers(uint256 jobId) external view returns (Offer[] memory) {
        return _offers[jobId];
    }

    /// @return level de 0 a 5.
    /// @return dailyCap encargos por día (0 en el nivel 0, que va por `newcomerJobs`).
    function levelOf(address agent) external view returns (uint8 level, uint16 dailyCap) {
        level = _level(agent);
        if (level > 0) dailyCap = levels[level - 1].dailyCap;
    }

    /// @notice Si puede coger (inmediato) u ofertar (selección) ahora, y por qué no.
    function canTake(address agent, uint256 jobId) external view returns (bool ok, string memory reason) {
        if (jobId >= _jobs.length) return (false, "invalid job");
        Job storage job = _jobs[jobId];
        if (job.state != State.Posted) return (false, "not posted");
        if (block.timestamp > job.expiresAt) return (false, "expired");
        if (job.mode == Mode.Selection && block.timestamp >= _applyEnd(job)) return (false, "offers closed");
        (reason,) = _check(agent, job);
        ok = bytes(reason).length == 0;
    }

    // ─────────────────────────────────────────────────────────── reglas

    /// @dev Las reglas menos el estado y las fechas del encargo, que comprueba
    ///      quien llama. Devuelve "" si pasa, y el nivel actual.
    function _check(address agent, Job storage job) internal view returns (string memory, uint8) {
        if (!registry.isActiveAgent(agent)) return ("not an active agent", 0);
        if (agent == job.client) return ("own job", 0);
        if (bans.isEitherBanned(agent, job.client)) return ("account suspended", 0);
        if (categoryMask[agent] & (uint256(1) << job.category) == 0) return ("category not declared", 0);
        AgentStats storage s = agentStats[agent];
        if (s.suspendedUntil > block.timestamp) return ("suspended", 0);

        uint8 level = _level(agent);
        if (level == 0) {
            if (job.experiencedOnly) return ("experienced only", 0);
            if (s.newcomerUsed >= newcomerJobs) return ("no newcomer jobs left", 0);
            if (s.open > 0) return ("newcomer job in progress", 0);
        } else {
            uint16 cap = levels[level - 1].dailyCap;
            if (s.day == _today() && s.takenToday >= cap) return ("daily quota used", level);
            if (s.open >= cap) return ("too many open", level);
        }

        if (job.campaignId != bytes32(0)) {
            bytes32 key = _campaignKey(job.client, job.campaignId);
            if (campaignTaken[key][agent] >= campaignCap[key]) return ("campaign cap reached", level);
        }
        return ("", level);
    }

    function _requireAllowed(address agent, Job storage job) internal view returns (uint8 level) {
        string memory reason;
        (reason, level) = _check(agent, job);
        if (bytes(reason).length != 0) revert NotAllowed(reason);
    }

    /// @dev El nivel sale de la reputación v2.5, que ya suma la del v2.
    function _level(address agent) internal view returns (uint8) {
        PanalReputationV2_5.Reputation memory r = reputation.getReputation(agent);
        uint256 rating = r.ratingCount == 0 ? 0 : (r.ratingSum * 100) / r.ratingCount;
        for (uint8 l = 5; l > 0; l--) {
            Level storage lv = levels[l - 1];
            if (r.tasksCompleted >= lv.minCompleted && rating >= lv.minRating) return l;
        }
        return 0;
    }

    function _better(uint8 la, Offer storage a, uint8 lb, Offer storage b) internal view returns (bool) {
        if (la != lb) return la > lb;
        if (a.price != b.price) return a.price < b.price;
        if (a.workDuration != b.workDuration) return a.workDuration < b.workDuration;
        return a.seq < b.seq;
    }

    /// @dev Índice de la oferta del agente, o `list.length` si no tiene.
    function _findOffer(Offer[] storage list, address agent) internal view returns (uint256 i) {
        for (; i < list.length; i++) {
            if (list[i].agent == agent) return i;
        }
    }

    function _today() internal view returns (uint32) {
        return uint32(block.timestamp / 1 days);
    }

    function _applyEnd(Job storage job) internal view returns (uint256) {
        return uint256(job.postedAt) + job.applyWindow;
    }

    /// @dev El último momento en que el encargo se puede asignar.
    function _lastAssign(Job storage job) internal view returns (uint256 last) {
        last = job.expiresAt;
        if (job.mode == Mode.Selection) {
            uint256 grace = _applyEnd(job) + job.chooseWindow + AUTO_ASSIGN_GRACE;
            if (grace < last) last = grace;
        }
    }

    /// @dev Una campaña es de quien la publica. Sin campaña (id 0), 0.
    function _campaignKey(address client, bytes32 id) internal pure returns (bytes32) {
        if (id == bytes32(0)) return bytes32(0);
        return keccak256(abi.encode(client, id));
    }

    // ─────────────────────────────────────────────────────────── asignar

    /// @dev `job.amount` es el depósito que hay para este encargo: `price` va al
    ///      escrow y lo que pase del precio vuelve al cliente.
    function _assign(
        uint256 jobId,
        Job storage job,
        address agent,
        uint256 price,
        uint64 workDuration,
        uint8 level,
        bool byClient
    ) internal {
        _countTaken(agent, _campaignKey(job.client, job.campaignId), level);

        address currency = job.currency;
        uint256 deposit = job.amount;
        books[currency].posted -= deposit;
        books[currency].inEscrow += price;
        if (deposit > price) _owe(job.client, currency, deposit - price);

        job.amount = price;
        job.agent = agent;
        job.state = State.Assigned;
        delete _offers[jobId];

        uint256 tid = _createEscrowTask(job, agent, price, workDuration);
        job.escrowTaskId = tid;
        emit JobAssigned(jobId, agent, tid, price, byClient);
    }

    /// @dev Cupo del día, encargos abiertos, novato y campaña.
    function _countTaken(address agent, bytes32 campaignKey, uint8 level) internal {
        AgentStats storage s = agentStats[agent];
        uint32 today = _today();
        if (s.day != today) {
            s.day = today;
            s.takenToday = 0;
        }
        s.takenToday += 1;
        s.open += 1;
        if (level == 0) s.newcomerUsed += 1;
        if (campaignKey != bytes32(0)) campaignTaken[campaignKey][agent] += 1;
    }

    /// @dev La tarea del escrow, ya a nombre del agente. El agente aceptó al
    ///      coger u ofertar, así que tiene todo el plazo para aceptar o entregar
    ///      (entregar cuenta como aceptar). En tokens se aprueba al escrow esa
    ///      cantidad y ni un wei más.
    function _createEscrowTask(Job storage job, address agent, uint256 price, uint64 workDuration)
        internal
        returns (uint256 tid)
    {
        address currency = job.currency;
        // Un encargo vuelto a publicar puede tener su dinero aún en el escrow.
        _ensureBalance(currency, price);
        PanalEscrowV2_5.NewTask memory t = PanalEscrowV2_5.NewTask({
            worker: agent,
            taskHash: job.taskHash,
            deadline: uint64(block.timestamp + workDuration),
            acceptWindow: uint32(workDuration),
            reviewWindow: job.reviewWindow,
            currency: currency,
            amount: price
        });
        if (currency == address(0)) {
            tid = escrow.createTask{value: price}(t);
        } else {
            _safeCall(currency, abi.encodeCall(ITablonToken.approve, (address(escrow), price)));
            tid = escrow.createTask(t);
            if (ITablonToken(currency).allowance(address(this), address(escrow)) != 0) {
                _safeCall(currency, abi.encodeCall(ITablonToken.approve, (address(escrow), 0)));
            }
        }
        if (escrow.getTask(tid).amount != price) revert EscrowAmountMismatch();
    }

    // ─────────────────────────────────────────────────────────── cerrar

    function _settle(uint256 jobId, Job storage job) internal {
        uint256 tid = job.escrowTaskId;
        PanalEscrowV2_5.Task memory t = escrow.getTask(tid);
        if (t.status != PanalEscrowV2_5.Status.Closed) {
            _advance(tid, t);
            t = escrow.getTask(tid);
            if (t.status != PanalEscrowV2_5.Status.Closed) revert NotFinished();
        }

        address agent = job.agent;
        address currency = job.currency;
        uint256 price = job.amount;
        agentStats[agent].open -= 1;
        books[currency].inEscrow -= price;
        job.state = State.Closed;

        // Lo que el escrow le acreditó a este contrato: lo mismo que calcula él.
        uint256 refund = price - (price * t.workerShareBps) / 10_000;
        PanalEscrowV2_5.Close reason = t.closeReason;

        if (
            reason == PanalEscrowV2_5.Close.Expired || reason == PanalEscrowV2_5.Close.Rejected
                || reason == PanalEscrowV2_5.Close.Cancelled
        ) {
            // Sin entrega. Vencido: falta y 7 días fuera. Rechazado: falta, sin
            // apartarlo (avisó). Cancelado: solo pasa si lo suspendieron, y eso
            // ya lo aparta de todo.
            bool penalized = reason != PanalEscrowV2_5.Close.Cancelled;
            if (penalized) _strike(agent, reason == PanalEscrowV2_5.Close.Expired);
            if (job.relist) {
                emit JobSettled(jobId, 0, penalized);
                _relist(jobId, job, refund);
            } else {
                _owe(job.client, currency, refund);
                emit JobSettled(jobId, refund, penalized);
            }
        } else {
            if (refund > 0) _owe(job.client, currency, refund);
            // Perder una disputa ante los jueces (humanos o autónomos) es falta,
            // sin apartarlo. Un acuerdo o una disputa sin decisión, no.
            bool lost = (reason == PanalEscrowV2_5.Close.Arbitrated || reason == PanalEscrowV2_5.Close.AutoArbitrated)
                && t.workerShareBps < LOST_DISPUTE_BPS;
            if (lost) _strike(agent, false);
            emit JobSettled(jobId, refund, lost);
        }
    }

    /// @dev Adelanta el escrow si ya se puede. Todo lo que llama aquí lo podría
    ///      llamar cualquiera (o este contrato, que es el cliente).
    function _advance(uint256 tid, PanalEscrowV2_5.Task memory t) internal {
        PanalEscrowV2_5.Status s = t.status;
        if (s == PanalEscrowV2_5.Status.Open || s == PanalEscrowV2_5.Status.Accepted) {
            if (block.timestamp > t.deadline || bans.isBanned(t.worker)) escrow.cancelTask(tid);
        } else if (s == PanalEscrowV2_5.Status.Delivered) {
            if (block.timestamp >= uint256(t.deliveredAt) + t.reviewWindow) {
                uint256[] memory ids = new uint256[](1);
                ids[0] = tid;
                escrow.release(ids);
            }
        } else if (s == PanalEscrowV2_5.Status.Disputed) {
            if (escrow.isRulingFinalizable(tid)) escrow.finalizeRuling(tid);
            else if (block.timestamp >= uint256(t.disputedAt) + _disputeTimeout) escrow.resolveExpiredDispute(tid);
        }
    }

    /// @dev Vuelve a publicarlo con la misma vigencia, contada desde ahora. En
    ///      uint256 y comprobado antes del cast (auditoría interna, hallazgo 3).
    function _relist(uint256 jobId, Job storage job, uint256 deposit) internal {
        uint256 listing = uint256(job.expiresAt) - uint256(job.postedAt);
        uint256 newExpiry = block.timestamp + listing;
        if (newExpiry > type(uint64).max) revert InvalidTimes();
        job.state = State.Posted;
        job.amount = deposit;
        job.agent = address(0);
        job.postedAt = uint64(block.timestamp);
        job.expiresAt = uint64(newExpiry);
        books[job.currency].posted += deposit;
        emit JobRelisted(jobId);
    }

    /// @dev 7 días fuera por no entregar; 30 con 3 faltas en 90 días.
    function _strike(address agent, bool suspend) internal {
        AgentStats storage s = agentStats[agent];
        s.strikes[0] = s.strikes[1];
        s.strikes[1] = s.strikes[2];
        s.strikes[2] = uint64(block.timestamp);

        uint8 recent;
        for (uint256 i; i < 3; i++) {
            if (s.strikes[i] != 0 && block.timestamp - s.strikes[i] <= STRIKE_WINDOW) recent++;
        }
        uint256 until;
        if (recent >= 3) until = block.timestamp + LONG_SUSPENSION;
        else if (suspend) until = block.timestamp + SUSPENSION;
        if (until > s.suspendedUntil) s.suspendedUntil = uint64(until);
        emit Strike(agent, recent, s.suspendedUntil);
    }

    // ─────────────────────────────────────────────────────────── dinero

    function _unpost(uint256 jobId, Job storage job) internal {
        books[job.currency].posted -= job.amount;
        _owe(job.client, job.currency, job.amount);
        delete _offers[jobId];
    }

    function _owe(address client, address currency, uint256 amount) internal {
        owed[client][currency] += amount;
        books[currency].owedTotal += amount;
        emit Credited(client, currency, amount);
    }

    /// @dev Si no hay bastante aquí, trae lo que el escrow tenga acreditado.
    function _ensureBalance(address currency, uint256 needed) internal {
        uint256 balance =
            currency == address(0) ? address(this).balance : ITablonToken(currency).balanceOf(address(this));
        if (balance >= needed) return;
        if (escrow.pendingWithdrawals(currency, address(this)) == 0) return;
        escrow.withdraw(currency);
    }

    /// @dev Cobra al que llama exactamente `amount`. En tokens mide lo recibido:
    ///      un token que cobre por transferir no cuadraría las cuentas.
    function _receive(address currency, address from, uint256 amount) internal {
        if (currency == address(0)) {
            if (msg.value != amount) revert AmountMismatch();
        } else {
            if (msg.value != 0) revert UnexpectedValue();
            uint256 before = ITablonToken(currency).balanceOf(address(this));
            _safeCall(currency, abi.encodeCall(ITablonToken.transferFrom, (from, address(this), amount)));
            if (ITablonToken(currency).balanceOf(address(this)) - before != amount) revert AmountMismatch();
        }
    }

    function _send(address currency, address to, uint256 amount) internal {
        if (currency == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _safeCall(currency, abi.encodeCall(ITablonToken.transfer, (to, amount)));
        }
    }

    /// @dev Acepta tokens que no devuelven bool.
    function _safeCall(address token, bytes memory data) internal {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    // ─────────────────────────────────────────────────────────── lecturas internas

    function _job(uint256 jobId) internal view returns (Job storage) {
        if (jobId >= _jobs.length) revert InvalidJob();
        return _jobs[jobId];
    }

    function _postedJob(uint256 jobId) internal view returns (Job storage job) {
        job = _job(jobId);
        if (job.state != State.Posted) revert WrongState();
    }

    function _assignedJob(uint256 jobId) internal view returns (Job storage job) {
        job = _job(jobId);
        if (job.state != State.Assigned) revert WrongState();
    }

    /// @dev Un encargo asignado, y quien llama es su cliente.
    function _clientJob(uint256 jobId) internal view returns (Job storage job) {
        job = _assignedJob(jobId);
        if (msg.sender != job.client) revert NotClient();
    }

    function _selectionJob(uint256 jobId) internal view returns (Job storage job) {
        job = _postedJob(jobId);
        if (job.mode != Mode.Selection) revert WrongMode();
    }

    function _requireCurrency(address currency) internal view {
        if (
            currency != address(0) && currency != PANAL_TOKEN
                && (currency != USDC_TOKEN || USDC_TOKEN == address(0))
        ) revert UnsupportedCurrency();
    }

    function _minAmount(address currency) internal view returns (uint256) {
        if (currency == address(0)) return MIN_NATIVE;
        return currency == PANAL_TOKEN ? MIN_PANAL : MIN_USDC;
    }

    function _requirePerJobCap(address currency, uint256 amount) internal view {
        uint256 perJob = caps[currency].perJob;
        if (perJob != 0 && amount > perJob) revert OverPerJobCap();
    }

    /// @dev El total cuenta lo publicado y lo que está en el escrow por encargos
    ///      del tablón: lo que se perdería si este contrato tuviera un fallo.
    function _requireTotalCap(address currency, uint256 extra) internal view {
        uint256 total = caps[currency].total;
        Books storage b = books[currency];
        if (total != 0 && b.posted + b.inEscrow + extra > total) revert OverTotalCap();
    }

    /// @dev La primera publicación fija el tope; las siguientes lo repiten.
    function _joinCampaign(bytes32 key, uint8 cap) internal {
        uint8 actual = campaignCap[key];
        if (cap == 0 || (actual != 0 && actual != cap)) revert InvalidCampaign();
        campaignCap[key] = cap;
    }

    /// @dev Límites fijos: nunca más de 100 al día, umbrales que suben, y una
    ///      nota mínima de 3,5 como poco.
    function _setLevels(Level[5] memory levels_) internal {
        for (uint256 i; i < 5; i++) {
            Level memory lv = levels_[i];
            if (lv.dailyCap == 0 || lv.dailyCap > MAX_DAILY_CAP) revert InvalidLevels();
            if (lv.minRating < MIN_RATING_FLOOR || lv.minRating > 500) revert InvalidLevels();
            if (i == 0) {
                if (lv.minCompleted == 0) revert InvalidLevels();
            } else {
                Level memory prev = levels_[i - 1];
                if (lv.minCompleted <= prev.minCompleted) revert InvalidLevels();
                if (lv.minRating < prev.minRating || lv.dailyCap < prev.dailyCap) revert InvalidLevels();
            }
            levels[i] = lv;
        }
        emit LevelsChanged(levels_);
    }

    function _setNewcomerJobs(uint8 jobs_) internal {
        if (jobs_ > MAX_NEWCOMER_JOBS) revert TooManyNewcomerJobs();
        newcomerJobs = jobs_;
        emit NewcomerJobsChanged(jobs_);
    }

    function _setCaps(address currency, uint256 perJob, uint256 total) internal {
        _requireCurrency(currency);
        caps[currency] = Caps(perJob, total);
        emit CapsChanged(currency, perJob, total);
    }
}
