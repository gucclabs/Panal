#!/usr/bin/env node
/**
 * Genera sdk/src/v2_5-abi.ts con los ABI enteros de los cinco contratos del
 * v2.5 (desplegados y verificados en Monad mainnet el 24-nov-2026).
 *
 *   node scripts/abi-v2-5.mjs <carpeta out/ de Foundry>
 *   node scripts/abi-v2-5.mjs <carpeta out/> --comprobar   (falla si el SDK se quedó atrás)
 *
 * La carpeta es la `out/` de los contratos del v2.5 ya compilados (`forge
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
  ['PanalEscrowV2_5', 'panalEscrowV2_5Abi'],
  ['PanalTablonV2_5', 'panalTablonV2_5Abi'],
  ['PanalReputationV2_5', 'panalReputationV2_5Abi'],
  ['PanalBans', 'panalBansAbi'],
  ['PanalPrices', 'panalPricesAbi'],
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
 * Panal SDK — los ABI enteros de los contratos del v2.5.
 *
 * GENERADO, NO SE EDITA A MANO. Son los de los contratos desplegados y
 * verificados en Monad mainnet el 24-nov-2026 (ver v2_5.ts). Se regenera con:
 *
 *   node scripts/abi-v2-5.mjs <carpeta out/ de Foundry de los contratos v2.5>
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
