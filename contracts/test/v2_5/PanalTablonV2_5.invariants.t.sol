// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Invariantes de PanalTablonV2_5: el dinero cuadra pase lo que pase.
 *
 * Un `Handler` hace operaciones validas en cualquier orden (sueltas y en
 * recorridos de punta a punta) —publicar en MON,
 * $PANAL y USDC, en los dos modos y con vuelta a publicar; coger, ofertar
 * (tambien por encima del presupuesto), elegir, asignar solo; aceptar, rechazar,
 * dar mas plazo, entregar, aprobar, disputar (el cliente o el agente), resolver los jueces
 * humanos o los autonomos, acordar un reparto; devolver vencidos por el escrow;
 * suspender y rehabilitar a clientes y agentes; cerrar, retirar, caducar,
 * cobrar y dejar pasar el tiempo— contra el escrow v2.5 de verdad. Despues de
 * cada una, por cada moneda:
 *
 *   1. El dinero cuadra al wei:
 *        saldo del tablon + lo que el escrow le tiene acreditado
 *          == publicado + devoluciones sin cobrar
 *             + lo que el escrow ya devolvio de encargos que el tablon aun no ha cerrado.
 *      Lo ultimo se calcula con el reparto que guarda el escrow (`workerShareBps`).
 *      Con `==` tambien salta si el tablon se queda con algo que deberia devolver.
 *   2. Las cuentas son la suma de los encargos: `posted` es lo publicado,
 *      `inEscrow` lo asignado y `owedTotal` lo que se debe a cada cliente.
 *   3. Cada encargo asignado tiene en el escrow su tarea: el tablon de cliente,
 *      el agente de trabajador y el mismo importe. Y la aprobacion de tokens
 *      al escrow siempre vuelve a cero.
 *   4. Los encargos abiertos de cada agente son los suyos asignados.
 *
 * Al final de cada recorrido, todos los clientes cobran lo suyo (tambien los
 * suspendidos) y el tablon se queda sin deber nada.
 */

import "forge-std/Test.sol";
import "../../src/v2/PanalRegistryV2.sol";
import "../../src/v2_5/PanalEscrowV2_5.sol";
import "../../src/v2_5/PanalReputationV2_5.sol";
import "../../src/v2_5/PanalTablonV2_5.sol";
import "../../src/PanalBans.sol";
import "../v2/mocks/MockERC20.sol";
import "./mocks/MockPermitToken.sol";

contract TablonHandler is Test {
    PanalTablonV2_5 public tablon;
    PanalEscrowV2_5 public escrow;
    PanalBans public bans;
    address public panal;
    address public usdc;
    address public arbitrator;
    address public autonomos;
    address public dueno;

    address[] public clientes;
    address[] public agentes;

    mapping(bytes32 => uint256) public hechas;

    /// Todo va en el constructor: una funcion publica para cambiarlo la
    /// llamaria el fuzzer tambien.
    constructor(
        PanalTablonV2_5 _tablon,
        address[4] memory roles, // arbitro, jueces autonomos, dueno, $PANAL
        address _usdc,
        address[] memory _clientes,
        address[] memory _agentes
    ) {
        tablon = _tablon;
        escrow = _tablon.escrow();
        bans = PanalBans(address(_tablon.bans()));
        arbitrator = roles[0];
        autonomos = roles[1];
        dueno = roles[2];
        panal = roles[3];
        usdc = _usdc;
        clientes = _clientes;
        agentes = _agentes;
    }

    function numClientes() external view returns (uint256) {
        return clientes.length;
    }

    function numAgentes() external view returns (uint256) {
        return agentes.length;
    }

    // ─────────────────────────────────────────── ayudas

    function _hay() internal view returns (bool) {
        return tablon.jobCount() > 0;
    }

    /// Casi siempre uno de los ocho ultimos, que son los que siguen vivos; a
    /// veces cualquiera, para tocar tambien los viejos.
    function _id(uint256 seed) internal view returns (uint256) {
        uint256 n = tablon.jobCount();
        if (seed % 5 == 0 || n <= 8) return (seed >> 8) % n;
        return n - 1 - ((seed >> 8) % 8);
    }

    /// Un encargo en ese estado, buscando desde uno de los ultimos hacia atras.
    /// Sin esto, el fuzzer casi nunca acierta con uno asignado.
    function _buscar(uint256 seed, PanalTablonV2_5.State estado) internal view returns (bool, uint256) {
        uint256 n = tablon.jobCount();
        if (n == 0) return (false, 0);
        uint256 inicio = n - 1 - (seed % (n < 16 ? n : 16));
        for (uint256 k; k <= inicio && k < 60; k++) {
            if (tablon.getJob(inicio - k).state == estado) return (true, inicio - k);
        }
        return (false, 0);
    }

    /// Alguien de la lista que no este suspendido, empezando por uno al azar.
    function _libre(uint256 seed, address[] storage lista) internal view returns (bool, address) {
        for (uint256 k; k < lista.length; k++) {
            address x = lista[(seed % lista.length + k) % lista.length];
            if (!bans.isBanned(x)) return (true, x);
        }
        return (false, address(0));
    }

    /// Un agente que puede coger ese encargo ahora, empezando por uno al azar.
    function _quienPuede(uint256 seed, uint256 id) internal view returns (bool, address) {
        for (uint256 k; k < agentes.length; k++) {
            address a = agentes[(seed % agentes.length + k) % agentes.length];
            (bool ok,) = tablon.canTake(a, id);
            if (ok) return (true, a);
        }
        return (false, address(0));
    }

    function _moneda(uint256 seed) internal view returns (address) {
        uint256 k = seed % 3;
        return k == 0 ? address(0) : k == 1 ? panal : usdc;
    }

    function _min(address moneda) internal view returns (uint256) {
        return moneda == address(0) ? 0.001 ether : moneda == panal ? 1e18 : 1e4;
    }

    /// El tope por encargo de cada moneda en este montaje.
    function _tope(address moneda) internal view returns (uint256) {
        return moneda == address(0) ? 30 ether : moneda == panal ? 30e18 : 300e6;
    }

    function _valor(address moneda, uint256 amount) internal pure returns (uint256) {
        return moneda == address(0) ? amount : 0;
    }

    function _parametros(uint256 seed, address moneda, uint256 amount, PanalTablonV2_5.Mode modo)
        internal
        view
        returns (PanalTablonV2_5.PostParams memory p)
    {
        p.taskHash = keccak256(abi.encode(seed, block.timestamp));
        p.currency = moneda;
        p.amount = amount;
        p.workDuration = uint64(bound(seed >> 16, 1 hours, 3 days));
        p.expiresAt = uint64(block.timestamp + 5 days);
        p.reviewWindow = uint32(bound(seed >> 40, 24 hours, 7 days));
        p.mode = modo;
        if (modo == PanalTablonV2_5.Mode.Selection) {
            p.applyWindow = 2 hours;
            p.chooseWindow = 1 days;
        }
        p.relist = (seed >> 32) % 4 == 0;
    }

    /// Un encargo asignado y su tarea del escrow, o (false) si no lo hay.
    function _asignado(uint256 seed)
        internal
        view
        returns (bool ok, uint256 id, PanalTablonV2_5.Job memory j, PanalEscrowV2_5.Task memory t)
    {
        (ok, id) = _buscar(seed, PanalTablonV2_5.State.Assigned);
        if (!ok) return (false, 0, j, t);
        j = tablon.getJob(id);
        t = escrow.getTask(j.escrowTaskId);
    }

    // ─────────────────────────────────────────── publicar y asignar

    function publicar(uint256 seed, uint256 cantidad) external {
        address c = clientes[seed % clientes.length];
        address moneda = _moneda(seed >> 8);
        // Casi siempre dentro del tope por encargo; a veces hasta el doble.
        uint256 amount = bound(cantidad, _min(moneda), cantidad % 10 == 0 ? _tope(moneda) * 2 : _tope(moneda));
        PanalTablonV2_5.Mode modo =
            (seed >> 24) % 3 == 0 ? PanalTablonV2_5.Mode.Immediate : PanalTablonV2_5.Mode.Selection;
        PanalTablonV2_5.PostParams memory p = _parametros(seed, moneda, amount, modo);
        vm.prank(c);
        try tablon.post{value: _valor(moneda, amount)}(p) {
            hechas["publicar"]++;
        } catch {}
    }

    function coger(uint256 agenteSeed, uint256 jobSeed) external {
        (bool ok, uint256 id) = _buscar(jobSeed, PanalTablonV2_5.State.Posted);
        if (!ok) return;
        vm.prank(agentes[agenteSeed % agentes.length]);
        try tablon.take(id) {
            hechas["coger"]++;
        } catch {}
    }

    function ofertar(uint256 agenteSeed, uint256 jobSeed, uint256 precio) external {
        (bool ok, uint256 id) = _buscar(jobSeed, PanalTablonV2_5.State.Posted);
        if (!ok) return;
        PanalTablonV2_5.Job memory j = tablon.getJob(id);
        precio = bound(precio, _min(j.currency), j.amount * 2); // hasta el doble: tambien por encima
        vm.prank(agentes[agenteSeed % agentes.length]);
        try tablon.applyFor(id, precio, 0) {
            hechas["ofertar"]++;
        } catch {}
    }

    function elegir(uint256 jobSeed, uint256 ofertaSeed) external {
        (bool ok, uint256 id) = _buscar(jobSeed, PanalTablonV2_5.State.Posted);
        if (!ok) return;
        PanalTablonV2_5.Offer[] memory o = tablon.offers(id);
        if (o.length == 0) return;
        PanalTablonV2_5.Offer memory elegida = o[ofertaSeed % o.length];
        PanalTablonV2_5.Job memory j = tablon.getJob(id);
        uint256 diff = elegida.price > j.amount ? elegida.price - j.amount : 0;
        vm.prank(j.client);
        try tablon.choose{value: _valor(j.currency, diff)}(id, elegida.agent) {
            hechas["elegir"]++;
        } catch {}
    }

    function asignarSolo(uint256 jobSeed) external {
        (bool ok, uint256 id) = _buscar(jobSeed, PanalTablonV2_5.State.Posted);
        if (!ok) return;
        try tablon.autoAssign(id) {
            hechas["asignarSolo"]++;
        } catch {}
    }

    /// Un encargo inmediato de punta a punta hasta una etapa al azar: asignado,
    /// entregado, en acuerdo, disputado, con decision de los jueces humanos o
    /// de los autonomos. Sin esto, el fuzzer rara vez encadena tantos pasos.
    function recorrido(uint256 seed, uint256 cantidad) external {
        (bool hayC, address c) = _libre(seed, clientes);
        if (!hayC) return;
        address moneda = _moneda(seed >> 16);
        uint256 amount = bound(cantidad, _min(moneda), _tope(moneda));
        PanalTablonV2_5.PostParams memory p = _parametros(seed, moneda, amount, PanalTablonV2_5.Mode.Immediate);
        uint256 id;
        vm.prank(c);
        try tablon.post{value: _valor(moneda, amount)}(p) returns (uint256 x) {
            id = x;
        } catch {
            return;
        }
        (bool hayA, address a) = _quienPuede(seed >> 8, id);
        if (!hayA) return;
        vm.prank(a);
        try tablon.take(id) {} catch {
            return;
        }
        hechas["recorrido"]++;
        uint256 tid = tablon.getJob(id).escrowTaskId;
        uint256 etapa = (seed >> 24) % 6;
        if (etapa == 0) return;
        vm.prank(a);
        try escrow.deliverResult(tid, keccak256("hecho")) {} catch {
            return;
        }
        if (etapa == 1) return;
        uint16 parte = uint16(bound(cantidad >> 8, 0, 10_000));
        if (etapa == 2) {
            vm.prank(a);
            try escrow.proposeSettlement(tid, parte) {} catch {
                return;
            }
            vm.prank(c);
            try tablon.acceptSettlement(id, parte) {} catch {}
            return;
        }
        vm.prank(c);
        try tablon.dispute(id, keccak256("cliente")) {} catch {
            return;
        }
        if (etapa == 4) {
            vm.prank(arbitrator);
            try escrow.resolveDispute(tid, parte, 3, bytes32(0)) {} catch {}
        } else if (etapa == 5) {
            vm.prank(autonomos);
            try escrow.proposeRuling(tid, parte, 3, keccak256("IA")) {} catch {}
        }
    }

    /// Un encargo de seleccion de punta a punta: dos ofertas, y el cliente
    /// elige una (pagando la diferencia si hace falta) o se asigna solo.
    function seleccion(uint256 seed, uint256 cantidad, uint256 precio) external {
        (bool hayC, address c) = _libre(seed, clientes);
        if (!hayC) return;
        address moneda = _moneda(seed >> 16);
        uint256 amount = bound(cantidad, _min(moneda), _tope(moneda));
        PanalTablonV2_5.PostParams memory p = _parametros(seed, moneda, amount, PanalTablonV2_5.Mode.Selection);
        uint256 id;
        vm.prank(c);
        try tablon.post{value: _valor(moneda, amount)}(p) returns (uint256 x) {
            id = x;
        } catch {
            return;
        }
        uint256 ofertas;
        for (uint256 k; k < 2; k++) {
            (bool hayA, address a) = _quienPuede((seed >> 8) + k, id);
            if (!hayA) break;
            uint256 pr = bound(uint256(keccak256(abi.encode(precio, k))), _min(moneda), _tope(moneda));
            vm.prank(a);
            try tablon.applyFor(id, pr, 0) {
                ofertas++;
            } catch {}
        }
        if (ofertas == 0) return;
        vm.warp(block.timestamp + 2 hours);
        if ((seed >> 48) % 2 == 0) {
            PanalTablonV2_5.Offer[] memory o = tablon.offers(id);
            PanalTablonV2_5.Offer memory elegida = o[precio % o.length];
            uint256 diff = elegida.price > amount ? elegida.price - amount : 0;
            vm.prank(c);
            try tablon.choose{value: _valor(moneda, diff)}(id, elegida.agent) {
                hechas["seleccion"]++;
            } catch {}
        } else {
            vm.warp(block.timestamp + 1 days);
            try tablon.autoAssign(id) {
                hechas["seleccion"]++;
            } catch {}
        }
    }

    // ─────────────────────────────────────────── el trabajo, en el escrow

    function aceptar(uint256 jobSeed) external {
        (bool ok,, PanalTablonV2_5.Job memory j,) = _asignado(jobSeed);
        if (!ok) return;
        vm.prank(j.agent);
        try escrow.acceptTask(j.escrowTaskId) {
            hechas["aceptar"]++;
        } catch {}
    }

    function rechazar(uint256 jobSeed) external {
        if (jobSeed % 3 != 0) return; // menos a menudo
        (bool ok,, PanalTablonV2_5.Job memory j,) = _asignado(jobSeed);
        if (!ok) return;
        vm.prank(j.agent);
        try escrow.rejectTask(j.escrowTaskId) {
            hechas["rechazar"]++;
        } catch {}
    }

    /// El cliente da mas plazo (solo vale si el agente ya acepto).
    function alargar(uint256 jobSeed, uint256 extra) external {
        (bool ok, uint256 id, PanalTablonV2_5.Job memory j, PanalEscrowV2_5.Task memory t) = _asignado(jobSeed);
        if (!ok) return;
        uint64 nuevo = uint64(t.deadline + bound(extra, 1 hours, 3 days));
        vm.prank(j.client);
        try tablon.extendDeadline(id, nuevo) {
            hechas["alargar"]++;
        } catch {}
    }

    function entregar(uint256 jobSeed) external {
        (bool ok,, PanalTablonV2_5.Job memory j,) = _asignado(jobSeed);
        if (!ok) return;
        vm.prank(j.agent);
        try escrow.deliverResult(j.escrowTaskId, keccak256("hecho")) {
            hechas["entregar"]++;
        } catch {}
    }

    function aprobar(uint256 jobSeed, uint8 rating) external {
        (bool ok, uint256 id, PanalTablonV2_5.Job memory j,) = _asignado(jobSeed);
        if (!ok) return;
        vm.prank(j.client);
        try tablon.approve(id, uint8(bound(rating, 1, 5))) {
            hechas["aprobar"]++;
        } catch {}
    }

    /// Disputa el cliente (por el tablon) o el agente (en el escrow).
    function disputar(uint256 jobSeed) external {
        (bool ok, uint256 id, PanalTablonV2_5.Job memory j,) = _asignado(jobSeed);
        if (!ok) return;
        if (jobSeed % 4 == 0) {
            vm.prank(j.agent);
            try escrow.openDispute(j.escrowTaskId, keccak256("agente")) {
                hechas["disputar"]++;
            } catch {}
        } else {
            vm.prank(j.client);
            try tablon.dispute(id, keccak256("cliente")) {
                hechas["disputar"]++;
            } catch {}
        }
    }

    function resolverHumanos(uint256 jobSeed, uint256 bps) external {
        (bool ok,, PanalTablonV2_5.Job memory j,) = _asignado(jobSeed);
        if (!ok) return;
        vm.prank(arbitrator);
        try escrow.resolveDispute(j.escrowTaskId, uint16(bound(bps, 0, 10_000)), 3, bytes32(0)) {
            hechas["resolverHumanos"]++;
        } catch {}
    }

    function dictarAutonomos(uint256 jobSeed, uint256 bps) external {
        (bool ok,, PanalTablonV2_5.Job memory j,) = _asignado(jobSeed);
        if (!ok) return;
        vm.prank(autonomos);
        try escrow.proposeRuling(j.escrowTaskId, uint16(bound(bps, 0, 10_000)), 3, keccak256("IA")) {
            hechas["dictarAutonomos"]++;
        } catch {}
    }

    /// Propone una parte y acepta la otra: a veces el cliente por el tablon,
    /// a veces el agente en el escrow.
    function acordar(uint256 jobSeed, uint256 bps) external {
        (bool ok, uint256 id, PanalTablonV2_5.Job memory j,) = _asignado(jobSeed);
        if (!ok) return;
        uint16 parte = uint16(bound(bps, 0, 10_000));
        if (jobSeed % 2 == 0) {
            vm.prank(j.agent);
            try escrow.proposeSettlement(j.escrowTaskId, parte) {} catch {
                return;
            }
            vm.prank(j.client);
            try tablon.acceptSettlement(id, parte) {
                hechas["acordar"]++;
            } catch {}
        } else {
            vm.prank(j.client);
            try tablon.proposeSettlement(id, parte) {} catch {
                return;
            }
            vm.prank(j.agent);
            try escrow.acceptSettlement(j.escrowTaskId, parte) {
                hechas["acordar"]++;
            } catch {}
        }
    }

    /// Cualquiera puede devolver en el escrow los vencidos.
    function devolverVencidos(uint256 jobSeed) external {
        (bool ok,, PanalTablonV2_5.Job memory j,) = _asignado(jobSeed);
        if (!ok) return;
        uint256[] memory ids = new uint256[](1);
        ids[0] = j.escrowTaskId;
        if (escrow.refundExpired(ids) > 0) hechas["devolverVencidos"]++;
    }

    // ─────────────────────────────────────────── suspensiones

    /// Suspende o rehabilita a un cliente o a un agente (lo que no este ya).
    function suspenderORehabilitar(uint256 seed) external {
        if (seed % 3 != 0) return; // menos a menudo
        uint256 n = clientes.length + agentes.length;
        uint256 k = (seed >> 8) % n;
        address quien = k < clientes.length ? clientes[k] : agentes[k - clientes.length];
        address[] memory l = new address[](1);
        l[0] = quien;
        bool estaba = bans.isBanned(quien); // antes del prank: es otra llamada
        if (!estaba && bans.bannedCount() >= 2) return; // como mucho dos a la vez
        vm.prank(dueno);
        if (estaba) bans.reinstate(l, keccak256("rehabilitado"));
        else bans.suspend(l, keccak256("pruebas"));
        hechas["suspenderORehabilitar"]++;
    }

    // ─────────────────────────────────────────── cerrar y cobrar

    function cerrar(uint256 jobSeed) external {
        (bool ok, uint256 id) = _buscar(jobSeed, PanalTablonV2_5.State.Assigned);
        if (!ok) return;
        try tablon.settle(id) {
            hechas["cerrar"]++;
        } catch {}
    }

    function retirar(uint256 jobSeed) external {
        if (!_hay() || jobSeed % 4 != 0) return; // menos a menudo: deja vivir a los demas
        uint256 id = _id(jobSeed);
        vm.prank(tablon.getJob(id).client);
        try tablon.withdrawJob(id) {
            hechas["retirar"]++;
        } catch {}
    }

    function caducar(uint256 jobSeed) external {
        (bool ok, uint256 id) = _buscar(jobSeed, PanalTablonV2_5.State.Posted);
        if (!ok) return;
        try tablon.expire(id) {
            hechas["caducar"]++;
        } catch {}
    }

    function cobrar(uint256 clienteSeed, uint256 monedaSeed) external {
        vm.prank(clientes[clienteSeed % clientes.length]);
        try tablon.claim(_moneda(monedaSeed)) {
            hechas["cobrar"]++;
        } catch {}
    }

    /// Casi siempre poco, para que haya ofertas dentro de su ventana de 2 h; a
    /// veces mucho, para que lleguen plazos, ventanas de revision, las 48 h de
    /// los jueces autonomos y los 14 dias de las disputas.
    function pasarTiempo(uint256 segundos) external {
        uint256 tope = segundos % 5 == 0 ? 4 days : 40 minutes;
        vm.warp(block.timestamp + bound(segundos >> 8, 1 minutes, tope));
    }
}

contract PanalTablonV2_5InvariantsTest is Test {
    PanalRegistryV2 registry;
    PanalReputationV2_5 reputation;
    PanalEscrowV2_5 escrow;
    PanalBans bans;
    MockERC20 panal;
    MockPermitToken usdc;
    PanalTablonV2_5 tablon;
    TablonHandler handler;
    address arbitrator = makeAddr("arbitrator");
    address autonomos = makeAddr("juecesAutonomos");
    address dueno = makeAddr("multisigDueno");

    function setUp() public {
        vm.warp(1_800_000_000);
        panal = new MockERC20("Panal", "PANAL");
        usdc = new MockPermitToken("USDC", "USDC", "2", 6);
        registry = new PanalRegistryV2(address(panal));
        reputation = new PanalReputationV2_5(address(0));
        bans = new PanalBans(dueno);
        escrow = new PanalEscrowV2_5(
            address(registry),
            address(reputation),
            address(bans),
            dueno,
            makeAddr("treasury"),
            arbitrator,
            address(panal),
            address(usdc)
        );
        reputation.setEscrow(address(escrow));
        vm.prank(dueno);
        escrow.proposeAutoArbitrator(autonomos);
        vm.warp(block.timestamp + 3 days);
        escrow.applyAutoArbitratorChange();

        PanalTablonV2_5.Level[5] memory l;
        l[0] = PanalTablonV2_5.Level(5, 400, 1);
        l[1] = PanalTablonV2_5.Level(30, 420, 5);
        l[2] = PanalTablonV2_5.Level(100, 440, 15);
        l[3] = PanalTablonV2_5.Level(300, 450, 40);
        l[4] = PanalTablonV2_5.Level(1000, 460, 100);
        // Tope por encargo en las tres monedas, y total solo en $PANAL: asi se
        // ejercitan los topes sin que las demas se queden sin sitio.
        tablon = new PanalTablonV2_5(
            address(escrow),
            dueno,
            l,
            2,
            PanalTablonV2_5.Caps(30 ether, 0),
            PanalTablonV2_5.Caps(30e18, 300e18),
            PanalTablonV2_5.Caps(300e6, 0)
        );
        address[] memory clientes = new address[](3);
        address[] memory agentes = new address[](8);
        for (uint256 i; i < 3; i++) {
            address c = makeAddr(string.concat("cliente", vm.toString(i)));
            vm.deal(c, 1_000_000 ether);
            panal.mint(c, 1_000_000e18);
            usdc.mint(c, 1_000_000e6);
            vm.startPrank(c);
            panal.approve(address(tablon), type(uint256).max);
            usdc.approve(address(tablon), type(uint256).max);
            vm.stopPrank();
            clientes[i] = c;
        }
        // Un novato, agentes de niveles 1 y 2 y cinco de nivel 5, todos con la
        // categoria 0. Las faltas los apartan 7 o 30 dias (como debe ser): con
        // pocos agentes, el fuzzer se quedaria sin nadie que coja encargos.
        uint256[8] memory hechasAntes = [uint256(0), 5, 30, 1000, 1000, 1000, 1000, 1000];
        for (uint256 i; i < 8; i++) {
            address a = makeAddr(string.concat("agente", vm.toString(i)));
            vm.prank(a);
            registry.registerAgent("ipfs://agente", 1 ether, address(0));
            uint8[] memory cats = new uint8[](1);
            vm.prank(a);
            tablon.setCategories(cats);
            if (hechasAntes[i] > 0) {
                vm.mockCall(
                    address(reputation),
                    abi.encodeWithSelector(PanalReputationV2_5.getReputation.selector, a),
                    abi.encode(PanalReputationV2_5.Reputation(hechasAntes[i], 480, 100, 0))
                );
            }
            agentes[i] = a;
        }
        handler = new TablonHandler(tablon, [arbitrator, autonomos, dueno, address(panal)], address(usdc), clientes, agentes);
        // Con `vm.prank` cambia quien llama, pero el MON sale del handler.
        vm.deal(address(handler), 1e30);
        targetContract(address(handler));
    }

    function _balance(address moneda) internal view returns (uint256) {
        if (moneda == address(0)) return address(tablon).balance;
        return ITablonToken(moneda).balanceOf(address(tablon));
    }

    function _comprobar(address moneda) internal view {
        (uint256 posted, uint256 inEscrow, uint256 owedTotal) = tablon.books(moneda);
        uint256 pendiente = escrow.pendingWithdrawals(moneda, address(tablon));

        uint256 sumaPublicado;
        uint256 sumaAsignado;
        uint256 devueltoSinCerrar;
        for (uint256 i; i < tablon.jobCount(); i++) {
            PanalTablonV2_5.Job memory j = tablon.getJob(i);
            if (j.currency != moneda) continue;
            if (j.state == PanalTablonV2_5.State.Posted) sumaPublicado += j.amount;
            if (j.state != PanalTablonV2_5.State.Assigned) continue;
            sumaAsignado += j.amount;

            // 3. La tarea del escrow es la suya.
            PanalEscrowV2_5.Task memory t = escrow.getTask(j.escrowTaskId);
            assertEq(t.client, address(tablon), "el cliente en el escrow no es el tablon");
            assertEq(t.worker, j.agent, "el trabajador no es el agente");
            assertEq(t.amount, j.amount, "el importe no cuadra con el escrow");
            if (t.status == PanalEscrowV2_5.Status.Closed) {
                devueltoSinCerrar += j.amount - (j.amount * t.workerShareBps) / 10_000;
            }
        }

        // 1. Al wei.
        assertEq(_balance(moneda) + pendiente, posted + owedTotal + devueltoSinCerrar, "el dinero no cuadra");

        // 2. Las cuentas son la suma de los encargos.
        assertEq(posted, sumaPublicado, "posted no es lo publicado");
        assertEq(inEscrow, sumaAsignado, "inEscrow no es lo asignado");
        uint256 sumaDebida;
        for (uint256 i; i < handler.numClientes(); i++) {
            sumaDebida += tablon.owed(handler.clientes(i), moneda);
        }
        assertEq(owedTotal, sumaDebida, "owedTotal no es lo debido");

        // 3. La aprobacion al escrow vuelve siempre a cero.
        if (moneda != address(0)) {
            assertEq(ITablonToken(moneda).allowance(address(tablon), address(escrow)), 0, "aprobacion abierta");
        }
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 200
    function invariant_elMonCuadra() public view {
        _comprobar(address(0));
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 200
    function invariant_elPanalCuadra() public view {
        _comprobar(address(panal));
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 200
    function invariant_elUsdcCuadra() public view {
        _comprobar(address(usdc));
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 200
    function invariant_losAbiertosSonLosAsignados() public view {
        for (uint256 a; a < handler.numAgentes(); a++) {
            address agente = handler.agentes(a);
            uint256 asignados;
            for (uint256 i; i < tablon.jobCount(); i++) {
                PanalTablonV2_5.Job memory j = tablon.getJob(i);
                if (j.state == PanalTablonV2_5.State.Assigned && j.agent == agente) asignados++;
            }
            (,, uint16 open,,) = tablon.agentStats(agente);
            assertEq(open, asignados, "abiertos descuadrados");
        }
    }

    /// Al final, todos cobran lo suyo, esten suspendidos o no, y el tablon
    /// sigue cuadrando sin deber nada. Con TABLON_RESUMEN=true, ademas, cuantas
    /// operaciones de cada tipo llegaron a hacer algo.
    function afterInvariant() external {
        address[3] memory monedas = [address(0), address(panal), address(usdc)];
        for (uint256 m; m < 3; m++) {
            for (uint256 i; i < handler.numClientes(); i++) {
                address c = handler.clientes(i);
                if (tablon.owed(c, monedas[m]) == 0) continue;
                vm.prank(c);
                tablon.claim(monedas[m]);
            }
            (,, uint256 owedTotal) = tablon.books(monedas[m]);
            assertEq(owedTotal, 0, "quedo algo sin cobrar");
            _comprobar(monedas[m]);
        }

        if (!vm.envOr("TABLON_RESUMEN", false)) return;
        string[22] memory ops = [
            "publicar",
            "recorrido",
            "seleccion",
            "coger",
            "ofertar",
            "elegir",
            "asignarSolo",
            "aceptar",
            "alargar",
            "rechazar",
            "entregar",
            "aprobar",
            "disputar",
            "resolverHumanos",
            "dictarAutonomos",
            "acordar",
            "devolverVencidos",
            "suspenderORehabilitar",
            "cerrar",
            "retirar",
            "caducar",
            "cobrar"
        ];
        for (uint256 i; i < ops.length; i++) {
            console.log(ops[i], handler.hechas(bytes32(bytes(ops[i]))));
        }
    }
}
