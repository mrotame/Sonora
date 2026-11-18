// Experience controller: owns the playback clock, camera, render loop and
// segment streaming for one run (TECHNICAL_ARCHITECTURE 11). Everything about
// the world is a function of track time: distance = speed * t, or the scenario's own path when it defines one.
import * as THREE from 'three';
import { Timeline, type Features } from '../../audio/intelligence/timeline.ts';
import type { ScenarioDefinition, ScenarioScene, TrackPath } from '../../scenarios/types.ts';
import { deriveSeed, type Seed } from '../../world/identity/seed.ts';
import { SegmentManager } from '../../world/segments/manager.ts';
import type { WorldWorker } from '../../world/generation/workerClient.ts';
import { LookState } from '../camera/lookState.ts';
import { SpeedGraph } from '../hud/speedGraph.ts';

export interface ExperienceOptions {
  canvas: HTMLCanvasElement;
  definition: ScenarioDefinition;
  worldSeed: Seed;
  timeline: Timeline;
  worker: WorldWorker;
  audioContext: AudioContext;
  audioBuffer: AudioBuffer;
  /** Node the audio plays into (e.g. a volume GainNode); defaults to the context destination. */
  audioOutput?: AudioNode;
  /** Element covering the view (black background) whose opacity the controller raises to fade the screen out at the end. */
  fadeOverlay?: HTMLElement;
  /** Optional 2D canvas for the speed graph; drawn only when the scenario has a music-driven path. */
  speedGraphCanvas?: HTMLCanvasElement;
  onEnded(): void;
  onFatal(error: Error): void;
  /** Receives frame stats about once per second (development diagnostics). */
  onStats?(stats: { fps: number; frameMs: number; drawCalls: number; triangles: number }): void;
}

const MAX_PIXEL_RATIO = 2;
/** Vertical field of view (degrees) when the scenario path does not set one. */
const DEFAULT_FOV = 70;
/** Fraction of the road slope angle the camera pitch follows (only for scenarios with a path), unless the scenario sets `pathTilt`. */
const DEFAULT_PATH_TILT = 0.8;
/** 0.5 (not 0.1) keeps depth precision usable when a scenario's view distance reaches kilometres. */
const NEAR_PLANE = 0.5;
/** Seconds the camera keeps moving after the music ends (at the path's slow end speed) while the screen fades to black. */
export const EPILOGUE_S = 5;

/** Screen fade (0 clear .. 1 black) over the epilogue, eased; a pure function of track time. */
export function fadeOut(t: number, musicEndS: number): number {
  const u = Math.min(1, Math.max(0, (t - musicEndS) / EPILOGUE_S));
  return u * u * (3 - 2 * u);
}

export class Experience {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, NEAR_PLANE, 1500);
  private readonly sceneImpl: ScenarioScene;
  private readonly look = new LookState();
  private readonly manager: SegmentManager<unknown>;
  /** Second, longer window for the scenario's optional far-field layer. */
  private readonly farManager: SegmentManager<unknown> | null = null;
  private readonly features: Features = { energy: 0, bass: 0, mid: 0, high: 0, flux: 0 };
  private readonly opts: ExperienceOptions;

  private source: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private raf = 0;
  private running = false;
  private ended = false;
  private lastFrameMs = 0;
  private statFrames = 0;
  private statStart = 0;
  private resizeObserver: ResizeObserver | null = null;
  private lastPointer: { x: number; y: number } | null = null;

  constructor(opts: ExperienceOptions) {
    this.opts = opts;
    this.musicEndS = opts.timeline.musicEndS;
    const { canvas, definition, worldSeed, worker } = opts;
    const { segmentLength, segmentsAhead, segmentsBehind } = definition.logic.config;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.camera.rotation.order = 'YXZ';
    this.sceneImpl = definition.createScene();
    this.renderer.setClearColor(this.sceneImpl.background);

    // Optional scenario-owned path (variable speed and road elevation); built from the same timeline as in the Worker.
    this.path = definition.logic.createPath?.(opts.timeline, worldSeed);
    if (this.path && opts.speedGraphCanvas && definition.logic.config.speedGraph !== false) {
      this.speedGraph = new SpeedGraph(opts.speedGraphCanvas, this.path, opts.timeline.durationS);
    }

    // The seed argument of createScene/interpret is derived by a named path so other uses stay independent.
    this.interpretSeed = deriveSeed(worldSeed, 'interpret');

    this.manager = new SegmentManager<unknown>({
      length: segmentLength,
      ahead: segmentsAhead,
      behind: segmentsBehind,
      source: { request: (index) => worker.requestSegment(index) },
      onAdd: (index, segment) => this.sceneImpl.addSegment(index, segment, index * segmentLength),
      onRemove: (index) => this.sceneImpl.removeSegment(index),
      onError: (error) => this.fail(error),
    });

    const farField = definition.logic.farField;
    const scene = this.sceneImpl;
    if (farField && scene.addFarSegment && scene.removeFarSegment) {
      const far = farField.config;
      this.farManager = new SegmentManager<unknown>({
        length: far.segmentLength,
        ahead: far.segmentsAhead,
        behind: far.segmentsBehind,
        source: { request: (index) => worker.requestSegment(index, 'far') },
        onAdd: (index, segment) => scene.addFarSegment!(index, segment, index * far.segmentLength),
        onRemove: (index) => scene.removeFarSegment!(index),
        onError: (error) => this.fail(error),
      });
    }
    this.camera.far = definition.logic.config.viewDistance ?? 1500;

    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerUp);
  }

  private readonly interpretSeed: Seed;
  /** Where the music ends (before any trailing silence); the epilogue starts here. */
  private readonly musicEndS: number;
  private readonly path: TrackPath | undefined;
  private speedGraph: SpeedGraph | undefined;

  /** Distance travelled at track time t: the scenario path if it has one, else constant speed. */
  private distanceAt(t: number): number {
    return this.path ? this.path.distanceAt(t) : this.opts.definition.logic.config.speed * t;
  }

  /** Generates the first segments so playback starts on a complete view. */
  async prepare(): Promise<void> {
    this.updateCamera(0, 0);
    await Promise.all([this.manager.update(0), this.farManager?.update(0), this.sceneImpl.ready?.()]);
    this.draw(); // compiles shaders before audio starts
  }

  /** One frame: the scenario draws it itself when it has its own pipeline (post-processing), else a plain render. */
  private draw(): void {
    if (this.sceneImpl.render) this.sceneImpl.render(this.renderer, this.camera);
    else this.renderer.render(this.sceneImpl.scene, this.camera);
  }

  /** Starts audio and the render loop. The AudioContext must already be running (created in the user gesture). */
  start(): void {
    const { audioContext, audioBuffer } = this.opts;
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.opts.audioOutput ?? audioContext.destination);
    // The end comes from the clock (music end + epilogue), not from the source: the clock keeps running after the audio stops.
    this.startedAt = audioContext.currentTime + 0.05;
    source.start(this.startedAt);
    this.source = source;
    this.running = true;
    this.lockPointer();
    this.statStart = performance.now();
    this.lastFrameMs = this.statStart;
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Track time in seconds, from the audio clock (compensating the output latency). */
  private trackTime(): number {
    const ctx = this.opts.audioContext;
    return Math.max(0, ctx.currentTime - this.startedAt - (ctx.outputLatency || 0));
  }

  private readonly frame = (nowMs: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);

    const dtS = Math.min((nowMs - this.lastFrameMs) / 1000, 0.1);
    this.lastFrameMs = nowMs;
    const t = this.trackTime();
    const { interpret } = this.opts.definition.logic;
    const distance = this.distanceAt(t);

    this.look.update(dtS, nowMs / 1000);
    this.updateCamera(distance, t);
    void this.manager.update(distance);
    void this.farManager?.update(distance);

    this.opts.timeline.evaluate(t, this.features);
    this.sceneImpl.update(interpret(this.features, this.interpretSeed), this.camera.position, t);
    this.draw();
    this.speedGraph?.draw(t);
    if (this.opts.fadeOverlay) this.opts.fadeOverlay.style.opacity = String(fadeOut(t, this.musicEndS));

    this.statFrames++;
    if (nowMs - this.statStart >= 1000 && this.opts.onStats) {
      const info = this.renderer.info.render;
      this.opts.onStats({
        fps: (this.statFrames * 1000) / (nowMs - this.statStart),
        frameMs: (nowMs - this.statStart) / this.statFrames,
        drawCalls: info.calls,
        triangles: info.triangles,
      });
      this.statFrames = 0;
      this.statStart = nowMs;
    }
    if (t >= this.musicEndS + EPILOGUE_S) this.finish();
  };

  private updateCamera(distance: number, t: number): void {
    const { eyeHeight, pathTilt = DEFAULT_PATH_TILT } = this.opts.definition.logic.config;
    const rise = this.path ? this.path.heightAt(t) : 0; // the road elevation under the camera at this time
    this.camera.position.set(0, eyeHeight + rise, -distance); // straight path toward -z
    // The camera tilts with the road (uphill looks up, a drop looks down) so steep slopes stay in view, by the scenario's
    // share (`pathTilt`; 0 keeps the view level); look is added on top.
    const tilt = this.path && pathTilt !== 0 ? Math.atan(this.path.slopeAt(t)) * pathTilt : 0;
    this.camera.rotation.set(this.look.pitch + tilt, -this.look.yaw, 0);
    // Optional music-driven field of view (pure function of track time).
    const fov = this.path?.fovAt?.(t) ?? DEFAULT_FOV;
    if (fov !== this.camera.fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private resize(): void {
    const canvas = this.opts.canvas;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Mouse look uses pointer lock: cursor hidden and centered; ESC releases it, a click on the canvas re-locks. */
  private lockPointer(): void {
    const canvas = this.opts.canvas;
    if (document.pointerLockElement === canvas) return;
    try {
      // Rejects (or returns void on old browsers) if not allowed, e.g. right after ESC; a later click retries.
      const result = canvas.requestPointerLock() as Promise<void> | undefined;
      result?.catch(() => { /* not allowed now; the user can click again */ });
    } catch { /* unsupported */ }
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') {
      this.lockPointer();
      return;
    }
    this.lastPointer = { x: e.clientX, y: e.clientY };
  };

  private readonly onPointerUp = (): void => {
    this.lastPointer = null;
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') {
      // Only a locked mouse controls the camera.
      if (document.pointerLockElement !== this.opts.canvas) return;
      this.look.addInput(e.movementX, e.movementY, e.timeStamp / 1000);
      return;
    }
    // Touch looks while the finger is down.
    if (!this.lastPointer) return;
    this.look.addInput(e.clientX - this.lastPointer.x, e.clientY - this.lastPointer.y, e.timeStamp / 1000);
    this.lastPointer = { x: e.clientX, y: e.clientY };
  };

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.opts.onEnded();
  }

  private fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.opts.onFatal(error);
  }

  dispose(): void {
    this.running = false;
    this.ended = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    const canvas = this.opts.canvas;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerUp);
    canvas.removeEventListener('pointerleave', this.onPointerUp);
    if (this.source) {
      this.source.onended = null;
      try { this.source.stop(); } catch { /* already stopped */ }
      this.source.disconnect();
    }
    if (this.opts.fadeOverlay) this.opts.fadeOverlay.style.opacity = '0';
    this.sceneImpl.dispose();
    this.renderer.dispose();
  }
}
