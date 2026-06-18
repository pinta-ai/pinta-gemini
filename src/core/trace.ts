/**
 * Per-session ULID trace store (SPEC §10).
 *
 * Keyed by session_id/conversationId in a map so concurrent host sessions don't
 * collide. New trace at turn start (gemini BeforeAgent / antigravity first
 * PreInvocation); reuse otherwise. ULID → 32-hex traceId happens in otlp.ts.
 *
 * Thin binding over the shared @pinta-ai/core disk store, preserving the
 * `new TraceManager(config)` constructor gemini callers expect.
 */
import { DiskSessionTraceManager } from "@pinta-ai/core";
import type { PintaConfig } from "./config.js";

export class TraceManager extends DiskSessionTraceManager {
  constructor(config: PintaConfig) {
    super(config.tracePath);
  }
}
