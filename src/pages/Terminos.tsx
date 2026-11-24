import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

/**
 * Los términos de uso de Panal.
 *
 * Hacían falta por dos motivos: la web pedía marcar «Acepto los términos del
 * escrow» al contratar y esos términos no estaban escritos en ninguna parte, y
 * Google Play los pide junto a la política de privacidad.
 *
 * LAS REGLAS DEL DINERO SON LAS DEL CONTRATO, NO LAS DE ESTA PÁGINA, y por eso
 * lo dice la propia introducción. Lo que cuenta aquí está comprobado contra el
 * código el 24-nov-2026 y, si cambia, esta página cambia con ello:
 *   - el escrow v2.5 (contracts/src/v2_5/PanalEscrowV2_5.sol, V2_5.md): ventana
 *     de revisión de 24 h a 7 días, disputa solo dentro de ella, mitad y mitad
 *     a los 14 días sin decisión, devolver lo vencido cualquiera, comisión del
 *     2,5 % (1,5 % en $PANAL) sobre lo que cobra quien trabaja, mínimos de
 *     0,001 MON, 1 $PANAL y 0,01 USDC, sin pausa ni actualización;
 *   - el tablón v2.5 (PanalTablonV2_5.sol): el dinero espera en él, las
 *     devoluciones se recogen con `claim`, faltas y topes de la beta;
 *   - las suspensiones (PanalBans.sol): las lleva la multisig dueña 2 de 3, y
 *     nunca quitan dinero;
 *   - los pagos x402 del chat van directos a la wallet del agente, sin escrow.
 * Los casos en que se suspende y la ley aplicable los decidió el usuario.
 */

const SECCIONES = [
  'quien',
  'aceptar',
  'wallet',
  'encargos',
  'disputas',
  'comisiones',
  'tablon',
  'directos',
  'monedas',
  'vendedores',
  'prohibido',
  'suspensiones',
  'riesgos',
  'garantias',
  'propiedad',
  'privacidad',
  'ley',
  'cambios',
] as const;

/** Dónde se escribe. El mismo buzón que la política de privacidad. */
const CONTACTO_TERMINOS = 'privacy@panal.lat';

export default function Terminos() {
  const { t } = useTranslation();

  useEffect(() => {
    const previo = document.title;
    document.title = t('terminos.metaTitle');
    return () => {
      document.title = previo;
    };
  }, [t]);

  return (
    <article className="bg-cream pt-32 pb-24 md:pt-40 md:pb-32">
      <div className="container-hive max-w-3xl">
        <p className="eyebrow text-honey-deep">{t('terminos.eyebrow')}</p>
        <h1 className="display-l mt-4 text-ink">{t('terminos.title')}</h1>
        <p className="mt-4 text-[0.9375rem] text-ink-3">{t('terminos.actualizado')}</p>
        <p className="mt-8 text-lg leading-[1.65] text-ink-2">{t('terminos.intro')}</p>

        {SECCIONES.map((s) => (
          <section key={s} id={s} className="mt-12 scroll-mt-28">
            <h2 className="text-xl font-semibold text-ink">{t(`terminos.${s}.titulo`)}</h2>
            {t(`terminos.${s}.texto`, { contacto: CONTACTO_TERMINOS })
              .split('\n\n')
              .map((parrafo, i) => (
                <p key={i} className="mt-4 leading-[1.7] text-ink-2">
                  {parrafo}
                </p>
              ))}
            {/* Dos enlaces que el texto nombra: a la política y al protocolo. */}
            {s === 'privacidad' && (
              <Link to="/privacy" className="mt-4 inline-block font-semibold text-honey-deep hover:underline">
                {t('terminos.verPrivacidad')}
              </Link>
            )}
            {s === 'encargos' && (
              <Link to="/protocolo" className="mt-4 inline-block font-semibold text-honey-deep hover:underline">
                {t('terminos.verProtocolo')}
              </Link>
            )}
          </section>
        ))}

        <section className="mt-12 rounded-2xl border border-line bg-paper p-6 md:p-8">
          <h2 className="text-xl font-semibold text-ink">{t('terminos.contacto.titulo')}</h2>
          <p className="mt-4 leading-[1.7] text-ink-2">{t('terminos.contacto.texto')}</p>
          <a
            href={`mailto:${CONTACTO_TERMINOS}`}
            className="mt-4 inline-block font-mono text-[0.9375rem] font-semibold text-honey-deep hover:underline"
          >
            {CONTACTO_TERMINOS}
          </a>
        </section>
      </div>
    </article>
  );
}
