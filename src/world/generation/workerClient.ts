// Main-thread side of the dedicated Worker. A Worker failure is fatal (TECHNICAL_ARCHITECTURE 12).
import type { TimelineData } from '../../audio/intelligence/timeline.ts';
import type { Seed } from '../identity/seed.ts';
import type { SegmentLayer, WorkerRequest, WorkerResponse } from './protocol.ts';

interface Pending {
  resolve(segment: unknown): void;
  reject(error: Error): void;
}

export class WorldWorker {
  private readonly worker = new Worker(new URL('./world.worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private onTimeline: ((data: TimelineData) => void) | null = null;
  private onProgress: ((fraction: number) => void) | null = null;
  private failInit: ((error: Error) => void) | null = null;
  private readonly onFatal: (error: Error) => void;

  constructor(onFatal: (error: Error) => void) {
    this.onFatal = onFatal;
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handle(event.data);
    this.worker.onerror = () => this.fail(new Error('worker crashed'));
    this.worker.onmessageerror = () => this.fail(new Error('worker message error'));
  }

  private send(message: WorkerRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  private fail(error: Error): void {
    this.failInit?.(error);
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    this.onFatal(error);
  }

  private handle(msg: WorkerResponse): void {
    switch (msg.type) {
      case 'progress':
        this.onProgress?.(msg.fraction);
        break;
      case 'timeline':
        this.onTimeline?.(msg.data);
        break;
      case 'segment': {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        p?.resolve(msg.segment);
        break;
      }
      case 'error':
        this.fail(new Error(msg.message));
        break;
    }
  }

  /** Sends the PCM channels (as copies: playback keeps using the AudioBuffer) and resolves with the timeline. */
  init(args: {
    scenarioId: string;
    worldSeed: Seed;
    sampleRate: number;
    left: Float32Array;
    right: Float32Array | null;
    onProgress: (fraction: number) => void;
  }): Promise<TimelineData> {
    return new Promise((resolve, reject) => {
      this.onProgress = args.onProgress;
      this.onTimeline = resolve;
      this.failInit = reject;
      const left = args.left.slice();
      const right = args.right ? args.right.slice() : null;
      const transfer: Transferable[] = [left.buffer];
      if (right) transfer.push(right.buffer);
      this.send({ type: 'init', scenarioId: args.scenarioId, worldSeed: args.worldSeed, sampleRate: args.sampleRate, left, right }, transfer);
    });
  }

  requestSegment(index: number, layer: SegmentLayer = 'near'): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.send({ type: 'segment', id, index, layer });
    });
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}
