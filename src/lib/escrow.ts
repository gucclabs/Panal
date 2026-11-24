/**
 * Panal — el escrow de cada tarea: v2 o v2.5, y qué se puede hacer con ella.
 *
 * Desde la fase B la web contrata en el escrow v2.5 (24-nov-2026), y el v2
 * sigue vivo para lo que ya estaba en marcha. Los dos cuentan sus tareas desde
 * 0, así que FUERA DE LA CADENA las del v2.5 llevan su número más mil millones
 * (ver sdk/src/v2_5.ts). Todo lo que la web hace con una tarea pasa por aquí:
 * el número de fuera entra, y sale la llamada al contrato que toca con el
 * número de verdad. Un componente que no pase por aquí mandaría el número de
 * fuera al escrow v2, que revierte: falla, pero no toca la tarea de otro.
 *
 * Lo que cambia en el v2.5, y por eso las reglas van aquí y no repartidas:
 *   - quien trabaja acepta o rechaza; entregar sin aceptar también acepta;
 *   - la revisión dura lo que eligió el cliente (24 h a 7 días), no 72 h fijas;
 *   - disputar puede cualquiera de las dos partes, y solo durante la revisión;
 *   - cancelar: si nadie aceptó y pasó el tiempo de aceptar, o pasado el plazo
 *     sin entrega;
 *   - las dos partes pueden pactar un reparto sin juez;
 *   - liberar el pago al acabar la revisión lo puede hacer cualquiera.
 */

import { keccak256, toBytes, type Address, type Hex } from 'viem';
import {
  CierreV2_5,
  EstadoV2_5,
  esDelV2_5,
  idDelV2_5,
  idEnLaCadena,
  panalEscrowV2_5Abi,
  type VersionEscrow,
} from '@panal/sdk';
import { PANAL_ESCROW_V2_5_ADDRESS, PANAL_ESCROW_V2_ADDRESS } from '@/contracts/config';
import { panalEscrowV2Abi } from '@/contracts/abis';
import type { ContractActionRequest } from '@/hooks/useContractAction';

export { esDelV2_5, idDelV2_5, idEnLaCadena, EstadoV2_5, CierreV2_5 };
export type { VersionEscrow };

/** De qué escrow es una tarea, por su número de fuera de la cadena. */
export function versionDeTarea(id: bigint): VersionEscrow {
  return esDelV2_5(id) ? 'v2_5' : 'v2';
}

/**
 * Cómo se enseña el número de una tarea: «#140» en el v2 y «#5 · v2.5» en el
 * v2.5. El número de fuera (1000000005) es para las máquinas; una persona que
 * lo viera creería que hay mil millones de encargos.
 */
export function etiquetaTarea(id: bigint): string {
  return `#${numeroVisible(id)}`;
}

/** Lo mismo sin la almohadilla, para textos que ya la ponen («Tarea #{{id}}»). */
export function numeroVisible(id: bigint): string {
  return esDelV2_5(id) ? `${idEnLaCadena(id).toString()} · v2.5` : id.toString();
}

/** Dirección y ABI del escrow de una versión. */
export function escrowDe(version: VersionEscrow): { address: Address; abi: typeof panalEscrowV2Abi | typeof panalEscrowV2_5Abi } {
  return version === 'v2_5'
    ? { address: PANAL_ESCROW_V2_5_ADDRESS, abi: panalEscrowV2_5Abi }
    : { address: PANAL_ESCROW_V2_ADDRESS, abi: panalEscrowV2Abi };
}

/** Lo que se le puede pedir al escrow sobre una tarea. */
export type AccionDeEscrow =
  | { tipo: 'aprobar'; nota: number }
  | { tipo: 'disputar'; motivo?: string }
  | { tipo: 'cancelar' }
  /** Liberar el pago pasada la revisión: `autoRelease` en el v2, `release` en el v2.5. */
  | { tipo: 'liberar' }
  | { tipo: 'entregar'; resultHash: Hex }
  | { tipo: 'coger' }
  | { tipo: 'aceptar' }
  | { tipo: 'rechazar' }
  | { tipo: 'proponerAcuerdo'; repartoBps: number }
  | { tipo: 'aceptarAcuerdo'; repartoBps: number }
  | { tipo: 'ampliarPlazo'; plazo: bigint }
  /**
   * Una disputa sin decisión a los 14 días. En el v2 el dinero vuelve entero
   * al cliente; en el v2.5 se cierra a mitad y mitad.
   */
  | { tipo: 'cerrarDisputaCaducada' }
  /** Cumplir la decisión de los jueces autónomos cuando ya es firme (solo v2.5). */
  | { tipo: 'cumplirDecision' };

const CERO32 = `0x${'0'.repeat(64)}` as Hex;

/**
 * La llamada al contrato para una acción sobre la tarea `id` (número de fuera).
 * Lanza si la acción no existe en su versión: en el v2 no se acepta, ni se
 * rechaza, ni se pacta, ni se amplía el plazo.
 */
export function llamadaDeEscrow(id: bigint, a: AccionDeEscrow): ContractActionRequest {
  const version = versionDeTarea(id);
  const base = escrowDe(version);
  const n = idEnLaCadena(id);
  const solo25 = (): void => {
    if (version !== 'v2_5') throw new Error(`«${a.tipo}» solo existe en el escrow v2.5 (tarea #${id})`);
  };
  switch (a.tipo) {
    case 'aprobar':
      return { ...base, functionName: 'approveAndRelease', args: [n, a.nota] };
    case 'disputar':
      // En el v2.5 queda en la cadena la huella del motivo (cero si no hay).
      return version === 'v2_5'
        ? { ...base, functionName: 'openDispute', args: [n, a.motivo?.trim() ? keccak256(toBytes(a.motivo.trim())) : CERO32] }
        : { ...base, functionName: 'openDispute', args: [n] };
    case 'cancelar':
      return { ...base, functionName: 'cancelTask', args: [n] };
    case 'liberar':
      return version === 'v2_5'
        ? { ...base, functionName: 'release', args: [[n]] }
        : { ...base, functionName: 'autoRelease', args: [n] };
    case 'entregar':
      return { ...base, functionName: 'deliverResult', args: [n, a.resultHash] };
    case 'coger':
      return { ...base, functionName: 'claimTask', args: [n] };
    case 'aceptar':
      solo25();
      return { ...base, functionName: 'acceptTask', args: [n] };
    case 'rechazar':
      solo25();
      return { ...base, functionName: 'rejectTask', args: [n] };
    case 'proponerAcuerdo':
      solo25();
      return { ...base, functionName: 'proposeSettlement', args: [n, a.repartoBps] };
    case 'aceptarAcuerdo':
      solo25();
      return { ...base, functionName: 'acceptSettlement', args: [n, a.repartoBps] };
    case 'ampliarPlazo':
      solo25();
      return { ...base, functionName: 'extendDeadline', args: [n, a.plazo] };
    case 'cerrarDisputaCaducada':
      return version === 'v2_5'
        ? { ...base, functionName: 'resolveExpiredDispute', args: [n] }
        : { ...base, functionName: 'resolveStuckDispute', args: [n] };
    case 'cumplirDecision':
      solo25();
      return { ...base, functionName: 'finalizeRuling', args: [n] };
  }
}

// ── Las reglas de tiempo de una tarea ─────────────────────────────────────

/** Lo que hace falta de una tarea para decidir qué se puede hacer con ella. */
export interface TareaParaReglas {
  id: bigint;
  version: VersionEscrow;
  /** El estado con la forma del v2 (TASK_STATUS): abierta, entregada, completada, en disputa, cancelada. */
  status: number;
  worker: Address;
  deadline: bigint;
  createdAt?: bigint;
  deliveredAt?: bigint;
  disputedAt?: bigint;
  /** Solo v2.5. */
  aceptada?: boolean;
  acceptBy?: bigint;
  reviewWindow?: number;
}

/** El estado con la forma del v2 (el de `TASK_STATUS` de useMyTasks). */
export const ESTADO = { Abierta: 0, Entregada: 1, Completada: 2, EnDisputa: 3, Cancelada: 4 } as const;

/** La revisión del v2: 72 h fijas (`AUTO_RELEASE` del contrato). */
export const REVISION_V2_S = 72 * 60 * 60;
/**
 * Sin decisión en 14 días la disputa caduca (los dos escrows): en el v2 el
 * dinero vuelve entero al cliente, en el v2.5 se reparte a mitad y mitad.
 */
export const DISPUTA_CADUCA_S = 14 * 24 * 60 * 60;
/** El v2.5 no deja que el plazo pase de un año desde que se contrató (`MAX_DURATION`). */
export const DURACION_MAXIMA_S = 365 * 24 * 60 * 60;

/** Cuántos días enteros se le pueden añadir al plazo de una tarea del v2.5 (0 si ninguno). */
export function diasAmpliables(t: { deadline: bigint; createdAt?: bigint }): number {
  if (t.createdAt === undefined) return 0;
  const hueco = t.createdAt + BigInt(DURACION_MAXIMA_S) - t.deadline;
  return hueco > 0n ? Number(hueco / 86_400n) : 0;
}

const CERO = '0x0000000000000000000000000000000000000000';

/** Cuándo se libera sola (o se puede liberar) una entregada; null si no está entregada. */
export function finDeRevision(t: TareaParaReglas, revisionV2S = REVISION_V2_S): bigint | null {
  if (t.status !== ESTADO.Entregada || !t.deliveredAt) return null;
  const ventana = t.version === 'v2_5' ? (t.reviewWindow ?? 0) : revisionV2S;
  return t.deliveredAt + BigInt(ventana);
}

export interface QuePuede {
  /** Cliente. */
  aprobar: boolean;
  disputarComoCliente: boolean;
  cancelar: boolean;
  liberar: boolean;
  ampliarPlazo: boolean;
  /** Trabajador. */
  aceptar: boolean;
  rechazar: boolean;
  entregar: boolean;
  disputarComoTrabajador: boolean;
  /** Los dos (solo v2.5): pactar un reparto con la tarea viva. */
  pactar: boolean;
}

/**
 * Qué puede hacer cada parte AHORA, con las reglas del contrato de su versión.
 * Es para enseñar botones: el contrato vuelve a comprobarlo todo al firmar.
 */
export function quePuede(t: TareaParaReglas, ahoraS: number, revisionV2S = REVISION_V2_S): QuePuede {
  const ahora = BigInt(Math.floor(ahoraS));
  const abierta = t.status === ESTADO.Abierta;
  const entregada = t.status === ESTADO.Entregada;
  const enDisputa = t.status === ESTADO.EnDisputa;
  const fin = finDeRevision(t, revisionV2S);
  const enRevision = entregada && fin !== null && ahora < fin;
  const conTrabajador = t.worker.toLowerCase() !== CERO;
  const vencida = ahora > t.deadline;

  if (t.version === 'v2') {
    return {
      aprobar: entregada,
      disputarComoCliente: entregada,
      // El v2 deja cancelar lo abierto: sin trabajador siempre, con él pasado el plazo.
      cancelar: abierta && (!conTrabajador || vencida),
      liberar: entregada && fin !== null && ahora >= fin,
      ampliarPlazo: false,
      aceptar: false,
      rechazar: false,
      entregar: abierta && conTrabajador && !vencida,
      disputarComoTrabajador: false,
      pactar: false,
    };
  }

  const aceptada = abierta && t.aceptada === true;
  const sinAceptar = abierta && !t.aceptada;
  const aTiempoDeAceptar = t.acceptBy !== undefined && ahora <= t.acceptBy;
  return {
    aprobar: entregada,
    disputarComoCliente: enRevision,
    // Vencida sin entrega, siempre; sin aceptar, si no tiene trabajador o ya
    // pasó su tiempo de aceptar. (Con el trabajador suspendido también se
    // puede, pero eso lo dice el contrato.)
    cancelar: abierta && (vencida || (sinAceptar && (!conTrabajador || !aTiempoDeAceptar))),
    liberar: entregada && fin !== null && ahora >= fin,
    ampliarPlazo: abierta && diasAmpliables(t) >= 1,
    aceptar: sinAceptar && conTrabajador && aTiempoDeAceptar && !vencida,
    rechazar: abierta && conTrabajador,
    // Sin aceptar, hasta su tiempo de aceptar; aceptada, hasta el plazo.
    entregar: conTrabajador && !vencida && (aceptada || (sinAceptar && aTiempoDeAceptar)),
    disputarComoTrabajador: enRevision,
    pactar: conTrabajador && (abierta || entregada || enDisputa),
  };
}

/**
 * Si una disputa ya caducó (14 días sin decisión) y cualquiera puede cerrarla.
 * En el v2.5, no si los jueces autónomos decidieron a tiempo: entonces se
 * espera a que su decisión sea firme (eso lo dice el contrato).
 */
export function disputaCaducada(t: TareaParaReglas, ahoraS: number): boolean {
  return t.status === ESTADO.EnDisputa && !!t.disputedAt && BigInt(Math.floor(ahoraS)) > t.disputedAt + BigInt(DISPUTA_CADUCA_S);
}
