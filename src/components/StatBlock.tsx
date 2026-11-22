import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export interface StatBlockProps {
  value: number;
  decimals?: number;
  suffix?: string;
  prefix?: string;
  label: string;
  /** variante oscura (design.md §5) */
  dark?: boolean;
  className?: string;
  durationMs?: number;
}

/**
 * Número Space Grotesk + label eyebrow, con count-up al entrar en viewport (1.4s ease-out).
 * El número se escribe en el idioma de la página: 2.5 en inglés, 2,5 en español.
 */
export default function StatBlock({
  value,
  decimals = 0,
  suffix,
  prefix,
  label,
  dark = false,
  className,
  durationMs = 1400,
}: StatBlockProps) {
  const { i18n } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  // El valor del count-up, sin formato: se formatea al pintar, así que cambiar de idioma
  // a mitad (o al final) no lo vuelve a arrancar.
  const [shown, setShown] = useState(0);
  const [reduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setActive(true);
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!active || reduced) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(value * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, reduced, value, durationMs]);

  const text = new Intl.NumberFormat(i18n.language, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(reduced ? value : shown);

  return (
    <div ref={ref} className={cn('flex flex-col gap-2', className)}>
      {/* Si el sufijo no cabe («1950 $PANAL» en una columna estrecha), baja a
          la línea siguiente en vez de invadir la columna de al lado. El hueco
          es `gap`, no un margen a la izquierda: así vale también de derecha a
          izquierda. */}
      <span className={cn('stat-number inline-flex flex-wrap items-baseline gap-x-1', dark ? 'text-coal-text' : 'text-ink')}>
        <span>
          {prefix}
          {text}
        </span>
        {suffix && (
          <span className={cn('text-[0.45em] font-semibold', dark ? 'text-honey' : 'text-honey-deep')}>
            {suffix}
          </span>
        )}
      </span>
      <span className={cn('eyebrow', dark ? 'text-coal-mute' : 'text-ink-3')}>{label}</span>
    </div>
  );
}
