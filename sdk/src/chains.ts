/**
 * Panal SDK — redes y direcciones de los contratos.
 *
 * Hasta ahora esto vivía duplicado en tres sitios: el frontend
 * (`src/contracts/config.ts`, atado a `import.meta.env` de Vite), el bot
 * (`bot/src/config.ts`) y el servidor MCP. Quien quisiera integrarse con Panal
 * tenía que copiar las direcciones a mano de uno de ellos, y cuando un contrato
 * rotara no habría forma de enterarse. Aquí son un dato exportado y versionado
 * con el paquete.
 */

import { defineChain } from 'viem';
import type { Address, Chain } from 'viem';

// `monad`, `monadTestnet` y `chainFor` llevan el tipo `Chain` escrito. Inferido,
// el tipo de `defineChain` arrastra tipos que viem no exporta (desde 2.57.12, el
// de `transactionReplacement`) y el `.d.ts` del SDK deja de compilar (TS2742).

/** Monad mainnet. Es la red por defecto: Panal está desplegado y en uso ahí. */
export const monad: Chain = defineChain({
  id: 143,
  name: 'Monad',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } },
  blockExplorers: { default: { name: 'MonadVision', url: 'https://monadvision.com' } },
});

/** Monad testnet, para probar un agente sin gastar dinero real. */
export const monadTestnet: Chain = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } },
  blockExplorers: { default: { name: 'MonadVision', url: 'https://testnet.monadvision.com' } },
  testnet: true,
});

export type PanalNetwork = 'mainnet' | 'testnet';

export interface PanalAddresses {
  /**
   * El registro de agentes que se lee y donde se escribe. En mainnet, desde el
   * 25-nov-2026, PanalRegistryV3: admite cualquier moneda de la lista (USDC
   * incluida) y, para quien no lo ha tocado, devuelve lo del V2 en directo. Los
   * agentes de antes siguen apareciendo igual sin firmar nada.
   */
  registry: Address;
  /**
   * PanalRegistryV2: el que valida el escrow v2 (`hire`). Opcional: sin él,
   * `registry` hace de los dos, como antes del V3.
   */
  registryV2?: Address;
  escrow: Address;
  /** El token $PANAL. Los agentes pueden cobrar en él o en MON nativo. */
  panalToken: Address;
  /** Multisig 2-de-3 que resuelve las disputas. Se lee del escrow en caliente. */
  arbitrator: Address;
  /**
   * PanalNames: el nombre único de cada agente.
   *
   * Es la única señal de identidad que vive EN LA CADENA. El nombre del perfil
   * es texto libre y se repite —hoy hay tres direcciones anunciándose como
   * "LexPanal"—, mientras que aquí un nombre lo tiene una sola dirección. Y a
   * diferencia de la verificación de dominio, que la hace el indexador contra
   * un servidor ajeno, esto se lee con una llamada `view`: no depende de que
   * nada esté levantado.
   *
   * En mainnet, desde el 25-nov-2026, PanalNamesV2: lee el registro V3 y nació
   * con los 15 nombres de antes migrados, cada uno con su dueño y su fecha.
   */
  names: Address;
  /**
   * PanalTablon: el tablón con reglas delante del escrow (contracts/BOARD.md).
   * Cero en una red donde no está desplegado: los métodos `…BoardJob` lo dicen
   * en vez de mandar nada a la dirección cero. Para probar otro, se pasa en
   * `addresses`.
   */
  tablon: Address;
}

/** PanalRegistryV2 (2026-07-29): solo MON y $PANAL. El V3 lo lee. */
export const REGISTRY_V2_MAINNET: Address = '0x89a812BFb1c35fc814ef25a3E6Ca75068B16Ac51';
/** El PanalNames de antes del V3: sus 15 nombres se migraron a PanalNamesV2. */
export const NAMES_V1_MAINNET: Address = '0xc94a8107C87859cAd2E472e71BbE25c15cdD614A';

/**
 * Desplegados en Monad mainnet el 2026-07-29 (escrow v2 auditado). PanalTablon,
 * el 2026-10-13 en el bloque 112930819, con los topes de la beta. El registro y
 * los nombres, los de Panal V3 (2026-11-25).
 */
export const MAINNET_ADDRESSES: PanalAddresses = {
  registry: '0xfD8643AdCAfFC73B524203434dd9a5bCBC0753b2',
  registryV2: REGISTRY_V2_MAINNET,
  escrow: '0xe138A9A492CFe27A13f8b7A6D312DA831791bCe9',
  panalToken: '0x2e2e44e7fa6178822d4397299f719e89d1a67777',
  arbitrator: '0xc384C1F5D6716571DA84329BeAaE6F064C6b1Fe0',
  names: '0xA3A01e1A59d5088Ce2ecd4b98385929bC3B6523d',
  tablon: '0x2Cfc6803E269fa9BF728e202736a7bc0547ae149',
};

/**
 * En testnet solo hay registry y escrow desplegados. El resto queda a cero: el
 * cliente avisa si se pide una operación que los necesite, en vez de mandar una
 * transacción a la dirección cero.
 */
export const TESTNET_ADDRESSES: PanalAddresses = {
  registry: '0x0000000000000000000000000000000000000000',
  escrow: '0x0000000000000000000000000000000000000000',
  panalToken: '0x0000000000000000000000000000000000000000',
  arbitrator: '0x0000000000000000000000000000000000000000',
  names: '0x0000000000000000000000000000000000000000',
  tablon: '0x0000000000000000000000000000000000000000',
};

/** `address(0)` significa MON nativo en todo el protocolo. */
export const NATIVE_CURRENCY: Address = '0x0000000000000000000000000000000000000000';

export function addressesFor(network: PanalNetwork): PanalAddresses {
  return network === 'mainnet' ? MAINNET_ADDRESSES : TESTNET_ADDRESSES;
}

export function chainFor(network: PanalNetwork): Chain {
  return network === 'mainnet' ? monad : monadTestnet;
}

/** Comisión del protocolo, en puntos básicos (250 = 2,5 %). */
export const FEE_BPS = 250n;
/** Si el cliente no aprueba ni disputa, el pago se libera solo pasado esto. */
export const AUTO_RELEASE_SECONDS = 3 * 24 * 60 * 60;
/** Si el árbitro no resuelve una disputa en este plazo, se reembolsa al cliente. */
export const DISPUTE_TIMEOUT_SECONDS = 14 * 24 * 60 * 60;
