/**
 * Panal — en qué monedas se puede contratar a un agente, y por cuánto.
 *
 * Dos fuentes, por orden:
 *   1. El registro (PanalRegistryV2): un precio y una moneda, MON o $PANAL, y
 *      los niveles de su ficha en esa moneda. Es lo que los agentes ya
 *      comprueban, así que en esa moneda manda siempre.
 *   2. PanalPrices (v2.5, 24-nov-2026): listas de precios por moneda, la i de
 *      cada una para el nivel i de la ficha. Solo añade monedas: la del
 *      registro no se toca.
 *
 * Una lista de PanalPrices solo vale si cuadra con los niveles: tantos precios
 * como niveles en la cadena, o uno solo si el agente no tiene niveles. Un
 * precio que cae en otro nivel es peor que no ofrecer la moneda (lo dice el
 * propio contrato). Con niveles que solo están en la tarjeta del bot tampoco
 * se ofrece: esos niveles no tienen orden fijo en la cadena.
 */

import type { Address } from 'viem';
import { NATIVE_CURRENCY, PANAL_TOKEN_ADDRESS, USDC_TOKEN_ADDRESS } from '@/contracts/config';

/** Lo que devuelve `getAllPrices(agente)` de PanalPrices. */
export interface PreciosPorMoneda {
  mon: readonly bigint[];
  panal: readonly bigint[];
  usdc: readonly bigint[];
}

/** La lista de una moneda. */
export function listaDe(p: PreciosPorMoneda, currency: string): readonly bigint[] {
  const c = currency.toLowerCase();
  if (c === NATIVE_CURRENCY.toLowerCase()) return p.mon;
  if (c === PANAL_TOKEN_ADDRESS.toLowerCase()) return p.panal;
  if (c === USDC_TOKEN_ADDRESS.toLowerCase()) return p.usdc;
  return [];
}

export interface DatosDelAgente {
  /** La moneda del registro. */
  registro: Address;
  /** PanalPrices, o null si no se pudo leer (entonces solo la del registro). */
  precios: PreciosPorMoneda | null;
  /** Cuántos niveles hay en la ficha de la cadena. */
  nivelesEnCadena: number;
  /** Cuántos niveles se enseñan (los de la cadena, o los de la tarjeta si no hay). */
  nivelesVisibles: number;
}

/** Si la lista de PanalPrices de una moneda se puede usar con estos niveles. */
function listaUsable(lista: readonly bigint[], d: DatosDelAgente): boolean {
  if (lista.length === 0 || lista.some((x) => x <= 0n)) return false;
  if (d.nivelesEnCadena > 0) return lista.length === d.nivelesEnCadena;
  // Sin niveles en la cadena: un precio, y solo si tampoco hay de tarjeta.
  return d.nivelesVisibles === 0 && lista.length === 1;
}

/** Las monedas en que se puede contratar, la del registro primero. */
export function monedasParaContratar(d: DatosDelAgente): Address[] {
  const out: Address[] = [d.registro];
  if (!d.precios) return out;
  for (const c of [NATIVE_CURRENCY, PANAL_TOKEN_ADDRESS as Address, USDC_TOKEN_ADDRESS]) {
    if (c.toLowerCase() === d.registro.toLowerCase()) continue;
    if (listaUsable(listaDe(d.precios, c), d)) out.push(c);
  }
  return out;
}

/**
 * Lo que se bloquea en `moneda` por el nivel `nivel` (índice; 0 sin niveles).
 * En la moneda del registro, `precioRegistro` (el del nivel elegido o el del
 * registro). En otra, el de PanalPrices; null si esa moneda no vale.
 */
export function importeEn(
  d: DatosDelAgente,
  moneda: string,
  nivel: number,
  precioRegistro: bigint,
): bigint | null {
  if (moneda.toLowerCase() === d.registro.toLowerCase()) return precioRegistro;
  if (!d.precios) return null;
  const lista = listaDe(d.precios, moneda);
  if (!listaUsable(lista, d)) return null;
  return lista[Math.max(0, Math.min(nivel, lista.length - 1))] ?? null;
}

/** Los mínimos del escrow v2.5, para avisar antes de firmar algo que revierte. */
export function minimoDelEscrowV2_5(moneda: string): bigint {
  const c = moneda.toLowerCase();
  if (c === USDC_TOKEN_ADDRESS.toLowerCase()) return 10_000n; // 0,01 USDC
  if (c === PANAL_TOKEN_ADDRESS.toLowerCase()) return 10n ** 18n; // 1 $PANAL
  return 10n ** 15n; // 0,001 MON
}

/**
 * Los tiempos de un encargo nuevo en el v2.5, a partir de ahora.
 *
 * `acceptWindow`: hasta 15 minutos antes del plazo (y nunca menos de los 5
 * minutos del contrato). El contrato exige que «ahora + acceptWindow» no pase
 * del plazo AL MINARSE: esos 15 minutos son el margen para firmar.
 */
export function tiemposDeEncargo(
  ahoraS: number,
  horasDePlazo: number,
  horasDeRevision: number,
): { deadline: bigint; acceptWindow: number; reviewWindow: number } {
  const total = Math.round(horasDePlazo * 3600);
  return {
    deadline: BigInt(Math.floor(ahoraS) + total),
    acceptWindow: Math.max(300, total - 900),
    reviewWindow: Math.round(horasDeRevision * 3600),
  };
}
