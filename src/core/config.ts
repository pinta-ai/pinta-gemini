/**
 * Runtime config (SPEC §9.1, §12).
 *
 * The real host does NOT pass our env to the hook subprocess, so endpoint/guard
 * config is loaded from ~/.gemini/pinta-gemini.env (env-file.ts) into process.env
 * at startup, then resolved here. Namespaced GEMINI_PLUGIN_OPTION_* wins over
 * OTEL_* (avoids colliding with Gemini's own OpenTelemetry).
 *
 * Data dir is anchored under the Gemini home (stable, cwd-independent) so the
 * per-turn trace written by one hook is readable by the next.
 */
import os from "os";
import path from "path";
import { parseHeadersEnv } from "@pinta-ai/core";

export interface PintaConfig {
  pluginData: string;
  tracePath: string;
  endpoint?: string;
  headers: Record<string, string>;
  guardEndpoint?: string;
}

function geminiHome(): string {
  return process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
}

function resolveEndpoint(): string | undefined {
  const traces = process.env.GEMINI_PLUGIN_OPTION_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (traces) return traces.replace(/\/+$/, "");
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (base) return base.replace(/\/+$/, "") + "/v1/traces";
  return undefined;
}

function resolveHeaders(): Record<string, string> {
  const headers = parseHeadersEnv(process.env.GEMINI_PLUGIN_OPTION_HEADERS || process.env.OTEL_EXPORTER_OTLP_HEADERS);
  const apiKey = process.env.GEMINI_PLUGIN_OPTION_API_KEY;
  if (apiKey && !headers["x-pinta-relay-token"]) headers["x-pinta-relay-token"] = apiKey;
  return headers;
}

export function loadConfig(): PintaConfig {
  const pluginData = process.env.GEMINI_PLUGIN_DATA || path.join(geminiHome(), "pinta-gemini-data");
  // guard now takes its relay token from config.headers['x-pinta-relay-token']
  // (same source as the trace transport — GEMINI_PLUGIN_OPTION_HEADERS), so the
  // two no longer diverge. This bootstrap stays only as a back-compat fallback
  // for the bare-token enrollment form (GEMINI_PLUGIN_OPTION_API_KEY).
  if (!process.env.PINTA_RELAY_TOKEN && process.env.GEMINI_PLUGIN_OPTION_API_KEY) {
    process.env.PINTA_RELAY_TOKEN = process.env.GEMINI_PLUGIN_OPTION_API_KEY;
  }
  return {
    pluginData,
    tracePath: path.join(pluginData, "trace.json"),
    endpoint: resolveEndpoint(),
    headers: resolveHeaders(),
    guardEndpoint: process.env.PINTA_GUARD_ENDPOINT,
  };
}
