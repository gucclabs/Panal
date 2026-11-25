/**
 * Panal — lo que un agente tiene sin cerrar.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ESTA PIEZA LA PIDIÓ UN FALLO DE VERDAD.
 *
 * El vigilante que corre dentro de cada agente daba por resueltas tareas que
 * habían fallado: un error a mitad de ronda adelantaba su marca por encima, y
 * un reintento que volvía a reventar se veía igual que uno que había entregado.
 * Dos tareas se quedaron abiertas y sin entregar mientras el servidor creía que
 * todo iba bien. Está arreglado, pero la lección no se arregla con un parche:
 * el dueño no tenía NINGUNA forma de enterarse, porque el único que vigilaba
 * era el propio proceso que había fallado.
 *
 * Por eso todo lo de aquí sale de la CADENA. Una tarea abierta, asignada a tu
 * agente, con el plazo corriendo y sin resultado anclado es un hecho público:
 * se ve desde el teléfono aunque tu servidor esté ardiendo, aunque su vigilante
 * mienta y aunque no tengas acceso a los logs.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Y una cosa que NO hace: no ofrece entregar. Entregar lo firma el agente con
 * su clave y el resultado está en su disco, así que desde el móvil no se puede.
 * Un botón «Entregar ahora» prometería algo que esta pantalla no puede cumplir.
 */

import type { Address } from 'viem';
import type { VersionEscrow } from '@panal/sdk';
import { ESTADO } from '@/lib/conversaciones';
import { AUTO_RELEASE_MS } from '~/lib/formato';

/** Lo que tarda una disputa en poder reclamarse de vuelta. Escrow v2. */
export const DISPUTA_MS = 14 * 24 * 60 * 60 * 1000;

export type Motivo = 'sin-entregar' | 'sin-cobrar' | 'sin-aprobar' | 'disputa';

export interface Fila {
  /** Único y estable: sirve de key y no cambia entre repasos. */
  clave: string;
  motivo: Motivo;
  /** Si merece salir en el filtro «corre prisa». */
  urgente: boolean;
  ref: string;
  /** Epoch ms de cuando se acaba el tiempo, si hay reloj. */
  vence: number | null;
  /** Lo que hay dentro, para pintar la cantidad sin volver a buscarla. */
  importe: bigint;
  simbolo: string;
  /** Solo en «sin cobrar»: de qué escrow y en qué moneda se saca (una firma). */
  escrow?: VersionEscrow;
  moneda?: Address;
}

export interface TareaGuardia {
  id: bigint;
  amountWei: bigint;
  currency: string;
  deadline: bigint;
  status: number;
  deliveredAt?: bigint;
  /** Segundos de revisión (v2.5); sin él, las 72 h del escrow v2. */
  reviewWindow?: number;
}

/** Un saldo sin sacar de un escrow, en una moneda. */
export interface SaldoGuardia {
  version: VersionEscrow;
  /** Sin ella, la pantalla la saca del símbolo. */
  moneda?: Address;
  simbolo: string;
  importe: bigint;
}

/** El número que se enseña: «#5 · V3» en Panal V3, el hueco del v2.5 (su número de fuera lleva mil millones más). */
export function refDeTarea(id: bigint): string {
  return id >= 1_000_000_000n ? `#${(id - 1_000_000_000n).toString()} · V3` : `#${id.toString()}`;
}

/**
 * Las cuatro cosas que le pueden estar pasando a un agente ahora mismo.
 *
 * El orden es el de urgencia real, no el de id: lo que vence antes va primero,
 * porque esta pantalla se mira con prisa o no se mira.
 *
 * No recibe la hora, y por eso su salida no depende de cuándo se llame: lo
 * vencido ya sale primero por tener el plazo más temprano. Quién ha vencido y
 * cuánto queda lo pinta la pantalla con el reloj del momento.
 */
export function revisar(
  tareas: TareaGuardia[],
  pendiente: { panal: bigint; mon: bigint; lista?: SaldoGuardia[] },
  simboloDe: (moneda: string) => string,
): Fila[] {
  const filas: Fila[] = [];

  for (const t of tareas) {
    const id = t.id.toString();
    const simbolo = simboloDe(t.currency);

    if (t.status === ESTADO.Abierto) {
      // Vencida o no, sigue abierta y sin nada anclado. Una vencida es MÁS
      // urgente, no menos: ahí el cliente ya puede recuperar su dinero.
      filas.push({
        clave: `sin-entregar-${id}`,
        motivo: 'sin-entregar',
        urgente: true,
        ref: refDeTarea(t.id),
        vence: Number(t.deadline) * 1000,
        importe: t.amountWei,
        simbolo,
      });
      continue;
    }

    if (t.status === ESTADO.Entregado) {
      filas.push({
        clave: `sin-aprobar-${id}`,
        motivo: 'sin-aprobar',
        // No corre prisa: si el cliente no hace nada, al acabar la revisión se
        // cobra sin él (72 h en el v2; en el v2.5, la que eligió al contratar).
        urgente: false,
        ref: refDeTarea(t.id),
        vence: t.deliveredAt
          ? Number(t.deliveredAt) * 1000 + (t.reviewWindow !== undefined ? t.reviewWindow * 1000 : AUTO_RELEASE_MS)
          : null,
        importe: t.amountWei,
        simbolo,
      });
      continue;
    }

    if (t.status === ESTADO.Disputado) {
      filas.push({
        clave: `disputa-${id}`,
        motivo: 'disputa',
        urgente: true,
        ref: refDeTarea(t.id),
        // El escrow guarda `disputedAt`, que aquí no se lee para no doblar las
        // llamadas: se enseña el plazo sin reloj antes que un reloj inventado.
        vence: null,
        importe: t.amountWei,
        simbolo,
      });
    }
  }

  // Lo que vence antes, primero. Lo que no tiene reloj va detrás de lo que sí:
  // un plazo corriendo manda sobre algo que no caduca.
  filas.sort((a, b) => {
    if (a.vence === null && b.vence === null) return 0;
    if (a.vence === null) return 1;
    if (b.vence === null) return -1;
    return a.vence - b.vence;
  });

  // El dinero sin cobrar va ARRIBA del todo: es lo único de esta pantalla en
  // lo que el dueño puede actuar él mismo.
  // Una fila por moneda, y CADA UNA lleva su símbolo de referencia: son dos
  // firmas distintas, y sin el símbolo las dos filas salían idénticas — que es
  // justo lo que pasó la primera vez que se pintó esta pantalla.
  // Con la lista, una fila por escrow y moneda (desde el v2.5 puede haber MON
  // en los dos, y son dos firmas); sin ella, una por moneda del escrow v2.
  const saldos: SaldoGuardia[] = pendiente.lista ?? [
    { version: 'v2', simbolo: 'MON', importe: pendiente.mon },
    { version: 'v2', simbolo: '$PANAL', importe: pendiente.panal },
  ];
  const dosEscrows = new Set(saldos.map((x) => x.version)).size > 1;
  // `unshift` las pone delante en orden inverso: se recorren al revés para
  // que salgan en el orden de la lista.
  for (const x of [...saldos].reverse()) {
    if (x.importe <= 0n) continue;
    const marca = x.simbolo === '$PANAL' ? 'panal' : x.simbolo.toLowerCase();
    filas.unshift({
      clave: x.version === 'v2' ? `sin-cobrar-${marca}` : `sin-cobrar-${marca}-v2_5`,
      motivo: 'sin-cobrar',
      urgente: true,
      ref: dosEscrows || x.version === 'v2_5' ? `${x.simbolo} · ${x.version === 'v2_5' ? 'V3' : 'v2'}` : x.simbolo,
      vence: null,
      importe: x.importe,
      simbolo: x.simbolo,
      escrow: x.version,
      ...(x.moneda ? { moneda: x.moneda } : {}),
    });
  }

  return filas;
}

/** Cuántas de las que corren prisa. Es el pulso de arriba de la pantalla. */
export function cuantasUrgentes(filas: Fila[]): number {
  return filas.filter((f) => f.urgente).length;
}
