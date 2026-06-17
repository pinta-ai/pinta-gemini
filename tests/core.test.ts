import { describe, it, expect } from "vitest";
import { normalize } from "../src/core/normalize";
import { formatDecision } from "../src/core/decision";
import { parseInvocation, antigravityProduct } from "../src/core/agent";
import { gateEvent, identity, isSkippedHook } from "../src/core/types";
import { buildOtlpPayload, ulidToTraceId } from "../src/core/otlp";
import type { GuardResult } from "../src/core/guard";
import { shellCommandText } from "../src/core/guard";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV"; // 26 Crockford chars

describe("shellCommandText", () => {
  it("reads Gemini CLI's `command`", () => {
    expect(shellCommandText({ command: "npm i evil@1.0.0" })).toBe("npm i evil@1.0.0");
  });
  it("reads Antigravity's PascalCase `CommandLine`", () => {
    expect(shellCommandText({ CommandLine: "npm i evil@1.0.0" })).toBe("npm i evil@1.0.0");
  });
  it("returns undefined for non-shell shapes (caller keeps JSON fallback)", () => {
    expect(shellCommandText({ file_path: "/a", content: "x" })).toBeUndefined();
    expect(shellCommandText(undefined)).toBeUndefined();
    expect(shellCommandText("already a string")).toBeUndefined();
    expect(shellCommandText({ command: 123 })).toBeUndefined();
  });
});

describe("normalize", () => {
  it("gemini: snake_case → canonical", () => {
    const c = normalize("gemini", "BeforeTool", { session_id: "s1", cwd: "/w", tool_name: "run_shell_command", tool_input: { command: "ls" } });
    expect(c).toMatchObject({ hook: "BeforeTool", session_id: "s1", cwd: "/w", tool_name: "run_shell_command" });
  });
  it("antigravity: camelCase → canonical (conversationId/workspacePaths/toolCall)", () => {
    const c = normalize("antigravity", "PreToolUse", { conversationId: "c1", workspacePaths: ["/w"], toolCall: { name: "run_command", args: { CommandLine: "ls" } } });
    expect(c).toMatchObject({ hook: "PreToolUse", session_id: "c1", cwd: "/w", tool_name: "run_command" });
    expect(c.tool_input).toEqual({ CommandLine: "ls" });
  });
  it("antigravity PostToolUse toolCall:null → tool_name undefined (F.3)", () => {
    const c = normalize("antigravity", "PostToolUse", { conversationId: "c1", workspacePaths: ["/w"], toolCall: null, error: "" });
    expect(c.tool_name).toBeUndefined();
  });
  it("falls back to hook_event_name when --event missing (gemini)", () => {
    expect(normalize("gemini", undefined, { hook_event_name: "SessionStart" }).hook).toBe("SessionStart");
  });
});

describe("formatDecision (host-aware)", () => {
  const deny: GuardResult = { decision: "DENY", reason: "r", userMessage: "⛔ blocked", durationMs: 1 };
  it("gemini deny → {decision,reason,systemMessage}", () => {
    expect(formatDecision("gemini", "BeforeTool", deny)).toEqual({ decision: "deny", reason: "⛔ blocked", systemMessage: "⛔ blocked" });
  });
  it("antigravity deny → {decision,reason} (no systemMessage)", () => {
    const out = formatDecision("antigravity", "PreToolUse", deny);
    expect(out).toEqual({ decision: "deny", reason: "⛔ blocked" });
    expect("systemMessage" in out).toBe(false);
  });
  it("gemini allow → {}", () => {
    expect(formatDecision("gemini", "BeforeTool", null)).toEqual({});
  });
  it("antigravity PreToolUse allow → {decision:'allow'} (required)", () => {
    expect(formatDecision("antigravity", "PreToolUse", null)).toEqual({ decision: "allow" });
  });
  it("antigravity non-gate allow → {}", () => {
    expect(formatDecision("antigravity", "PostToolUse", null)).toEqual({});
  });
});

describe("agent identification", () => {
  it("parseInvocation reads --agent/--event", () => {
    expect(parseInvocation(["node", "x", "--agent", "antigravity", "--event", "Stop"])).toEqual({ agent: "antigravity", event: "Stop" });
  });
  it("defaults agent to gemini", () => {
    expect(parseInvocation(["node", "x"]).agent).toBe("gemini");
  });
  it("antigravityProduct from transcriptPath (DG11)", () => {
    expect(antigravityProduct({ transcriptPath: "/h/.gemini/antigravity-cli/brain/x/logs/transcript_full.jsonl" })).toBe("agy");
    expect(antigravityProduct({ transcriptPath: "/h/.gemini/antigravity/brain/x/logs/transcript.jsonl" })).toBe("antigravity2");
    expect(antigravityProduct({})).toBeUndefined();
  });
});

describe("types helpers", () => {
  it("gate event per family", () => {
    expect(gateEvent("gemini")).toBe("BeforeTool");
    expect(gateEvent("antigravity")).toBe("PreToolUse");
  });
  it("identity per family", () => {
    expect(identity("gemini")).toMatchObject({ ingest: "gemini", service: "gemini-cli" });
    expect(identity("antigravity")).toMatchObject({ ingest: "antigravity", service: "antigravity-cli" });
  });
  it("skips AfterModel only", () => {
    expect(isSkippedHook("AfterModel")).toBe(true);
    expect(isSkippedHook("AfterTool")).toBe(false);
  });
});

describe("otlp", () => {
  it("ulidToTraceId → 32 hex", () => {
    const t = ulidToTraceId(ULID);
    expect(t).toMatch(/^[0-9a-f]{32}$/);
  });
  it("gemini span: ingest.type + canonical session_id + service.name", () => {
    const c = normalize("gemini", "BeforeTool", { session_id: "s1", cwd: "/w", tool_name: "t", tool_input: {} });
    const p = buildOtlpPayload({ agent: "gemini", canonical: c, event: { session_id: "s1", tool_name: "t" }, traceId: ULID });
    const span = p.resourceSpans[0].scopeSpans[0].spans[0];
    const attrs = Object.fromEntries(span.attributes.map((a) => [a.key, (a.value as any).stringValue]));
    expect(span.name).toBe("gemini.before_tool");
    expect(attrs["ingest.type"]).toBe("gemini");
    expect(attrs["gemini.session_id"]).toBe("s1");
    expect(p.resourceSpans[0].resource.attributes.find((a) => a.key === "service.name")?.value).toEqual({ stringValue: "gemini-cli" });
  });
  it("antigravity span: canonical session_id derived from conversationId", () => {
    const ev = { conversationId: "c1", workspacePaths: ["/w"], toolCall: { name: "run_command", args: {} } };
    const c = normalize("antigravity", "PreToolUse", ev);
    const p = buildOtlpPayload({ agent: "antigravity", canonical: c, event: ev, traceId: ULID, product: "agy" });
    const span = p.resourceSpans[0].scopeSpans[0].spans[0];
    const attrs = Object.fromEntries(span.attributes.map((a) => [a.key, (a.value as any).stringValue]));
    expect(attrs["ingest.type"]).toBe("antigravity");
    expect(attrs["antigravity.session_id"]).toBe("c1"); // canonical from conversationId
    expect(attrs["antigravity.product"]).toBe("agy");
  });
  it("guard attrs present when guarded", () => {
    const c = normalize("gemini", "BeforeTool", { session_id: "s1" });
    const guard: GuardResult = { decision: "DENY", reason: "rule_x", userMessage: null, durationMs: 5 };
    const p = buildOtlpPayload({ agent: "gemini", canonical: c, event: { session_id: "s1" }, traceId: ULID, guard });
    const attrs = Object.fromEntries(p.resourceSpans[0].scopeSpans[0].spans[0].attributes.map((a) => [a.key, (a.value as any).stringValue ?? (a.value as any).intValue]));
    expect(attrs["pinta.guard.decision"]).toBe("deny");
    expect(attrs["pinta.guard.matched_rule"]).toBe("rule_x");
  });
});
