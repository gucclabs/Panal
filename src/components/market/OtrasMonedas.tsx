import { useTranslation } from 'react-i18next';
import { formatMon, type Agent } from '@/data/agents';
import { cn } from '@/lib/utils';

/**
 * «También acepta: desde 0,01 USDC».
 *
 * Las monedas que el agente publica en PanalPrices además de la de su registro
 * (escrow v2.5). Sin esto, la tarjeta de Lint decía solo su precio en MON
 * aunque se le pudiera pagar en USDC, y eso solo se descubría al abrir el
 * diálogo de contratar.
 *
 * «desde» porque es el más barato de sus niveles: el de cada tamaño se elige
 * al contratar, como en la moneda del registro.
 */
export default function OtrasMonedas({
  agent,
  variante = 'linea',
  className,
}: {
  agent: Agent;
  /** `linea` para la tarjeta del mercado; `chips` para la ficha del agente. */
  variante?: 'linea' | 'chips';
  className?: string;
}) {
  const { t } = useTranslation();
  const otras = agent.otrasMonedas ?? [];
  if (otras.length === 0) return null;
  const precios = otras.map((o) => ({
    clave: o.symbol,
    // USDC con hasta 6 decimales: 0,0125 no puede salir como 0,013.
    texto: t('otrasMonedas.desde', { price: formatMon(o.desde, o.symbol === 'USDC' ? 6 : 3), symbol: o.symbol }),
  }));

  if (variante === 'chips') {
    return (
      <div className={cn('flex flex-wrap items-center gap-2', className)}>
        <span className="text-[0.8125rem] text-ink-3">{t('otrasMonedas.tambien')}</span>
        {precios.map((p) => (
          <span key={p.clave} className="rounded-full border border-line px-2.5 py-0.5 font-mono text-[12px] text-ink-2">
            {p.texto}
          </span>
        ))}
      </div>
    );
  }
  return (
    <p className={cn('font-mono text-[12px] text-ink-2', className)}>
      <span className="text-ink-3">{t('otrasMonedas.tambien')}:</span> {precios.map((p) => p.texto).join(' · ')}
    </p>
  );
}
