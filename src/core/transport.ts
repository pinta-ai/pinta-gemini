/**
 * OTLP/HTTP transport (SPEC §9, §13). Config-driven endpoint/headers. On failure
 * enqueues to the retry-queue; next hook flushes. Silent disable when no endpoint.
 */
import { RetryQueue } from "./retry-queue.js";
import { mergeBatch } from "./otlp.js";
import type { OtlpPayload } from "./otlp.js";
import type { PintaConfig } from "./config.js";

const TIMEOUT_MS = 5000;

export class Transport {
  private queue: RetryQueue;
  constructor(private config: PintaConfig) {
    this.queue = new RetryQueue(config.pluginData);
  }

  async send(payload: OtlpPayload): Promise<void> {
    if (!this.config.endpoint) return;
    const ok = await this.post(payload);
    if (!ok) this.queue.enqueue(payload);
  }

  async flush(): Promise<void> {
    if (!this.config.endpoint) return;
    if (!this.queue.tryAcquireLock()) return;
    try {
      const entries = this.queue.readAll();
      if (entries.length === 0) return;
      const ok = await this.post(mergeBatch(entries.map((e) => e.payload)));
      if (ok) this.queue.rewrite([]);
    } finally {
      this.queue.release();
    }
  }

  private async post(payload: OtlpPayload): Promise<boolean> {
    const endpoint = this.config.endpoint!;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.config.headers },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        process.stderr.write(`[pinta-gemini] OTLP POST ${res.status} ${endpoint}\n`);
        return false;
      }
      return true;
    } catch (err) {
      process.stderr.write(`[pinta-gemini] OTLP POST failed: ${(err as Error).message ?? String(err)}\n`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
