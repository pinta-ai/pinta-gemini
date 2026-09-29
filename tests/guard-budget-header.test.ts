import { describe, it, expect, afterEach, vi } from "vitest";
import { evaluateGuard } from "../src/core/guard";

/**
 * The manager bounds its package check by how long this hook will wait, and
 * only reads that number off the wire (`x-pinta-guard-budget-ms`, core ≥ 0.9.0).
 * Without it the manager falls back to a table of copied adaptor constants —
 * still 50 for pinta-gemini — and abandons the package check at 40ms even
 * though this hook now waits 100 (PTA-579).
 *
 * Asserted at the fetch, not at the argument handed to core: the argument is
 * covered by guard-timeout.test.ts, and this is the half that proves the core
 * this bundle is built against actually puts it on the request. A lockfile
 * that slides back under 0.9.0 fails here, not in the field.
 */
describe("guard budget header", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("declares the 100ms budget on the wire, for both hosts", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ decision: "ALLOW", reason: null, durationMs: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    for (const agent of ["gemini", "antigravity"] as const) {
      await evaluateGuard({ resourceSpans: [] }, "http://guard.local/guard/evaluate", undefined, agent);
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const headers = fetchMock.mock.calls.map(
      (call) => (call as unknown as [unknown, { headers: Record<string, string> }])[1].headers,
    );
    expect(headers[0]).toMatchObject({ "x-pinta-guard-budget-ms": "100", "x-pinta-agent-type": "gemini" });
    expect(headers[1]).toMatchObject({ "x-pinta-guard-budget-ms": "100", "x-pinta-agent-type": "antigravity" });
  });
});
