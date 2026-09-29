# Changelog

## 0.13.0

### Changed
- The guard gate waits **100ms** for a verdict (was 50ms) before failing open.
  50ms sat under the manager's own round trip at the tail (prod p99 58ms), so
  calls the manager would have decided were allowed by the timeout instead.
  Applies to both Gemini CLI and Antigravity.
- `@pinta-ai/core` `^0.9.0`: the guard request now carries
  `x-pinta-guard-budget-ms: 100`. Pinta Manager 0.1.10+ bounds its package
  check by this value (80% of it) instead of its built-in table, which still
  lists pinta-gemini at 50ms — without the header the manager would keep
  abandoning the package check at 40ms.

### Compatibility
- Pinta Manager 0.1.11 or later remains the guard-payload compatibility floor.
  Older managers ignore the new header; nothing else in the request changes.

Refs PTA-579.

## 0.12.0

### Added
- Truthful scalar `gemini.model` and `antigravity.model` attributes with
  `model_source` provenance. Gemini request models are read from the verified
  nested `llm_request.model` field; conflicting raw values remain available as
  `model_raw`.
- Regression and built-hook loopback OTLP coverage for model switches,
  concurrent sessions, same-session subagents, missing metadata, raw payload
  preservation, redaction and guard-span identity.

### Fixed
- Omit blank, placeholder, non-string and JSON-prefixed model IDs, including
  malformed or truncated strings starting with `{` or `[` after trimming.

### Compatibility
- Pinta Manager 0.1.11 or later remains the guard-payload compatibility floor;
  the `@pinta-ai/core` dependency remains `^0.8.0`. No new required envelope
  fields, hook registration changes or additional desktop upgrade are needed.
- Gemini `AfterModel` remains skipped: the verified native translator exposes
  response content/token counts, not actual response model identity, and fires
  per streamed chunk. Current Antigravity native hooks expose no model.
  Unavailable models are omitted; no transcript scans or session-model guesses.

Refs PTA-524.
