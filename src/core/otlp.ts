/**
 * OTLP span builder — multi-host Bronze flatten (SPEC §9).
 *
 * span name = "<ingest>.<snake(hook)>"; attributes = ingest.type + <prefix>.*
 * (every top-level event field) + pinta.guard.* when guarded. Resource carries
 * service.name per host family + host/process info. ULID → 32-hex traceId.
 */
import crypto from "crypto";
import os from "os";
import type { Agent, Canonical, RawEvent } from "./types.js";
import { identity } from "./types.js";
import { redact, truncate } from "./redact.js";
import type { GuardResult } from "./guard.js";

export const PLUGIN_VERSION = "0.3.0";

export interface OtlpAttribute {
  key: string;
  value: { stringValue: string } | { intValue: number } | { doubleValue: number } | { boolValue: boolean };
}
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
}
export interface ResourceSpans {
  resource: { attributes: OtlpAttribute[] };
  scopeSpans: Array<{ scope: { name: string; version: string }; spans: OtlpSpan[] }>;
}
export interface OtlpPayload {
  resourceSpans: ResourceSpans[];
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulidToTraceId(ulid: string): string {
  if (ulid.length !== 26) throw new Error(`ulidToTraceId: expected 26 chars, got ${ulid.length}`);
  let n = 0n;
  for (const ch of ulid) {
    const idx = CROCKFORD.indexOf(ch);
    if (idx < 0) throw new Error(`ulidToTraceId: invalid Crockford char "${ch}"`);
    n = (n << 5n) | BigInt(idx);
  }
  n &= (1n << 128n) - 1n;
  return n.toString(16).padStart(32, "0");
}

export function newSpanId(): string {
  return crypto.randomBytes(8).toString("hex");
}

function snakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function maybeRedactString(prefix: string, key: string, raw: string): string {
  const truncated = truncate(raw);
  const skip = new Set([`${prefix}.hook`, `${prefix}.agent`, `${prefix}.tool_name`, `${prefix}.session_id`, `${prefix}.transcript_path`, `${prefix}.transcriptPath`, `${prefix}.cwd`]);
  if (skip.has(key)) return truncated;
  const context = key === `${prefix}.tool_input` || key === `${prefix}.tool_response` || key === `${prefix}.toolCall` ? ("bash" as const) : undefined;
  return redact(truncated, { context });
}

function toOtlpValue(prefix: string, key: string, v: unknown): OtlpAttribute["value"] | null {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case "string":
      return { stringValue: maybeRedactString(prefix, key, v) };
    case "boolean":
      return { boolValue: v };
    case "number":
      return Number.isInteger(v) ? { intValue: v } : { doubleValue: v };
    case "object":
      try {
        return { stringValue: maybeRedactString(prefix, key, JSON.stringify(v)) };
      } catch {
        return { stringValue: maybeRedactString(prefix, key, String(v)) };
      }
    default:
      return { stringValue: maybeRedactString(prefix, key, String(v)) };
  }
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
  const ts = args.now ?? Date.now();
  const tsNano = (BigInt(ts) * 1_000_000n).toString();

  const attrs: OtlpAttribute[] = [
    { key: "ingest.type", value: { stringValue: id.ingest } },
    { key: `${id.prefix}.hook`, value: { stringValue: args.canonical.hook } },
    { key: `${id.prefix}.agent`, value: { stringValue: args.agent } },
  ];
  if (args.product) attrs.push({ key: `${id.prefix}.product`, value: { stringValue: args.product } });
  // Bronze: flatten every top-level event field under the prefix.
  for (const [k, v] of Object.entries(args.event)) {
    const key = `${id.prefix}.${k}`;
    const value = toOtlpValue(id.prefix, key, v);
    if (value !== null) attrs.push({ key, value });
  }
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
    if (val != null && !have.has(key)) attrs.push({ key, value: { stringValue: maybeRedactString(id.prefix, key, String(val)) } });
  }
  if (args.guard) {
    attrs.push(
      { key: "pinta.guard.decision", value: { stringValue: args.guard.decision.toLowerCase() } },
      { key: "pinta.guard.duration_ms", value: { intValue: args.guard.durationMs } },
    );
    if (args.guard.reason) attrs.push({ key: "pinta.guard.matched_rule", value: { stringValue: args.guard.reason } });
    if (args.guard.failOpenReason) attrs.push({ key: "pinta.guard.fail_open_reason", value: { stringValue: args.guard.failOpenReason } });
  }

  const span: OtlpSpan = {
    traceId: ulidToTraceId(args.traceId),
    spanId: newSpanId(),
    name: `${id.ingest}.${snakeCase(args.canonical.hook)}`,
    kind: 1,
    startTimeUnixNano: tsNano,
    endTimeUnixNano: tsNano,
    attributes: attrs,
  };
  return {
    resourceSpans: [{ resource: { attributes: resourceAttrs(id.service) }, scopeSpans: [{ scope: { name: "pinta-gemini", version: PLUGIN_VERSION }, spans: [span] }] }],
  };
}

export function mergeBatch(payloads: OtlpPayload[]): OtlpPayload {
  const out: ResourceSpans[] = [];
  for (const p of payloads) out.push(...p.resourceSpans);
  return { resourceSpans: out };
}
