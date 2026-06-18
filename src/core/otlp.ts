/**
 * OTLP span builder — multi-host Bronze flatten (SPEC §9).
 *
 * span name = "<ingest>.<snake(hook)>"; attributes = ingest.type + <prefix>.*
 * (every top-level event field) + pinta.guard.* when guarded. Resource carries
 * service.name per host family + host/process info. ULID → 32-hex traceId.
 *
 * The OTLP envelope + the redaction-aware attribute pipeline now live in
 * @pinta-ai/core. This module keeps only the gemini-specific bits: multi-host
 * identity (ingest.type / prefix / service.name), the cross-host canonical key
 * merge, resource attributes, and the per-prefix redaction policy.
 */
import os from "os";
import type { Agent, Canonical, RawEvent } from "./types.js";
import { identity } from "./types.js";
import {
  attrsFromRecord,
  buildPayload,
  mergeBatch,
  snakeCase,
  toOtlpValue,
  type AttrPolicy,
  type GuardResult,
  type OtlpAttribute,
  type OtlpPayload,
} from "@pinta-ai/core";

// Re-exported so the rest of the adapter keeps its existing import surface.
export {
  mergeBatch,
  ulidToTraceId,
  newSpanId,
} from "@pinta-ai/core";
export type {
  OtlpAttribute,
  OtlpSpan,
  ResourceSpans,
  OtlpPayload,
} from "@pinta-ai/core";

export const PLUGIN_VERSION = "0.4.1";

/**
 * Redaction policy for a given host prefix. Skip keys are identifiers / our own
 * keys (truncation still applies); bash-context keys may carry shell command
 * text (Gemini's tool_input/tool_response, Antigravity's toolCall).
 */
function attrPolicy(prefix: string): AttrPolicy {
  return {
    skipRedactKeys: new Set([
      `${prefix}.hook`,
      `${prefix}.agent`,
      `${prefix}.tool_name`,
      `${prefix}.session_id`,
      `${prefix}.transcript_path`,
      `${prefix}.transcriptPath`,
      `${prefix}.cwd`,
    ]),
    bashContextKeys: new Set([
      `${prefix}.tool_input`,
      `${prefix}.tool_response`,
      `${prefix}.toolCall`,
    ]),
  };
}

function resourceAttrs(serviceName: string): OtlpAttribute[] {
  return [
    { key: "service.name", value: { stringValue: serviceName } },
    { key: "telemetry.sdk.name", value: { stringValue: "pinta-gemini" } },
    { key: "telemetry.sdk.language", value: { stringValue: "nodejs" } },
    { key: "telemetry.sdk.version", value: { stringValue: PLUGIN_VERSION } },
    { key: "process.pid", value: { intValue: process.pid } },
    { key: "process.owner", value: { stringValue: os.userInfo().username } },
    { key: "host.name", value: { stringValue: os.hostname() } },
    { key: "host.arch", value: { stringValue: os.arch() } },
  ];
}

export function buildOtlpPayload(args: {
  agent: Agent;
  canonical: Canonical;
  event: RawEvent;
  traceId: string; // ULID (26)
  now?: number;
  guard?: GuardResult | null;
  product?: string; // DG11 antigravity sub-label
}): OtlpPayload {
  const id = identity(args.agent);
  const policy = attrPolicy(id.prefix);

  const attrs: OtlpAttribute[] = [
    { key: "ingest.type", value: { stringValue: id.ingest } },
    { key: `${id.prefix}.hook`, value: { stringValue: args.canonical.hook } },
    { key: `${id.prefix}.agent`, value: { stringValue: args.agent } },
  ];
  if (args.product) attrs.push({ key: `${id.prefix}.product`, value: { stringValue: args.product } });
  // Bronze: flatten every top-level event field under the prefix.
  attrs.push(...attrsFromRecord(args.event, id.prefix, policy));
  // Canonical cross-host keys — uniform `<prefix>.session_id|cwd|tool_name` so
  // queries work the same for gemini (snake raw) and antigravity (camel raw,
  // e.g. conversationId/workspacePaths). Only added when Bronze didn't already
  // emit the key (gemini's raw session_id already produces gemini.session_id).
  const have = new Set(attrs.map((a) => a.key));
  for (const [field, val] of [
    ["session_id", args.canonical.session_id],
    ["cwd", args.canonical.cwd],
    ["tool_name", args.canonical.tool_name],
  ] as const) {
    const key = `${id.prefix}.${field}`;
    if (val != null && !have.has(key)) {
      const value = toOtlpValue(key, String(val), policy);
      if (value !== null) attrs.push({ key, value });
    }
  }

  return buildPayload({
    traceId: args.traceId,
    spanName: `${id.ingest}.${snakeCase(args.canonical.hook)}`,
    attributes: attrs,
    resource: resourceAttrs(id.service),
    scope: { name: "pinta-gemini", version: PLUGIN_VERSION },
    now: args.now,
    guard: args.guard,
  });
}
