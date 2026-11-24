/**
 * Las dos versiones del escrow en la web (`src/lib/escrow.ts`) y en qué
 * monedas se contrata (`src/lib/monedasDeContratacion.ts`).
 *
 *   pnpm exec tsx scripts/test-escrow-web.ts
 *
 * Desde el 24-nov-2026 la web contrata en el escrow v2.5 y sigue cerrando lo
 * que quedó en el v2. Lo que no puede pasar:
 *
 *   - Mandar un número del v2.5 (1000000005) al escrow equivocado, o el número
 *     de fuera a la cadena (allí es el 5).
 *   - Enseñar un botón que el contrato rechaza: el v2.5 tiene sus propias
 *     reglas (aceptar antes de `acceptBy`, revisión de 24 h a 7 días, disputar
 *     solo dentro de la revisión, pactos, ampliar el plazo hasta 365 días).
 *   - Ofrecer una moneda con un precio de otro nivel: una lista de PanalPrices
 *     solo vale si cuadra con los niveles de la cadena.
 */

import { toFunctionSelector, type Abi, type Address, type Hex } from 'viem';
import { panalEscrowV2_5Abi } from '@panal/sdk';
import { panalEscrowV2Abi } from '../src/contracts/abis';
import {
  NATIVE_CURRENCY,
  PANAL_ESCROW_V2_5_ADDRESS,
  PANAL_ESCROW_V2_ADDRESS,
  PANAL_TOKEN_ADDRESS,
  USDC_TOKEN_ADDRESS,
} from '../src/contracts/config';
import {
  DISPUTA_CADUCA_S,
  ESTADO,
  diasAmpliables,
  disputaCaducada,
  etiquetaTarea,
  finDeRevision,
  idDelV2_5,
  llamadaDeEscrow,
  numeroVisible,
  quePuede,
  versionDeTarea,
  type AccionDeEscrow,
  type TareaParaReglas,
} from '../src/lib/escrow';
import {
  importeEn,
  minimoDelEscrowV2_5,
  monedasParaContratar,
  otrasMonedasDe,
  precioEnMoneda,
  tiemposDeEncargo,
  type DatosDelAgente,
} from '../src/lib/monedasDeContratacion';
import type { Agent } from '../src/data/agents';

let fallos = 0;
const check = (nombre: string, ok: boolean, detalle = ''): void => {
  console.log(`${ok ? '✅' : '❌'} ${nombre}${ok ? '' : ` — ${detalle}`}`);
  if (!ok) fallos++;
};
const lanza = (f: () => unknown): boolean => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};
const json = (x: unknown): string => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? `${v}n` : v));

const V2 = 140n;
const V25 = idDelV2_5(5n);
const TRABAJADOR = '0x00000000000000000000000000000000000000aa' as Address;
const NADIE = '0x0000000000000000000000000000000000000000' as Address;
const AHORA = 2_000_000_000;
const A = BigInt(AHORA);
const DIA = 86_400n;

console.log('\n─── números de tarea ───');
check('el v2 se queda como está', versionDeTarea(V2) === 'v2' && etiquetaTarea(V2) === '#140' && numeroVisible(V2) === '140');
check('el v2.5 se enseña con su número de la cadena', versionDeTarea(V25) === 'v2_5' && etiquetaTarea(V25) === '#5 · v2.5', etiquetaTarea(V25));

console.log('\n─── cada acción va a su escrow, con el número de la cadena ───');
{
  const aprobar2 = llamadaDeEscrow(V2, { tipo: 'aprobar', nota: 5 });
  const aprobar25 = llamadaDeEscrow(V25, { tipo: 'aprobar', nota: 5 });
  check('aprobar en el v2', aprobar2.address === PANAL_ESCROW_V2_ADDRESS && json(aprobar2.args) === json([140n, 5]), json(aprobar2));
  check('aprobar en el v2.5 manda el 5, no el 1000000005', aprobar25.address === PANAL_ESCROW_V2_5_ADDRESS && json(aprobar25.args) === json([5n, 5]), json(aprobar25));

  const lib2 = llamadaDeEscrow(V2, { tipo: 'liberar' });
  const lib25 = llamadaDeEscrow(V25, { tipo: 'liberar' });
  check('liberar: autoRelease en el v2', lib2.functionName === 'autoRelease' && json(lib2.args) === json([140n]));
  check('liberar: release([id]) en el v2.5', lib25.functionName === 'release' && json(lib25.args) === json([[5n]]), json(lib25));

  const disp2 = llamadaDeEscrow(V2, { tipo: 'disputar', motivo: 'no entregó' });
  const disp25 = llamadaDeEscrow(V25, { tipo: 'disputar' });
  const disp25m = llamadaDeEscrow(V25, { tipo: 'disputar', motivo: '  no entregó ' });
  check('disputar en el v2 no lleva motivo', json(disp2.args) === json([140n]));
  check('disputar en el v2.5 sin motivo lleva la huella cero', (disp25.args?.[1] as Hex) === `0x${'0'.repeat(64)}`, json(disp25));
  check(
    'disputar en el v2.5 con motivo lleva su huella (sin espacios de más)',
    (disp25m.args?.[1] as Hex) !== `0x${'0'.repeat(64)}` &&
      (disp25m.args?.[1] as Hex) === (llamadaDeEscrow(V25, { tipo: 'disputar', motivo: 'no entregó' }).args?.[1] as Hex),
  );

  const caduca2 = llamadaDeEscrow(V2, { tipo: 'cerrarDisputaCaducada' });
  const caduca25 = llamadaDeEscrow(V25, { tipo: 'cerrarDisputaCaducada' });
  check('disputa caducada: resolveStuckDispute en el v2', caduca2.functionName === 'resolveStuckDispute');
  check('disputa caducada: resolveExpiredDispute en el v2.5', caduca25.functionName === 'resolveExpiredDispute');

  const solo25: AccionDeEscrow[] = [
    { tipo: 'aceptar' },
    { tipo: 'rechazar' },
    { tipo: 'proponerAcuerdo', repartoBps: 6000 },
    { tipo: 'aceptarAcuerdo', repartoBps: 6000 },
    { tipo: 'ampliarPlazo', plazo: A + 10n * DIA },
    { tipo: 'cumplirDecision' },
  ];
  check('lo que solo existe en el v2.5 no se firma contra el v2', solo25.every((a) => lanza(() => llamadaDeEscrow(V2, a))));
  check('…y en el v2.5 sí', solo25.every((a) => !lanza(() => llamadaDeEscrow(V25, a))));
}

console.log('\n─── cada llamada existe en el ABI de su escrow ───');
{
  const todas: AccionDeEscrow[] = [
    { tipo: 'aprobar', nota: 4 },
    { tipo: 'disputar', motivo: 'x' },
    { tipo: 'cancelar' },
    { tipo: 'liberar' },
    { tipo: 'entregar', resultHash: `0x${'1'.repeat(64)}` },
    { tipo: 'coger' },
    { tipo: 'aceptar' },
    { tipo: 'rechazar' },
    { tipo: 'proponerAcuerdo', repartoBps: 5000 },
    { tipo: 'aceptarAcuerdo', repartoBps: 5000 },
    { tipo: 'ampliarPlazo', plazo: A },
    { tipo: 'cerrarDisputaCaducada' },
    { tipo: 'cumplirDecision' },
  ];
  // `claimTask` es del v2 (tareas abiertas a cualquiera); en el v2.5 no hay.
  const noEnV25 = new Set(['coger']);
  for (const [id, abi, nombre] of [
    [V2, panalEscrowV2Abi as Abi, 'v2'],
    [V25, panalEscrowV2_5Abi as Abi, 'v2.5'],
  ] as const) {
    for (const a of todas) {
      let r;
      try {
        r = llamadaDeEscrow(id, a);
      } catch {
        continue; // ya comprobado arriba: no existe en esa versión
      }
      if (nombre === 'v2.5' && noEnV25.has(a.tipo)) continue;
      const fn = abi.find((x) => x.type === 'function' && x.name === r.functionName);
      const cuadra = !!fn && fn.type === 'function' && fn.inputs.length === (r.args?.length ?? 0);
      check(`${nombre}: ${a.tipo} → ${r.functionName}(${r.args?.length ?? 0})`, cuadra, fn ? toFunctionSelector(fn) : 'no está en el ABI');
    }
  }
}

console.log('\n─── qué se puede hacer: v2.5 ───');
const t25 = (c: Partial<TareaParaReglas>): TareaParaReglas => ({
  id: V25,
  version: 'v2_5',
  status: ESTADO.Abierta,
  worker: TRABAJADOR,
  deadline: A + 2n * DIA,
  createdAt: A - 3600n,
  acceptBy: A + 2n * DIA - 900n,
  aceptada: false,
  reviewWindow: 72 * 3600,
  ...c,
});
{
  const p = quePuede(t25({}), AHORA);
  check('sin aceptar y a tiempo: aceptar, rechazar o entregar directamente', p.aceptar && p.rechazar && p.entregar && !p.cancelar, json(p));
  check('el cliente puede pactar y ampliar el plazo', p.pactar && p.ampliarPlazo, json(p));

  const tarde = quePuede(t25({ acceptBy: A - 1n }), AHORA);
  check('pasado su tiempo de aceptar: ya no se acepta ni se entrega, y el cliente cancela', !tarde.aceptar && !tarde.entregar && tarde.cancelar, json(tarde));

  const enMarcha = quePuede(t25({ aceptada: true, acceptBy: A - 1n }), AHORA);
  check('aceptada: se entrega hasta el plazo y el cliente no cancela', enMarcha.entregar && !enMarcha.cancelar && !enMarcha.aceptar, json(enMarcha));

  const vencida = quePuede(t25({ aceptada: true, deadline: A - 1n }), AHORA);
  check('aceptada y vencida: no se entrega, el cliente cancela', !vencida.entregar && vencida.cancelar, json(vencida));

  const sinNadie = quePuede(t25({ worker: NADIE }), AHORA);
  check('sin trabajador: se cancela, no se acepta ni se pacta', sinNadie.cancelar && !sinNadie.aceptar && !sinNadie.pactar, json(sinNadie));

  const entregada = t25({ status: ESTADO.Entregada, deliveredAt: A - 3600n, reviewWindow: 24 * 3600 });
  const enRev = quePuede(entregada, AHORA);
  check('en revisión: aprobar o disputar (las dos partes); liberar todavía no', enRev.aprobar && enRev.disputarComoCliente && enRev.disputarComoTrabajador && !enRev.liberar, json(enRev));
  check('la revisión es la que se eligió al contratar', finDeRevision(entregada) === A - 3600n + 24n * 3600n);

  const pasada = quePuede(t25({ status: ESTADO.Entregada, deliveredAt: A - 25n * 3600n, reviewWindow: 24 * 3600 }), AHORA);
  check('pasada la revisión: liberar sí, disputar ya no, aprobar sigue', pasada.liberar && !pasada.disputarComoCliente && !pasada.disputarComoTrabajador && pasada.aprobar, json(pasada));

  const disputa = quePuede(t25({ status: ESTADO.EnDisputa, disputedAt: A - 3600n }), AHORA);
  check('en disputa: solo pactar', disputa.pactar && !disputa.aprobar && !disputa.cancelar && !disputa.entregar, json(disputa));

  const alTope = t25({ createdAt: A - DIA, deadline: A - DIA + 365n * DIA });
  check('el plazo no pasa de 365 días desde que se creó', diasAmpliables(alTope) === 0 && !quePuede(alTope, AHORA).ampliarPlazo);
  check('días que se pueden añadir', diasAmpliables({ createdAt: 0n, deadline: 7n * DIA }) === 358);
}

console.log('\n─── qué se puede hacer: v2 ───');
const t2 = (c: Partial<TareaParaReglas>): TareaParaReglas => ({
  id: V2,
  version: 'v2',
  status: ESTADO.Abierta,
  worker: TRABAJADOR,
  deadline: A + DIA,
  ...c,
});
{
  const abierta = quePuede(t2({}), AHORA);
  check('en el v2 no se acepta, ni se rechaza, ni se pacta, ni se amplía', !abierta.aceptar && !abierta.rechazar && !abierta.pactar && !abierta.ampliarPlazo, json(abierta));
  check('en el v2 se entrega con la tarea abierta y a tiempo', abierta.entregar && !abierta.cancelar);
  check('en el v2, sin trabajador, se cancela', quePuede(t2({ worker: NADIE }), AHORA).cancelar);

  const rev = quePuede(t2({ status: ESTADO.Entregada, deliveredAt: A - 71n * 3600n }), AHORA);
  const fuera = quePuede(t2({ status: ESTADO.Entregada, deliveredAt: A - 73n * 3600n }), AHORA);
  check('en el v2 la revisión son 72 h', !rev.liberar && fuera.liberar, json({ rev, fuera }));
}

console.log('\n─── disputas que caducan ───');
{
  const d = (hace: bigint): TareaParaReglas => t25({ status: ESTADO.EnDisputa, disputedAt: A - hace });
  check('a los 14 días justos todavía no', !disputaCaducada(d(BigInt(DISPUTA_CADUCA_S)), AHORA));
  check('un segundo después, sí', disputaCaducada(d(BigInt(DISPUTA_CADUCA_S) + 1n), AHORA));
}

console.log('\n─── en qué monedas se contrata ───');
{
  const PANAL = PANAL_TOKEN_ADDRESS as Address;
  const base: DatosDelAgente = {
    registro: NATIVE_CURRENCY,
    precios: { mon: [], panal: [], usdc: [2_500_000n] },
    nivelesEnCadena: 0,
    nivelesVisibles: 0,
  };
  check('sin niveles, un precio en USDC basta', json(monedasParaContratar(base)) === json([NATIVE_CURRENCY, USDC_TOKEN_ADDRESS]));
  check('la del registro siempre primero, y con su precio', importeEn(base, NATIVE_CURRENCY, 0, 5n * 10n ** 16n) === 5n * 10n ** 16n);
  check('el importe en USDC sale de PanalPrices', importeEn(base, USDC_TOKEN_ADDRESS, 0, 1n) === 2_500_000n);

  const tresNiveles: DatosDelAgente = { ...base, nivelesEnCadena: 3, nivelesVisibles: 3 };
  check('con tres niveles, un precio suelto NO vale', json(monedasParaContratar(tresNiveles)) === json([NATIVE_CURRENCY]));
  check('…ni da importe', importeEn(tresNiveles, USDC_TOKEN_ADDRESS, 1, 1n) === null);

  const tresPrecios: DatosDelAgente = { ...tresNiveles, precios: { mon: [], panal: [], usdc: [1_000_000n, 2_000_000n, 3_000_000n] } };
  check('con tres niveles y tres precios, sí; el nivel i paga el precio i', importeEn(tresPrecios, USDC_TOKEN_ADDRESS, 1, 1n) === 2_000_000n);

  const deTarjeta: DatosDelAgente = { ...base, nivelesVisibles: 2 };
  check('con niveles solo en la tarjeta del bot, no se ofrece otra moneda', json(monedasParaContratar(deTarjeta)) === json([NATIVE_CURRENCY]));

  const conCero: DatosDelAgente = { ...base, precios: { mon: [], panal: [], usdc: [0n] } };
  check('un precio cero no vale', json(monedasParaContratar(conCero)) === json([NATIVE_CURRENCY]));

  check('si PanalPrices no se pudo leer, solo la del registro', json(monedasParaContratar({ ...base, precios: null })) === json([NATIVE_CURRENCY]));

  const enPanal: DatosDelAgente = { ...base, registro: PANAL, precios: { mon: [10n ** 16n], panal: [5n], usdc: [] } };
  check('la moneda del registro no se repite ni la pisa PanalPrices', json(monedasParaContratar(enPanal)) === json([PANAL, NATIVE_CURRENCY]) && importeEn(enPanal, PANAL, 0, 100n) === 100n);
}

console.log('\n─── el mercado: otras monedas y el filtro ───');
{
  // Lint tal cual está en la cadena: MON en el registro, tres niveles y USDC en PanalPrices.
  const lint = { mon: [], panal: [], usdc: [10_000n, 20_000n, 40_000n] };
  const otras = otrasMonedasDe(NATIVE_CURRENCY, lint, 3);
  check('Lint: también USDC, desde 0,01', otras.length === 1 && otras[0]!.symbol === 'USDC' && otras[0]!.desdeWei === 10_000n && otras[0]!.desde === 0.01, json(otras));
  check('el «desde» es el más barato aunque no vaya primero', otrasMonedasDe(NATIVE_CURRENCY, { ...lint, usdc: [40_000n, 10_000n, 20_000n] }, 3)[0]?.desde === 0.01);
  check('una lista que no cuadra con los niveles no se anuncia', otrasMonedasDe(NATIVE_CURRENCY, lint, 2).length === 0);
  check('la moneda del registro no sale como «otra»', otrasMonedasDe(NATIVE_CURRENCY, { ...lint, mon: [1n, 2n, 3n] }, 3).every((o) => o.symbol !== 'MON'));

  const agente = { currency: NATIVE_CURRENCY, pricePerTask: 0.005, otrasMonedas: otras } as unknown as Agent;
  check('filtro MON: el precio del registro', precioEnMoneda(agente, 'mon') === 0.005);
  check('filtro USDC: el de PanalPrices', precioEnMoneda(agente, 'usdc') === 0.01);
  check('filtro $PANAL: no lo acepta', precioEnMoneda(agente, 'panal') === null);
  const sinPrecios = { currency: PANAL_TOKEN_ADDRESS, pricePerTask: 5 } as unknown as Agent;
  check('sin PanalPrices: solo la moneda del registro', precioEnMoneda(sinPrecios, 'panal') === 5 && precioEnMoneda(sinPrecios, 'usdc') === null);
}

console.log('\n─── mínimos y tiempos del v2.5 ───');
{
  check('mínimos del escrow', minimoDelEscrowV2_5(USDC_TOKEN_ADDRESS) === 10_000n && minimoDelEscrowV2_5(PANAL_TOKEN_ADDRESS) === 10n ** 18n && minimoDelEscrowV2_5(NATIVE_CURRENCY) === 10n ** 15n);

  const t = tiemposDeEncargo(AHORA, 24, 72);
  check('plazo y revisión', t.deadline === A + DIA && t.reviewWindow === 72 * 3600, json(t));
  check('se puede aceptar hasta 15 min antes del plazo (margen para minar)', A + BigInt(t.acceptWindow) === t.deadline - 900n, json(t));
  for (const h of [24, 72, 168]) {
    const r = tiemposDeEncargo(AHORA, 48, h).reviewWindow;
    check(`revisión de ${h} h dentro de 24 h–7 días`, r >= 24 * 3600 && r <= 7 * 24 * 3600);
  }
  const corto = tiemposDeEncargo(AHORA, 0.25, 24);
  check('nunca menos de los 5 min del contrato para aceptar', corto.acceptWindow === 300 && A + 300n <= corto.deadline, json(corto));
}

console.log(fallos === 0 ? '\n✅ todo en orden\n' : `\n❌ ${fallos} fallo(s)\n`);
process.exit(fallos === 0 ? 0 : 1);
