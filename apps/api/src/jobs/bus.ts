/**
 * Job bus abstraction. Production uses BullMQ (Redis) with retries + exponential backoff;
 * tests and single-node dev can use the inline bus. Every handler must be idempotent: jobs
 * can be delivered more than once.
 */
import { Queue, Worker, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';

export type JobName =
  | 'task.generate_assignments'
  | 'submission.evaluate'
  | 'evaluation.apply'
  | 'growth.recalculate'
  | 'notification.fanout'
  | 'integration.import_students'
  | 'insights.nightly'
  | 'privacy.export';

export interface JobPayload { tenantId: string; [k: string]: unknown }
export type Handler = (payload: JobPayload) => Promise<void>;

export interface EnqueueOptions { jobId?: string; delayMs?: number }

export interface JobBus {
  enqueue(name: JobName, payload: JobPayload, opts?: EnqueueOptions): Promise<void>;
  close(): Promise<void>;
}

const QUEUE = 's360-jobs';

export class BullBus implements JobBus {
  private queue: Queue;
  private connection: Redis;
  constructor() {
    this.connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue = new Queue(QUEUE, { connection: this.connection });
  }
  async enqueue(name: JobName, payload: JobPayload, opts: EnqueueOptions = {}) {
    const o: JobsOptions = {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 3600, count: 10_000 },
      removeOnFail: { age: 7 * 86400 },
    };
    if (opts.jobId) o.jobId = opts.jobId.replace(/:/g, '_');
    if (opts.delayMs) o.delay = opts.delayMs;
    await this.queue.add(name, payload, o);
  }
  async counts() {
    return this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
  }
  async close() {
    await this.queue.close();
    this.connection.disconnect();
  }
}

export function startBullWorker(handlers: Record<JobName, Handler>, concurrency = 10) {
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  return new Worker(QUEUE, async (job) => {
    const h = handlers[job.name as JobName];
    if (!h) throw new Error(`no handler for ${job.name}`);
    await h(job.data as JobPayload);
  }, { connection, concurrency });
}

/** Runs jobs in-process, FIFO, after the enqueuing transaction has committed. */
export class InlineBus implements JobBus {
  private pending: { name: JobName; payload: JobPayload; jobId?: string }[] = [];
  private seen = new Set<string>();
  public failures: { name: JobName; error: unknown }[] = [];
  constructor(private handlers: () => Record<JobName, Handler>) {}
  async enqueue(name: JobName, payload: JobPayload, opts: EnqueueOptions = {}) {
    if (opts.jobId && this.pending.some((p) => p.jobId === opts.jobId)) return; // dedupe like BullMQ
    this.pending.push({ name, payload, jobId: opts.jobId });
  }
  /** Drains queued jobs. Returns the number executed. */
  async drain(): Promise<number> {
    let n = 0;
    while (this.pending.length) {
      const j = this.pending.shift()!;
      try {
        await this.handlers()[j.name](j.payload);
      } catch (error) {
        this.failures.push({ name: j.name, error });
      }
      n++;
    }
    return n;
  }
  async close() { /* nothing */ }
}
