/**
 * ESM dual-entry (M5b/M5e, plan §4.2/§4.3): built to `dist/index.mjs` via a
 * separate `--format=esm` esbuild step (see package.json `build:esm`).
 *
 * Exports the pinta-gemini `lifecycle` TranscriptSource for the pinta-manager
 * sidecar's runtime `import()` (`import(~/.pinta/adaptors/pinta-gemini/…mjs)`),
 * AND still works as a direct-exec Gemini/Antigravity hook — but guarded so
 * that *importing* this module (the sidecar loading the adaptor) does NOT also
 * read stdin / forward a span / call process.exit().
 *
 * `dist/index.js` (built from `src/index.ts`) remains the hook-only,
 * always-direct-exec entry the host invokes — untouched by this work.
 *
 * Guard: `import.meta.main` is Bun-only. Comparing `import.meta.url` to the
 * realpath of `process.argv[1]` works on both Node 20 and Bun, so this file
 * behaves the same regardless of which runtime execs the hook.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Load ~/.gemini/pinta-gemini.env BEFORE importing the hook, so loadConfig()
// (called inside runHook) sees the injected env (mirrors src/index.ts).
import { loadEnvFile } from "./env-file.js";
loadEnvFile();

import { runHook } from "./hook.js";
import { lifecycle } from "./lifecycle/scanner.js";

export { lifecycle };

function isDirectlyExecuted(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    // process.argv[1] missing/unreadable (REPL, unusual host) — err on the
    // side of NOT running the hook, the safer default for an import() caller.
    return false;
  }
}

if (isDirectlyExecuted()) {
  runHook();
}
