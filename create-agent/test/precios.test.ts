/**
 * `npm run precios`: lo que se publica en PanalPrices desde la plantilla.
 *
 *     npx tsx test/precios.test.ts
 *
 * Hermético: solo lee lo escrito en la línea de órdenes. Lo que protege es que
 * no se firme nada que el contrato rechazaría (y Monad cobraría igual) ni una
 * lista que no cuadra con los niveles, que nadie podría usar.
 */

import { leerPrecios, leerSimbolo } from '../template/src/precios.js';

let fallos = 0;
const check = (nombre: string, ok: boolean, detalle = ''): void => {
  console.log(`${ok ? '✅' : '❌'} ${nombre}${ok ? '' : ` — ${detalle}`}`);
  if (!ok) fallos++;
};
const json = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

console.log('\nla moneda');
check('USDC, PANAL, $PANAL y MON, en mayúsculas o no', leerSimbolo('usdc') === 'USDC' && leerSimbolo('PANAL') === '$PANAL' && leerSimbolo('$panal') === '$PANAL' && leerSimbolo('mon') === 'MON');
check('otra cosa, no', leerSimbolo('EUR') === null && leerSimbolo(undefined) === null);

console.log('\nlos precios');
const sinNiveles = leerPrecios(['2.5'], 'USDC', 0);
check('sin niveles, uno, en 6 decimales', sinNiveles.ok && json(sinNiveles.precios) === '["2500000"]', json(sinNiveles));
const tres = leerPrecios(['1', '2,5', '6'], 'USDC', 3);
check('con tres niveles, tres, y la coma vale', tres.ok && json(tres.precios) === '["1000000","2500000","6000000"]', json(tres));
check('off deja de aceptarla (lista vacía)', json(leerPrecios(['off'], 'USDC', 3)) === '{"ok":true,"precios":[]}');
check('con tres niveles, uno solo no', !leerPrecios(['2'], 'USDC', 3).ok);
check('sin niveles, dos no', !leerPrecios(['1', '2'], 'USDC', 0).ok);
check('desordenados no: el contrato los quiere de menor a mayor', !leerPrecios(['5', '1'], 'USDC', 2).ok);
check('por debajo del mínimo del escrow no (0,01 USDC)', !leerPrecios(['0.001'], 'USDC', 0).ok);
check('más decimales de los que tiene la moneda, no', !leerPrecios(['1.0000001'], 'USDC', 0).ok);
check('en $PANAL, 18 decimales', json(leerPrecios(['100'], '$PANAL', 0)) === '{"ok":true,"precios":["100000000000000000000"]}');
check('basura, no', !leerPrecios(['dos'], 'MON', 0).ok);

console.log(fallos === 0 ? '\n✅ precios: todo bien' : `\n❌ precios: ${fallos} fallo(s)`);
process.exit(fallos === 0 ? 0 : 1);
