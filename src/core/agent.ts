/**
 * Agent/event identification (SPEC §3.2, DG1) + product sub-label (DG11).
 *
 * The host runs us as `node dist/index.js --agent <a> --event <e>`. These argv
 * values are the SOLE identifiers — verified preserved across all hosts (no
 * payload field, no env). We never infer the event from the payload.
 */
import type { Agent, RawEvent } from "./types.js";

export interface Invocation {
  agent: Agent;
  event: string | undefined;
}

export function parseInvocation(argv: string[] = process.argv): Invocation {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return { agent: get("--agent") || "gemini", event: get("--event") };
}

/**
 * Derive the Antigravity product sub-label from `transcriptPath` (DG11, F.4).
 * agy v1.0.x  → ".../antigravity-cli/brain/.../transcript_full.jsonl"
 * Antigravity 2.0 → ".../antigravity/brain/.../transcript.jsonl"
 * Returns undefined when not determinable (e.g. gemini, or unknown path).
 */
export function antigravityProduct(ev: RawEvent): string | undefined {
  const tp = ev["transcriptPath"];
  if (typeof tp !== "string") return undefined;
  if (tp.includes("/antigravity-cli/brain/")) return "agy";
  if (tp.includes("/antigravity/brain/")) return "antigravity2";
  return undefined;
}
