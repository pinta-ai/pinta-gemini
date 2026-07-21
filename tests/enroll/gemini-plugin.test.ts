// Ported from pinta-manager `sidecar/tests/enroll/gemini-plugin.test.ts` as
// part of the enroll-lifecycle migration (same coverage, contract-shaped ctx).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyGeminiPlugin, removeGeminiPlugin, type GeminiPluginInstall } from "../../src/enroll/gemini-plugin.js";
import { enroll } from "../../src/enroll/index.js";
import type { EnrollContext } from "../../src/enroll/types.js";

let tmpHome: string;
let tmpAdaptorBase: string;
let tmpAdaptorRoot: string;
let tmpBackupRoot: string;

// Mirror the real pinta-catalog manifest: namespaced GEMINI_PLUGIN_OPTION_*
// keys (avoid colliding with Gemini CLI's own native OTel).
const install: GeminiPluginInstall = {
  dist_root: "package/dist",
  env_file_keys: {
    GEMINI_PLUGIN_OPTION_ENDPOINT: "relay-endpoint",
    GEMINI_PLUGIN_OPTION_HEADERS: "relay-token",
  },
};

// Same mapping the manager's relay token resolver produces (mirrored so the
// ported assertions keep their exact expected strings).
function makeTokenResolver(opts: { sidecarPort: number; relayToken: string }) {
  return (source: string): string => {
    switch (source) {
      case "relay-endpoint":
        return `http://127.0.0.1:${opts.sidecarPort}/v1/traces`;
      case "relay-token":
        return `x-pinta-relay-token=${opts.relayToken}`;
      case "relay-token-raw":
        return opts.relayToken;
      case "relay-guard-endpoint":
        return `http://127.0.0.1:${opts.sidecarPort}/guard/evaluate`;
      default:
        throw new Error(`unknown token source: ${source}`);
    }
  };
}

function makeCtx(overrides: Partial<EnrollContext> = {}): EnrollContext {
  return {
    adaptorId: "pinta-gemini",
    adaptorVersion: "0.1.0",
    adaptorRoot: tmpAdaptorRoot,
    homeDir: tmpHome,
    platform: "darwin",
    nodePath: "node",
    resolveToken: makeTokenResolver({ sidecarPort: 4318, relayToken: "GEMINI-TOKEN" }),
    backupRoot: tmpBackupRoot,
    ...overrides,
  };
}

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmgr-gemini-home-"));
  tmpAdaptorBase = fs.mkdtempSync(path.join(os.tmpdir(), "pmgr-gemini-base-"));
  tmpAdaptorRoot = path.join(tmpAdaptorBase, "pinta-gemini", "0.1.0");
  tmpBackupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pmgr-gemini-bak-"));
  fs.mkdirSync(path.join(tmpAdaptorRoot, "package", "dist"), { recursive: true });
  fs.writeFileSync(path.join(tmpAdaptorRoot, "package", "dist", "index.js"), "// pinta-gemini entry");
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpAdaptorBase, { recursive: true, force: true });
  fs.rmSync(tmpBackupRoot, { recursive: true, force: true });
});

describe("enroll (EnrollSource)", () => {
  it("declares its identity and the gemini-plugin hooks provider", () => {
    expect(enroll.id).toBe("pinta-gemini");
    expect(enroll.mcp).toBeUndefined();
    expect(enroll.hooks?.installType).toBe("gemini-plugin");
    expect(enroll.hooks?.watchPaths("/h")).toEqual([
      path.join("/h", ".gemini", "extensions", "pinta-gemini", "hooks", "hooks.json"),
      path.join("/h", ".gemini", "config", "hooks.json"),
      path.join("/h", ".gemini", "pinta-gemini.env"),
    ]);
  });

  it("apply/remove round-trips through the provider interface", async () => {
    const result = await enroll.hooks!.apply(makeCtx(), install as unknown as Record<string, unknown>);
    expect(result.installed).toBe(true);
    const removed = await enroll.hooks!.remove(makeCtx(), install as unknown as Record<string, unknown>);
    expect(removed.installed).toBe(false);
  });
});

describe("applyGeminiPlugin", () => {
  it("throws when adapter entry is missing", async () => {
    fs.rmSync(path.join(tmpAdaptorRoot, "package", "dist", "index.js"));
    await expect(applyGeminiPlugin(makeCtx(), install)).rejects.toThrow(/entry missing/);
  });

  it("writes the Gemini extension (manifest + hooks.json) with the dist entry", async () => {
    const result = await applyGeminiPlugin(makeCtx(), install);
    expect(result.installed).toBe(true);

    const extDir = path.join(tmpHome, ".gemini", "extensions", "pinta-gemini");
    const manifest = readJson(path.join(extDir, "gemini-extension.json"));
    expect(manifest).toMatchObject({ name: "pinta-gemini", version: "0.1.0" });

    const hooks = readJson(path.join(extDir, "hooks", "hooks.json"));
    expect(Object.keys(hooks.hooks)).toContain("BeforeTool");
    const cmd = hooks.hooks.BeforeTool[0].hooks[0].command;
    expect(cmd).toContain("package/dist/index.js");
    expect(cmd).toContain("--agent gemini --event BeforeTool");
    expect(hooks.hooks.BeforeTool[0].matcher).toBe(""); // tool event carries matcher
  });

  it("writes Antigravity global config with tool events wrapped and lifecycle events flat", async () => {
    await applyGeminiPlugin(makeCtx(), install);
    const cfg = readJson(path.join(tmpHome, ".gemini", "config", "hooks.json"));
    const events = cfg["pinta-gemini"];
    // tool event → [{matcher, hooks:[handler]}]
    expect(events.PreToolUse[0].matcher).toBe("");
    expect(events.PreToolUse[0].hooks[0].command).toContain("--agent antigravity --event PreToolUse");
    // lifecycle event → [handler] (flat, no matcher/hooks wrapper)
    expect(events.PreInvocation[0].type).toBe("command");
    expect(events.PreInvocation[0].command).toContain("--agent antigravity --event PreInvocation");
    expect(events.PreInvocation[0].hooks).toBeUndefined();
  });

  it("preserves the user's other named hooks in the Antigravity config", async () => {
    const cfgPath = path.join(tmpHome, ".gemini", "config", "hooks.json");
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify({ "user-hook": { PreToolUse: [] } }));
    await applyGeminiPlugin(makeCtx(), install);
    const cfg = readJson(cfgPath);
    expect(cfg["user-hook"]).toBeDefined();
    expect(cfg["pinta-gemini"]).toBeDefined();
  });

  it("writes the env file with resolved OTLP keys + injected guard endpoint", async () => {
    await applyGeminiPlugin(makeCtx(), install);
    const env = fs.readFileSync(path.join(tmpHome, ".gemini", "pinta-gemini.env"), "utf-8");
    expect(env).toContain("GEMINI_PLUGIN_OPTION_ENDPOINT=http://127.0.0.1:4318/v1/traces");
    expect(env).toContain("GEMINI_PLUGIN_OPTION_HEADERS=x-pinta-relay-token=GEMINI-TOKEN");
    expect(env).toContain("PINTA_GUARD_ENDPOINT=http://127.0.0.1:4318/guard/evaluate");
  });

  // Root cause (codex bug report): a hook command beginning with a quoted
  // node.exe path containing spaces is mis-tokenized by the host's hook runner.
  // On win32 both the Gemini extension and Antigravity config route through a
  // bare `.cmd` launcher token instead.
  it("on win32, routes both hosts' hook commands through .cmd wrappers", async () => {
    const bundled = "C:/Program Files/Pinta Manager/node.exe";
    await applyGeminiPlugin(makeCtx({ platform: "win32", nodePath: bundled }), install);

    const extHooks = readJson(path.join(tmpHome, ".gemini", "extensions", "pinta-gemini", "hooks", "hooks.json"));
    const geminiCmd = extHooks.hooks.BeforeTool[0].hooks[0].command as string;
    expect(geminiCmd).toMatch(/pinta-hook-[0-9a-f]{8}\.cmd$/);
    expect(geminiCmd).not.toContain("node.exe");

    const cfg = readJson(path.join(tmpHome, ".gemini", "config", "hooks.json"));
    const antiCmd = cfg["pinta-gemini"].PreToolUse[0].hooks[0].command as string;
    expect(antiCmd).toMatch(/pinta-hook-[0-9a-f]{8}\.cmd$/);

    // Wrappers written into the adaptor package root (manager-owned, reaped on upgrade).
    const pkgDir = path.join(tmpAdaptorRoot, "package");
    const cmdFiles = fs.readdirSync(pkgDir).filter((f) => f.endsWith(".cmd"));
    // 8 Gemini events + 5 Antigravity events = 13 distinct commands (distinct --event).
    expect(cmdFiles.length).toBe(13);
    const sample = fs.readFileSync(path.join(pkgDir, cmdFiles[0]!), "utf-8");
    expect(sample.startsWith("@echo off")).toBe(true);
    expect(sample).toContain("exit /b %ERRORLEVEL%");
  });

  it("does not create a .cmd wrapper on non-Windows", async () => {
    await applyGeminiPlugin(makeCtx({ platform: "darwin", nodePath: "/bundled/node" }), install);
    const pkgDir = path.join(tmpAdaptorRoot, "package");
    expect(fs.readdirSync(pkgDir).some((f) => f.endsWith(".cmd"))).toBe(false);
  });
});

describe("removeGeminiPlugin", () => {
  it("removes the extension dir and strips our named key, preserving others", async () => {
    const cfgPath = path.join(tmpHome, ".gemini", "config", "hooks.json");
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify({ "user-hook": { Stop: [] } }));

    await applyGeminiPlugin(makeCtx(), install);
    const result = await removeGeminiPlugin(makeCtx(), install);
    expect(result.installed).toBe(false);

    expect(fs.existsSync(path.join(tmpHome, ".gemini", "extensions", "pinta-gemini"))).toBe(false);
    const cfg = readJson(cfgPath);
    expect(cfg["pinta-gemini"]).toBeUndefined();
    expect(cfg["user-hook"]).toBeDefined();
  });
});
