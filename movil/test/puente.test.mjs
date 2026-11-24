/**
 * La app como wallet de panal.lat (`src/lib/puente.ts`).
 *
 * Lo que se comprueba es lo que decide qué se conecta y qué se firma, sin
 * relé ni teléfono: que el enlace `panal://` traiga la sesión entera, que
 * solo se conecte panal.lat, que la sesión aprobada sea Monad y esta cuenta,
 * y que cada petición de la web se lea bien y pase por la MISMA política que
 * las firmas de la propia app. Esa última parte va con un llavero de verdad:
 * lo armado al aceptar tiene que dejar firmar justo eso, y nada sin armar.
 */
import { webcrypto } from 'node:crypto';

globalThis.__VITE_ENV__ = { VITE_CHAIN: 'mainnet' };

const disco = new Map();
globalThis.localStorage = {
  getItem: (k) => (disco.has(k) ? disco.get(k) : null),
  setItem: (k, v) => disco.set(k, String(v)),
  removeItem: (k) => disco.delete(k),
};
if (!globalThis.crypto.randomUUID) globalThis.crypto.randomUUID = webcrypto.randomUUID.bind(webcrypto);
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');

const { encodeFunctionData, stringToHex, verifyMessage, verifyTypedData, getAddress } = await import('viem');
const ll = await import('../src/lib/llavero.ts');
const ses = await import('../src/lib/sesion.ts');
const { PROVEEDOR } = await import('../src/lib/conector.ts');
const politica = await import('../src/lib/signingPolicy.ts');
const pu = await import('../src/lib/puente.ts');
const { panalEscrowV2Abi, panalTokenAbi } = await import('@/contracts/abis');
const cfg = await import('@/contracts/config');

let bien = 0;
let mal = 0;
const dice = (que, cond) => {
  if (cond) { bien++; console.log('  ✅', que); }
  else { mal++; console.log('  ❌', que); }
};
const lanza = (f) => {
  try { f(); return false; } catch { return true; }
};

const URI = 'wc:8a5b1c2d3e4f5061728394a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f@2?relay-protocol=irn&symKey=1f2e3d4c5b6a79887766554433221100ffeeddccbbaa99887766554433221100&expiryTimestamp=1795000000';

console.log('\nel enlace panal://');
dice('trae la sesión entera', pu.uriDeEnlace(`panal://wc?uri=${encodeURIComponent(URI)}`) === URI);
dice('también con la barra antes de ?', pu.uriDeEnlace(`panal://wc/?uri=${encodeURIComponent(URI)}`) === URI);
dice('panal:// a secas no trae nada que emparejar', pu.uriDeEnlace('panal://') === null);
dice('ni el de volver a firmar', pu.uriDeEnlace('panal:///wc?requestId=1&sessionTopic=abc') === null);
dice('otro esquema no vale', pu.uriDeEnlace(`metamask://wc?uri=${encodeURIComponent(URI)}`) === null);
dice('una uri que no es de WalletConnect v2 no vale', pu.uriDeEnlace(`panal://wc?uri=${encodeURIComponent('wc:abc@1?x=1')}`) === null);
dice('sin escapar se corta y no vale', pu.uriDeEnlace(`panal://wc?uri=${URI}`) === null);

console.log('\nsolo panal.lat');
let o = pu.origenAceptado({ origin: 'https://panal.lat', validation: 'VALID' }, 'https://panal.lat');
dice('panal.lat comprobada se conecta', o.ok && o.comprobado);
o = pu.origenAceptado({ origin: 'https://panal.lat', validation: 'UNKNOWN' }, 'https://panal.lat');
dice('sin verificación también, pero avisando', o.ok && !o.comprobado);
o = pu.origenAceptado(undefined, 'https://panal.lat/app');
dice('vale cualquier página de panal.lat', o.ok);
o = pu.origenAceptado({ origin: 'https://evil.example', validation: 'INVALID' }, 'https://panal.lat');
dice('una web que se hace pasar por panal.lat, no', !o.ok && o.motivo === 'falsa');
o = pu.origenAceptado({ origin: 'https://panal.lat', validation: 'VALID', isScam: true }, 'https://panal.lat');
dice('una marcada como estafa, no', !o.ok && o.motivo === 'estafa');
o = pu.origenAceptado({ origin: 'https://app.uniswap.org', validation: 'VALID' }, 'https://app.uniswap.org');
dice('otra web de verdad, tampoco', !o.ok && o.motivo === 'otraWeb');
dice('panal.lat.otra.com no es panal.lat', !pu.origenAceptado(undefined, 'https://panal.lat.otra.com').ok);
dice('sin https no es panal.lat', !pu.origenAceptado(undefined, 'http://panal.lat').ok);
dice('sin origen, nada', !pu.origenAceptado(undefined, undefined).ok);

console.log('\nla sesión que se aprueba');
const dir = '0x1111111111111111111111111111111111111111';
const deWagmi = {
  requiredNamespaces: {},
  optionalNamespaces: {
    eip155: {
      chains: [pu.CADENA],
      methods: ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4', 'wallet_switchEthereumChain', 'wallet_sendCalls'],
      events: ['chainChanged', 'accountsChanged'],
    },
  },
};
const esp = pu.espaciosAprobados(deWagmi, dir);
dice('Monad y solo Monad', esp.eip155.chains.length === 1 && esp.eip155.chains[0] === 'eip155:143');
dice('con esta cuenta', esp.eip155.accounts[0] === `eip155:143:${getAddress(dir)}`);
dice('y los métodos que la app sabe contestar', esp.eip155.methods.includes('eth_signTypedData_v4') && !esp.eip155.methods.includes('wallet_sendCalls'));
dice('si la web exige otra red, no se aprueba', lanza(() => pu.espaciosAprobados({ requiredNamespaces: { eip155: { chains: ['eip155:1'] } } }, dir)));
dice('ni otra familia de cadenas', lanza(() => pu.espaciosAprobados({ requiredNamespaces: { solana: { chains: ['solana:x'] } } }, dir)));
dice('ni un método que no se contesta', lanza(() => pu.espaciosAprobados({ requiredNamespaces: { eip155: { chains: [pu.CADENA], methods: ['eth_sign'] } } }, dir)));

console.log('\ncon un llavero de verdad');
const llave = await ll.crearLlavero('123456');
const { wallet } = await ll.crearWallet(llave, 'La del móvil');
await ses.abrirSesion(llave, wallet);
const yo = getAddress(ses.cuentaViva().address);
const otro = '0x2222222222222222222222222222222222222222';
const agente = '0x3333333333333333333333333333333333333333';

console.log('\nlo que se lee de cada petición');
dice('cambiar a Monad se contesta sin preguntar', pu.describir('wallet_switchEthereumChain', [{ chainId: '0x8f' }], yo).tipo === 'red');
dice('cambiar a otra red, no', pu.describir('wallet_switchEthereumChain', [{ chainId: '0x1' }], yo).tipo === 'bloqueada');

const brief = stringToHex('Panal brief #12');
let d = pu.describir('personal_sign', [brief, yo], yo);
dice('un mensaje de Panal se enseña con su texto', d.tipo === 'mensaje' && d.texto === 'Panal brief #12');
dice('firmado como otro, no', pu.describir('personal_sign', [brief, otro], yo).tipo === 'bloqueada');
dice('un mensaje cualquiera, no', pu.describir('personal_sign', [stringToHex('Sign in to evil.example'), yo], yo).tipo === 'bloqueada');

const ahora = Date.now();
const permit = (owner, spender, value, deadline, tipo = 'Permit') => ({
  domain: { name: 'Panal', version: '1', chainId: 143, verifyingContract: cfg.PANAL_TOKEN_ADDRESS },
  types: {
    Permit: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  },
  primaryType: tipo,
  message: { owner, spender, value: String(value), nonce: '0', deadline: String(deadline) },
});
const plazo = Math.floor(ahora / 1000) + 300;
d = pu.describir('eth_signTypedData_v4', [yo, JSON.stringify(permit(yo, agente, 500000000000000000n, plazo))], yo);
dice('un permit de x402 se lee: a quién y cuánto', d.tipo === 'permit' && d.a === getAddress(agente) && d.importe === 500000000000000000n);
dice('y cuánto le queda', d.tipo === 'permit' && d.caduca > 240_000 && d.caduca <= 300_000);
dice('un permit a nombre de otro, no', pu.describir('eth_signTypedData_v4', [yo, JSON.stringify(permit(otro, agente, 1n, plazo))], yo).tipo === 'bloqueada');
dice('otros datos tipados, no', pu.describir('eth_signTypedData_v4', [yo, JSON.stringify(permit(yo, agente, 1n, plazo, 'Order'))], yo).tipo === 'bloqueada');

const crear = encodeFunctionData({
  abi: panalEscrowV2Abi,
  functionName: 'createTask',
  args: [agente, `0x${'ab'.repeat(32)}`, 1800000000n, cfg.PANAL_TOKEN_ADDRESS, 10n ** 18n],
});
d = pu.describir('eth_sendTransaction', [{ from: yo, to: cfg.PANAL_ESCROW_V2_ADDRESS, data: crear }], yo);
dice('contratar se lee: agente, importe y moneda', d.tipo === 'encargo' && d.agente === getAddress(agente) && d.importe === 10n ** 18n);
const aprobar = encodeFunctionData({ abi: panalTokenAbi, functionName: 'approve', args: [cfg.PANAL_ESCROW_V2_ADDRESS, 10n ** 18n] });
d = pu.describir('eth_sendTransaction', [{ from: yo, to: cfg.PANAL_TOKEN_ADDRESS, data: aprobar }], yo);
dice('aprobar $PANAL al escrow se lee', d.tipo === 'aprobar' && d.para === 'escrow');
const aOtro = encodeFunctionData({ abi: panalTokenAbi, functionName: 'approve', args: [otro, 10n ** 18n] });
dice('aprobar $PANAL a cualquiera, no', pu.describir('eth_sendTransaction', [{ from: yo, to: cfg.PANAL_TOKEN_ADDRESS, data: aOtro }], yo).tipo === 'bloqueada');
const transferir = encodeFunctionData({ abi: panalTokenAbi, functionName: 'transfer', args: [otro, 10n ** 18n] });
dice('mandar $PANAL a otro, no', pu.describir('eth_sendTransaction', [{ from: yo, to: cfg.PANAL_TOKEN_ADDRESS, data: transferir }], yo).tipo === 'bloqueada');
dice('una llamada a un contrato que no es de Panal, no', pu.describir('eth_sendTransaction', [{ from: yo, to: otro, data: '0x095ea7b3' }], yo).tipo === 'bloqueada');
d = pu.describir('eth_sendTransaction', [{ from: yo, to: agente, value: '0x6f05b59d3b20000' }], yo);
dice('MON a secas se lee como pago de un mensaje', d.tipo === 'pagoMon' && d.importe === 500000000000000000n);
dice('mandado desde otra cuenta, no', pu.describir('eth_sendTransaction', [{ from: otro, to: agente, value: '0x1' }], yo).tipo === 'bloqueada');
dice('crear un contrato, no', pu.describir('eth_sendTransaction', [{ from: yo, data: '0x6080' }], yo).tipo === 'bloqueada');
dice('un método que no se contesta, no', pu.describir('eth_sign', [yo, '0x00'], yo).tipo === 'bloqueada');

console.log('\nfirmar: solo lo que se aceptó');
let fallo = false;
const tipado = permit(yo, agente, 500000000000000000n, plazo);
try {
  await PROVEEDOR.request({ method: 'eth_signTypedData_v4', params: [yo, JSON.stringify(tipado)] });
} catch { fallo = true; }
dice('sin aceptar en la hoja, el permit no se firma', fallo);

pu.armar(pu.describir('eth_signTypedData_v4', [yo, JSON.stringify(tipado)], yo));
const firma = await PROVEEDOR.request({ method: 'eth_signTypedData_v4', params: [yo, JSON.stringify(tipado)] });
dice(
  'aceptado, se firma y la firma es de esta cuenta',
  await verifyTypedData({ address: yo, ...tipado, message: { ...tipado.message, value: BigInt(tipado.message.value), nonce: 0n, deadline: BigInt(plazo) }, signature: firma }),
);
fallo = false;
try {
  await PROVEEDOR.request({ method: 'eth_signTypedData_v4', params: [yo, JSON.stringify(tipado)] });
} catch { fallo = true; }
dice('y vale para una sola firma', fallo);

const deMensaje = await PROVEEDOR.request({ method: 'personal_sign', params: [brief, yo] });
dice('un mensaje de Panal se firma sin armar nada', await verifyMessage({ address: yo, message: 'Panal brief #12', signature: deMensaje }));

dice('contratar sin aceptar, no pasa la política', lanza(() => politica.revisarTransaccion({ to: cfg.PANAL_ESCROW_V2_ADDRESS, data: crear, value: 0n })));
pu.armar(pu.describir('eth_sendTransaction', [{ from: yo, to: cfg.PANAL_ESCROW_V2_ADDRESS, data: crear }], yo));
dice('aceptado, pasa', !lanza(() => politica.revisarTransaccion({ to: cfg.PANAL_ESCROW_V2_ADDRESS, data: crear, value: 0n })));

pu.armar(pu.describir('eth_sendTransaction', [{ from: yo, to: agente, value: '0x6f05b59d3b20000' }], yo));
dice('el MON aceptado pasa por el importe exacto', !lanza(() => politica.revisarTransaccion({ to: agente, value: 500000000000000000n })));
pu.armar(pu.describir('eth_sendTransaction', [{ from: yo, to: agente, value: '0x6f05b59d3b20000' }], yo));
dice('y por uno más alto, no', lanza(() => politica.revisarTransaccion({ to: agente, value: 500000000000000001n })));

console.log('\nel escrow v2.5 y su tablón (24-nov-2026)');
const sdk = await import('@panal/sdk');
const usdc = cfg.USDC_TOKEN_ADDRESS;
const crear25 = encodeFunctionData({
  abi: sdk.panalEscrowV2_5Abi,
  functionName: 'createTask',
  args: [{
    worker: agente, taskHash: `0x${'cd'.repeat(32)}`, deadline: 1800000000n,
    acceptWindow: 3600, reviewWindow: 259200, currency: usdc, amount: 2_500_000n,
  }],
});
d = pu.describir('eth_sendTransaction', [{ from: yo, to: cfg.PANAL_ESCROW_V2_5_ADDRESS, data: crear25 }], yo);
dice('contratar en el v2.5 se lee: agente, importe y USDC', d.tipo === 'encargo' && d.agente === getAddress(agente) && d.importe === 2_500_000n && d.moneda === getAddress(usdc));
dice('sin aceptar, no pasa la política', lanza(() => politica.revisarTransaccion({ to: cfg.PANAL_ESCROW_V2_5_ADDRESS, data: crear25, value: 0n })));
pu.armar(d);
dice('aceptado, pasa', !lanza(() => politica.revisarTransaccion({ to: cfg.PANAL_ESCROW_V2_5_ADDRESS, data: crear25, value: 0n })));
dice('y vale para una sola firma', lanza(() => politica.revisarTransaccion({ to: cfg.PANAL_ESCROW_V2_5_ADDRESS, data: crear25, value: 0n })));
pu.armar(d);
dice('con MON pegado a un encargo en USDC, no', lanza(() => politica.revisarTransaccion({ to: cfg.PANAL_ESCROW_V2_5_ADDRESS, data: crear25, value: 1n })));
pu.armar(d);
const crear25Mas = encodeFunctionData({
  abi: sdk.panalEscrowV2_5Abi,
  functionName: 'createTask',
  args: [{
    worker: agente, taskHash: `0x${'cd'.repeat(32)}`, deadline: 1800000000n,
    acceptWindow: 3600, reviewWindow: 259200, currency: usdc, amount: 9_000_000n,
  }],
});
dice('por otro importe que el aceptado, no', lanza(() => politica.revisarTransaccion({ to: cfg.PANAL_ESCROW_V2_5_ADDRESS, data: crear25Mas, value: 0n })));
politica.olvidarPermisos();

const conPermit = encodeFunctionData({
  abi: sdk.panalEscrowV2_5Abi,
  functionName: 'createTaskWithPermit',
  args: [
    { worker: agente, taskHash: `0x${'cd'.repeat(32)}`, deadline: 1800000000n, acceptWindow: 3600, reviewWindow: 259200, currency: usdc, amount: 1n },
    { deadline: 1800000000n, v: 27, r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}` },
  ],
});
dice('createTaskWithPermit, no', pu.describir('eth_sendTransaction', [{ from: yo, to: cfg.PANAL_ESCROW_V2_5_ADDRESS, data: conPermit }], yo).tipo === 'bloqueada');

const aceptar = encodeFunctionData({ abi: sdk.panalEscrowV2_5Abi, functionName: 'acceptTask', args: [5n] });
d = pu.describir('eth_sendTransaction', [{ from: yo, to: cfg.PANAL_ESCROW_V2_5_ADDRESS, data: aceptar }], yo);
dice('lo que no pone dinero en el v2.5 pasa sin armar', d.tipo === 'escrow' && d.funcion === 'acceptTask');
const retirar25 = encodeFunctionData({ abi: sdk.panalEscrowV2_5Abi, functionName: 'withdraw', args: [usdc] });
dice('retirar USDC del v2.5, también', pu.describir('eth_sendTransaction', [{ from: yo, to: cfg.PANAL_ESCROW_V2_5_ADDRESS, data: retirar25 }], yo).tipo === 'escrow');

const erc20 = (await import('viem')).erc20Abi;
const aprobarUsdc = encodeFunctionData({ abi: erc20, functionName: 'approve', args: [cfg.PANAL_ESCROW_V2_5_ADDRESS, 2_500_000n] });
d = pu.describir('eth_sendTransaction', [{ from: yo, to: usdc, data: aprobarUsdc }], yo);
dice('aprobar USDC al escrow v2.5 se lee, con su moneda', d.tipo === 'aprobar' && d.para === 'escrow' && d.moneda === getAddress(usdc));
const usdcAlV2 = encodeFunctionData({ abi: erc20, functionName: 'approve', args: [cfg.PANAL_ESCROW_V2_ADDRESS, 1n] });
dice('aprobar USDC al escrow v2 (que no lo cobra), no', pu.describir('eth_sendTransaction', [{ from: yo, to: usdc, data: usdcAlV2 }], yo).tipo === 'bloqueada');
const usdcAOtro = encodeFunctionData({ abi: erc20, functionName: 'approve', args: [otro, 1n] });
dice('aprobar USDC a cualquiera, no', pu.describir('eth_sendTransaction', [{ from: yo, to: usdc, data: usdcAOtro }], yo).tipo === 'bloqueada');
const usdcFuera = encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [otro, 1n] });
dice('mandar USDC a otro, no', pu.describir('eth_sendTransaction', [{ from: yo, to: usdc, data: usdcFuera }], yo).tipo === 'bloqueada');
const panalAl25 = encodeFunctionData({ abi: panalTokenAbi, functionName: 'approve', args: [cfg.PANAL_ESCROW_V2_5_ADDRESS, 10n ** 18n] });
dice('aprobar $PANAL al escrow v2.5, sí', pu.describir('eth_sendTransaction', [{ from: yo, to: cfg.PANAL_TOKEN_ADDRESS, data: panalAl25 }], yo).tipo === 'aprobar');

const usdcAlTablon = encodeFunctionData({ abi: erc20, functionName: 'approve', args: [cfg.PANAL_TABLON_V2_5_ADDRESS, 5_000_000n] });
d = pu.describir('eth_sendTransaction', [{ from: yo, to: usdc, data: usdcAlTablon }], yo);
dice('aprobar USDC al tablón v2.5 se lee', d.tipo === 'aprobar' && d.para === 'tablon');
dice('sin aceptar, no pasa', lanza(() => politica.revisarTransaccion({ to: usdc, data: usdcAlTablon, value: 0n })));
pu.armar(d);
dice('aceptado, pasa por ese importe y en USDC', !lanza(() => politica.revisarTransaccion({ to: usdc, data: usdcAlTablon, value: 0n })));
const panalAlTablonMismo = encodeFunctionData({ abi: panalTokenAbi, functionName: 'approve', args: [cfg.PANAL_TABLON_V2_5_ADDRESS, 5_000_000n] });
pu.armar(d);
dice('el mismo importe en $PANAL no vale por lo aceptado en USDC', lanza(() => politica.revisarTransaccion({ to: cfg.PANAL_TOKEN_ADDRESS, data: panalAlTablonMismo, value: 0n })));
politica.olvidarPermisos();

const post25 = encodeFunctionData({
  abi: sdk.panalTablonV2_5Abi,
  functionName: 'post',
  args: [{
    taskHash: `0x${'01'.repeat(32)}`, advertHash: `0x${'02'.repeat(32)}`, category: 1, currency: cfg.NATIVE_CURRENCY,
    amount: 10n ** 17n, workDuration: 3600n, expiresAt: 1800000000n, mode: 0, applyWindow: 0n, chooseWindow: 0n,
    experiencedOnly: false, relist: false, campaignId: `0x${'0'.repeat(64)}`, campaignCapPerAgent: 0, reviewWindow: 259200,
  }],
});
d = pu.describir('eth_sendTransaction', [{ from: yo, to: cfg.PANAL_TABLON_V2_5_ADDRESS, data: post25, value: '0x16345785d8a0000' }], yo);
dice('publicar en el tablón v2.5 se lee con su importe', d.tipo === 'tablon' && d.funcion === 'post' && d.importe === 10n ** 17n);
pu.armar(d);
dice('aceptado, pasa con el MON justo', !lanza(() => politica.revisarTransaccion({ to: cfg.PANAL_TABLON_V2_5_ADDRESS, data: post25, value: 10n ** 17n })));

const elegir25 = encodeFunctionData({ abi: sdk.panalTablonV2_5Abi, functionName: 'choose', args: [7n, agente] });
d = pu.describir('eth_sendTransaction', [{ from: yo, to: cfg.PANAL_TABLON_V2_5_ADDRESS, data: elegir25 }], yo);
dice('elegir en el v2.5 se lee con el número de fuera', d.tipo === 'tablon' && d.funcion === 'choose' && d.jobId === 1_000_000_007n);
pu.armar(d);
dice('aceptado, pasa', !lanza(() => politica.revisarTransaccion({ to: cfg.PANAL_TABLON_V2_5_ADDRESS, data: elegir25, value: 0n })));
politica.permitirTablon({ funcion: 'choose', amount: 0n, currency: cfg.NATIVE_CURRENCY, jobId: 1_000_000_007n, agente });
dice('lo que arma una hoja de la app con el número de fuera, también', !lanza(() => politica.revisarTransaccion({ to: cfg.PANAL_TABLON_V2_5_ADDRESS, data: elegir25, value: 0n })));
politica.permitirTablon({ funcion: 'choose', amount: 0n, currency: cfg.NATIVE_CURRENCY, jobId: 7n, agente });
dice('pero el 7 del v2 no vale por el 7 del v2.5', lanza(() => politica.revisarTransaccion({ to: cfg.PANAL_TABLON_V2_5_ADDRESS, data: elegir25, value: 0n })));
politica.olvidarPermisos();

const pactar = encodeFunctionData({ abi: sdk.panalTablonV2_5Abi, functionName: 'proposeSettlement', args: [7n, 5000] });
dice('pactar un reparto en el tablón v2.5 pasa sin armar', pu.describir('eth_sendTransaction', [{ from: yo, to: cfg.PANAL_TABLON_V2_5_ADDRESS, data: pactar }], yo).tipo === 'tablon');
const topes = encodeFunctionData({ abi: sdk.panalTablonV2_5Abi, functionName: 'setCaps', args: [usdc, 1n, 1n] });
dice('lo del dueño del tablón, no', pu.describir('eth_sendTransaction', [{ from: yo, to: cfg.PANAL_TABLON_V2_5_ADDRESS, data: topes }], yo).tipo === 'bloqueada');

const precios = encodeFunctionData({ abi: sdk.panalPricesAbi, functionName: 'setPrices', args: [usdc, [1_000_000n, 2_500_000n]] });
d = pu.describir('eth_sendTransaction', [{ from: yo, to: cfg.PANAL_PRICES_ADDRESS, data: precios }], yo);
dice('los precios propios en USDC se leen', d.tipo === 'precios' && d.importes.length === 2 && d.moneda === getAddress(usdc));
dice('con MON pegado, no', pu.describir('eth_sendTransaction', [{ from: yo, to: cfg.PANAL_PRICES_ADDRESS, data: precios, value: '0x1' }], yo).tipo === 'bloqueada');

politica.olvidarPermisos();
ses.cerrarSesion();

console.log(`\n${bien} bien · ${mal} mal`);
process.exit(mal === 0 ? 0 : 1);
