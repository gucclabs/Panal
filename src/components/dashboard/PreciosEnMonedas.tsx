/**
 * Panal — lo que cobra un agente en otras monedas (PanalPrices, escrow v2.5).
 *
 * El registro guarda un precio en una moneda (MON o $PANAL). Desde el v2.5 se
 * puede cobrar también en las otras, USDC incluido, publicando en PanalPrices
 * una lista por moneda: un precio por cada nivel de la ficha (en el mismo
 * orden, de menor a mayor), o uno solo si no hay niveles. Vaciar una lista es
 * dejar de aceptar esa moneda. Es una transacción por moneda.
 *
 * Es informativo, como el precio del registro: el escrow no lo comprueba. La
 * web lo usa para ofrecer esa moneda al contratar; el agente, para saber qué
 * importe esperar.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Loader2, TriangleAlert } from 'lucide-react';
import { formatUnits, parseUnits, type Address } from 'viem';
import { useReadContract } from 'wagmi';
import { leerNivelesDeMetadata, panalPricesAbi } from '@panal/sdk';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  EXPLORER_TX,
  NATIVE_CURRENCY,
  PANAL_PRICES_ADDRESS,
  PANAL_TOKEN_ADDRESS,
  USDC_TOKEN_ADDRESS,
  activeChain,
  currencySymbol,
  decimalesDe,
} from '@/contracts/config';
import { useContractAction } from '@/hooks/useContractAction';
import { minimoDelEscrowV2_5 } from '@/lib/monedasDeContratacion';

const MONEDAS: Address[] = [NATIVE_CURRENCY, PANAL_TOKEN_ADDRESS as Address, USDC_TOKEN_ADDRESS];

/** Lo que se escribe en una casilla, en unidades mínimas; null si no es un número válido. */
function leerImporte(texto: string, moneda: Address): bigint | null {
  const s = texto.replace(',', '.').trim();
  const dec = decimalesDe(moneda);
  if (!new RegExp(`^\\d+(\\.\\d{1,${dec}})?$`).test(s)) return null;
  const v = parseUnits(s, dec);
  return v > 0n ? v : null;
}

export default function PreciosEnMonedas({
  open,
  onOpenChange,
  agente,
  metadataURI,
  monedaDelRegistro,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agente: Address;
  metadataURI: string;
  monedaDelRegistro: Address;
}) {
  const { t } = useTranslation();
  // Los niveles de la CADENA: las listas van por ellos, en su orden.
  const niveles = useMemo(() => leerNivelesDeMetadata(metadataURI), [metadataURI]);
  const casillas = Math.max(1, niveles.length);
  const otras = MONEDAS.filter((m) => m.toLowerCase() !== monedaDelRegistro.toLowerCase());

  const { data, refetch } = useReadContract({
    address: PANAL_PRICES_ADDRESS,
    abi: panalPricesAbi,
    functionName: 'getAllPrices',
    args: [agente],
    chainId: activeChain.id,
    query: { enabled: open },
  });
  const action = useContractAction({ onMined: () => void refetch() });
  const [textos, setTextos] = useState<Record<string, string[]>>({});

  // Al abrir (o al llegar lo publicado), las casillas con lo que hay.
  useEffect(() => {
    if (!open || !data) return;
    const [mon, panal, usdc] = data as readonly [readonly bigint[], readonly bigint[], readonly bigint[]];
    const listas: Record<string, readonly bigint[]> = {
      [NATIVE_CURRENCY.toLowerCase()]: mon,
      [PANAL_TOKEN_ADDRESS.toLowerCase()]: panal,
      [USDC_TOKEN_ADDRESS.toLowerCase()]: usdc,
    };
    const iniciales: Record<string, string[]> = {};
    for (const m of otras) {
      const lista = listas[m.toLowerCase()] ?? [];
      iniciales[m.toLowerCase()] = Array.from({ length: casillas }, (_, i) =>
        lista.length === casillas && lista[i] !== undefined ? formatUnits(lista[i]!, decimalesDe(m)) : '',
      );
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- se rellena una vez por lectura
    setTextos(iniciales);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, data, casillas]);

  const guardar = (moneda: Address, vaciar: boolean) => {
    const lista = textos[moneda.toLowerCase()] ?? [];
    const importes = vaciar ? [] : lista.map((x) => leerImporte(x, moneda));
    if (importes.some((x) => x === null)) return;
    void action.run({
      address: PANAL_PRICES_ADDRESS,
      abi: panalPricesAbi,
      functionName: 'setPrices',
      args: [moneda, importes as bigint[]],
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !action.busy && onOpenChange(o)}>
      <DialogContent className="max-h-[92dvh] w-[calc(100vw-1.5rem)] overflow-y-auto border-line bg-paper sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-ink">{t('precios.titulo')}</DialogTitle>
          <DialogDescription className="text-ink-2">
            {t(niveles.length > 0 ? 'precios.descNiveles' : 'precios.desc', { n: niveles.length })}
          </DialogDescription>
        </DialogHeader>

        {action.busy || action.txHash ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            {action.busy && <Loader2 size={24} className="animate-spin text-honey-deep" aria-hidden />}
            <p className="text-[0.875rem] text-ink">
              {action.signing
                ? t('hire.step3.signing')
                : action.mined
                  ? t('dashReal.txConfirmed')
                  : t('hire.step3.confirming')}
            </p>
            {action.txHash && (
              <a
                href={EXPLORER_TX(action.txHash)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-full border border-line px-4 py-2 font-mono text-[12px] text-ink-2 transition-colors hover:border-honey hover:text-honey-deep"
              >
                {t('hire.step3.viewTx')}
                <ExternalLink size={13} />
              </a>
            )}
            {!action.busy && (
              <button
                type="button"
                onClick={() => action.reset()}
                className="rounded-full border border-line px-4 py-2 text-[0.8125rem] text-ink-2 transition-colors hover:border-honey"
              >
                {t('common.back')}
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-5 py-1">
            {otras.map((m) => {
              const simbolo = currencySymbol(m);
              const lista = textos[m.toLowerCase()] ?? Array.from({ length: casillas }, () => '');
              const importes = lista.map((x) => leerImporte(x, m));
              const malas = lista.some((x, i) => x.trim() !== '' && importes[i] === null);
              const completas = importes.every((x) => x !== null);
              const bajoMinimo = importes.some((x) => x !== null && x < minimoDelEscrowV2_5(m));
              // El contrato los quiere de menor a mayor, como los niveles: si no, revierte.
              const desordenados = importes.some((x, i) => i > 0 && x !== null && importes[i - 1] != null && x < importes[i - 1]!);
              return (
                <section key={m} className="flex flex-col gap-2 rounded-xl border border-line bg-cream p-4">
                  <p className="font-mono text-[0.875rem] font-semibold text-ink">{simbolo}</p>
                  {lista.map((valor, i) => (
                    <label key={i} className="flex items-center gap-3 text-[0.8125rem] text-ink-2">
                      <span className="min-w-0 flex-1 truncate">
                        {niveles.length > 0 ? (niveles[i]?.name ?? t('precios.nivel', { n: i + 1 })) : t('precios.porEncargo')}
                      </span>
                      <input
                        value={valor}
                        onChange={(e) =>
                          setTextos((previo) => {
                            const nueva = [...(previo[m.toLowerCase()] ?? lista)];
                            nueva[i] = e.target.value;
                            return { ...previo, [m.toLowerCase()]: nueva };
                          })
                        }
                        inputMode="decimal"
                        placeholder={simbolo === 'USDC' ? '2.50' : simbolo === '$PANAL' ? '100' : '0.05'}
                        aria-label={`${simbolo} ${i + 1}`}
                        className="w-32 rounded-xl border border-line bg-paper px-3 py-2 font-mono text-[0.8125rem] text-ink placeholder:text-ink-3 focus:border-honey focus:outline-none"
                      />
                    </label>
                  ))}
                  {malas && (
                    <p className="flex items-center gap-1.5 text-[0.75rem] text-terra">
                      <TriangleAlert size={12} aria-hidden />
                      {t('wallet.invalidAmount')}
                    </p>
                  )}
                  {bajoMinimo && <p className="text-[0.75rem] text-terra">{t('precios.bajoMinimo')}</p>}
                  {desordenados && <p className="text-[0.75rem] text-terra">{t('precios.desordenados')}</p>}
                  <div className="mt-1 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => guardar(m, false)}
                      disabled={!completas || bajoMinimo || desordenados}
                      className="btn-monad px-4 py-2 text-[0.8125rem] font-semibold disabled:opacity-40"
                    >
                      {t('precios.guardar', { moneda: simbolo })}
                    </button>
                    <button
                      type="button"
                      onClick={() => guardar(m, true)}
                      className="rounded-full border border-line px-4 py-2 text-[0.8125rem] text-ink-2 transition-colors hover:border-terra hover:text-terra"
                    >
                      {t('precios.noAceptar', { moneda: simbolo })}
                    </button>
                  </div>
                </section>
              );
            })}
            <p className="text-[0.75rem] leading-relaxed text-ink-3">{t('precios.nota')}</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
