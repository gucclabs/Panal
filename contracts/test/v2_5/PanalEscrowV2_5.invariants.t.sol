// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Invariantes del escrow v2.5: el dinero que tiene el contrato es, al wei, el
 * que debe, en cada una de las tres monedas.
 *
 * Un `Handler` hace miles de operaciones en cualquier orden —contratar en MON,
 * $PANAL y USDC (con trabajador o abierto), coger, aceptar, rechazar, entregar,
 * aprobar, liberar por tiempo, disputar, resolver, dejar caducar la disputa,
 * acordar un reparto, ampliar el plazo, cancelar, devolver lo vencido, retirar
 * y hacer pasar el tiempo— y después de cada una Foundry exige:
 *
 *     saldo del escrow == lo bloqueado en encargos vivos + lo acreditado a todos
 *
 * por cada moneda; que un encargo cerrado diga cómo se cerró y uno vivo no; y que
 * lo entregado tenga su huella.
 */

import "forge-std/Test.sol";
import "../../src/v2_5/PanalEscrowV2_5.sol";
import "../../src/v2_5/PanalReputationV2_5.sol";
import "../../src/v2/PanalRegistryV2.sol";
import "../../src/PanalBans.sol";
import "./mocks/MockPermitToken.sol";

contract EscrowV2_5Handler is Test {
    PanalEscrowV2_5 public escrow;
    MockPermitToken public panal;
    MockPermitToken public usdc;
    address public arbitrator;
    address public dueno;
    address public autonomos;

    address[] public clientes;
    address[] public trabajadores;
    address[] public cuentas; // todos los que pueden tener algo acreditado

    mapping(bytes32 => uint256) public hechas;
    PanalBans public bans;

    constructor(
        PanalEscrowV2_5 e,
        MockPermitToken p,
        MockPermitToken u,
        PanalRegistryV2 registry,
        address arb,
        address treasury,
        address dueno_,
        address autonomos_,
        PanalBans bans_
    ) {
        bans = bans_;
        dueno = dueno_;
        autonomos = autonomos_;
        escrow = e;
        panal = p;
        usdc = u;
        arbitrator = arb;
        for (uint256 i; i < 3; i++) {
            address c = makeAddr(string.concat("cliente", vm.toString(i)));
            address w = makeAddr(string.concat("trabajador", vm.toString(i)));
            clientes.push(c);
            trabajadores.push(w);
            cuentas.push(c);
            cuentas.push(w);
            vm.prank(w);
            registry.registerAgent("ipfs://t", 1e18, address(0));
            vm.deal(c, 1e30);
            p.mint(c, 1e30);
            u.mint(c, 1e30);
            vm.startPrank(c);
            p.approve(address(e), type(uint256).max);
            u.approve(address(e), type(uint256).max);
            vm.stopPrank();
        }
        cuentas.push(treasury);
    }

    function numCuentas() external view returns (uint256) {
        return cuentas.length;
    }

    function _id(uint256 seed) internal view returns (uint256, bool) {
        uint256 n = escrow.getTaskCount();
        if (n == 0) return (0, false);
        // Casi siempre uno de los últimos: son los que siguen vivos.
        return (seed % 4 == 0 ? seed % n : n - 1 - (seed % (n < 5 ? n : 5)), true);
    }

    /// Un encargo en el estado pedido, empezando a buscar en un punto al azar.
    function _buscar(uint256 seed, PanalEscrowV2_5.Status st) internal view returns (uint256, bool) {
        uint256 n = escrow.getTaskCount();
        for (uint256 k; k < n; k++) {
            uint256 id = (seed % n + k) % n;
            if (escrow.getTask(id).status == st) return (id, true);
        }
        return (0, false);
    }

    function _todos() internal view returns (uint256[] memory ids) {
        ids = new uint256[](escrow.getTaskCount());
        for (uint256 i; i < ids.length; i++) ids[i] = i;
    }

    function crear(uint256 seed, uint96 cantidad) external {
        _crear(seed, cantidad, (seed / 9) % 5 != 0);
    }

    function _crear(uint256 seed, uint96 cantidad, bool conTrabajador) internal {
        address c = clientes[seed % 3];
        uint256 m = (seed / 3) % 3;
        address moneda = m == 0 ? address(0) : (m == 1 ? address(panal) : address(usdc));
        uint256 min = m == 0 ? 0.001 ether : (m == 1 ? 1e18 : 1e4);
        uint256 amount = bound(cantidad, min, m == 2 ? 1_000_000e6 : 1_000e18);
        PanalEscrowV2_5.NewTask memory p;
        p.worker = conTrabajador ? trabajadores[(seed / 45) % 3] : address(0);
        p.taskHash = keccak256(abi.encode(seed));
        p.deadline = uint64(block.timestamp + bound(seed, 1 hours, 10 days));
        p.acceptWindow = uint32(bound(seed / 7, 5 minutes, p.deadline - block.timestamp));
        p.reviewWindow = uint32(bound(seed / 11, 24 hours, 7 days));
        p.currency = moneda;
        p.amount = amount;
        vm.prank(c);
        try escrow.createTask{value: m == 0 ? amount : 0}(p) {
            hechas["crear"]++;
        } catch {}
    }

    /// Lo normal con agentes: contratar y entregar en el mismo momento.
    function contratarYEntregar(uint256 seed, uint96 cantidad) external {
        _crear(seed, cantidad, true);
        uint256 n = escrow.getTaskCount();
        if (n == 0) return;
        PanalEscrowV2_5.Task memory t = escrow.getTask(n - 1);
        if (t.status != PanalEscrowV2_5.Status.Open || t.worker == address(0)) return;
        vm.prank(t.worker);
        try escrow.deliverResult(n - 1, keccak256(abi.encode("r", seed))) {
            hechas["entregar"]++;
        } catch {}
    }

    function coger(uint256 seed) external {
        (uint256 id, bool ok) = _buscar(seed, PanalEscrowV2_5.Status.Open);
        if (!ok) return;
        vm.prank(trabajadores[seed % 3]);
        try escrow.claimTask(id) {
            hechas["coger"]++;
        } catch {}
    }

    function aceptar(uint256 seed) external {
        (uint256 id, bool ok) = _buscar(seed, PanalEscrowV2_5.Status.Open);
        if (!ok) return;
        vm.prank(escrow.getTask(id).worker);
        try escrow.acceptTask(id) {
            hechas["aceptar"]++;
        } catch {}
    }

    function rechazar(uint256 seed) external {
        (uint256 id, bool ok) = _id(seed);
        if (!ok || seed % 3 != 0) return;
        vm.prank(escrow.getTask(id).worker);
        try escrow.rejectTask(id) {
            hechas["rechazar"]++;
        } catch {}
    }

    function entregar(uint256 seed) external {
        (uint256 id, bool ok) = _buscar(seed, PanalEscrowV2_5.Status.Accepted);
        if (!ok) (id, ok) = _buscar(seed, PanalEscrowV2_5.Status.Open);
        if (!ok) return;
        vm.prank(escrow.getTask(id).worker);
        try escrow.deliverResult(id, keccak256(abi.encode("r", seed))) {
            hechas["entregar"]++;
        } catch {}
    }

    function aprobar(uint256 seed) external {
        (uint256 id, bool ok) = _buscar(seed, PanalEscrowV2_5.Status.Delivered);
        if (!ok) return;
        vm.prank(escrow.getTask(id).client);
        try escrow.approveAndRelease(id, uint8(1 + seed % 5)) {
            hechas["aprobar"]++;
        } catch {}
    }

    function liberar(uint256 seed) external {
        if (escrow.getTaskCount() == 0) return;
        // A veces lo cobra el propio trabajador, de una vez.
        if (seed % 3 == 0) {
            vm.prank(trabajadores[seed % 3]);
            try escrow.releaseAndWithdraw(_todos(), address(0)) returns (uint256 n) {
                if (n > 0) hechas["liberar"]++;
            } catch {}
            return;
        }
        try escrow.release(_todos()) returns (uint256 n) {
            if (n > 0) hechas["liberar"]++;
        } catch {}
    }

    function disputar(uint256 seed) external {
        (uint256 id, bool ok) = _buscar(seed, PanalEscrowV2_5.Status.Delivered);
        if (!ok) return;
        PanalEscrowV2_5.Task memory t = escrow.getTask(id);
        vm.prank(seed % 4 == 0 ? t.worker : t.client);
        try escrow.openDispute(id, bytes32(seed)) {
            hechas["disputar"]++;
        } catch {}
    }

    function resolver(uint256 seed, uint16 share) external {
        (uint256 id, bool ok) = _buscar(seed, PanalEscrowV2_5.Status.Disputed);
        if (!ok) return;
        vm.prank(arbitrator);
        try escrow.resolveDispute(id, uint16(bound(share, 0, 10_000)), uint8(1 + seed % 5), bytes32(0)) {
            hechas["resolver"]++;
        } catch {}
    }

    function disputaCaducada(uint256 seed) external {
        (uint256 id, bool ok) = _buscar(seed, PanalEscrowV2_5.Status.Disputed);
        if (!ok) return;
        try escrow.resolveExpiredDispute(id) {
            hechas["caducada"]++;
        } catch {}
    }

    /// Un recorrido entero hasta los jueces autónomos: contratar, entregar,
    /// disputar y que propongan; luego, según la semilla, corrigen los humanos,
    /// se cumple a las 48 h, el dueño los quita, o se queda pendiente.
    function recorridoConJueces(uint256 seed, uint96 cantidad, uint16 share) external {
        uint256 antes = escrow.getTaskCount();
        _crear(seed, cantidad, true);
        if (escrow.getTaskCount() == antes) return; // p. ej., el cliente está suspendido
        uint256 id = antes;
        PanalEscrowV2_5.Task memory t = escrow.getTask(id);
        if (t.status != PanalEscrowV2_5.Status.Open) return;
        vm.prank(t.worker);
        try escrow.deliverResult(id, keccak256(abi.encode("r", seed))) {} catch { return; }
        vm.prank(seed % 3 == 0 ? t.worker : t.client);
        try escrow.openDispute(id, bytes32(seed)) {} catch { return; }
        hechas["disputar"]++;
        vm.prank(autonomos);
        try escrow.proposeRuling(id, uint16(bound(share, 0, 10_000)), uint8(1 + seed % 5), bytes32(seed)) {
            hechas["dictar"]++;
        } catch { return; }
        uint256 rama = (seed >> 16) % 4;
        if (rama == 0) {
            vm.warp(block.timestamp + bound(seed, 0, 47 hours));
            vm.prank(arbitrator);
            try escrow.resolveDispute(id, uint16(bound(seed >> 32, 0, 10_000)), 3, bytes32(0)) {
                hechas["corregir"]++;
            } catch {}
        } else if (rama == 1) {
            vm.warp(block.timestamp + 48 hours);
            try escrow.finalizeRuling(id) {
                hechas["cumplir"]++;
            } catch {}
        } else if (rama == 2 && escrow.autoArbitrator() != address(0)) {
            vm.prank(dueno);
            escrow.removeAutoArbitrator();
            hechas["quitar"]++;
        }
    }

    /// Los jueces autónomos proponen en una disputa.
    function dictar(uint256 seed, uint16 share) external {
        (uint256 id, bool ok) = _buscar(seed, PanalEscrowV2_5.Status.Disputed);
        if (!ok) return;
        vm.prank(autonomos);
        try escrow.proposeRuling(id, uint16(bound(share, 0, 10_000)), uint8(1 + seed % 5), bytes32(seed)) {
            hechas["dictar"]++;
        } catch {}
    }

    /// Pasan 48 h y se cumple una decisión firme.
    function cumplirDecision(uint256 seed) external {
        (uint256 id, bool ok) = _buscar(seed, PanalEscrowV2_5.Status.Disputed);
        if (!ok) return;
        vm.warp(block.timestamp + 48 hours);
        try escrow.finalizeRuling(id) {
            hechas["cumplir"]++;
        } catch {}
    }

    /// El dueño quita a los jueces autónomos o los vuelve a poner (3 días).
    function quitarOPonerAutonomos(uint256 seed) external {
        if (seed % 8 != 0) return;
        if (escrow.autoArbitrator() != address(0)) {
            vm.prank(dueno);
            escrow.removeAutoArbitrator();
            hechas["quitar"]++;
        } else {
            vm.prank(dueno);
            escrow.proposeAutoArbitrator(autonomos);
            vm.warp(block.timestamp + 3 days);
            escrow.applyAutoArbitratorChange();
            hechas["poner"]++;
        }
    }

    function acordar(uint256 seed, uint16 share) external {
        (uint256 id, bool ok) = _id(seed);
        if (!ok) return;
        PanalEscrowV2_5.Task memory t = escrow.getTask(id);
        uint16 s = uint16(bound(share, 0, 10_000));
        (address a, address b) = seed % 2 == 0 ? (t.client, t.worker) : (t.worker, t.client);
        vm.prank(a);
        try escrow.proposeSettlement(id, s) {} catch { return; }
        vm.prank(b);
        try escrow.acceptSettlement(id, s) {
            hechas["acordar"]++;
        } catch {}
    }

    function ampliar(uint256 seed) external {
        (uint256 id, bool ok) = _id(seed);
        if (!ok) return;
        PanalEscrowV2_5.Task memory t = escrow.getTask(id);
        vm.prank(t.client);
        try escrow.extendDeadline(id, uint64(uint256(t.deadline) + bound(seed, 1, 3 days))) {
            hechas["ampliar"]++;
        } catch {}
    }

    function cancelar(uint256 seed) external {
        (uint256 id, bool ok) = _id(seed);
        if (!ok) return;
        vm.prank(escrow.getTask(id).client);
        try escrow.cancelTask(id) {
            hechas["cancelar"]++;
        } catch {}
    }

    function devolverVencidos(uint256) external {
        if (escrow.getTaskCount() == 0) return;
        try escrow.refundExpired(_todos()) returns (uint256 n) {
            if (n > 0) hechas["devolver"]++;
        } catch {}
    }

    function retirar(uint256 seed) external {
        address quien = cuentas[seed % cuentas.length];
        uint256 m = (seed / 7) % 3;
        address token = m == 0 ? address(0) : (m == 1 ? address(panal) : address(usdc));
        vm.prank(quien);
        try escrow.withdraw(token) {
            hechas["retirar"]++;
        } catch {}
    }

    /// Pasa la ventana de revisión más larga (7 días) y libera todo lo que toque.
    function esperarYLiberar() external {
        if (escrow.getTaskCount() == 0) return;
        vm.warp(block.timestamp + 7 days);
        try escrow.release(_todos()) returns (uint256 n) {
            if (n > 0) hechas["liberar"]++;
        } catch {}
    }

    /// Deja pasar los 14 días de una disputa y la cierra a mitad y mitad.
    function esperarDisputaCaducada(uint256 seed) external {
        (uint256 id, bool ok) = _buscar(seed, PanalEscrowV2_5.Status.Disputed);
        if (!ok) return;
        vm.warp(block.timestamp + 14 days);
        try escrow.resolveExpiredDispute(id) {
            hechas["caducada"]++;
        } catch {}
    }

    /// Deja vencer los plazos (hasta 10 días) y devuelve lo que no se entregó.
    function esperarYDevolver() external {
        if (escrow.getTaskCount() == 0) return;
        vm.warp(block.timestamp + 10 days + 1);
        try escrow.refundExpired(_todos()) returns (uint256 n) {
            if (n > 0) hechas["devolver"]++;
        } catch {}
    }

    /// El dueño suspende o rehabilita a un cliente o un trabajador al azar.
    function suspenderORehabilitar(uint256 seed) external {
        if (seed % 4 != 0) return;
        address quien = seed % 8 < 4 ? clientes[(seed >> 8) % 3] : trabajadores[(seed >> 8) % 3];
        address[] memory l = new address[](1);
        l[0] = quien;
        bool suspendido = bans.isBanned(quien);
        vm.prank(dueno);
        if (suspendido) {
            bans.reinstate(l, bytes32(seed | 1));
            hechas["rehabilitar"]++;
        } else {
            bans.suspend(l, bytes32(seed | 1));
            hechas["suspender"]++;
        }
    }

    function pasarTiempo(uint256 segundos) external {
        // Casi siempre poco; a veces lo bastante para pasar la revisión (hasta 7 días)
        // o los 14 días de una disputa.
        uint256 hasta = segundos % 16 == 0 ? 15 days : (segundos % 8 == 0 ? 8 days : 6 hours);
        vm.warp(block.timestamp + bound(segundos, 1 minutes, hasta));
    }
}

contract PanalEscrowV2_5InvariantTest is Test {
    PanalEscrowV2_5 escrow;
    PanalBans bans;
    EscrowV2_5Handler handler;
    MockPermitToken panal;
    MockPermitToken usdc;

    function setUp() public {
        panal = new MockPermitToken("PANAL", "PANAL", "1", 18);
        usdc = new MockPermitToken("USDC", "USDC", "2", 6);
        PanalRegistryV2 registry = new PanalRegistryV2(address(panal));
        PanalReputationV2_5 rep = new PanalReputationV2_5(address(0));
        address arbitrator = makeAddr("jueces");
        address treasury = makeAddr("tesoreria");
        address dueno = makeAddr("dueno");
        address autonomos = makeAddr("juecesAutonomos");
        bans = new PanalBans(dueno);
        escrow = new PanalEscrowV2_5(
            address(registry), address(rep), address(bans), dueno, treasury, arbitrator, address(panal), address(usdc)
        );
        rep.setEscrow(address(escrow));
        vm.prank(dueno);
        escrow.proposeAutoArbitrator(autonomos);
        vm.warp(block.timestamp + 3 days);
        escrow.applyAutoArbitratorChange();
        handler = new EscrowV2_5Handler(escrow, panal, usdc, registry, arbitrator, treasury, dueno, autonomos, bans);
        targetContract(address(handler));
    }

    function _bloqueado(address moneda) internal view returns (uint256 total) {
        uint256 n = escrow.getTaskCount();
        for (uint256 i; i < n; i++) {
            PanalEscrowV2_5.Task memory t = escrow.getTask(i);
            if (t.currency == moneda && t.status != PanalEscrowV2_5.Status.Closed) total += t.amount;
        }
    }

    function _acreditado(address moneda) internal view returns (uint256 total) {
        uint256 n = handler.numCuentas();
        for (uint256 i; i < n; i++) {
            total += escrow.pendingWithdrawals(moneda, handler.cuentas(i));
        }
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 200
    function invariant_elMonCuadra() public view {
        assertEq(address(escrow).balance, _bloqueado(address(0)) + _acreditado(address(0)), "MON descuadrado");
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 200
    function invariant_elPanalCuadra() public view {
        assertEq(
            panal.balanceOf(address(escrow)), _bloqueado(address(panal)) + _acreditado(address(panal)), "$PANAL descuadrado"
        );
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 200
    function invariant_elUsdcCuadra() public view {
        assertEq(
            usdc.balanceOf(address(escrow)), _bloqueado(address(usdc)) + _acreditado(address(usdc)), "USDC descuadrado"
        );
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 200
    function invariant_cadaCierreDiceComo() public view {
        uint256 n = escrow.getTaskCount();
        for (uint256 i; i < n; i++) {
            PanalEscrowV2_5.Task memory t = escrow.getTask(i);
            bool cerrado = t.status == PanalEscrowV2_5.Status.Closed;
            assertEq(cerrado, t.closeReason != PanalEscrowV2_5.Close.None, "cierre sin motivo o motivo sin cierre");
            if (t.status == PanalEscrowV2_5.Status.Delivered || t.status == PanalEscrowV2_5.Status.Disputed) {
                assertTrue(t.resultHash != bytes32(0) && t.deliveredAt != 0, "entregado sin huella");
            }
            if (t.status != PanalEscrowV2_5.Status.Open) {
                assertTrue(t.worker != address(0) || cerrado, "vivo sin trabajador fuera de Open");
            }
            if (t.closeReason == PanalEscrowV2_5.Close.AutoArbitrated) {
                (,, uint64 finalAt,,) = escrow.rulings(i);
                assertTrue(finalAt != 0 && block.timestamp >= finalAt, "cumplida sin decision firme");
            }
        }
    }

    /// Al final de cada ronda: todo el que tiene saldo acreditado lo retira, esté
    /// suspendido o no. Nadie se queda con dinero atascado en el escrow.
    function afterInvariant() public {
        uint256 cuentas = handler.numCuentas();
        address[3] memory monedas = [address(0), address(panal), address(usdc)];
        for (uint256 i; i < cuentas; i++) {
            address quien = handler.cuentas(i);
            for (uint256 m; m < 3; m++) {
                uint256 debe = escrow.pendingWithdrawals(monedas[m], quien);
                if (debe == 0) continue;
                vm.prank(quien);
                escrow.withdraw(monedas[m]);
                assertEq(escrow.pendingWithdrawals(monedas[m], quien), 0, "no pudo retirar");
            }
        }
        _resumen();
    }

    function _resumen() internal view {
        console.log("crear", handler.hechas("crear"), "coger", handler.hechas("coger"));
        console.log("aceptar", handler.hechas("aceptar"), "rechazar", handler.hechas("rechazar"));
        console.log("entregar", handler.hechas("entregar"), "aprobar", handler.hechas("aprobar"));
        console.log("liberar", handler.hechas("liberar"), "disputar", handler.hechas("disputar"));
        console.log("resolver", handler.hechas("resolver"), "caducada", handler.hechas("caducada"));
        console.log("acordar", handler.hechas("acordar"), "ampliar", handler.hechas("ampliar"));
        console.log("cancelar", handler.hechas("cancelar"), "devolver", handler.hechas("devolver"));
        console.log("retirar", handler.hechas("retirar"), "dictar", handler.hechas("dictar"));
        console.log("cumplir", handler.hechas("cumplir"), "quitar", handler.hechas("quitar"));
        console.log("corregir", handler.hechas("corregir"), "poner", handler.hechas("poner"));
        console.log("suspender", handler.hechas("suspender"), "rehabilitar", handler.hechas("rehabilitar"));
    }
}
