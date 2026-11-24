/**
 * Pruebas de las otras monedas de un agente (PanalPrices, v2.5).
 *
 *   npx tsx test/otras-monedas.test.ts
 *
 * HERMÉTICO: no toca la red. El cliente es de mentira y devuelve lo que la
 * cadena tiene hoy para Lint: MON en el registro y USDC en PanalPrices, con
 * tres niveles.
 */

import type { Address } from 'viem';
import { NATIVE_CURRENCY, componerNivel, leerNivelesDeMetadata, type Agent, type PanalClient } from '@panal/sdk';
import { importe, lineaOtrasMonedas, otrasMonedasDe, precioParaNivel } from '../src/monedas.js';

let fallos = 0;
const check = (nombre: string, ok: boolean, detalle = ''): void => {
  console.log(`${ok ? '✅' : '❌'} ${nombre}${ok ? '' : ` — ${detalle}`}`);
  if (!ok) fallos++;
};

const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as Address;
const PANAL = '0x0000000000000000000000000000000000000ABC' as Address;
const PRICES = '0x90CBa3BE239FcA150Fc8fAfC10D6bD7CCb547663' as Address;
const LINT = '0x1558cf6aed695f3f8aafe488058efe28d216e69c' as Address;
const OTRO = '0x00000000000000000000000000000000000000aa' as Address;

// Tres niveles en la ficha de la cadena, como Lint, escritos con el SDK.
const TRES_NIVELES = [
  'Lint',
  componerNivel({ name: 'Small', precio: '1' }),
  componerNivel({ name: 'Medium', precio: '2' }),
  componerNivel({ name: 'Large', precio: '4' }),
].join(' · ');
if (leerNivelesDeMetadata(TRES_NIVELES).length !== 3) throw new Error(`la ficha de prueba no tiene 3 niveles: ${TRES_NIVELES}`);

function agente(address: Address, metadataURI: string, currency: Address = NATIVE_CURRENCY): Agent {
  return { address, metadataURI, currency, active: true } as unknown as Agent;
}

/** Un cliente con PanalPrices de mentira: lo que devuelve cada `getAllPrices`. */
function cliente(precios: Record<string, [bigint[], bigint[], bigint[]] | 'falla'>, conV2_5 = true): PanalClient {
  return {
    v2_5: conV2_5 ? { prices: PRICES, usdc: USDC } : null,
    addresses: { panalToken: PANAL },
    publicClient: {
      multicall: async ({ contracts }: { contracts: Array<{ args: [Address] }> }) =>
        contracts.map((c) => {
          const r = precios[c.args[0].toLowerCase()];
          return !r || r === 'falla' ? { status: 'failure' } : { status: 'success', result: r };
        }),
    },
  } as unknown as PanalClient;
}

const lint = agente(LINT, TRES_NIVELES);
const usdcLint: [bigint[], bigint[], bigint[]] = [[], [], [10_000n, 20_000n, 40_000n]];

{
  const m = await otrasMonedasDe(cliente({ [LINT]: usdcLint }), [lint]);
  const otras = m.get(LINT) ?? [];
  check('Lint: también USDC, con sus tres precios', otras.length === 1 && otras[0]!.simbolo === 'USDC' && otras[0]!.decimales === 6 && otras[0]!.precios.join() === '10000,20000,40000', JSON.stringify(otras, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  check('el precio de cada tamaño', precioParaNivel(otras[0]!, 0) === 10_000n && precioParaNivel(otras[0]!, 2) === 40_000n && precioParaNivel(otras[0]!, 9) === 40_000n);
  check('importe con los 6 decimales de USDC', importe(otras[0]!, 10_000n) === '0.01 USDC', importe(otras[0]!, 10_000n));
  const linea = lineaOtrasMonedas(otras, 'X');
  check('la línea de la ficha', linea.length === 1 && linea[0] === '  Also accepts: 0.01 / 0.02 / 0.04 USDC (one price per size, same order as above) — X', linea[0]);
}

{
  const m = await otrasMonedasDe(cliente({ [LINT]: [[], [], [10_000n, 20_000n]] }), [lint]);
  check('una lista que no cuadra con los niveles no se anuncia', !m.has(LINT));
}

{
  const sinNiveles = agente(OTRO, 'Otro');
  const uno = await otrasMonedasDe(cliente({ [OTRO]: [[], [], [50_000n]] }), [sinNiveles]);
  check('sin niveles: vale un precio', uno.get(OTRO)?.[0]?.precios.join() === '50000');
  const dos = await otrasMonedasDe(cliente({ [OTRO]: [[], [], [50_000n, 60_000n]] }), [sinNiveles]);
  check('sin niveles: dos precios no valen', !dos.has(OTRO));
  const cero = await otrasMonedasDe(cliente({ [OTRO]: [[], [], [0n]] }), [sinNiveles]);
  check('un precio a cero no vale', !cero.has(OTRO));
}

{
  const enPanal = agente(OTRO, 'Otro', PANAL);
  const m = await otrasMonedasDe(cliente({ [OTRO]: [[10n ** 16n], [5n], []] }), [enPanal]);
  const otras = m.get(OTRO) ?? [];
  check('la moneda del registro no sale como «otra»', otras.length === 1 && otras[0]!.simbolo === 'MON', JSON.stringify(otras.map((o) => o.simbolo)));
}

{
  const m = await otrasMonedasDe(cliente({ [LINT]: usdcLint, [OTRO]: 'falla' }), [lint, agente(OTRO, 'Otro')]);
  check('si un agente falla, los demás siguen', m.has(LINT) && !m.has(OTRO));
  const sin = await otrasMonedasDe(cliente({ [LINT]: usdcLint }, false), [lint]);
  check('en una red sin v2.5 no hay otras monedas', sin.size === 0);
  check('sin otras monedas, ninguna línea', lineaOtrasMonedas([], 'X').length === 0);
}

console.log(fallos === 0 ? '\n✅ todo en orden\n' : `\n❌ ${fallos} fallo(s)\n`);
process.exit(fallos === 0 ? 0 : 1);
