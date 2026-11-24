import { useEffect, useState } from 'react';
import { useSignMessage, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import type { Address, Hex } from 'viem';
import { esTextoCifrado } from '@panal/sdk';
import { activeChain, publicClient } from '@/contracts/config';
import { escrowDe, idEnLaCadena, llamadaDeEscrow, quePuede, versionDeTarea } from '@/lib/escrow';
import { usePanalAgents } from '@/hooks/usePanalAgents';
import { useWallet } from '@/hooks/useWallet';
import { darAccesoALosArbitrosDeUnaTarea } from '@/lib/accesos';
import { esBuzon } from '@/lib/botEndpoint';
import { clavePublicaDe } from '@/lib/cifrado';
import type { EncargoEnHilo } from '@/lib/conversaciones';
import { hayEntrega } from '@/lib/expedientes';
import { getTaskSobre } from '@/lib/taskBriefs';
import Hoja, { Boton, Fila, Nota, Tarjeta } from '~/componentes/Hoja';
import Dolares from '~/componentes/Dolares';
import { AUTO_RELEASE_MS, monto, restante } from '~/lib/formato';
import { useAhora } from '@/hooks/useAhora';
import { useTextos } from '~/i18n/idiomas';


/**
 * Revisar una entrega: aprobar con nota, o disputar.
 *
 * LAS ESTRELLAS NO SON UN ADORNO. `approveAndRelease(taskId, rating)` exige una
 * nota de 1 a 5: aprobar sin puntuar no existe en el contrato, así que el botón
 * espera a que elijas en vez de mandar un 5 por defecto en tu nombre.
 *
 * Y la cuenta atrás va arriba del todo porque callarse NO es neutral: en el
 * escrow v2, a los tres días de la entrega `autoRelease` lo cobra cualquiera y
 * deja un 5 registrado; en el v2.5, al acabar la revisión que eligió el
 * cliente se libera sin nota. No decir nada es pagar.
 *
 * En el v2.5 solo se disputa DENTRO de la revisión: pasada, el botón no sale
 * (el contrato lo rechazaría).
 *
 * Abierta la disputa con alguien que recibe en el buzón de Panal, si algo va
 * cifrado se le da acceso a quien decide en el mismo paso: sin él no podría
 * leer el encargo ni la entrega, y Panal tampoco.
 */
export default function HojaRevisar({
  encargo,
  onCerrar,
  onHecho,
}: {
  encargo: EncargoEnHilo | null;
  onCerrar: () => void;
  onHecho: () => void;
}): React.ReactElement | null {
  const [estrellas, setEstrellas] = useState(0);
  const [disputando, setDisputando] = useState(false);
  const T = useTextos();
  const { writeContract, data: hash, isPending } = useWriteContract();
  const recibo = useWaitForTransactionReceipt({ hash });
  const { address } = useWallet();
  const { agents } = usePanalAgents();
  const { signMessageAsync } = useSignMessage();
  const ahoraS = useAhora();
  // Tras la disputa: cómo fue darle acceso a quien decide. `null` mientras se da.
  const [acceso, setAcceso] = useState<string | null>(null);
  // Solo con quien recibe en el buzón hay algo que pueda ir cifrado.
  const buzon = encargo ? (agents.find((a) => a.workerAddress.toLowerCase() === encargo.agente.toLowerCase())?.botUrl ?? null) : null;
  const conBuzon = esBuzon(buzon) && !!address;

  /**
   * Da acceso a quien decide, si hay a qué. Devuelve qué decir, o `null` si
   * no hay nada que decir (nada va cifrado).
   */
  const darAccesoAQuienDecide = async (e: EncargoEnHilo): Promise<string | null> => {
    const yo = address as Address;
    const sobre = getTaskSobre(e.taskHash);
    // Sin el sobre cifrado guardado ni clave propia publicada, nada va cifrado: ni una firma.
    if (!(sobre && esTextoCifrado(sobre)) && !(await clavePublicaDe(yo))) return null;
    try {
      // En su escrow, con el número de la cadena: `tasks` en el v2, `getTask` en el v2.5.
      const version = versionDeTarea(BigInt(e.id));
      const tarea = (await publicClient.readContract({
        ...escrowDe(version),
        functionName: version === 'v2_5' ? 'getTask' : 'tasks',
        args: [idEnLaCadena(BigInt(e.id))],
      } as never)) as unknown as { resultHash: Hex };
      const r = await darAccesoALosArbitrosDeUnaTarea({
        botUrl: buzon!,
        taskId: BigInt(e.id),
        taskHash: e.taskHash as Hex,
        resultHash: hayEntrega(tarea.resultHash) ? tarea.resultHash : null,
        rol: 'client',
        sobreGuardado: sobre,
        yo,
        firmar: (message) => signMessageAsync({ message }),
      });
      if (r.objetos === 0) return null;
      return r.arbitros > 0 ? T.revisar.accesoDado : T.revisar.accesoSinClave;
    } catch {
      return T.revisar.accesoNo;
    }
  };

  // Solo avisar al padre: la hoja se desmonta al cerrarse, asi que las
  // estrellas y la vista de disputa se reinician solas.
  useEffect(() => {
    if (!recibo.isSuccess) return;
    if (!disputando || !encargo || !conBuzon) {
      onHecho();
      return;
    }
    void darAccesoAQuienDecide(encargo).then((texto) => {
      if (texto === null) onHecho();
      else setAcceso(texto);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recibo.isSuccess]);

  if (!encargo) return null;

  const trabajando = isPending || recibo.isLoading;
  const id = BigInt(encargo.id);
  const version = versionDeTarea(id);
  // La comisión del v2.5 es del 1,5 % en $PANAL y del 2,5 % en MON y USDC; la del v2, 2,5 % siempre.
  const bps = version === 'v2_5' && encargo.simbolo === '$PANAL' ? 150n : 250n;
  const comision = (BigInt(encargo.importe) * bps) / 10_000n;
  const alAgente = BigInt(encargo.importe) - comision;
  const pct = (Number(bps) / 100).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const revisionMs = encargo.revisionS !== undefined ? encargo.revisionS * 1000 : AUTO_RELEASE_MS;
  // Las reglas del contrato de su versión (lib/escrow.ts de la web).
  const puede = quePuede(
    {
      id,
      version,
      status: encargo.estado,
      worker: encargo.agente as Address,
      deadline: 0n,
      deliveredAt: encargo.entregado ? BigInt(Math.floor(encargo.entregado / 1000)) : undefined,
      reviewWindow: encargo.revisionS,
    },
    ahoraS,
  );

  const aprobar = () => {
    if (estrellas < 1) return;
    writeContract({ ...llamadaDeEscrow(id, { tipo: 'aprobar', nota: estrellas }), chainId: activeChain.id } as never);
  };

  const abrirDisputa = () => {
    writeContract({ ...llamadaDeEscrow(id, { tipo: 'disputar' }), chainId: activeChain.id } as never);
  };

  if (disputando && recibo.isSuccess && conBuzon) {
    return (
      <Hoja abierta titulo={T.revisar.disputaTitulo} onCerrar={onHecho} bloqueada={acceso === null}>
        <Nota>{acceso ?? T.revisar.dandoAcceso}</Nota>
        {acceso !== null && (
          <div className="mt-[18px] pb-1">
            <Boton variante="secundario" onClick={onHecho}>
              {T.comun.cerrar}
            </Boton>
          </div>
        )}
      </Hoja>
    );
  }

  if (disputando) {
    return (
      <Hoja
        abierta
        titulo={T.revisar.disputaTitulo}
        onCerrar={() => setDisputando(false)}
        bloqueada={trabajando}
      >
        <p className="mt-1.5 text-[13.5px] leading-[1.55] text-ink-2">
          {T.revisar.disputaTexto(monto(encargo.importe, encargo.simbolo), encargo.simbolo)}
        </p>

        {/* Sin campo de motivo a propósito: openDispute no acepta texto, y
            guardarlo en otro sitio sería inventar infraestructura. El árbitro
            ya puede ver lo que hace falta para juzgar. */}
        <div className="mt-4 rounded-[14px] border border-line px-4 py-3.5">
          <p className="text-[11.5px] uppercase tracking-[0.06em] text-ink-3">
            {T.revisar.loQueVeraQuienDecide}
          </p>
          <ul className="mt-2.5 flex flex-col gap-2 text-[13px] text-ink-2">
            <li>{T.revisar.pruebaBrief}</li>
            <li>{T.revisar.pruebaEntrega}</li>
            <li>{T.revisar.pruebaHilo}</li>
          </ul>
        </div>

        <Tarjeta>
          <Fila
            etiqueta={T.revisar.decide}
            pie={T.revisar.decidePie}
            valor="0xc384…1Fe0"
            color="text-ink-3"
          />
        </Tarjeta>

        <Nota>{version === 'v2_5' ? T.revisar.catorceDias25 : T.revisar.catorceDias}</Nota>

        <div className="mt-[18px] flex gap-2.5 pb-1">
          <div className="grow">
            <Boton variante="secundario" onClick={() => setDisputando(false)} disabled={trabajando}>
              {T.comun.ahoraNo}
            </Boton>
          </div>
          <div className="grow-[1.4]">
            <Boton variante="peligro" onClick={abrirDisputa} disabled={trabajando}>
              {trabajando ? T.revisar.abriendo : T.revisar.abrirDisputa}
            </Boton>
          </div>
        </div>
      </Hoja>
    );
  }

  return (
    <Hoja abierta titulo={T.revisar.titulo} onCerrar={onCerrar} bloqueada={trabajando}>
      {encargo.entregado && (
        <div className="mt-3 flex items-center gap-2.5 rounded-xl border border-honey-line bg-honey-soft px-3.5 py-3">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#E29A2E"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0"
            aria-hidden
          >
            <circle cx="12" cy="12" r="8.5" />
            <path d="M12 7.5V12l3 2" />
          </svg>
          <p className="text-[12.5px] leading-[1.45] text-honey">
            {version === 'v2_5' ? T.revisar.sePagaSinTi : T.revisar.seApruebaSolo}{' '}
            <strong className="font-semibold">{restante(encargo.entregado, ahoraS * 1000, revisionMs)}</strong>
            {version === 'v2_5' ? T.revisar.sinNota : T.revisar.conCinco}
          </p>
        </div>
      )}

      <div className="mt-3.5 rounded-[14px] border border-line px-4 py-3">
        <p className="text-[11.5px] uppercase tracking-[0.06em] text-ink-3">
          {T.revisar.loQuePediste}
        </p>
        <p className="seleccionable mt-1.5 break-words text-[13.5px] leading-[1.5] text-ink-2">
          {encargo.brief ?? T.revisar.briefPerdido}
        </p>
      </div>

      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <p className="text-[13.5px] font-semibold">{T.revisar.tuValoracion}</p>
          <p className={`text-[12.5px] ${estrellas > 0 ? 'text-ink-2' : 'text-ink-3'}`}>
            {T.revisar.leyendas[estrellas]}
          </p>
        </div>
        <div className="-ml-2.5 mt-0.5 flex gap-0.5">
          {[1, 2, 3, 4, 5].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setEstrellas(v)}
              disabled={trabajando}
              aria-label={T.revisar.estrellas(v)}
              className="pulsable flex h-11 w-11 items-center justify-center"
            >
              <svg
                width="27"
                height="27"
                viewBox="0 0 24 24"
                fill={v <= estrellas ? '#E29A2E' : 'none'}
                stroke={v <= estrellas ? '#E29A2E' : '#4A4363'}
                strokeWidth="1.7"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M12 3.4l2.7 5.5 6 .9-4.35 4.2 1.03 6-5.38-2.83L6.62 20l1.03-6L3.3 9.8l6-.9z" />
              </svg>
            </button>
          ))}
        </div>
        <p className="mt-0.5 text-[11.5px] leading-[1.45] text-ink-3">
          {T.revisar.quedaEnElRegistro}
        </p>
      </div>

      <Tarjeta>
        <Fila
          etiqueta={T.revisar.alAgente}
          valor={
            <span className="text-right">
              {monto(alAgente, encargo.simbolo)} {encargo.simbolo}
              <Dolares wei={alAgente} simbolo={encargo.simbolo} className="block" />
            </span>
          }
          color="text-ink"
        />
        <Fila
          etiqueta={T.revisar.protocolo(pct)}
          valor={`${monto(comision, encargo.simbolo)} ${encargo.simbolo}`}
          color="text-ink-2"
        />
      </Tarjeta>

      <div className="mt-4">
        <Boton
          onClick={aprobar}
          variante={estrellas > 0 ? 'principal' : 'apagado'}
          disabled={estrellas < 1 || trabajando}
        >
          {trabajando
            ? T.revisar.firmando
            : estrellas > 0
              ? T.revisar.aprobarYPagar(monto(encargo.importe, encargo.simbolo), encargo.simbolo)
              : T.revisar.eligeValoracion}
        </Boton>
      </div>

      {puede.disputarComoCliente && (
      <button
        type="button"
        onClick={() => setDisputando(true)}
        disabled={trabajando}
        className="pulsable mt-0.5 flex h-11 w-full items-center justify-center gap-2 pb-1 text-[13.5px] font-medium text-terra"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#C9653B"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M12 4.5l8.5 15h-17z" />
          <path d="M12 10v4" />
        </svg>
        {T.revisar.algoNoCuadra}
      </button>
      )}
    </Hoja>
  );
}
