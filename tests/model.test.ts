import { describe, expect, it } from "vitest";
import { modelFields, resolveModel } from "../src/core/model.js";
import { normalize } from "../src/core/normalize.js";
import { buildOtlpPayload } from "../src/core/otlp.js";
import type { RawEvent } from "../src/core/types.js";

const TRACE = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

function attrs(agent: string, hook: string, event: RawEvent) {
  const payload = buildOtlpPayload({
    agent, canonical: normalize(agent, hook, event), event, traceId: TRACE,
  });
  return Object.fromEntries(payload.resourceSpans[0].scopeSpans[0].spans[0].attributes
    .map(({ key, value }) => [key, Object.values(value)[0]]));
}

describe("model evidence", () => {
  it("lifts the Gemini request model without rewriting the raw request", () => {
    const event = { llm_request: { model: "gemini-2.5-pro", messages: [] }, model: "gemini-2.5-flash" };
    expect(modelFields("gemini", "BeforeModel", event)).toEqual({
      llm_request: event.llm_request,
      model: "gemini-2.5-pro",
      model_source: "requested:llm_request.model",
      model_raw: "gemini-2.5-flash",
    });
    expect(event.model).toBe("gemini-2.5-flash");
  });

  it("prefers explicit response identity, but never mistakes the request for a response", () => {
    const event = {
      llm_request: { model: "gemini-2.5-pro" },
      llm_response: { modelVersion: "gemini-2.5-pro-001", model: "gemini-2.5-pro" },
    };
    expect(resolveModel("gemini", "AfterModel", event)).toEqual({
      model: "gemini-2.5-pro-001", source: "response:llm_response.modelVersion",
    });
    expect(resolveModel("gemini", "AfterModel", {
      ...event, llm_response: { candidates: [], usageMetadata: {} },
    })).toEqual({ model: "gemini-2.5-pro", source: "requested:llm_request.model" });
    expect(resolveModel("gemini", "AfterModel", {
      llm_response: { model: "gemini-response-id" },
    })?.source).toBe("response:llm_response.model");
  });

  it.each([
    undefined, null, "", " \t", "unknown", " UNKNOWN ", "n/a", "default", "auto", 17, {}, [],
    "{}", "[]", '{"id":"model"}', '["model"]', "{", "[", "{truncated", "[truncated", " \t{broken", "\n [broken",
  ])(
    "omits unusable model %j rather than turning it into a model ID", (model) => {
      for (const agent of ["gemini", "antigravity"]) {
        const fields = modelFields(agent, "BeforeModel", { model, llm_request: { model } });
        expect(fields.model).toBeUndefined();
        expect(fields.model_source).toBeUndefined();
        expect(fields.model_raw).toEqual(model);
      }
    },
  );

  it("rejects JSON prefixes on nested request/response and Antigravity modelId paths", () => {
    for (const model of ["{", "[", " \t{truncated", "\n [truncated"]) {
      expect(resolveModel("gemini", "BeforeToolSelection", { llm_request: { model } })).toBeUndefined();
      expect(resolveModel("gemini", "AfterModel", { llm_response: { modelVersion: model } })).toBeUndefined();
      expect(resolveModel("gemini", "AfterModel", { llm_response: { model } })).toBeUndefined();
      expect(resolveModel("antigravity", "PreInvocation", { modelId: model })).toBeUndefined();
    }
    expect(resolveModel("gemini", "BeforeModel", {
      llm_request: { model: "  provider/model[variant]  " },
    })?.model).toBe("provider/model[variant]");
  });

  it("keeps protocols distinct and does not mine tool arguments or arbitrary nested objects", () => {
    const event = { llm_request: { model: "gemini-2.5-pro" }, tool_input: { model: "child-model" } };
    expect(resolveModel("gemini", "BeforeTool", event)).toBeUndefined();
    expect(resolveModel("antigravity", "PreInvocation", event)).toBeUndefined();
    expect(resolveModel("antigravity", "PreInvocation", { modelId: "claude-sonnet-4-5" })).toEqual({
      model: "claude-sonnet-4-5", source: "reported:modelId",
    });
    expect(resolveModel("antigravity", "PreToolUse", { model: "gemini-3-pro" })?.source)
      .toBe("reported:model");
  });

  it("never carries state across switches, subagents, concurrent sessions or end events", () => {
    for (const event of [
      { session_id: "a", model: "gemini-2.5-pro" },
      { session_id: "b", model: "gemini-2.5-flash" },
      { session_id: "a", agent_id: "child", model: "child-model" },
      { session_id: "a", model: "gemini-3-pro" },
    ]) {
      expect(resolveModel("gemini", "BeforeTool", event)?.model).toBe(event.model);
      expect(resolveModel("gemini", "AfterTool", { session_id: event.session_id })).toBeUndefined();
    }
    for (const hook of ["AfterAgent", "SessionEnd", "SessionStart", "BeforeAgent"]) {
      expect(resolveModel("gemini", hook, { session_id: "a", transcript_path: "stale.jsonl" })).toBeUndefined();
    }
  });

  it("leaves redaction and scalar OTLP typing intact", () => {
    const event = {
      cli_version: "0.59.0",
      model: { id: "not-a-supported-shape" },
      llm_request: { model: "gemini-2.5-pro", messages: [] },
      tool_input: { command: "mysql -psecretpw" },
    };
    const actual = attrs("gemini", "BeforeModel", event);
    expect(actual["gemini.model"]).toBe("gemini-2.5-pro");
    expect(actual["gemini.model_source"]).toBe("requested:llm_request.model");
    expect(actual["gemini.model_raw"]).toBe(JSON.stringify(event.model));
    expect(actual["gemini.llm_request"]).toBe(JSON.stringify(event.llm_request));
    expect(actual["gemini.tool_input"]).not.toContain("secretpw");
    expect(actual["gemini.tool_input"]).toContain("[REDACTED:cli_password_short]");
    expect(attrs("antigravity", "PreToolUse", { cliVersion: "1.2.3", model: "unknown" })["antigravity.model"])
      .toBeUndefined();
  });
});
