import path from "node:path";
import type { EnrollContext, EnrollSource } from "./types.js";
import {
  applyGeminiPlugin,
  removeGeminiPlugin,
  type GeminiPluginInstall,
} from "./gemini-plugin.js";

/**
 * The enroll lifecycle export the pinta-manager sidecar drives (`import()`ed
 * from the installed adaptor's `dist/index.mjs`). pinta-gemini owns the
 * install knowledge for both of its hosts — Gemini CLI (extension) and
 * Antigravity (named-hook) — so the manager never hard-codes `~/.gemini`
 * paths.
 */
export const enroll: EnrollSource = {
  id: "pinta-gemini",
  hooks: {
    installType: "gemini-plugin",
    apply: (ctx: EnrollContext, install: Record<string, unknown>) =>
      applyGeminiPlugin(ctx, install as unknown as GeminiPluginInstall),
    remove: (ctx: EnrollContext, install: Record<string, unknown>) =>
      removeGeminiPlugin(ctx, install as unknown as GeminiPluginInstall),
    watchPaths: (homeDir: string) => [
      path.join(homeDir, ".gemini", "extensions", "pinta-gemini", "hooks", "hooks.json"),
      path.join(homeDir, ".gemini", "config", "hooks.json"),
      path.join(homeDir, ".gemini", "pinta-gemini.env"),
    ],
  },
};

export type {
  EnrollSource,
  EnrollContext,
  EnrollApplyResult,
  HookEnrollProvider,
  McpConfigSource,
  McpConfigScope,
  McpDetectContext,
  McpServerEntry,
} from "./types.js";
export type { GeminiPluginInstall } from "./gemini-plugin.js";
