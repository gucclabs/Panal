/**
 * Pruebas del escrow v2.5 en el bot: buzón, índice y API (`src/v2_5.ts`).
 *
 *   npx tsx scripts/test-v2-5.ts     (o: pnpm test:v2-5)
 *
 * HERMÉTICO: sin red, sin cadena. Los eventos y las tareas se escriben aquí.
 *
 * Lo que se protege:
 *   1. La numeración: fuera de la cadena, lo del v2.5 va desde mil millones.
 *      El índice desplaza los números al leer los eventos, el buzón separa los
 *      dos tablones por número, y la API no enseña lo del v2.5 a quien no lo
 *      pide (la web, la app y los agentes publicados lo leerían como del v2).
 *   2. Que los eventos que pide el indexador son los del contrato desplegado:
 *      se comparan con el ABI generado del SDK. Una firma distinta no da
 *      error: da cero eventos, en silencio.
 *   3. Que lo que el índice cuenta de cada agente imite a la reputación v2.5:
 *      completado si cobró algo, nota si la hay, «no entregó» solo si venció.
 *   4. Que cada tablón lleve lo suyo: topes, categorías y saldos por cobrar.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress, keccak256, toBytes, toEventSelector, type AbiEvent, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { IndexStore, type IndexedEvent } from '../src/indexer-store.js';
import { createIndexServer } from '../src/indexer-http.js';
import { NAMES_EVENTS, REGISTRY_EVENTS, TABLON_EVENTS, desplazarV2_5 } from '../src/indexer.js';
import { createBuzonServer, pruebasSignMessage } from '../src/buzon.js';
import { BuzonStore } from '../src/buzon-store.js';
import { NATIVE_CURRENCY, TaskStatus, type Task, type TrabajoTablon } from '../src/chain.js';
import {
  BANS_EVENTS,
  CierreV2_5,
  ESCROW_V2_5_EVENTS,
  PRICES_EVENTS,
  PRIMER_ID_V2_5,
  StatusV2_5,
  V2_5_ANTERIOR,
  V2_5_MAINNET,
  comoTareaV2,
  esDelV2_5,
  escrowV2_5Abi,
  idDelV2_5,
  idEnLaCadena,
  tablonV2_5Abi,
  type TareaV2_5,
} from '../src/v2_5.js';
// Los ABI generados de los contratos desplegados, los mismos que usa el SDK.
import {
  panalBansAbi,
  panalEscrowV2_5Abi,
  panalNamesV2Abi,
  panalPricesAbi,
  panalRegistryV3Abi,
  panalTablonV2_5Abi,
} from '../../sdk/src/v2_5-abi.js';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`✅ ${label}${detail ? `: ${detail}` : ''}`);
  else {
    failures += 1;
    console.error(`❌ ${label}${detail ? `: ${detail}` : ''}`);
  }
}

const PANAL = '0x2e2e44e7fa6178822d4397299f719e89d1a67777';
const USDC = V2_5_MAINNET.usdc.toLowerCase();
const TABLON_V2 = '0x2cfc6803e269fa9bf728e202736a7bc0547ae149';
const TABLON_V25 = V2_5_MAINNET.tablon.toLowerCase();
const CLIENTE = '0xaaaa000000000000000000000000000000000001';
const AGENTE = '0xbbbb000000000000000000000000000000000002';
const OTRO = '0xcccc000000000000000000000000000000000003';
const CERO32 = `0x${'0'.repeat(64)}` as Hex;
const G = (n: number | bigint): string => idDelV2_5(BigInt(n)).toString();

// ── 1. La numeración y la forma del v2 ────────────────────────────────────

console.log('\nla numeración');
check('el 5 del v2.5 es el 1.000.000.005', idDelV2_5(5n) === 1_000_000_005n && PRIMER_ID_V2_5 === 1_000_000_000n);
check('y vuelve a ser el 5 en la cadena', idEnLaCadena(1_000_000_005n) === 5n);
check('los del v2 no se tocan', idEnLaCadena(140n) === 140n && !esDelV2_5(140n) && esDelV2_5(1_000_000_000n));

console.log('\nuna tarea del v2.5 con la forma del v2, para el buzón');
const t25 = (status: StatusV2_5, closeReason = CierreV2_5.None): TareaV2_5 => ({
  client: getAddress(CLIENTE),
  deadline: 2_000_000_000n,
  status,
  closeReason,
  workerShareBps: 0,
  worker: getAddress(AGENTE),
  acceptBy: 1_999_000_000n,
  reviewWindow: 72 * 3600,
  currency: getAddress(USDC),
  deliveredAt: 0n,
  feeBps: 250,
  amount: 5_000_000n,
  createdAt: 1_990_000_000n,
  disputedAt: 0n,
  taskHash: keccak256(toBytes('encargo')),
  resultHash: CERO32,
});
check('aceptada → Open (todavía se entrega)', comoTareaV2(t25(StatusV2_5.Accepted)).status === TaskStatus.Open);
check('entregada → Delivered', comoTareaV2(t25(StatusV2_5.Delivered)).status === TaskStatus.Delivered);
check('en disputa → Disputed', comoTareaV2(t25(StatusV2_5.Disputed)).status === TaskStatus.Disputed);
check('vencida → Cancelled', comoTareaV2(t25(StatusV2_5.Closed, CierreV2_5.Expired)).status === TaskStatus.Cancelled);
check('rechazada → Cancelled', comoTareaV2(t25(StatusV2_5.Closed, CierreV2_5.Rejected)).status === TaskStatus.Cancelled);
check('por acuerdo → Completed', comoTareaV2(t25(StatusV2_5.Closed, CierreV2_5.Mutual)).status === TaskStatus.Completed);
check('la moneda viaja: USDC', comoTareaV2(t25(StatusV2_5.Open)).currency.toLowerCase() === USDC);

// ── 2. Los eventos y los ABI son los del contrato ────────────────────────

console.log('\nlos eventos que pide el indexador son los del contrato desplegado');
const selectores = (abi: readonly { type: string }[]): Set<string> =>
  new Set(abi.filter((x): x is AbiEvent => x.type === 'event').map((e) => toEventSelector(e)));
const cubre = (pedidos: readonly AbiEvent[], abi: readonly { type: string }[]): string[] => {
  const del = selectores(abi);
  return pedidos.filter((e) => !del.has(toEventSelector(e))).map((e) => e.name);
};
check('escrow v2.5', cubre(ESCROW_V2_5_EVENTS, panalEscrowV2_5Abi).length === 0, cubre(ESCROW_V2_5_EVENTS, panalEscrowV2_5Abi).join(','));
check('PanalBans', cubre(BANS_EVENTS, panalBansAbi).length === 0);
check('PanalPrices', cubre(PRICES_EVENTS, panalPricesAbi).length === 0);
check('PanalRegistryV3', cubre(REGISTRY_EVENTS, panalRegistryV3Abi).length === 0, cubre(REGISTRY_EVENTS, panalRegistryV3Abi).join(','));
check('PanalNamesV2, con Asignado', cubre(NAMES_EVENTS, panalNamesV2Abi).length === 0 && NAMES_EVENTS.some((e) => e.name === 'Asignado'), cubre(NAMES_EVENTS, panalNamesV2Abi).join(','));
{
  // El tablón v2.5 se lee con los eventos del v2: los que emite tienen que estar.
  const delV25 = panalTablonV2_5Abi.filter((x): x is AbiEvent => x.type === 'event');
  const pedidos = new Set(TABLON_EVENTS.map((e) => toEventSelector(e)));
  const fuera = delV25.filter((e) => !pedidos.has(toEventSelector(e)) && !/^Ownership/.test(e.name)).map((e) => e.name);
  check('el tablón v2.5 no emite nada que el índice no lea (salvo la propiedad)', fuera.length === 0, fuera.join(','));
}
{
  const campos = (abi: readonly unknown[], fn: string): string =>
    JSON.stringify(
      (
        (abi as { type: string; name?: string; outputs?: { components?: { name: string; type: string }[] }[] }[]).find(
          (x) => x.type === 'function' && x.name === fn,
        )?.outputs?.[0]?.components ?? []
      ).map((c) => `${c.type} ${c.name}`),
    );
  check('getTask del bot = el del contrato, campo a campo', campos(escrowV2_5Abi, 'getTask') === campos(panalEscrowV2_5Abi, 'getTask'));
  check('getJob del bot = el del tablón v2.5', campos(tablonV2_5Abi, 'getJob') === campos(panalTablonV2_5Abi, 'getJob'));
}

console.log('\nel índice desplaza los números del v2.5 al leerlos');
{
  const a: Record<string, string | number | boolean> = { taskId: '5', worker: AGENTE };
  desplazarV2_5('escrow25', a);
  check('taskId del escrow v2.5', a['taskId'] === G(5));
  const j: Record<string, string | number | boolean> = { jobId: '2', escrowTaskId: '7', agent: AGENTE };
  desplazarV2_5('tablon25', j);
  check('jobId y escrowTaskId del tablón v2.5', j['jobId'] === G(2) && j['escrowTaskId'] === G(7));
  const v2: Record<string, string | number | boolean> = { taskId: '5' };
  desplazarV2_5('escrow', v2);
  check('los del v2, tal cual', v2['taskId'] === '5');
}

// ── 3. El índice ──────────────────────────────────────────────────────────

let n = 0;
function ev(contract: IndexedEvent['contract'], event: string, args: Record<string, string | number | boolean>, ts = 1_790_000_000): IndexedEvent {
  n += 1;
  return {
    id: `0x${n.toString(16).padStart(64, '0')}-0`,
    contract,
    event,
    blockNumber: n,
    logIndex: 0,
    txHash: `0x${n.toString(16).padStart(64, '0')}`,
    ts: ts + n,
    args,
  };
}
const creada = (id: number, worker = AGENTE, client = CLIENTE, currency = USDC, amount = '5000000') =>
  ev('escrow25', 'TaskCreated', { taskId: G(id), client, worker, currency, amount, taskHash: CERO32, deadline: '2000000000', acceptBy: '1999000000', reviewWindow: 259200 });
const cerrada = (id: number, reason: CierreV2_5, workerPaid: string, fee: string, clientRefund: string, rating: number) =>
  ev('escrow25', 'TaskClosed', { taskId: G(id), reason, workerPaid, fee, clientRefund, rating });

const dir = mkdtempSync(join(tmpdir(), 'panal-v25-'));
const store = new IndexStore(dir, PANAL, TABLON_V2, { tablon: TABLON_V25, usdc: USDC });

console.log('\nun encargo del v2.5 de principio a fin, en USDC');
store.append([
  // Uno del v2 con el mismo número en la cadena (1): no se pisan.
  ev('escrow', 'TaskCreated', { taskId: '1', client: CLIENTE, worker: AGENTE, currency: NATIVE_CURRENCY, amount: '1000000000000000000', taskHash: CERO32, deadline: '2000000000' }),
  creada(1),
  ev('escrow25', 'TaskAccepted', { taskId: G(1), worker: AGENTE }),
  ev('escrow25', 'TaskDelivered', { taskId: G(1), worker: AGENTE, resultHash: '0xdead' }),
  cerrada(1, CierreV2_5.Approved, '4875000', '125000', '0', 5),
]);
{
  const t = store.task(G(1));
  check('existe con su número de fuera', !!t, JSON.stringify(t));
  check('y el 1 del v2 sigue siendo otro', store.task('1')?.coin === 'MON' && t?.coin === 'USDC');
  check('aceptada, entregada y aprobada → completed con su nota', t?.status === 'completed' && t.rating === 5 && t.cierre === 'Approved');
  check('guarda cuándo la aceptó', typeof t?.acceptedTs === 'number');
  const ag = store.agentStats().find((a) => a.address === AGENTE)!;
  check('cuenta para el agente: 1 completada (más la del v2 abierta)', ag.completed === 1 && ag.tasks === 2, JSON.stringify({ c: ag.completed, t: ag.tasks }));
  check('su volumen, en USDC (lo cobrado, sin la comisión)', ag.volume['USDC'] === '4875000', JSON.stringify(ag.volume));
  // Hoy: las cifras diarias solo cubren los últimos días.
  const ahora = Math.floor(Date.now() / 1000);
  store.append([
    ev('escrow25', 'TaskCreated', { taskId: G(50), client: CLIENTE, worker: AGENTE, currency: USDC, amount: '2500000', taskHash: CERO32, deadline: '2000000000', acceptBy: '1999000000', reviewWindow: 259200 }, ahora - 1_000),
  ]);
  const movido = store.dailyStats(2).reduce((s, d) => s + BigInt(d.usdcMoved), 0n);
  check('el USDC movido entra en las cifras diarias, aparte del MON', movido === 2_500_000n, String(movido));
}

console.log('\nlos cierres sin entrega');
store.append([
  creada(2),
  cerrada(2, CierreV2_5.Expired, '0', '0', '5000000', 0),
  creada(3),
  cerrada(3, CierreV2_5.Rejected, '0', '0', '5000000', 0),
  creada(4, '0x0000000000000000000000000000000000000000'),
  cerrada(4, CierreV2_5.Cancelled, '0', '0', '5000000', 0),
]);
{
  const ag = store.agentStats().find((a) => a.address === AGENTE)!;
  check('vencida sin entrega: no entregó', ag.notDelivered === 1, String(ag.notDelivered));
  check('rechazada a tiempo: no cuenta como no entregada', store.task(G(3))?.status === 'cancelled' && ag.notDelivered === 1);
  check('las tres, canceladas', [2, 3, 4].every((i) => store.task(G(i))?.status === 'cancelled'));
}

console.log('\nuna abierta a cualquiera, cogida');
store.append([creada(5, '0x0000000000000000000000000000000000000000'), ev('escrow25', 'TaskAccepted', { taskId: G(5), worker: OTRO })]);
{
  const t = store.task(G(5));
  check('al cogerla queda con su trabajador', t?.worker === OTRO && typeof t.claimedTs === 'number');
  check('y la encuentra en sus tareas', store.tasksOf(OTRO, { v: 'v2_5' }).some((x) => x.taskId === G(5)));
}

console.log('\ndisputas: decisión de los jueces');
store.append([
  creada(6),
  ev('escrow25', 'TaskDelivered', { taskId: G(6), worker: AGENTE, resultHash: '0xbeef' }),
  ev('escrow25', 'TaskDisputed', { taskId: G(6), openedBy: CLIENTE, reasonHash: CERO32 }),
  ev('escrow25', 'RulingProposed', { taskId: G(6), by: OTRO, workerShareBps: 0, rating: 2, decisionHash: CERO32, finalAt: 1_800_000_000 }),
]);
{
  const t = store.task(G(6));
  check('en disputa, con la decisión propuesta', t?.status === 'disputed' && t.ruling?.workerShareBps === 0 && t.ruling.finalAt === 1_800_000_000);
  const antes = store.agentStats().find((a) => a.address === AGENTE)!;
  store.append([ev('escrow25', 'DisputeResolved', { taskId: G(6), workerShareBps: 0, rating: 2, decisionHash: CERO32 }), cerrada(6, CierreV2_5.AutoArbitrated, '0', '0', '5000000', 2)]);
  const despues = store.agentStats().find((a) => a.address === AGENTE)!;
  check('todo al cliente: no es una completada', despues.completed === antes.completed);
  check('pero su nota cuenta, como en la reputación v2.5', despues.ratingCount === antes.ratingCount + 1);
  check('y la disputa quedó contada', despues.disputes >= 1);
  check('lo devuelto al cliente', store.task(G(6))?.clientRefunded === '5000000');
}

console.log('\nla API no enseña el v2.5 a quien no lo pide');
{
  const solo2 = store.tasksOf(CLIENTE);
  check('por defecto, solo las del v2', solo2.every((t) => !esDelV2_5(BigInt(t.taskId))) && solo2.length === 1, solo2.map((t) => t.taskId).join(','));
  const solo25 = store.tasksOf(CLIENTE, { v: 'v2_5' });
  check('v2_5: solo las del v2.5', solo25.length > 0 && solo25.every((t) => esDelV2_5(BigInt(t.taskId))));
  const todas = store.tasksOf(CLIENTE, { v: 'all', limit: 100 });
  check('all: las dos', todas.length === solo2.length + solo25.length);
}

console.log('\nsuspensiones y precios');
store.append([
  ev('bans', 'AccountSuspended', { account: OTRO, reasonHash: '0x01' }),
  ev('prices', 'PricesSet', { agent: AGENTE, currency: USDC, amounts: JSON.stringify(['5000000', '20000000']) }),
  ev('prices', 'PricesSet', { agent: AGENTE, currency: NATIVE_CURRENCY, amounts: JSON.stringify(['1000000000000000000']) }),
]);
check('suspendida', store.estaSuspendido(OTRO) && !store.estaSuspendido(AGENTE));
check('sus precios en USDC, de menor a mayor', JSON.stringify(store.preciosDe(AGENTE)[USDC]) === '["5000000","20000000"]', JSON.stringify(store.preciosDe(AGENTE)));
store.append([
  ev('bans', 'AccountReinstated', { account: OTRO, reasonHash: '0x02' }),
  ev('prices', 'PricesSet', { agent: AGENTE, currency: NATIVE_CURRENCY, amounts: '[]' }),
]);
check('readmitida', !store.estaSuspendido(OTRO));
check('una lista vacía es «ya no cobro en esa moneda»', store.preciosDe(AGENTE)[NATIVE_CURRENCY] === undefined && !!store.preciosDe(AGENTE)[USDC]);

console.log('\nlos precios del V3 mandan sobre los del v2.5 de antes');
{
  const V3 = V2_5_MAINNET.prices.toLowerCase();
  const ANTES = V2_5_ANTERIOR.prices.toLowerCase();
  const p = (agent: string, amounts: string[], address?: string): IndexedEvent => ({
    ...ev('prices', 'PricesSet', { agent, currency: USDC, amounts: JSON.stringify(amounts) }),
    ...(address ? { address } : {}),
  });
  store.append([p(OTRO, ['3000000'])]);
  check('los guardados sin dirección (de antes) cuentan', store.preciosDe(OTRO)[USDC]?.[0] === '3000000');
  store.append([p(OTRO, ['4000000'], ANTES)]);
  check('mientras no publique en el V3, lo último del de antes', store.preciosDe(OTRO)[USDC]?.[0] === '4000000');
  store.append([p(OTRO, ['6000000'], V3)]);
  check('en cuanto publica en el V3, el V3', store.preciosDe(OTRO)[USDC]?.[0] === '6000000');
  store.append([p(OTRO, ['1'], ANTES)]);
  check('y lo que llegue después al de antes ya no cuenta', store.preciosDe(OTRO)[USDC]?.[0] === '6000000', JSON.stringify(store.preciosDe(OTRO)));
  store.append([p(OTRO, [], V3)]);
  check('vaciarlos en el V3 los vacía, aunque el de antes tenga', store.preciosDe(OTRO)[USDC] === undefined);
}

console.log('\nPanalNamesV2: los migrados conservan su historia');
{
  const MIGRADO = '0xdddd000000000000000000000000000000000004';
  const RESERVA = '0xeeee000000000000000000000000000000000005';
  store.append([ev('names', 'Reclamado', { hash: CERO32, nombre: 'lint', dueno: MIGRADO, pagado: '0' }, 1_700_000_000)]);
  const antes = store.nombre(MIGRADO);
  store.append([ev('names', 'Asignado', { hash: CERO32, nombre: 'lint', a: MIGRADO })]);
  check('el migrado sigue «reclamado» y con su fecha', JSON.stringify(store.nombre(MIGRADO)) === JSON.stringify(antes) && antes?.origen === 'reclamado');
  store.append([ev('names', 'Asignado', { hash: CERO32, nombre: 'panal', a: RESERVA })]);
  check('uno reservado que se entrega es «recibido»', store.nombre(RESERVA)?.nombre === 'panal' && store.nombre(RESERVA)?.origen === 'recibido');
}

console.log('\ncada tablón, lo suyo');
store.append([
  ev('tablon', 'CapsChanged', { currency: NATIVE_CURRENCY, perJob: '1', total: '2' }),
  ev('tablon25', 'CapsChanged', { currency: USDC, perJob: '5770000', total: '11550000' }),
  ev('tablon25', 'JobPosted', { jobId: G(0), client: CLIENTE, category: 1, currency: USDC, amount: '5000000', mode: 0, campaignId: CERO32 }),
  creada(9, AGENTE, TABLON_V25),
  ev('tablon25', 'JobAssigned', { jobId: G(0), agent: AGENTE, escrowTaskId: G(9), price: '5000000', byClient: false }),
  ev('tablon25', 'Credited', { client: CLIENTE, currency: USDC, amount: '700000' }),
  ev('tablon25', 'CategoriesSet', { agent: AGENTE, categories: JSON.stringify([1, 2]) }),
]);
{
  const c2 = store.configTablon('v2');
  const c25 = store.configTablon('v2_5');
  check('los topes del v2.5 no pisan los del v2', !!c2.caps[NATIVE_CURRENCY] && !c2.caps[USDC] && c25.caps[USDC]?.perJob === '5770000', JSON.stringify({ c2: c2.caps, c25: c25.caps }));
  check('la tarea del tablón v2.5 la encuentra su cliente de verdad', store.task(G(9))?.realClient === CLIENTE && store.tasksOf(CLIENTE, { v: 'v2_5' }).some((t) => t.taskId === G(9)));
  check(
    'lo que debe el tablón v2.5, solo en el v2.5',
    store.porCobrarDe(CLIENTE, 'v2_5')[USDC] === '700000' && Object.keys(store.porCobrarDe(CLIENTE, 'v2')).length === 0,
    JSON.stringify(store.porCobrarDe(CLIENTE, 'v2_5')),
  );
  check('las categorías, por tablón', JSON.stringify(store.categoriasDe(AGENTE, 'v2_5')) === '[1,2]' && store.categoriasDe(AGENTE, 'v2').length === 0);
  check('el encargo del v2.5 está en su lista, no en la del v2', store.jobs({ v: 'v2_5', limit: 10 }).some((j) => j.jobId === G(0)) && !store.jobs({ limit: 10 }).some((j) => j.jobId === G(0)));
}

console.log('\nal reiniciar, sale lo mismo');
{
  const otra = new IndexStore(dir, PANAL, TABLON_V2, { tablon: TABLON_V25, usdc: USDC });
  check('la tarea', JSON.stringify(otra.task(G(1))) === JSON.stringify(store.task(G(1))));
  check('las suspensiones y los precios', !otra.estaSuspendido(OTRO) && JSON.stringify(otra.preciosDe(AGENTE)) === JSON.stringify(store.preciosDe(AGENTE)));
}

// ── 4. La API ─────────────────────────────────────────────────────────────

async function api(): Promise<void> {
  console.log('\nla API');
  const server = createIndexServer({ store, allowLocalhostOrigin: true });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const dirS = server.address();
  const base = `http://127.0.0.1:${typeof dirS === 'object' && dirS ? dirS.port : 0}`;
  try {
    const de = async (ruta: string) => {
      const r = await fetch(`${base}${ruta}`);
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const sin = await de(`/index/tasks?address=${CLIENTE}`);
    const ids = (sin.body.tasks as { taskId: string }[]).map((t) => t.taskId);
    check('/index/tasks sin v: solo el v2', ids.length === 1 && ids[0] === '1', ids.join(','));
    const con = await de(`/index/tasks?address=${CLIENTE}&v=2.5`);
    check('/index/tasks?v=2.5: el v2.5', (con.body.tasks as { taskId: string }[]).every((t) => esDelV2_5(BigInt(t.taskId))));
    check('un v que no existe es un 400', (await de(`/index/tasks?address=${CLIENTE}&v=3`)).status === 400);
    const precios = await de(`/index/prices?agent=${AGENTE}`);
    check('/index/prices', JSON.stringify((precios.body.prices as Record<string, string[]>)[USDC]) === '["5000000","20000000"]');
    const bans = await de('/index/bans');
    check('/index/bans: nadie suspendido ahora', bans.status === 200 && bans.body.count === 0);
    const cfg = await de('/index/board/config?v=2.5');
    check('/index/board/config?v=2.5: sus topes', !!(cfg.body.caps as Record<string, unknown>)[USDC]);
    const job = await de(`/index/board/job?id=${G(0)}`);
    check('/index/board/job de un encargo del v2.5, con su tarea', (job.body.task as { taskId?: string } | null)?.taskId === G(9));
  } finally {
    server.close();
  }
}

// ── 5. El buzón ───────────────────────────────────────────────────────────

async function buzon(): Promise<void> {
  console.log('\nel buzón separa los dos tablones por número');
  const cliente = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  const agente = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const V2 = getAddress(TABLON_V2);
  const V25 = getAddress(TABLON_V25);
  const BRIEF = 'El encargo del tablón v2.5';
  const trabajo = (escrowTaskId: bigint): TrabajoTablon => ({
    client: cliente.address,
    state: 1,
    agent: agente.address,
    taskHash: keccak256(toBytes(BRIEF)),
    advertHash: CERO32,
    escrowTaskId,
  });
  const TRABAJOS: Record<string, TrabajoTablon> = { '1': trabajo(1n), [G(1)]: trabajo(idDelV2_5(7n)) };
  const TAREAS: Record<string, Task> = {
    [G(7)]: {
      client: V25,
      worker: agente.address,
      amount: 5_000_000n,
      taskHash: keccak256(toBytes(BRIEF)),
      resultHash: keccak256(toBytes('la entrega')),
      deadline: 2_000_000_000n,
      createdAt: 1_990_000_000n,
      status: TaskStatus.Disputed,
      currency: getAddress(USDC),
    },
  };
  const pedidos: bigint[] = [];
  const bdir = mkdtempSync(join(tmpdir(), 'panal-v25-buzon-'));
  const server = createBuzonServer({
    store: new BuzonStore(bdir),
    fetchTask: async (id) => {
      const t = TAREAS[id.toString()];
      if (!t) throw new Error('no existe');
      return t;
    },
    fetchDisputedAt: async () => BigInt(Math.floor(Date.now() / 1000) - 60),
    fetchAgent: async () => ({ owner: agente.address, metadataURI: 'X · y · z', pricePerTask: 1n, active: true, registeredAt: 1n, currency: NATIVE_CURRENCY }),
    contratos: { escrow: getAddress(V2_5_MAINNET.escrow), registry: getAddress(V2_5_MAINNET.escrow), token: getAddress(PANAL) },
    simboloDe: () => 'USDC',
    indexer: 'https://api.panal.lat',
    allowLocalhostOrigin: true,
    tablon: V2,
    tablonV2_5: V25,
    fetchArbitros: async () => [],
    fetchJob: async (id) => {
      pedidos.push(id);
      const j = TRABAJOS[id.toString()];
      if (!j) throw new Error('InvalidJob');
      return j;
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const dirS = server.address();
  const base = `http://127.0.0.1:${typeof dirS === 'object' && dirS ? dirS.port : 0}/buzon`;
  try {
    const brief = (tablon: string, id: string) =>
      fetch(`${base}/${tablon}/brief/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://panal.lat' },
        body: JSON.stringify({ brief: BRIEF }),
      });
    const ok = await brief(V25, G(1));
    check('el encargo del tablón v2.5 entra por su dirección y su número', ok.status === 200, `status=${ok.status}`);
    check('y se comprueba con ese número', pedidos.includes(idDelV2_5(1n)));
    pedidos.length = 0;
    const mal1 = await brief(V25, '1');
    check('un número del v2 por la ruta del v2.5: 404, sin preguntar a la cadena', mal1.status === 404 && pedidos.length === 0, `status=${mal1.status}`);
    const mal2 = await brief(V2, G(1));
    check('y uno del v2.5 por la del v2, igual', mal2.status === 404 && pedidos.length === 0, `status=${mal2.status}`);
    const v2ok = await brief(V2, '1');
    check('el tablón v2 sigue como estaba', v2ok.status === 200, `status=${v2ok.status}`);

    console.log('\nel cliente de verdad de una tarea del tablón v2.5');
    const leer = async (job?: string) => {
      const e = Math.floor(Date.now() / 1000) + 60;
      return fetch(`${base}/${agente.address}/pruebas/${G(7)}${job ? `?job=${job}` : ''}`, {
        headers: {
          'x-panal-address': cliente.address,
          'x-panal-signature': await cliente.signMessage({ message: pruebasSignMessage(idDelV2_5(7n), e) }),
          'x-panal-expira': String(e),
        },
      });
    };
    const conJob = await leer(G(1));
    check('con su encargo del v2.5, el cliente lee las pruebas', conJob.status === 200, `status=${conJob.status}`);
    const sinJob = await leer();
    check('sin decir el encargo, el contrato no es nadie', sinJob.status === 403, `status=${sinJob.status}`);
    const otroJob = await leer('1');
    check('con un encargo que no es el de esa tarea, tampoco', otroJob.status === 403, `status=${otroJob.status}`);
  } finally {
    server.close();
    rmSync(bdir, { recursive: true, force: true });
  }
}

await api();
await buzon();
rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} fallo(s)`);
  process.exit(1);
}
console.log('\nTodo bien.');
