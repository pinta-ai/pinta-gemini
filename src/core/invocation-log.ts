/**
 * Debug audit log (SPEC §12). When PINTA_GEMINI_DEBUG=1, append one JSONL record
 * per hook invocation to <dataDir>/invocations.jsonl — argv, raw payload,
 * normalized canonical, guard verdict, decision. Best-effort; never throws.
 * Consumed by tools/hook-verify.ts.
 */
import fs from "fs";
import path from "path";
import type { PintaConfig } from "./config.js";

export function logInvocation(config: PintaConfig, rec: Record<string, unknown>): void {
  if (process.env.PINTA_GEMINI_DEBUG !== "1") return;
  try {
    fs.mkdirSync(config.pluginData, { recursive: true });
    fs.appendFileSync(path.join(config.pluginData, "invocations.jsonl"), JSON.stringify(rec) + "\n");
  } catch {
    /* best-effort */
  }
}
