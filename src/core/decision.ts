/**
 * Host-aware allow/deny output (SPEC §7.3).
 *
 *   guard DENY → gemini: {decision:"deny", reason, systemMessage}
 *                antigravity: {decision:"deny", reason}  (no systemMessage)
 *   allow      → gemini: {} ; antigravity gate(PreToolUse): {decision:"allow"}
 *                (required) ; antigravity non-gate: {}
 */
import type { Agent, DecisionOutput } from "./types.js";
import { isGemini } from "./types.js";
import type { GuardResult } from "./guard.js";

export function formatDecision(agent: Agent, event: string | undefined, guard: GuardResult | null): DecisionOutput {
  if (guard && guard.decision === "DENY") {
    const reason = guard.userMessage ?? guard.reason ?? "guard_deny";
    if (isGemini(agent)) return { decision: "deny", reason, systemMessage: guard.userMessage ?? undefined };
    return { decision: "deny", reason };
  }
  // allow — antigravity PreToolUse REQUIRES an explicit decision; else {}
  if (!isGemini(agent) && event === "PreToolUse") return { decision: "allow" };
  return {};
}
