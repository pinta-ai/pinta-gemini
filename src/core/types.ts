/**
 * Multi-host hook types + host-family helpers.
 *
 * Agent label is a free string baked at install time via `--agent`. "gemini"
 * gets the Gemini CLI protocol (snake_case, BeforeTool gate); any other label
 * ("antigravity", …) gets the Antigravity protocol (camelCase, PreToolUse gate).
 * See docs/SPEC.md §3.2, §5, §6.
 */

export type Agent = string;

/** Raw host event payload (snake gemini OR camel antigravity). */
export type RawEvent = Record<string, unknown>;

/** Host-neutral canonical view used by guard/telemetry. */
export interface Canonical {
  hook: string; // canonical event name (= --event)
  session_id?: string; // gemini session_id | antigravity conversationId
  cwd?: string; // gemini cwd | antigravity workspacePaths[0]
  tool_name?: string; // gemini tool_name | antigravity toolCall.name
  tool_input?: unknown; // gemini tool_input | antigravity toolCall.args
}

/** Host-specific output decision (top-level keys differ per host — see decision.ts). */
export interface DecisionOutput {
  decision?: "allow" | "deny";
  reason?: string;
  systemMessage?: string;
  [key: string]: unknown;
}

export const isGemini = (agent: Agent): boolean => agent === "gemini";

/** Bronze identity per host family (telemetry prefix / ingest.type / service.name). */
export interface Identity {
  prefix: string;
  ingest: string;
  service: string;
}

/** Per-host-family constants — the single source for all isGemini branching. */
interface HostProfile {
  identity: Identity;
  gateEvent: string; // tool-gate event (where guard runs)
}
const GEMINI: HostProfile = {
  identity: { prefix: "gemini", ingest: "gemini", service: "gemini-cli" },
  gateEvent: "BeforeTool",
};
const ANTIGRAVITY: HostProfile = {
  identity: { prefix: "antigravity", ingest: "antigravity", service: "antigravity-cli" },
  gateEvent: "PreToolUse",
};
const profile = (agent: Agent): HostProfile => (isGemini(agent) ? GEMINI : ANTIGRAVITY);

export function identity(agent: Agent): Identity {
  return profile(agent).identity;
}

/** Tool-gate event (where guard runs) per host family. */
export function gateEvent(agent: Agent): string {
  return profile(agent).gateEvent;
}

/**
 * AfterModel fires per streamed chunk on Gemini — never capture it even if some
 * config registers it (span explosion). Everything else captured flows through.
 */
const SKIP_HOOKS = new Set(["AfterModel"]);
export const isSkippedHook = (hook: string): boolean => SKIP_HOOKS.has(hook);
