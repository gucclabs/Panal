/**
 * Panal SDK — el escrow de Panal V3 y su tablón (desplegados el 25-nov-2026),
 * en el hueco del v2.5.
 *
 * EL V3 EN EL HUECO DEL v2.5. El escrow v2.5 del 24-nov se quedó vacío y lo
 * reemplazó el V3 al día siguiente: el mismo escrow, con las monedas en una
 * lista (PanalCurrencies) que el multisig dueño amplía con 48 h de aviso, y la
 * comisión guardada en cada encargo. Ocupa los mismos números (más de mil
 * millones) y el SDK lo sigue llamando `v2_5` (`hireV2_5`, `TareaV2_5`…): los
 * nombres ya publicados no cambian. Los contratos se llaman PanalEscrowV3,
 * PanalBoardV3, PanalPricesV3, PanalReputationV3, PanalRegistryV3 y
 * PanalCurrencies.
 *
 * QUÉ CAMBIA FRENTE AL v2
 *
 *   - Las monedas de la lista: al desplegar, MON, $PANAL y USDC (6
 *     decimales), con comisión del 1,5 % en $PANAL y del 2,5 % en MON y USDC.
 *     Para las de hoy, `getCurrencies()` del cliente.
 *   - Quien trabaja acepta (o rechaza) el encargo. Entregar sin haber aceptado
 *     cuenta como aceptar.
 *   - La revisión dura lo que diga el cliente al contratar: de 24 h a 7 días
 *     (72 h por defecto). Pasada sin aprobar ni disputar, el pago se libera.
 *   - Acuerdos: cliente y trabajador pueden pactar un reparto sin juez.
 *   - Jueces autónomos: proponen una decisión que queda firme a las 48 h si el
 *     multisig no la anula.
 *   - Suspensiones (PanalBans): una cuenta suspendida no puede contratar ni
 *     trabajar, pero siempre puede retirar su saldo.
 *
 * LA NUMERACIÓN. El escrow v2.5 y el tablón v2.5 cuentan desde 0, igual que
 * los del v2. Para que el 5 de uno no se confunda con el 5 del otro, FUERA DE
 * LA CADENA (el buzón, el indexador, los mensajes firmados y este SDK) cada
 * encargo del v2.5 lleva su número MÁS MIL MILLONES: el 5 del v2.5 es el
 * 1.000.000.005. Los métodos del cliente reciben y devuelven ese número y
 * eligen solos el contrato. Si algo se lo pasa por error al contrato del v2,
 * la llamada revierte: no existe esa tarea.
 */

import type { Address, Hex } from 'viem';
import type { PanalNetwork } from './chains.js';
import { TaskStatus, type Task } from './types.js';

// ── La numeración ──────────────────────────────────────────────────────────

/** Desde aquí, los números de tarea y de encargo son del v2.5. */
export const PRIMER_ID_V2_5 = 1_000_000_000n;

export type VersionEscrow = 'v2' | 'v2_5';

/** El número de fuera de la cadena de un encargo del v2.5. */
export function idDelV2_5(idEnLaCadena: bigint): bigint {
  return PRIMER_ID_V2_5 + idEnLaCadena;
}

export function esDelV2_5(id: bigint): boolean {
  return id >= PRIMER_ID_V2_5;
}

export function versionDe(id: bigint): VersionEscrow {
  return esDelV2_5(id) ? 'v2_5' : 'v2';
}

/** El número de verdad en su contrato, sea del v2 o del v2.5. */
export function idEnLaCadena(id: bigint): bigint {
  return esDelV2_5(id) ? id - PRIMER_ID_V2_5 : id;
}

// ── Las direcciones ────────────────────────────────────────────────────────

export interface DireccionesV2_5 {
  /** PanalEscrowV3. */
  escrow: Address;
  /** PanalBoardV3. */
  tablon: Address;
  /** PanalReputationV3: la del V3 más la que trae del v2. */
  reputation: Address;
  /** PanalBans: las cuentas suspendidas. */
  bans: Address;
  /** PanalPricesV3: los precios de cada agente en cada moneda de la lista. */
  prices: Address;
  usdc: Address;
  /** PanalCurrencies: en qué monedas se trabaja, con su mínimo y su comisión. */
  currencies?: Address;
}

/** Panal V3, desplegado y verificado en Monad mainnet el 25-nov-2026. */
export const V2_5_MAINNET: DireccionesV2_5 & { currencies: Address } = {
  escrow: '0xE9666cB1Ce29CC511ED9Fa28f11749d22D47264f',
  tablon: '0xeB267E44Ff624CC03D1B8b9851e1EDF03835C70c',
  reputation: '0x6b6D6b38932B918763782175AE2D06ee3DBF1EA6',
  bans: '0xdA315187aA8bE2266a3bFfe6cdD876A1250A4638',
  prices: '0xfbf59aa0D9574359fd20E049db4C821Fba896413',
  usdc: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  currencies: '0x86A2d5b9e02e3E8F63ED468fDC31565e44d70790',
};

/** El bloque del primer contrato del V3: antes no hay nada que leer. */
export const V2_5_DESDE_BLOQUE = 125_136_390n;

/**
 * El v2.5 del 24-nov, que el V3 reemplazó al día siguiente sin que nadie lo
 * usara (0 tareas, 0 encargos). Queda solo por una cosa: los precios en USDC
 * que los agentes publicaron en su PanalPrices. Hasta que cada agente publique
 * los suyos en el V3, se leen de ahí (ver `getPricesV2_5` del cliente).
 */
export const V2_5_ANTERIOR = {
  escrow: '0x1800225eac5cEF7798e2A926AE243F2a4a42D440',
  tablon: '0x10aF8A30591Fcee56127692d7346476bc68CD656',
  reputation: '0xc8f91E7718835cAEf5e36452705B8922c857624e',
  prices: '0x90CBa3BE239FcA150Fc8fAfC10D6bD7CCb547663',
} as const satisfies Record<string, Address>;

/** Las del v2.5 en una red, o `null` donde no está desplegado (testnet). */
export function direccionesV2_5For(network: PanalNetwork): DireccionesV2_5 | null {
  return network === 'mainnet' ? V2_5_MAINNET : null;
}

// ── Las reglas del escrow v2.5 (constantes del contrato) ──────────────────

/**
 * Comisión en $PANAL y en el resto (MON y USDC), en puntos básicos: las de la
 * lista al desplegar el V3. El multisig puede cambiarlas con 48 h de aviso, y
 * cada encargo se queda con la que tenía al crearse (`TareaV2_5.feeBps`). Para
 * las de hoy, `getCurrencies()` del cliente.
 */
export const FEE_BPS_V2_5 = { panal: 150, resto: 250 } as const;
/** La revisión que proponen la web y la app, y sus límites. */
export const REVISION_POR_DEFECTO_S = 72 * 60 * 60;
export const REVISION_MINIMA_S = 24 * 60 * 60;
export const REVISION_MAXIMA_S = 7 * 24 * 60 * 60;
/** Lo mínimo que tiene quien trabaja para aceptar. */
export const ACEPTAR_MINIMO_S = 5 * 60;
/** Sin decisión en 14 días, cualquiera puede devolver el dinero al cliente. */
export const DISPUTA_CADUCA_S = 14 * 24 * 60 * 60;
/** Lo que tarda en quedar firme una decisión de los jueces autónomos. */
export const DECISION_FIRME_S = 48 * 60 * 60;
/** USDC tiene 6 decimales; MON y $PANAL, 18. */
export const USDC_DECIMALES = 6;

// ── Las tareas ─────────────────────────────────────────────────────────────

export enum EstadoV2_5 {
  Abierta = 0,
  Aceptada = 1,
  Entregada = 2,
  EnDisputa = 3,
  Cerrada = 4,
}

/** Cómo se cerró una tarea (`Close` en el contrato). */
export enum CierreV2_5 {
  Ninguno = 0,
  Aprobada = 1,
  /** La revisión pasó sin aprobar ni disputar: se liberó sola. */
  PorTiempo = 2,
  Arbitrada = 3,
  /** La disputa pasó 14 días sin decisión: se cerró a mitad y mitad (en el v2 volvía entero al cliente). */
  DisputaCaducada = 4,
  /** Acuerdo entre las dos partes. */
  Acuerdo = 5,
  Cancelada = 6,
  /** Pasó el plazo sin entrega. */
  Vencida = 7,
  /** Quien trabaja la rechazó. */
  Rechazada = 8,
  /** La decidieron los jueces autónomos y quedó firme. */
  ArbitradaAutonoma = 9,
}

/** Cierres sin entrega: el dinero volvió entero al cliente. */
export const CIERRES_SIN_ENTREGA: ReadonlySet<CierreV2_5> = new Set([
  CierreV2_5.Cancelada,
  CierreV2_5.Vencida,
  CierreV2_5.Rechazada,
]);

/** Una tarea del escrow v2.5, con su número de fuera de la cadena en `id`. */
export interface TareaV2_5 {
  id: bigint;
  client: Address;
  /** Cero en las abiertas a cualquiera, hasta que alguien la coge. */
  worker: Address;
  /** Cero = MON; si no, $PANAL o USDC. */
  currency: Address;
  amount: bigint;
  taskHash: Hex;
  resultHash: Hex;
  estado: EstadoV2_5;
  cierre: CierreV2_5;
  /** Al cerrar, la parte de quien trabajó (10.000 = todo). */
  workerShareBps: number;
  /** Hasta cuándo se puede entregar (unix, segundos). */
  deadline: bigint;
  /** Hasta cuándo puede aceptar (o entregar sin haber aceptado). */
  acceptBy: bigint;
  /** Segundos de revisión tras la entrega. */
  reviewWindow: number;
  createdAt: bigint;
  /** Cero si no se ha entregado. */
  deliveredAt: bigint;
  /** Cero si no hay disputa. */
  disputedAt: bigint;
  /**
   * La comisión de este encargo en puntos básicos, fijada al crearlo con la
   * de la lista de monedas. Lo que cambie la lista después no la toca.
   */
  feeBps: number;
}

/** De lo que devuelve `getTask` del escrow v2.5 a una `TareaV2_5`. */
export function tareaV2_5DeLaCadena(id: bigint, t: Record<string, unknown>): TareaV2_5 {
  return {
    id,
    client: t.client as Address,
    worker: t.worker as Address,
    currency: t.currency as Address,
    amount: BigInt(t.amount as bigint),
    taskHash: t.taskHash as Hex,
    resultHash: t.resultHash as Hex,
    estado: Number(t.status) as EstadoV2_5,
    cierre: Number(t.closeReason) as CierreV2_5,
    workerShareBps: Number(t.workerShareBps),
    deadline: BigInt(t.deadline as bigint),
    acceptBy: BigInt(t.acceptBy as bigint),
    reviewWindow: Number(t.reviewWindow),
    createdAt: BigInt(t.createdAt as bigint),
    deliveredAt: BigInt(t.deliveredAt as bigint),
    disputedAt: BigInt(t.disputedAt as bigint),
    feeBps: Number(t.feeBps ?? 0),
  };
}

/**
 * Una tarea del v2.5 con la forma de las del v2 (`Task`), para el código que
 * ya sabe tratar esas: aceptada cuenta como abierta (todavía se puede
 * entregar), cerrada sin entrega es cancelada, y cerrada con entrega, por el
 * motivo que sea, completada. Lo que esa forma no tiene (aceptar, la revisión,
 * los acuerdos) está en la `TareaV2_5`.
 */
export function comoTask(t: TareaV2_5): Task {
  let status: TaskStatus;
  switch (t.estado) {
    case EstadoV2_5.Abierta:
    case EstadoV2_5.Aceptada:
      status = TaskStatus.Open;
      break;
    case EstadoV2_5.Entregada:
      status = TaskStatus.Delivered;
      break;
    case EstadoV2_5.EnDisputa:
      status = TaskStatus.Disputed;
      break;
    default:
      status = CIERRES_SIN_ENTREGA.has(t.cierre) ? TaskStatus.Cancelled : TaskStatus.Completed;
  }
  return {
    id: t.id,
    client: t.client,
    worker: t.worker,
    amount: t.amount,
    currency: t.currency,
    taskHash: t.taskHash,
    resultHash: t.resultHash,
    status,
    deadline: t.deadline,
    createdAt: t.createdAt,
  };
}

/** Cuándo acaba la revisión de una tarea entregada (unix, segundos), o null. */
export function finDeLaRevision(t: TareaV2_5): bigint | null {
  return t.estado === EstadoV2_5.Entregada ? t.deliveredAt + BigInt(t.reviewWindow) : null;
}

// ── La lista de monedas (PanalCurrencies) ───────────────────────────────────

/** Una moneda de la lista. */
export interface MonedaDeLaLista {
  /** address(0) = MON. */
  token: Address;
  /** Si se puede empezar algo nuevo en ella (contratar, registrarse, publicar). */
  activa: boolean;
  decimales: number;
  /** La comisión que llevaría un encargo nuevo, en puntos básicos. */
  feeBps: number;
  /** Lo mínimo de un encargo, en sus unidades. */
  minimo: bigint;
}

/** Lo más que puede llegar a cobrar el escrow (`MAX_FEE_BPS` de la lista): 5 %. */
export const FEE_BPS_MAXIMA = 500;
/** El aviso que da el multisig antes de añadir una moneda o cambiar sus números. */
export const AVISO_MONEDAS_S = 48 * 60 * 60;

/** La reputación v2.5: la suya en el v2.5 más la que traía del v2. */
export interface ReputacionV2_5 {
  tasksCompleted: bigint;
  ratingSum: bigint;
  ratingCount: bigint;
  disputesLost: bigint;
}

/** La media de una reputación, con dos decimales, o null sin notas. */
export function mediaDe(r: ReputacionV2_5): number | null {
  return r.ratingCount === 0n ? null : Math.round((Number(r.ratingSum) / Number(r.ratingCount)) * 100) / 100;
}
