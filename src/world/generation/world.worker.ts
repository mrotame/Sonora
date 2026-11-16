// Dedicated Worker: whole-track analysis and segment generation (TECHNICAL_ARCHITECTURE 12).
// It produces data only and never touches the Three.js scene.
import { analyzeTrack } from '../../audio/analysis/analyze.ts';
import { Timeline, TRACK_NAMES, type TimelineData } from '../../audio/intelligence/timeline.ts';
import { scenarioLogics } from '../../scenarios/logics.ts';
import type { ScenarioLogic, TrackPath } from '../../scenarios/types.ts';
import { deriveSeed, type Seed } from '../identity/seed.ts';
import type { WorkerRequest, WorkerResponse } from './protocol.ts';

interface WorkerScope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
}
const ctx = self as unknown as WorkerScope;

let logic: ScenarioLogic<unknown, unknown> | null = null;
let timeline: Timeline | null = null;
let worldSeed: Seed | null = null;
let path: TrackPath | undefined;

/** Typed arrays at the top level of a segment, or one level down inside plain objects, are moved, not copied. */
function transferablesOf(segment: unknown): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  const visit = (value: unknown, depth: number): void => {
    if (ArrayBuffer.isView(value)) {
      if (value.buffer instanceof ArrayBuffer) buffers.add(value.buffer);
    } else if (depth < 2 && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const v of Object.values(value)) visit(v, depth + 1);
    }
  };
  visit(segment, 0);
  return [...buffers];
}

function init(req: Extract<WorkerRequest, { type: 'init' }>): void {
  const found = scenarioLogics[req.scenarioId];
  if (!found) throw new Error(`unknown scenario ${req.scenarioId}`);
  logic = found;
  worldSeed = req.worldSeed;

  let lastReported = -1;
  const data = analyzeTrack(req.left, req.right ?? req.left, req.sampleRate, (fraction) => {
    if (fraction - lastReported >= 0.05 || fraction === 1) {
      lastReported = fraction;
      ctx.postMessage({ type: 'progress', fraction });
    }
  });
  timeline = new Timeline(data);
  path = found.createPath?.(timeline, req.worldSeed);

  // The main thread gets its own copy of the tracks; the Worker keeps the originals for generation.
  const copy: TimelineData = {
    rate: data.rate,
    durationS: data.durationS,
    tracks: Object.fromEntries(TRACK_NAMES.map((n) => [n, data.tracks[n].slice()])) as TimelineData['tracks'],
  };
  ctx.postMessage({ type: 'timeline', data: copy }, TRACK_NAMES.map((n) => copy.tracks[n].buffer));
}

function generate(req: Extract<WorkerRequest, { type: 'segment' }>): void {
  if (!logic || !timeline || !worldSeed) throw new Error('worker not initialized');
  const far = req.layer === 'far' ? logic.farField : undefined;
  if (req.layer === 'far' && !far) throw new Error('scenario has no far-field layer');
  const segmentLength = far ? far.config.segmentLength : logic.config.segmentLength;
  const input = {
    index: req.index,
    startDistance: req.index * segmentLength,
    length: segmentLength,
    worldSeed,
    // Separate named seed paths per layer, so adding the far field leaves the near segments' seeds untouched.
    seed: deriveSeed(worldSeed, far ? 'far-segment' : 'segment', req.index),
    timeline,
    speed: logic.config.speed,
    path,
  };
  const segment = far ? far.generateSegment(input) : logic.generateSegment(input);
  ctx.postMessage({ type: 'segment', id: req.id, index: req.index, segment }, transferablesOf(segment));
}

ctx.onmessage = (event) => {
  const req = event.data;
  try {
    if (req.type === 'init') init(req);
    else generate(req);
  } catch (e) {
    ctx.postMessage({ type: 'error', id: req.type === 'segment' ? req.id : undefined, message: e instanceof Error ? e.message : String(e) });
  }
};
