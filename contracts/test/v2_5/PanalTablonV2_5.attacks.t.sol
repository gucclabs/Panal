// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Ataques que buscan dinero o saltarse las reglas, y que tienen que fallar.
 *
 * Salen de la revision de seguridad del tablon v2 (contracts/TABLON-SECURITY.md en
 * Panal), pasadas al v2.5, y de lo nuevo del v2.5 (suspensiones, acuerdos).
 * Cada prueba es un intento concreto: rodear el tablon hablando con el escrow
 * directamente, actuar sobre encargos ajenos, meter MON a la fuerza, volver a
 * entrar desde un cobro, cobrar dos veces, desbordar los plazos. Despues, los
 * tres que la revision arreglo (F2, F4, F6) y los tres riesgos que se aceptaron
 * (F1, F3, F5), con su comportamiento fijado.
 */

import "./PanalTablonV2_5.t.sol";

/// Manda su saldo al tablon sin pasar por `receive()`: SELFDESTRUCT sigue
/// moviendo el saldo despues de Cancun.
contract Kamikaze {
    constructor(address payable destino) payable {
        selfdestruct(destino);
    }
}

/// Cobra y, mientras recibe el MON, intenta todo lo que no esta cerrado con el
/// cerrojo: ofertar, retirar la oferta y cambiar sus categorias. Y despues lo
/// que si lo esta: cobrar otra vez.
contract CobradorCurioso {
    PanalTablonV2_5 public tablon;
    uint256 public jobId;
    bool public dentro;
    bool public otraVez;

    constructor(PanalTablonV2_5 _tablon) {
        tablon = _tablon;
    }

    function publicar(PanalTablonV2_5.PostParams calldata p) external payable returns (uint256) {
        return tablon.post{value: msg.value}(p);
    }

    function retirar(uint256 id) external {
        tablon.withdrawJob(id);
    }

    function cobrar(uint256 id, bool intentarCobrarOtraVez) external {
        jobId = id;
        otraVez = intentarCobrarOtraVez;
        dentro = true;
        tablon.claim(address(0));
        dentro = false;
    }

    receive() external payable {
        if (!dentro) return;
        uint8[] memory cats = new uint8[](1);
        tablon.setCategories(cats);
        try tablon.applyFor(jobId, 1 ether, 0) {} catch {}
        try tablon.withdrawOffer(jobId) {} catch {}
        if (otraVez) tablon.claim(address(0));
    }
}

contract PanalTablonV2_5AttacksTest is PanalTablonV2_5Base {
    address atacante = makeAddr("atacante");

    function _asignado() internal returns (uint256 id, address a) {
        a = _agent("honrado", 30, 420);
        id = _post(MON, 5 ether, IMMEDIATE);
        _take(a, id);
    }

    // ─────────────────────────────────────── rodear el tablon por el escrow

    function test_ataque_el_escrow_no_deja_tocar_las_tareas_del_tablon() public {
        (uint256 id,) = _asignado();
        uint256 tid = _job(id).escrowTaskId;
        address otro = _agent("otro", 30, 420);

        vm.prank(otro); // nace asignada: nadie la puede "reclamar" como en el tablon viejo
        vm.expectRevert("PanalEscrowV2_5: not claimable");
        escrow.claimTask(tid);

        vm.startPrank(client); // ni siquiera el cliente de verdad: en el escrow el cliente es el tablon
        vm.expectRevert("PanalEscrowV2_5: not client");
        escrow.cancelTask(tid);
        vm.expectRevert("PanalEscrowV2_5: not a party");
        escrow.openDispute(tid, bytes32(0));
        vm.expectRevert("PanalEscrowV2_5: not a party");
        escrow.proposeSettlement(tid, 0);
        vm.stopPrank();

        vm.prank(atacante);
        vm.expectRevert("PanalEscrowV2_5: not worker");
        escrow.deliverResult(tid, RESULT);
    }

    // ─────────────────────────────────────── encargos ajenos

    function test_ataque_nadie_actua_sobre_encargos_ajenos() public {
        uint256 publicado = _post(MON, 5 ether, SELECTION);
        (uint256 asignado,) = _asignado();
        vm.warp(block.timestamp + 2 hours);

        vm.startPrank(atacante);
        vm.expectRevert(PanalTablonV2_5.NotClient.selector);
        tablon.withdrawJob(publicado);
        vm.expectRevert(PanalTablonV2_5.NotClient.selector);
        tablon.choose(publicado, atacante);
        vm.expectRevert(PanalTablonV2_5.NotClient.selector);
        tablon.approve(asignado, 1);
        vm.expectRevert(PanalTablonV2_5.NotClient.selector);
        tablon.dispute(asignado, bytes32(0));
        vm.expectRevert(PanalTablonV2_5.NotClient.selector);
        tablon.proposeSettlement(asignado, 10_000);
        vm.expectRevert(PanalTablonV2_5.NotClient.selector);
        tablon.acceptSettlement(asignado, 10_000);
        vm.expectRevert(PanalTablonV2_5.NotOwner.selector);
        tablon.transferOwnership(atacante);
        vm.expectRevert(PanalTablonV2_5.NotOwner.selector);
        tablon.setCaps(MON, 0, 0);
        vm.expectRevert(PanalTablonV2_5.NothingToClaim.selector);
        tablon.claim(MON);
        vm.stopPrank();
    }

    function test_ataque_no_se_coge_un_encargo_que_ya_tiene_agente() public {
        (uint256 id,) = _asignado();
        address otro = _agent("otro", 300, 470);
        vm.prank(otro);
        vm.expectRevert(PanalTablonV2_5.WrongState.selector);
        tablon.take(id);
    }

    // ─────────────────────────────────────── cobrar dos veces

    function test_ataque_no_se_cobra_dos_veces_ni_se_cierra_dos_veces() public {
        (uint256 id,) = _asignado();
        vm.warp(block.timestamp + 1 days + 1);
        tablon.settle(id);
        vm.expectRevert(PanalTablonV2_5.WrongState.selector);
        tablon.settle(id);

        vm.startPrank(client);
        tablon.claim(MON);
        vm.expectRevert(PanalTablonV2_5.NothingToClaim.selector);
        tablon.claim(MON);
        vm.stopPrank();
    }

    function test_ataque_un_encargo_vuelto_a_publicar_se_retira_una_sola_vez() public {
        address a = _agent("a", 30, 420);
        PanalTablonV2_5.PostParams memory p = _params(MON, 5 ether, IMMEDIATE);
        p.relist = true;
        uint256 id = _post(p);
        _take(a, id);
        vm.warp(block.timestamp + 1 days + 1);
        tablon.settle(id); // vuelve a estar publicado

        vm.startPrank(client);
        tablon.withdrawJob(id);
        vm.expectRevert(PanalTablonV2_5.WrongState.selector);
        tablon.withdrawJob(id);
        uint256 antes = client.balance;
        tablon.claim(MON);
        vm.stopPrank();
        assertEq(client.balance - antes, 5 ether, "el deposito, una vez");
    }

    // ─────────────────────────────────────── MON a la fuerza

    function test_ataque_MON_metido_a_la_fuerza_no_descuadra_nada() public {
        new Kamikaze{value: 3 ether}(payable(address(tablon)));
        assertEq(address(tablon).balance, 3 ether);

        (uint256 id,) = _asignado();
        vm.warp(block.timestamp + 1 days + 1);
        tablon.settle(id);
        uint256 antes = client.balance;
        vm.prank(client);
        tablon.claim(MON);
        assertEq(client.balance - antes, 5 ether, "el cliente cobra lo suyo, ni mas ni menos");
        (uint256 posted,, uint256 owedTotal) = tablon.books(MON);
        assertEq(posted + owedTotal, 0);
    }

    // ─────────────────────────────────────── volver a entrar

    function test_ataque_reentrar_al_cobrar_solo_llega_a_lo_inofensivo() public {
        CobradorCurioso c = new CobradorCurioso(tablon);
        vm.deal(address(c), 0);
        vm.prank(address(c));
        registry.registerAgent("ipfs://c", 1 ether, MON);
        _rep(address(c), 30, 420);

        uint256 suyo = c.publicar{value: 1 ether}(_params(MON, 1 ether, IMMEDIATE));
        c.retirar(suyo);
        uint256 ajeno = _post(MON, 2 ether, SELECTION);

        // Lo que no mueve dinero se puede hacer desde dentro, y no rompe nada.
        c.cobrar(ajeno, false);
        assertEq(address(c).balance, 1 ether);
        assertEq(tablon.owed(address(c), MON), 0);

        // Cobrar otra vez desde dentro: el cerrojo lo para y el cobro entero revierte.
        uint256 otro = c.publicar{value: 1 ether}(_params(MON, 1 ether, IMMEDIATE));
        c.retirar(otro);
        vm.expectRevert(PanalTablonV2_5.TransferFailed.selector);
        c.cobrar(ajeno, true);
        assertEq(tablon.owed(address(c), MON), 1 ether, "se le sigue debiendo, entero");
    }

    // ─────────────────────────────────────── numeros extremos

    function test_ataque_plazos_enormes_no_desbordan() public {
        PanalTablonV2_5.PostParams memory p = _params(MON, 1 ether, SELECTION);
        p.applyWindow = type(uint64).max;
        p.chooseWindow = type(uint64).max;
        p.expiresAt = type(uint64).max;
        vm.prank(client);
        vm.expectRevert(PanalTablonV2_5.InvalidTimes.selector);
        tablon.post{value: 1 ether}(p);

        // Un plazo de entrega enorme ya no se publica (365 dias como mucho,
        // igual que el escrow), y con el maximo el escrow lo acepta.
        p = _params(MON, 1 ether, IMMEDIATE);
        p.workDuration = type(uint64).max;
        vm.prank(client);
        vm.expectRevert(PanalTablonV2_5.InvalidTimes.selector);
        tablon.post{value: 1 ether}(p);

        p.workDuration = 365 days;
        p.expiresAt = uint64(block.timestamp + 365 days);
        uint256 id = _post(p);
        address a = _agent("a", 30, 420);
        vm.warp(block.timestamp + 100 days);
        _take(a, id);
        assertEq(escrow.getTask(_job(id).escrowTaskId).deadline, block.timestamp + 365 days);
    }

    /// Auditoria interna, hallazgo 3: un encargo con vigencia enorme que vuelve
    /// a publicarse desbordaba al sumar. Ya no entra, y la cuenta va en uint256.
    function test_ataque_volver_a_publicar_con_la_vigencia_maxima() public {
        address a = _agent("a", 30, 420);
        PanalTablonV2_5.PostParams memory p = _params(MON, 1 ether, IMMEDIATE);
        p.relist = true;
        p.expiresAt = uint64(block.timestamp + 365 days);
        uint256 id = _post(p);
        _take(a, id);
        vm.warp(block.timestamp + 1 days + 1);
        tablon.settle(id);
        assertEq(_job(id).expiresAt, block.timestamp + 365 days);
    }

    // ─────────────────────────────────────── arreglados en la revision

    /// F2. Un plazo imposible haria sancionar a un bot honrado por coger un
    ///     encargo que nadie podia entregar. Ya no se puede publicar.
    function test_ataque_F2_un_plazo_imposible_ya_no_se_publica() public {
        PanalTablonV2_5.PostParams memory p = _params(MON, 0.001 ether, IMMEDIATE);
        p.workDuration = 1;
        vm.deal(atacante, 1 ether);
        vm.prank(atacante);
        vm.expectRevert(PanalTablonV2_5.InvalidTimes.selector);
        tablon.post{value: 0.001 ether}(p);
        assertEq(tablon.MIN_WORK_DURATION(), 1 hours);
    }

    /// F4. Adelantarse con el id de una campaña ajena no la bloquea: cada
    ///     campaña es de quien la publica.
    function test_ataque_F4_nadie_ocupa_la_campana_de_otro() public {
        PanalTablonV2_5.PostParams memory p = _params(MON, 1 ether, IMMEDIATE);
        p.campaignId = keccak256("evento-octubre");
        p.campaignCapPerAgent = 255;
        _postAs(client2, p); // se adelanta

        p.campaignCapPerAgent = 2;
        uint256 id = _post(p); // y la de verdad se publica igual, con su tope
        assertEq(tablon.campaignCap(keccak256(abi.encode(client, p.campaignId))), 2);
        address a = _agent("a", 30, 420);
        _take(a, id);
    }

    /// F6. Una oferta ya no ata para siempre: medio año despues no se puede
    ///     asignar, y el encargo se devuelve.
    function test_ataque_F6_una_oferta_vieja_ya_no_se_asigna() public {
        address a = _agent("a", 300, 470);
        vm.deal(atacante, 10 ether);
        PanalTablonV2_5.PostParams memory p = _params(MON, 1 ether, SELECTION);
        p.expiresAt = uint64(block.timestamp + 365 days);
        uint256 id = _postAs(atacante, p);
        _apply(a, id, 1 ether, 1 hours);

        vm.warp(block.timestamp + 180 days);
        vm.prank(atacante);
        vm.expectRevert(PanalTablonV2_5.Expired.selector);
        tablon.choose(id, a);
        vm.expectRevert(PanalTablonV2_5.Expired.selector);
        tablon.autoAssign(id);
        tablon.expire(id);
        (,,, uint64 until) = _stats(a);
        assertEq(until, 0, "el agente no paga por una oferta vieja");
    }

    // ─────────────────────────────────────── riesgos aceptados
    //
    // Siguen siendo posibles y estan en TABLON-SECURITY.md con su motivo. Estas
    // pruebas fijan el comportamiento de hoy: si alguien lo cambia, se entera.

    /// F1. Llenar el tope total bloquea las publicaciones nuevas en esa moneda,
    ///     y el atacante lo recupera todo. La multisig sube el tope con setCaps.
    function test_riesgo_F1_llenar_el_tope_total_bloquea_y_se_recupera() public {
        vm.deal(atacante, 1_000 ether);
        uint256 a = _postAs(atacante, _params(MON, 500 ether, IMMEDIATE));
        uint256 b = _postAs(atacante, _params(MON, 500 ether, IMMEDIATE));
        vm.prank(client);
        vm.expectRevert(PanalTablonV2_5.OverTotalCap.selector);
        tablon.post{value: 1 ether}(_params(MON, 1 ether, IMMEDIATE));

        vm.prank(multisig);
        tablon.setCaps(MON, 500 ether, 2_000 ether); // la respuesta
        _post(MON, 1 ether, IMMEDIATE);

        vm.startPrank(atacante);
        tablon.withdrawJob(a);
        tablon.withdrawJob(b);
        tablon.claim(MON);
        vm.stopPrank();
        assertEq(atacante.balance, 1_000 ether);
    }

    /// F3. Cada cartera nueva trae sus 2 encargos de novato, tambien en modo
    ///     inmediato. Se decidio no cerrarlo; el cliente puede marcar el
    ///     encargo "solo con experiencia" o publicar en seleccion.
    function test_riesgo_F3_carteras_novatas_cogen_inmediatos() public {
        for (uint256 i; i < 3; i++) {
            _take(_agent(string.concat("sybil", vm.toString(i))), _post(MON, 1 ether, IMMEDIATE));
        }
        PanalTablonV2_5.PostParams memory p = _params(MON, 1 ether, IMMEDIATE);
        p.experiencedOnly = true;
        uint256 cerrado = _post(p);
        address otro = _agent("sybil3"); // antes del expectRevert: registrarlo son llamadas
        _notAllowed("experienced only");
        _take(otro, cerrado);
    }

    /// F5. Una disputa sin decision en 14 dias se cierra a mitad y mitad (en el
    ///     v2 se devolvia todo al cliente), sin falta para el agente, aunque la
    ///     abriera el mismo agente: abrirla no le da mas que la mitad.
    function test_riesgo_F5_disputa_atascada_mitad_y_mitad_sin_falta() public {
        address a = _agent("a", 30, 420);
        uint256 id = _post(MON, 2 ether, IMMEDIATE);
        _take(a, id);
        _deliver(id);
        uint256 tid = _job(id).escrowTaskId;
        vm.prank(a);
        escrow.openDispute(tid, bytes32(0));
        vm.warp(block.timestamp + 14 days);
        tablon.settle(id);
        (,,, uint64 until) = _stats(a);
        assertEq(until, 0);
        assertEq(tablon.owed(client, MON), 1 ether, "la mitad vuelve al cliente");
    }

    // ─────────────────────────────────────── nuevo en el v2.5

    /// Cualquiera puede devolver en el escrow un encargo vencido (refundExpired):
    /// el tablon lo reconoce igual al cerrar, con su falta.
    function test_ataque_devolver_por_el_escrow_no_salta_la_falta() public {
        (uint256 id, address a) = _asignado();
        vm.warp(block.timestamp + 1 days + 1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = _job(id).escrowTaskId;
        vm.prank(atacante);
        escrow.refundExpired(ids);
        tablon.settle(id);
        assertEq(tablon.owed(client, MON), 5 ether);
        (,,, uint64 until) = _stats(a);
        assertEq(until, block.timestamp + 7 days);
    }

    /// Un agente que rechaza para no llevarse la suspension de 7 dias se lleva
    /// la falta igual: tres en 90 dias son 30 dias fuera.
    function test_ataque_rechazar_en_serie_acaba_en_30_dias_fuera() public {
        address a = _agent("a", 30, 420);
        for (uint256 i; i < 3; i++) {
            uint256 id = _post(MON, 1 ether, IMMEDIATE);
            _take(a, id);
            uint256 tid = _job(id).escrowTaskId;
            vm.prank(a);
            escrow.rejectTask(tid);
            tablon.settle(id);
        }
        (,,, uint64 until) = _stats(a);
        assertEq(until, block.timestamp + 30 days);
    }

    /// Suspender al cliente no deja al agente sin cobrar lo que ya entrego.
    function test_ataque_suspender_al_cliente_no_bloquea_al_agente() public {
        (uint256 id, address a) = _asignado();
        address[] memory l = new address[](1);
        l[0] = client;
        vm.prank(multisig);
        bans.suspend(l, keccak256("fraude"));
        _deliver(id); // en el escrow el cliente es el tablon, que no esta suspendido
        vm.warp(block.timestamp + 72 hours);
        tablon.settle(id);
        assertEq(escrow.pendingWithdrawals(MON, a), 4.875 ether);
    }

    /// Un token que devuelve false: la aprobacion al escrow se queda en cero y
    /// nada se mueve a medias (lo cubre _safeCall). Aqui, que la aprobacion
    /// siempre vuelve a cero aunque el escrow coja menos.
    function test_ataque_la_aprobacion_al_escrow_siempre_vuelve_a_cero() public {
        address a = _agent("a", 30, 420);
        uint256 id = _post(address(usdc), 5e6, SELECTION);
        _apply(a, id, 3e6, 0);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(client);
        tablon.choose(id, a);
        assertEq(usdc.allowance(address(tablon), address(escrow)), 0);
        assertEq(tablon.owed(client, address(usdc)), 2e6);
    }

    function test_ataque_una_oferta_no_puede_pedir_menos_del_minimo_ni_mas_del_tope() public {
        address a = _agent("a", 30, 420);
        uint256 id = _post(MON, 1 ether, SELECTION);
        vm.startPrank(a);
        vm.expectRevert(PanalTablonV2_5.BelowMinimum.selector);
        tablon.applyFor(id, 0, 0);
        vm.expectRevert(PanalTablonV2_5.OverPerJobCap.selector);
        tablon.applyFor(id, type(uint256).max, 0);
        vm.stopPrank();
    }
}
