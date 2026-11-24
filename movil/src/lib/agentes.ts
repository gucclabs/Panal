/**
 * Panal — administrar y seguir agentes desde el teléfono.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * EL MURO, y decide la forma de todo lo que hay debajo.
 *
 * `registerAgent`, `updatePrice`, `updateMetadata` y `setActive` NO reciben
 * ninguna dirección de agente: actúan sobre `msg.sender`. En mainnet los nueve
 * agentes registrados tienen como dueño su propia dirección, sin una excepción.
 *
 * O sea que una wallet solo puede administrarse a sí misma. «Mis agentes» en
 * plural NO existe hoy, y para mandar sobre uno desde el móvil hay que conectar
 * SU wallet — la que está corriendo su bot, con su clave en un `.env`.
 *
 * De ahí los dos modos, y de ahí que el que viene puesto sea SEGUIR: mirar no
 * necesita firmar nada, así que la clave del agente puede quedarse en el
 * servidor. Administrar es una decisión aparte y la pantalla la nombra.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { useQuery } from '@tanstack/react-query';
import type { Address, Hex } from 'viem';
import { EstadoV2_5, comoTask, esDelV2_5, idDelV2_5, idEnLaCadena, panalEscrowV2_5Abi, tareaV2_5DeLaCadena } from '@panal/sdk';
import type { VersionEscrow } from '@panal/sdk';
import { panalEscrowV2Abi, panalRegistryV2Abi } from '@/contracts/abis';
import {
  NATIVE_CURRENCY,
  PANAL_ESCROW_V2_5_ADDRESS,
  PANAL_ESCROW_V2_ADDRESS,
  PANAL_REGISTRY_V2_ADDRESS,
  PANAL_TOKEN_ADDRESS,
  USDC_TOKEN_ADDRESS,
  V2_5_ENABLED,
  activeChain,
  publicClient,
} from '@/contracts/config';
import { extractBotUrl } from '@/lib/botEndpoint';
import { esDireccion, partirFicha } from '~/lib/ficha';
import type { FilaCartera } from '~/lib/cartera';
import { fetchTaskIdsOf } from '@/lib/indexer';

export { armarFicha, dejarDeSeguir, esDireccion, partirFicha, seguidos, seguir } from '~/lib/ficha';

/* ── la ficha del agente, tal y como está en el registro ─────────────────── */

export interface Ficha {
  /** `false` cuando esa dirección no está registrada como agente. */
  registrado: boolean;
  dueno: Address;
  metadataURI: string;
  nombre: string;
  descripcion: string;
  botUrl: string | null;
  precio: bigint;
  moneda: Address;
  activo: boolean;
  desde: number;
}

export function useFicha(direccion: string | undefined) {
  return useQuery<Ficha>({
    queryKey: ['ficha-agente', activeChain.id, direccion?.toLowerCase()],
    enabled: !!direccion && esDireccion(direccion),
    staleTime: 20_000,
    queryFn: async () => {
      const f = (await publicClient.readContract({
        address: PANAL_REGISTRY_V2_ADDRESS,
        abi: panalRegistryV2Abi,
        functionName: 'getAgent',
        args: [direccion as Address],
      })) as {
        owner: Address;
        metadataURI: string;
        pricePerTask: bigint;
        active: boolean;
        registeredAt: bigint;
        currency: Address;
      };

      const { nombre, descripcion } = partirFicha(f.metadataURI ?? '');
      return {
        // `getAgent` de una dirección sin registrar devuelve la tupla a cero.
        // Es `registeredAt` lo que lo distingue, no el nombre.
        registrado: f.registeredAt > 0n,
        dueno: f.owner,
        metadataURI: f.metadataURI ?? '',
        nombre: nombre || `${direccion!.slice(0, 6)}…${direccion!.slice(-4)}`,
        descripcion,
        botUrl: extractBotUrl(f.metadataURI),
        precio: f.pricePerTask,
        moneda: f.currency,
        activo: f.active,
        desde: Number(f.registeredAt) * 1000,
      };
    },
  });
}

/* ── lo ganado y sin cobrar ──────────────────────────────────────────────── */

/** Lo que un escrow le debe a una cuenta en una moneda. Sacarlo es una firma. */
export interface SaldoEnEscrow {
  version: VersionEscrow;
  moneda: Address;
  simbolo: 'MON' | '$PANAL' | 'USDC';
  importe: bigint;
}

export interface Pendiente {
  /** Lo de los dos escrows sumado, por moneda. */
  panal: bigint;
  mon: bigint;
  usdc: bigint;
  hay: boolean;
  /** Uno por escrow y moneda con saldo: cada uno es una firma. */
  lista: SaldoEnEscrow[];
}

/** Dirección del escrow de una versión. */
export function direccionEscrow(v: VersionEscrow): Address {
  return v === 'v2_5' ? PANAL_ESCROW_V2_5_ADDRESS : PANAL_ESCROW_V2_ADDRESS;
}

/**
 * Lo que los escrows le deben a una cuenta, escrow a escrow y moneda a moneda.
 *
 * Cada escrow guarda su saldo (el v2.5, del 24-nov-2026, también en USDC) y
 * `withdraw(token)` solo vacía el del escrow al que se llama. Si el v2.5 no
 * contesta, se sigue con el v2: es de donde sale casi todo lo cobrado.
 */
export async function leerPendiente(direccion: Address): Promise<Pendiente> {
  const v2 = (moneda: Address) =>
    publicClient.readContract({
      address: PANAL_ESCROW_V2_ADDRESS,
      abi: panalEscrowV2Abi,
      functionName: 'pendingWithdrawals',
      args: [moneda, direccion],
    }) as Promise<bigint>;
  const v25 = (moneda: Address) =>
    !V2_5_ENABLED
      ? Promise.resolve(0n)
      : (publicClient.readContract({
          address: PANAL_ESCROW_V2_5_ADDRESS,
          abi: panalEscrowV2_5Abi,
          functionName: 'pendingWithdrawals',
          args: [moneda, direccion],
        }) as Promise<bigint>).catch(() => 0n);

  const pedir: Omit<SaldoEnEscrow, 'importe'>[] = [
    { version: 'v2', moneda: PANAL_TOKEN_ADDRESS, simbolo: '$PANAL' },
    { version: 'v2', moneda: NATIVE_CURRENCY, simbolo: 'MON' },
    { version: 'v2_5', moneda: PANAL_TOKEN_ADDRESS, simbolo: '$PANAL' },
    { version: 'v2_5', moneda: NATIVE_CURRENCY, simbolo: 'MON' },
    { version: 'v2_5', moneda: USDC_TOKEN_ADDRESS, simbolo: 'USDC' },
  ];
  const importes = await Promise.all(pedir.map((x) => (x.version === 'v2' ? v2(x.moneda) : v25(x.moneda))));
  const lista = pedir.map((x, i) => ({ ...x, importe: importes[i]! })).filter((x) => x.importe > 0n);
  const suma = (simbolo: SaldoEnEscrow['simbolo']) =>
    lista.filter((x) => x.simbolo === simbolo).reduce((a, x) => a + x.importe, 0n);
  return { panal: suma('$PANAL'), mon: suma('MON'), usdc: suma('USDC'), hay: lista.length > 0, lista };
}

/**
 * Lo que los escrows le deben al agente y todavía está dentro.
 *
 * Es una lectura por escrow y moneda, porque `pendingWithdrawals(token,
 * cuenta)` recibe un token, y por lo mismo sacarlo es una firma por cada uno.
 * Eso sale escrito en la pantalla: esconderlo haría que la segunda petición
 * pareciera un fallo.
 */
export function usePendiente(direccion: string | undefined) {
  return useQuery<Pendiente>({
    queryKey: ['pendiente', activeChain.id, direccion?.toLowerCase()],
    enabled: !!direccion && esDireccion(direccion),
    staleTime: 10_000,
    refetchInterval: 20_000,
    queryFn: () => leerPendiente(direccion as Address),
  });
}

/* ── los encargos de un agente, sea o no el que firma ────────────────────── */

export interface TareaDeAgente {
  /** El número de fuera de la cadena: en el v2.5, el de la cadena más mil millones. */
  id: bigint;
  version: VersionEscrow;
  client: Address;
  worker: Address;
  amountWei: bigint;
  taskHash: Hex;
  resultHash: Hex;
  deadline: bigint;
  createdAt: bigint;
  status: number;
  currency: Address;
  deliveredAt?: bigint;
  // ── Solo v2.5 ──
  /** Segundos de revisión tras la entrega (en el v2, 72 h fijas). */
  reviewWindow?: number;
  /** Ya la aceptó quien trabaja (sigue «abierta» en `status`). */
  aceptada?: boolean;
  acceptBy?: bigint;
  disputedAt?: bigint;
}

const LOTE = 5;
const RESPIRO_MS = 300;
const VENTANA_RECIENTE = 25;
const TOPE_ESCANEO = 200;
/** Cuántas tareas del final se miran para contar los encargos abiertos. */
const VENTANA_CARTERA = 120;

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Las tareas en las que una dirección es el TRABAJADOR.
 *
 * `useMyTasks` hace esto mismo pero solo para la wallet conectada, y aquí hace
 * falta para una dirección cualquiera: en modo «seguir» se mira un agente que
 * no eres tú. Se repite el planteamiento —ids del indexador, datos de la
 * cadena, ventana reciente por si el indexador va atrasado, escaneo de
 * respaldo— en vez de tocar el hook de la web, que la app no debe cambiar.
 */
async function tareasDe(direccion: Address): Promise<TareaDeAgente[]> {
  const total = Number(
    (await publicClient.readContract({
      address: PANAL_ESCROW_V2_ADDRESS,
      abi: panalEscrowV2Abi,
      functionName: 'getTaskCount',
    })) as bigint,
  );
  if (total === 0) return [];

  const cabeza = await publicClient.getBlockNumber().catch(() => undefined);
  const delIndice = await fetchTaskIdsOf(direccion, cabeza);

  const aLeer = new Set<string>();
  if (delIndice !== null) {
    for (const id of delIndice) aLeer.add(id.toString());
    for (let i = Math.max(0, total - VENTANA_RECIENTE); i < total; i++) aLeer.add(String(i));
  } else {
    for (let i = Math.max(0, total - TOPE_ESCANEO); i < total; i++) aLeer.add(String(i));
  }

  const ids = [...aLeer]
    .map((x) => BigInt(x))
    .filter((id) => id < BigInt(total))
    .sort((a, b) => (a > b ? 1 : a < b ? -1 : 0));

  const suyas: TareaDeAgente[] = [];
  const dirLc = direccion.toLowerCase();

  for (let i = 0; i < ids.length; i += LOTE) {
    const lote = ids.slice(i, i + LOTE);
    const filas = await Promise.all(
      lote.map(
        (id) =>
          publicClient.readContract({
            address: PANAL_ESCROW_V2_ADDRESS,
            abi: panalEscrowV2Abi,
            functionName: 'tasks',
            args: [id],
          }) as Promise<Omit<TareaDeAgente, 'id'> & { amount: bigint }>,
      ),
    );
    filas.forEach((f, j) => {
      if (f.worker.toLowerCase() !== dirLc) return;
      suyas.push({
        id: lote[j]!,
        client: f.client,
        worker: f.worker,
        amountWei: f.amount,
        taskHash: f.taskHash,
        resultHash: f.resultHash,
        deadline: f.deadline,
        createdAt: f.createdAt,
        status: Number(f.status),
        currency: f.currency ?? NATIVE_CURRENCY,
        version: 'v2',
      });
    });
    if (i + LOTE < ids.length) await dormir(RESPIRO_MS);
  }

  // `deliveredAt` solo de las entregadas: es lo que da la cuenta atrás de los
  // tres días, y pedirlo de todas serían lecturas tiradas.
  const entregadas = suyas.filter((t) => t.status === 1);
  for (let i = 0; i < entregadas.length; i += LOTE) {
    const lote = entregadas.slice(i, i + LOTE);
    const cuandos = await Promise.all(
      lote.map(
        (t) =>
          publicClient
            .readContract({
              address: PANAL_ESCROW_V2_ADDRESS,
              abi: panalEscrowV2Abi,
              functionName: 'deliveredAt',
              args: [t.id],
            })
            .catch(() => 0n) as Promise<bigint>,
      ),
    );
    lote.forEach((t, j) => {
      t.deliveredAt = cuandos[j];
    });
    if (i + LOTE < entregadas.length) await dormir(RESPIRO_MS);
  }

  // Las del v2.5 no pueden tumbar las del v2: aquí se ve lo que hay sin cobrar.
  const del25 = await tareasV2_5De(direccion, delIndice).catch((e: unknown) => {
    console.warn('[panal] no se pudieron leer las tareas del escrow v2.5', e);
    return [] as TareaDeAgente[];
  });
  return [...suyas, ...del25].sort((a, b) =>
    a.createdAt !== b.createdAt ? (a.createdAt > b.createdAt ? -1 : 1) : a.id > b.id ? -1 : 1,
  );
}

/** Una tarea del v2.5 con la forma de `TareaDeAgente`. */
function deV2_5(id: bigint, fila: Record<string, unknown>): TareaDeAgente {
  const t = tareaV2_5DeLaCadena(idDelV2_5(id), fila);
  return {
    id: t.id,
    version: 'v2_5',
    client: t.client,
    worker: t.worker,
    amountWei: t.amount,
    taskHash: t.taskHash,
    resultHash: t.resultHash,
    deadline: t.deadline,
    createdAt: t.createdAt,
    status: comoTask(t).status,
    currency: t.currency,
    deliveredAt: t.deliveredAt > 0n ? t.deliveredAt : undefined,
    reviewWindow: t.reviewWindow,
    aceptada: t.estado === EstadoV2_5.Aceptada,
    acceptBy: t.acceptBy,
    disputedAt: t.disputedAt > 0n ? t.disputedAt : undefined,
  };
}

/** Cuántas tareas tiene el escrow v2.5 (0 donde no está desplegado). */
async function cuentaV2_5(): Promise<bigint> {
  if (!V2_5_ENABLED) return 0n;
  return (await publicClient.readContract({
    address: PANAL_ESCROW_V2_5_ADDRESS,
    abi: panalEscrowV2_5Abi,
    functionName: 'getTaskCount',
  })) as bigint;
}

/** Lee tareas del v2.5 por su número de la cadena, de cinco en cinco. */
async function leerV2_5(ids: bigint[]): Promise<TareaDeAgente[]> {
  const out: TareaDeAgente[] = [];
  for (let i = 0; i < ids.length; i += LOTE) {
    const lote = ids.slice(i, i + LOTE);
    const filas = await Promise.all(
      lote.map(
        (id) =>
          publicClient.readContract({
            address: PANAL_ESCROW_V2_5_ADDRESS,
            abi: panalEscrowV2_5Abi,
            functionName: 'getTask',
            args: [id],
          }) as Promise<Record<string, unknown>>,
      ),
    );
    filas.forEach((f, j) => out.push(deV2_5(lote[j]!, f)));
    if (i + LOTE < ids.length) await dormir(RESPIRO_MS);
  }
  return out;
}

/** Las del v2.5 en las que `direccion` trabaja: las del indexador y las últimas. */
async function tareasV2_5De(direccion: Address, delIndice: bigint[] | null): Promise<TareaDeAgente[]> {
  const total = await cuentaV2_5();
  if (total === 0n) return [];
  const aLeer = new Set<bigint>();
  for (const id of delIndice ?? []) if (esDelV2_5(id) && idEnLaCadena(id) < total) aLeer.add(idEnLaCadena(id));
  const ventana = BigInt(delIndice !== null ? VENTANA_RECIENTE : TOPE_ESCANEO);
  for (let i = total > ventana ? total - ventana : 0n; i < total; i++) aLeer.add(i);
  const dirLc = direccion.toLowerCase();
  const leidas = await leerV2_5([...aLeer].sort((a, b) => (a > b ? 1 : a < b ? -1 : 0)));
  return leidas.filter((t) => t.worker.toLowerCase() === dirLc);
}

/* ── la cartera: varios agentes de una vez ───────────────────────────────── */

/**
 * Todos los agentes que sigues, en UNA consulta.
 *
 * Se lee todo junto y no con un hook por fila porque el total tiene que salir
 * de la misma foto que las filas: con una consulta por agente, la suma de
 * arriba iría cambiando mientras van llegando y por un momento diría una cifra
 * que no es la de ninguna lista.
 *
 * Son tres lecturas por agente —ficha y las dos monedas— más el escaneo de sus
 * encargos abiertos. Con nueve agentes son 27 lecturas y un escaneo del escrow
 * compartido por todos, que es lo que cuesta ver una cartera entera.
 */
export function useCartera(direcciones: string[]) {
  const claves = direcciones.map((d) => d.toLowerCase()).sort();

  return useQuery<FilaCartera[]>({
    queryKey: ['cartera', activeChain.id, claves.join(',')],
    enabled: claves.length > 0,
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      const ahora = Math.floor(Date.now() / 1000);
      // Las tareas abiertas se sacan del escrow UNA vez y se reparten: pedir
      // las de cada agente por separado repetiría el mismo recorrido nueve
      // veces contra un RPC público.
      const abiertasPorAgente = await abiertasDe(claves);

      const filas = await Promise.all(
        claves.map(async (dir): Promise<FilaCartera> => {
          const [ficha, pendiente] = await Promise.all([
            publicClient.readContract({
              address: PANAL_REGISTRY_V2_ADDRESS,
              abi: panalRegistryV2Abi,
              functionName: 'getAgent',
              args: [dir as Address],
            }) as Promise<{
              metadataURI: string;
              pricePerTask: bigint;
              active: boolean;
              registeredAt: bigint;
              currency: Address;
            }>,
            leerPendiente(dir as Address),
          ]);

          const suyas = abiertasPorAgente.get(dir) ?? [];
          return {
            direccion: dir,
            nombre: partirFicha(ficha.metadataURI ?? '').nombre || `${dir.slice(0, 6)}…${dir.slice(-4)}`,
            registrado: ficha.registeredAt > 0n,
            activo: ficha.active,
            precio: ficha.pricePerTask,
            moneda:
              ficha.currency?.toLowerCase() === PANAL_TOKEN_ADDRESS.toLowerCase() ? '$PANAL' : 'MON',
            conEndpoint: extractBotUrl(ficha.metadataURI) !== null,
            panal: pendiente.panal,
            mon: pendiente.mon,
            usdc: pendiente.usdc,
            firmas: pendiente.lista.length,
            vencidos: suyas.filter((t) => t < ahora).length,
            abiertos: suyas.filter((t) => t >= ahora).length,
          };
        }),
      );
      return filas;
    },
  });
}

/**
 * Los plazos de los encargos ABIERTOS de cada agente, en un solo recorrido.
 *
 * Solo mira la cola del escrow: un encargo abierto es reciente por definición
 * —o venció, y entonces sigue estando en esa cola salvo que sea muy viejo—.
 * Recorrer las 61 tareas enteras por cada carga de pantalla sería castigar un
 * RPC público para enseñar un contador.
 */
async function abiertasDe(direcciones: string[]): Promise<Map<string, number[]>> {
  const salida = new Map<string, number[]>();
  const total = Number(
    (await publicClient.readContract({
      address: PANAL_ESCROW_V2_ADDRESS,
      abi: panalEscrowV2Abi,
      functionName: 'getTaskCount',
    })) as bigint,
  );

  const buscadas = new Set(direcciones);
  const desde = Math.max(0, total - VENTANA_CARTERA);

  for (let i = desde; i < total; i += LOTE) {
    const lote = Array.from({ length: Math.min(LOTE, total - i) }, (_, j) => BigInt(i + j));
    const filas = await Promise.all(
      lote.map(
        (id) =>
          publicClient.readContract({
            address: PANAL_ESCROW_V2_ADDRESS,
            abi: panalEscrowV2Abi,
            functionName: 'tasks',
            args: [id],
          }) as Promise<{ worker: Address; deadline: bigint; status: number }>,
      ),
    );
    for (const f of filas) {
      if (Number(f.status) !== 0) continue;
      const w = f.worker.toLowerCase();
      if (!buscadas.has(w)) continue;
      salida.set(w, [...(salida.get(w) ?? []), Number(f.deadline)]);
    }
    if (i + LOTE < total) await dormir(RESPIRO_MS);
  }

  // Y la cola del v2.5: abiertas son las que nadie ha entregado todavía,
  // aceptadas o no.
  try {
    const total25 = await cuentaV2_5();
    const ventana = BigInt(VENTANA_CARTERA);
    const ids: bigint[] = [];
    for (let i = total25 > ventana ? total25 - ventana : 0n; i < total25; i++) ids.push(i);
    for (const t of await leerV2_5(ids)) {
      if (t.status !== 0) continue;
      const w = t.worker.toLowerCase();
      if (!buscadas.has(w)) continue;
      salida.set(w, [...(salida.get(w) ?? []), Number(t.deadline)]);
    }
  } catch (e) {
    console.warn('[panal] la cartera no pudo leer el escrow v2.5', e);
  }
  return salida;
}

export function useTareasDe(direccion: string | undefined) {
  return useQuery<TareaDeAgente[]>({
    queryKey: ['tareas-de', activeChain.id, direccion?.toLowerCase()],
    enabled: !!direccion && esDireccion(direccion),
    queryFn: () => tareasDe(direccion as Address),
    staleTime: 10_000,
    refetchInterval: 20_000,
    refetchIntervalInBackground: false,
    retry: 1,
  });
}
