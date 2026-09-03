// gemini-specific binding over the shared guard in @pinta-ai/core. Preserves the
// historical gemini behavior: 50ms timeout, relay token resolved from the
// caller (config.headers['x-pinta-relay-token']) with a PINTA_RELAY_TOKEN
// fallback, PINTA_GUARD_DISABLED honored, and a `pinta-gemini/<version>`
// User-Agent. `shellCommandText` stays here — it is gemini-specific multi-host
// tool-input extraction, not a shared utility.
import { evaluateGuard as coreEvaluateGuard } from "@pinta-ai/core";
import type { GuardInput, GuardResult } from "@pinta-ai/core";
import { identity, type Agent } from "./types.js";

export type { GuardInput, GuardResult } from "@pinta-ai/core";

const TIMEOUT_MS = 50;

// Self-identify to the manager's guard route so it can attribute calls to this
// adaptor (the route parses `pinta-*/<version>` out of the User-Agent). Keep the
// version in sync with package.json.
const GUARD_UA = "pinta-gemini/0.8.0";

/**
 * The shell command text out of a tool_input, regardless of host field name:
 * Gemini CLI's run_shell_command uses `command`, Antigravity's run_command uses
 * PascalCase `CommandLine`. The manager's guard scans rawTextFields.toolInput as
 * its shell-command fallback (the package extractor reads toolInput.command or
 * rawTextFields.toolInput) and cannot parse a command out of a JSON-stringified
 * object — so for Antigravity we must hand it the plain command string, else the
 * package guard silently fails open. Returns undefined for non-shell shapes so
 * the caller keeps its JSON-stringify fallback.
 */
export function shellCommandText(toolInput: unknown): string | undefined {
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return undefined;
  const o = toolInput as Record<string, unknown>;
  const v = o["command"] ?? o["CommandLine"];
  return typeof v === "string" ? v : undefined;
}

export function evaluateGuard(
  input: GuardInput,
  endpoint: string | undefined,
  // Relay token to authenticate the guard call. Pass the SAME token the trace
  // transport uses (config.headers['x-pinta-relay-token'], parsed from
  // GEMINI_PLUGIN_OPTION_HEADERS) so trace and guard share one env source.
  // Falls back to PINTA_RELAY_TOKEN for back-compat with older enrollments.
  relayToken?: string,
  // Which host is running. Required to name the agent: this bundle serves both
  // Gemini CLI and Antigravity, so the User-Agent — one fixed
  // `pinta-gemini/<version>` for both — cannot carry the distinction, and the
  // manager reading only that answered `unknown` for every call from here
  // (PTA-260). `identity(agent).ingest` is the same value the telemetry leg has
  // been sending as `ingest.type` all along; this puts it on the guard leg too,
  // so both paths name the agent the same way.
  agent?: Agent,
): Promise<GuardResult | null> {
  return coreEvaluateGuard(input, endpoint, {
    timeoutMs: TIMEOUT_MS,
    token: relayToken ?? process.env.PINTA_RELAY_TOKEN ?? "",
    disabled: process.env.PINTA_GUARD_DISABLED === "1",
    userAgent: GUARD_UA,
    // Omitted when the caller does not say, rather than defaulted to "gemini".
    // Half of this bundle's installs are Antigravity, so a default is not a
    // safe guess — it is a wrong answer for half of them, and a wrong agent
    // blocks the client a rule did not name while missing the one it did.
    agentType: agent ? identity(agent).ingest : undefined,
  });
}
