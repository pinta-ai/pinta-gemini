/**
 * Host-aware allow/deny output (SPEC §7.3).
 *
 *   guard DENY → gemini: {decision:"deny", reason, systemMessage}
 *                antigravity: {decision:"deny", reason}  (no systemMessage)
 *   allow      → gemini: {} ; antigravity gate(PreToolUse): {decision:"allow"}
 *                (required) ; antigravity non-gate: {}
 *
 *   gemini AfterTool DENY (a tool *output*, PTA-695): Gemini CLI 0.59.0 replaces
 *   the model-facing result with `reason`, so `reason` carries everything the
 *   model gets instead of that output — the policy's notice, a fixed recovery
 *   hint and, when the manager said the output can be masked, the output with
 *   only the detected values replaced by `[REDACTED:<category>]`. Without
 *   `outputAction` (manager < 0.1.16) the output is withheld. `systemMessage`
 *   is the one-line notice shown to the user. Antigravity has no verified
 *   post-tool control channel, so this branch is Gemini-only.
 */
import type { Agent, DecisionOutput } from "./types.js";
import { isGemini } from "./types.js";
import type { GuardResult } from "./guard.js";
import { buildOutputDenial } from "@pinta-ai/core";

/**
 * The tool output as Gemini would have handed it to the model: `llmContent`
 * when it is a string, else the JSON of `llmContent` (a parts array), else the
 * JSON of the whole `tool_response`. Masking runs over this text, so a value
 * sitting inside a JSON string is masked in its escaped form as well.
 */
export function returnedText(toolResponse: unknown): string {
  const llm = (toolResponse as { llmContent?: unknown } | null | undefined)?.llmContent;
  if (typeof llm === "string") return llm;
  return JSON.stringify(llm ?? toolResponse) ?? "";
}

export function formatDecision(
  agent: Agent,
  event: string | undefined,
  guard: GuardResult | null,
  // Gemini's raw `tool_response`; only read on the AfterTool DENY branch.
  toolResponse?: unknown,
): DecisionOutput {
  if (guard && guard.decision === "DENY") {
    if (isGemini(agent) && event === "AfterTool") {
      const d = buildOutputDenial({ original: returnedText(toolResponse), guard });
      const reason = d.action === "mask"
        ? `${d.notice}\n\n${d.guidance}\n\n${d.text}`
        : `${d.notice}\n\n${d.guidance}`;
      return { decision: "deny", reason, systemMessage: d.notice };
    }
    const reason = guard.userMessage ?? guard.reason ?? "guard_deny";
    if (isGemini(agent)) return { decision: "deny", reason, systemMessage: guard.userMessage ?? undefined };
    return { decision: "deny", reason };
  }
  // allow — antigravity PreToolUse REQUIRES an explicit decision; else {}
  if (!isGemini(agent) && event === "PreToolUse") return { decision: "allow" };
  return {};
}
