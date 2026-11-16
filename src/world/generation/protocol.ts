// Typed messages between the main thread and the dedicated Worker (TECHNICAL_ARCHITECTURE 12).
import type { TimelineData } from '../../audio/intelligence/timeline.ts';
import type { Seed } from '../identity/seed.ts';

export type WorkerRequest =
  | {
      type: 'init';
      scenarioId: string;
      worldSeed: Seed;
      sampleRate: number;
      left: Float32Array;
      /** null when the source is mono (same channel as `left`). */
      right: Float32Array | null;
    }
  | { type: 'segment'; id: number; index: number; layer: SegmentLayer };

/** 'near' = the detailed segments; 'far' = the optional far-field layer (coarse, longer segments). */
export type SegmentLayer = 'near' | 'far';

export type WorkerResponse =
  | { type: 'progress'; fraction: number }
  | { type: 'timeline'; data: TimelineData }
  | { type: 'segment'; id: number; index: number; segment: unknown }
  | { type: 'error'; id?: number; message: string };
