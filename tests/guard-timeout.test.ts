import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * How long a gate waits for the guard before it fail-opens (PTA-579).
 *
 * 50ms was shorter than the manager's own round trip at the tail — prod codex
 * answered at p99 58ms, so calls that would have been decided were allowed by
 * the timeout instead. 100ms covers that tail while keeping the hook snappy.
 *
 * Asserted at the argument handed to `@pinta-ai/core`, not at the wire:
 * core ≥ 0.9.0 is what turns `timeoutMs` into the `x-pinta-guard-budget-ms`
 * header the manager bounds its package check by, so the number this adaptor
 * passes is the one both sides use. Asserted as a literal because it is a
 * decision, not a derivation — a change to it should have to change this line.
 */
const coreEvaluateGuard = vi.fn(async () => null);
vi.mock("@pinta-ai/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pinta-ai/core")>()),
  evaluateGuard: coreEvaluateGuard,
}));

const { evaluateGuard } = await import("../src/core/guard");

describe("guard timeout", () => {
  afterEach(() => coreEvaluateGuard.mockClear());

  it("waits 100ms for the guard, for both hosts", async () => {
    for (const agent of ["gemini", "antigravity"] as const) {
      await evaluateGuard({ resourceSpans: [] }, "http://guard.local/guard/evaluate", "tok", agent);
    }
    expect(coreEvaluateGuard).toHaveBeenCalledTimes(2);
    for (const call of coreEvaluateGuard.mock.calls as unknown as [unknown, unknown, { timeoutMs?: number }][]) {
      expect(call[2].timeoutMs).toBe(100);
    }
  });
});
