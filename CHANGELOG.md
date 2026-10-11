# Changelog

## 0.14.0

### Changed
- Gemini `AfterTool` denials now hand the model the policy's own message plus
  a fixed recovery hint instead of one fixed sentence, and keep the session
  alive. When the manager says the output can be masked (`outputAction:"mask"`
  with `redactions`), `reason` carries the original output with only the
  detected values replaced by `[REDACTED:<category>]`; otherwise the output is
  withheld. `systemMessage` is the one-line notice, including the manager's
  `evaluationId` when sent, so a false positive can be reported by reference
  (PTA-695).
- The guard's rule id is still never shown to the model; redaction values stay
  in the synchronous guard response and are not written to the audit span, the
  retry queue or the invocation log.
- `@pinta-ai/core` `^0.10.0`: parses `evaluationId`, `outputAction` and
  `redactions` from the guard response and provides `buildOutputDenial`, which
  produces the same copy on every adaptor.

### Compatibility
- Pinta Manager 0.1.16 or later sends `outputAction`/`redactions`. Older
  managers send neither, and this release withholds the output with the policy
  `userMessage` as before — no manager upgrade is required to keep enforcing.
- Antigravity post-tool events remain observation-only; input-gate denials on
  both hosts are unchanged.

## 0.13.1

### Fixed
- Guard `AfterTool` success and error output before telemetry, returning fixed
  safe denial feedback instead of the original model-facing content (PTA-585).
- Complete decided denials without waiting for collector network IO while
  preserving the original redacted evidence in the bounded retry queue.
- Bundle `@pinta-ai/core` `^0.9.2` to keep ordinary `find -path` and
  `find -print` arguments out of mysql-family short-password masking (PTA-515).
- Preserve mysql password masking in Antigravity's native JSON `CommandLine`
  field; cover both real password values and unchanged `find` arguments.

### Compatibility
- Catalog distribution of this output-enforcing release is gated to Manager
  0.1.14 or later; older Managers keep the preceding compatible adapter.
- Output protection requires the host's synchronous output hook and a
  Manager/guard that projects that event as output. Component-level native
  evidence is not a claim of full authenticated CLI acceptance.
- Existing guard budgets, REVIEW/disabled/fail-open behavior and guard/export
  ordering remain unchanged. Output denial does not undo an executed tool.

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
