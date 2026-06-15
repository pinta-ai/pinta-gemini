/**
 * e2e-hooks.ts — mock-host harness that proves the pinta-gemini adapter behaves
 * correctly across ALL THREE hosts (Gemini CLI, Antigravity 1.0, Antigravity 2.0)
 * for BOTH telemetry forwarding and guard allow/deny.
 *
 * What it does
 * ------------
 * For each fixture it plays the role of the host: spawns the adapter as a child
 * process exactly the way a host would — `node <entry> --agent <a> --event <e>`
 * with the event JSON on stdin — then asserts:
 *   1. the child always exits 0 (fail-open),
 *   2. stdout is EXACTLY one JSON object (Gemini's "silence is mandatory"),
 *   3. the decision JSON matches that host's deny/allow contract,
 *   4. our mock OTLP collector received a span with the right ingest.type, and
 *   5. for tool-gate events, the span carries the guard decision.
 *
 * Mock services (started in-process):
 *   - OTLP collector  : captures every span the adapter forwards.
 *   - Guard endpoint  : DENY for dangerous tool input, ALLOW otherwise — mirrors
 *                       Pinta Manager's /guard/evaluate contract.
 *
 * Running
 * -------
 *   npx tsx tools/e2e-hooks.ts            # uses dist/index.js if present, else --stub
 *   npx tsx tools/e2e-hooks.ts --stub     # force the embedded reference adapter
 *   npx tsx tools/e2e-hooks.ts --entry path/to/index.js
 *   npx tsx tools/e2e-hooks.ts --print-probe   # print the host-side --event arg probe
 *   npx tsx tools/e2e-hooks.ts --keep     # keep the temp stub file for inspection
 *
 * The embedded reference stub implements the DG1–DG10 contract from
 * BACKGROUND_RESEARCH.md, so this file runs green TODAY and serves as the
 * executable spec the real adapter must satisfy.
 */
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// CLI args for the harness itself
// ---------------------------------------------------------------------------
const ARGS = process.argv.slice(2);
const FORCE_STUB = ARGS.includes("--stub");
const KEEP = ARGS.includes("--keep");
const PRINT_PROBE = ARGS.includes("--print-probe");
const ENTRY_FLAG = (() => {
  const i = ARGS.indexOf("--entry");
  return i >= 0 ? ARGS[i + 1] : undefined;
})();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const DIST_ENTRY = path.join(REPO, "dist", "index.js");

// ---------------------------------------------------------------------------
// Host-side --event arg probe (DG1). Cannot be automated without the real host
// binary; print the exact hooks.json to install for a manual one-time check.
// ---------------------------------------------------------------------------
function printProbe(): void {
  const probe = {
    "pinta-gemini-probe": {
      PreToolUse: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              // If args survive, /tmp/pinta-probe will contain "--event PreToolUse".
              command: `sh -c 'echo "$@" >> /tmp/pinta-probe' _ --event PreToolUse`,
            },
          ],
        },
      ],
    },
  };
  console.log(
    "# DG1 probe — install this in the host's hooks.json, trigger a tool call,\n" +
      "# then `cat /tmp/pinta-probe`. Seeing `--event PreToolUse` confirms args are\n" +
      "# preserved → --event is the sole event-identification mechanism.\n",
  );
  console.log(JSON.stringify(probe, null, 2));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Agent = "gemini" | "antigravity1" | "antigravity2";
interface OtlpAttr {
  key: string;
  value: Record<string, unknown>;
}
interface CapturedSpan {
  name: string;
  ingestType?: string;
  serviceName?: string;
  sessionId?: string;
  guardDecision?: string;
  attrs: Record<string, string>;
}

interface Fixture {
  label: string;
  agent: Agent;
  event: string;
  gate: boolean; // tool-gate event → guard runs
  decision: "allow" | "deny";
  sessionId: string;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Mock OTLP collector — captures spans keyed by session id
// ---------------------------------------------------------------------------
const captured: CapturedSpan[] = [];

function flattenAttrs(attrs: OtlpAttr[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of attrs ?? []) {
    const v = a.value ?? {};
    const val =
      (v as any).stringValue ??
      (v as any).intValue ??
      (v as any).boolValue ??
      (v as any).doubleValue;
    out[a.key] = String(val);
  }
  return out;
}

function startCollector(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body);
        for (const rs of payload.resourceSpans ?? []) {
          const rattrs = flattenAttrs(rs.resource?.attributes);
          for (const ss of rs.scopeSpans ?? []) {
            for (const span of ss.spans ?? []) {
              const sattrs = flattenAttrs(span.attributes);
              captured.push({
                name: span.name,
                ingestType: sattrs["ingest.type"],
                serviceName: rattrs["service.name"],
                sessionId: sattrs["gemini.session_id"] ?? sattrs["antigravity.session_id"],
                guardDecision: sattrs["pinta.guard.decision"],
                attrs: { ...rattrs, ...sattrs },
              });
            }
          }
        }
      } catch {
        /* ignore malformed */
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

// ---------------------------------------------------------------------------
// Mock guard endpoint — DENY dangerous input, ALLOW otherwise
// ---------------------------------------------------------------------------
const DANGEROUS = /rm\s+-rf|\bsecret\b|credential|password|AKIA[0-9A-Z]{16}/i;

function startGuard(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let deny = false;
      try {
        const { input } = JSON.parse(body);
        const raw = input?.rawTextFields?.toolInput ?? JSON.stringify(input?.toolInput ?? "");
        deny = DANGEROUS.test(raw);
      } catch {
        /* fail-open */
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          deny
            ? {
                decision: "DENY",
                reason: "deny_dangerous_command",
                userMessage: "⛔ Blocked by Pinta AI — deny_dangerous_command",
                durationMs: 3,
              }
            : { decision: "ALLOW", reason: null, userMessage: null, durationMs: 2 },
        ),
      );
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

// ---------------------------------------------------------------------------
// Embedded reference adapter (the executable spec). Written to a temp .mjs and
// spawned exactly like the real dist/index.js. Implements DG1–DG10.
// ---------------------------------------------------------------------------
const STUB_SOURCE = String.raw`
// pinta-gemini REFERENCE STUB — mirrors the planned adapter contract.
const GATE = { gemini: "BeforeTool", antigravity1: "PreToolUse", antigravity2: "PreToolUse" };

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf-8");
}
// DG2 — normalize host payload (snake gemini / camel antigravity) → canonical
function normalize(agent, event, ev) {
  if (agent === "gemini") {
    return {
      hook: event || ev.hook_event_name,
      session_id: ev.session_id,
      cwd: ev.cwd,
      tool_name: ev.tool_name,
      tool_input: ev.tool_input,
    };
  }
  // antigravity1 / antigravity2 (camelCase, no event name in payload)
  return {
    hook: event,
    session_id: ev.conversationId,
    cwd: Array.isArray(ev.workspacePaths) ? ev.workspacePaths[0] : undefined,
    tool_name: ev.toolCall && ev.toolCall.name,
    tool_input: ev.toolCall && ev.toolCall.args,
  };
}
async function guardEval(c) {
  const endpoint = process.env.PINTA_GUARD_ENDPOINT;
  if (!endpoint) return null;
  const raw = typeof c.tool_input === "string" ? c.tool_input : JSON.stringify(c.tool_input ?? null);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pinta-relay-token": process.env.PINTA_RELAY_TOKEN || "" },
      body: JSON.stringify({ input: { spanId: c.session_id || "unknown", toolName: c.tool_name, toolInput: c.tool_input, rawTextFields: { toolInput: raw } } }),
    });
    if (res.status !== 200) return { decision: "ALLOW", reason: null, userMessage: null };
    return await res.json();
  } catch {
    return { decision: "ALLOW", reason: null, userMessage: null }; // fail-open
  }
}
function resolveEndpoint() {
  const t = process.env.GEMINI_PLUGIN_OPTION_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (t) return t.replace(/\/+$/, "");
  const b = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (b) return b.replace(/\/+$/, "") + "/v1/traces";
  return undefined;
}
// DG3 — agent-specific Bronze prefix / ingest.type / service.name
function ident(agent) {
  return agent === "gemini"
    ? { prefix: "gemini", ingest: "gemini", service: "gemini-cli" }
    : { prefix: "antigravity", ingest: "antigravity", service: "antigravity-cli" };
}
function snake(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
async function forward(agent, c, ev, guard) {
  const endpoint = resolveEndpoint();
  if (!endpoint) return;
  const id = ident(agent);
  const attrs = [
    { key: "ingest.type", value: { stringValue: id.ingest } },
    { key: id.prefix + ".hook", value: { stringValue: c.hook } },
  ];
  if (c.session_id) attrs.push({ key: id.prefix + ".session_id", value: { stringValue: String(c.session_id) } });
  if (c.tool_name) attrs.push({ key: id.prefix + ".tool_name", value: { stringValue: String(c.tool_name) } });
  if (guard) {
    attrs.push({ key: "pinta.guard.decision", value: { stringValue: String(guard.decision).toLowerCase() } });
    if (guard.reason) attrs.push({ key: "pinta.guard.matched_rule", value: { stringValue: String(guard.reason) } });
  }
  const payload = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: id.service } }] },
        scopeSpans: [{ scope: { name: "pinta-gemini", version: "0.0.0" }, spans: [{ name: id.ingest + "." + snake(c.hook || "unknown"), attributes: attrs }] }],
      },
    ],
  };
  try {
    await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  } catch (e) {
    process.stderr.write("[pinta-gemini] forward failed: " + e + "\n");
  }
}
// DG5 — host-aware decision output
function formatDecision(agent, event, guard) {
  if (guard && guard.decision === "DENY") {
    const reason = guard.userMessage || guard.reason || "guard_deny";
    if (agent === "gemini") return { decision: "deny", reason, systemMessage: guard.userMessage || undefined };
    return { decision: "deny", reason }; // antigravity
  }
  // allow
  if (agent !== "gemini" && event === "PreToolUse") return { decision: "allow" }; // antigravity PreToolUse: decision required
  return {}; // gemini, and antigravity non-gate
}
(async () => {
  let out = {};
  try {
    const agent = arg("--agent");
    const event = arg("--event");
    const ev = JSON.parse((await readStdin()) || "{}");
    const c = normalize(agent, event, ev);
    let guard = null;
    if (c.hook === GATE[agent]) guard = await guardEval(c);
    await forward(agent, c, ev, guard);
    out = formatDecision(agent, event, guard);
  } catch (e) {
    process.stderr.write("[pinta-gemini] error: " + e + "\n");
    out = {}; // DG6 fail-open
  }
  process.stdout.write(JSON.stringify(out) + "\n"); // DG6: always exactly one JSON
  process.exit(0); // always 0
})();
`;

function writeStub(): string {
  const p = path.join(os.tmpdir(), `pinta-gemini-stub-${process.pid}.mjs`);
  fs.writeFileSync(p, STUB_SOURCE);
  return p;
}

// ---------------------------------------------------------------------------
// Fixtures — 3 hosts × {allow, deny} on the gate event + one telemetry-only event per family
// ---------------------------------------------------------------------------
const COMMON_GEMINI = (sid: string) => ({
  session_id: sid,
  transcript_path: "/w/.gemini/transcript.jsonl",
  cwd: "/w",
  timestamp: "2026-06-12T00:00:00Z",
});
const COMMON_ANTIGRAVITY = (sid: string) => ({
  conversationId: sid,
  workspacePaths: ["/w"],
  transcriptPath: "/w/.gemini/antigravity/transcript.jsonl",
  artifactDirectoryPath: "/w/.gemini/antigravity/artifacts",
});

const FIXTURES: Fixture[] = [
  // ---- Gemini CLI (snake_case, hook_event_name in payload) ----
  {
    label: "gemini BeforeTool — benign → allow",
    agent: "gemini",
    event: "BeforeTool",
    gate: true,
    decision: "allow",
    sessionId: "g-allow",
    payload: { ...COMMON_GEMINI("g-allow"), hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command: "ls -la" } },
  },
  {
    label: "gemini BeforeTool — `rm -rf /` → deny",
    agent: "gemini",
    event: "BeforeTool",
    gate: true,
    decision: "deny",
    sessionId: "g-deny",
    payload: { ...COMMON_GEMINI("g-deny"), hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command: "rm -rf /" } },
  },
  {
    label: "gemini AfterTool — telemetry only",
    agent: "gemini",
    event: "AfterTool",
    gate: false,
    decision: "allow",
    sessionId: "g-after",
    payload: { ...COMMON_GEMINI("g-after"), hook_event_name: "AfterTool", tool_name: "run_shell_command", tool_input: { command: "ls" }, tool_response: { ok: true } },
  },

  // ---- Antigravity 2.0 (camelCase, no event name → --event arg) ----
  {
    label: "antigravity2 PreToolUse — benign → allow",
    agent: "antigravity2",
    event: "PreToolUse",
    gate: true,
    decision: "allow",
    sessionId: "a2-allow",
    payload: { ...COMMON_ANTIGRAVITY("a2-allow"), toolCall: { name: "run_command", args: { CommandLine: "ls", Cwd: "/w" } }, stepIdx: 3 },
  },
  {
    label: "antigravity2 PreToolUse — `rm -rf /` → deny",
    agent: "antigravity2",
    event: "PreToolUse",
    gate: true,
    decision: "deny",
    sessionId: "a2-deny",
    payload: { ...COMMON_ANTIGRAVITY("a2-deny"), toolCall: { name: "run_command", args: { CommandLine: "rm -rf /", Cwd: "/w" } }, stepIdx: 9 },
  },
  {
    label: "antigravity2 PostInvocation — telemetry only",
    agent: "antigravity2",
    event: "PostInvocation",
    gate: false,
    decision: "allow",
    sessionId: "a2-post",
    payload: { ...COMMON_ANTIGRAVITY("a2-post"), invocationNum: 3, initialNumSteps: 10 },
  },

  // ---- Antigravity 1.0 (assumed == 2.0 I/O; same gate path) ----
  {
    label: "antigravity1 PreToolUse — benign → allow",
    agent: "antigravity1",
    event: "PreToolUse",
    gate: true,
    decision: "allow",
    sessionId: "a1-allow",
    payload: { ...COMMON_ANTIGRAVITY("a1-allow"), toolCall: { name: "run_command", args: { CommandLine: "echo hi" } }, stepIdx: 1 },
  },
  {
    label: "antigravity1 PreToolUse — credentials → deny",
    agent: "antigravity1",
    event: "PreToolUse",
    gate: true,
    decision: "deny",
    sessionId: "a1-deny",
    payload: { ...COMMON_ANTIGRAVITY("a1-deny"), toolCall: { name: "run_command", args: { CommandLine: "cat ~/.aws/credentials" } }, stepIdx: 2 },
  },
];

// ---------------------------------------------------------------------------
// Runner + assertions
// ---------------------------------------------------------------------------
interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runAdapter(entry: string, fx: Fixture, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("node", [entry, "--agent", fx.agent, "--event", fx.event], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
    child.stdin.write(JSON.stringify(fx.payload));
    child.stdin.end();
  });
}

interface Check {
  ok: boolean;
  msg: string;
}

function assertCase(fx: Fixture, r: RunResult): Check[] {
  const checks: Check[] = [];
  const push = (ok: boolean, msg: string) => checks.push({ ok, msg });

  // 1. always exit 0
  push(r.exitCode === 0, `exit 0 (got ${r.exitCode})`);

  // 2. stdout is exactly one JSON object
  let out: any = null;
  let parsed = false;
  try {
    const trimmed = r.stdout.trim();
    out = JSON.parse(trimmed);
    parsed = typeof out === "object" && out !== null && !Array.isArray(out);
  } catch {
    /* parsed stays false */
  }
  push(parsed, `stdout is one JSON object (got ${JSON.stringify(r.stdout.slice(0, 80))})`);
  if (!parsed) return checks;

  // 3. decision contract per host
  if (fx.decision === "deny") {
    push(out.decision === "deny", `decision === "deny" (got ${out.decision})`);
    push(typeof out.reason === "string" && /Pinta|deny/i.test(out.reason), `reason carries deny message (got ${JSON.stringify(out.reason)})`);
    if (fx.agent === "gemini") {
      push(typeof out.systemMessage === "string" && out.systemMessage.length > 0, `gemini deny has systemMessage`);
    } else {
      push(!("systemMessage" in out), `antigravity deny omits systemMessage`);
    }
  } else {
    // allow
    if (fx.agent !== "gemini" && fx.event === "PreToolUse") {
      push(out.decision === "allow", `antigravity PreToolUse allow → {decision:"allow"} (got ${JSON.stringify(out)})`);
    } else {
      push(Object.keys(out).length === 0, `allow → {} empty object (got ${JSON.stringify(out)})`);
    }
  }

  // 4. OTLP span captured with right identity
  const spans = captured.filter((s) => s.sessionId === fx.sessionId);
  push(spans.length >= 1, `>=1 span forwarded for session ${fx.sessionId} (got ${spans.length})`);
  if (spans.length) {
    const expectedIngest = fx.agent === "gemini" ? "gemini" : "antigravity";
    const expectedService = fx.agent === "gemini" ? "gemini-cli" : "antigravity-cli";
    push(spans.every((s) => s.ingestType === expectedIngest), `ingest.type === "${expectedIngest}"`);
    push(spans.every((s) => s.serviceName === expectedService), `service.name === "${expectedService}"`);

    // 5. gate events carry the guard decision; non-gate events do not
    if (fx.gate) {
      const want = fx.decision; // allow|deny
      push(spans.some((s) => s.guardDecision === want), `span pinta.guard.decision === "${want}"`);
    } else {
      push(spans.every((s) => s.guardDecision === undefined), `non-gate span has no guard decision`);
    }
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  if (PRINT_PROBE) {
    printProbe();
    return;
  }

  const collector = await startCollector();
  const guard = await startGuard();
  const collectorPort = (collector.address() as any).port;
  const guardPort = (guard.address() as any).port;
  const otlpEndpoint = `http://127.0.0.1:${collectorPort}/v1/traces`;
  const guardEndpoint = `http://127.0.0.1:${guardPort}/guard/evaluate`;

  // Resolve adapter entry: explicit flag > dist (if present & not forced stub) > embedded stub
  let entry: string;
  let usingStub = false;
  let stubPath: string | undefined;
  if (ENTRY_FLAG) {
    entry = path.resolve(ENTRY_FLAG);
  } else if (!FORCE_STUB && fs.existsSync(DIST_ENTRY)) {
    entry = DIST_ENTRY;
  } else {
    stubPath = writeStub();
    entry = stubPath;
    usingStub = true;
  }

  console.log(`pinta-gemini e2e-hooks`);
  console.log(`  adapter   : ${entry}${usingStub ? "  (embedded reference stub)" : ""}`);
  console.log(`  collector : ${otlpEndpoint}`);
  console.log(`  guard     : ${guardEndpoint}`);
  console.log("");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: otlpEndpoint,
    GEMINI_PLUGIN_OPTION_ENDPOINT: otlpEndpoint,
    PINTA_GUARD_ENDPOINT: guardEndpoint,
    PINTA_RELAY_TOKEN: "test-token",
    GEMINI_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), "pinta-gemini-data-")),
  };

  let totalChecks = 0;
  let failedChecks = 0;
  let failedCases = 0;

  for (const fx of FIXTURES) {
    const r = await runAdapter(entry, fx, env);
    // give the collector a tick to ingest the async POST
    await new Promise((res) => setTimeout(res, 30));
    const checks = assertCase(fx, r);
    const caseFailed = checks.some((c) => !c.ok);
    if (caseFailed) failedCases++;
    console.log(`${caseFailed ? "✗" : "✓"} ${fx.label}`);
    for (const c of checks) {
      totalChecks++;
      if (!c.ok) {
        failedChecks++;
        console.log(`    ✗ ${c.msg}`);
      }
    }
    if (caseFailed && r.stderr.trim()) {
      console.log(`    stderr: ${r.stderr.trim().split("\n").join(" | ")}`);
    }
  }

  console.log("");
  console.log(
    `${failedCases === 0 ? "PASS" : "FAIL"} — ${FIXTURES.length - failedCases}/${FIXTURES.length} cases, ` +
      `${totalChecks - failedChecks}/${totalChecks} checks`,
  );

  collector.close();
  guard.close();
  if (stubPath && !KEEP) fs.rmSync(stubPath, { force: true });
  else if (stubPath) console.log(`\n(stub kept: ${stubPath})`);

  process.exit(failedCases === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
