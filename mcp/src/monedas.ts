/**
 * Panal MCP — en qué otras monedas cobra un agente (PanalPrices, escrow v2.5).
 *
 * El registro guarda UN precio y UNA moneda por agente (MON o $PANAL). Desde el
 * v2.5, el dueño puede publicar además listas en PanalPrices: una por moneda,
 * la i de cada una para el nivel i de la ficha de la cadena. Lint, por ejemplo,
 * cobra en MON en el registro y en USDC por PanalPrices — y por aquí solo se
 * veía «1 MON», igual que le pasaba a la web hasta #452.
 *
 * La regla es la misma que usa la web para ofrecer la moneda al pagar
 * (`src/lib/monedasDeContratacion.ts`): una lista solo vale si tiene tantos
 * precios como niveles hay en la cadena, o uno solo si no hay niveles, y
 * ninguno a cero. Si no cuadra, la web no la ofrece, así que aquí tampoco se
 * anuncia.
 */

import { formatUnits, type Address } from 'viem';
import { NATIVE_CURRENCY, leerNivelesDeMetadata, panalPricesAbi, type Agent, type PanalClient } from '@panal/sdk';

/** Una moneda más, con sus precios en el orden de los niveles de la cadena. */
export interface OtraMoneda {
  currency: Address;
  simbolo: 'MON' | '$PANAL' | 'USDC';
  /** 6 en USDC; 18 en MON y $PANAL. */
  decimales: number;
  /** En unidades mínimas de esa moneda, en el orden de los niveles. */
  precios: bigint[];
}

/** Multicall3: la misma dirección en todas las cadenas, Monad incluida. */
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
const POR_LOTE = 100;

function usable(lista: readonly bigint[], nivelesEnCadena: number): boolean {
  if (lista.length === 0 || lista.some((x) => x <= 0n)) return false;
  return nivelesEnCadena > 0 ? lista.length === nivelesEnCadena : lista.length === 1;
}

/**
 * Las otras monedas de cada agente, por dirección en minúsculas. Una llamada
 * por cada 100 agentes, no una por agente: una búsqueda devuelve el mercado
 * entero y el RPC público corta cerca de 50 a la vez.
 *
 * Nunca lanza: sin PanalPrices (otra red, RPC caído) cada agente se queda con
 * la moneda de su registro, que es lo que se enseñaba antes.
 */
export async function otrasMonedasDe(panal: PanalClient, agentes: Agent[]): Promise<Map<string, OtraMoneda[]>> {
  const out = new Map<string, OtraMoneda[]>();
  const v = panal.v2_5;
  if (!v || agentes.length === 0) return out;
  const candidatas: Array<Pick<OtraMoneda, 'currency' | 'simbolo' | 'decimales'>> = [
    { currency: NATIVE_CURRENCY, simbolo: 'MON', decimales: 18 },
    { currency: panal.addresses.panalToken, simbolo: '$PANAL', decimales: 18 },
    { currency: v.usdc, simbolo: 'USDC', decimales: 6 },
  ];

  for (let i = 0; i < agentes.length; i += POR_LOTE) {
    const lote = agentes.slice(i, i + POR_LOTE);
    let res: Array<{ status: 'success' | 'failure'; result?: unknown }>;
    try {
      res = (await panal.publicClient.multicall({
        contracts: lote.map((a) => ({
          address: v.prices,
          abi: panalPricesAbi,
          functionName: 'getAllPrices',
          args: [a.address],
        })) as never,
        multicallAddress: MULTICALL3,
        allowFailure: true,
      })) as unknown as typeof res;
    } catch {
      continue;
    }
    res.forEach((r, k) => {
      if (r.status !== 'success') return;
      const agente = lote[k]!;
      const [mon, panalL, usdc] = r.result as readonly [readonly bigint[], readonly bigint[], readonly bigint[]];
      const listas = [mon, panalL, usdc];
      const niveles = leerNivelesDeMetadata(agente.metadataURI).length;
      const otras: OtraMoneda[] = [];
      candidatas.forEach((c, j) => {
        if (c.currency.toLowerCase() === agente.currency.toLowerCase()) return;
        const lista = listas[j]!;
        if (usable(lista, niveles)) otras.push({ ...c, precios: [...lista] });
      });
      if (otras.length > 0) out.set(agente.address.toLowerCase(), otras);
    });
  }
  return out;
}

/** El precio de una moneda para un nivel (índice; 0 si el agente no tiene niveles). */
export function precioParaNivel(otra: OtraMoneda, nivel: number): bigint {
  return otra.precios[Math.max(0, Math.min(nivel, otra.precios.length - 1))]!;
}

/** «0.01 USDC». */
export function importe(otra: OtraMoneda, wei: bigint): string {
  return `${formatUnits(wei, otra.decimales)} ${otra.simbolo}`;
}

/**
 * «Also accepts: 0.01 / 0.02 / 0.04 USDC (one price per size, same order) — …».
 * Vacío si no acepta otra. `como` dice dónde se elige la moneda, que no es lo
 * mismo en el MCP local (paga en la del registro) que en el remoto (enlace).
 */
export function lineaOtrasMonedas(otras: OtraMoneda[], como: string): string[] {
  if (otras.length === 0) return [];
  const varios = otras.some((o) => o.precios.length > 1);
  const lista = otras
    .map((o) => `${o.precios.map((p) => formatUnits(p, o.decimales)).join(' / ')} ${o.simbolo}`)
    .join(' · ');
  return [`  Also accepts: ${lista}${varios ? ' (one price per size, same order as above)' : ''} — ${como}`];
}

/**
 * La dirección de una moneda dicha por su nombre («USDC», «$PANAL», «mon») o
 * por su dirección. null si no es ninguna de las que cobra el escrow.
 */
export function monedaPorNombre(panal: PanalClient, nombre: string): Address | null {
  const n = nombre.trim().replace(/^\$/, '').toUpperCase();
  if (n === 'MON') return NATIVE_CURRENCY;
  if (n === 'PANAL') return panal.addresses.panalToken;
  if (n === 'USDC') return panal.v2_5?.usdc ?? null;
  const conocidas = [NATIVE_CURRENCY, panal.addresses.panalToken, ...(panal.v2_5 ? [panal.v2_5.usdc] : [])];
  return conocidas.find((c) => c.toLowerCase() === nombre.trim().toLowerCase()) ?? null;
}
