/**
 * pinta-gemini — unified OTLP forwarder + guard adapter for Gemini CLI and
 * Antigravity (agy v1.0.x / 2.0). Entry point (SPEC §4, §5).
 *
 * Host runs: `node dist/index.js --agent <a> --event <e>` with event JSON on
 * stdin. We normalize, (gate-event) consult guard, forward an OTLP span, and
 * emit a host-appropriate allow/deny on stdout. ALWAYS one JSON, ALWAYS exit 0.
 */
import { loadEnvFile } from "./env-file.js";
loadEnvFile(); // must run before config reads process.env

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

async function main(): Promise<void> {
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
        guard = await evaluateGuard(
          { spanId: sessionId, toolName: c.tool_name, toolInput: c.tool_input, rawTextFields: { toolInput: rawToolInput } },
          config.guardEndpoint,
          config.headers['x-pinta-relay-token'],
        );
      }

      const product = isGemini(agent) ? undefined : antigravityProduct(ev);
      await transport.send(buildOtlpPayload({ agent, canonical: c, event: ev, traceId, guard, product }));
      out = formatDecision(agent, event, guard);
    }
  } catch (e) {
    process.stderr.write(`[pinta-gemini] error: ${e}\n`);
    out = {}; // fail-open
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

main();
