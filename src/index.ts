/**
 * pinta-gemini — unified OTLP forwarder + guard adapter for Gemini CLI and
 * Antigravity (agy v1.0.x / 2.0). CJS-shaped direct-exec entry (SPEC §4, §5).
 *
 * Host runs: `node dist/index.js --agent <a> --event <e>` with event JSON on
 * stdin. This file is ALWAYS direct-exec'd by the host, so it just loads the
 * env-file and runs the hook. The importable dual-entry (with the `lifecycle`
 * export + a direct-exec guard) lives in `src/index.mts` → `dist/index.mjs`.
 *
 * The hook body itself lives in `src/hook.ts`, shared by both entries.
 */
import { loadEnvFile } from "./env-file.js";
loadEnvFile(); // must run before config reads process.env

import { runHook } from "./hook.js";

runHook();
