// Scenario logic contract (TECHNICAL_ARCHITECTURE 9). This file and every
// `logic.ts` are pure and DOM-free: they run inside the Worker and in Node tests.
import type { Features, Timeline } from '../audio/intelligence/timeline.ts';
import type { Seed } from '../world/identity/seed.ts';
import type * as THREE from 'three';

/** Main-thread, Three.js side of a scenario: owns its meshes, materials and disposal. */
export interface ScenarioScene {
  readonly scene: THREE.Scene;
  /** Clear color matching the scenario's horizon. */
  readonly background: THREE.Color;
  /** Optional: resolves once the scene's assets (textures) are loaded; awaited before the first frame. */
  ready?(): Promise<void>;
  addSegment(index: number, descriptor: unknown, startDistance: number): void;
  removeSegment(index: number): void;
  /** Far-field layer (only for scenarios whose logic defines `farField`): coarse segments that extend the view distance. */
  addFarSegment?(index: number, descriptor: unknown, startDistance: number): void;
  removeFarSegment?(index: number): void;
  /** `trackTime` (s) is the playback clock, for time-addressable shader animation that is not driven by features. */
  update(params: unknown, cameraPosition: THREE.Vector3, trackTime: number): void;
  dispose(): void;
}

export interface ScenarioDefinition {
  logic: ScenarioLogic<unknown, unknown>;
  /** Shown in the scenario selector. */
  label: string;
  createScene(): ScenarioScene;
}

export interface ScenarioConfig {
  /** Fixed spatial length L of a segment, in world units (8.1). */
  segmentLength: number;
  /** Constant camera forward speed v: distance(t) = v * t (11). */
  speed: number;
  /** Streaming window, in segments. Starting values, to be calibrated by profiling. */
  segmentsAhead: number;
  segmentsBehind: number;
  eyeHeight: number;
  /** Camera far plane in world units (default 1500). Must cover the scenario's farthest visible content. */
  viewDistance?: number;
  /** Show the speed/height graph HUD when the scenario has a path (default true). */
  speedGraph?: boolean;
}

/** Streaming window of the optional far-field layer, in far segments of its own length. */
export interface FarFieldConfig {
  segmentLength: number;
  segmentsAhead: number;
  segmentsBehind: number;
}

/**
 * Optional, scenario-owned camera path along the travel axis. A pure, time-addressable function of the
 * timeline (no per-frame state). Scenarios that do not provide one keep the constant `distance = speed * t`
 * and a flat road. The scenario's `generateSegment` must use the same path as the camera.
 */
export interface TrackPath {
  /** Distance travelled at track time t (monotonic increasing). */
  distanceAt(t: number): number;
  /** Inverse of `distanceAt`: track time at which the camera reaches distance d. */
  timeAt(d: number): number;
  /** Height of the road (and of the whole world with it) above its base level at track time t. */
  heightAt(t: number): number;
  /** Road slope (rise over run along the travel axis) at track time t. */
  slopeAt(t: number): number;
  /** Optional vertical field of view (degrees) at track time t; absent = the controller's default (70). */
  fovAt?(t: number): number;
}

export interface SegmentInput {
  index: number;
  /** Distance along the travel axis where the segment starts (index * length). */
  startDistance: number;
  length: number;
  /** Seed of the whole world: use it for continuous world-space fields. */
  worldSeed: Seed;
  /** Sub-seed derived for ('segment', index): use it for discrete per-segment content. */
  seed: Seed;
  timeline: Timeline;
  speed: number;
  /** Present only for scenarios that define `createPath`. */
  path?: TrackPath;
}

export interface ScenarioLogic<Params, Segment> {
  id: string;
  version: number;
  config: ScenarioConfig;
  /**
   * Opt-in: music-driven camera speed and road elevation. Absent = constant speed on a flat road. A scenario whose road
   * follows its terrain (bridges) also receives the world seed; others ignore it.
   */
  createPath?(timeline: Timeline, worldSeed?: Seed): TrackPath;
  /** Pure mapping from timeline features at time t to visual parameters. */
  interpret(features: Features, seed: Seed): Params;
  /** Pure function of its input: the same input always yields the same segment. */
  generateSegment(input: SegmentInput): Segment;
  /**
   * Opt-in far-field layer (level of detail): coarse segments streamed in a second, longer window so the world
   * can be seen far beyond the detailed segments. Pure like `generateSegment`, sampling the same continuous fields.
   */
  farField?: {
    config: FarFieldConfig;
    generateSegment(input: SegmentInput): unknown;
  };
}
