# pinta-gemini

단일 어댑터로 **세 호스트**의 hook 이벤트를 받아 (1) OTLP/HTTP span 으로 forward(관측),
(2) tool 호출을 원격 guard 로 allow/deny(집행)한다. `pinta-cc`/`pinta-codex`/`pinta-copilot` 의 자매 어댑터로,
core(otlp/transport/retry-queue/redact/guard/trace)를 공유 패턴으로 재사용한다.

| 호스트 | `--agent` | hook 메커니즘 (실측 검증) |
|---|---|---|
| Google Gemini CLI | `gemini` | **extension** `~/.gemini/extensions/pinta-gemini/` (folder-trust 우회) |
| Antigravity CLI (agy v1.0.x) | `antigravity` | 전역 `~/.gemini/config/hooks.json` |
| Antigravity 2.0 | `antigravity` | 전역 `~/.gemini/config/hooks.json` (동일) 또는 workspace `.agents/hooks.json` |

> 상태: **v0.1 (검증 완료)**. 2026-06-15 실측에서 gemini 8/8, antigravity 5/5 이벤트 커버리지 +
> payload 형상·deny/allow·인자보존 확인. 자세한 건 [`docs/SPEC.md`](./docs/SPEC.md), [`docs/BACKGROUND_RESEARCH.md`](./docs/BACKGROUND_RESEARCH.md) PART F 참조.

## 저장소 구조
```
src/
  index.ts            진입점 (loadEnv → parse argv → normalize → guard → forward → decision → exit 0)
  env-file.ts         ~/.gemini/pinta-gemini.env 로더 (호스트가 env 안 주므로 주입 벡터)
  core/
    types.ts          Agent/Canonical 타입 + 호스트 family helper(gate/identity)
    agent.ts          --agent/--event 파싱 + antigravity 제품 서브라벨(transcriptPath)
    normalize.ts      호스트 payload → canonical (snake/camel 흡수)
    config.ts         endpoint/headers/guard/data-dir 해석
    guard.ts          원격 guard 평가 (50ms, fail-open)       ← pinta-cc 재사용
    decision.ts       호스트별 allow/deny 출력
    otlp.ts           멀티호스트 Bronze flatten + ingest.type/prefix/service.name
    transport.ts      OTLP/HTTP POST (5s) + 실패 시 retry-queue
    retry-queue.ts    파일 JSONL 큐 (cap 1000, 파일락)        ← pinta-cc 재사용
    redact.ts         시크릿 마스킹 + truncation              ← pinta-cc 재사용
    trace.ts          session 키 ULID trace map
    invocation-log.ts DEBUG 감사 로그 (invocations.jsonl)
tools/
  install-hooks.ts    호스트별 설치 (gemini=extension / antigravity=전역 config; lifecycle=flat 구조)
  doctor.ts           설치/엔드포인트 헬스체크
  hook-verify.ts      실측 검증 watcher (watch/report/teardown/selftest)
  e2e-hooks.ts        오프라인 계약 테스트 (mock guard+collector + reference stub)
  e2e-from-config.ts  오프라인 install→read→fire 테스트 (sandbox)
  demo-trace.ts       모든 이벤트 발사 + payload 관측 데모
tests/core.test.ts    단위 테스트 (normalize/decision/agent/otlp)
docs/                 SPEC + 배경연구
```

## 빠른 시작
```bash
npm install                    # devDeps (esbuild/tsx/vitest)
npm run build                  # → dist/index.js (install 전 필수)
npm test                       # vitest 단위 테스트
npm run e2e                    # 오프라인 계약 테스트 (3 호스트 형상)

# 실제 호스트 검증 (CLI 는 직접 실행)
npm run verify                 # ~/.gemini 에 설치 + watcher; 다른 터미널서 gemini/agy 실행
#   antigravity2 workspace:  npm run verify -- --workspace /path/to/project
npx tsx tools/hook-verify.ts report     # 누적 invocations.jsonl 채점
npm run doctor                 # 설치/엔드포인트 상태
npx tsx tools/hook-verify.ts teardown   # 원복 (hook 제거, jsonl 보존)
```

## 동작 계약 (요약 — 상세 [SPEC §7](./docs/SPEC.md))
- 이벤트/agent 식별: install 시 command 에 박는 `--agent`/`--event` 인자가 유일 수단(인자보존 실측 확정).
- 출력: stdout 에 **항상 단일 JSON**, **항상 exit 0**(fail-open).
- deny: gemini `{decision,reason,systemMessage}` / antigravity `{decision,reason}`. allow: gemini `{}` / antigravity PreToolUse `{decision:"allow"}`.
- guard: `PINTA_GUARD_ENDPOINT` POST, 50ms, fail-open. 텔레메트리: `GEMINI_PLUGIN_OPTION_*` > `OTEL_EXPORTER_OTLP_*`.
- 설정 주입: 호스트가 hook 에 env 를 안 주므로 `~/.gemini/pinta-gemini.env`(어댑터가 읽음)로 주입.

## Model telemetry

`gemini.model` / `antigravity.model` is a **scalar, host-supplied model ID**,
not a guessed default. `*.model_source` distinguishes evidence:

| Surface | Precedence / source |
| --- | --- |
| Gemini `BeforeModel`, `BeforeToolSelection` | `llm_request.model` → `requested:llm_request.model`, then top-level `model` → `reported:model` |
| Gemini response normalization | Explicit `llm_response.modelVersion`, then `llm_response.model` → `response:…`, then the request; **`AfterModel` remains skipped**, preserving streaming span counts |
| Other Gemini hooks | Top-level scalar `model` only → `reported:model` |
| Antigravity (agy and 2.0) | Top-level scalar `model`, then `modelId` → `reported:…`; never Gemini's nested fields |

The [Gemini hook types](https://github.com/google-gemini/gemini-cli/blob/v0.59.0/packages/core/src/hooks/types.ts)
expose a model on the **request**, not on ordinary tool/session hooks. The
[response translator](https://github.com/google-gemini/gemini-cli/blob/v0.59.0/packages/core/src/hooks/hookTranslator.ts)
currently omits actual response model identity. Before-model hooks are not
registered by the default installer; this change does not alter registration.
The verified [Antigravity payloads](./docs/BACKGROUND_RESEARCH.md#f3-확정된-이벤트별-payload-형상-실측-키셋)
do not expose a model at all, so existing Antigravity hooks normally omit it.
Explicit fields from host versions that supply them are preserved, not invented.

Blank, non-string and placeholder IDs (`unknown`, `undefined`, `null`, `n/a`,
`none`, `-`, `auto`, `default`) are omitted. Any trimmed string starting with
`{` or `[` is also omitted, including malformed or truncated JSON-like strings;
matching closing braces are not required. A conflicting or unusable top-level
host value is retained as `*.model_raw`; nested raw payloads remain unchanged
and use the existing redaction pipeline. Requested aliases are not claimed to
be an actual provider response identity.

Resolution is event-local: fixed field checks, **no added I/O, host commands,
file scans or cache**. A session/transcript path alone cannot disambiguate a
tool's model call from an earlier turn or same-session subagent. Such missing
models stay missing, including after switches, resumed sessions, and end hooks.

### AfterModel decision

Reviewed against Gemini CLI **v0.59.0** and upstream main's response schema on
2026-09-21. [`fireAfterModelEvent`](https://github.com/google-gemini/gemini-cli/blob/v0.59.0/packages/core/src/hooks/hookEventHandler.ts)
does **not** give hooks the raw GenAI SDK response: it calls
[`toHookLLMResponse`](https://github.com/google-gemini/gemini-cli/blob/v0.59.0/packages/core/src/hooks/hookTranslator.ts).
That translator explicitly constructs only `text`, `candidates` (content parts,
finish reason, index, safety ratings), and `usageMetadata` (token counts).
Neither `model` nor `modelVersion` is exposed on `llm_response`; the model field
that *is* present is `llm_request.model`, which is request evidence only.

The [host reference](https://github.com/google-gemini/gemini-cli/blob/v0.59.0/docs/hooks/reference.md#aftermodel)
says `AfterModel` fires after **each response chunk**, not once per completed
turn. The existing skip therefore avoids chunk-level span multiplication and
forwarding request/response content without recovering an additional
authoritative model identity. It stays in place; no event is renamed or
fabricated as `AfterAgent`, and hook registration/counts are unchanged.

Explicit response-ID support in the pure normalizer is not a claim that today's
native hook delivers it. If a verified host version does expose an actual
`model`/`modelVersion`, the appropriate follow-up is a **metadata-only
`AfterModel` observation**, excluding prompt/response content and using a
verified request identity for any deduplication. That requires evidence of the
new payload and coordination of the original hook's runtime classification;
it is not enabled speculatively here.

## 라이선스
PolyForm Noncommercial 1.0.0
