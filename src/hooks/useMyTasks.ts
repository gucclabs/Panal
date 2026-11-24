/**
 * Panal — Mis tareas REALES on-chain (PanalEscrow).
 *
 * CUÁLES son tuyas lo dice el indexador; QUÉ dicen, la cadena.
 *
 * Antes se resolvían las dos preguntas escaneando el escrow: leer las 200
 * últimas tareas y quedarse con las que te nombran. Con 200 tareas en total
 * funcionaba, y a partir de ahí quien contrató ayer DEJABA DE VER LA SUYA — no
 * podía aprobarla, ni disputarla, ni descargar su resultado, y a las 72 h el
 * pago se liberaba solo sin que se hubiera enterado.
 *
 * Ahora el indexador devuelve la lista de ids que te nombran, completa y sin
 * ventana, y de la cadena se leen SOLO esos. Se pasa de 200 lecturas fijas a
 * tantas como tareas tengas.
 *
 * Los datos siguen saliendo de la cadena y no del indexador, y no es por
 * desconfianza: sus eventos no traen `deadline`, `taskHash` ni `deliveredAt`,
 * que es justo lo que hace falta para saber si puedes cancelar, si el texto
 * que recibes es el que encargaste y cuándo se libera el pago solo.
 *
 * Y dos cosas que hay que respetar:
 *
 *   - El indexador va 15 s por detrás. Una tarea recién creada todavía no está
 *     en su lista, así que se le suma SIEMPRE una ventana corta del final del
 *     escrow. Sin eso, contratas y tu tarea no aparece.
 *   - Si el indexador no responde, se vuelve al escaneo de antes. Peor, pero
 *     nunca un panel en blanco: es la pantalla donde la gente va a cobrar.
 *
 * Nombres de agente: el mapeo worker→nombre se hace en los componentes a
 * partir de `usePanalAgents` (si no hay agente registrado con esa address,
 * se muestra la address truncada).
 */

import { useQuery } from '@tanstack/react-query';
import type { Address, Hex } from 'viem';
import { EstadoV2_5, comoTask, panalEscrowV2_5Abi, tareaV2_5DeLaCadena } from '@panal/sdk';
import {
  NATIVE_CURRENCY,
  PANAL_ESCROW_ADDRESS,
  PANAL_ESCROW_V2_5_ADDRESS,
  PANAL_ESCROW_V2_ADDRESS,
  V2_5_ENABLED,
  V2_ENABLED,
  activeChain,
  publicClient,
} from '@/contracts/config';
import { panalEscrowAbi, panalEscrowV2Abi } from '@/contracts/abis';
import { useWallet } from '@/hooks/useWallet';
import { fetchTaskIdsOf } from '@/lib/indexer';
import { esDelV2_5, idDelV2_5, idEnLaCadena, type VersionEscrow } from '@/lib/escrow';

/** Escrow y ABI activos (v2 dual-moneda cuando V2_ENABLED). */
export const ACTIVE_ESCROW_ADDRESS = V2_ENABLED ? PANAL_ESCROW_V2_ADDRESS : PANAL_ESCROW_ADDRESS;
export const ACTIVE_ESCROW_ABI = V2_ENABLED ? panalEscrowV2Abi : panalEscrowAbi;

/** Status del enum on-chain. */
export const TASK_STATUS = {
  Open: 0,
  Delivered: 1,
  Completed: 2,
  Disputed: 3,
  Cancelled: 4,
} as const;

export interface RealTask {
  /**
   * El número de fuera de la cadena: el de siempre en el v2, y el de la cadena
   * más mil millones en el v2.5 (ver lib/escrow.ts). Para firmar, `llamadaDeEscrow`.
   */
  id: bigint;
  /** De qué escrow es. */
  version: VersionEscrow;
  client: Address;
  worker: Address;
  amountWei: bigint;
  taskHash: Hex;
  resultHash: Hex;
  deadline: bigint;
  createdAt: bigint;
  status: number;
  /** moneda de la tarea: address(0) = MON (v1 siempre), PANAL_TOKEN = $PANAL (solo v2) */
  currency: Address;
  /** timestamp de entrega (solo si status === Delivered) */
  deliveredAt?: bigint;
  role: 'client' | 'worker';
  // ── Solo v2.5 ──
  /** Quien trabaja ya la aceptó (sigue «abierta» en `status`: todavía se entrega). */
  aceptada?: boolean;
  /** Hasta cuándo puede aceptar, o entregar sin haber aceptado. */
  acceptBy?: bigint;
  /** Segundos que tiene el cliente para revisar la entrega. */
  reviewWindow?: number;
  /** Cómo se cerró (`CierreV2_5`), si está cerrada. */
  cierre?: number;
  /** Cuándo se abrió la disputa, si la hay. */
  disputedAt?: bigint;
  /** Al cerrar, la parte de quien trabajó (10.000 = todo). */
  workerShareBps?: number;
}

const CHUNK = 5;
const CHUNK_SLEEP_MS = 300;
/** Tope del escaneo de respaldo, cuando el indexador no responde. */
const MAX_TASKS_SCAN = 200;

/**
 * Cuántas tareas del final del escrow se miran SIEMPRE, además de las que
 * diga el indexador.
 *
 * Cubre su retraso: sondea cada 15 s, así que una tarea recién creada aún no
 * está en su lista. 25 son varios minutos de mercado incluso con actividad
 * alta, y cuestan 25 lecturas.
 */
const VENTANA_RECIENTE = 25;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RawTaskTuple {
  client: Address;
  worker: Address;
  amount: bigint;
  taskHash: Hex;
  resultHash: Hex;
  deadline: bigint;
  createdAt: bigint;
  status: number;
  /** solo escrow v2 (ausente en v1) */
  currency?: Address;
}

/**
 * Las del escrow v2.5: los números del indexador desde mil millones, más el
 * final del escrow por lo mismo que en el v2. Se leen con `getTask`, que trae
 * de una vez lo que en el v2 son tres lecturas (deliveredAt, disputedAt…).
 */
async function fetchMyTasksV2_5(me: Address, delIndice: bigint[] | null): Promise<RealTask[]> {
  if (!V2_5_ENABLED) return [];
  const count = (await publicClient.readContract({
    address: PANAL_ESCROW_V2_5_ADDRESS,
    abi: panalEscrowV2_5Abi,
    functionName: 'getTaskCount',
  })) as bigint;
  if (count === 0n) return [];
  const aLeer = new Set<bigint>();
  for (const id of delIndice ?? []) if (esDelV2_5(id) && idEnLaCadena(id) < count) aLeer.add(idEnLaCadena(id));
  const ventana = delIndice !== null ? BigInt(VENTANA_RECIENTE) : BigInt(MAX_TASKS_SCAN);
  for (let i = count > ventana ? count - ventana : 0n; i < count; i++) aLeer.add(i);

  const ids = [...aLeer].sort((a, b) => (a > b ? 1 : a < b ? -1 : 0));
  const meLc = me.toLowerCase();
  const mine: RealTask[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await Promise.all(
      chunk.map(
        (id) =>
          publicClient.readContract({
            address: PANAL_ESCROW_V2_5_ADDRESS,
            abi: panalEscrowV2_5Abi,
            functionName: 'getTask',
            args: [id],
          }) as Promise<Record<string, unknown>>,
      ),
    );
    rows.forEach((row, j) => {
      const t = tareaV2_5DeLaCadena(idDelV2_5(chunk[j]), row);
      const isClient = t.client.toLowerCase() === meLc;
      const isWorker = t.worker.toLowerCase() === meLc;
      if (!isClient && !isWorker) return;
      const v2 = comoTask(t);
      mine.push({
        id: t.id,
        version: 'v2_5',
        client: t.client,
        worker: t.worker,
        amountWei: t.amount,
        taskHash: t.taskHash,
        resultHash: t.resultHash,
        deadline: t.deadline,
        createdAt: t.createdAt,
        status: v2.status,
        currency: t.currency,
        deliveredAt: t.deliveredAt > 0n ? t.deliveredAt : undefined,
        role: isClient ? 'client' : 'worker',
        aceptada: t.estado === EstadoV2_5.Aceptada,
        acceptBy: t.acceptBy,
        reviewWindow: t.reviewWindow,
        cierre: t.cierre,
        disputedAt: t.disputedAt > 0n ? t.disputedAt : undefined,
        workerShareBps: t.workerShareBps,
      });
    });
    if (i + CHUNK < ids.length) await sleep(CHUNK_SLEEP_MS);
  }
  return mine;
}

async function fetchMyTasks(me: Address): Promise<RealTask[]> {
  // Los números que me nombran, de los dos escrows; null = el indexador no
  // respondió o va atrasado, y cada escrow cae a su escaneo de respaldo.
  const cabeza = await publicClient.getBlockNumber().catch(() => undefined);
  const delIndice = await fetchTaskIdsOf(me, cabeza);
  // Las del v2.5 no pueden tumbar las del v2: es la pantalla donde se cobra.
  const [v2, v25] = await Promise.all([
    fetchMyTasksV2(me, delIndice),
    fetchMyTasksV2_5(me, delIndice).catch((e: unknown) => {
      console.warn('[mis tareas] no se pudieron leer las del escrow v2.5', e);
      return [] as RealTask[];
    }),
  ]);
  // Más recientes primero, de los dos escrows juntos.
  return [...v2, ...v25].sort((a, b) =>
    a.createdAt !== b.createdAt ? (a.createdAt > b.createdAt ? -1 : 1) : a.id > b.id ? -1 : a.id < b.id ? 1 : 0,
  );
}

async function fetchMyTasksV2(me: Address, delIndice: bigint[] | null): Promise<RealTask[]> {
  const count = (await publicClient.readContract({
    address: ACTIVE_ESCROW_ADDRESS,
    abi: ACTIVE_ESCROW_ABI,
    functionName: 'getTaskCount',
  })) as bigint;

  const total = Number(count);
  if (total === 0) return [];

  const aLeer = new Set<string>();
  if (delIndice !== null) {
    // Solo los del v2: los del v2.5 van desde mil millones.
    for (const id of delIndice) if (!esDelV2_5(id)) aLeer.add(id.toString());
    // Su lista va 15 s por detrás, así que se le suma el final del escrow: sin
    // esto, contratas y tu tarea recién creada no aparece en el panel.
    for (let i = Math.max(0, total - VENTANA_RECIENTE); i < total; i++) aLeer.add(String(i));
  } else {
    // Sin indexador se vuelve al escaneo de antes. Peor —solo ve las últimas
    // MAX_TASKS_SCAN— pero es mejor que dejar en blanco la pantalla donde la
    // gente aprueba y cobra.
    for (let i = Math.max(0, total - MAX_TASKS_SCAN); i < total; i++) aLeer.add(String(i));
  }

  const ids = [...aLeer]
    .map((x) => BigInt(x))
    // Un id que ya no existe en el escrow (indexador de otra red, o adelantado)
    // haría reventar la lectura del lote entero.
    .filter((id) => id < count)
    .sort((a, b) => (a > b ? 1 : a < b ? -1 : 0));

  const meLc = me.toLowerCase();
  const mine: RealTask[] = [];

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await Promise.all(
      chunk.map(
        (id) =>
          publicClient.readContract({
            address: ACTIVE_ESCROW_ADDRESS,
            abi: ACTIVE_ESCROW_ABI,
            functionName: 'tasks',
            args: [id],
          }) as Promise<RawTaskTuple>,
      ),
    );
    rows.forEach((row, j) => {
      const isClient = row.client.toLowerCase() === meLc;
      const isWorker = row.worker.toLowerCase() === meLc;
      if (!isClient && !isWorker) return;
      mine.push({
        id: chunk[j],
        version: 'v2',
        client: row.client,
        worker: row.worker,
        amountWei: row.amount,
        taskHash: row.taskHash,
        resultHash: row.resultHash,
        deadline: row.deadline,
        createdAt: row.createdAt,
        status: Number(row.status),
        currency: row.currency ?? NATIVE_CURRENCY,
        role: isClient ? 'client' : 'worker',
      });
    });
    if (i + CHUNK < ids.length) await sleep(CHUNK_SLEEP_MS);
  }

  // deliveredAt solo para las mías en Delivered (pocas en la práctica).
  const delivered = mine.filter((tk) => tk.status === TASK_STATUS.Delivered);
  for (let i = 0; i < delivered.length; i += CHUNK) {
    const chunk = delivered.slice(i, i + CHUNK);
    const ts = await Promise.all(
      chunk.map(
        (tk) =>
          publicClient
            .readContract({
              address: ACTIVE_ESCROW_ADDRESS,
              abi: ACTIVE_ESCROW_ABI,
              functionName: 'deliveredAt',
              args: [tk.id],
            })
            .catch(() => 0n) as Promise<bigint>,
      ),
    );
    chunk.forEach((tk, j) => {
      tk.deliveredAt = ts[j];
    });
    if (i + CHUNK < delivered.length) await sleep(CHUNK_SLEEP_MS);
  }

  return mine;
}

export interface MyTasks {
  tasks: RealTask[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useMyTasks(): MyTasks {
  const { address, connected } = useWallet();
  const addr = (connected && address ? address : null) as Address | null;

  const query = useQuery({
    queryKey: ['my-tasks', activeChain.id, V2_ENABLED, V2_5_ENABLED, addr],
    enabled: !!addr,
    queryFn: () => fetchMyTasks(addr as Address),
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    retry: 1,
  });

  return {
    tasks: query.data ?? [],
    loading: !!addr && query.isLoading,
    error: query.isError ? (query.error as Error) : null,
    refetch: () => void query.refetch(),
  };
}
