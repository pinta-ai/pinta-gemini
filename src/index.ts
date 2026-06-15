/**
 * pinta-gemini — unified OTLP forwarder + guard adapter for THREE hosts:
 *   - gemini       : Google Gemini CLI        (snake_case, hook_event_name in payload)
 *   - antigravity1 : Antigravity CLI 1.0      (camelCase, event via --event arg)
 *   - antigravity2 : Antigravity 2.0          (camelCase, event via --event arg)
 *
 * The host runs us as a command hook: `node dist/index.js --agent <a> --event <e>`
 * with the event JSON on stdin. We forward an OTLP span and, on tool-gate events,
 * consult the guard and emit a host-appropriate allow/deny decision on stdout.
 *
 * Contract (see BACKGROUND_RESEARCH.md DG1–DG10):
 *   - DG1: --agent/--event are the sole agent/event identifiers (no env, no payload field).
 *   - DG2: normalize host payload → canonical {hook, session_id, cwd, tool_name, tool_input}.
 *   - DG3: agent-specific ingest.type / prefix / service.name.
 *   - DG5: host-aware decision output.
 *   - DG6: ALWAYS exactly one JSON object on stdout, ALWAYS exit 0 (fail-open).
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Agent label is a free string baked at install time (--agent). "gemini" gets
// the Gemini CLI protocol (snake_case, BeforeTool gate); ANY other label
// ("antigravity-cli", "antigravity2", …) gets the Antigravity protocol
// (camelCase, PreToolUse gate). Empirically agy v1.0.7 reads ~/.gemini/config/
// hooks.json and speaks the documented Antigravity ("2.0") protocol.
type Agent = string;
const isGemini = (a: Agent): boolean => a === "gemini";

/** Canonical tool-gate event per host family. */
function gateEvent(agent: Agent): string {
  return isGemini(agent) ? "BeforeTool" : "PreToolUse";
}

interface Identity {
  prefix: string;
  ingest: string;
  service: string;
}
function identity(agent: Agent): Identity {
  return agent === "gemini"
    ? { prefix: "gemini", ingest: "gemini", service: "gemini-cli" }
    : { prefix: "antigravity", ingest: "antigravity", service: "antigravity-cli" };
}

interface Canonical {
  hook: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
}

interface GuardResult {
  decision: "ALLOW" | "DENY" | "REVIEW";
  reason: string | null;
  userMessage: string | null;
}

interface DecisionOutput {
  decision?: "allow" | "deny";
  reason?: string;
  systemMessage?: string;
}

// ---------------------------------------------------------------------------
function argv(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

/** Best-effort load of ~/.gemini/pinta-gemini.env (unset keys only). */
function loadEnvFile(): void {
  try {
    const home = process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
    const content = fs.readFileSync(path.join(home, "pinta-gemini.env"), "utf-8");
    for (const raw of content.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const idx = line.indexOf("=");
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    /* missing/unreadable — silent no-op */
  }
}

// DG2 — normalize host payload (snake gemini / camel antigravity) → canonical
function normalize(agent: Agent, event: string | undefined, ev: Record<string, unknown>): Canonical {
  if (agent === "gemini") {
    return {
      hook: event || (ev["hook_event_name"] as string) || "unknown",
      session_id: ev["session_id"] as string | undefined,
      cwd: ev["cwd"] as string | undefined,
      tool_name: ev["tool_name"] as string | undefined,
      tool_input: ev["tool_input"],
    };
  }
  // antigravity1 / antigravity2 — camelCase, no event name in payload
  const workspacePaths = ev["workspacePaths"];
  const toolCall = ev["toolCall"] as { name?: string; args?: unknown } | undefined;
  return {
    hook: event || "unknown",
    session_id: ev["conversationId"] as string | undefined,
    cwd: Array.isArray(workspacePaths) ? (workspacePaths[0] as string) : undefined,
    tool_name: toolCall?.name,
    tool_input: toolCall?.args,
  };
}

function resolveEndpoint(): string | undefined {
  const traces = process.env.GEMINI_PLUGIN_OPTION_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (traces) return traces.replace(/\/+$/, "");
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (base) return base.replace(/\/+$/, "") + "/v1/traces";
  return undefined;
}

function parseHeaders(): Record<string, string> {
  const raw = process.env.GEMINI_PLUGIN_OPTION_HEADERS || process.env.OTEL_EXPORTER_OTLP_HEADERS;
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const [k, ...rest] = pair.split("=");
    if (k && rest.length) out[k.trim()] = rest.join("=").trim();
  }
  return out;
}

async function evaluateGuard(c: Canonical): Promise<GuardResult | null> {
  const endpoint = process.env.PINTA_GUARD_ENDPOINT;
  if (!endpoint || process.env.PINTA_GUARD_DISABLED === "1") return null;
  const raw = typeof c.tool_input === "string" ? c.tool_input : JSON.stringify(c.tool_input ?? null);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 50); // fail-open on slow guard
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pinta-relay-token": process.env.PINTA_RELAY_TOKEN ?? "" },
      body: JSON.stringify({
        input: { spanId: c.session_id ?? "unknown", toolName: c.tool_name, toolInput: c.tool_input, rawTextFields: { toolInput: raw } },
      }),
      signal: ctrl.signal,
    });
    if (res.status !== 200) return { decision: "ALLOW", reason: null, userMessage: null };
    const body = (await res.json()) as Partial<GuardResult>;
    return { decision: body.decision ?? "ALLOW", reason: body.reason ?? null, userMessage: body.userMessage ?? null };
  } catch {
    return { decision: "ALLOW", reason: null, userMessage: null }; // fail-open
  } finally {
    clearTimeout(timer);
  }
}

function snake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();
}

type AttrValue = { stringValue: string } | { intValue: number } | { boolValue: boolean } | { doubleValue: number };
interface Attr {
  key: string;
  value: AttrValue;
}

// DG3 — Bronze flatten with agent-specific prefix + ingest.type discriminator
async function forward(agent: Agent, c: Canonical, ev: Record<string, unknown>, guard: GuardResult | null): Promise<void> {
  const endpoint = resolveEndpoint();
  if (!endpoint) return;
  const id = identity(agent);
  const attrs: Attr[] = [
    { key: "ingest.type", value: { stringValue: id.ingest } },
    { key: `${id.prefix}.hook`, value: { stringValue: c.hook } },
    { key: `${id.prefix}.agent`, value: { stringValue: agent } },
  ];
  if (c.session_id) attrs.push({ key: `${id.prefix}.session_id`, value: { stringValue: c.session_id } });
  if (c.cwd) attrs.push({ key: `${id.prefix}.cwd`, value: { stringValue: c.cwd } });
  if (c.tool_name) attrs.push({ key: `${id.prefix}.tool_name`, value: { stringValue: c.tool_name } });
  // Bronze: stringify remaining top-level event fields under the prefix.
  for (const [k, v] of Object.entries(ev)) {
    if (v === null || v === undefined) continue;
    const key = `${id.prefix}.${k}`;
    const value: AttrValue =
      typeof v === "string"
        ? { stringValue: v }
        : typeof v === "boolean"
          ? { boolValue: v }
          : typeof v === "number"
            ? Number.isInteger(v)
              ? { intValue: v }
              : { doubleValue: v }
            : { stringValue: JSON.stringify(v) };
    attrs.push({ key, value });
  }
  if (guard) {
    attrs.push({ key: "pinta.guard.decision", value: { stringValue: guard.decision.toLowerCase() } });
    if (guard.reason) attrs.push({ key: "pinta.guard.matched_rule", value: { stringValue: guard.reason } });
  }
  const payload = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: id.service } }] },
        scopeSpans: [{ scope: { name: "pinta-gemini", version: "0.1.0" }, spans: [{ name: `${id.ingest}.${snake(c.hook)}`, kind: 1, attributes: attrs }] }],
      },
    ],
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", ...parseHeaders() }, body: JSON.stringify(payload), signal: ctrl.signal });
  } catch (e) {
    process.stderr.write(`[pinta-gemini] OTLP forward failed: ${(e as Error).message}\n`);
  } finally {
    clearTimeout(timer);
  }
}

// DG5 — host-aware decision output
function formatDecision(agent: Agent, event: string | undefined, guard: GuardResult | null): DecisionOutput {
  if (guard && guard.decision === "DENY") {
    const reason = guard.userMessage ?? guard.reason ?? "guard_deny";
    if (agent === "gemini") return { decision: "deny", reason, systemMessage: guard.userMessage ?? undefined };
    return { decision: "deny", reason }; // antigravity
  }
  // allow — antigravity PreToolUse REQUIRES an explicit decision; everything else may be {}
  if (agent !== "gemini" && event === "PreToolUse") return { decision: "allow" };
  return {};
}

/**
 * Audit log — when PINTA_GEMINI_DEBUG=1, append one JSONL record per hook
 * invocation to <dataDir>/invocations.jsonl. Lets you see, for every fired hook:
 * what argv it got, the RAW payload the host delivered, the normalized canonical
 * fields, the guard verdict, and the decision we returned. Best-effort; never throws.
 */
function logInvocation(rec: Record<string, unknown>): void {
  if (process.env.PINTA_GEMINI_DEBUG !== "1") return;
  try {
    const home = process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
    const dataDir = process.env.GEMINI_PLUGIN_DATA || path.join(home, "pinta-gemini-data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(path.join(dataDir, "invocations.jsonl"), JSON.stringify(rec) + "\n");
  } catch {
    /* best-effort */
  }
}

async function main(): Promise<void> {
  let out: DecisionOutput = {};
  const agent: Agent = argv("--agent") || "gemini";
  const event = argv("--event");
  let ev: Record<string, unknown> = {};
  let c: Canonical | undefined;
  let guard: GuardResult | null = null;
  try {
    loadEnvFile();
    ev = JSON.parse((await readStdin()) || "{}") as Record<string, unknown>;
    c = normalize(agent, event, ev);
    if (c.hook === gateEvent(agent)) guard = await evaluateGuard(c);
    await forward(agent, c, ev, guard);
    out = formatDecision(agent, event, guard);
  } catch (e) {
    process.stderr.write(`[pinta-gemini] error: ${e}\n`);
    out = {}; // DG6 fail-open
  }
  logInvocation({
    ts: new Date().toISOString(),
    pid: process.pid,
    agent,
    event,
    argv: process.argv.slice(2),
    received_payload: ev,
    normalized: c ?? null,
    guard,
    decision_returned: out,
  });
  process.stdout.write(JSON.stringify(out) + "\n"); // DG6: exactly one JSON object
  process.exit(0); // always 0
}

main();
