// Ported verbatim from pinta-manager `sidecar/src/enroll/gemini-plugin.ts` as
// part of the enroll-lifecycle migration: the wrapper owns "what lives where"
// for its host (troy §4.2), so the Gemini/Antigravity install knowledge lives
// here and the manager only drives `enroll.hooks.apply/remove`.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { EnrollApplyResult, EnrollContext } from "./types.js";
import { writeAtomicWithBackup } from "./fs-util.js";
import { renderHookCommand, toCommandPath } from "./node-binary.js";
import { parseEnvFile, serializeEnvFile } from "./env-file.js";

/**
 * pinta-gemini installs hooks for TWO Gemini-family hosts that both read from
 * `~/.gemini`, using a single adapter binary (`--agent <gemini|antigravity>`):
 *
 *   - Gemini CLI    → EXTENSION  `~/.gemini/extensions/pinta-gemini/`
 *                     (gemini-extension.json + hooks/hooks.json). Extensions
 *                     bypass the folder-trust gate that skips settings.json hooks.
 *   - Antigravity   → `~/.gemini/config/hooks.json` (named-hook, global)
 *                     covers agy v1.0.x AND Antigravity 2.0 (same global config).
 *
 * Hooks are built in-code (no template) because the two hosts use different
 * structures (Gemini extension vs Antigravity named-hook, tool events wrapped
 * `{matcher,hooks}` vs lifecycle handlers flat). Config injected via env file
 * `~/.gemini/pinta-gemini.env`. See pinta-gemini SPEC §3.
 */

/** The catalog manifest `install` block for a `gemini-plugin` target. */
export interface GeminiPluginInstall {
  dist_root: string;
  env_file_keys: Record<string, string>;
}

// Gemini CLI: 11 events total; we register the 8 useful ones (skip BeforeModel,
// AfterModel[per-chunk], BeforeToolSelection). Antigravity: all 5.
const GEMINI_EVENTS = ["BeforeTool", "AfterTool", "BeforeAgent", "AfterAgent", "SessionStart", "SessionEnd", "PreCompress", "Notification"];
const ANTIGRAVITY_EVENTS = ["PreToolUse", "PostToolUse", "PreInvocation", "PostInvocation", "Stop"];
const TOOL_EVENTS = new Set(["BeforeTool", "AfterTool", "PreToolUse", "PostToolUse"]);

const EXT_NAME = "pinta-gemini";
const HOOK_NAME = "pinta-gemini";

interface HookHandler {
  name?: string;
  type: "command";
  command: string;
  timeout?: number;
}

/** Resolve a `key → TokenSource` manifest record to actual values. */
function resolveTokenMap(
  map: Record<string, string>,
  resolve: (source: string) => string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    out[k] = resolve(v);
  }
  return out;
}

function hookCommand(
  entry: string,
  nodePath: string,
  agent: string,
  event: string,
  platform: NodeJS.Platform,
  wrapperDir: string,
): string {
  // Command STRING is shell-parsed by the host → forward-slash the entry path.
  // renderHookCommand rewrites the `node` token and, on Windows, routes through
  // a `.cmd` launcher (the Gemini CLI / Antigravity hook runner mis-tokenizes a
  // quoted node.exe path with spaces). Wrapper lives in the adaptor package
  // root (manager-owned, reaped with the version on upgrade).
  return renderHookCommand(
    `node ${toCommandPath(entry)} --agent ${agent} --event ${event}`,
    nodePath,
    platform,
    wrapperDir,
  );
}

/** Gemini extension hooks.json: every event uses the {matcher?, hooks:[handler]} shape. */
function buildGeminiExtensionHooks(
  entry: string,
  nodePath: string,
  platform: NodeJS.Platform,
  wrapperDir: string,
): { hooks: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = {};
  for (const ev of GEMINI_EVENTS) {
    const handler: HookHandler = { name: HOOK_NAME, type: "command", command: hookCommand(entry, nodePath, "gemini", ev, platform, wrapperDir), timeout: 60000 };
    const def: Record<string, unknown> = { hooks: [handler] };
    if (TOOL_EVENTS.has(ev)) def.matcher = "";
    hooks[ev] = [def];
  }
  return { hooks };
}

/** Antigravity named-hook events block: tool events wrapped, lifecycle events flat. */
function buildAntigravityEvents(
  entry: string,
  nodePath: string,
  platform: NodeJS.Platform,
  wrapperDir: string,
): Record<string, unknown[]> {
  const events: Record<string, unknown[]> = {};
  for (const ev of ANTIGRAVITY_EVENTS) {
    const handler: HookHandler = { type: "command", command: hookCommand(entry, nodePath, "antigravity", ev, platform, wrapperDir), timeout: 30 };
    events[ev] = TOOL_EVENTS.has(ev) ? [{ matcher: "", hooks: [handler] }] : [handler];
  }
  return events;
}

function safeParseObject(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// --- public API ---

export async function applyGeminiPlugin(
  ctx: EnrollContext,
  install: GeminiPluginInstall,
): Promise<EnrollApplyResult> {
  const distAbsPath = path.join(ctx.adaptorRoot, install.dist_root);
  const entry = path.join(distAbsPath, "index.js");
  if (!fs.existsSync(entry)) {
    throw new Error(`gemini-plugin: adapter entry missing: ${entry}`);
  }

  const geminiHome = path.join(ctx.homeDir, ".gemini");
  const extDir = path.join(geminiHome, "extensions", EXT_NAME);
  const extManifestPath = path.join(extDir, "gemini-extension.json");
  const extHooksPath = path.join(extDir, "hooks", "hooks.json");
  const antigravityCfgPath = path.join(geminiHome, "config", "hooks.json");
  const envFilePath = path.join(geminiHome, "pinta-gemini.env");
  // Windows `.cmd` launchers (if any) live in the adaptor package root —
  // manager-owned and reaped with the version dir on upgrade.
  const wrapperDir = path.dirname(distAbsPath);

  // 1. Gemini CLI extension (fully manager-owned dir → overwrite).
  const manifest = { name: EXT_NAME, version: ctx.adaptorVersion, description: "Pinta OTLP forwarder + guard" };
  await writeAtomicWithBackup(extManifestPath, JSON.stringify(manifest, null, 2) + "\n", ctx.backupRoot);
  await writeAtomicWithBackup(extHooksPath, JSON.stringify(buildGeminiExtensionHooks(entry, ctx.nodePath, ctx.platform, wrapperDir), null, 2) + "\n", ctx.backupRoot);

  // 2. Antigravity global config/hooks.json (merge: replace only our named key).
  const cfgExisting = fs.existsSync(antigravityCfgPath) ? safeParseObject(fs.readFileSync(antigravityCfgPath, "utf-8")) : {};
  cfgExisting[HOOK_NAME] = buildAntigravityEvents(entry, ctx.nodePath, ctx.platform, wrapperDir);
  await writeAtomicWithBackup(antigravityCfgPath, JSON.stringify(cfgExisting, null, 2) + "\n", ctx.backupRoot);

  // 3. env file (merge keys + unconditional guard endpoint, mirroring codex).
  const envExisting = fs.existsSync(envFilePath) ? parseEnvFile(fs.readFileSync(envFilePath, "utf-8")) : {};
  const newEnv = resolveTokenMap(install.env_file_keys, ctx.resolveToken);
  newEnv["PINTA_GUARD_ENDPOINT"] = ctx.resolveToken("relay-guard-endpoint");
  await writeAtomicWithBackup(envFilePath, serializeEnvFile({ ...envExisting, ...newEnv }), ctx.backupRoot);

  return {
    installed: true,
    configPath: extHooksPath,
    details: { geminiHome, extDir, antigravityCfgPath, envFilePath },
  };
}

export async function removeGeminiPlugin(
  ctx: EnrollContext,
  _install: GeminiPluginInstall,
): Promise<EnrollApplyResult> {
  const geminiHome = path.join(ctx.homeDir, ".gemini");
  const extDir = path.join(geminiHome, "extensions", EXT_NAME);
  const antigravityCfgPath = path.join(geminiHome, "config", "hooks.json");
  const extHooksPath = path.join(extDir, "hooks", "hooks.json");

  // 1. Remove the manager-owned Gemini extension directory entirely.
  await fsp.rm(extDir, { recursive: true, force: true });

  // 2. Strip our named key from the Antigravity config (preserve user's others).
  if (fs.existsSync(antigravityCfgPath)) {
    const cfg = safeParseObject(fs.readFileSync(antigravityCfgPath, "utf-8"));
    if (HOOK_NAME in cfg) {
      delete cfg[HOOK_NAME];
      await writeAtomicWithBackup(antigravityCfgPath, JSON.stringify(cfg, null, 2) + "\n", ctx.backupRoot);
    }
  }

  return { installed: false, configPath: extHooksPath };
}
