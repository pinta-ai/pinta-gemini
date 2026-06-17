/**
 * install-hooks — write host-specific hook config that points every event at
 * this adapter's dist/index.js, with `--agent`/`--event` baked into the command
 * (DG1: the sole event/agent identifiers).
 *
 * Per-host targets (corrected from real-host verification on 2026-06-15):
 *
 *   gemini         → ~/.gemini/extensions/pinta-gemini/  (EXTENSION, not settings.json)
 *                    Extension hooks BYPASS the folder-trust gate that skips
 *                    settings.json hooks in untrusted folders (hookRegistry:
 *                    ConfigSource.Extensions is ungated). Auto-active on drop-in.
 *                    hooks.json shape: { "hooks": { "BeforeTool": [ {matcher,hooks} ] } }
 *                    timeout = milliseconds.
 *
 *   antigravity     → ~/.gemini/config/hooks.json  (GLOBAL/user-level; CONFIRMED:
 *                     agy v1.0.7 reads this, and ANTIGRAVITY2_HOOKS.md documents
 *                     ~/.gemini/config/ as the user-level customization dir — so
 *                     both agy v1.0.x and Antigravity 2.0 read it globally with the
 *                     same camelCase protocol. One profile covers both.)
 *                     named-hook shape: { "pinta-gemini": { "PreToolUse": [...] } }
 *                     timeout = seconds. Optional --workspace DIR installs to
 *                     <DIR>/.agents/hooks.json instead (project-scoped).
 *
 * NOTE: ~/.gemini/antigravity-cli/hooks.json (from the binary-analysis doc) is
 * NOT read by agy v1.0.7 — removed.
 *
 * Idempotent: re-running replaces only our entries. --uninstall removes them.
 *
 * Usage:
 *   tsx tools/install-hooks.ts --agent gemini
 *   tsx tools/install-hooks.ts --agent antigravity                      # global
 *   tsx tools/install-hooks.ts --agent antigravity --workspace /proj    # project-scoped
 *   ... [--dry-run] [--uninstall]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Agent = "gemini" | "antigravity";
const KNOWN_AGENTS: Agent[] = ["gemini", "antigravity"];

const HOOK_NAME = "pinta-gemini";
const EXT_NAME = "pinta-gemini";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const ENTRY = path.join(REPO, "dist", "index.js");

// Gemini's full enum is 11; we register 8 and skip the 3 chatty/low-value ones
// (BeforeModel, AfterModel[per-chunk], BeforeToolSelection). Tool events carry a matcher.
const GEMINI_EVENTS = ["BeforeTool", "AfterTool", "BeforeAgent", "AfterAgent", "SessionStart", "SessionEnd", "PreCompress", "Notification"];
const ANTIGRAVITY_EVENTS = ["PreToolUse", "PostToolUse", "PreInvocation", "PostInvocation", "Stop"];
const TOOL_EVENTS = new Set(["BeforeTool", "AfterTool", "PreToolUse", "PostToolUse"]);

function geminiHome(): string {
  return process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
}
function command(agent: Agent, event: string): string {
  return `${process.execPath} ${ENTRY} --agent ${agent} --event ${event}`;
}

// ── gemini: extension dir ──────────────────────────────────────────────────
function geminiExtDir(home: string): string {
  return path.join(home, "extensions", EXT_NAME);
}
function installGemini(home: string, dryRun: boolean, uninstall: boolean): void {
  const dir = geminiExtDir(home);
  if (uninstall) {
    if (fs.existsSync(dir)) {
      if (!dryRun) fs.rmSync(dir, { recursive: true, force: true });
      console.log(`${dryRun ? "[dry-run] would remove" : "removed"} (gemini ext): ${dir}`);
    } else console.log(`nothing to remove (gemini ext): ${dir}`);
    return;
  }
  const manifest = { name: EXT_NAME, version: "0.2.1", description: "Pinta OTLP forwarder + guard (verification)" };
  const hooks: Record<string, unknown> = {};
  for (const ev of GEMINI_EVENTS) {
    const def: any = { hooks: [{ name: HOOK_NAME, type: "command", command: command("gemini", ev), timeout: 60000 }] };
    if (TOOL_EVENTS.has(ev)) def.matcher = "";
    hooks[ev] = [def];
  }
  const hooksFile = { hooks };
  if (dryRun) {
    console.log(`[dry-run] would write gemini extension at: ${dir}`);
    console.log(`  gemini-extension.json: ${JSON.stringify(manifest)}`);
    console.log(`  hooks/hooks.json:\n${JSON.stringify(hooksFile, null, 2)}`);
    return;
  }
  fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "gemini-extension.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "hooks", "hooks.json"), JSON.stringify(hooksFile, null, 2) + "\n");
  console.log(`installed (gemini ext): ${dir}`);
}

// ── antigravity: named-hook hooks.json (GLOBAL by default) ─────────────────
function antigravityFile(home: string, workspace?: string): string {
  // Global/user-level (default) — read by both agy v1.0.x and Antigravity 2.0.
  // --workspace switches to a project-scoped .agents/hooks.json.
  return workspace ? path.join(workspace, ".agents", "hooks.json") : path.join(home, "config", "hooks.json");
}
function installAntigravity(agent: Agent, home: string, workspace: string | undefined, dryRun: boolean, uninstall: boolean): void {
  const file = antigravityFile(home, workspace);
  let root: any = {};
  try {
    root = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    /* none */
  }
  if (uninstall) {
    if (root && typeof root === "object" && HOOK_NAME in root) {
      delete root[HOOK_NAME];
      if (!dryRun) fs.writeFileSync(file, JSON.stringify(root, null, 2) + "\n");
      console.log(`${dryRun ? "[dry-run] would clean" : "cleaned"} (${agent}): ${file}`);
    } else console.log(`nothing to remove (${agent}): ${file}`);
    return;
  }
  const events: Record<string, unknown> = {};
  for (const ev of ANTIGRAVITY_EVENTS) {
    const handler: any = { type: "command", command: command(agent, ev), timeout: 30 };
    // Tool events: [{matcher, hooks:[handler]}]. Lifecycle events (PreInvocation/
    // PostInvocation/Stop): handlers DIRECTLY in the array, no matcher/hooks wrapper
    // (ANTIGRAVITY2_HOOKS.md: "a list of handlers directly under the event key").
    events[ev] = TOOL_EVENTS.has(ev) ? [{ matcher: "", hooks: [handler] }] : [handler];
  }
  root[HOOK_NAME] = events; // replace only our named hook; preserve user's others
  const content = JSON.stringify(root, null, 2) + "\n";
  if (dryRun) {
    console.log(`[dry-run] would write (${agent}): ${file}\n${content}`);
    return;
  }
  // back up an existing user file once before first write
  const bak = file + ".pinta-bak";
  if (fs.existsSync(file) && !fs.existsSync(bak)) fs.copyFileSync(file, bak);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  console.log(`installed (${agent}): ${file}`);
}

function main(): void {
  const args = process.argv.slice(2);
  const agent = (() => {
    const i = args.indexOf("--agent");
    return i >= 0 ? (args[i + 1] as Agent) : undefined;
  })();
  const workspace = (() => {
    const i = args.indexOf("--workspace");
    return i >= 0 ? args[i + 1] : undefined;
  })();
  const dryRun = args.includes("--dry-run");
  const uninstall = args.includes("--uninstall");

  if (!agent || !KNOWN_AGENTS.includes(agent)) {
    console.error(`usage: install-hooks --agent <${KNOWN_AGENTS.join("|")}> [--workspace DIR] [--dry-run] [--uninstall]`);
    process.exit(2);
  }

  const home = geminiHome();
  if (agent === "gemini") installGemini(home, dryRun, uninstall);
  else installAntigravity(agent, home, workspace, dryRun, uninstall);

  if (!uninstall && !dryRun && !fs.existsSync(ENTRY)) {
    console.log(`  ⚠ adapter not built yet — run \`npm run build\` to create ${ENTRY}`);
  }
}

main();
