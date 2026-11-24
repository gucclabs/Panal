/**
 * Que «se intentó» no vuelva a contar como «se resolvió».
 *
 *     npx tsx test/vigilante.test.ts     (o: npm test)
 *
 * Hermético: no toca la red ni la cadena. `panal` es de mentira y el reloj no
 * hace falta — se llama a la primera pasada del vigilante y se para.
 *
 * LOS DOS FALLOS QUE ESTO CIERRA, los dos vistos en mainnet:
 *
 *   #54 — una tarea reventó a mitad de la ronda (demora del modelo). El error
 *         se registró y se siguió, pero la marca se escribía igual al final, y
 *         lo que recordaba la tarea vivía solo en memoria. Hubo un reinicio y
 *         quedó huérfana: la marca ya estaba por delante y nadie volvió a
 *         mirarla.
 *   #55 — el modelo devolvió 429 dos veces. `work()` no lanza nunca a propósito,
 *         así que el vigilante no vio ningún error, la dio por entregada y dejó
 *         de vigilarla, con la tarea abierta y sin entregar.
 *
 * La prueba que de verdad importa es la del REINICIO: se arranca un vigilante,
 * se le rompe una tarea, se para, y se arranca otro contra el mismo directorio.
 * Es lo que pasó de verdad y es lo que antes perdía la tarea.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { keccak256, toBytes } from 'viem';
import { EstadoV2_5, TaskStatus, idDelV2_5, type TareaV2_5 } from '@panal/sdk';
import { arrancarVigilante } from '../template/src/vigilante.js';
import type { VigilanteDeps } from '../template/src/vigilante.js';

let fallos = 0;
const check = (nombre: string, ok: boolean, detalle = ''): void => {
  console.log(`${ok ? '✅' : '❌'} ${nombre}${ok ? '' : ` — ${detalle}`}`);
  if (!ok) fallos++;
};

const YO = '0x1111111111111111111111111111111111111111' as const;
const OTRO = '0x2222222222222222222222222222222222222222' as const;
const BRIEF = 'revisa este contrato';

interface TareaFalsa {
  client: string;
  worker: string;
  status: TaskStatus;
  taskHash: string;
}

/** Solo lo que el vigilante mira de una tarea. */
function tarea(p: Partial<TareaFalsa> = {}): Record<string, unknown> {
  return {
    client: OTRO,
    worker: YO,
    amount: 1n,
    taskHash: keccak256(toBytes(BRIEF)),
    resultHash: `0x${'00'.repeat(32)}`,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    createdAt: 0n,
    status: TaskStatus.Open,
    currency: `0x${'00'.repeat(20)}`,
    ...p,
  };
}

/**
 * El estado que el vigilante deja en disco.
 *
 * `pendientes ?? []` no es defensa por si acaso: la versión con los fallos no
 * escribía esa lista en absoluto. Sin esto, correr esta prueba contra el
 * código viejo revienta en la primera línea con un `undefined` y no llega a
 * decir QUÉ se pierde — que es justo para lo que sirve.
 */
function leerEstado(dir: string): { visto: string; pendientes: string[] } {
  const raw = JSON.parse(readFileSync(join(dir, 'vigilante.json'), 'utf8')) as {
    visto: string;
    pendientes?: string[];
  };
  return { visto: raw.visto, pendientes: raw.pendientes ?? [] };
}

/**
 * Una pasada completa del vigilante y se para.
 *
 * `arrancarVigilante` hace un primer repaso nada más arrancar, que es
 * justamente el que interesa.
 *
 * Se espera a que el estado CAMBIE, no a que exista. Esperar a que existiera
 * funcionaba en un directorio limpio y mentía en la prueba del reinicio: allí
 * el archivo ya estaba de la vida anterior, así que la espera terminaba antes
 * de que el vigilante nuevo hubiera hecho nada y la prueba fallaba sola.
 */
async function unaPasada(deps: VigilanteDeps): Promise<void> {
  const crudo = (): string | null => {
    try {
      return readFileSync(join(deps.dataDir, 'vigilante.json'), 'utf8');
    } catch {
      return null;
    }
  };
  const antes = crudo();
  const { parar } = arrancarVigilante(deps);
  const hasta = Date.now() + 4000;
  while (crudo() === antes) {
    if (Date.now() > hasta) throw new Error('el vigilante no actualizó el estado');
    await new Promise((r) => setTimeout(r, 10));
  }
  parar();
}

/** Dependencias por defecto: una tarea nuestra, abierta, con encargo guardado. */
function deps(dir: string, extra: Partial<VigilanteDeps> = {}, tareas?: Record<string, unknown>[]): VigilanteDeps {
  const lista = tareas ?? [tarea()];
  return {
    // Solo se usan estos dos métodos; el resto del cliente no hace falta.
    panal: {
      getTaskCount: async () => BigInt(lista.length),
      getTask: async (id: bigint) => lista[Number(id)],
    } as unknown as VigilanteDeps['panal'],
    yo: YO,
    dataDir: dir,
    trabajar: async () => true,
    enCurso: () => false,
    briefGuardado: () => BRIEF,
    resultadoGuardado: () => null,
    reentregar: async () => {},
    ...extra,
  };
}

const temporales: string[] = [];
const nuevoDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'vigilante-'));
  temporales.push(d);
  return d;
};

console.log('\n── Lo que sí se resuelve, sale de la lista ──\n');
{
  const dir = nuevoDir();
  await unaPasada(deps(dir));
  const e = leerEstado(dir);
  check('una tarea entregada no queda pendiente', e.pendientes.length === 0, JSON.stringify(e));
  check('la marca avanza igualmente', e.visto === '0', e.visto);
}
{
  const dir = nuevoDir();
  await unaPasada(deps(dir, {}, [tarea({ worker: OTRO })]));
  check('una tarea de otro no queda pendiente', leerEstado(dir).pendientes.length === 0);
}
{
  const dir = nuevoDir();
  await unaPasada(deps(dir, {}, [tarea({ status: TaskStatus.Completed })]));
  check('una tarea ya cerrada no queda pendiente', leerEstado(dir).pendientes.length === 0);
}

console.log('\n── Bug 2: un reintento que falla NO es un reintento que funciona ──\n');
{
  const dir = nuevoDir();
  await unaPasada(deps(dir, { trabajar: async () => false }));
  const e = leerEstado(dir);
  check('trabajar() que no entrega deja la tarea pendiente', e.pendientes.includes('0'), JSON.stringify(e));
}
{
  // El caso de los adjuntos: `work()` sale limpio, sin error y sin entregar.
  const dir = nuevoDir();
  await unaPasada(deps(dir, { trabajar: async () => false }));
  check('esperar adjuntos tampoco cuenta como resuelta', leerEstado(dir).pendientes.includes('0'));
}
{
  const dir = nuevoDir();
  await unaPasada(deps(dir, { enCurso: () => true }));
  check('una tarea trabajándose ahora sigue pendiente', leerEstado(dir).pendientes.includes('0'));
}

console.log('\n── Bug 1: un error a mitad no adelanta la marca por encima ──\n');
{
  const dir = nuevoDir();
  await unaPasada(
    deps(dir, {
      trabajar: async () => {
        throw new Error('el modelo se colgó');
      },
    }),
  );
  const e = leerEstado(dir);
  check('una tarea que revienta queda pendiente', e.pendientes.includes('0'), JSON.stringify(e));
}
{
  // Falla la LECTURA de la tarea, que es el otro sitio donde reventaba: ahí ni
  // siquiera se llegaba a apuntar nada, ni en memoria.
  const dir = nuevoDir();
  const d = deps(dir);
  d.panal = {
    getTaskCount: async () => 1n,
    getTask: async () => {
      throw new Error('RPC caído');
    },
  } as unknown as VigilanteDeps['panal'];
  await unaPasada(d);
  check('un fallo del RPC deja la tarea pendiente', leerEstado(dir).pendientes.includes('0'));
}
{
  // El error de una tarea no puede arrastrar a las demás.
  const dir = nuevoDir();
  let n = 0;
  await unaPasada(
    deps(
      dir,
      {
        trabajar: async () => {
          n++;
          if (n === 1) throw new Error('la primera revienta');
          return true;
        },
      },
      [tarea(), tarea()],
    ),
  );
  const e = leerEstado(dir);
  check('la que falla queda y la que va bien sale', e.pendientes.length === 1, JSON.stringify(e.pendientes));
}

console.log('\n── Lo que de verdad pasó con la #54: reiniciar ──\n');
{
  const dir = nuevoDir();
  // Primera vida: la tarea revienta.
  await unaPasada(
    deps(dir, {
      trabajar: async () => {
        throw new Error('demora del modelo');
      },
    }),
  );
  const tras = leerEstado(dir);
  check('tras el fallo queda anotada EN DISCO', tras.pendientes.includes('0'), JSON.stringify(tras));

  // Segunda vida: proceso nuevo, mismo directorio, y ahora sí entrega.
  let mirada = false;
  await unaPasada(
    deps(dir, {
      trabajar: async () => {
        mirada = true;
        return true;
      },
    }),
  );
  check('el vigilante nuevo VUELVE a mirarla', mirada);
  check('y al entregarla sale de la lista', leerEstado(dir).pendientes.length === 0);
}

console.log('\n── Las del tablón con reglas, por su camino ──\n');
{
  // Su cliente en el escrow es PanalTablon, no hay encargo guardado (llega del
  // buzón del tablón) y hay un resultado a medias: nada de eso puede llevarla
  // al camino de las demás.
  const TABLON = '0x2Cfc6803E269fa9BF728e202736a7bc0547ae149';
  const dir = nuevoDir();
  const llamadas: string[] = [];
  await unaPasada(
    deps(
      dir,
      {
        briefGuardado: () => null,
        resultadoGuardado: () => 'a medias',
        reentregar: async () => {
          llamadas.push('reentregar');
        },
        trabajar: async () => {
          llamadas.push('trabajar');
          return true;
        },
        tablon: {
          es: (cliente) => cliente.toLowerCase() === TABLON.toLowerCase(),
          retomar: async (id) => {
            llamadas.push(`retomar #${id}`);
            return true;
          },
        },
      },
      [tarea({ client: TABLON })],
    ),
  );
  check('la retoma el tablón, y no se reentrega ni se trabaja por el camino normal', llamadas.join() === 'retomar #0', llamadas.join());
  check('  y, entregada, sale de la lista', leerEstado(dir).pendientes.length === 0);
}
{
  const TABLON = '0x2Cfc6803E269fa9BF728e202736a7bc0547ae149';
  const dir = nuevoDir();
  await unaPasada(
    deps(dir, { briefGuardado: () => null, tablon: { es: () => true, retomar: async () => false } }, [tarea({ client: TABLON })]),
  );
  check('si el tablón no la entregó, queda pendiente', leerEstado(dir).pendientes.includes('0'));
}

console.log('\n── Compatibilidad con el archivo de la versión anterior ──\n');
{
  const dir = nuevoDir();
  writeFileSync(join(dir, 'vigilante.json'), JSON.stringify({ visto: '0' }));
  await unaPasada(deps(dir, {}, [tarea(), tarea()]));
  const e = leerEstado(dir);
  check('un estado sin `pendientes` se lee sin romper', Array.isArray(e.pendientes), JSON.stringify(e));
  check('y respeta la marca que traía', e.visto === '1', e.visto);
}

console.log('\n── El escrow v2.5: su contador, aceptar a tiempo y cobrar lo revisado ──\n');

const AHORA = BigInt(Math.floor(Date.now() / 1000));
/** Una tarea del v2.5, con su número de fuera de la cadena. */
function t25(i: bigint, p: Partial<TareaV2_5> = {}): TareaV2_5 {
  return {
    id: idDelV2_5(i),
    client: OTRO,
    worker: YO,
    currency: `0x${'00'.repeat(20)}`,
    amount: 10n ** 17n,
    taskHash: keccak256(toBytes(BRIEF)),
    resultHash: `0x${'00'.repeat(32)}`,
    estado: EstadoV2_5.Abierta,
    cierre: 0,
    workerShareBps: 0,
    deadline: AHORA + 7200n,
    acceptBy: AHORA + 6300n,
    reviewWindow: 86_400,
    createdAt: AHORA - 60n,
    deliveredAt: 0n,
    disputedAt: 0n,
    ...p,
  } as TareaV2_5;
}

/** Sin tareas en el v2 y estas en el v2.5. */
function deps25(dir: string, extra: Partial<VigilanteDeps>, lista: TareaV2_5[]): VigilanteDeps {
  return deps(dir, {
    panal: {
      getTaskCount: async () => 0n,
      getTask: async () => {
        throw new Error('no hay tareas en el v2');
      },
      v2_5: { escrow: OTRO },
      getTaskCountV2_5: async () => BigInt(lista.length),
      getTaskV2_5: async (id: bigint) => lista[Number(id - idDelV2_5(0n))],
    } as unknown as VigilanteDeps['panal'],
    ...extra,
  });
}

/** Arranca el vigilante y lo para cuando se cumple `listo` (o a los 4 s). */
async function hasta(d: VigilanteDeps, listo: () => boolean): Promise<void> {
  const { parar } = arrancarVigilante(d);
  const fin = Date.now() + 4000;
  while (!listo() && Date.now() < fin) await new Promise((r) => setTimeout(r, 10));
  // Un respiro para que termine de escribir lo que estuviera escribiendo.
  await new Promise((r) => setTimeout(r, 50));
  parar();
}

{
  const dir = nuevoDir();
  const trabajadas: bigint[] = [];
  await unaPasada(
    deps25(dir, { trabajar: async (id) => (trabajadas.push(id), true) }, [t25(0n)]),
  );
  const e = JSON.parse(readFileSync(join(dir, 'vigilante.json'), 'utf8')) as { visto25?: string; pendientes: string[] };
  check('una tarea nueva del v2.5 se ve y se trabaja con su número de fuera', trabajadas.join() === '1000000000', trabajadas.join());
  check('  y la marca del v2.5 avanza aparte', e.visto25 === '0' && e.pendientes.length === 0, JSON.stringify(e));
}
{
  const dir = nuevoDir();
  const trabajadas: bigint[] = [];
  await unaPasada(
    deps25(dir, { trabajar: async (id) => (trabajadas.push(id), true) }, [t25(0n, { acceptBy: AHORA - 10n })]),
  );
  check('pasado su tiempo de aceptar sin aceptarla, no se trabaja y se suelta', trabajadas.length === 0 && leerEstado(dir).pendientes.length === 0);
}
{
  const dir = nuevoDir();
  const aceptadas: bigint[] = [];
  await unaPasada(
    deps25(dir, { enCurso: () => true, aceptar: async (id) => void aceptadas.push(id) }, [t25(0n, { acceptBy: AHORA + 300n })]),
  );
  check('trabajándose y con su tiempo de aceptar acabándose, se acepta', aceptadas.join() === '1000000000', aceptadas.join());
  check('  y sigue pendiente hasta que se entregue', leerEstado(dir).pendientes.includes('1000000000'));
}
{
  const dir = nuevoDir();
  const aceptadas: bigint[] = [];
  await unaPasada(deps25(dir, { enCurso: () => true, aceptar: async (id) => void aceptadas.push(id) }, [t25(0n)]));
  check('con tiempo de sobra no se gasta una transacción en aceptar', aceptadas.length === 0);
}
{
  const dir = nuevoDir();
  const aceptadas: bigint[] = [];
  await unaPasada(
    deps25(dir, { enCurso: () => true, aceptar: async (id) => void aceptadas.push(id) }, [
      t25(0n, { estado: EstadoV2_5.Aceptada, acceptBy: AHORA + 60n }),
    ]),
  );
  check('una ya aceptada no se vuelve a aceptar', aceptadas.length === 0);
}
{
  const dir = nuevoDir();
  const liberadas: bigint[] = [];
  const entregada = t25(0n, { estado: EstadoV2_5.Entregada, deliveredAt: AHORA - 90_000n, reviewWindow: 86_400 });
  await hasta(
    deps25(dir, { liberar: async (ts) => (ts.forEach((t) => liberadas.push(t.id)), true) }, [entregada]),
    () => liberadas.length > 0,
  );
  const e = JSON.parse(readFileSync(join(dir, 'vigilante.json'), 'utf8')) as { porCobrar?: string[] };
  check('entregada y pasada su revisión, se libera', liberadas.join() === '1000000000', liberadas.join());
  check('  y sale de la lista de por cobrar', (e.porCobrar ?? []).length === 0, JSON.stringify(e));
}
{
  const dir = nuevoDir();
  const liberadas: bigint[] = [];
  const enRevision = t25(0n, { estado: EstadoV2_5.Entregada, deliveredAt: AHORA - 3600n, reviewWindow: 86_400 });
  await hasta(
    deps25(dir, { liberar: async (ts) => (ts.forEach((t) => liberadas.push(t.id)), true) }, [enRevision]),
    () => {
      try {
        return (JSON.parse(readFileSync(join(dir, 'vigilante.json'), 'utf8')) as { porCobrar?: string[] }).porCobrar?.length === 1;
      } catch {
        return false;
      }
    },
  );
  check('dentro de su revisión no se libera, pero queda apuntada', liberadas.length === 0);
}
{
  const dir = nuevoDir();
  const liberadas: bigint[] = [];
  const entregada = t25(0n, { estado: EstadoV2_5.Entregada, deliveredAt: AHORA - 90_000n });
  let intentos = 0;
  await hasta(
    deps25(dir, { liberar: async () => (intentos++, false) }, [entregada]),
    () => intentos > 0,
  );
  const e = JSON.parse(readFileSync(join(dir, 'vigilante.json'), 'utf8')) as { porCobrar?: string[] };
  check('si liberar no compensa todavía, se queda apuntada para luego', intentos === 1 && (e.porCobrar ?? []).includes('1000000000') && liberadas.length === 0, JSON.stringify(e));
}

for (const d of temporales) rmSync(d, { recursive: true, force: true });
console.log(fallos === 0 ? '\n✅ todo bien\n' : `\n❌ ${fallos} fallos\n`);
process.exit(fallos === 0 ? 0 : 1);
