import { describe, it, expect } from "vitest";
import { normalize } from "../src/core/normalize";
import { formatDecision, returnedText } from "../src/core/decision";
import { parseInvocation, antigravityProduct } from "../src/core/agent";
import { gateEvent, identity, isSkippedHook } from "../src/core/types";
import { buildOtlpPayload, ulidToTraceId } from "../src/core/otlp";
import type { GuardResult } from "../src/core/guard";
import { attachGuard, DEFAULT_NOTICE, GUIDANCE_MASK, GUIDANCE_WITHHOLD } from "@pinta-ai/core";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV"; // 26 Crockford chars

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

  describe("gemini AfterTool deny (tool output, PTA-695)", () => {
    const SENSITIVE = "ctx7sk-FAKE0000";
    const mask: GuardResult = {
      ...deny, userMessage: "Credential in tool output", evaluationId: "ev-1",
      outputAction: "mask", redactions: [{ category: "CREDENTIAL", match: SENSITIVE }],
    };
    it("mask: reason = notice + guidance + masked llmContent string; systemMessage = notice", () => {
      const out = formatDecision("gemini", "AfterTool", mask, { llmContent: `key ${SENSITIVE} here`, returnDisplay: "x" });
      expect(out).toEqual({
        decision: "deny",
        reason: `Credential in tool output (evaluation ev-1)\n\n${GUIDANCE_MASK(1, "ev-1")}\n\nkey [REDACTED:CREDENTIAL] here`,
        systemMessage: "Credential in tool output (evaluation ev-1)",
      });
      expect(out.reason).not.toContain(SENSITIVE);
    });
    it("mask: non-string llmContent (parts) is masked as JSON", () => {
      const out = formatDecision("gemini", "AfterTool", mask, { llmContent: [{ text: `k ${SENSITIVE}` }] });
      expect(out.reason).toContain(`[{"text":"k [REDACTED:CREDENTIAL]"}]`);
      expect(out.reason).not.toContain(SENSITIVE);
    });
    it("mask: no llmContent → whole tool_response JSON is masked", () => {
      const out = formatDecision("gemini", "AfterTool", mask, { output: SENSITIVE });
      expect(out.reason).toContain(`{"output":"[REDACTED:CREDENTIAL]"}`);
      expect(out.reason).not.toContain(SENSITIVE);
    });
    it("mask requested but value absent from output → withhold (no output delivered)", () => {
      const out = formatDecision("gemini", "AfterTool", mask, { llmContent: "nothing sensitive" });
      expect(out.reason).toBe(`Credential in tool output (evaluation ev-1)\n\n${GUIDANCE_WITHHOLD("ev-1")}`);
      expect(out.reason).not.toContain("nothing sensitive");
    });
    it("old manager (no outputAction) → withhold with userMessage; never the guard reason", () => {
      const out = formatDecision("gemini", "AfterTool", { ...deny, reason: "rule-id" }, { llmContent: "the output" });
      expect(out).toEqual({
        decision: "deny",
        reason: `⛔ blocked\n\n${GUIDANCE_WITHHOLD()}`,
        systemMessage: "⛔ blocked",
      });
      expect(out.reason).not.toContain("rule-id");
      expect(out.reason).not.toContain("the output");
    });
    it("no userMessage → DEFAULT_NOTICE", () => {
      const out = formatDecision("gemini", "AfterTool", { ...deny, userMessage: null }, { llmContent: "o" });
      expect(out.systemMessage).toBe(DEFAULT_NOTICE);
      expect(out.reason!.startsWith(`${DEFAULT_NOTICE}\n\n`)).toBe(true);
    });
    it("returnedText: string llmContent as is, parts as JSON, missing response as empty", () => {
      expect(returnedText({ llmContent: "s" })).toBe("s");
      expect(returnedText({ llmContent: [{ text: "p" }] })).toBe(`[{"text":"p"}]`);
      expect(returnedText({ a: 1 })).toBe(`{"a":1}`);
      expect(returnedText(undefined)).toBe("");
    });
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
  it("carries no guard attrs itself; the verdict is attached to the same span afterwards", () => {
    const c = normalize("gemini", "BeforeTool", { session_id: "s1" });
    const guard: GuardResult = { decision: "DENY", reason: "rule_x", userMessage: null, durationMs: 5 };
    const p = buildOtlpPayload({ agent: "gemini", canonical: c, event: { session_id: "s1" }, traceId: ULID });
    expect(p.resourceSpans[0].scopeSpans[0].spans[0].attributes.some((a) => a.key.startsWith("pinta.guard."))).toBe(false);
    attachGuard(p, guard);
    const attrs = Object.fromEntries(p.resourceSpans[0].scopeSpans[0].spans[0].attributes.map((a) => [a.key, (a.value as any).stringValue ?? (a.value as any).intValue]));
    expect(attrs["pinta.guard.decision"]).toBe("deny");
    expect(attrs["pinta.guard.matched_rule"]).toBe("rule_x");
  });
});

/**
 * What the guard is told about the invocation.
 *
 * `normalize` already lifts `cwd` out of both host shapes — gemini's `cwd` and
 * antigravity's `workspacePaths[0]` — and the canonical event carries `hook`.
 * Both were being dropped at the guard call.
 *
 * `cwd` locates a relative target: `rm -rf passwd` reads as routine work until
 * you know it was issued from /etc (PTA-176). `hook` is what lets the manager
 * trust the tool name, since Claude Code owns those names and neither gemini
 * nor antigravity does, so without it a tool called `Read` is taken at its
 * word and its arguments are read as content (PTA-207).
 */
describe("normalize carries what the guard needs", () => {
  it("lifts gemini's cwd and hook", () => {
    const c = normalize("gemini", undefined, {
      hook_event_name: "PreToolUse",
      session_id: "s1",
      cwd: "/etc",
      tool_name: "run_shell_command",
      tool_input: { command: "rm -rf passwd" },
    });
    expect(c).toMatchObject({ cwd: "/etc", hook: "PreToolUse" });
  });

  it("lifts antigravity's workspace path as the cwd", () => {
    const c = normalize("antigravity", "PreToolUse", {
      conversationId: "c1",
      workspacePaths: ["/etc", "/tmp"],
      toolCall: { name: "run_command", args: { command: "rm -rf passwd" } },
    });
    expect(c).toMatchObject({ cwd: "/etc", hook: "PreToolUse" });
  });
});
