/**
 * OTLP/HTTP transport (SPEC §9, §13) — gemini binding over the shared
 * DiskTransport in @pinta-ai/core. Keeps the `new Transport(config)` call shape
 * and the config-driven endpoint/headers resolution (gemini resolves these from
 * GEMINI_PLUGIN_OPTION_* / OTEL_* into PintaConfig at startup, so the transport
 * reads them off the config rather than re-reading env vars). On send failure
 * the payload is persisted to disk and a later hook's flush() drains it.
 */
import { DiskTransport, DiskRetryQueue, MAX_POST_BYTES, type OtlpPayload } from "@pinta-ai/core";
import type { PintaConfig } from "./config.js";

export class Transport extends DiskTransport {
  constructor(config: PintaConfig) {
    super({
      pluginData: config.pluginData,
      logPrefix: "pinta-gemini",
      resolveOptions: () =>
        config.endpoint
          ? { endpoint: config.endpoint, headers: config.headers }
          : null,
    });
  }
}

export function deferPayload(payload: OtlpPayload, config: PintaConfig): void {
  if (!config.endpoint) return;
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_POST_BYTES) {
    process.stderr.write("[pinta-gemini] deferred telemetry exceeds MAX_POST_BYTES; dropped\n");
    return;
  }
  new DiskRetryQueue(config.pluginData, "pinta-gemini").enqueue(payload);
}
