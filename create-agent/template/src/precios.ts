/**
 * Lo que cobras en otras monedas, USDC incluido (PanalPrices, escrow v2.5).
 *
 *   npm run precios                       → lo que tienes publicado
 *   npm run precios -- USDC 2.5           → un precio, si no vendes niveles
 *   npm run precios -- USDC 1 2.5 6       → uno por nivel, de menor a mayor
 *   npm run precios -- USDC off           → dejar de aceptar USDC
 *
 * Tu registro guarda UN precio en UNA moneda (MON o $PANAL), y tus niveles van
 * en esa moneda. Desde el escrow v2.5 puedes cobrar además en las otras: se
 * publica en PanalPrices una lista por moneda, con un precio por cada nivel de
 * tu ficha y en el mismo orden (de menor a mayor), o uno solo si no tienes
 * niveles. La web ofrece esa moneda al contratarte y este agente la acepta,
 * midiendo el nivel comprado con esa lista.
 *
 * Si cambias tus niveles, vuelve a publicar estos precios: una lista que no
 * cuadra con ellos no la usa nadie, porque no se sabría qué nivel se pagó.
 *
 * Es una transacción por moneda, con el gas fijado a mano (Monad cobra el
 * límite entero; ver retirada.ts).
 */

import { pathToFileURL } from 'node:url';
import { formatUnits, parseUnits } from 'viem';
import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { NATIVE_CURRENCY, USDC_DECIMALES, createPanalClient, leerNivelesDeMetadata, panalPricesAbi } from '@panal/sdk';
import { TOPE_GAS, gasConMargen } from './retirada.js';

export type Simbolo = 'MON' | '$PANAL' | 'USDC';

/** Los mínimos del escrow v2.5: un precio por debajo no se podría contratar. */
export const MINIMO: Record<Simbolo, string> = { MON: '0.001', $PANAL: '1', USDC: '0.01' };

export const decimalesDe = (s: Simbolo): number => (s === 'USDC' ? USDC_DECIMALES : 18);

/** La moneda tal como se escribe en la línea de órdenes. */
export function leerSimbolo(texto: string | undefined): Simbolo | null {
  const t = (texto ?? '').trim().toUpperCase().replace(/^\$/, '');
  return t === 'MON' ? 'MON' : t === 'PANAL' ? '$PANAL' : t === 'USDC' ? 'USDC' : null;
}

/**
 * Los precios escritos, en unidades mínimas, o el motivo por el que no valen.
 * `off` (o nada) es la lista vacía: dejar de aceptar la moneda.
 */
export function leerPrecios(
  textos: string[],
  simbolo: Simbolo,
  niveles: number,
): { ok: true; precios: bigint[] } | { ok: false; motivo: string } {
  if (textos.length === 0 || (textos.length === 1 && textos[0]!.trim().toLowerCase() === 'off')) {
    return { ok: true, precios: [] };
  }
  const dec = decimalesDe(simbolo);
  const precios: bigint[] = [];
  for (const crudo of textos) {
    const t = crudo.replace(',', '.').trim();
    if (!new RegExp(`^\\d+(\\.\\d{1,${dec}})?$`).test(t)) return { ok: false, motivo: `«${crudo}» no es un importe en ${simbolo}` };
    precios.push(parseUnits(t, dec));
  }
  const hacen = Math.max(1, niveles);
  if (precios.length !== hacen) {
    return {
      ok: false,
      motivo:
        niveles > 0
          ? `tienes ${niveles} niveles en tu ficha: hacen falta ${niveles} precios, uno por nivel y en el mismo orden`
          : 'no tienes niveles en tu ficha: va un solo precio por encargo',
    };
  }
  const minimo = parseUnits(MINIMO[simbolo], dec);
  if (precios.some((p) => p < minimo)) return { ok: false, motivo: `el escrow no admite menos de ${MINIMO[simbolo]} ${simbolo}` };
  if (precios.some((p, i) => i > 0 && p < precios[i - 1]!)) return { ok: false, motivo: 'van de menor a mayor, como tus niveles' };
  return { ok: true, precios };
}

async function main(): Promise<void> {
  await import('dotenv/config');
  const clave = process.env.AGENT_PRIVATE_KEY?.trim();
  if (!clave || !/^0x[0-9a-fA-F]{64}$/.test(clave)) {
    console.error('Falta AGENT_PRIVATE_KEY en el .env (0x + 64 hex).');
    process.exit(1);
  }
  const account = privateKeyToAccount(clave as `0x${string}`);
  const panal = createPanalClient({ account, rpcUrl: process.env.RPC_URL });
  const v = panal.v2_5;
  if (!v) {
    console.error(`PanalPrices no está desplegado en ${panal.network}: solo existe en mainnet.`);
    process.exit(1);
  }
  const agente = await panal.getAgent(account.address);
  if (agente.registeredAt === 0n) {
    console.error('Aún no estás dado de alta: primero npm run register.');
    process.exit(1);
  }
  const niveles = leerNivelesDeMetadata(agente.metadataURI).length;
  const delRegistro = agente.currency ?? NATIVE_CURRENCY;
  const direccion: Record<Simbolo, Address> = { MON: NATIVE_CURRENCY, $PANAL: panal.addresses.panalToken, USDC: v.usdc };
  const esDelRegistro = (s: Simbolo) => direccion[s].toLowerCase() === delRegistro.toLowerCase();

  const [, , ...args] = process.argv;
  const simbolo = leerSimbolo(args[0]);

  // Sin argumentos: enseñar lo que hay.
  if (!args[0]) {
    console.log(`\nTu registro cobra en ${(Object.keys(direccion) as Simbolo[]).find(esDelRegistro) ?? '?'}` +
      ` · ${niveles > 0 ? `${niveles} niveles` : 'sin niveles'}\n`);
    for (const s of Object.keys(direccion) as Simbolo[]) {
      if (esDelRegistro(s)) continue;
      const lista = await panal.getPricesV2_5(account.address, direccion[s]);
      const texto = lista.length ? lista.map((p) => formatUnits(p, decimalesDe(s))).join(' · ') : 'no aceptas';
      const aviso = lista.length && lista.length !== Math.max(1, niveles) ? '  ← no cuadra con tus niveles: nadie la usa' : '';
      console.log(`  ${s.padEnd(6)} ${texto}${aviso}`);
    }
    console.log('\nPara cambiarlos: npm run precios -- USDC 1 2.5 6   (uno por nivel)   ·   npm run precios -- USDC off\n');
    return;
  }
  if (!simbolo) {
    console.error(`«${args[0]}» no es una moneda: MON, PANAL o USDC.`);
    process.exit(1);
  }
  if (esDelRegistro(simbolo)) {
    console.error(`${simbolo} es la moneda de tu registro: ese precio se cambia con npm run register (o desde el panel).`);
    process.exit(1);
  }
  const leido = leerPrecios(args.slice(1), simbolo, niveles);
  if (!leido.ok) {
    console.error(`No publico nada: ${leido.motivo}.`);
    process.exit(1);
  }

  const wallet = panal.walletClient;
  if (!wallet) throw new Error('el cliente no tiene cuenta para firmar');
  const llamada = {
    address: v.prices,
    abi: panalPricesAbi,
    functionName: 'setPrices',
    args: [direccion[simbolo], leido.precios],
  } as const;
  // Si el contrato lo rechazaría (agente inactivo, suspendido…), la estimación
  // ya falla con su motivo y no se firma nada.
  const gas = gasConMargen(await panal.publicClient.estimateContractGas({ ...llamada, account }));
  if (gas > TOPE_GAS) {
    console.error(`La estimación de gas salió en ${gas}: demasiado. No se firma (Monad cobra el límite entero).`);
    process.exit(1);
  }
  const hash = await wallet.writeContract({ ...llamada, gas, chain: panal.publicClient.chain, account });
  const recibo = await panal.publicClient.waitForTransactionReceipt({ hash });
  if (recibo.status !== 'success') {
    console.error(`La transacción revirtió (tx ${hash}): no cambió nada.`);
    process.exit(1);
  }
  console.log(
    leido.precios.length
      ? `Publicado: cobras en ${simbolo} ${leido.precios.map((p) => formatUnits(p, decimalesDe(simbolo))).join(' · ')} · tx ${hash}`
      : `Listo: ya no aceptas ${simbolo} · tx ${hash}`,
  );
}

// Solo al ejecutarlo: las pruebas importan las funciones sin lanzar nada.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
