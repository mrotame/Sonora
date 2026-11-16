// Segment window manager (TECHNICAL_ARCHITECTURE 8.1): keeps `ahead` segments in
// front of the camera and `behind` behind it, requesting the nearest first and
// ignoring results for segments that left the window before finishing.

export interface SegmentSource<S> {
  request(index: number): Promise<S>;
}

export interface SegmentManagerOptions<S> {
  length: number;
  ahead: number;
  behind: number;
  source: SegmentSource<S>;
  onAdd(index: number, segment: S): void;
  onRemove(index: number): void;
  onError(error: Error): void;
}

export class SegmentManager<S> {
  private readonly loaded = new Set<number>();
  private readonly wanted = new Set<number>();
  private readonly inflight = new Map<number, Promise<void>>();

  private readonly opts: SegmentManagerOptions<S>;

  constructor(opts: SegmentManagerOptions<S>) {
    this.opts = opts;
  }

  /** Updates the window for the camera at `distance`. Returns a promise that settles when current requests finish. */
  update(distance: number): Promise<void> {
    const { length, ahead, behind } = this.opts;
    const current = Math.floor(distance / length);
    const lo = current - behind, hi = current + ahead;

    for (const index of [...this.loaded]) {
      if (index < lo || index > hi) {
        this.loaded.delete(index);
        this.opts.onRemove(index);
      }
    }
    for (const index of [...this.wanted]) if (index < lo || index > hi) this.wanted.delete(index);

    const order: number[] = [];
    for (let i = current; i <= hi; i++) order.push(i);
    for (let i = current - 1; i >= lo; i--) order.push(i);
    for (const index of order) {
      if (this.loaded.has(index) || this.wanted.has(index)) continue;
      this.wanted.add(index);
      const job = this.opts.source.request(index).then(
        (segment) => {
          if (this.inflight.get(index) === job) this.inflight.delete(index);
          if (!this.wanted.delete(index)) return; // left the window meanwhile
          this.loaded.add(index);
          this.opts.onAdd(index, segment);
        },
        (error: unknown) => this.opts.onError(error instanceof Error ? error : new Error(String(error))),
      );
      this.inflight.set(index, job);
    }
    return Promise.all(this.inflight.values()).then(() => undefined);
  }

  get loadedCount(): number {
    return this.loaded.size;
  }
}
