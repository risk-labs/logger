// Shared queue used by webhook based transports (Slack, Discord) to decouple accepting a log entry from delivering it.
//
// winston 3 pipes the logger stream into every attached transport and each transport buffers a small number of log
// objects (default object mode highWaterMark of 16). If a transport stops acknowledging writes -- for example because
// it is awaiting a webhook post that never resolves, or is being rate limited -- backpressure pauses the shared source
// and *every* transport stops receiving logs, including healthy ones like the console transport. Since log writes are
// fire and forget the application keeps running, silently, with no logs at all.
//
// A logging pipeline should shed load, never backpressure the application. Transports using this queue therefore
// acknowledge the winston write immediately and deliver in the background, dropping the oldest queued elements once
// the queue is full rather than growing without bound.

import { delay } from "../helpers/delay";

export interface AsyncLogQueueOptions<T> {
  // Maximum number of elements held in the queue. Once reached, the oldest element is dropped to make room.
  maxQueueSize: number;

  // Delivers a single element. A rejection is treated as a delivery failure and is either retried (see
  // retryDelaySeconds) or reported through onError.
  deliver: (element: T) => Promise<void>;

  // Reports an element that could not be delivered. Transports typically emit a TransportError here.
  onError: (error: unknown, element: T) => void;

  // Reports how many elements were dropped since the last report. Called once the queue has drained, so that a flood
  // results in a single summary rather than one message per dropped element. Implementations may enqueue from here;
  // anything enqueued is delivered before the queue is considered flushed.
  onDropped?: (droppedCount: number) => void;

  // Returns how long to wait before retrying the failed element, or undefined if it should not be retried. Used to
  // honour rate limit responses (Slack's `Retry-After` header, Discord's `retry_after` body field).
  retryDelaySeconds?: (error: unknown) => number | undefined;

  // Number of retries allowed per element before it is reported through onError. Defaults to 3.
  maxRetries?: number;

  // Upper bound on a single retry delay, in seconds. Defaults to 60. Prevents an upstream from parking the queue for
  // an unbounded amount of time.
  maxRetryDelaySeconds?: number;
}

export class AsyncLogQueue<T> {
  private readonly queue: T[] = [];
  private isDraining = false;
  private droppedCount = 0;

  constructor(private readonly options: AsyncLogQueueOptions<T>) {}

  // True when everything accepted so far has been delivered (or dropped and reported). Transports expose this through
  // their own isFlushed getter so that waitForLogger can block on it before the process terminates.
  get isFlushed(): boolean {
    return this.queue.length === 0 && !this.isDraining;
  }

  // Number of elements currently waiting to be delivered. Exposed for tests and diagnostics.
  get length(): number {
    return this.queue.length;
  }

  // Accepts elements for delivery and kicks off the drain loop. Never blocks the caller and never rejects: this is
  // called from a winston transport's log method, which must return promptly to keep the logger pipeline moving.
  enqueue(...elements: T[]): void {
    for (const element of elements) {
      // Drop the oldest element rather than the newest: during a flood the most recent logs are the most useful.
      if (this.queue.length >= this.options.maxQueueSize) {
        this.queue.shift();
        this.droppedCount++;
      }
      this.queue.push(element);
    }

    // Deliberately not awaited. drain never rejects.
    this.drain();
  }

  private async drain(): Promise<void> {
    if (this.isDraining) return; // A drain loop is already running and will pick up whatever was just enqueued.
    this.isDraining = true;

    try {
      while (this.queue.length > 0 || this.droppedCount > 0) {
        // The queue has drained but elements were dropped along the way. Report the summary before exiting the loop:
        // onDropped may enqueue a message of its own and we want it delivered by this same loop.
        if (this.queue.length === 0) {
          const droppedCount = this.droppedCount;
          this.droppedCount = 0;
          try {
            this.options.onDropped?.(droppedCount);
          } catch {
            // Reporting dropped elements must never break the drain loop.
          }
          continue;
        }

        // Take the element off the queue before delivering it, so that an element being delivered can never be dropped
        // to make room for a newer one.
        await this.deliver(this.queue.shift() as T);
      }
    } finally {
      this.isDraining = false;
    }
  }

  // Delivers a single element, retrying while the failure is retryable and reporting it once it is not.
  private async deliver(element: T): Promise<void> {
    const maxRetries = this.options.maxRetries ?? 3;
    const maxRetryDelaySeconds = this.options.maxRetryDelaySeconds ?? 60;

    for (let retries = 0; ; retries++) {
      try {
        return await this.options.deliver(element);
      } catch (error) {
        const retryDelaySeconds = this.options.retryDelaySeconds?.(error);
        if (retryDelaySeconds !== undefined && retries < maxRetries) {
          await delay(Math.min(retryDelaySeconds, maxRetryDelaySeconds));
          continue;
        }
        try {
          this.options.onError(error, element);
        } catch {
          // An error reporter that throws must not stall the queue.
        }
        return;
      }
    }
  }
}
