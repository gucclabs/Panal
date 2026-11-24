/**
 * Panal — lo que cada escrow te debe, por moneda.
 *
 * Los escrows acreditan, no envían: lo cobrado (o devuelto) se queda en el
 * contrato hasta que lo retiras. Desde el 24-nov-2026 hay dos —el v2, con lo
 * que ya estaba en marcha, y el v2.5, donde va todo lo nuevo— y cada uno
 * guarda su saldo: retirar del v2 no toca lo del v2.5. Tres monedas en el
 * v2.5 (MON, $PANAL y USDC) y dos en el v2.
 *
 * Una sola lectura (multicall) para las cinco, y un sitio para todo el panel:
 * el aviso junto a una tarea aprobada, las filas de Pagos y la cartera.
 */

import { useReadContracts } from 'wagmi';
import type { Address } from 'viem';
import { panalEscrowV2_5Abi } from '@panal/sdk';
import {
  NATIVE_CURRENCY,
  PANAL_ESCROW_V2_5_ADDRESS,
  PANAL_ESCROW_V2_ADDRESS,
  PANAL_TOKEN_ADDRESS,
  USDC_TOKEN_ADDRESS,
  V2_5_ENABLED,
  V2_ENABLED,
  activeChain,
  currencySymbol,
  type SimboloMoneda,
} from '@/contracts/config';
import { panalEscrowV2Abi } from '@/contracts/abis';
import { useWallet } from '@/hooks/useWallet';
import type { VersionEscrow } from '@/lib/escrow';

export interface Pendiente {
  version: VersionEscrow;
  currency: Address;
  simbolo: SimboloMoneda;
  /** undefined mientras se lee (o si la lectura falló). */
  cantidad: bigint | undefined;
}

/** Las monedas de cada escrow, en el orden en que se enseñan. */
export const MONEDAS_DE: Record<VersionEscrow, Address[]> = {
  v2_5: [NATIVE_CURRENCY, PANAL_TOKEN_ADDRESS as Address, USDC_TOKEN_ADDRESS],
  v2: [NATIVE_CURRENCY, PANAL_TOKEN_ADDRESS as Address],
};

const VERSIONES: VersionEscrow[] = [...(V2_5_ENABLED ? (['v2_5'] as const) : []), ...(V2_ENABLED ? (['v2'] as const) : [])];

export function usePendientes(): {
  pendientes: Pendiente[];
  /** Lo que queda por retirar de una moneda en un escrow (0n si nada o sin leer). */
  de: (version: VersionEscrow, currency: string) => bigint;
  refetch: () => void;
} {
  const { address } = useWallet();
  const pares = VERSIONES.flatMap((version) => MONEDAS_DE[version].map((currency) => ({ version, currency })));
  const { data, refetch } = useReadContracts({
    contracts: pares.map(({ version, currency }) => ({
      address: version === 'v2_5' ? PANAL_ESCROW_V2_5_ADDRESS : PANAL_ESCROW_V2_ADDRESS,
      abi: version === 'v2_5' ? panalEscrowV2_5Abi : panalEscrowV2Abi,
      functionName: 'pendingWithdrawals',
      args: [currency, address as Address],
      chainId: activeChain.id,
    })) as never,
    query: { enabled: !!address, refetchInterval: 15_000, retry: 1 },
  });
  const pendientes: Pendiente[] = pares.map(({ version, currency }, i) => {
    const r = (data as { status: string; result?: unknown }[] | undefined)?.[i];
    return {
      version,
      currency,
      simbolo: currencySymbol(currency),
      cantidad: r?.status === 'success' && typeof r.result === 'bigint' ? r.result : undefined,
    };
  });
  return {
    pendientes,
    de: (version, currency) =>
      pendientes.find((p) => p.version === version && p.currency.toLowerCase() === currency.toLowerCase())?.cantidad ?? 0n,
    refetch: () => void refetch(),
  };
}
