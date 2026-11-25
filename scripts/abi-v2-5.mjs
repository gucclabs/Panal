#!/usr/bin/env node
/**
 * Genera sdk/src/v2_5-abi.ts con los ABI enteros de los contratos de Panal V3
 * (desplegados y verificados en Monad mainnet el 25-nov-2026). El V3 ocupa el
 * hueco del v2.5 —los números de más de mil millones—, así que los exports
 * conservan sus nombres `…V2_5Abi`: la web, la app y el MCP no cambian de
 * import. El v2.5 del 24-nov quedó vacío y sin uso.
 *
 *   node scripts/abi-v2-5.mjs <carpeta out/ de Foundry>
 *   node scripts/abi-v2-5.mjs <carpeta out/> --comprobar   (falla si el SDK se quedó atrás)
 *
 * La carpeta es la `out/` de los contratos del V3 ya compilados (`forge
 * build`). Su código es el verificado en Sourcify (exact match), así que el
 * ABI también se puede comprobar contra el de Sourcify para cada dirección.
 *
 * Van enteros —funciones, eventos y errores— por lo mismo que el del tablón:
 * sin los errores con nombre, viem no sabe decir por qué revirtió algo.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const carpeta = process.argv[2];
if (!carpeta || carpeta.startsWith('--')) {
  console.error('uso: node scripts/abi-v2-5.mjs <carpeta out/ de Foundry> [--comprobar]');
  process.exit(2);
}
const DESTINO = 'sdk/src/v2_5-abi.ts';

/** [contrato, nombre del export] */
const CONTRATOS = [
  ['PanalEscrowV3', 'panalEscrowV2_5Abi'],
  ['PanalBoardV3', 'panalTablonV2_5Abi'],
  ['PanalReputationV3', 'panalReputationV2_5Abi'],
  ['PanalBans', 'panalBansAbi'],
  ['PanalPricesV3', 'panalPricesAbi'],
  ['PanalCurrencies', 'panalCurrenciesAbi'],
  ['PanalRegistryV3', 'panalRegistryV3Abi'],
  ['PanalNamesV2', 'panalNamesV2Abi'],
];

let total = 0;
const partes = CONTRATOS.map(([contrato, nombre]) => {
  const abi = JSON.parse(readFileSync(join(carpeta, `${contrato}.sol`, `${contrato}.json`), 'utf8')).abi.filter(
    (x) => x.type !== 'constructor' && x.type !== 'receive',
  );
  total += abi.length;
  return `/** ${contrato}. */\nexport const ${nombre} = ${JSON.stringify(abi, null, 2)} as const;\n`;
});

const texto = `/**
 * Panal SDK — los ABI enteros de los contratos de Panal V3.
 *
 * GENERADO, NO SE EDITA A MANO. Son los de los contratos desplegados y
 * verificados en Monad mainnet el 25-nov-2026 (ver v2_5.ts). El V3 ocupa el
 * hueco del v2.5, así que los exports conservan sus nombres: el del escrow es
 * PanalEscrowV3, el del tablón PanalBoardV3, el de la reputación
 * PanalReputationV3 y el de los precios PanalPricesV3. Se regenera con:
 *
 *   node scripts/abi-v2-5.mjs <carpeta out/ de Foundry de los contratos V3>
 */

${partes.join('\n')}`;

if (process.argv.includes('--comprobar')) {
  const actual = readFileSync(DESTINO, 'utf8');
  if (actual !== texto) {
    console.error(`✗ ${DESTINO} no es el ABI de ${carpeta}: regenéralo con node scripts/abi-v2-5.mjs`);
    process.exit(1);
  }
  console.log(`✓ ${DESTINO} cuadra con los contratos (${total} entradas)`);
} else {
  writeFileSync(DESTINO, texto);
  console.log(`${DESTINO}: ${total} entradas en ${CONTRATOS.length} contratos`);
}
