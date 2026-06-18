/**
 * Per-session ULID trace store (SPEC §10).
 *
 * Keyed by session_id/conversationId in a map so concurrent host sessions don't
 * collide. New trace at turn start (gemini BeforeAgent / antigravity first
 * PreInvocation); reuse otherwise. ULID → 32-hex traceId happens in otlp.ts.
 */
import fs from "fs";
import path from "path";
import { generateUlid } from "@pinta-ai/core";
import type { PintaConfig } from "./config.js";

export class TraceManager {
  private tracePath: string;

  constructor(config: PintaConfig) {
    this.tracePath = config.tracePath;
  }

  private read(): Record<string, string> {
    try {
      const data = JSON.parse(fs.readFileSync(this.tracePath, "utf-8"));
      return data && typeof data === "object" ? data : {};
    } catch {
      return {};
    }
  }

  private write(map: Record<string, string>): void {
    try {
      fs.mkdirSync(path.dirname(this.tracePath), { recursive: true });
      fs.writeFileSync(this.tracePath, JSON.stringify(map));
    } catch {
      /* best-effort */
    }
  }

  /** Start a fresh trace for this session (turn boundary). */
  newTrace(sessionId: string): string {
    const map = this.read();
    const traceId = generateUlid();
    map[sessionId] = traceId;
    this.write(map);
    return traceId;
  }

  /** Current trace for this session; creates one if absent. */
  currentTrace(sessionId: string): string {
    const map = this.read();
    if (map[sessionId]) return map[sessionId];
    return this.newTrace(sessionId);
  }
}
