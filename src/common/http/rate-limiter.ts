export interface RateLimiterOptions {
  minIntervalMs: number;
  maxConcurrent: number;
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

export class RateLimiter {
  private readonly options: RateLimiterOptions;
  private readonly queue: Waiter[] = [];
  private active = 0;

  private nextSlotAt = 0;
  private timer?: NodeJS.Timeout;
  private closed = false;

  constructor(options: RateLimiterOptions) {
    this.options = options;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  penalise(delayMs: number): void {
    const until = Date.now() + delayMs;
    if (until > this.nextSlotAt) {
      this.nextSlotAt = until;
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  get inFlight(): number {
    return this.active;
  }

  close(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    while (this.queue.length > 0) {
      this.queue.shift()!.reject(new Error('Rate limiter closed'));
    }
  }

  private acquire(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Rate limiter closed'));
    if (this.active < this.options.maxConcurrent && Date.now() >= this.nextSlotAt) {
      return this.start();
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.schedule();
    });
  }

  private start(): Promise<void> {
    this.active += 1;
    this.nextSlotAt = Date.now() + this.options.minIntervalMs;
    return Promise.resolve();
  }

  private release(): void {
    this.active -= 1;
    this.schedule();
  }

  private schedule(): void {
    if (this.closed || this.timer) return;
    if (this.queue.length === 0) return;
    if (this.active >= this.options.maxConcurrent) return;

    const wait = Math.max(0, this.nextSlotAt - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.closed) return;
      const waiter = this.queue.shift();
      if (!waiter) return;
      this.start().then(waiter.resolve, waiter.reject);
      this.schedule();
    }, wait);

    this.timer.unref?.();
  }
}
