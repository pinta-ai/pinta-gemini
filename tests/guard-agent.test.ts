import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { runHook } from "../src/hook";
import { identity } from "../src/core/types";
import { evaluateGuard } from "../src/core/guard";

/**
 * One bundle, two agents — and only this side knows which.
 *
 * The guard leg sends a single fixed `pinta-gemini/<version>` User-Agent for
 * both hosts, so a manager reading only that answered `unknown` for every call
 * from here and no agent-scoped rule could match in real time (PTA-260). The
 * bundle already carries the answer: `identity(agent).ingest`, the same value
 * the telemetry leg sends as `ingest.type`.
 *
 * Driven through `runHook()` rather than by calling `evaluateGuard` directly.
 * The two are not the same test: what was missing was the wiring from the hook —
 * where `agent` is in scope — down to the header, and a test that calls the
 * guard wrapper itself skips exactly that, so deleting the argument at the call
 * site still passes. Measured: it did.
 *
 * Asserted at the header, not at the type. The value is handed to
 * `@pinta-ai/core`, which assembles headers by hand, so a type-level assertion
 * would hold while the wire carried nothing.
 */

/**
 * Agent names the manager will act on.
 *
 * Copied from the manager's closed set rather than derived from anything here,
 * because that is the point of the assertion: a name this side invents is not
 * an error anywhere in this repo, it just arrives at a route that does not
 * recognise it and falls back to `unknown`. `identity()` has three fields with
 * near-identical values — `prefix`, `ingest`, `service` — and only one of them
 * is this vocabulary.
 */
const MANAGER_KNOWS: ReadonlySet<string> = new Set([
  "mcp",
  "cc",
  "codex",
  "copilot",
  "gemini",
  "antigravity",
  "opencode",
  "musecode",
  "tailscale-aperture",
]);

describe("the guard leg names the agent the User-Agent cannot", () => {
  let tmp: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  const argv = process.argv;

  const guardCall = () =>
    fetchMock.mock.calls.find(([u]) => String(u).includes("/guard/evaluate"));
  const guardHeaders = (): Record<string, string> =>
    (guardCall()?.[1] as { headers?: Record<string, string> })?.headers ?? {};

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pg-guard-"));
    process.env.GEMINI_HOME = tmp;
    process.env.GEMINI_PLUGIN_DATA = tmp;
    process.env.GEMINI_PLUGIN_OPTION_HEADERS = "x-pinta-relay-token=tok";
    process.env.GEMINI_PLUGIN_OPTION_ENDPOINT = "http://otel.local/v1/traces";
    process.env.PINTA_GUARD_ENDPOINT = "http://guard.local/guard/evaluate";
    delete process.env.PINTA_GUARD_DISABLED;

    fetchMock = vi.fn(async (u: unknown) =>
      String(u).includes("/guard/evaluate")
        ? ({ status: 200, json: async () => ({ decision: "ALLOW", reason: null, durationMs: 1 }) } as unknown as Response)
        : ({ status: 200, json: async () => ({}) } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    // `runHook` ends with `process.exit(0)` — always, by design, so a host that
    // reads the exit code never sees a hook failure as a tool failure. Swallow
    // it rather than reshaping the hook: the exit is the last statement, so
    // everything under test has already run by the time it fires.
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    process.argv = argv;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Drive one real gate-event invocation, exactly as the host does. */
  async function gate(agent: "gemini" | "antigravity"): Promise<void> {
    const hook = agent === "gemini" ? "BeforeTool" : "PreToolUse";
    const body =
      agent === "gemini"
        ? { session_id: "s1", cwd: "/w", tool_name: "run_shell_command", tool_input: { command: "rm -rf /etc" } }
        : { conversationId: "s1", workspacePaths: ["/w"], toolCall: { name: "run_command", args: { CommandLine: "rm -rf /etc" } } };
    process.argv = ["node", "index.js", "--agent", agent, "--event", hook];
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(process, "stdin", {
      value: Readable.from([Buffer.from(JSON.stringify(body))]),
      configurable: true,
    });
    await runHook();
  }

  it("sends gemini and antigravity as different names, under the same User-Agent", async () => {
    await gate("gemini");
    const first = guardHeaders();
    expect(first["x-pinta-agent-type"], "gemini must reach the guard leg").toBe("gemini");

    fetchMock.mockClear();
    await gate("antigravity");
    const second = guardHeaders();
    expect(second["x-pinta-agent-type"], "antigravity must not read as gemini").toBe("antigravity");

    // The distinction is the whole claim — a build that sent one name for both
    // would pass either assertion on its own. And the User-Agent stays one
    // value, which is why the header had to exist at all.
    expect(first["user-agent"]).toBe(second["user-agent"]);
    expect(first["user-agent"]).toMatch(/^pinta-gemini\//);
  });

  it("sends a name the manager acts on, not a neighbouring field with the same spelling", async () => {
    // `identity()` carries `prefix`, `ingest` and `service`, and today `prefix`
    // happens to equal `ingest` — so swapping them changes nothing observable
    // and no test here can tell them apart. The manager can: it validates
    // against a closed set, and a value outside it becomes `unknown` silently.
    // So the assertion is membership in that set, which `service`
    // ("gemini-cli") already fails and a future `prefix` change would too.
    for (const agent of ["gemini", "antigravity"] as const) {
      fetchMock.mockClear();
      await gate(agent);
      const sent = guardHeaders()["x-pinta-agent-type"];
      expect(sent, `${agent} sent a name the manager cannot act on`).toBeDefined();
      expect(MANAGER_KNOWS.has(sent), `${agent} -> ${sent}`).toBe(true);
      expect(sent).toBe(identity(agent).ingest);
    }
  });

  it("says nothing rather than guessing when the caller does not name the host", async () => {
    // Reached by calling the wrapper directly, because `runHook` always knows
    // the agent — argv carries it — so the hook path can never exercise the
    // absent case. A second caller that forgets the argument can, and half of
    // this bundle's installs are Antigravity: defaulting to "gemini" would be a
    // wrong answer for half of them, blocking a client no rule named while
    // missing the one it did.
    //
    // The manager's contract is that an adaptor sending no name stays
    // `unknown`. This is the side that keeps that reachable.
    await evaluateGuard({ spanId: "s" }, "http://guard.local/guard/evaluate", "tok");
    expect("x-pinta-agent-type" in guardHeaders()).toBe(false);
  });

  it("names the agent on the leg that gates, not only on the one that reports", async () => {
    // Both legs have to agree or a rule matches after the fact and not before —
    // the shape PTA-256 named. The telemetry payload has carried `ingest.type`
    // all along; this asserts the guard call carries the same string, so the
    // two cannot drift by editing one literal.
    await gate("antigravity");
    const telemetry = fetchMock.mock.calls.find(([u]) => !String(u).includes("/guard/evaluate"));
    expect(telemetry, "telemetry leg did not fire").toBeDefined();
    expect(String(telemetry?.[1] && (telemetry[1] as { body?: unknown }).body)).toContain("antigravity");
    expect(guardHeaders()["x-pinta-agent-type"]).toBe("antigravity");
  });
});
