/**
 * demo-trace.ts — make hook execution + payload delivery fully observable.
 *
 *   1. installs all 3 hosts' configs into a VISIBLE home (default ./.demo-home,
 *      or your real ~/.gemini with --real),
 *   2. fires EVERY event registered in each installed config (not just the gate),
 *      with a representative payload, running the command verbatim from disk,
 *   3. dumps <home>/pinta-gemini-data/invocations.jsonl so you can see, per hook:
 *      argv received, RAW payload delivered, normalized canonical, guard verdict,
 *      and the decision returned.
 *
 * Files are left in place for inspection. Run:
 *   npx tsx tools/demo-trace.ts            # ./.demo-home (safe, inspectable)
 *   npx tsx tools/demo-trace.ts --real     # writes into ~/.gemini (use uninstall after)
 *   npx tsx tools/demo-trace.ts --clean    # remove ./.demo-home and exit
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

const ARGS = process.argv.slice(2);
const REAL = ARGS.includes("--real");
const CLEAN = ARGS.includes("--clean");
const DEMO_HOME = path.join(REPO, ".demo-home");

// ---------------------------------------------------------------------------
// mock collector + guard
// ---------------------------------------------------------------------------
const DANGEROUS = /rm\s+-rf|\bsecret\b|credential|password|AKIA[0-9A-Z]{16}/i;
function startGuard(): Promise<http.Server> {
  const s = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      let deny = false;
      try {
        const { input } = JSON.parse(b);
        deny = DANGEROUS.test(input?.rawTextFields?.toolInput ?? "");
      } catch {}
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify(
          deny
            ? { decision: "DENY", reason: "deny_dangerous_command", userMessage: "⛔ Blocked by Pinta AI — deny_dangerous_command" }
            : { decision: "ALLOW", reason: null, userMessage: null },
        ),
      );
    });
  });
  return new Promise((r) => s.listen(0, () => r(s)));
}
function startCollector(): Promise<{ server: http.Server; count: () => number }> {
  let n = 0;
  const s = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try {
        JSON.parse(b);
        n++;
      } catch {}
      res.writeHead(200).end("{}");
    });
  });
  return new Promise((r) => s.listen(0, () => r({ server: s, count: () => n })));
}

// ---------------------------------------------------------------------------
// representative payload per (agent, event)
// ---------------------------------------------------------------------------
const G = (sid: string, extra: object) => ({ session_id: sid, transcript_path: "/w/.gemini/t.jsonl", cwd: "/w", timestamp: "2026-06-12T00:00:00Z", ...extra });
const A = (sid: string, extra: object) => ({ conversationId: sid, workspacePaths: ["/w"], transcriptPath: "/w/.gemini/antigravity/t.jsonl", artifactDirectoryPath: "/w/.gemini/antigravity/art", ...extra });

interface Shot {
  event: string;
  label: string;
  payload: object;
}
function shotsFor(agent: Agent): Shot[] {
  if (agent === "gemini") {
    return [
      { event: "SessionStart", label: "session begin", payload: G("g1", { hook_event_name: "SessionStart", source: "startup" }) },
      { event: "BeforeAgent", label: "user prompt", payload: G("g1", { hook_event_name: "BeforeAgent", prompt: "list the files" }) },
      { event: "BeforeTool", label: "tool gate (benign)", payload: G("g1", { hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command: "ls -la" } }) },
      { event: "BeforeTool", label: "tool gate (DANGEROUS)", payload: G("g1", { hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command: "rm -rf /" } }) },
      { event: "AfterTool", label: "tool result", payload: G("g1", { hook_event_name: "AfterTool", tool_name: "run_shell_command", tool_input: { command: "ls -la" }, tool_response: { ok: true } }) },
      { event: "AfterAgent", label: "turn end", payload: G("g1", { hook_event_name: "AfterAgent", prompt: "list the files", prompt_response: "done" }) },
      { event: "PreCompress", label: "compaction", payload: G("g1", { hook_event_name: "PreCompress", trigger: "auto" }) },
      { event: "Notification", label: "notification", payload: G("g1", { hook_event_name: "Notification", notification_type: "ToolPermission", message: "needs approval" }) },
      { event: "SessionEnd", label: "session end", payload: G("g1", { hook_event_name: "SessionEnd", reason: "exit" }) },
    ];
  }
  const sid = "a";
  return [
    { event: "PreInvocation", label: "before model call", payload: A(sid, { invocationNum: 1, initialNumSteps: 0 }) },
    { event: "PreToolUse", label: "tool gate (benign)", payload: A(sid, { toolCall: { name: "run_command", args: { CommandLine: "ls", Cwd: "/w" } }, stepIdx: 2 }) },
    { event: "PreToolUse", label: "tool gate (DANGEROUS)", payload: A(sid, { toolCall: { name: "run_command", args: { CommandLine: "cat ~/.aws/credentials" } }, stepIdx: 3 }) },
    { event: "PostToolUse", label: "tool result", payload: A(sid, { stepIdx: 2, error: "" }) },
    { event: "PostInvocation", label: "after tool calls", payload: A(sid, { invocationNum: 1, initialNumSteps: 4 }) },
    { event: "Stop", label: "loop terminates", payload: A(sid, { executionNum: 1, terminationReason: "model_stop", error: "", fullyIdle: true }) },
  ];
}

function readCommand(home: string, agent: Agent, event: string): string | undefined {
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
  for (const d of defs) for (const h of d.hooks ?? [d]) if (typeof h.command === "string" && h.command.includes(ENTRY)) return h.command;
  return undefined;
}

function fire(command: string, payload: object, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function main(): Promise<void> {
  if (CLEAN) {
    fs.rmSync(DEMO_HOME, { recursive: true, force: true });
    console.log(`removed ${DEMO_HOME}`);
    return;
  }
  if (!fs.existsSync(ENTRY)) {
    console.error(`adapter not built: ${ENTRY}\nrun: npm run build`);
    process.exit(1);
  }

  const home = REAL ? path.join(os.homedir(), ".gemini") : DEMO_HOME;
  const dataDir = path.join(home, "pinta-gemini-data");
  const logFile = path.join(dataDir, "invocations.jsonl");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.rmSync(logFile, { force: true }); // fresh log for this run

  const guard = await startGuard();
  const { server: collector, count } = await startCollector();
  const otlp = `http://127.0.0.1:${(collector.address() as any).port}/v1/traces`;
  const guardEndpoint = `http://127.0.0.1:${(guard.address() as any).port}/guard/evaluate`;

  console.log(`home    : ${home}${REAL ? "  (YOUR REAL ~/.gemini)" : ""}`);
  console.log(`adapter : ${ENTRY}\n`);

  // 1. install all 3 hosts
  console.log("── install ──────────────────────────────");
  for (const agent of ["gemini", "antigravity"] as Agent[]) {
    const r = spawnSync("npx", ["--yes", "tsx", INSTALLER, "--agent", agent], { env: { ...process.env, GEMINI_HOME: home }, encoding: "utf-8" });
    console.log("  " + (r.stdout || r.stderr).trim());
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GEMINI_HOME: home,
    GEMINI_PLUGIN_DATA: dataDir,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: otlp,
    PINTA_GUARD_ENDPOINT: guardEndpoint,
    PINTA_RELAY_TOKEN: "test-token",
    PINTA_GEMINI_DEBUG: "1", // turn on the invocation audit log
  };

  // 2. fire every registered event per host
  console.log("\n── fire every registered hook ───────────");
  let fired = 0;
  let missing = 0;
  for (const agent of ["gemini", "antigravity"] as Agent[]) {
    console.log(`\n[${agent}]`);
    for (const shot of shotsFor(agent)) {
      const command = readCommand(home, agent, shot.event);
      if (!command) {
        missing++;
        console.log(`  ✗ ${shot.event.padEnd(16)} no installed command`);
        continue;
      }
      const { code, stdout } = await fire(command, shot.payload, env);
      fired++;
      const decision = stdout.trim();
      console.log(`  ✓ ${shot.event.padEnd(16)} ${shot.label.padEnd(24)} exit=${code}  → ${decision}`);
    }
  }

  await new Promise((r) => setTimeout(r, 50)); // let async OTLP POSTs land
  collector.close();
  guard.close();

  // 3. show the audit log
  console.log(`\n── invocation audit log (${logFile}) ──`);
  const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
  console.log(`${fired} hooks fired, ${lines.length} logged, ${count()} OTLP spans received, ${missing} missing\n`);
  console.log("agent         event            tool/—              guard      returned");
  console.log("─".repeat(82));
  for (const ln of lines) {
    const r = JSON.parse(ln);
    const tool = r.normalized?.tool_name ?? "—";
    const guardV = r.guard ? r.guard.decision : "—";
    const ret = JSON.stringify(r.decision_returned);
    console.log(`${String(r.agent).padEnd(13)} ${String(r.event).padEnd(16)} ${String(tool).padEnd(19)} ${String(guardV).padEnd(10)} ${ret}`);
  }

  // 4. show two FULL records so payload delivery is visible end-to-end
  console.log(`\n── sample full records (RAW payload → normalized → decision) ──`);
  const samples = lines.map((l) => JSON.parse(l)).filter((r) => r.event === "BeforeTool" || (r.agent === "antigravity" && r.event === "PreToolUse"));
  for (const r of samples.slice(0, 2)) {
    console.log("\n" + JSON.stringify({ agent: r.agent, event: r.event, argv: r.argv, received_payload: r.received_payload, normalized: r.normalized, guard: r.guard, decision_returned: r.decision_returned }, null, 2));
  }

  console.log(`\ninspect: cat ${logFile}`);
  console.log(`config : ${home}/extensions/pinta-gemini/hooks/hooks.json , ${home}/config/hooks.json`);
  if (REAL) console.log(`uninstall: for a in gemini antigravity; do GEMINI_HOME=${home} npx tsx tools/install-hooks.ts --agent $a --uninstall; done`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
