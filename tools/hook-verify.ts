/**
 * hook-verify.ts — REAL-host hook verification watcher.
 *
 * You run the actual CLIs (gemini-cli / antigravity-cli (agy) / antigravity 2.0);
 * this installs our hooks into your real ~/.gemini, injects a debug env so the
 * adapter records every invocation to a jsonl, then TAILS that jsonl and scores
 * the BACKGROUND_RESEARCH hypotheses live.
 *
 * Corrected install model (from 2026-06-15 real-host findings):
 *   gemini          → ~/.gemini/extensions/pinta-gemini/  (EXTENSION — bypasses the
 *                     folder-trust gate that skips settings.json hooks; restart gemini)
 *   antigravity-cli → ~/.gemini/config/hooks.json         (agy v1.0.x; confirmed read path)
 *   antigravity2    → <workspace>/.agents/hooks.json      (needs --workspace DIR)
 *
 * Subcommands: watch (default) | teardown | report | selftest
 *   npx tsx tools/hook-verify.ts [--workspace DIR]
 *   npx tsx tools/hook-verify.ts selftest
 *   npx tsx tools/hook-verify.ts teardown [--workspace DIR]
 */
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const ENTRY = path.join(REPO, "dist", "index.js");
const INSTALLER = path.join(HERE, "install-hooks.ts");

// One `antigravity` profile covers both agy v1.0.x and Antigravity 2.0 — they
// read the SAME global ~/.gemini/config/hooks.json with the same camelCase
// protocol, so they're indistinguishable by config file (and don't need to be).
type Agent = "gemini" | "antigravity";
const ALL_AGENTS: Agent[] = ["gemini", "antigravity"];
const family = (a: Agent): "gemini" | "antigravity" => (a === "gemini" ? "gemini" : "antigravity");
const GATE = (a: Agent): string => (a === "gemini" ? "BeforeTool" : "PreToolUse");

const REAL_HOME = process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
const ENV_FILE = (home: string) => path.join(home, "pinta-gemini.env");
const DATA_DIR = (home: string) => path.join(home, "pinta-gemini-data");
const LOG_FILE = (home: string) => path.join(DATA_DIR(home), "invocations.jsonl");

const EXPECTED: Record<Agent, string[]> = {
  gemini: ["SessionStart", "BeforeAgent", "BeforeTool", "AfterTool", "AfterAgent", "PreCompress", "Notification", "SessionEnd"],
  antigravity: ["PreInvocation", "PreToolUse", "PostToolUse", "PostInvocation", "Stop"],
};

interface Rec {
  ts: string;
  agent: Agent;
  event?: string;
  argv: string[];
  received_payload: Record<string, unknown>;
  normalized: { hook: string; session_id?: string; cwd?: string; tool_name?: string; tool_input?: unknown } | null;
  guard: { decision: string; reason: string | null; userMessage: string | null } | null;
  decision_returned: Record<string, unknown>;
}

// ===========================================================================
// SCORER (label-agnostic, per exercised host)
// ===========================================================================
interface HypStatus {
  id: string;
  title: string;
  kind: "critical" | "info" | "manual";
  status: "pass" | "fail" | "pending";
  detail: string;
}

function score(recs: Rec[]): { hyps: HypStatus[]; coverage: Record<Agent, { seen: string[]; missing: string[] }>; denials: Rec[] } {
  const hyps: HypStatus[] = [];
  const hosts = [...new Set(recs.map((r) => r.agent))] as Agent[];

  for (const a of ALL_AGENTS) {
    const rs = recs.filter((r) => r.agent === a);
    const exercised = rs.length > 0;

    // H1 — --event/--agent args preserved by the host (DG1, the critical unknown)
    if (!exercised) {
      hyps.push({ id: `H1.${a}`, title: `[${a}] --event/--agent args preserved`, kind: "critical", status: "pending", detail: "not exercised yet" });
    } else {
      const good = rs.find((r) => Array.isArray(r.argv) && r.argv.includes("--event") && r.argv.includes("--agent") && r.normalized?.hook === r.argv[r.argv.indexOf("--event") + 1]);
      hyps.push(good
        ? { id: `H1.${a}`, title: `[${a}] --event/--agent args preserved`, kind: "critical", status: "pass", detail: `argv=${JSON.stringify(good.argv)}` }
        : { id: `H1.${a}`, title: `[${a}] --event/--agent args preserved`, kind: "critical", status: "fail", detail: `host stripped args — argv=${JSON.stringify(rs[0].argv)} → enable payload-shape fallback` });
    }
    if (!exercised) continue;

    // H2 — payload shape matches the family
    const sample = rs[0].received_payload;
    if (family(a) === "gemini") {
      const ok = "hook_event_name" in sample && "session_id" in sample;
      hyps.push({ id: `H2.${a}`, title: `[${a}] snake_case payload w/ hook_event_name`, kind: "critical", status: ok ? "pass" : "fail", detail: ok ? `keys: ${Object.keys(sample).slice(0, 6).join(",")}…` : `got ${Object.keys(sample).join(",")}` });
    } else {
      const ok = "conversationId" in sample && "workspacePaths" in sample && !("hook_event_name" in sample);
      hyps.push({ id: `H2.${a}`, title: `[${a}] camelCase payload (conversationId/workspacePaths, no event name)`, kind: "critical", status: ok ? "pass" : "fail", detail: ok ? `keys: ${Object.keys(sample).slice(0, 6).join(",")}…` : `DIVERGES — got ${Object.keys(sample).join(",")}` });
    }

    // H3 — guard DENY emits correct deny output on the gate event
    const deny = rs.find((r) => r.normalized?.hook === GATE(a) && (r.decision_returned as any)?.decision === "deny");
    hyps.push({ id: `H3.${a}`, title: `[${a}] guard DENY → correct deny output`, kind: "critical", status: deny ? "pass" : "pending", detail: deny ? JSON.stringify(deny.decision_returned) : "trigger a denied tool (see scenarios)" });

    // H4 — allow output shape on the gate event
    const allow = rs.find((r) => r.normalized?.hook === GATE(a) && (r.decision_returned as any)?.decision !== "deny");
    if (allow) {
      const out = allow.decision_returned as any;
      const ok = family(a) === "gemini" ? Object.keys(out).length === 0 : out.decision === "allow";
      hyps.push({ id: `H4.${a}`, title: `[${a}] allow output shape`, kind: "critical", status: ok ? "pass" : "fail", detail: `got ${JSON.stringify(out)} (expect ${family(a) === "gemini" ? "{}" : '{"decision":"allow"}'})` });
    } else {
      hyps.push({ id: `H4.${a}`, title: `[${a}] allow output shape`, kind: "critical", status: "pending", detail: "no allow on gate yet" });
    }

    // H5 — normalization extracted tool_name on the gate event
    const gate = rs.find((r) => r.normalized?.hook === GATE(a));
    if (gate) {
      const ok = Boolean(gate.normalized?.tool_name);
      hyps.push({ id: `H5.${a}`, title: `[${a}] normalization extracted tool_name`, kind: "critical", status: ok ? "pass" : "fail", detail: ok ? `tool_name=${gate.normalized?.tool_name}` : `FAILED on ${JSON.stringify(gate.received_payload).slice(0, 100)}` });
    }
  }

  // H6 — deny actually blocks (manual)
  const denials = recs.filter((r) => (r.decision_returned as any)?.decision === "deny");
  hyps.push({ id: "H6", title: "deny actually BLOCKS the tool in the CLI (manual confirm)", kind: "manual", status: "pending", detail: denials.length ? `${denials.length} deny(s) emitted — confirm the CLI blocked them` : "no deny emitted yet" });

  // H7 — PreInvocation frequency (info)
  const pre = recs.filter((r) => r.normalized?.hook === "PreInvocation");
  const byConv: Record<string, number> = {};
  for (const r of pre) byConv[r.normalized?.session_id ?? "?"] = (byConv[r.normalized?.session_id ?? "?"] ?? 0) + 1;
  hyps.push({ id: "H7", title: "[antigravity] PreInvocation frequency (per model-call?)", kind: "info", status: pre.length ? "pass" : "pending", detail: pre.length ? JSON.stringify(byConv) : "no PreInvocation yet" });

  const coverage = {} as Record<Agent, { seen: string[]; missing: string[] }>;
  for (const a of ALL_AGENTS) {
    const seen = [...new Set(recs.filter((r) => r.agent === a).map((r) => r.normalized?.hook ?? r.event ?? "?"))].filter(Boolean) as string[];
    coverage[a] = { seen, missing: EXPECTED[a].filter((e) => !seen.includes(e)) };
  }
  return { hyps, coverage, denials };
}

const ICON = { pass: "✅", fail: "❌", pending: "⬜" } as const;

function renderReport(recs: Rec[]): string {
  const { hyps, coverage, denials } = score(recs);
  const L: string[] = [];
  L.push(`# pinta-gemini hook verification report`);
  L.push(`captured invocations: ${recs.length}`, "");
  L.push(`## Event coverage (captured vs installed)`);
  for (const a of ALL_AGENTS) L.push(`- **${a}**: ${coverage[a].seen.length}/${EXPECTED[a].length}  seen=[${coverage[a].seen.join(", ")}]  missing=[${coverage[a].missing.join(", ")}]`);
  L.push("", `## Hypotheses`);
  for (const h of hyps) L.push(`- ${ICON[h.status]} ${h.kind === "manual" ? "🖐" : h.kind === "info" ? "ℹ️" : ""} **${h.id}** ${h.title} — ${h.detail}`);
  if (denials.length) {
    L.push("", `## Manual deny checks (confirm the CLI actually blocked these)`);
    for (const d of denials) L.push(`- [${d.agent}/${d.normalized?.hook}] tool=${d.normalized?.tool_name} → ${JSON.stringify(d.decision_returned)}`);
  }
  const crit = hyps.filter((h) => h.kind === "critical");
  const failed = crit.filter((h) => h.status === "fail");
  const pending = crit.filter((h) => h.status === "pending");
  L.push("", `## Remaining to verify`);
  if (pending.length) L.push(`- pending (exercise these): ${pending.map((h) => h.id).join(", ")}`);
  if (failed.length) L.push(`- ❌ FIX: ${failed.map((h) => `${h.id} (${h.detail})`).join(" ; ")}`);
  L.push(denials.length ? `- 🖐 confirm ${denials.length} deny(s) blocked the tool` : `- 🖐 trigger ≥1 deny per host and confirm it blocked`);
  const ok = crit.length > 0 && failed.length === 0 && pending.length === 0;
  L.push("", `## Dev-entry gate`);
  L.push(`- all critical hypotheses pass: ${ok ? "YES" : "NO"}`);
  L.push(`- deny emitted: ${denials.length ? "yes (confirm honored manually)" : "NOT yet"}`);
  L.push(`- **verdict: ${ok && denials.length ? "READY for real development (after manual deny ticks)" : "NOT READY — see above"}**`);
  return L.join("\n");
}

function renderDash(recs: Rec[]): string {
  const { coverage } = score(recs);
  return `captured=${recs.length}  [${ALL_AGENTS.map((a) => `${a} ${coverage[a].seen.length}/${EXPECTED[a].length}`).join(" | ")}]`;
}

// ===========================================================================
// Scenarios
// ===========================================================================
function printScenarios(workspace?: string): void {
  console.log(`
┌── TEST SCENARIOS — run these in YOUR terminals while this watcher runs ──────
│ Mock guard DENIES input matching: rm -rf · password · secret · credential · AWS keys.
│ Safe deny trigger: ask the agent to run  echo "password test"
│ (invocations.jsonl is created lazily on the FIRST captured hook.)
│
│ ── Gemini CLI (installed as an EXTENSION → bypasses folder-trust) ─────────
│  0. RESTART gemini so it loads the new ~/.gemini/extensions/pinta-gemini.
│  1. launch:    gemini                        → SessionStart
│  2. prompt:    "list the files here"         → BeforeAgent, BeforeTool(allow), AfterTool, AfterAgent
│  3. deny:      run the shell command: echo "password test"  → BeforeTool(DENY) — confirm blocked
│  4. /quit                                    → SessionEnd
│
│ ── antigravity (agy v1.0.x AND Antigravity 2.0 → GLOBAL ~/.gemini/config/hooks.json) ──
│  Both binaries read the same global config; both log as agent=antigravity.
│  1. launch:    agy   (or Antigravity 2.0)    → PreInvocation
│  2. prompt:    "list files in this folder"   → PreToolUse(allow), PostToolUse, PostInvocation
│  3. deny:      run: echo "password test"     → PreToolUse(DENY) — confirm blocked
│  4. exit                                     → Stop
${workspace ? `│  (also installed project-scoped at ${path.join(workspace, ".agents", "hooks.json")})` : "│  (project-scoped .agents/ install available via --workspace <dir>)"}
└──────────────────────────────────────────────────────────────────────────────
`);
}

// ===========================================================================
// install / teardown / read-back
// ===========================================================================
function runInstaller(agent: Agent, home: string, workspace: string | undefined, extra: string[]): void {
  const args = [INSTALLER, "--agent", agent, ...extra];
  if (agent === "antigravity" && workspace) args.push("--workspace", workspace);
  const r = spawnSync("npx", ["--yes", "tsx", ...args], { env: { ...process.env, GEMINI_HOME: home }, encoding: "utf-8" });
  console.log("  " + (r.stdout || r.stderr).trim());
}

function configPath(home: string, agent: Agent, workspace?: string): string {
  if (agent === "gemini") return path.join(home, "extensions", "pinta-gemini", "hooks", "hooks.json");
  // antigravity: global ~/.gemini/config/hooks.json by default, or workspace .agents/
  return workspace ? path.join(workspace, ".agents", "hooks.json") : path.join(home, "config", "hooks.json");
}

function readInstalledCommand(home: string, agent: Agent, event: string, workspace?: string): string | undefined {
  const file = configPath(home, agent, workspace);
  if (!file) return undefined;
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

function writeEnvFile(home: string, otlp: string, guard: string): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    ENV_FILE(home),
    ["# written by hook-verify.ts — remove with: tsx tools/hook-verify.ts teardown", "PINTA_GEMINI_DEBUG=1", `GEMINI_PLUGIN_DATA=${DATA_DIR(home)}`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${otlp}`, `PINTA_GUARD_ENDPOINT=${guard}`, "PINTA_RELAY_TOKEN=verify-token"].join("\n") + "\n",
  );
  console.log(`  wrote ${ENV_FILE(home)}`);
}

const DANGEROUS = /rm\s+-rf|\bsecret\b|credential|password|AKIA[0-9A-Z]{16}/i;
function startServers(): Promise<{ otlp: string; guard: string; close: () => void }> {
  const collector = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => res.writeHead(200).end("{}"));
  });
  const guardSrv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      let deny = false;
      try {
        deny = DANGEROUS.test(JSON.parse(b)?.input?.rawTextFields?.toolInput ?? "");
      } catch {}
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(deny ? { decision: "DENY", reason: "deny_dangerous_command", userMessage: "⛔ Blocked by Pinta AI — deny_dangerous_command" } : { decision: "ALLOW", reason: null, userMessage: null }));
    });
  });
  return new Promise((resolve) => collector.listen(0, () => guardSrv.listen(0, () => resolve({ otlp: `http://127.0.0.1:${(collector.address() as any).port}/v1/traces`, guard: `http://127.0.0.1:${(guardSrv.address() as any).port}/guard/evaluate`, close: () => (collector.close(), guardSrv.close()) }))));
}

function readAll(file: string): Rec[] {
  try {
    return fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Rec);
  } catch {
    return [];
  }
}

// ===========================================================================
// selftest
// ===========================================================================
function selftest(): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pinta-verify-selftest-"));
  const file = path.join(tmp, "invocations.jsonl");
  const rec = (agent: Agent, event: string, payload: object, normalized: object, guard: any, decision: object) => ({ ts: "t", agent, event, argv: ["--agent", agent, "--event", event], received_payload: payload, normalized: { hook: event, ...normalized }, guard, decision_returned: decision });
  const recs: any[] = [
    rec("gemini", "SessionStart", { session_id: "g1", cwd: "/w", hook_event_name: "SessionStart" }, { session_id: "g1", cwd: "/w" }, null, {}),
    rec("gemini", "BeforeTool", { session_id: "g1", cwd: "/w", hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command: "ls" } }, { session_id: "g1", cwd: "/w", tool_name: "run_shell_command" }, { decision: "ALLOW", reason: null, userMessage: null }, {}),
    rec("gemini", "BeforeTool", { session_id: "g1", cwd: "/w", hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command: "echo password" } }, { session_id: "g1", cwd: "/w", tool_name: "run_shell_command" }, { decision: "DENY", reason: "deny_dangerous_command", userMessage: "⛔ Blocked by Pinta AI — deny_dangerous_command" }, { decision: "deny", reason: "⛔ Blocked by Pinta AI — deny_dangerous_command", systemMessage: "⛔ Blocked by Pinta AI — deny_dangerous_command" }),
    rec("antigravity", "PreToolUse", { conversationId: "a1", workspacePaths: ["/w"], transcriptPath: "/t", toolCall: { name: "run_command", args: { CommandLine: "ls" } }, stepIdx: 1 }, { session_id: "a1", cwd: "/w", tool_name: "run_command" }, { decision: "ALLOW", reason: null, userMessage: null }, { decision: "allow" }),
    rec("antigravity", "PreToolUse", { conversationId: "a1", workspacePaths: ["/w"], transcriptPath: "/t", toolCall: { name: "run_command", args: { CommandLine: "echo password" } }, stepIdx: 2 }, { session_id: "a1", cwd: "/w", tool_name: "run_command" }, { decision: "DENY", reason: "deny_dangerous_command", userMessage: "⛔ Blocked by Pinta AI — deny_dangerous_command" }, { decision: "deny", reason: "⛔ Blocked by Pinta AI — deny_dangerous_command" }),
  ];
  for (const r of recs) fs.appendFileSync(file, JSON.stringify(r) + "\n");
  console.log(renderReport(readAll(file)));
  console.log(`\n(selftest data: ${file})`);
}

// ===========================================================================
// main
// ===========================================================================
async function main(): Promise<void> {
  const cmd = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "watch";
  const wsIdx = process.argv.indexOf("--workspace");
  const workspace = wsIdx >= 0 ? process.argv[wsIdx + 1] : undefined;
  const home = REAL_HOME;

  if (cmd === "selftest") return selftest();
  if (cmd === "report") return void console.log(renderReport(readAll(LOG_FILE(home))));
  if (cmd === "teardown") {
    console.log("── teardown ──");
    for (const a of ALL_AGENTS) runInstaller(a, home, workspace, ["--uninstall"]);
    for (const a of ALL_AGENTS) {
      const bak = configPath(home, a, workspace) + ".pinta-bak";
      if (fs.existsSync(bak)) {
        fs.copyFileSync(bak, configPath(home, a, workspace));
        fs.rmSync(bak);
        console.log(`  restored ${configPath(home, a, workspace)}`);
      }
    }
    fs.rmSync(ENV_FILE(home), { force: true });
    console.log(`  removed ${ENV_FILE(home)}\nteardown complete (jsonl kept).`);
    return;
  }

  // watch
  if (!fs.existsSync(ENTRY)) {
    console.error(`adapter not built: ${ENTRY}\nrun: npm run build`);
    process.exit(1);
  }
  console.log(`pinta-gemini hook-verify — REAL host watch`);
  console.log(`home: ${home}${workspace ? `  workspace=${workspace} (antigravity also project-scoped)` : "  (antigravity installed GLOBALLY)"}\n── install ──`);
  for (const a of ALL_AGENTS) runInstaller(a, home, workspace, []);

  const srv = await startServers();
  writeEnvFile(home, srv.otlp, srv.guard);
  fs.mkdirSync(DATA_DIR(home), { recursive: true });

  const file = LOG_FILE(home);
  let offset = 0;
  try {
    offset = fs.statSync(file).size;
  } catch {}
  const all: Rec[] = [];
  console.log(`\nwatching ${file}`);
  printScenarios(workspace);
  console.log(`dashboard: ${renderDash(all)}   (Ctrl-C → final report)\n`);

  const timer = setInterval(() => {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size <= offset) return;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    const text = buf.toString("utf-8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) return;
    offset += lastNl + 1;
    for (const line of text.slice(0, lastNl).split("\n")) {
      if (!line.trim()) continue;
      let r: Rec;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      all.push(r);
      const dec = (r.decision_returned as any)?.decision;
      const flag = dec === "deny" ? "  ⛔DENY (confirm the CLI blocked it!)" : "";
      const argFlag = Array.isArray(r.argv) && r.argv.includes("--event") ? "" : "  ⚠ARGS-STRIPPED";
      console.log(`▶ ${r.agent}/${r.normalized?.hook ?? r.event}  tool=${r.normalized?.tool_name ?? "—"}  guard=${r.guard?.decision ?? "—"}${flag}${argFlag}`);
      console.log(`   ${renderDash(all)}`);
    }
  }, 500);

  const finish = () => {
    clearInterval(timer);
    srv.close();
    const report = renderReport(all);
    fs.writeFileSync(path.join(REPO, "verification-report.md"), report + "\n");
    fs.rmSync(ENV_FILE(home), { force: true });
    console.log("\n\n" + report);
    console.log(`\nreport: ${path.join(REPO, "verification-report.md")}`);
    console.log(`env-file removed (hooks still installed). full uninstall: npx tsx tools/hook-verify.ts teardown${workspace ? ` --workspace ${workspace}` : ""}`);
    process.exit(0);
  };
  process.on("SIGINT", finish);
  process.on("SIGTERM", finish);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
