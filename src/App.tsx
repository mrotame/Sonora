// Application flow: input -> preparing -> running -> ended | failed (PRODUCT_SPEC 2).
// Screens are deliberately minimal in this slice; the product UI comes later.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AcquisitionError, acquireAudio, type AcquisitionErrorCode } from './audio/sources/backendSource';
import { decodeAudioFile, DecodeError } from './audio/processing/decode';
import { Timeline } from './audio/intelligence/timeline';
import { Experience } from './experience/controller/experience';
import { scenarios } from './scenarios/registry';
import { createWorldSeed } from './world/identity/seed';
import { WorldWorker } from './world/generation/workerClient';

// One clear, non-technical sentence per failure (PRODUCT_SPEC 2.4).
const MESSAGES: Record<AcquisitionErrorCode | 'DECODE' | 'INTERNAL', string> = {
  INVALID_URL: 'Esse link não parece ser de um vídeo público do YouTube. Confira o endereço e tente de novo.',
  UNAVAILABLE: 'Não foi possível acessar esse vídeo; ele pode ser privado ou estar indisponível. Tente outro vídeo.',
  LIVE: 'Transmissões ao vivo não são suportadas. Escolha um vídeo comum.',
  TOO_LONG: 'Esse vídeo tem mais de 10 minutos. Escolha um vídeo mais curto.',
  TOO_LARGE: 'O áudio desse vídeo é grande demais. Escolha um vídeo mais curto.',
  BLOCKED: 'O serviço de áudio foi bloqueado temporariamente. Tente novamente em alguns minutos.',
  TIMEOUT: 'A preparação demorou mais que o esperado. Tente novamente.',
  DOWNLOAD_FAILED: 'Não foi possível obter o áudio desse vídeo. Tente novamente ou use outro vídeo.',
  BUSY: 'O serviço está ocupado agora. Tente novamente em instantes.',
  RATE_LIMITED: 'Muitas tentativas seguidas. Aguarde um minuto e tente de novo.',
  NOT_FOUND: 'A preparação do áudio foi perdida. Tente novamente.',
  BACKEND_UNREACHABLE: 'Não foi possível falar com o serviço de áudio. Verifique sua conexão e tente novamente.',
  CANCELLED: 'A operação foi cancelada.',
  DECODE: 'Não foi possível processar o áudio deste vídeo neste navegador. Tente outro vídeo.',
  INTERNAL: 'Algo deu errado ao montar o mundo. Tente novamente.',
};

const STAGE_LABEL: Record<string, string> = {
  queued: 'Obtendo o áudio (na fila)',
  fetching_metadata: 'Obtendo o áudio (verificando o vídeo)',
  downloading: 'Obtendo o áudio (baixando)',
  transferring: 'Obtendo o áudio (recebendo o arquivo)',
  decoding: 'Preparando o áudio',
  analyzing: 'Analisando a música',
  building: 'Montando o mundo',
};

// Prefilled in development builds only, so a test run needs no typing.
const DEV_DEFAULT_URL = 'https://www.youtube.com/watch?v=Ni31ybA1OII';

type Phase ='input' | 'preparing' | 'running' | 'ended' | 'failed';

// The volume is a user preference, cached so every scenario/run starts at the same level.
const VOLUME_KEY = 'sonora.volume';
const DEFAULT_VOLUME = 0.8;

function loadVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

interface Stats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
}

export function App() {
  const [url, setUrl] = useState(import.meta.env.DEV ? DEV_DEFAULT_URL : '');
  const [scenarioId, setScenarioId] = useState(scenarios[0]!.logic.id);
  const [phase, setPhase] = useState<Phase>('input');
  const [stage, setStage] = useState('queued');
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const speedGraphRef = useRef<HTMLCanvasElement>(null);
  const fadeRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [volume, setVolume] = useState(loadVolume);
  const gainRef = useRef<GainNode | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  // Persist the volume and apply it to the live audio graph (if any).
  useEffect(() => {
    try { localStorage.setItem(VOLUME_KEY, String(volume)); } catch { /* storage unavailable */ }
    if (gainRef.current) gainRef.current.gain.value = volume;
  }, [volume]);

  function finishWith(next: Phase, code?: keyof typeof MESSAGES) {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setStats(null);
    setError(code ? MESSAGES[code] : null);
    setPhase(next);
  }

  async function start(e: FormEvent) {
    e.preventDefault();
    const definition = scenarios.find((s) => s.logic.id === scenarioId)!;
    const canvas = canvasRef.current!;

    // Created inside the submit gesture so playback can start later without another click.
    const audioContext = new AudioContext();
    const gain = audioContext.createGain();
    gain.gain.value = volume;
    gain.connect(audioContext.destination);
    gainRef.current = gain;
    const abort = new AbortController();
    let worker: WorldWorker | null = null;
    let experience: Experience | null = null;
    cleanupRef.current = () => {
      abort.abort();
      experience?.dispose();
      worker?.dispose();
      void audioContext.close().catch(() => undefined);
    };

    setError(null);
    setStage('queued');
    setPhase('preparing');
    try {
      const file = await acquireAudio(url, setStage, abort.signal);
      setStage('decoding');
      const audio = await decodeAudioFile(file);

      setStage('analyzing');
      const worldSeed = createWorldSeed({
        audioIdentity: audio.identity,
        scenarioId: definition.logic.id,
        scenarioVersion: definition.logic.version,
      });
      worker = new WorldWorker(() => finishWith('failed', 'INTERNAL'));
      const timelineData = await worker.init({
        scenarioId: definition.logic.id,
        worldSeed,
        sampleRate: audio.sampleRate,
        left: audio.channels[0],
        right: audio.channels[1] === audio.channels[0] ? null : audio.channels[1],
        onProgress: () => undefined,
      });

      setStage('building');
      experience = new Experience({
        canvas,
        definition,
        worldSeed,
        timeline: new Timeline(timelineData),
        worker,
        audioContext,
        audioBuffer: audio.buffer,
        audioOutput: gain,
        speedGraphCanvas: speedGraphRef.current ?? undefined,
        fadeOverlay: fadeRef.current ?? undefined,
        onEnded: () => finishWith('ended'),
        onFatal: () => finishWith('failed', 'INTERNAL'),
        onStats: import.meta.env.DEV ? setStats : undefined,
      });
      await experience.prepare();
      await audioContext.resume();
      setPhase('running');
      experience.start();
    } catch (err) {
      if (err instanceof AcquisitionError && err.code === 'CANCELLED') return;
      const code = err instanceof AcquisitionError ? err.code : err instanceof DecodeError ? 'DECODE' : 'INTERNAL';
      finishWith('failed', code);
    }
  }

  const overlay = phase !== 'running';
  // The speed graph only makes sense for scenarios whose speed follows the music.
  const showSpeedGraph = phase === 'running' && !!scenarios.find((s) => s.logic.id === scenarioId)?.logic.createPath;
  return (
    <>
      <canvas ref={canvasRef} style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', display: 'block', touchAction: 'none' }} />
      <canvas
        ref={speedGraphRef}
        aria-label="Gráfico de velocidade da música"
        style={{ position: 'fixed', top: 12, right: 12, width: 220, height: 76, display: showSpeedGraph ? 'block' : 'none', pointerEvents: 'none', background: 'rgba(8,2,20,0.45)', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 6 }}
      />
      {/* End-of-track fade to black, driven by the Experience controller (covers the scene and the speed graph). */}
      <div ref={fadeRef} aria-hidden="true" style={{ position: 'fixed', inset: 0, background: '#000', opacity: 0, pointerEvents: 'none' }} />
      {overlay && (
        <main style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: phase === 'preparing' ? 'rgba(8,2,20,0.85)' : '#0a0418', color: '#f4e9ff', fontFamily: 'system-ui, sans-serif', padding: '1rem' }}>
          <div style={{ width: 'min(560px, 100%)' }}>
            <h1 style={{ marginTop: 0 }}>Sonora</h1>
            {(phase === 'input' || phase === 'failed' || phase === 'ended') && (
              <form onSubmit={(ev) => void start(ev)}>
                {phase === 'ended' && <p role="status">A música terminou. Cole outro link para uma nova viagem.</p>}
                {phase === 'failed' && <p role="alert">{error}</p>}
                <label>
                  Link de um vídeo do YouTube
                  <input type="url" value={url} onChange={(ev) => setUrl(ev.target.value)} placeholder="https://www.youtube.com/watch?v=..." required style={{ display: 'block', width: '100%', padding: '0.6rem', boxSizing: 'border-box', margin: '0.3rem 0 0.8rem' }} />
                </label>
                <label>
                  Cenário
                  <select value={scenarioId} onChange={(ev) => setScenarioId(ev.target.value)} style={{ display: 'block', width: '100%', padding: '0.6rem', margin: '0.3rem 0 1rem' }}>
                    {scenarios.map((s) => (
                      <option key={s.logic.id} value={s.logic.id}>{s.label}</option>
                    ))}
                  </select>
                </label>
                <button type="submit" style={{ padding: '0.6rem 1.4rem' }}>Iniciar</button>
              </form>
            )}
            {phase === 'preparing' && <p role="status">{STAGE_LABEL[stage] ?? stage}…</p>}
          </div>
        </main>
      )}
      <label style={{ position: 'fixed', left: 12, bottom: 12, zIndex: 10, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'rgba(8,2,20,0.55)', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 6, color: '#f4e9ff', fontFamily: 'system-ui, sans-serif', fontSize: 12 }}>
        Volume
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(ev) => setVolume(Number(ev.target.value))}
          aria-label="Volume"
          style={{ width: 120 }}
        />
        <span style={{ minWidth: '3ch', textAlign: 'right' }}>{Math.round(volume * 100)}%</span>
      </label>
      {import.meta.env.DEV && stats && (
        <pre id="stats" style={{ position: 'fixed', top: 8, left: 8, margin: 0, padding: '4px 8px', background: 'rgba(0,0,0,0.6)', color: '#9fffa8', fontSize: 12 }}>
          {stats.fps.toFixed(0)} fps | {stats.frameMs.toFixed(1)} ms | {stats.drawCalls} draws | {(stats.triangles / 1000).toFixed(0)}k tris
        </pre>
      )}
    </>
  );
}
