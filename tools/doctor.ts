/**
 * doctor — read-only health check for a pinta-gemini install (SPEC §15).
 * Verifies: adapter built, env-file/endpoints, and hook install state per host.
 *   npx tsx tools/doctor.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const ENTRY = path.join(REPO, "dist", "index.js");
const HOME = process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini");

const ok = (b: boolean) => (b ? "✅" : "❌");
const warn = (b: boolean) => (b ? "✅" : "⚠️ ");

function readJson(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return undefined;
  }
}

console.log(`pinta-gemini doctor   (home: ${HOME})\n`);

// 1. adapter built
console.log(`${ok(fs.existsSync(ENTRY))} adapter built: ${ENTRY}${fs.existsSync(ENTRY) ? "" : "  → npm run build"}`);

// 2. env-file + endpoints
const envFile = path.join(HOME, "pinta-gemini.env");
const env = fs.existsSync(envFile) ? Object.fromEntries(fs.readFileSync(envFile, "utf-8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])) : {};
const otlp = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.GEMINI_PLUGIN_OPTION_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.GEMINI_PLUGIN_OPTION_ENDPOINT;
const guard = process.env.PINTA_GUARD_ENDPOINT || env.PINTA_GUARD_ENDPOINT;
console.log(`${warn(fs.existsSync(envFile))} env-file: ${fs.existsSync(envFile) ? envFile : "(none — set OTEL_/PINTA_GUARD_ vars or write the env-file)"}`);
console.log(`${warn(Boolean(otlp))} OTLP endpoint: ${otlp ?? "(unset → telemetry disabled)"}`);
console.log(`${warn(Boolean(guard))} guard endpoint: ${guard ?? "(unset → guard disabled, all ALLOW)"}`);

// 3. install state per host
const extHooks = path.join(HOME, "extensions", "pinta-gemini", "hooks", "hooks.json");
const extManifest = path.join(HOME, "extensions", "pinta-gemini", "gemini-extension.json");
const geminiInstalled = fs.existsSync(extManifest) && Boolean(readJson(extHooks)?.hooks);
console.log(`\n${warn(geminiInstalled)} gemini install (extension): ${geminiInstalled ? extHooks : "(not installed → npm run install-hooks -- --agent gemini)"}`);

const agCfg = path.join(HOME, "config", "hooks.json");
const agInstalled = Boolean(readJson(agCfg)?.["pinta-gemini"]);
console.log(`${warn(agInstalled)} antigravity install (global config): ${agInstalled ? agCfg : "(not installed → npm run install-hooks -- --agent antigravity)"}`);
if (agInstalled) {
  const events = Object.keys(readJson(agCfg)["pinta-gemini"]);
  console.log(`    events: ${events.join(", ")}`);
}

// 4. recent captures
const log = path.join(HOME, "pinta-gemini-data", "invocations.jsonl");
if (fs.existsSync(log)) {
  const n = fs.readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).length;
  console.log(`\nℹ️  ${n} captured invocations: ${log}`);
}
