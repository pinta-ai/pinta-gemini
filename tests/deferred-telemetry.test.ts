import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_POST_BYTES, type OtlpPayload } from "@pinta-ai/core";

const mocks = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock("@pinta-ai/core", async original => ({
  ...await original<typeof import("@pinta-ai/core")>(),
  DiskRetryQueue: class { enqueue = mocks.enqueue; },
}));
import { deferPayload } from "../src/core/transport.js";

const config = { pluginData: process.cwd(), endpoint: "http://127.0.0.1/traces", headers: {} } as Parameters<typeof deferPayload>[1];
function sizedPayload(bytes: number): OtlpPayload {
  const payload: OtlpPayload = {
    resourceSpans: [{ resource: { attributes: [{ key: "audit", value: { stringValue: "" } }] }, scopeSpans: [] }],
  };
  const padding = bytes - Buffer.byteLength(JSON.stringify(payload), "utf8");
  payload.resourceSpans[0].resource.attributes[0].value = {
    stringValue: "é".repeat(Math.floor(padding / 2)) + "a".repeat(padding % 2),
  };
  expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBe(bytes);
  return payload;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("deferred denial telemetry budget", () => {
  it.each([MAX_POST_BYTES - 1, MAX_POST_BYTES])("retains the same payload at %s UTF-8 bytes", bytes => {
    const payload = sizedPayload(bytes);
    deferPayload(payload, config);
    expect(mocks.enqueue).toHaveBeenCalledWith(payload);
    expect(mocks.enqueue.mock.calls[0][0]).toBe(payload);
  });

  it("drops an oversized UTF-8 payload instead of queuing or sending it", () => {
    deferPayload(sizedPayload(MAX_POST_BYTES + 1), config);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("MAX_POST_BYTES"));
  });

  it("does not retain a guard-only payload without telemetry configuration", () => {
    deferPayload({ resourceSpans: [] }, { ...config, endpoint: "" });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
