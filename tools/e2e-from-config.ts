/**
 * e2e-from-config.ts — the REAL end-to-end test.
 *
 * Unlike e2e-hooks.ts (which hardcodes `node entry --agent --event`), this harness:
 *   1. creates a sandbox GEMINI_HOME (never touches your real ~/.gemini),
 *   2. runs `install-hooks --agent <a>` for all three hosts → writes real config files,
 *   3. reads each host's config back from disk, extracts the EXACT command string,
 *   4. executes that command verbatim via `sh -c` with the event JSON on stdin —
 *      exactly how the host fires a hook,
 *   5. asserts the adapter's decision output + the OTLP span + the guard decision.
 *
 * This proves install-hooks, the on-disk config format, the --event arg mechanism,
 * and the adapter all line up — for Gemini CLI, Antigravity 1.0, and Antigravity 2.0.
 *
 * Run:  npx tsx tools/e2e-from-config.ts
 */
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

type Agent = "gemini" | "antigravity";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const ENTRY = path.join(REPO, "dist", "index.js");
const INSTALLER = path.join(HERE, "install-hooks.ts");

// ---------------------------------------------------------------------------
// Mock OTLP collector + guard (same contract as e2e-hooks.ts)
// ---------------------------------------------------------------------------
interface CapturedSpan {
  ingestType?: string;
  serviceName?: string;
  sessionId?: string;
  guardDecision?: string;
}
const captured: CapturedSpan[] = [];

function flat(attrs: any[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of attrs ?? []) {
    const v = a.value ?? {};
    out[a.key] = String(v.stringValue ?? v.intValue ?? v.boolValue ?? v.doubleValue);
  }
  return out;
}

function startCollector(): Promise<http.Server> {
  const s = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const p = JSON.parse(body);
        for (const rs of p.resourceSpans ?? []) {
          const r = flat(rs.resource?.attributes);
          for (const ss of rs.scopeSpans ?? []) {
            for (const span of ss.spans ?? []) {
              const a = flat(span.attributes);
              captured.push({
                ingestType: a["ingest.type"],
                serviceName: r["service.name"],
                sessionId: a["gemini.session_id"] ?? a["antigravity.session_id"],
                guardDecision: a["pinta.guard.decision"],
              });
            }
          }
        }
      } catch {
        /* ignore */
      }
      res.writeHead(200).end("{}");
    });
  });
  return new Promise((r) => s.listen(0, () => r(s)));
}

const DANGEROUS = /rm\s+-rf|\bsecret\b|credential|password|AKIA[0-9A-Z]{16}/i;
function startGuard(): Promise<http.Server> {
  const s = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let deny = false;
      try {
        const { input } = JSON.parse(body);
        deny = DANGEROUS.test(input?.rawTextFields?.toolInput ?? JSON.stringify(input?.toolInput ?? ""));
      } catch {
        /* fail-open */
      }
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify(
          deny
            ? { decision: "DENY", reason: "deny_dangerous_command", userMessage: "⛔ Blocked by Pinta AI — deny_dangerous_command", durationMs: 3 }
            : { decision: "ALLOW", reason: null, userMessage: null, durationMs: 2 },
        ),
      );
    });
  });
  return new Promise((r) => s.listen(0, () => r(s)));
}

// ---------------------------------------------------------------------------
// Read the command string for a (agent, event) back out of the installed config
// ---------------------------------------------------------------------------
function readInstalledCommand(home: string, agent: Agent, event: string): string | undefined {
  let file: string;
  if (agent === "gemini") file = path.join(home, "extensions", "pinta-gemini", "hooks", "hooks.json");
  else file = path.join(home, "config", "hooks.json");

  let cfg: any;
  try {
    cfg = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }

  const defs = agent === "gemini" ? cfg?.hooks?.[event] : cfg?.["pinta-gemini"]?.[event];
  if (!Array.isArray(defs)) return undefined;
  for (const def of defs) {
    for (const h of def.hooks ?? [def]) {
      if (typeof h.command === "string" && h.command.includes(ENTRY)) return h.command;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Fire a hook by running the installed command verbatim, host-style
// ---------------------------------------------------------------------------
interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  command: string;
}
function fireHook(command: string, payload: object, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr, command }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Fixtures (gate event + one telemetry event per host)
// ---------------------------------------------------------------------------
const G = (sid: string) => ({ session_id: sid, transcript_path: "/w/.gemini/t.jsonl", cwd: "/w", timestamp: "2026-06-12T00:00:00Z" });
const A = (sid: string) => ({ conversationId: sid, workspacePaths: ["/w"], transcriptPath: "/w/.gemini/antigravity/t.jsonl", artifactDirectoryPath: "/w/.gemini/antigravity/art" });

interface Fixture {
  label: string;
  agent: Agent;
  event: string;
  gate: boolean;
  decision: "allow" | "deny";
  sessionId: string;
  payload: object;
}
const FIXTURES: Fixture[] = [
  { label: "gemini BeforeTool — benign → allow", agent: "gemini", event: "BeforeTool", gate: true, decision: "allow", sessionId: "g-allow", payload: { ...G("g-allow"), hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command: "ls -la" } } },
  { label: "gemini BeforeTool — rm -rf / → deny", agent: "gemini", event: "BeforeTool", gate: true, decision: "deny", sessionId: "g-deny", payload: { ...G("g-deny"), hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command: "rm -rf /" } } },
  { label: "gemini AfterTool — telemetry only", agent: "gemini", event: "AfterTool", gate: false, decision: "allow", sessionId: "g-after", payload: { ...G("g-after"), hook_event_name: "AfterTool", tool_name: "run_shell_command", tool_input: { command: "ls" }, tool_response: { ok: true } } },

  { label: "antigravity2 PreToolUse — benign → allow", agent: "antigravity", event: "PreToolUse", gate: true, decision: "allow", sessionId: "a2-allow", payload: { ...A("a2-allow"), toolCall: { name: "run_command", args: { CommandLine: "ls", Cwd: "/w" } }, stepIdx: 3 } },
  { label: "antigravity2 PreToolUse — rm -rf / → deny", agent: "antigravity", event: "PreToolUse", gate: true, decision: "deny", sessionId: "a2-deny", payload: { ...A("a2-deny"), toolCall: { name: "run_command", args: { CommandLine: "rm -rf /", Cwd: "/w" } }, stepIdx: 9 } },
  { label: "antigravity2 PostInvocation — telemetry only", agent: "antigravity", event: "PostInvocation", gate: false, decision: "allow", sessionId: "a2-post", payload: { ...A("a2-post"), invocationNum: 3, initialNumSteps: 10 } },

  { label: "antigravity1 PreToolUse — benign → allow", agent: "antigravity", event: "PreToolUse", gate: true, decision: "allow", sessionId: "a1-allow", payload: { ...A("a1-allow"), toolCall: { name: "run_command", args: { CommandLine: "echo hi" } }, stepIdx: 1 } },
  { label: "antigravity1 PreToolUse — credentials → deny", agent: "antigravity", event: "PreToolUse", gate: true, decision: "deny", sessionId: "a1-deny", payload: { ...A("a1-deny"), toolCall: { name: "run_command", args: { CommandLine: "cat ~/.aws/credentials" } }, stepIdx: 2 } },
];

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
interface Check {
  ok: boolean;
  msg: string;
}
function assertCase(fx: Fixture, r: RunResult): Check[] {
  const checks: Check[] = [];
  const push = (ok: boolean, msg: string) => checks.push({ ok, msg });

  push(r.command.includes(`--agent ${fx.agent}`) && r.command.includes(`--event ${fx.event}`), `installed command carries --agent/--event`);
  push(r.exitCode === 0, `exit 0 (got ${r.exitCode})`);

  let out: any = null;
  let parsed = false;
  try {
    out = JSON.parse(r.stdout.trim());
    parsed = typeof out === "object" && out !== null && !Array.isArray(out);
  } catch {
    /* */
  }
  push(parsed, `stdout is one JSON object (got ${JSON.stringify(r.stdout.slice(0, 80))})`);
  if (!parsed) return checks;

  if (fx.decision === "deny") {
    push(out.decision === "deny", `decision === "deny"`);
    push(typeof out.reason === "string" && /Pinta|deny/i.test(out.reason), `reason carries deny message`);
    if (fx.agent === "gemini") push(typeof out.systemMessage === "string" && out.systemMessage.length > 0, `gemini deny has systemMessage`);
    else push(!("systemMessage" in out), `antigravity deny omits systemMessage`);
  } else if (fx.agent !== "gemini" && fx.event === "PreToolUse") {
    push(out.decision === "allow", `antigravity PreToolUse allow → {decision:"allow"}`);
  } else {
    push(Object.keys(out).length === 0, `allow → {} (got ${JSON.stringify(out)})`);
  }

  const spans = captured.filter((s) => s.sessionId === fx.sessionId);
  push(spans.length >= 1, `>=1 span forwarded (got ${spans.length})`);
  if (spans.length) {
    const ingest = fx.agent === "gemini" ? "gemini" : "antigravity";
    const service = fx.agent === "gemini" ? "gemini-cli" : "antigravity-cli";
    push(spans.every((s) => s.ingestType === ingest), `ingest.type === "${ingest}"`);
    push(spans.every((s) => s.serviceName === service), `service.name === "${service}"`);
    if (fx.gate) push(spans.some((s) => s.guardDecision === fx.decision), `span pinta.guard.decision === "${fx.decision}"`);
    else push(spans.every((s) => s.guardDecision === undefined), `non-gate span has no guard decision`);
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  if (!fs.existsSync(ENTRY)) {
    console.error(`adapter not built: ${ENTRY}\nrun: npm run build`);
    process.exit(1);
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pinta-gemini-home-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pinta-gemini-data-"));
  const collector = await startCollector();
  const guard = await startGuard();
  const otlp = `http://127.0.0.1:${(collector.address() as any).port}/v1/traces`;
  const guardEndpoint = `http://127.0.0.1:${(guard.address() as any).port}/guard/evaluate`;

  console.log("pinta-gemini e2e-from-config");
  console.log(`  GEMINI_HOME : ${home}`);
  console.log(`  adapter     : ${ENTRY}`);
  console.log(`  collector   : ${otlp}`);
  console.log(`  guard       : ${guardEndpoint}\n`);

  // 1. install all three hosts' configs into the sandbox home
  console.log("→ applying host hook configs (install-hooks):");
  for (const agent of ["gemini", "antigravity"] as Agent[]) {
    const res = spawnSync("npx", ["--yes", "tsx", INSTALLER, "--agent", agent], {
      env: { ...process.env, GEMINI_HOME: home },
      encoding: "utf-8",
    });
    process.stdout.write("  " + (res.stdout || res.stderr).trim().split("\n").join("\n  ") + "\n");
  }
  console.log("");

  // env the host would pass to the hook subprocess
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GEMINI_HOME: home,
    GEMINI_PLUGIN_DATA: dataDir,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: otlp,
    PINTA_GUARD_ENDPOINT: guardEndpoint,
    PINTA_RELAY_TOKEN: "test-token",
  };

  // 2-5. fire each fixture using the command read back from the installed config
  let failedCases = 0;
  let totalChecks = 0;
  let failedChecks = 0;
  for (const fx of FIXTURES) {
    const command = readInstalledCommand(home, fx.agent, fx.event);
    if (!command) {
      failedCases++;
      console.log(`✗ ${fx.label}\n    ✗ no installed command found for ${fx.agent}/${fx.event}`);
      continue;
    }
    const r = await fireHook(command, fx.payload, env);
    await new Promise((res) => setTimeout(res, 30)); // let the async OTLP POST land
    const checks = assertCase(fx, r);
    const bad = checks.some((c) => !c.ok);
    if (bad) failedCases++;
    console.log(`${bad ? "✗" : "✓"} ${fx.label}`);
    for (const c of checks) {
      totalChecks++;
      if (!c.ok) {
        failedChecks++;
        console.log(`    ✗ ${c.msg}`);
      }
    }
    if (bad && r.stderr.trim()) console.log(`    stderr: ${r.stderr.trim().split("\n").join(" | ")}`);
  }

  console.log("");
  console.log(`${failedCases === 0 ? "PASS" : "FAIL"} — ${FIXTURES.length - failedCases}/${FIXTURES.length} cases, ${totalChecks - failedChecks}/${totalChecks} checks`);

  collector.close();
  guard.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(failedCases === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
