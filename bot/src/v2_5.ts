/**
 * El escrow v2.5 y su tablón, desplegados el 24-nov-2026, vistos desde el bot.
 *
 * LA NUMERACIÓN. El escrow v2.5 y el tablón v2.5 empiezan a contar desde 0, y
 * el buzón, el indexador y todos los mensajes firmados («Panal resultado #5 ·
 * …») identifican cada encargo solo por su número. Para que el 5 del v2.5 no
 * choque con el 5 del v2, FUERA DE LA CADENA cada encargo del v2.5 lleva su
 * número más mil millones: el 5 del v2.5 es el 1.000.000.005. El v2 va por el
 * 140 y nunca llegará ahí.
 *
 * Así no cambia ni una ruta del buzón, ni su almacén, ni el texto de ningún
 * mensaje, ni la lista de firmas que acepta la app. Y si algún componente se
 * olvida de traducirlo y se lo pide al escrow v2, la llamada revierte (no
 * existe esa tarea): falla, en vez de leer un encargo equivocado.
 *
 * En la cadena, el número es siempre el de verdad (`idEnLaCadena`).
 */

import { parseAbi, parseAbiItem, type Address, type Hex } from 'viem';
import { TaskStatus, withRetry, type ChainClients, type Task, type TrabajoTablon } from './chain.js';

/** Desde aquí, los números son del v2.5. */
export const PRIMER_ID_V2_5 = 1_000_000_000n;

/** El número que usa todo lo que no es la cadena, para un encargo del v2.5. */
export function idDelV2_5(idEnLaCadena: bigint): bigint {
  return PRIMER_ID_V2_5 + idEnLaCadena;
}

export function esDelV2_5(id: bigint): boolean {
  return id >= PRIMER_ID_V2_5;
}

/** El número de verdad en su contrato, sea del v2 o del v2.5. */
export function idEnLaCadena(id: bigint): bigint {
  return esDelV2_5(id) ? id - PRIMER_ID_V2_5 : id;
}

/** Las direcciones del v2.5 en Monad mainnet, desplegadas el 24-nov-2026. */
export const V2_5_MAINNET = {
  escrow: '0x1800225eac5cEF7798e2A926AE243F2a4a42D440',
  tablon: '0x10aF8A30591Fcee56127692d7346476bc68CD656',
  reputation: '0xc8f91E7718835cAEf5e36452705B8922c857624e',
  bans: '0xdA315187aA8bE2266a3bFfe6cdD876A1250A4638',
  prices: '0x90CBa3BE239FcA150Fc8fAfC10D6bD7CCb547663',
  usdc: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  /** El bloque del primero (PanalBans). El indexador recorre desde aquí. */
  desdeBloque: 124_859_551,
} as const;

/** Lo que el bot necesita saber del v2.5. `null` en la config = no lo hay. */
export interface ConfigV2_5 {
  escrow: Address;
  tablon: Address;
  reputation: Address;
  bans: Address;
  prices: Address;
  usdc: Address;
  desdeBloque: number;
}

// ── El escrow v2.5 ─────────────────────────────────────────────────────────

/** Status del escrow v2.5. */
export enum StatusV2_5 {
  Open = 0,
  Accepted = 1,
  Delivered = 2,
  Disputed = 3,
  Closed = 4,
}

/** Cómo se cerró una tarea del v2.5. */
export enum CierreV2_5 {
  None = 0,
  Approved = 1,
  Timeout = 2,
  Arbitrated = 3,
  DisputeExpired = 4,
  Mutual = 5,
  Cancelled = 6,
  Expired = 7,
  Rejected = 8,
  AutoArbitrated = 9,
}

/** Los cierres en que no hubo entrega: el dinero volvió entero al cliente. */
export const CIERRES_SIN_ENTREGA: ReadonlySet<number> = new Set([
  CierreV2_5.Cancelled,
  CierreV2_5.Expired,
  CierreV2_5.Rejected,
]);

/** `getTask` con la forma entera del struct: viem decodifica por posición. */
export const escrowV2_5Abi = [
  {
    type: 'function',
    name: 'getTask',
    stateMutability: 'view',
    inputs: [{ name: 'taskId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'client', type: 'address' },
          { name: 'deadline', type: 'uint64' },
          { name: 'status', type: 'uint8' },
          { name: 'closeReason', type: 'uint8' },
          { name: 'workerShareBps', type: 'uint16' },
          { name: 'worker', type: 'address' },
          { name: 'acceptBy', type: 'uint64' },
          { name: 'reviewWindow', type: 'uint32' },
          { name: 'currency', type: 'address' },
          { name: 'deliveredAt', type: 'uint64' },
          { name: 'amount', type: 'uint128' },
          { name: 'createdAt', type: 'uint64' },
          { name: 'disputedAt', type: 'uint64' },
          { name: 'taskHash', type: 'bytes32' },
          { name: 'resultHash', type: 'bytes32' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'getTaskCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/** Una tarea del v2.5 tal como sale de la cadena. */
export interface TareaV2_5 {
  client: Address;
  deadline: bigint;
  status: StatusV2_5;
  closeReason: CierreV2_5;
  workerShareBps: number;
  worker: Address;
  acceptBy: bigint;
  reviewWindow: number;
  currency: Address;
  deliveredAt: bigint;
  amount: bigint;
  createdAt: bigint;
  disputedAt: bigint;
  taskHash: Hex;
  resultHash: Hex;
}

export async function getTareaV2_5(clients: ChainClients, v: ConfigV2_5, idEnCadena: bigint): Promise<TareaV2_5> {
  const t = await withRetry(`getTask v2.5 (${idEnCadena})`, () =>
    clients.publicClient.readContract({
      address: v.escrow,
      abi: escrowV2_5Abi,
      functionName: 'getTask',
      args: [idEnCadena],
    }),
  );
  return {
    ...t,
    status: Number(t.status) as StatusV2_5,
    closeReason: Number(t.closeReason) as CierreV2_5,
    workerShareBps: Number(t.workerShareBps),
    reviewWindow: Number(t.reviewWindow),
    amount: BigInt(t.amount),
  };
}

/**
 * Una tarea del v2.5 con la forma de las del v2, para el buzón.
 *
 * Lo que el buzón mira es si hay entrega, si está en disputa y si se cerró:
 *   - Aceptada cuenta como abierta: todavía se puede entregar.
 *   - Cerrada sin entrega (cancelada, vencida, rechazada) es «cancelada».
 *   - Cerrada con entrega, por el motivo que sea, es «completada».
 */
export function comoTareaV2(t: TareaV2_5): Task {
  let status: TaskStatus;
  switch (t.status) {
    case StatusV2_5.Open:
    case StatusV2_5.Accepted:
      status = TaskStatus.Open;
      break;
    case StatusV2_5.Delivered:
      status = TaskStatus.Delivered;
      break;
    case StatusV2_5.Disputed:
      status = TaskStatus.Disputed;
      break;
    default:
      status = CIERRES_SIN_ENTREGA.has(t.closeReason) ? TaskStatus.Cancelled : TaskStatus.Completed;
  }
  return {
    client: t.client,
    worker: t.worker,
    amount: t.amount,
    taskHash: t.taskHash,
    resultHash: t.resultHash,
    deadline: t.deadline,
    createdAt: t.createdAt,
    status,
    currency: t.currency,
  };
}

// ── Quién juzga en el v2.5 ─────────────────────────────────────────────────

const rolesAbi = parseAbi([
  'function arbitrator() view returns (address)',
  'function autoArbitrator() view returns (address)',
  'function owners(uint256) view returns (address)',
]);

/** Una cuenta y, si es un multisig, sus firmantes (`owners(i)` hasta que revierta). */
async function conFirmantes(clients: ChainClients, cuenta: Address): Promise<Address[]> {
  const out: Address[] = [cuenta];
  for (let i = 0; i < 10; i++) {
    try {
      out.push(
        (await clients.publicClient.readContract({
          address: cuenta,
          abi: rolesAbi,
          functionName: 'owners',
          args: [BigInt(i)],
        })) as Address,
      );
    } catch {
      break;
    }
  }
  return out;
}

/**
 * Los jueces del v2.5: el árbitro humano (el mismo multisig que en el v2) y,
 * si los hay, los jueces autónomos, cada uno con sus firmantes.
 */
export async function getArbitrosV2_5(clients: ChainClients, v: ConfigV2_5): Promise<Address[]> {
  const leer = (fn: 'arbitrator' | 'autoArbitrator') =>
    withRetry(`${fn}() v2.5`, () =>
      clients.publicClient.readContract({ address: v.escrow, abi: rolesAbi, functionName: fn }),
    ) as Promise<Address>;
  const humanos = await conFirmantes(clients, await leer('arbitrator'));
  const auto = await leer('autoArbitrator');
  const autonomos = auto === '0x0000000000000000000000000000000000000000' ? [] : await conFirmantes(clients, auto);
  return [...humanos, ...autonomos];
}

// ── El tablón v2.5 ─────────────────────────────────────────────────────────

/** `getJob` del tablón v2.5, con la forma entera de su struct. */
export const tablonV2_5Abi = [
  { type: 'error', name: 'InvalidJob', inputs: [] },
  {
    type: 'function',
    name: 'getJob',
    stateMutability: 'view',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'client', type: 'address' },
          { name: 'mode', type: 'uint8' },
          { name: 'state', type: 'uint8' },
          { name: 'category', type: 'uint8' },
          { name: 'experiencedOnly', type: 'bool' },
          { name: 'relist', type: 'bool' },
          { name: 'reviewWindow', type: 'uint32' },
          { name: 'currency', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'taskHash', type: 'bytes32' },
          { name: 'advertHash', type: 'bytes32' },
          { name: 'campaignId', type: 'bytes32' },
          { name: 'postedAt', type: 'uint64' },
          { name: 'expiresAt', type: 'uint64' },
          { name: 'workDuration', type: 'uint64' },
          { name: 'applyWindow', type: 'uint64' },
          { name: 'chooseWindow', type: 'uint64' },
          { name: 'agent', type: 'address' },
          { name: 'escrowTaskId', type: 'uint256' },
        ],
      },
    ],
  },
] as const;

/**
 * Un encargo del tablón v2.5, con la forma que usa el buzón. Su tarea del
 * escrow va ya con el número de fuera (más mil millones): es del escrow v2.5.
 */
export async function getTrabajoV2_5(clients: ChainClients, v: ConfigV2_5, jobIdEnCadena: bigint): Promise<TrabajoTablon> {
  const j = await withRetry(`getJob v2.5 (${jobIdEnCadena})`, () =>
    clients.publicClient.readContract({
      address: v.tablon,
      abi: tablonV2_5Abi,
      functionName: 'getJob',
      args: [jobIdEnCadena],
    }),
  );
  const asignado = Number(j.state) !== 0 && j.agent !== '0x0000000000000000000000000000000000000000';
  return {
    client: j.client,
    state: Number(j.state),
    agent: j.agent,
    taskHash: j.taskHash,
    advertHash: j.advertHash,
    // Sin asignar, `escrowTaskId` es 0 y no apunta a nada: se deja en 0.
    escrowTaskId: asignado ? idDelV2_5(j.escrowTaskId) : 0n,
  };
}

// ── Eventos que indexa el v2.5 ─────────────────────────────────────────────
//
// El tablón v2.5 emite sus eventos con las mismas firmas que el v2 (los que
// quitó no aparecen): se lee con TABLON_EVENTS. Los del escrow cambian.

export const ESCROW_V2_5_EVENTS = [
  parseAbiItem(
    'event TaskCreated(uint256 indexed taskId, address indexed client, address indexed worker, address currency, uint256 amount, bytes32 taskHash, uint64 deadline, uint64 acceptBy, uint32 reviewWindow)',
  ),
  parseAbiItem('event TaskAccepted(uint256 indexed taskId, address indexed worker)'),
  parseAbiItem('event TaskDelivered(uint256 indexed taskId, address indexed worker, bytes32 resultHash)'),
  parseAbiItem('event TaskDisputed(uint256 indexed taskId, address indexed openedBy, bytes32 reasonHash)'),
  parseAbiItem('event DisputeResolved(uint256 indexed taskId, uint16 workerShareBps, uint8 rating, bytes32 decisionHash)'),
  parseAbiItem('event SettlementProposed(uint256 indexed taskId, address indexed by, uint16 workerShareBps)'),
  parseAbiItem('event DeadlineExtended(uint256 indexed taskId, uint64 deadline)'),
  parseAbiItem(
    'event TaskClosed(uint256 indexed taskId, uint8 indexed reason, uint256 workerPaid, uint256 fee, uint256 clientRefund, uint8 rating)',
  ),
  parseAbiItem(
    'event RulingProposed(uint256 indexed taskId, address indexed by, uint16 workerShareBps, uint8 rating, bytes32 decisionHash, uint64 finalAt)',
  ),
  parseAbiItem('event RulingOverruled(uint256 indexed taskId, address indexed by)'),
  parseAbiItem('event Withdrawal(address indexed to, address indexed token, uint256 amount)'),
] as const;

/** PanalBans: la lista de suspendidos. */
export const BANS_EVENTS = [
  parseAbiItem('event AccountSuspended(address indexed account, bytes32 reasonHash)'),
  parseAbiItem('event AccountReinstated(address indexed account, bytes32 reasonHash)'),
] as const;

/** PanalPrices: los precios de cada agente, por moneda. */
export const PRICES_EVENTS = [parseAbiItem('event PricesSet(address indexed agent, address indexed currency, uint128[] amounts)')] as const;
