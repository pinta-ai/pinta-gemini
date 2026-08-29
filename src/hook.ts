/**
 * pinta-gemini hook body (extracted from the former `src/index.ts` so that
 * BOTH entry points can share it):
 *   - `src/index.ts`  → `dist/index.js`  : direct-exec hook (what the Gemini/
 *     Antigravity host invokes as `node dist/index.js --agent … --event …`).
 *   - `src/index.mts` → `dist/index.mjs` : ESM dual-entry that ALSO exports the
 *     `lifecycle` TranscriptSource for the pinta-manager sidecar's runtime
 *     `import()`, while still running this hook when direct-exec'd.
 *
 * The env-file MUST already be loaded (via `loadEnvFile()`) by the entry point
 * before `runHook()` is called, since `loadConfig()` reads `process.env`.
 */
import { loadConfig } from "./core/config.js";
import { parseInvocation, antigravityProduct } from "./core/agent.js";
import { normalize } from "./core/normalize.js";
import { gateEvent, isGemini, isSkippedHook } from "./core/types.js";
import type { Agent, Canonical, DecisionOutput, RawEvent } from "./core/types.js";
import { evaluateGuard, shellCommandText } from "./core/guard.js";
import type { GuardResult } from "./core/guard.js";
import { Transport } from "./core/transport.js";
import { TraceManager } from "./core/trace.js";
import { buildOtlpPayload } from "./core/otlp.js";
import { formatDecision } from "./core/decision.js";
import { logInvocation } from "./core/invocation-log.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

/** Turn boundary → start a fresh trace. gemini=BeforeAgent, antigravity=first PreInvocation. */
function isTurnStart(agent: Agent, c: Canonical, ev: RawEvent): boolean {
  if (isGemini(agent)) return c.hook === "BeforeAgent";
  return c.hook === "PreInvocation" && ev["invocationNum"] === 1;
}

/** Run the hook end-to-end: read stdin, forward OTLP, emit one JSON, exit 0. */
export async function runHook(): Promise<void> {
  const { agent, event } = parseInvocation();
  let out: DecisionOutput = {};
  let ev: RawEvent = {};
  let c: Canonical | undefined;
  let guard: GuardResult | null = null;
  const config = loadConfig();

  try {
    ev = JSON.parse((await readStdin()) || "{}") as RawEvent;
    c = normalize(agent, event, ev);

    if (!isSkippedHook(c.hook)) {
      const transport = new Transport(config);
      await transport.flush();

      const sessionId = c.session_id ?? "unknown";
      const trace = new TraceManager(config);
      const traceId = isTurnStart(agent, c, ev) ? trace.newTrace(sessionId) : trace.currentTrace(sessionId);

      // Guard only on the host's tool-gate event.
      if (c.hook === gateEvent(agent)) {
        const rawToolInput =
          shellCommandText(c.tool_input) ??
          (typeof c.tool_input === "string" ? c.tool_input : JSON.stringify(c.tool_input ?? null));
        // `cwd` and `hook` are already on the canonical event and were being
        // dropped. `cwd` locates a relative target — `rm -rf passwd` reads as
        // routine work until you know it was issued from /etc (PTA-176) — and
        // the event is what lets the manager trust the tool name, since Claude
        // Code owns those names and neither gemini nor antigravity does
        // (PTA-207).
        guard = await evaluateGuard(
          { spanId: sessionId, toolName: c.tool_name, method: c.hook, cwd: c.cwd, toolInput: c.tool_input, rawTextFields: { toolInput: rawToolInput } },
          config.guardEndpoint,
          config.headers['x-pinta-relay-token'],
        );
      }

      // Decide FIRST — the guard verdict must be locked in before telemetry, so a
      // telemetry failure can never discard an already-obtained DENY.
      out = formatDecision(agent, event, guard);

      const product = isGemini(agent) ? undefined : antigravityProduct(ev);
      // Telemetry send is best-effort; if it throws, the catch preserves `out` below.
      await transport.send(buildOtlpPayload({ agent, canonical: c, event: ev, traceId, guard, product }));
    }
  } catch (e) {
    process.stderr.write(`[pinta-gemini] error: ${e}\n`);
    // Preserve an already-obtained guard decision (esp. DENY); only fail-open when no
    // guard verdict was reached. Telemetry failure must never flip a DENY to ALLOW.
    out = guard ? formatDecision(agent, event, guard) : {};
  }

  logInvocation(config, {
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

  process.stdout.write(JSON.stringify(out) + "\n"); // exactly one JSON object
  process.exit(0); // always 0
}
