// Initial, failed, ended and preparing screens: URL input, scenario selector and start button
// over a blurred screenshot of the selected scenario (PRODUCT_SPEC 2.1).
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { scenarios } from '../scenarios/registry';
import { artFor } from './scenarioArt';
import { stageProgress, toPercent } from './progress';
import './home.css';

interface HomeScreenProps {
  url: string;
  onUrlChange(url: string): void;
  scenarioId: string;
  onScenarioChange(id: string): void;
  onSubmit(e: FormEvent): void;
  /** Preparing: show the progress text instead of the form. */
  preparing: boolean;
  statusText: string;
  /** Current preparation step and the real fraction of the analysis step (0..1). */
  stage: string;
  analysisFraction: number;
  /** Optional line above the form (end of music, or the failure reason). */
  message?: { kind: 'status' | 'alert'; text: string } | null;
}

/** Cross-fades the backdrop when the selected scenario changes. */
function Backdrop({ scenarioId }: { scenarioId: string }) {
  const [shown, setShown] = useState(scenarioId);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (scenarioId === shown) return;
    setHidden(true);
    const timer = setTimeout(() => {
      setShown(scenarioId);
      setHidden(false);
    }, 200);
    return () => clearTimeout(timer);
  }, [scenarioId, shown]);

  // Warm the cache so switching scenarios does not flash an unloaded image.
  useEffect(() => {
    for (const s of scenarios) for (const src of artFor(s.logic.id).backdrops) new Image().src = src;
  }, []);

  const { backdrops } = artFor(shown);
  return (
    <div className={`home-bg${hidden ? ' is-hidden' : ''}${backdrops.length > 1 ? ' is-split' : ''}`} aria-hidden="true">
      {backdrops.map((src) => (
        <i key={src} style={{ backgroundImage: `url(${src})` }} />
      ))}
    </div>
  );
}

/**
 * Progress bar with a percentage. The value never goes backwards; steps without a real fraction
 * creep forward (see progress.ts), and the analysis step uses the Worker's real progress.
 */
function LoadingBar({ stage, analysisFraction, label }: { stage: string; analysisFraction: number; label: string }) {
  const [progress, setProgress] = useState(0);
  const stageStart = useRef({ stage, at: performance.now() });
  const fraction = useRef(analysisFraction);
  fraction.current = analysisFraction;

  useEffect(() => {
    if (stageStart.current.stage !== stage) stageStart.current = { stage, at: performance.now() };
  }, [stage]);

  useEffect(() => {
    const tick = () => {
      const { stage: current, at } = stageStart.current;
      const value = stageProgress(current, performance.now() - at, current === 'analyzing' ? fraction.current : undefined);
      if (value !== null) setProgress((prev) => Math.max(prev, value));
    };
    tick();
    const timer = setInterval(tick, 100);
    return () => clearInterval(timer);
  }, []);

  const percent = toPercent(progress);
  return (
    <div className="home-loading" role="status">
      <p className="home-loading-label">{label}…</p>
      <div className="home-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Progresso da preparação">
        <div className="home-bar-fill" style={{ width: `${percent}%` }} />
      </div>
      <p className="home-loading-percent">{percent}%</p>
    </div>
  );
}

export function HomeScreen({ url, onUrlChange, scenarioId, onScenarioChange, onSubmit, preparing, statusText, stage, analysisFraction, message }: HomeScreenProps) {
  return (
    <main className="home">
      <h1 className="home-brand">Sonora</h1>
      <Backdrop scenarioId={scenarioId} />
      <div className="home-veil" />
      <div className="home-panel">
        {preparing ? (
          <LoadingBar stage={stage} analysisFraction={analysisFraction} label={statusText} />
        ) : (
          <>
            {message && <p className="home-message" role={message.kind === 'alert' ? 'alert' : 'status'}>{message.text}</p>}
            <form className="home-form" onSubmit={onSubmit}>
              <label className="home-field">
                Link de um vídeo do YouTube
                <input className="home-input" type="url" value={url} onChange={(ev) => onUrlChange(ev.target.value)} placeholder="https://www.youtube.com/watch?v=..." required />
              </label>
              <div>
                <p className="home-group-title" id="home-scenario-title">Cenário</p>
                <div className="home-tiles" role="radiogroup" aria-labelledby="home-scenario-title">
                  {scenarios.map((s) => {
                    const selected = s.logic.id === scenarioId;
                    return (
                      <label key={s.logic.id} className={`home-tile${selected ? ' is-selected' : ''}`}>
                        <input type="radio" name="scenario" value={s.logic.id} checked={selected} onChange={() => onScenarioChange(s.logic.id)} />
                        {artFor(s.logic.id).icon}
                        <span>{s.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
              <button className="home-go" type="submit">Iniciar</button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
