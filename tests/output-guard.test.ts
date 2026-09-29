import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agent: "gemini", event: "AfterTool", evaluate: vi.fn(),
  send: vi.fn(), flush: vi.fn(), enqueue: vi.fn(),
}));
vi.mock("../src/core/config.js", () => ({
  loadConfig: () => ({ pluginData: process.cwd(), endpoint: "http://127.0.0.1/traces", headers: {} }),
}));
vi.mock("../src/core/agent.js", async (original) => ({
  ...await original<typeof import("../src/core/agent.js")>(),
  parseInvocation: () => ({ agent: mocks.agent, event: mocks.event }),
}));
vi.mock("../src/core/guard.js", () => ({ evaluateGuard: mocks.evaluate }));
vi.mock("../src/core/transport.js", () => ({
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

let output: string[];
let response: unknown;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.agent = "gemini";
  mocks.event = "AfterTool";
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
    expect(output.map(line => JSON.parse(line))).toEqual([{ decision: "deny", reason: "output-policy" }]);
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
    mocks.enqueue.mockImplementation(() => { throw new Error("queue unavailable"); });
    await runHook();
    expect(JSON.parse(output[0]).decision).toBe("deny");
  });

  it.each(["ALLOW", "REVIEW", null])("retains %s behavior and telemetry", async (decision) => {
    mocks.evaluate.mockResolvedValue(decision ? { ...deny, decision } : null);
    await runHook();
    expect(output.map(line => JSON.parse(line))).toEqual([{}]);
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("does not invent Antigravity post-tool control", () => {
    expect(isGuardEvent("gemini", "AfterTool")).toBe(true);
    expect(isGuardEvent("antigravity", "AfterTool")).toBe(false);
    expect(isGuardEvent("antigravity", "PostToolUse")).toBe(false);
    expect(isGuardEvent("antigravity", "PreToolUse")).toBe(true);
  });
});
