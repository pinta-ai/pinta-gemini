/**
 * ~/.gemini/pinta-gemini.env loader (SPEC §12).
 *
 * The real host doesn't pass our env to the hook subprocess, so this file is the
 * injection vector for OTLP endpoint / guard endpoint / relay token / debug.
 * Merges only UNSET keys (explicit shell exports win). Missing file = no-op.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function envFilePath(): string {
  const home = process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
  return path.join(home, "pinta-gemini.env");
}

export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export function loadEnvFile(filePath: string = envFilePath()): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(parseEnvFile(content))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
