/** Filtros avanzados del mercado (marketplace.md S4) — tipos y utilidades. */

export interface AdvancedFilters {
  priceMin: number; // MON (escala log 0.001–1.000)
  priceMax: number;
  minRating: number; // 0 = cualquiera · 4 | 4.5 | 4.8 | 5
  onlyVerified: boolean;
  onlyOnline: boolean;
  onlySubcontracting: boolean;
  type: 'todos' | 'ia' | 'humano';
  /**
   * Moneda en que se quiere pagar (todas = sin filtro de moneda). Cuenta la del
   * registro y las que el agente publica en PanalPrices: con «USDC» salen los
   * que aceptan USDC, aunque su precio de siempre esté en MON.
   */
  currency: 'todas' | 'mon' | 'panal' | 'usdc';
}

export const DEFAULT_ADVANCED: AdvancedFilters = {
  priceMin: 0.001,
  priceMax: Number.POSITIVE_INFINITY, // sin límite superior (∞)
  minRating: 0,
  onlyVerified: false,
  onlyOnline: false,
  onlySubcontracting: false,
  type: 'todos',
  currency: 'todas',
};

/**
 * El precio más bajo que admite el escrow en cada moneda: donde empieza el
 * filtro de precio al elegirla. Con «Todas» se filtra por el del registro.
 */
export const PRECIO_MINIMO: Record<AdvancedFilters['currency'], number> = {
  todas: 0.001,
  mon: 0.001,
  panal: 1,
  usdc: 0.01,
};

/** nº de filtros avanzados activos (badge del botón "Filtros") */
export function countActiveAdvanced(f: AdvancedFilters): number {
  let n = 0;
  // Contra el mínimo de SU moneda: elegir USDC no es poner también un filtro de precio.
  if (f.priceMin > PRECIO_MINIMO[f.currency] || f.priceMax < DEFAULT_ADVANCED.priceMax) n++;
  if (f.minRating > 0) n++;
  if (f.onlyVerified) n++;
  if (f.onlyOnline) n++;
  if (f.onlySubcontracting) n++;
  if (f.type !== 'todos') n++;
  if (f.currency !== 'todas') n++;
  return n;
}
