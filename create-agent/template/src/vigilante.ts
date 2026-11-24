/**
 * El vigilante: se entera de las tareas aunque nadie llame a la puerta.
 *
 * Un agente normal solo trabaja cuando alguien le hace POST /brief. Eso deja
 * tres agujeros que cuestan dinero de verdad, y los tres han pasado:
 *
 *   1. EL ENCARGO QUE NO LLEGÓ. El cliente pagó on-chain y el push del brief
 *      falló —móvil, wallet que se traga la firma, pestaña cerrada, tu agente
 *      caído dos minutos—. El pago se queda bloqueado y tú no te enteras.
 *   2. EL TRABAJO A MEDIAS. Recibiste el encargo, te pusiste a trabajar y el
 *      proceso murió. Al arrancar no queda ni rastro: la tarea sigue abierta
 *      para siempre.
 *   3. LA ENTREGA QUE NO SE ANCLÓ. Terminaste el trabajo, lo guardaste, y la
 *      transacción de entrega falló. Tienes el resultado en disco y el cliente
 *      no tiene nada.
 *
 * LO QUE NO PUEDE HACER, y conviene tenerlo claro antes de esperarlo: el
 * escrow guarda `keccak256(encargo)`, no el encargo. Un vigilante que ve una
 * tarea nueva sabe que existe, de quién es y cuánto paga, pero NO qué le
 * pidieron. Si el encargo nunca llegó, no hay nada que inventar: se avisa con
 * el enlace de reenvío y se espera. Adivinar sería entregar cualquier cosa
 * anclando su hash, que es peor que no entregar.
 *
 * «MIRADA» NO ES «RESUELTA», y confundirlas costó dos tareas de verdad.
 *
 * La marca guarda hasta dónde se ha ENUMERADO, no hasta dónde se ha resuelto.
 * Antes se escribía al final de cada ronda pasara lo que pasara, así que una
 * tarea que fallaba a mitad —el modelo colgado, el RPC caído— se quedaba por
 * detrás de la marca y no volvía a mirarse nunca. Y lo que la recordaba vivía
 * solo en memoria, o sea que un reinicio conservaba la mitad optimista (la
 * marca, en disco) y perdía la otra (los pendientes, en RAM).
 *
 * Ahora las dos cosas viven en el MISMO archivo y se escriben juntas: la marca
 * dice hasta dónde se enumeró, y `pendientes` lleva las excepciones. Una tarea
 * sale de esa lista cuando de verdad se cierra —entregada, completada,
 * cancelada— y no cuando se intentó algo con ella.
 *
 * SE SONDEA, NO SE ESCUCHAN EVENTOS. `eth_getLogs` del RPC público está
 * limitado a 100 bloques, así que un agente parado veinte minutos ya no puede
 * recuperar su propio hueco. Leer el contador de tareas y mirar las nuevas es
 * una llamada cada vuelta, funciona igual tras cualquier parón y no depende de
 * que el RPC conserve nada.
 *
 * LOS DOS ESCROWS (24-nov-2026). Desde el escrow v2.5 hay dos contadores: el
 * del v2, que sigue cerrando lo suyo, y el del v2.5, donde entra todo lo nuevo.
 * Sus tareas llevan, fuera de la cadena, su número + 1.000.000.000, y el SDK
 * elige el contrato por el número. El v2.5 trae tres cosas que mirar:
 *
 *   - ACEPTAR A TIEMPO. Una tarea sin aceptar solo se puede entregar hasta su
 *     `acceptBy` (entregar cuenta como aceptar). Si un trabajo se alarga y ese
 *     momento se acerca, se acepta en la cadena; desde ahí el límite es el
 *     plazo. Pasado `acceptBy` sin aceptar ya no se puede ni aceptar ni
 *     entregar: el cliente la cancela y recupera su dinero, y aquí se suelta.
 *   - COBRAR LO QUE PASÓ LA REVISIÓN. Entregada, si el cliente no aprueba ni
 *     disputa dentro de su revisión (de 24 h a 7 días), cualquiera puede
 *     liberar el pago, y quien más interés tiene es este agente. Las entregadas
 *     se apuntan en `porCobrar` y, pasada su revisión, se liberan juntas.
 *   - RECHAZAR no lo hace solo: un encargo que no encaja se contesta por HTTP
 *     como siempre.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256, toBytes } from 'viem';
import type { Address } from 'viem';
import {
  EstadoV2_5,
  TaskStatus,
  comoTask,
  esDelV2_5,
  finDeLaRevision,
  idDelV2_5,
  type PanalClient,
  type TareaV2_5,
} from '@panal/sdk';

/**
 * Cuánto antes de `acceptBy` se acepta una tarea del v2.5 que se está
 * trabajando. Aceptar es una transacción (~0,005 MON): solo se gasta cuando el
 * trabajo puede pasarse de ese momento. Lo normal —la web da para aceptar
 * hasta 15 minutos antes del plazo— es entregar mucho antes y no gastarla.
 */
export const ACEPTAR_SI_QUEDAN_S = 20 * 60;

/** Cada cuánto se intenta cobrar lo que pasó la revisión. */
const COBRO_CADA_MS = 15 * 60 * 1000;

export interface VigilanteDeps {
  panal: PanalClient;
  /** La dirección de este agente. */
  yo: Address;
  /** Dónde guardar hasta dónde se miró. */
  dataDir: string;
  /**
   * Trabaja una tarea de la que YA se tiene el encargo.
   *
   * Devuelve si la ENTREGÓ, y ese booleano es media corrección de este archivo.
   * `work()` está escrito para no lanzar nunca —una tarea rota no puede tumbar
   * la ronda entera—, así que desde aquí un reintento que funcionó y uno que
   * volvió a reventar por límite de uso se veían exactamente igual: sin error.
   * El vigilante daba por buena la tarea y dejaba de mirarla.
   *
   * Y no vale con relanzar el error: `work()` también sale limpio cuando la
   * tarea espera adjuntos que no han llegado, que tampoco es haberla resuelto.
   * Hace falta que lo diga, no que se deduzca de que nadie protestó.
   */
  trabajar: (taskId: bigint, brief: string) => Promise<boolean>;
  /**
   * ¿Se está trabajando esa tarea AHORA MISMO?
   *
   * Sin esto, el vigilante no sabe distinguir un trabajo en curso de uno
   * muerto: los dos se ven igual desde fuera —tarea abierta, encargo en disco,
   * sin resultado—. Se vio en la primera prueba real, donde anunció que
   * retomaba una tarea que estaba corriendo tan tranquila. No llegó a
   * duplicarla porque `work` tiene su propia guarda, pero el aviso era falso, y
   * un trabajo más largo que el intervalo lo repetiría en cada vuelta.
   */
  enCurso: (taskId: bigint) => boolean;
  /** El encargo recibido, si se guardó. */
  briefGuardado: (taskId: bigint) => string | null;
  /** El resultado ya calculado, si lo hay. */
  resultadoGuardado: (taskId: bigint) => string | null;
  /** Reintenta anclar un resultado que ya está calculado. */
  reentregar: (taskId: bigint, texto: string) => Promise<void>;
  /** URL pública del agente, para el aviso de encargo huérfano. */
  urlPublica?: string;
  /**
   * Las tareas que repartió el tablón con reglas (PanalTablon). Su cliente en
   * el escrow es el tablón, su encargo no llega por /brief —se lee firmando del
   * buzón del tablón— y su entrega tiene que dejarse allí antes de anclarse.
   * Por eso no siguen el camino de las demás: ni se reentregan con
   * `reentregar`, ni se avisa de que falte su encargo. `retomar` dice si quedó
   * entregada. Sin esto, cada una saldría como «PAGADA Y SIN ENCARGO».
   */
  tablon?: {
    es: (cliente: Address) => boolean;
    retomar: (taskId: bigint) => Promise<boolean>;
  };
  /**
   * Acepta en la cadena una tarea del v2.5 (ver `ACEPTAR_SI_QUEDAN_S`). Sin
   * esto, un trabajo que se alargue más allá de `acceptBy` ya no se podría
   * entregar.
   */
  aceptar?: (taskId: bigint) => Promise<void>;
  /**
   * Libera juntas las entregadas del v2.5 cuya revisión ya pasó. Devuelve si
   * lo hizo: `false` si no compensaba todavía o la wallet estaba ocupada, y
   * entonces se reintenta más tarde.
   */
  liberar?: (tareas: TareaV2_5[]) => Promise<boolean>;
}

/** Cada cuánto se mira cuando hay movimiento, en segundos. */
const CADA = (() => {
  const n = Number(process.env.VIGILANTE_SEGUNDOS?.trim() || '60');
  // Menos de 15 s no aporta nada y sí gasta el límite del RPC.
  return Number.isFinite(n) && n >= 15 ? Math.floor(n) : 60;
})();

/**
 * Cuántas vueltas en blanco antes de bajar el ritmo, y a cuánto se baja.
 *
 * Un agente parado pregunta `getTaskCount()` cada 60 s aunque no pase nada.
 * Una gota. Pero el RPC público es COMPARTIDO y corta cerca de 50 llamadas
 * concurrentes: con mil agentes son 16,7 llamadas/s permanentes, y entre
 * todos ahogan el pozo del que bebe también el indexador — que es de quien
 * depende el catálogo entero del mercado.
 *
 * Así que tras un rato sin encontrar nada —el caso normal— se pasa a mirar
 * cada cinco minutos. Al primer hallazgo se vuelve al ritmo corto.
 *
 * Lo que cuesta: un encargo perdido se detecta en cinco minutos en vez de en
 * uno. Los plazos se miden en horas, así que no cambia nada para nadie.
 */
const VUELTAS_EN_BLANCO = 20;
const CADA_TRANQUILO = Math.max(CADA, 300);

/**
 * Cuánto se espera antes de dar por perdido un encargo.
 *
 * El camino normal es: la transacción se mina y el cliente empuja el encargo
 * unos segundos después. Sin esta espera, el vigilante gritaría en cada tarea
 * legítima y el aviso dejaría de significar nada.
 */
const GRACIA_MS = 3 * 60 * 1000;

/** Cuántas tareas hacia atrás se miran al arrancar sin marca previa. */
const REPASO_INICIAL = 50n;

/**
 * Tope de la lista de pendientes.
 *
 * Una tarea sale de la lista cuando se cierra —entregada, completada,
 * cancelada—, y todas acaban cerrándose: al vencer el plazo el cliente
 * recupera su dinero y la tarea deja de estar abierta. Aun así el tope existe
 * porque nadie OBLIGA al cliente a cancelar: una tarea abandonada puede
 * quedarse abierta para siempre, y sin tope el archivo crecería sin fin.
 *
 * Al recortar se tiran las más VIEJAS, que son las que menos se pueden
 * recuperar, y se dice en voz alta. Callarlo sería repetir el fallo que este
 * archivo viene a arreglar.
 */
const MAX_PENDIENTES = 500;

/** Qué se sabe de una tarea tras mirarla. «Se intentó» no es un veredicto. */
type Veredicto = 'resuelta' | 'pendiente';

export function arrancarVigilante(deps: VigilanteDeps): { parar: () => void } {
  if (process.env.VIGILANTE === 'off') {
    console.log('Vigilante desactivado (VIGILANTE=off).');
    return { parar: () => {} };
  }

  const estadoPath = join(deps.dataDir, 'vigilante.json');
  /**
   * Cuándo se vio por primera vez una tarea sin encargo.
   *
   * Esto SÍ puede vivir solo en memoria: solo sirve para el margen de gracia
   * antes de gritar, y perderlo en un reinicio únicamente reinicia esa cuenta
   * atrás. Lo que no puede vivir solo en memoria es la lista de pendientes, y
   * por eso está aparte.
   */
  const vistas = new Map<string, number>();
  /** De las que ya se avisó, para no repetir el aviso cada vuelta. */
  const avisadas = new Set<string>();
  /** De los encargos guardados que no cuadran, para no repetir la queja. */
  const quejadas = new Set<string>();
  let parado = false;

  interface Estado {
    visto: bigint;
    pendientes: Set<string>;
    /** Hasta dónde se enumeró el escrow v2.5, con su número de la CADENA (-1: nada). */
    visto25: bigint;
    /** Entregadas del v2.5 que esperan a que acabe su revisión para cobrarlas. */
    porCobrar: Set<string>;
  }

  const leerEstado = (): Estado => {
    try {
      const raw = JSON.parse(readFileSync(estadoPath, 'utf8')) as {
        visto?: string;
        pendientes?: string[];
        visto25?: string;
        porCobrar?: string[];
      };
      return {
        // -1 y no 0: sin marca hay que hacer el repaso inicial.
        visto: raw.visto === undefined ? -1n : BigInt(raw.visto),
        // Un archivo de la versión anterior no trae la lista. Se lee como
        // vacía y la primera ronda la vuelve a poblar con lo que siga abierto
        // por delante de la marca; lo que quedó huérfano por detrás hay que
        // recuperarlo a mano, que es exactamente el destrozo que esto corrige.
        pendientes: new Set(raw.pendientes ?? []),
        // Un archivo de antes del v2.5 no las trae: se empieza desde cero, que
        // en el v2.5 es empezar por su primera tarea.
        visto25: raw.visto25 === undefined ? -1n : BigInt(raw.visto25),
        porCobrar: new Set(raw.porCobrar ?? []),
      };
    } catch {
      return { visto: -1n, pendientes: new Set(), visto25: -1n, porCobrar: new Set() };
    }
  };

  /**
   * Las dos cosas se escriben JUNTAS, y ahí está la corrección.
   *
   * Antes la marca iba a disco y los pendientes se quedaban en RAM, así que un
   * reinicio guardaba la mitad que dice «ya miré» y perdía la que dice «pero
   * esto sigue sin resolver». En un solo archivo no puede pasar.
   */
  const escribirEstado = (e: Estado): void => {
    const { visto, pendientes } = e;
    let lista = [...pendientes];
    if (lista.length > MAX_PENDIENTES) {
      // Ordenadas por id: las más viejas primero, que son las que se tiran.
      lista.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      const tiradas = lista.slice(0, lista.length - MAX_PENDIENTES);
      lista = lista.slice(-MAX_PENDIENTES);
      console.error(
        `[vigilante] la lista de pendientes pasó de ${MAX_PENDIENTES}: dejo de seguir ` +
          `${tiradas.length} tarea(s) vieja(s) (#${tiradas[0]}…#${tiradas[tiradas.length - 1]}). ` +
          'Míralas a mano si alguna sigue abierta.',
      );
    }
    try {
      // `porCobrar` con el mismo tope: todas salen al cobrarse o cerrarse, pero
      // nada obliga a que pase.
      const cobrar = [...e.porCobrar].slice(-MAX_PENDIENTES);
      writeFileSync(
        estadoPath,
        JSON.stringify(
          { visto: visto.toString(), pendientes: lista, visto25: e.visto25.toString(), porCobrar: cobrar },
          null,
          2,
        ),
      );
    } catch (err) {
      // Perder el estado cuesta repetir el repaso, así que no se para nada.
      console.error(`[vigilante] no se pudo guardar el estado: ${err instanceof Error ? err.message : err}`);
    }
  };

  /** true si encontro algo que atender: eso es lo que decide el ritmo. */
  async function repasar(): Promise<boolean> {
    const total = await deps.panal.getTaskCount();
    const estado = leerEstado();
    const { visto, pendientes } = estado;
    // La primera vez se miran las últimas REPASO_INICIAL en vez de las 30.000
    // que pueda haber: las viejas están cerradas y no cambian.
    const desde = visto >= 0n ? visto + 1n : total > REPASO_INICIAL ? total - REPASO_INICIAL : 0n;

    // Las nuevas, más las que quedaron sin resolver de vueltas anteriores.
    const aMirar = new Set<string>(pendientes);
    for (let i = desde; i < total; i++) aMirar.add(i.toString());

    // Y las del v2.5, con su número de fuera de la cadena. Si su contador no
    // responde, esta vuelta se queda en lo que ya había: la marca no avanza y
    // la próxima las recoge.
    let visto25 = estado.visto25;
    if (deps.panal.v2_5) {
      try {
        const total25 = await deps.panal.getTaskCountV2_5();
        const desde25 = visto25 >= 0n ? visto25 + 1n : total25 > REPASO_INICIAL ? total25 - REPASO_INICIAL : 0n;
        for (let i = desde25; i < total25; i++) aMirar.add(idDelV2_5(i).toString());
        visto25 = total25 - 1n;
      } catch (err) {
        console.error(`[vigilante] el contador del escrow v2.5 no respondió: ${err instanceof Error ? err.message : err}`);
      }
    }

    const porCobrar = new Set(estado.porCobrar);
    const guardar = (restantes: Set<string>): void =>
      escribirEstado({ visto: total - 1n, pendientes: restantes, visto25, porCobrar });

    if (aMirar.size === 0) {
      guardar(aMirar);
      await cobrarRevisadas(porCobrar).catch((err) =>
        console.error(`[vigilante] cobrar lo revisado: ${err instanceof Error ? err.message : err}`),
      );
      guardar(aMirar);
      return false;
    }

    // Se PARTE de que todas siguen pendientes y solo sale la que devuelva un
    // veredicto de resuelta. Antes era al revés —dentro salvo que alguien se
    // quejara— y por eso un fallo a mitad equivalía a un éxito.
    const restantes = new Set<string>(aMirar);
    for (const id of aMirar) {
      // `break` y no `return`: hay que guardar lo que sí se llegó a resolver,
      // y sobre todo lo que no.
      if (parado) break;
      const taskId = BigInt(id);
      let veredicto: Veredicto = 'pendiente';
      try {
        veredicto = await revisarUna(taskId, porCobrar);
      } catch (err) {
        console.error(
          `[vigilante] #${taskId}: ${err instanceof Error ? err.message : err} — sigue pendiente`,
        );
      }
      if (veredicto === 'resuelta') restantes.delete(id);
    }
    guardar(restantes);
    if (!parado) {
      await cobrarRevisadas(porCobrar).catch((err) =>
        console.error(`[vigilante] cobrar lo revisado: ${err instanceof Error ? err.message : err}`),
      );
      guardar(restantes);
    }
    // Habia algo que mirar, aunque no fuera nuestro: no es una vuelta en blanco.
    return true;
  }

  /** Cuándo se intentará cobrar otra vez (en memoria: perderlo solo adelanta un intento). */
  let proximoCobro = 0;

  /**
   * Libera las entregadas del v2.5 cuya revisión ya pasó. Las que ya no están
   * entregadas —aprobadas, liberadas por otro, en disputa— salen de la lista:
   * su dinero ya va por otro camino.
   */
  async function cobrarRevisadas(porCobrar: Set<string>): Promise<void> {
    if (!deps.liberar || porCobrar.size === 0 || Date.now() < proximoCobro) return;
    proximoCobro = Date.now() + COBRO_CADA_MS;
    const ahora = BigInt(Math.floor(Date.now() / 1000));
    const listas: TareaV2_5[] = [];
    for (const id of [...porCobrar]) {
      if (parado) return;
      const t = await deps.panal.getTaskV2_5(BigInt(id));
      const fin = finDeLaRevision(t);
      if (fin === null) {
        porCobrar.delete(id);
        continue;
      }
      if (ahora >= fin) listas.push(t);
    }
    if (listas.length === 0) return;
    if (await deps.liberar(listas)) for (const t of listas) porCobrar.delete(t.id.toString());
  }

  async function revisarUna(taskId: bigint, porCobrar: Set<string>): Promise<Veredicto> {
    // Del v2.5 se lee entera: hacen falta `acceptBy` y si ya se aceptó.
    const v25 = esDelV2_5(taskId) ? await deps.panal.getTaskV2_5(taskId) : null;
    const task = v25 ? comoTask(v25) : await deps.panal.getTask(taskId);
    const id = taskId.toString();

    // No es mía: no hay nada que resolver y no hará falta volver a mirarla.
    if (task.worker.toLowerCase() !== deps.yo.toLowerCase()) {
      vistas.delete(id);
      return 'resuelta';
    }
    // Cerrada en la cadena —entregada, completada, disputada o cancelada—.
    // ESTA es la única salida buena de la lista: lo dice el escrow, no nosotros.
    if (task.status !== TaskStatus.Open) {
      vistas.delete(id);
      avisadas.delete(id);
      quejadas.delete(id);
      // Entregada en el v2.5: queda cobrarla si el cliente no aprueba a tiempo.
      if (v25?.estado === EstadoV2_5.Entregada && deps.liberar) porCobrar.add(id);
      return 'resuelta';
    }

    // Del v2.5 y sin aceptar: entregar solo vale hasta `acceptBy`.
    if (v25?.estado === EstadoV2_5.Abierta) {
      const ahora = BigInt(Math.floor(Date.now() / 1000));
      if (ahora > v25.acceptBy) {
        vistas.delete(id);
        avisadas.delete(id);
        console.error(
          `[vigilante] #${taskId} pasó su tiempo de aceptar sin aceptarla ni entregarla: ya no se puede ` +
            'hacer nada con ella. El cliente puede cancelarla y recuperar su dinero.',
        );
        return 'resuelta';
      }
      // Se trabaja ahora y el trabajo puede pasarse de `acceptBy`: se acepta,
      // y desde ahí el límite es el plazo. Si falla, se reintenta la próxima vuelta.
      if (deps.enCurso(taskId) && deps.aceptar && v25.acceptBy - ahora < BigInt(ACEPTAR_SI_QUEDAN_S)) {
        try {
          await deps.aceptar(taskId);
          console.log(`[vigilante] #${taskId} aceptada en la cadena: el trabajo se alarga y su tiempo de aceptar se acababa`);
        } catch (err) {
          console.error(`[vigilante] #${taskId} no se pudo aceptar: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    // Se está trabajando ahora mismo: no es un hueco, es el camino normal. Ni
    // se retoma, ni se avisa de que falte el encargo — lo tiene y lo está
    // usando. El vigilante solo se ocupa de lo que ya no se mueve.
    //
    // PERO SIGUE PENDIENTE. Antes esto la sacaba de la lista, y era el mismo
    // fallo con otro disfraz: si ese trabajo en curso acababa reventando, la
    // marca ya había pasado por encima y no volvía a mirarla nadie.
    if (deps.enCurso(taskId)) {
      vistas.delete(id);
      return 'pendiente';
    }

    // Del tablón con reglas: por su camino. Si `retomar` lanza, sube a
    // `repasar`, que la deja pendiente para la próxima vuelta.
    if (deps.tablon?.es(task.client)) {
      const entregada = await deps.tablon.retomar(taskId);
      vistas.delete(id);
      return entregada ? 'resuelta' : 'pendiente';
    }

    // CASO 3: el resultado está calculado y la tarea sigue abierta, así que la
    // entrega no llegó a anclarse. Se reintenta, que es gratis para el cliente
    // y le devuelve una tarea que daba por perdida.
    //
    // Si `reentregar` falla, lanza: sube a `repasar`, que la deja pendiente.
    const resultado = deps.resultadoGuardado(taskId);
    if (resultado !== null) {
      console.log(`[vigilante] #${taskId} tenía resultado sin anclar: se reintenta la entrega`);
      await deps.reentregar(taskId, resultado);
      vistas.delete(id);
      return 'resuelta';
    }

    // CASO 2: el encargo está guardado pero no hay resultado, o sea que el
    // trabajo se quedó a medias. Se retoma.
    const brief = deps.briefGuardado(taskId);
    if (brief !== null) {
      // Se comprueba el hash ANTES de trabajar. El archivo lleva en disco desde
      // otra ejecución y no vale fiarse: si no cuadra con lo que hay en la
      // cadena, trabajar sobre él sería entregar algo que el cliente no pidió.
      if (keccak256(toBytes(brief)) !== task.taskHash) {
        // Pendiente, NO resuelta: el cliente todavía puede reenviar el bueno
        // por /reenviar y entonces sí se puede trabajar. Se queja una sola vez
        // para no llenar el log en cada vuelta.
        if (!quejadas.has(id)) {
          quejadas.add(id);
          console.error(
            `[vigilante] #${taskId} el encargo guardado NO cuadra con el taskHash de la cadena: ` +
              'no se trabaja sobre él. Que el cliente lo reenvíe.',
          );
        }
        return 'pendiente';
      }
      console.log(`[vigilante] #${taskId} se quedó a medias: se retoma el trabajo`);
      const entregada = await deps.trabajar(taskId, brief);
      vistas.delete(id);
      // AQUÍ vivía el segundo fallo: se daba por resuelta sin mirar si lo
      // estaba. Un modelo que devuelve 429 dos veces seguidas se veía igual
      // que una entrega perfecta.
      if (!entregada) {
        console.log(`[vigilante] #${taskId} no quedó entregada: sigue en la lista para la próxima vuelta`);
      }
      return entregada ? 'resuelta' : 'pendiente';
    }

    // CASO 1: hay tarea y no hay encargo. Aquí no se puede hacer nada más que
    // avisar: el texto no está en la cadena y adivinarlo sería inventárselo.
    const visto = vistas.get(id);
    if (visto === undefined) {
      vistas.set(id, Date.now());
      return 'pendiente';
    }
    if (Date.now() - visto < GRACIA_MS || avisadas.has(id)) return 'pendiente';

    avisadas.add(id);
    // En cuánto vence, no cuándo. La fecha absoluta se imprimía en UTC junto a
    // una marca de log en hora local, y un plazo de dos horas se leía como
    // vencido. Lo que hace falta saber aquí es cuánto margen queda.
    const restanMin = Math.round((Number(task.deadline) * 1000 - Date.now()) / 60000);
    const vence =
      restanMin <= 0
        ? 'YA VENCIDO'
        : restanMin < 60
          ? `en ${restanMin} min`
          : `en ${Math.floor(restanMin / 60)} h ${restanMin % 60} min`;
    console.error(
      `[vigilante] #${taskId} PAGADA Y SIN ENCARGO. ${task.client} bloqueó su pago hace más de ` +
        `${Math.round(GRACIA_MS / 60000)} min y el texto no ha llegado nunca. No se puede adivinar: el escrow ` +
        `solo guarda su hash.\n` +
        `  Que lo reenvíe desde ${deps.urlPublica ? `${deps.urlPublica}/reenviar?task=${taskId}` : 'tu /reenviar'}` +
        ` o desde https://panal.lat/dashboard.\n` +
        `  Si nadie lo hace, el plazo vence ${vence} y el cliente recupera su dinero.`,
    );
    // Sigue abierta y sin encargo: se queda en la lista hasta que la cadena
    // diga otra cosa.
    return 'pendiente';
  }

  console.log(`Vigilante activo: repasa cada ${CADA} s (VIGILANTE=off para apagarlo).`);
  // Una pasada al arrancar, que es cuando más falta hace: recoge todo lo que
  // se perdió mientras el proceso estaba caído.
  void repasar().catch((err) => console.error(`[vigilante] primer repaso: ${err instanceof Error ? err.message : err}`));

  // El ritmo se reprograma en vez de usar un intervalo fijo: así puede
  // aflojar solo cuando lleva un rato sin encontrar nada.
  let enBlanco = 0;
  let tranquilo = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const programar = (ms: number): void => {
    timer = setTimeout(() => {
      void (async () => {
        let hizoAlgo = false;
        try {
          hizoAlgo = await repasar();
        } catch (err) {
          console.error(`[vigilante] ${err instanceof Error ? err.message : err}`);
        }

        if (hizoAlgo) {
          enBlanco = 0;
          if (tranquilo) {
            tranquilo = false;
            console.log(`[vigilante] hay movimiento: vuelvo a mirar cada ${CADA} s`);
          }
        } else if (++enBlanco >= VUELTAS_EN_BLANCO && !tranquilo) {
          tranquilo = true;
          console.log(
            `[vigilante] ${VUELTAS_EN_BLANCO} vueltas sin nada: paso a mirar cada ${CADA_TRANQUILO} s ` +
              'para no cargar el RPC compartido. Vuelvo al ritmo corto en cuanto haya algo.',
          );
        }
        if (!parado) programar((tranquilo ? CADA_TRANQUILO : CADA) * 1000);
      })();
    }, ms);
    // Sin unref, este temporizador mantiene vivo el proceso para siempre
    // aunque todo lo demás haya terminado.
    timer.unref?.();
  };
  programar(CADA * 1000);

  return {
    parar: () => {
      parado = true;
      if (timer) clearTimeout(timer);
    },
  };
}
