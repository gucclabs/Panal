/**
 * Pruebas del escrow v2.5 y su tablón en el SDK.
 *
 *   npx tsx test/v2_5.test.ts
 *
 * HERMÉTICO: no toca la red. La cadena y el buzón se sustituyen por dobles.
 *
 * Lo que se protege:
 *   1. La numeración: fuera de la cadena, lo del v2.5 va desde mil millones, y
 *      en la cadena se manda SIEMPRE el número de verdad, al contrato de su
 *      versión. Equivocarse aquí es firmar en el escrow equivocado.
 *   2. Que una tarea del v2.5 se lea con la forma del v2 sin mentir: aceptada
 *      sigue abierta, cerrada sin entrega es cancelada.
 *   3. Que contratar en USDC apruebe el importe exacto al escrow v2.5 y lea el
 *      número de la tarea del evento, no del contador.
 *   4. Que el tablón v2.5 devuelva la tarea de su encargo con el número de
 *      fuera, y nunca la tarea 0 de alguien cuando el encargo no se asignó.
 */

import { encodeAbiParameters, encodeEventTopics, keccak256, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createPanalClient } from '../src/client.js';
import { NATIVE_CURRENCY } from '../src/chains.js';
import { TaskStatus } from '../src/types.js';
import { EstadoTablon, ModoTablon, encargoDeLaCadena, problemaAlPublicar } from '../src/tablon-reglas.js';
import { panalEscrowV2_5Abi, panalTablonV2_5Abi } from '../src/v2_5-abi.js';
import {
  CierreV2_5,
  EstadoV2_5,
  PRIMER_ID_V2_5,
  V2_5_ANTERIOR,
  V2_5_MAINNET,
  comoTask,
  esDelV2_5,
  finDeLaRevision,
  idDelV2_5,
  idEnLaCadena,
  mediaDe,
  tareaV2_5DeLaCadena,
  versionDe,
  type TareaV2_5,
} from '../src/v2_5.js';

let fallos = 0;
const check = (nombre: string, ok: boolean, detalle = ''): void => {
  console.log(`${ok ? '✅' : '❌'} ${nombre}${ok ? '' : ` — ${detalle}`}`);
  if (!ok) fallos++;
};
const lanza = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

// Claves de prueba conocidas (las de Hardhat/Anvil). Nunca tienen fondos reales.
const yo = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const agente = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;
const CERO32 = `0x${'0'.repeat(64)}` as Hex;
const ahora = BigInt(Math.floor(Date.now() / 1000));
const V2_ESCROW = '0xe138A9A492CFe27A13f8b7A6D312DA831791bCe9';
const mismo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

console.log('\nla numeración');
check('el primero del v2.5 es mil millones', idDelV2_5(0n) === PRIMER_ID_V2_5 && PRIMER_ID_V2_5 === 1_000_000_000n);
check('el 5 del v2.5 es el 1.000.000.005', idDelV2_5(5n) === 1_000_000_005n);
check('y vuelve a ser el 5 en la cadena', idEnLaCadena(1_000_000_005n) === 5n);
check('un número del v2 se queda como está', idEnLaCadena(140n) === 140n && !esDelV2_5(140n));
check('versionDe', versionDe(999_999_999n) === 'v2' && versionDe(1_000_000_000n) === 'v2_5');

console.log('\nuna tarea del v2.5 con la forma del v2');
const tarea = (estado: EstadoV2_5, cierre = CierreV2_5.Ninguno, extra: Partial<TareaV2_5> = {}): TareaV2_5 => ({
  id: idDelV2_5(3n),
  client: yo.address,
  worker: agente,
  currency: V2_5_MAINNET.usdc,
  amount: 10_000_000n,
  taskHash: keccak256(toBytes('el encargo')),
  resultHash: CERO32,
  estado,
  cierre,
  workerShareBps: 0,
  deadline: ahora + 86_400n,
  acceptBy: ahora + 3_600n,
  reviewWindow: 72 * 3600,
  createdAt: ahora,
  deliveredAt: 0n,
  disputedAt: 0n,
  ...extra,
});
check('abierta → Open', comoTask(tarea(EstadoV2_5.Abierta)).status === TaskStatus.Open);
check('aceptada → Open: todavía se puede entregar', comoTask(tarea(EstadoV2_5.Aceptada)).status === TaskStatus.Open);
check('entregada → Delivered', comoTask(tarea(EstadoV2_5.Entregada)).status === TaskStatus.Delivered);
check('en disputa → Disputed', comoTask(tarea(EstadoV2_5.EnDisputa)).status === TaskStatus.Disputed);
for (const c of [CierreV2_5.Cancelada, CierreV2_5.Vencida, CierreV2_5.Rechazada]) {
  check(`cerrada ${CierreV2_5[c]} → Cancelled`, comoTask(tarea(EstadoV2_5.Cerrada, c)).status === TaskStatus.Cancelled);
}
for (const c of [CierreV2_5.Aprobada, CierreV2_5.PorTiempo, CierreV2_5.Acuerdo, CierreV2_5.Arbitrada, CierreV2_5.ArbitradaAutonoma, CierreV2_5.DisputaCaducada]) {
  check(`cerrada ${CierreV2_5[c]} → Completed`, comoTask(tarea(EstadoV2_5.Cerrada, c)).status === TaskStatus.Completed);
}
check('conserva el número de fuera', comoTask(tarea(EstadoV2_5.Abierta)).id === idDelV2_5(3n));
check('sin entrega no hay fin de revisión', finDeLaRevision(tarea(EstadoV2_5.Aceptada)) === null);
check(
  'entregada: fin de revisión = entrega + su ventana',
  finDeLaRevision(tarea(EstadoV2_5.Entregada, CierreV2_5.Ninguno, { deliveredAt: 1000n, reviewWindow: 86_400 })) === 87_400n,
);
check('media con dos decimales', mediaDe({ tasksCompleted: 3n, ratingSum: 14n, ratingCount: 3n, disputesLost: 0n }) === 4.67);
check('sin notas, sin media', mediaDe({ tasksCompleted: 1n, ratingSum: 0n, ratingCount: 0n, disputesLost: 0n }) === null);

console.log('\nel ABI generado es el de los campos que se leen');
{
  const getTask = panalEscrowV2_5Abi.find((x) => x.type === 'function' && x.name === 'getTask');
  const campos = getTask && 'outputs' in getTask ? (getTask.outputs[0] as { components: { name: string }[] }).components.map((c) => c.name) : [];
  const leidos = ['client', 'worker', 'currency', 'amount', 'taskHash', 'resultHash', 'status', 'closeReason', 'workerShareBps', 'deadline', 'acceptBy', 'reviewWindow', 'createdAt', 'deliveredAt', 'disputedAt'];
  check('getTask trae todo lo que lee tareaV2_5DeLaCadena', leidos.every((c) => campos.includes(c)), campos.join(','));
  const getJob = panalTablonV2_5Abi.find((x) => x.type === 'function' && x.name === 'getJob');
  const job = getJob && 'outputs' in getJob ? (getJob.outputs[0] as { components: { name: string }[] }).components.map((c) => c.name) : [];
  check('getJob del tablón v2.5 trae reviewWindow y escrowTaskId', job.includes('reviewWindow') && job.includes('escrowTaskId'));
  const post = panalTablonV2_5Abi.find((x) => x.type === 'function' && x.name === 'post');
  const params = post && 'inputs' in post ? (post.inputs[0] as { components: { name: string }[] }).components.map((c) => c.name) : [];
  check('post del tablón v2.5 pide reviewWindow', params.includes('reviewWindow'));
}

console.log('\nun encargo del tablón v2.5');
{
  const crudo = (estado: EstadoTablon, agent: Address, escrowTaskId: bigint) => ({
    client: yo.address,
    mode: 0,
    state: estado,
    category: 1,
    experiencedOnly: false,
    relist: false,
    reviewWindow: 86_400,
    currency: NATIVE_CURRENCY,
    amount: 10n ** 18n,
    taskHash: CERO32,
    advertHash: CERO32,
    campaignId: CERO32,
    postedAt: 1n,
    expiresAt: 2n,
    workDuration: 3600n,
    applyWindow: 0n,
    chooseWindow: 0n,
    agent,
    escrowTaskId,
  });
  const asignado = encargoDeLaCadena(idDelV2_5(2n), crudo(EstadoTablon.Asignado, agente, 7n), 'v2_5');
  check('su tarea va con el número de fuera', asignado.escrowTaskId === idDelV2_5(7n), String(asignado.escrowTaskId));
  check('lleva su versión y su revisión', asignado.version === 'v2_5' && asignado.ventanaRevisionS === 86_400);
  const sinAsignar = encargoDeLaCadena(idDelV2_5(3n), crudo(EstadoTablon.Publicado, NATIVE_CURRENCY, 0n), 'v2_5');
  check('sin asignar, cero: no la tarea 0 del v2.5 de otro', sinAsignar.escrowTaskId === 0n);
  const retirado = encargoDeLaCadena(idDelV2_5(4n), crudo(EstadoTablon.Retirado, NATIVE_CURRENCY, 0n), 'v2_5');
  check('retirado sin asignar, también cero', retirado.escrowTaskId === 0n);
  const v2 = encargoDeLaCadena(9n, { ...crudo(EstadoTablon.Asignado, agente, 7n), attested: false, refundPending: false, workerShareBps: 0 });
  check('el del v2 no cambia', v2.escrowTaskId === 7n && v2.version === undefined);
}

console.log('\npublicar: la revisión a medida es solo del v2.5');
{
  const base = {
    encargo: 'Traduce esto',
    anuncio: 'Traducción corta',
    categoria: 1,
    importe: 10n ** 18n,
    plazoEntregaS: 3600,
    caducaEnS: 86_400,
    modo: ModoTablon.Inmediato,
  };
  check('en el v2 no se elige', /tablón v2\.5/.test(problemaAlPublicar({ ...base, ventanaRevisionS: 86_400 }) ?? ''));
  check('menos de 24 h no vale', /24 horas/.test(problemaAlPublicar({ ...base, version: 'v2_5', ventanaRevisionS: 3600 }) ?? ''));
  check('más de 7 días no vale', /7 días/.test(problemaAlPublicar({ ...base, version: 'v2_5', ventanaRevisionS: 8 * 86_400 }) ?? ''));
  check('48 h en el v2.5 sí', problemaAlPublicar({ ...base, version: 'v2_5', ventanaRevisionS: 48 * 3600 }) === null);
}

// ── El cliente, con la cadena de mentira ──────────────────────────────────

interface Lectura {
  address: string;
  functionName: string;
  args: readonly unknown[];
}
interface Escritura extends Lectura {
  value?: bigint;
  gas?: bigint;
}

/** Un crudo de `getTask` del escrow v2.5. */
const crudoV2_5 = (o: Partial<Record<string, unknown>> = {}) => ({
  client: yo.address,
  deadline: ahora + 86_400n,
  status: EstadoV2_5.Aceptada,
  closeReason: 0,
  workerShareBps: 0,
  worker: agente,
  acceptBy: ahora + 3600n,
  reviewWindow: 72 * 3600,
  currency: V2_5_MAINNET.usdc,
  deliveredAt: 0n,
  amount: 10_000_000n,
  createdAt: ahora,
  disputedAt: 0n,
  feeBps: 250,
  taskHash: keccak256(toBytes('el encargo')),
  resultHash: CERO32,
  ...o,
});

function montar(
  responder: (l: Lectura) => unknown,
  opciones: { cuenta?: typeof yo; logs?: { address: Address; topics: Hex[]; data: Hex }[]; v2_5?: null } = {},
) {
  const panal = createPanalClient({
    account: opciones.cuenta ?? yo,
    indexerUrl: null,
    buzonUrl: 'https://buzon.prueba/buzon',
    ...(opciones.v2_5 === null ? { v2_5: null } : {}),
  });
  const lecturas: Lectura[] = [];
  const escrituras: Escritura[] = [];
  const pc = panal.publicClient as unknown as Record<string, unknown>;
  pc.readContract = async (l: Lectura) => {
    lecturas.push(l);
    return responder(l);
  };
  pc.estimateContractGas = async () => 100_000n;
  pc.estimateFeesPerGas = async () => ({ maxFeePerGas: 100n });
  pc.getBalance = async () => 10n ** 21n;
  pc.waitForTransactionReceipt = async () => ({ status: 'success', logs: opciones.logs ?? [] });
  (panal.walletClient as unknown as Record<string, unknown>).writeContract = async (e: Escritura) => {
    escrituras.push(e);
    return '0xdef' as Hex;
  };
  return { panal, lecturas, escrituras };
}

console.log('\ngetTask elige el escrow por el número');
{
  const { panal, lecturas } = montar((l) =>
    l.functionName === 'getTask'
      ? crudoV2_5()
      : { client: yo.address, worker: agente, amount: 1n, taskHash: CERO32, resultHash: CERO32, deadline: 0n, createdAt: 0n, status: 1, currency: NATIVE_CURRENCY },
  );
  const t = await panal.getTask(idDelV2_5(5n));
  check('lee del escrow v2.5', mismo(lecturas[0]!.address, V2_5_MAINNET.escrow) && lecturas[0]!.functionName === 'getTask');
  check('con el número de la cadena', lecturas[0]!.args[0] === 5n, String(lecturas[0]!.args[0]));
  check('y vuelve con el de fuera y la forma del v2', t.id === idDelV2_5(5n) && t.status === TaskStatus.Open);
  await panal.getTask(5n);
  check('el 5 lo lee del escrow v2, con tasks()', mismo(lecturas[1]!.address, V2_ESCROW) && lecturas[1]!.functionName === 'tasks');
  const entera = await panal.getTaskV2_5(idDelV2_5(5n));
  check('getTaskV2_5 da la tarea entera', entera.estado === EstadoV2_5.Aceptada && entera.reviewWindow === 72 * 3600);
  check('getTaskV2_5 no acepta números del v2', /escrow v2/.test(await lanza(() => panal.getTaskV2_5(5n))));
}

console.log('\nsin v2.5, un número del v2.5 falla con un error que lo dice');
{
  const { panal } = montar(() => crudoV2_5(), { v2_5: null });
  check('v2_5: null lo apaga', panal.v2_5 === null);
  check('y getTask lo dice', /no está desplegado/.test(await lanza(() => panal.getTask(idDelV2_5(1n)))));
}

console.log('\nlo de siempre firma en el escrow v2.5 con el número de la cadena');
{
  const { panal, escrituras } = montar(() => crudoV2_5({ status: EstadoV2_5.Entregada, deliveredAt: ahora }));
  await panal.approveTask(idDelV2_5(5n), 5);
  const e = escrituras[0]!;
  check('approveAndRelease en el v2.5', mismo(e.address, V2_5_MAINNET.escrow) && e.functionName === 'approveAndRelease');
  check('con [5, 5]', e.args[0] === 5n && e.args[1] === 5);
  check('con el gas fijado', e.gas === 110_000n, String(e.gas));
  await panal.openDispute(idDelV2_5(5n), 'No es lo que pedí');
  const d = escrituras[1]!;
  check('la disputa lleva la huella del motivo', d.functionName === 'openDispute' && d.args[1] === keccak256(toBytes('No es lo que pedí')));
  await panal.openDispute(idDelV2_5(5n));
  check('sin motivo, la huella es cero', escrituras[2]!.args[1] === CERO32);
  check('no aprueba lo que no se ha entregado', /solo se aprueba lo entregado/.test(
    await lanza(() => montar(() => crudoV2_5()).panal.approveTask(idDelV2_5(5n), 5)),
  ));
}

console.log('\nquien trabaja: aceptar, rechazar, entregar');
{
  const trabajador = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const { panal, escrituras } = montar(() => crudoV2_5({ status: EstadoV2_5.Abierta, worker: trabajador.address }), { cuenta: trabajador });
  await panal.acceptTask(idDelV2_5(8n));
  check('acceptTask [8] en el v2.5', escrituras[0]!.functionName === 'acceptTask' && escrituras[0]!.args[0] === 8n);
  await panal.rejectTask(idDelV2_5(8n));
  check('rejectTask [8]', escrituras[1]!.functionName === 'rejectTask' && escrituras[1]!.args[0] === 8n);
  const { resultHash } = await panal.deliverResult(idDelV2_5(8n), 'el resultado');
  const e = escrituras[2]!;
  check('deliverResult [8, hash] en el v2.5', mismo(e.address, V2_5_MAINNET.escrow) && e.args[0] === 8n && e.args[1] === resultHash);
  const ajena = montar(() => crudoV2_5({ status: EstadoV2_5.Abierta }));
  check('no acepta la de otro', /Solo quien trabaja/.test(await lanza(() => ajena.panal.acceptTask(idDelV2_5(8n)))));
  check('ni la entrega', /no a ti/.test(await lanza(() => ajena.panal.deliverResult(idDelV2_5(8n), 'x'))));
}

console.log('\nacuerdos y retiradas');
{
  const { panal, escrituras, lecturas } = montar((l) => (l.functionName === 'proposals' ? [agente, 7000] : 0n));
  await panal.proposeSettlement(idDelV2_5(4n), 7000);
  check('proposeSettlement [4, 7000]', escrituras[0]!.functionName === 'proposeSettlement' && escrituras[0]!.args[0] === 4n && escrituras[0]!.args[1] === 7000);
  check('un reparto fuera de 0..10.000 no se firma', /0 a 10\.000/.test(await lanza(() => panal.acceptSettlement(idDelV2_5(4n), 10_001))));
  check('los acuerdos no existen en el v2', /escrow v2/.test(await lanza(() => panal.proposeSettlement(4n, 5000))));
  const p = await panal.getSettlementProposal(idDelV2_5(4n));
  check('la propuesta en pie', p?.by === agente && p.workerShareBps === 7000);
  await panal.withdraw(V2_5_MAINNET.usdc, 'v2_5');
  const w = escrituras[1]!;
  check('withdraw(USDC) en el escrow v2.5', mismo(w.address, V2_5_MAINNET.escrow) && w.functionName === 'withdraw' && w.args[0] === V2_5_MAINNET.usdc);
  await panal.getPendingWithdrawal(agente, V2_5_MAINNET.usdc, 'v2_5');
  const saldo = lecturas[lecturas.length - 1]!;
  check('el saldo del v2.5, (moneda, cuenta)', mismo(saldo.address, V2_5_MAINNET.escrow) && saldo.args[0] === V2_5_MAINNET.usdc);
  await panal.releaseV2_5([idDelV2_5(1n), idDelV2_5(2n)]);
  const r = escrituras[2]!;
  check('release con los números de la cadena', r.functionName === 'release' && JSON.stringify((r.args[0] as bigint[]).map(String)) === '["1","2"]');
}

console.log('\ncontratar en USDC');
{
  const logs = [
    {
      address: V2_5_MAINNET.escrow as Address,
      topics: encodeEventTopics({
        abi: panalEscrowV2_5Abi,
        eventName: 'TaskCreated',
        args: { taskId: 42n, client: yo.address, worker: agente },
      }) as Hex[],
      data: encodeAbiParameters(
        [
          { type: 'address' },
          { type: 'uint256' },
          { type: 'bytes32' },
          { type: 'uint64' },
          { type: 'uint64' },
          { type: 'uint32' },
        ],
        [V2_5_MAINNET.usdc, 5_000_000n, keccak256(toBytes('Hazme esto')), ahora + 86_400n, ahora + 85_800n, 72 * 3600],
      ),
    },
  ];
  const { panal, escrituras, lecturas } = montar(
    (l) => {
      if (l.functionName === 'isBanned') return false;
      if (l.functionName === 'info') return [true, 6, 250, 10_000n];
      if (l.functionName === 'getPrices') return [5_000_000n, 20_000_000n];
      if (l.functionName === 'balanceOf') return 50_000_000n;
      throw new Error(`lectura inesperada ${l.functionName}`);
    },
    { logs },
  );
  (panal as unknown as Record<string, unknown>).getAgent = async () => ({
    address: agente,
    active: true,
    currency: NATIVE_CURRENCY,
    pricePerTask: 10n ** 18n,
  });
  const r = await panal.hireV2_5({ agent: agente, brief: 'Hazme esto', currency: V2_5_MAINNET.usdc, reviewWindow: 48 * 3600 });
  check('el precio sale de PanalPrices: el primero', r.amount === 5_000_000n, String(r.amount));
  check('pregunta antes si está suspendido', lecturas.some((l) => l.functionName === 'isBanned' && mismo(l.address, V2_5_MAINNET.bans)));
  check('mira la moneda en la lista de monedas', lecturas.some((l) => l.functionName === 'info' && mismo(l.address, V2_5_MAINNET.currencies) && mismo(String(l.args[0]), V2_5_MAINNET.usdc)));
  const [approve, crear] = escrituras;
  check('approve exacto de USDC al escrow v2.5', approve?.functionName === 'approve' && mismo(approve.address, V2_5_MAINNET.usdc) && mismo(String(approve.args[0]), V2_5_MAINNET.escrow) && approve.args[1] === 5_000_000n);
  const nueva = crear?.args[0] as Record<string, unknown>;
  check('createTask en el v2.5, sin MON', crear?.functionName === 'createTask' && mismo(crear.address, V2_5_MAINNET.escrow) && (crear.value ?? 0n) === 0n);
  check('con su revisión y su moneda', nueva.reviewWindow === 48 * 3600 && nueva.currency === V2_5_MAINNET.usdc && nueva.amount === 5_000_000n);
  check('aceptar dura hasta 10 min antes del plazo', Number(nueva.acceptWindow) === Number((nueva.deadline as bigint) - ahora) - 600 || Number(nueva.acceptWindow) === Number((nueva.deadline as bigint) - ahora) - 601);
  check('el número sale del evento, con el desplazamiento', r.taskId === idDelV2_5(42n), String(r.taskId));
  const sinSaldo = montar((l) => {
    if (l.functionName === 'balanceOf') return 1_000_000n;
    if (l.functionName === 'isBanned') return false;
    // En la lista solo está USDC; cualquier otra cosa sale desactivada y a cero.
    if (l.functionName === 'info') return mismo(String(l.args[0]), V2_5_MAINNET.usdc) ? [true, 6, 250, 2_000_000n] : [false, 0, 0, 0n];
    return [];
  });
  (sinSaldo.panal as unknown as Record<string, unknown>).getAgent = async () => ({ address: agente, active: true, currency: NATIVE_CURRENCY, pricePerTask: 1n });
  const error = await lanza(() => sinSaldo.panal.hireV2_5({ agent: agente, brief: 'x', currency: V2_5_MAINNET.usdc, amount: 5_000_000n }));
  check('el aviso de saldo cuenta USDC con 6 decimales', /5 USDC/.test(error) && /tiene 1\./.test(error), error);
  check('no contrata en una moneda que no está en la lista', /no es una moneda activa de la lista/.test(await lanza(() => sinSaldo.panal.hireV2_5({ agent: agente, brief: 'x', currency: agente }))));
  check('ni por debajo del mínimo de la lista', /mínimo de un encargo/.test(await lanza(() => sinSaldo.panal.hireV2_5({ agent: agente, brief: 'x', currency: V2_5_MAINNET.usdc, amount: 1_000_000n }))));
}

console.log('\nPanal V3: la lista de monedas y los precios de antes');
{
  check('el V3 en el hueco del v2.5', mismo(V2_5_MAINNET.escrow, '0xE9666cB1Ce29CC511ED9Fa28f11749d22D47264f') && mismo(V2_5_MAINNET.currencies, '0x86A2d5b9e02e3E8F63ED468fDC31565e44d70790'));
  const { panal } = montar(() => crudoV2_5({ feeBps: 150 }));
  check('cada encargo trae su comisión', (await panal.getTaskV2_5(idDelV2_5(3n))).feeBps === 150);

  const lista = montar((l) => {
    if (l.functionName === 'currencies') return [NATIVE_CURRENCY, V2_5_MAINNET.usdc];
    if (l.functionName === 'info') return mismo(String(l.args[0]), NATIVE_CURRENCY) ? [true, 18, 250, 10n ** 15n] : [false, 6, 250, 10_000n];
    throw new Error(`lectura inesperada ${l.functionName}`);
  });
  const monedas = await lista.panal.getCurrencies();
  check('getCurrencies lee la lista en su orden', monedas.length === 2 && monedas[0]!.token === NATIVE_CURRENCY && monedas[0]!.minimo === 10n ** 15n && monedas[0]!.decimales === 18);
  check('y dice cuál está desactivada', monedas[1]!.activa === false && monedas[1]!.feeBps === 250);
  check('todo en PanalCurrencies', lista.lecturas.every((l) => mismo(l.address, V2_5_MAINNET.currencies)));

  // Precios: si el agente no ha publicado nada en el V3, los del v2.5 de antes.
  const sinPublicar = montar((l) => {
    if (l.functionName === 'getPrices') return mismo(l.address, V2_5_ANTERIOR.prices) ? [7_000_000n] : [];
    if (l.functionName === 'updatedAt') return 0n;
    throw new Error(`lectura inesperada ${l.functionName}`);
  });
  const p1 = await sinPublicar.panal.getPricesV2_5(agente, V2_5_MAINNET.usdc);
  check('sin precios en el V3, los del PanalPrices de antes', p1.length === 1 && p1[0] === 7_000_000n, String(p1));
  const vaciado = montar((l) => {
    if (l.functionName === 'getPrices') return mismo(l.address, V2_5_ANTERIOR.prices) ? [7_000_000n] : [];
    if (l.functionName === 'updatedAt') return ahora;
    throw new Error(`lectura inesperada ${l.functionName}`);
  });
  check('si los vació en el V3, manda el V3', (await vaciado.panal.getPricesV2_5(agente, V2_5_MAINNET.usdc)).length === 0);
  check('y no mira los de antes', !vaciado.lecturas.some((l) => mismo(l.address, V2_5_ANTERIOR.prices)));
  const conPrecio = montar((l) => (l.functionName === 'getPrices' ? [9n] : 0n));
  await conPrecio.panal.getPricesV2_5(agente);
  check('con precios en el V3, una sola lectura', conPrecio.lecturas.length === 1 && mismo(conPrecio.lecturas[0]!.address, V2_5_MAINNET.prices));
}

console.log('\nel escrow v2 con el registro V3');
{
  const soloV3 = montar((l) => {
    if (l.functionName === 'getAgent') return { active: false, registeredAt: 0n };
    return 10n ** 21n;
  });
  (soloV3.panal as unknown as Record<string, unknown>).getAgent = async () => ({ address: agente, active: true, currency: NATIVE_CURRENCY, pricePerTask: 10n ** 18n });
  const e1 = await lanza(() => soloV3.panal.hire({ agent: agente, brief: 'x' }));
  check('un agente que solo está en el V3 no se contrata en el v2', /registro V2/.test(e1) && /hireV2_5/.test(e1), e1);
  check('y se pregunta al registro V2', soloV3.lecturas.some((l) => l.functionName === 'getAgent' && mismo(l.address, '0x89a812BFb1c35fc814ef25a3E6Ca75068B16Ac51')));
  check('sin firmar nada', soloV3.escrituras.length === 0);
  const enUsdc = montar(() => 0n);
  (enUsdc.panal as unknown as Record<string, unknown>).getAgent = async () => ({ address: agente, active: true, currency: V2_5_MAINNET.usdc, pricePerTask: 1n });
  const e2 = await lanza(() => enUsdc.panal.hire({ agent: agente, brief: 'x' }));
  check('ni uno que cobra en USDC', /solo cobra en MON o \$PANAL/.test(e2), e2);
}

console.log('\nel tablón v2.5');
{
  const { panal, escrituras, lecturas } = montar((l) => {
    if (l.functionName === 'canTake') return [true, ''];
    if (l.functionName === 'getJob') {
      return {
        client: agente,
        mode: 0,
        state: EstadoTablon.Asignado,
        category: 1,
        experiencedOnly: false,
        relist: false,
        reviewWindow: 72 * 3600,
        currency: NATIVE_CURRENCY,
        amount: 10n ** 18n,
        taskHash: CERO32,
        advertHash: CERO32,
        campaignId: CERO32,
        postedAt: 1n,
        expiresAt: 2n,
        workDuration: 3600n,
        applyWindow: 0n,
        chooseWindow: 0n,
        agent: yo.address,
        escrowTaskId: 11n,
      };
    }
    return 0n;
  });
  const r = await panal.takeBoardJob(idDelV2_5(3n));
  const canTake = lecturas.find((l) => l.functionName === 'canTake')!;
  check('canTake al tablón v2.5 con [yo, 3]', mismo(canTake.address, V2_5_MAINNET.tablon) && canTake.args[1] === 3n);
  check('take [3] en el tablón v2.5', escrituras[0]!.functionName === 'take' && mismo(escrituras[0]!.address, V2_5_MAINNET.tablon) && escrituras[0]!.args[0] === 3n);
  check('y su tarea vuelve con el número de fuera', r.escrowTaskId === idDelV2_5(11n), String(r.escrowTaskId));
  await panal.disputeBoardJob(idDelV2_5(3n), 'Falta la mitad');
  check('la disputa del tablón v2.5 lleva la huella del motivo', escrituras[1]!.functionName === 'dispute' && escrituras[1]!.args[1] === keccak256(toBytes('Falta la mitad')));
  await panal.approveBoardJob(idDelV2_5(3n), 4);
  check('approve [3, 4] en el tablón v2.5', escrituras[2]!.functionName === 'approve' && escrituras[2]!.args[0] === 3n && mismo(escrituras[2]!.address, V2_5_MAINNET.tablon));
  check('los acuerdos del tablón son solo del v2.5', /tablón v2/.test(await lanza(() => panal.proposeBoardSettlement(3n, 5000))));
  await panal.claimBoardRefund(NATIVE_CURRENCY, 'v2_5').catch(() => undefined);
  const owed = lecturas.find((l) => l.functionName === 'owed')!;
  check('lo que debe, del tablón v2.5', mismo(owed.address, V2_5_MAINNET.tablon));
}

console.log('\npublicar en el tablón v2.5');
{
  const logs = [
    {
      address: V2_5_MAINNET.tablon as Address,
      topics: encodeEventTopics({
        abi: panalTablonV2_5Abi,
        eventName: 'JobPosted',
        args: { jobId: 6n, client: yo.address, category: 1 },
      }) as Hex[],
      data: encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'bytes32' }],
        [NATIVE_CURRENCY, 10n ** 18n, 0, CERO32],
      ),
    },
  ];
  const { panal, escrituras } = montar(() => 0n, { logs });
  const peticiones: string[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    peticiones.push(`${init?.method ?? 'GET'} ${String(url)}`);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const r = await panal.postBoardJob({
    encargo: 'Traduce esto',
    anuncio: 'Traducción corta',
    categoria: 1,
    importe: 10n ** 18n,
    plazoEntregaS: 3600,
    caducaEnS: 86_400,
    modo: ModoTablon.Inmediato,
    version: 'v2_5',
    ventanaRevisionS: 48 * 3600,
  });
  const post = escrituras[0]!;
  check('post en el tablón v2.5, con el MON', post.functionName === 'post' && mismo(post.address, V2_5_MAINNET.tablon) && post.value === 10n ** 18n);
  check('con su revisión', (post.args[0] as Record<string, unknown>).reviewWindow === 48 * 3600);
  check('el número sale con el desplazamiento', r.jobId === idDelV2_5(6n), String(r.jobId));
  check(
    'los textos van al buzón del tablón v2.5, con ese número',
    peticiones.some((p) => p === `POST https://buzon.prueba/buzon/${V2_5_MAINNET.tablon}/anuncio/${idDelV2_5(6n)}`),
    peticiones.join(' | '),
  );
}

console.log('\nlos jueces del v2.5');
{
  const humano = '0xc384C1F5D6716571DA84329BeAaE6F064C6b1Fe0' as Address;
  const firmantes = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'] as Address[];
  const { panal, lecturas } = montar((l) => {
    if (l.functionName === 'arbitrator') return humano;
    if (l.functionName === 'autoArbitrator') return NATIVE_CURRENCY;
    if (l.functionName === 'owners') {
      const i = Number(l.args[0]);
      if (mismo(l.address, humano) && i < firmantes.length) return firmantes[i];
      throw new Error('revert');
    }
    throw new Error(`lectura inesperada ${l.functionName}`);
  });
  const jueces = await panal.getArbitrators('v2_5');
  check('lee el árbitro del escrow v2.5', mismo(lecturas[0]!.address, V2_5_MAINNET.escrow));
  check('sin jueces autónomos, los firmantes del multisig', JSON.stringify(jueces) === JSON.stringify(firmantes), JSON.stringify(jueces));
}

if (fallos > 0) {
  console.error(`\n${fallos} fallo(s)`);
  process.exit(1);
}
console.log('\nTodo bien.');
