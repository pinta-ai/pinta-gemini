/**
 * Host payload → canonical normalization (SPEC §6).
 *
 * gemini (snake_case): session_id, cwd, tool_name, tool_input, hook_event_name.
 * antigravity (camelCase): conversationId, workspacePaths[0], toolCall.{name,args}.
 *
 * Note (F.3): antigravity PostToolUse.toolCall may be null → tool_name absent is
 * allowed; callers MUST NOT assume tool_name on non-PreToolUse events.
 */
import type { Agent, Canonical, RawEvent } from "./types.js";
import { isGemini } from "./types.js";

export function normalize(agent: Agent, event: string | undefined, ev: RawEvent): Canonical {
  if (isGemini(agent)) {
    return {
      hook: event || (ev["hook_event_name"] as string) || "unknown",
      session_id: asString(ev["session_id"]),
      cwd: asString(ev["cwd"]),
      tool_name: asString(ev["tool_name"]),
      tool_input: ev["tool_input"],
    };
  }
  const workspacePaths = ev["workspacePaths"];
  const toolCall = ev["toolCall"] as { name?: string; args?: unknown } | null | undefined;
  return {
    hook: event || "unknown",
    session_id: asString(ev["conversationId"]),
    cwd: Array.isArray(workspacePaths) ? asString(workspacePaths[0]) : undefined,
    tool_name: toolCall?.name,
    tool_input: toolCall?.args,
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
