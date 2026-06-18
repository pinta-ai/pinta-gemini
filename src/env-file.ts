/**
 * ~/.gemini/pinta-gemini.env loader (SPEC §12) — gemini binding over @pinta-ai/core.
 *
 * The real host doesn't pass our env to the hook subprocess, so this file is the
 * injection vector for OTLP endpoint / guard endpoint / relay token / debug.
 * Merges only UNSET keys (explicit shell exports win). Missing file = no-op.
 *
 * The parser + merge semantics live in the shared package; this module only
 * binds gemini's path (honoring the GEMINI_HOME override, which the shared
 * `envFilePath(dir, filename, overrideEnvVar)` helper handles directly).
 */
import {
  envFilePath as coreEnvFilePath,
  loadEnvFile as coreLoadEnvFile,
  parseEnvFile,
} from "@pinta-ai/core";

export { parseEnvFile };

export function envFilePath(): string {
  return coreEnvFilePath(".gemini", "pinta-gemini.env", "GEMINI_HOME");
}

export function loadEnvFile(filePath: string = envFilePath()): void {
  coreLoadEnvFile(filePath);
}
