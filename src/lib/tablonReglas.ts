/**
 * Panal — el tablón con reglas (PanalTablon): lo que leen y firman la web y la
 * app. La interfaz está en `pages/Tablon.tsx` (web) y en la app; aquí, el
 * dinero y los datos, que son lo que comparten.
 *
 * QUÉ CAMBIA RESPECTO AL TABLÓN DEL ESCROW
 *
 * Aquel era `createTask(worker = 0)`: el primero que llegaba se lo quedaba. En
 * este el dinero espera en PanalTablon y la tarea del escrow nace YA asignada
 * al agente que pasa las reglas (nivel, cupo, categoría, sanciones). Dos
 * consecuencias que se ven en todo este archivo:
 *
 *   - En el escrow, el CLIENTE de esas tareas es PanalTablon. Quien publicó
 *     aprueba y disputa llamando al tablón, que lo reenvía; el escrow no le
 *     conoce.
 *   - Los textos van por número de ENCARGO, no de tarea, y bajo la dirección
 *     del tablón en el buzón (`/buzon/<tablón>/…`).
 *
 * LECTURAS EN BLOQUE. Una fila del tablón son varias lecturas (el encargo, sus
 * ofertas, su tarea del escrow), y el RPC público limita. Van por Multicall3:
 * cincuenta encargos son una sola petición.
 *
 * DOS TABLONES (24-nov-2026). Lo nuevo se publica en el tablón v2.5, que
 * reparte en el escrow v2.5 y admite USDC; el v2 sigue para lo que ya estaba
 * en marcha. Igual que las tareas, los encargos del v2.5 llevan FUERA DE LA
 * CADENA su número más mil millones: con ese número se elige el contrato
 * (`enTablon`) y el buzón (`buzonDelTablon`), y a la cadena va el de verdad.
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  keccak256,
  maxUint256,
  toBytes,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import {
  MAX_FILE_BYTES,
  REVISION_POR_DEFECTO_S,
  comoTask,
  esDelV2_5,
  idDelV2_5,
  idEnLaCadena,
  panalCurrenciesAbi,
  panalEscrowV2_5Abi,
  panalTablonV2_5Abi,
  tareaV2_5DeLaCadena,
  type VersionEscrow,
  encargoDeLaCadena,
  ofertaDeLaCadena,
  panalTablonAbi,
  sanitizeFileName,
  situacionDe,
  tablonArchivoSignMessage,
  tablonEncargoSignMessage,
  tablonEntregaSignMessage,
  tablonResultadoSignMessage,
  verifyFileBytes,
  type Acceso,
  type ArchivoParaSubir,
  type EncargoConReglas,
  type HashedFile,
  type OfertaConReglas,
  type SituacionEnElTablon,
} from '@panal/sdk';
import {
  MULTICALL3_ADDRESS,
  NATIVE_CURRENCY,
  PANAL_CURRENCIES_ADDRESS,
  PANAL_ESCROW_V2_5_ADDRESS,
  PANAL_ESCROW_V2_ADDRESS,
  PANAL_TABLON_ADDRESS,
  PANAL_TABLON_V2_5_ADDRESS,
  PANAL_TOKEN_ADDRESS,
  USDC_TOKEN_ADDRESS,
  V2_5_ENABLED,
  currencySymbol,
  publicClient,
  type SimboloMoneda,
} from '@/contracts/config';
import { panalEscrowV2Abi } from '@/contracts/abis';
import { BUZON_BASE, cabecerasFirma, expiraEn } from '@/lib/botEndpoint';
import { nombreEnBuzon } from '@/lib/cifrado';
import { llamadaDeEscrow } from '@/lib/escrow';

const TABLON = PANAL_TABLON_ADDRESS as Address;
const TABLON_V2_5 = PANAL_TABLON_V2_5_ADDRESS as Address;
const ABI = panalTablonAbi as unknown as Abi;
const ABI_V2_5 = panalTablonV2_5Abi as unknown as Abi;

/** Dónde se publica lo nuevo: el tablón v2.5 en mainnet, el v2 donde no está. */
export const VERSION_PARA_PUBLICAR: VersionEscrow = V2_5_ENABLED ? 'v2_5' : 'v2';

/** De qué tablón es un encargo, por su número de fuera de la cadena. */
export function versionDelEncargo(jobId: bigint): VersionEscrow {
  return esDelV2_5(jobId) ? 'v2_5' : 'v2';
}

function tablonDe(version: VersionEscrow): { address: Address; abi: Abi } {
  return version === 'v2_5' ? { address: TABLON_V2_5, abi: ABI_V2_5 } : { address: TABLON, abi: ABI };
}

/** El buzón de un tablón: los textos van bajo su dirección. */
function buzonDe(version: VersionEscrow): string {
  return `${BUZON_BASE}/${version === 'v2_5' ? PANAL_TABLON_V2_5_ADDRESS : PANAL_TABLON_ADDRESS}`;
}

/** El buzón donde viven los textos de un encargo (por su número de fuera). */
export function buzonDelTablon(jobId: bigint): string {
  return buzonDe(versionDelEncargo(jobId));
}

/** El buzón del tablón donde se publica ahora. */
export const BUZON_PARA_PUBLICAR = buzonDe(VERSION_PARA_PUBLICAR);

/** Encargos por llamada a Multicall3. Cincuenta structs caben de sobra. */
const POR_LOTE = 50;

/** Gas como mucho para una firma en el tablón: la que más gasta crea la tarea. */
const TOPE_GAS = 3_000_000n;

/** Las monedas de cada tablón: MON y $PANAL en el v2; además USDC en el v2.5. */
export const MONEDAS_DE_TABLON: Record<VersionEscrow, readonly Address[]> = {
  v2: [NATIVE_CURRENCY, PANAL_TOKEN_ADDRESS as Address],
  v2_5: [NATIVE_CURRENCY, PANAL_TOKEN_ADDRESS as Address, USDC_TOKEN_ADDRESS],
};

/** Las monedas en que se puede publicar ahora. */
export const MONEDAS_TABLON = MONEDAS_DE_TABLON[VERSION_PARA_PUBLICAR];

/**
 * Una tarea del escrow que repartió PanalTablon: en el escrow, su cliente es el
 * tablón, no quien publicó. Se enseña como «Tablón», no como una dirección.
 * Cualquiera de los dos tablones.
 */
export function esDelTablon(cliente: string): boolean {
  const c = cliente.toLowerCase();
  return c === PANAL_TABLON_ADDRESS.toLowerCase() || c === PANAL_TABLON_V2_5_ADDRESS.toLowerCase();
}

export function simboloDe(moneda: Address): SimboloMoneda {
  return currencySymbol(moneda);
}

/* ── lecturas ─────────────────────────────────────────────────────────── */

async function enBloque<T>(llamadas: { functionName: string; args?: readonly unknown[]; address?: Address; abi?: Abi }[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < llamadas.length; i += POR_LOTE) {
    const lote = llamadas.slice(i, i + POR_LOTE).map((l) => ({
      address: l.address ?? TABLON,
      abi: l.abi ?? ABI,
      functionName: l.functionName,
      args: l.args ?? [],
    }));
    const res = await publicClient.multicall({
      contracts: lote as never,
      multicallAddress: MULTICALL3_ADDRESS,
      allowFailure: false,
    });
    out.push(...(res as T[]));
  }
  return out;
}

/** Los últimos `limite` encargos de un tablón, con su número de fuera de la cadena. */
async function encargosDe(version: VersionEscrow, limite: number): Promise<EncargoConReglas[]> {
  const tablon = tablonDe(version);
  const total = (await publicClient.readContract({ ...tablon, functionName: 'jobCount' })) as bigint;
  const ids: bigint[] = [];
  for (let i = total - 1n; i >= 0n && ids.length < limite; i--) ids.push(i);
  if (ids.length === 0) return [];
  const crudos = await enBloque<Record<string, unknown>>(ids.map((id) => ({ ...tablon, functionName: 'getJob', args: [id] })));
  return crudos.map((j, k) =>
    version === 'v2_5' ? encargoDeLaCadena(idDelV2_5(ids[k]!), j, 'v2_5') : encargoDeLaCadena(ids[k]!, j),
  );
}

/**
 * Los últimos encargos de los dos tablones, del más nuevo al más viejo, en
 * cualquier estado. Si el v2.5 no responde, quedan los del v2 (y al revés).
 */
export async function leerEncargos(limite = 200): Promise<EncargoConReglas[]> {
  const [v25, v2] = await Promise.all([
    V2_5_ENABLED ? encargosDe('v2_5', limite).catch(() => [] as EncargoConReglas[]) : Promise.resolve([]),
    encargosDe('v2', limite),
  ]);
  return [...v25, ...v2].sort((a, b) => b.publicadoEn - a.publicadoEn).slice(0, limite);
}

/** Las ofertas de varios encargos de selección, por número de encargo (de fuera). */
export async function leerOfertas(ids: bigint[]): Promise<Map<string, OfertaConReglas[]>> {
  const out = new Map<string, OfertaConReglas[]>();
  if (ids.length === 0) return out;
  const listas = await enBloque<readonly Record<string, unknown>[]>(
    ids.map((id) => ({ ...tablonDe(versionDelEncargo(id)), functionName: 'offers', args: [idEnLaCadena(id)] })),
  );
  listas.forEach((lista, k) => out.set(ids[k]!.toString(), lista.map(ofertaDeLaCadena)));
  return out;
}

/** Lo que importa de una tarea del escrow para el tablón. */
export interface TareaDelTablon {
  /** 0 abierta · 1 entregada · 2 completada · 3 en disputa · 4 cancelada. */
  estado: number;
  plazo: number;
  resultHash: Hex;
  entregadaEn: number;
  disputadaEn: number;
  /** Solo v2.5: la revisión de esta tarea, en segundos (en el v2, la de `ReglasDelTablon`). */
  revisionS?: number;
}

/** Las tareas del escrow de los encargos asignados, por id de tarea (de fuera de la cadena). */
export async function leerTareas(taskIds: bigint[]): Promise<Map<string, TareaDelTablon>> {
  const out = new Map<string, TareaDelTablon>();
  const delV2 = taskIds.filter((id) => !esDelV2_5(id));
  const delV25 = taskIds.filter((id) => esDelV2_5(id));
  if (delV2.length > 0) {
    const escrow = { address: PANAL_ESCROW_V2_ADDRESS as Address, abi: panalEscrowV2Abi as unknown as Abi };
    const res = await enBloque<unknown>(
      delV2.flatMap((id) => [
        { ...escrow, functionName: 'tasks', args: [id] },
        { ...escrow, functionName: 'deliveredAt', args: [id] },
        { ...escrow, functionName: 'disputedAt', args: [id] },
      ]),
    );
    delV2.forEach((id, k) => {
      const t = res[k * 3] as { status: number; deadline: bigint; resultHash: Hex };
      out.set(id.toString(), {
        estado: Number(t.status),
        plazo: Number(t.deadline),
        resultHash: t.resultHash,
        entregadaEn: Number(res[k * 3 + 1] as bigint),
        disputadaEn: Number(res[k * 3 + 2] as bigint),
      });
    });
  }
  if (delV25.length > 0) {
    // En el v2.5, `getTask` trae todo de una vez; el estado se da con la forma
    // del v2 (aceptada cuenta como abierta: todavía se entrega).
    const escrow = { address: PANAL_ESCROW_V2_5_ADDRESS as Address, abi: panalEscrowV2_5Abi as unknown as Abi };
    const res = await enBloque<Record<string, unknown>>(
      delV25.map((id) => ({ ...escrow, functionName: 'getTask', args: [idEnLaCadena(id)] })),
    );
    delV25.forEach((id, k) => {
      const t = tareaV2_5DeLaCadena(id, res[k]!);
      out.set(id.toString(), {
        estado: Number(comoTask(t).status),
        plazo: Number(t.deadline),
        resultHash: t.resultHash,
        entregadaEn: Number(t.deliveredAt),
        disputadaEn: Number(t.disputedAt),
        revisionS: t.reviewWindow,
      });
    });
  }
  return out;
}

/** Los topes de la beta, lo que ya ocupa cada moneda y los mínimos: los del tablón donde se publica. */
export interface ReglasDelTablon {
  /** Solo el tablón v2 se podía pausar; el v2.5 no tiene pausa. */
  pausado: boolean;
  /**
   * Por moneda (dirección en minúsculas). 0 = sin tope. (En el tablón V3 el
   * «sin tope» es el máximo de uint256, y aquí se traduce a 0; un 0 de verdad
   * en el V3 es «moneda cerrada», y el contrato rechaza la publicación.)
   */
  topes: Record<string, { porEncargo: bigint; total: bigint; ocupado: bigint }>;
  /** El mínimo por encargo, por moneda (dirección en minúsculas). */
  minimos: Record<string, bigint>;
  /**
   * La revisión de las tareas del v2 (72 h, `AUTO_RELEASE`), en segundos. Las
   * del v2.5 traen la suya (`TareaDelTablon.revisionS`).
   */
  liberacionS: number;
  /** Lo que tarda en caducar una disputa (14 días en los dos escrows). */
  disputaS: number;
}

export async function leerReglas(): Promise<ReglasDelTablon> {
  const escrow = { address: PANAL_ESCROW_V2_ADDRESS as Address, abi: panalEscrowV2Abi as unknown as Abi };
  const tablon = tablonDe(VERSION_PARA_PUBLICAR);
  const es25 = VERSION_PARA_PUBLICAR === 'v2_5';
  const monedas = MONEDAS_TABLON;
  // Los mínimos: en el v2, MIN_NATIVE y MIN_TOKEN del tablón; en el V3 (hueco
  // del v2.5), los de la lista de monedas, uno por moneda.
  const lista = { address: PANAL_CURRENCIES_ADDRESS as Address, abi: panalCurrenciesAbi as unknown as Abi };
  const minimos25 = monedas.map((m) => ({ ...lista, functionName: 'minAmount', args: [m] }));
  const minimosV2 = ['MIN_NATIVE', 'MIN_TOKEN'].map((n) => ({ ...tablon, functionName: n }));
  const [liberacion, disputa, ...resto] = await enBloque<unknown>([
    { ...escrow, functionName: 'AUTO_RELEASE' },
    { ...escrow, functionName: 'DISPUTE_TIMEOUT' },
    ...(es25 ? [] : [{ ...tablon, functionName: 'paused' }]),
    ...(es25 ? minimos25 : minimosV2),
    ...monedas.flatMap((m) => [
      { ...tablon, functionName: 'caps', args: [m] },
      { ...tablon, functionName: 'books', args: [m] },
    ]),
  ]);
  const pausado = es25 ? false : Boolean(resto.shift());
  const minimos: Record<string, bigint> = {};
  monedas.forEach((m) => {
    minimos[m.toLowerCase()] = resto.shift() as bigint;
  });
  const topes: ReglasDelTablon['topes'] = {};
  monedas.forEach((m, k) => {
    const [porEncargo, total] = (resto[k * 2] as readonly [bigint, bigint]).map((x) => (x === maxUint256 ? 0n : x));
    // `books`: (posted, inEscrow, owedTotal[, pulled, attributed] en el v2).
    const [posted, inEscrow] = resto[k * 2 + 1] as readonly bigint[];
    topes[m.toLowerCase()] = { porEncargo: porEncargo!, total: total!, ocupado: posted! + inEscrow! };
  });
  return {
    pausado,
    topes,
    minimos,
    liberacionS: Number(liberacion as bigint),
    disputaS: Number(disputa as bigint),
  };
}

/** Cuándo se puede liberar una tarea del tablón entregada (unix), o null. */
export function liberableDesde(tarea: TareaDelTablon, reglas: ReglasDelTablon | undefined): number | null {
  const revision = tarea.revisionS ?? reglas?.liberacionS;
  return revision === undefined ? null : tarea.entregadaEn + revision;
}

/** La revisión que se pone a los encargos que se publican ahora (v2.5). */
export const REVISION_AL_PUBLICAR_S = REVISION_POR_DEFECTO_S;

/** Nivel, cupo, suspensión y categorías de un agente, en el tablón donde se publica ahora. */
export async function leerSituacion(agente: Address): Promise<SituacionEnElTablon> {
  const tablon = tablonDe(VERSION_PARA_PUBLICAR);
  const [[nivel, cupo], stats, novato, mascara] = (await enBloque<unknown>([
    { ...tablon, functionName: 'levelOf', args: [agente] },
    { ...tablon, functionName: 'agentStats', args: [agente] },
    { ...tablon, functionName: 'newcomerJobs' },
    { ...tablon, functionName: 'categoryMask', args: [agente] },
  ])) as [readonly [number, number], readonly [number, number, number, number, bigint], number, bigint];
  return situacionDe(
    {
      nivel: Number(nivel),
      cupoDiario: Number(cupo),
      stats: {
        day: Number(stats[0]),
        takenToday: Number(stats[1]),
        open: Number(stats[2]),
        newcomerUsed: Number(stats[3]),
        suspendedUntil: Number(stats[4]),
      },
      encargosDeNovato: Number(novato),
      mascara,
    },
    Math.floor(Date.now() / 1000),
  );
}

/** Lo que un tablón le debe a alguien en una moneda. */
export interface Deuda {
  version: VersionEscrow;
  moneda: Address;
  cantidad: bigint;
}

/** Lo que los dos tablones le deben a una dirección, por tablón y moneda (solo lo que no es cero). */
export async function leerDeuda(quien: Address): Promise<Deuda[]> {
  const pares = (V2_5_ENABLED ? (['v2_5', 'v2'] as const) : (['v2'] as const)).flatMap((version) =>
    MONEDAS_DE_TABLON[version].map((moneda) => ({ version, moneda })),
  );
  const res = await enBloque<bigint>(
    pares.map(({ version, moneda }) => ({ ...tablonDe(version), functionName: 'owed', args: [quien, moneda] })),
  );
  return pares.map((p, k) => ({ ...p, cantidad: res[k]! })).filter((d) => d.cantidad > 0n);
}

/** Si un agente puede coger u ofertar en cada encargo, y por qué no. */
export async function leerPermisos(agente: Address, ids: bigint[]): Promise<Map<string, { ok: boolean; motivo: string }>> {
  const out = new Map<string, { ok: boolean; motivo: string }>();
  if (ids.length === 0) return out;
  const res = await enBloque<readonly [boolean, string]>(
    ids.map((id) => ({ ...tablonDe(versionDelEncargo(id)), functionName: 'canTake', args: [agente, idEnLaCadena(id)] })),
  );
  res.forEach(([ok, motivo], k) => out.set(ids[k]!.toString(), { ok, motivo }));
  return out;
}

/* ── el buzón ─────────────────────────────────────────────────────────── */

/**
 * Los anuncios, comprobados contra el `advertHash` de cada encargo. Uno que no
 * cuadre no sale: el buzón puede dejar de servir, pero no inventarse un anuncio.
 */
export async function leerAnuncios(
  encargos: EncargoConReglas[],
): Promise<{ anuncios: Map<string, string>; confidenciales: Set<string> }> {
  const out = new Map<string, string>();
  const confidenciales = new Set<string>();
  // Los de los dos tablones: cada buzón tiene los suyos.
  const versiones = V2_5_ENABLED ? (['v2_5', 'v2'] as const) : (['v2'] as const);
  const listas = await Promise.all(
    versiones.map(async (v) => {
      try {
        const res = await fetch(`${buzonDe(v)}/lista`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return [];
        const cuerpo = (await res.json()) as { anuncios?: { jobId: string; anuncio: string; cifrado?: boolean }[] };
        return cuerpo.anuncios ?? [];
      } catch {
        return [];
      }
    }),
  );
  const anuncios = listas.flat();
  const hashes = new Map(encargos.map((j) => [j.id.toString(), j.advertHash.toLowerCase()]));
  for (const a of anuncios) {
    if (typeof a.anuncio !== 'string') continue;
    if (hashes.get(a.jobId) !== keccak256(toBytes(a.anuncio)).toLowerCase()) continue;
    out.set(a.jobId, a.anuncio);
    // Lo dice el buzón y no la cadena: si mintiera, lo que cambia es un aviso,
    // y quien coja el encargo lo verá al abrirlo.
    if (a.cifrado === true) confidenciales.add(a.jobId);
  }
  return { anuncios: out, confidenciales };
}

/**
 * Si el buzón acepta ya los textos de este tablón. Se pregunta ANTES de
 * publicar: si no, el dinero quedaría depositado con un encargo que nadie
 * puede leer. Pasó el día del despliegue: el buzón de producción aún no tenía
 * la dirección del tablón y respondía «not found» a todo.
 */
export async function buzonAceptaElTablon(): Promise<boolean> {
  try {
    const res = await fetch(`${BUZON_PARA_PUBLICAR}/lista`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return false;
    const cuerpo = (await res.json()) as { anuncios?: unknown };
    return Array.isArray(cuerpo.anuncios);
  } catch {
    return false;
  }
}

/**
 * Si el buzón del tablón ya guarda archivos. Se pregunta ANTES de cobrar un
 * encargo con adjuntos: un buzón anterior a los archivos aceptaría el encargo
 * y no sus bytes, y el agente cobraría por algo que no puede abrir. Un POST sin
 * credenciales a la ruta de archivos: el que la conoce contesta 400 (faltan
 * credenciales); el que no, 404.
 */
export async function buzonAceptaArchivos(): Promise<boolean> {
  try {
    // Un número del tablón donde se publica: el buzón rechaza con 404 los del otro.
    const cero = VERSION_PARA_PUBLICAR === 'v2_5' ? idDelV2_5(0n) : 0n;
    const res = await fetch(`${BUZON_PARA_PUBLICAR}/archivo/${cero.toString()}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    });
    return res.status !== 404;
  } catch {
    return false;
  }
}

/**
 * Deja el anuncio y el encargo de un encargo ya publicado. Sin firma: el buzón
 * solo acepta los textos que dan los hashes que la cadena guardó. Repetirlo no
 * molesta, así que sirve para reintentar.
 */
export async function guardarTextos(jobId: bigint, anuncio: string, encargo: string): Promise<void> {
  for (const [ruta, campo, texto] of [
    ['anuncio', 'anuncio', anuncio],
    ['brief', 'brief', encargo],
  ] as const) {
    const res = await fetch(`${buzonDelTablon(jobId)}/${ruta}/${jobId.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [campo]: texto }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${ruta}: HTTP ${res.status}`);
  }
}

type Firmar = (mensaje: string) => Promise<string>;

/**
 * El encargo privado: lo leen su cliente y su agente. Se comprueba contra el
 * `taskHash` de la cadena. `null` si el buzón no lo tiene.
 */
export async function leerEncargoPrivado(job: EncargoConReglas, yo: Address, firmar: Firmar): Promise<string | null> {
  return (await leerEncargoConFirma(job, await credencialTablon('encargo', job.id, yo, firmar))).brief;
}

/**
 * Una firma para leer del buzón del tablón, que vale unos minutos. Se guarda y
 * se reutiliza: con la misma que abre el encargo se bajan sus adjuntos, y con
 * la que abre la entrega, sus archivos. Una ventana de la wallet, no cinco.
 */
export interface CredencialTablon {
  yo: Address;
  firma: string;
  expira: number;
}

export async function credencialTablon(
  tipo: 'encargo' | 'resultado' | 'archivo',
  jobId: bigint,
  yo: Address,
  firmar: Firmar,
): Promise<CredencialTablon> {
  const expira = expiraEn();
  const mensaje =
    tipo === 'encargo'
      ? tablonEncargoSignMessage(jobId, expira)
      : tipo === 'resultado'
        ? tablonResultadoSignMessage(jobId, expira)
        : tablonArchivoSignMessage(jobId, expira);
  return { yo, firma: await firmar(mensaje), expira };
}

/** Si una credencial sigue sirviendo un rato más (un minuto de margen). */
export function credencialVigente(c: CredencialTablon | null): c is CredencialTablon {
  return !!c && c.expira > Math.floor(Date.now() / 1000) + 60;
}

/** El encargo privado con una credencial ya firmada (la de `encargo`). */
export async function leerEncargoConFirma(
  job: EncargoConReglas,
  cred: CredencialTablon,
): Promise<{ brief: string | null; cred: CredencialTablon; accesos: Acceso[] }> {
  const res = await fetch(`${buzonDelTablon(job.id)}/encargo/${job.id.toString()}`, {
    headers: cabecerasFirma(cred.yo, cred.firma, cred.expira),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return { brief: null, cred, accesos: [] };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { brief, accesos } = (await res.json()) as { brief?: unknown; accesos?: unknown };
  if (typeof brief !== 'string' || keccak256(toBytes(brief)).toLowerCase() !== job.taskHash.toLowerCase()) {
    throw new Error('no cuadra con el taskHash');
  }
  // Los accesos que te han dado, si el encargo va cifrado y no eras de sus
  // destinatarios —el cliente te lo dio al elegirte—.
  return { brief, cred, accesos: Array.isArray(accesos) ? (accesos as Acceso[]) : [] };
}

/**
 * Deja la entrega en el buzón. Va ANTES de anclarla en el escrow: al revés, un
 * fallo del buzón dejaría al cliente con una entrega anclada que no puede leer.
 * La firma lleva el hash dentro, así que vale solo para ESTE texto.
 */
export async function dejarEntrega(jobId: bigint, texto: string, yo: Address, firmar: Firmar): Promise<Hex> {
  const hash = keccak256(toBytes(texto));
  const expira = expiraEn();
  const firma = await firmar(tablonEntregaSignMessage(jobId, hash, expira));
  const res = await fetch(`${buzonDelTablon(jobId)}/entrega/${jobId.toString()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entrega: texto, address: yo, signature: firma, expira }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return hash;
}

/** La entrega, para su cliente, comprobada contra el `resultHash` del escrow. */
export async function leerEntrega(jobId: bigint, resultHash: Hex, yo: Address, firmar: Firmar): Promise<string | null> {
  return (await leerEntregaConFirma(jobId, resultHash, await credencialTablon('resultado', jobId, yo, firmar))).texto;
}

/** La entrega con una credencial ya firmada (la de `resultado`), para reutilizarla en sus archivos. */
export async function leerEntregaConFirma(
  jobId: bigint,
  resultHash: Hex,
  cred: CredencialTablon,
): Promise<{ texto: string | null; cred: CredencialTablon; accesos: Acceso[] }> {
  const res = await fetch(`${buzonDelTablon(jobId)}/result/${jobId.toString()}`, {
    headers: cabecerasFirma(cred.yo, cred.firma, cred.expira),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return { texto: null, cred, accesos: [] };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { resultText, accesos } = (await res.json()) as { resultText?: unknown; accesos?: unknown };
  if (typeof resultText !== 'string' || keccak256(toBytes(resultText)).toLowerCase() !== resultHash.toLowerCase()) {
    throw new Error('no cuadra con el resultHash');
  }
  return { texto: resultText, cred, accesos: Array.isArray(accesos) ? (accesos as Acceso[]) : [] };
}

/* ── archivos ─────────────────────────────────────────────────────────── */

/**
 * Sube archivos al buzón del tablón: los adjuntos del cliente (después de dejar
 * el encargo, que los anuncia) o los de la entrega del agente (antes de dejar
 * la entrega, que los anunciará). Una firma para todos. Repetir no ocupa más.
 */
export async function subirArchivosDelTablon(
  jobId: bigint,
  archivos: ArchivoParaSubir[],
  yo: Address,
  firmar: Firmar,
  alSubir?: (hechos: number) => void,
): Promise<void> {
  if (archivos.length === 0) return;
  const cred = await credencialTablon('archivo', jobId, yo, firmar);
  let hechos = 0;
  for (const a of archivos) {
    const nombre = sanitizeFileName(a.name);
    const res = await fetch(`${buzonDelTablon(jobId)}/archivo/${jobId.toString()}`, {
      method: 'POST',
      headers: {
        ...cabecerasFirma(cred.yo, cred.firma, cred.expira),
        'content-type': a.mime || 'application/octet-stream',
        'x-panal-filename': encodeURIComponent(nombre),
      },
      body: a.bytes as unknown as BodyInit,
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`«${nombre}»: HTTP ${res.status}`);
    alSubir?.(++hechos);
  }
}

/** El texto de la entrega con sus archivos: la del SDK, la misma que firma la plantilla. */
export { entregaConArchivos } from '@panal/sdk';

/**
 * Un archivo del tablón, comprobado byte a byte contra el hash del texto
 * anclado. `adjunto`: del encargo; `entrega`: de la entrega. La credencial es
 * la misma con la que se leyó ese texto.
 */
export async function bajarArchivoDelTablon(
  jobId: bigint,
  archivo: HashedFile,
  de: 'adjunto' | 'entrega',
  cred: CredencialTablon,
  cifrado = false,
): Promise<Uint8Array> {
  // Si el texto que lo anuncia iba cifrado, el buzón lo guarda con un nombre
  // opaco: el de verdad solo lo sabe quien leyó ese texto.
  const nombre = cifrado ? nombreEnBuzon(archivo.hash) : sanitizeFileName(archivo.name);
  const res = await fetch(
    `${buzonDelTablon(jobId)}/archivo/${jobId.toString()}/${encodeURIComponent(nombre)}?de=${de}`,
    { headers: cabecerasFirma(cred.yo, cred.firma, cred.expira), signal: AbortSignal.timeout(180_000) },
  );
  if (!res.ok) throw new Error(`«${nombre}»: HTTP ${res.status}`);
  const largo = Number(res.headers.get('content-length') ?? 0);
  if (largo > MAX_FILE_BYTES) throw new Error(`«${nombre}» pasa del tope`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  verifyFileBytes(archivo, bytes);
  return bytes;
}

/* ── firmar ───────────────────────────────────────────────────────────── */

/** Lo que se firma en PanalTablon: el gas va fijado por `gasParaTablon`. */
export interface FirmaEnTablon {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}

/** Funciones del tablón cuyo primer argumento es el número de un encargo. */
const CON_ENCARGO = new Set([
  'take',
  'applyFor',
  'withdrawOffer',
  'withdrawJob',
  'choose',
  'autoAssign',
  'approve',
  'dispute',
  'settle',
  'expire',
  'attestResolution',
  // Solo v2.5:
  'proposeSettlement',
  'acceptSettlement',
  'extendDeadline',
]);

const CERO32 = `0x${'0'.repeat(64)}` as Hex;

/**
 * Una firma en el tablón que toca. Con un encargo (primer argumento), el de
 * su versión y su número de la cadena; sin él (publicar, categorías), el
 * tablón donde se publica ahora, salvo que se diga otro (`version`: cobrar lo
 * que debe cada tablón).
 */
export function enTablon(
  functionName: string,
  args: readonly unknown[],
  value?: bigint,
  version?: VersionEscrow,
): FirmaEnTablon {
  let v: VersionEscrow = version ?? VERSION_PARA_PUBLICAR;
  let a = args;
  if (CON_ENCARGO.has(functionName) && typeof args[0] === 'bigint') {
    v = versionDelEncargo(args[0]);
    a = [idEnLaCadena(args[0]), ...args.slice(1)];
  }
  // El v2.5 deja en la cadena la huella del motivo de la disputa; cero si no hay.
  if (functionName === 'dispute' && v === 'v2_5' && a.length === 1) a = [...a, CERO32];
  if (functionName === 'dispute' && v === 'v2_5' && typeof a[1] === 'string' && !a[1].startsWith('0x')) {
    a = [a[0], a[1].trim() ? keccak256(toBytes(a[1].trim())) : CERO32];
  }
  return { ...tablonDe(v), functionName, args: a, ...(value ? { value } : {}) };
}

/**
 * El gas con el que se firma: la estimación más un 10 %. Siempre explícito,
 * porque Monad cobra el límite entero y el nodo lo infla si se le deja
 * rellenarlo (ver `gasDeRetirada` en reservaDeGas.ts, 1,096 MON de lección).
 *
 * Y de paso, el mejor momento para saber si el contrato lo rechazaría: si la
 * estimación revierte, lanza `RechazoDelTablon` con el error por su nombre y
 * no se firma nada.
 */
export async function gasParaTablon(cuenta: Address, f: FirmaEnTablon): Promise<bigint> {
  let estimado: bigint;
  try {
    estimado = await publicClient.estimateContractGas({ ...f, account: cuenta } as never);
  } catch (err) {
    throw rechazoDe(err) ?? err;
  }
  const gas = (estimado * 11n + 9n) / 10n;
  return gas > TOPE_GAS ? TOPE_GAS : gas;
}

/** El contrato dijo que no, con el nombre de su error y, si lo hay, el motivo. */
export class RechazoDelTablon extends Error {
  readonly error: string;
  readonly motivo: string | null;
  constructor(error: string, motivo: string | null) {
    super(motivo ? `${error}: ${motivo}` : error);
    this.name = 'RechazoDelTablon';
    this.error = error;
    this.motivo = motivo;
  }
}

/** Saca el error del contrato de lo que lanza viem, si lo hay. */
export function rechazoDe(err: unknown): RechazoDelTablon | null {
  if (err instanceof RechazoDelTablon) return err;
  if (!(err instanceof BaseError)) return null;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError) || !revert.data?.errorName) return null;
  const [primero] = (revert.data.args ?? []) as unknown[];
  return new RechazoDelTablon(revert.data.errorName, typeof primero === 'string' ? primero : null);
}

/**
 * La clave i18n de un motivo de `canTake`/`NotAllowed`. El contrato los da en
 * inglés y en texto («daily quota used»); aquí se convierten en una clave
 * («dailyQuotaUsed») para que cada idioma diga lo suyo.
 */
export function claveDeMotivo(motivo: string): string {
  return motivo
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+(.)/g, (_, c: string) => c.toUpperCase());
}

/* ── firmar y esperar ─────────────────────────────────────────────────── */

/** Lo que firma la wallet: el `writeContractAsync` de wagmi encaja tal cual. */
export type Escribir = (req: {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
  gas: bigint;
  chainId: number;
}) => Promise<Hex>;

/** La tx se minó pero revirtió: gastó gas y no cambió nada. */
export class TxRevertida extends Error {
  readonly hash: Hex;
  constructor(hash: Hex) {
    super(`revertida: ${hash}`);
    this.name = 'TxRevertida';
    this.hash = hash;
  }
}

/**
 * Firma con el gas fijado y espera a que salga bien. Si el contrato lo
 * rechazaría, lanza `RechazoDelTablon` ANTES de pedir la firma.
 */
export async function firmarYEsperar(escribir: Escribir, cuenta: Address, f: FirmaEnTablon): Promise<Hex> {
  const gas = await gasParaTablon(cuenta, f);
  const hash = await escribir({ ...f, gas, chainId: publicClient.chain!.id });
  const recibo = await publicClient.waitForTransactionReceipt({ hash });
  if (recibo.status !== 'success') throw new TxRevertida(hash);
  return hash;
}

const erc20 = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const satisfies Abi;

/**
 * Con un token ($PANAL, o USDC en el v2.5), el permiso EXACTO al tablón antes
 * de pagar. Nunca infinito: un fallo del contrato no puede llevarse más de lo
 * que se iba a pagar. Si ya hay permiso suficiente, no pide nada.
 *
 * `version`: el tablón al que se paga (el donde se publica, o el de un encargo
 * ya publicado, al elegir una oferta más cara).
 */
export async function permitirToken(
  escribir: Escribir,
  cuenta: Address,
  token: Address,
  importe: bigint,
  version: VersionEscrow = VERSION_PARA_PUBLICAR,
): Promise<Hex | null> {
  const tablon = tablonDe(version).address;
  const actual = (await publicClient.readContract({
    address: token,
    abi: erc20,
    functionName: 'allowance',
    args: [cuenta, tablon],
  })) as bigint;
  if (actual >= importe) return null;
  return firmarYEsperar(escribir, cuenta, { address: token, abi: erc20 as unknown as Abi, functionName: 'approve', args: [tablon, importe] });
}

/** Entregar en el escrow (el de la tarea): el agente ancla el hash de lo que dejó en el buzón. */
export function entregarEnEscrow(taskId: bigint, resultHash: Hex): FirmaEnTablon {
  const l = llamadaDeEscrow(taskId, { tipo: 'entregar', resultHash });
  return { address: l.address, abi: l.abi as unknown as Abi, functionName: l.functionName, args: l.args ?? [] };
}
