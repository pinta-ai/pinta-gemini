/**
 * ~/.gemini/pinta-gemini.env loader (SPEC §12) — gemini binding over @pinta-ai/core.
 *
 * The real host doesn't pass our env to the hook subprocess, so this file is the
 * injection vector for OTLP endpoint / guard endpoint / relay token / debug.
 * Merges only UNSET keys (explicit shell exports win). Missing file = no-op.
 *
 * The parser + merge semantics live in the shared package; this module only
 * binds gemini's path (honoring the GEMINI_HOME override, which the shared
 * `envFilePath(dir, filename)` helper does not handle).
 */
import os from "node:os";
import path from "node:path";
import { loadEnvFile as coreLoadEnvFile, parseEnvFile } from "@pinta-ai/core";

export { parseEnvFile };

export function envFilePath(): string {
  const home = process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
  return path.join(home, "pinta-gemini.env");
}

export function loadEnvFile(filePath: string = envFilePath()): void {
  coreLoadEnvFile(filePath);
}
