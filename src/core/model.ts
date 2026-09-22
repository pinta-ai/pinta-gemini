import { isGemini, type Agent, type RawEvent } from "./types.js";

export interface ModelEvidence {
  model: string;
  source: string;
}

const PLACEHOLDERS = new Set([
  "unknown", "undefined", "null", "n/a", "none", "-", "auto", "default",
]);

function modelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (!id || id.startsWith("{") || id.startsWith("[") || PLACEHOLDERS.has(id.toLowerCase())) return undefined;
  return id;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function evidence(value: unknown, source: string): ModelEvidence | undefined {
  const model = modelId(value);
  return model ? { model, source } : undefined;
}

/**
 * Only the firing hook's own fields are evidence. Tool hooks do not expose a
 * model/turn/call identity today; a transcript path alone cannot safely join
 * them to an earlier model call (especially a same-session subagent's call).
 */
export function resolveModel(agent: Agent, hook: string, event: RawEvent): ModelEvidence | undefined {
  if (isGemini(agent)) {
    if (hook === "AfterModel") {
      const response = record(event.llm_response);
      // Current Gemini's translator omits model identity. Respect it if a host
      // version explicitly supplies it, never label the request as a response.
      const actual = evidence(response?.modelVersion, "response:llm_response.modelVersion")
        ?? evidence(response?.model, "response:llm_response.model");
      if (actual) return actual;
    }
    if (hook === "BeforeModel" || hook === "BeforeToolSelection" || hook === "AfterModel") {
      const requested = evidence(record(event.llm_request)?.model, "requested:llm_request.model");
      if (requested) return requested;
    }
    return evidence(event.model, "reported:model");
  }

  // Antigravity's camelCase hooks have no documented model field. Do not
  // interpret Gemini's llm_request/llm_response on this different protocol.
  return evidence(event.model, "reported:model")
    ?? evidence(event.modelId, "reported:modelId");
}

/** Keep conflicting/non-scalar host values without polluting the scalar key. */
export function modelFields(agent: Agent, hook: string, event: RawEvent): RawEvent {
  const model = resolveModel(agent, hook, event);
  const { model: rawModel, model_source: rawSource, ...fields } = event;
  if ("model" in event && rawModel !== model?.model) fields.model_raw = rawModel;
  if ("model_source" in event) fields.model_source_raw = rawSource;
  if (model) {
    fields.model = model.model;
    fields.model_source = model.source;
  }
  return fields;
}
