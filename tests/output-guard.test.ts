import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agent: "gemini", event: "AfterTool", evaluate: vi.fn(),
  send: vi.fn(), flush: vi.fn(), enqueue: vi.fn(),
  endpoint: "http://127.0.0.1/traces",
}));
vi.mock("../src/core/config.js", () => ({
  loadConfig: () => ({ pluginData: process.cwd(), endpoint: mocks.endpoint, headers: {} }),
}));
vi.mock("../src/core/agent.js", async (original) => ({
  ...await original<typeof import("../src/core/agent.js")>(),
  parseInvocation: () => ({ agent: mocks.agent, event: mocks.event }),
}));
vi.mock("../src/core/guard.js", () => ({ evaluateGuard: mocks.evaluate }));
vi.mock("../src/core/transport.js", async original => ({
  ...await original<typeof import("../src/core/transport.js")>(),
  Transport: class { flush = mocks.flush; send = mocks.send; },
}));
vi.mock("../src/core/trace.js", () => ({
  TraceManager: class { currentTrace() { return "1".repeat(26); } },
}));
vi.mock("../src/core/host-version.js", () => ({ hostVersion: () => "0.59.0" }));
vi.mock("@pinta-ai/core", async (original) => ({
  ...await original<typeof import("@pinta-ai/core")>(),
  DiskRetryQueue: class { enqueue = mocks.enqueue; },
}));
import { runHook } from "../src/hook.js";
import { isGuardEvent } from "../src/core/types.js";
import { DEFAULT_NOTICE, GUIDANCE_MASK, GUIDANCE_WITHHOLD } from "@pinta-ai/core";

const SENSITIVE = "ctx7sk-FAKE0000";
const WITHHELD = { decision: "deny", reason: `${DEFAULT_NOTICE}\n\n${GUIDANCE_WITHHOLD()}`, systemMessage: DEFAULT_NOTICE };

let output: string[];
let response: unknown;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.agent = "gemini";
  mocks.event = "AfterTool";
  mocks.endpoint = "http://127.0.0.1/traces";
  output = [];
  response = { llmContent: "audit result", returnDisplay: "audit result" };
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
    yield Buffer.from(JSON.stringify({
      hook_event_name: mocks.event, tool_name: "run_shell_command",
      session_id: "audit", cwd: process.cwd(),
      tool_input: { command: "printf audit" },
      ...(mocks.event === "AfterTool" ? { tool_response: response } : {}),
    }));
  } as never);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.stubEnv("PINTA_GEMINI_HOST_VERSION", "0.59.0");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const deny = { decision: "DENY", reason: "output-policy", durationMs: 1 };

describe("Gemini output enforcement", () => {
  it.each([false, true])("guards native tool_response including error=%s", async (failed) => {
    if (failed) response = { llmContent: "audit error", returnDisplay: "audit error", error: { type: "execution_failed", message: "audit error" } };
    mocks.evaluate.mockResolvedValue(deny);
    await runHook();
    expect(output.map(line => JSON.parse(line))).toEqual([WITHHELD]);
    const payload = mocks.evaluate.mock.calls[0][0];
    const attrs = Object.fromEntries(payload.resourceSpans[0].scopeSpans[0].spans[0].attributes.map((a: any) => [a.key, a.value]));
    expect(attrs).toMatchObject({
      "gemini.hook": { stringValue: "AfterTool" },
      "gemini.tool_response": { stringValue: JSON.stringify(response) },
      "pinta.guard.decision": { stringValue: "deny" },
      "pinta.guard.target": { stringValue: "tool_output" },
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(payload);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.flush).not.toHaveBeenCalled();
  });

  it.each(["BeforeTool", "AfterTool"])("%s DENY never waits for backlog or collector", async (event) => {
    mocks.event = event;
    mocks.evaluate.mockResolvedValue(deny);
    mocks.flush.mockImplementation(() => new Promise(() => {}));
    mocks.send.mockImplementation(() => new Promise(() => {}));
    await runHook();
    expect(JSON.parse(output[0]).decision).toBe("deny");
    expect(mocks.flush).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("retains DENY if queue persistence fails", async () => {
    mocks.evaluate.mockResolvedValue(deny);
    mocks.enqueue.mockImplementation(() => {
      expect(output).toHaveLength(1);
      throw new Error("queue unavailable");
    });
    await runHook();
    expect(JSON.parse(output[0]).decision).toBe("deny");
    expect(output).toHaveLength(1);
  });

  it("withhold (old manager, no outputAction): policy userMessage + withhold guidance, never the rule id or the output", async () => {
    mocks.evaluate.mockResolvedValue({ ...deny, reason: "RULE_ID_MARKER", userMessage: "Blocked by org policy" });
    await runHook();
    expect(output.map(line => JSON.parse(line))).toEqual([{
      decision: "deny",
      reason: `Blocked by org policy\n\n${GUIDANCE_WITHHOLD()}`,
      systemMessage: "Blocked by org policy",
    }]);
    expect(output[0]).not.toContain("RULE_ID_MARKER");
    expect(output[0]).not.toContain("audit result");
    expect(mocks.enqueue).toHaveBeenCalledWith(mocks.evaluate.mock.calls[0][0]);
  });

  it("withhold (explicit): notice carries the evaluation id", async () => {
    mocks.evaluate.mockResolvedValue({ ...deny, userMessage: "Prompt injection in output", evaluationId: "ev-7", outputAction: "withhold" });
    await runHook();
    const out = output.map(line => JSON.parse(line));
    expect(out).toEqual([{
      decision: "deny",
      reason: `Prompt injection in output (evaluation ev-7)\n\n${GUIDANCE_WITHHOLD("ev-7")}`,
      systemMessage: "Prompt injection in output (evaluation ev-7)",
    }]);
    expect(output[0]).not.toContain("audit result");
  });

  it("mask: delivers the output with only the detected value masked, stdout before telemetry, nothing leaked onto the span", async () => {
    response = { llmContent: `token ${SENSITIVE} found`, returnDisplay: "…" };
    const guard = {
      ...deny, userMessage: "Credential in tool output", evaluationId: "ev-1",
      outputAction: "mask", redactions: [{ category: "CREDENTIAL", match: SENSITIVE }],
    };
    mocks.evaluate.mockResolvedValue(guard);
    mocks.enqueue.mockImplementation(() => { expect(output).toHaveLength(1); });
    await runHook();

    const out = output.map(line => JSON.parse(line));
    expect(out).toEqual([{
      decision: "deny",
      reason: `Credential in tool output (evaluation ev-1)\n\n${GUIDANCE_MASK(1, "ev-1")}\n\ntoken [REDACTED:CREDENTIAL] found`,
      systemMessage: "Credential in tool output (evaluation ev-1)",
    }]);
    expect(out[0]).not.toHaveProperty("continue");
    expect(output[0]).not.toContain(SENSITIVE);
    expect(output[0]).toContain("[REDACTED:CREDENTIAL]");
    expect(output[0]).toContain("evaluation ev-1");

    // Decided DENY: deferred to the queue, never awaiting collector IO.
    const payload = mocks.evaluate.mock.calls[0][0];
    expect(mocks.enqueue).toHaveBeenCalledWith(payload);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.flush).not.toHaveBeenCalled();

    // The span carries the verdict and target, but no redaction values beyond
    // the judged tool_response itself: no `redactions`/`match` attribute, and
    // no pinta.guard.* attribute quoting the secret.
    const attrs = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes as Array<{ key: string; value: any }>;
    const byKey = Object.fromEntries(attrs.map(a => [a.key, a.value]));
    expect(byKey).toMatchObject({
      "pinta.guard.decision": { stringValue: "deny" },
      "pinta.guard.target": { stringValue: "tool_output" },
    });
    // `pinta.guard.matched_rule` is the rule id and is fine; the banned keys are the
    // redaction list, its `match` values and the delivery advice.
    expect(attrs.some(a => /redaction|\.match$|outputAction|output_action/i.test(a.key))).toBe(false);
    for (const a of attrs.filter(a => a.key.startsWith("pinta.guard."))) {
      expect(JSON.stringify(a.value)).not.toContain(SENSITIVE);
    }
  });

  it("mask requested but the value is not in the output → withhold", async () => {
    mocks.evaluate.mockResolvedValue({
      ...deny, userMessage: "Credential in tool output", evaluationId: "ev-2",
      outputAction: "mask", redactions: [{ category: "CREDENTIAL", match: SENSITIVE }],
    });
    await runHook();
    const out = JSON.parse(output[0]);
    expect(out.reason).toBe(`Credential in tool output (evaluation ev-2)\n\n${GUIDANCE_WITHHOLD("ev-2")}`);
    expect(out.reason).not.toContain("audit result");
    expect(output).toHaveLength(1);
  });

  it("does not retain telemetry in guard-only mode", async () => {
    mocks.endpoint = "";
    mocks.evaluate.mockResolvedValue(deny);
    await runHook();
    expect(JSON.parse(output[0]).decision).toBe("deny");
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.flush).not.toHaveBeenCalled();
  });

  it.each(["ALLOW", "REVIEW", null])("retains %s behavior and telemetry", async (decision) => {
    mocks.evaluate.mockResolvedValue(decision ? { ...deny, decision } : null);
    await runHook();
    expect(output.map(line => JSON.parse(line))).toEqual([{}]);
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    const payload = mocks.send.mock.calls[0][0];
    const target = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes.find((a: any) => a.key === "pinta.guard.target");
    expect(target?.value.stringValue).toBe(decision ? "tool_output" : undefined);
  });

  it("does not invent Antigravity post-tool control", () => {
    expect(isGuardEvent("gemini", "AfterTool")).toBe(true);
    expect(isGuardEvent("antigravity", "AfterTool")).toBe(false);
    expect(isGuardEvent("antigravity", "PostToolUse")).toBe(false);
    expect(isGuardEvent("antigravity", "PreToolUse")).toBe(true);
  });
});
