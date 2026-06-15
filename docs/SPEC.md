# pinta-gemini — Engineering Specification

> 상태: **Draft v0.1** (2026-06-15) · 검증: 3개 호스트 실측 완료(§12)
> 배경/근거: [`BACKGROUND_RESEARCH.md`](./BACKGROUND_RESEARCH.md) (특히 **PART F = 실측 진실 소스**)
> 선례: `pinta-cc`(core), `pinta-copilot`(payload 흡수/install), `pinta-codex`(env-file)
> 키워드 MUST/SHOULD/MAY 는 RFC 2119 의미로 사용한다.

---

## 1. 개요 & 범위

`pinta-gemini`는 **단일 어댑터 바이너리**로 세 호스트의 hook 이벤트를 받아
(1) OTLP/HTTP span 으로 변환·forward(관측), (2) tool 호출을 원격 guard 로 allow/deny(집행)한다.

**지원 호스트:**

| 호스트 | 식별자(`--agent`) | hook 메커니즘 |
|---|---|---|
| Google Gemini CLI | `gemini` | extension (`~/.gemini/extensions/pinta-gemini/`) |
| Antigravity CLI (agy v1.0.x) | `antigravity` | 전역 `~/.gemini/config/hooks.json` |
| Antigravity 2.0 | `antigravity` | 전역 `~/.gemini/config/hooks.json` (동일) 또는 workspace `.agents/hooks.json` |

**범위 밖(별도 repo):** aware-backend ingest slice, pinta-catalog 등록, pinta-manager enroll. (§13)

---

## 2. 목표 / 비목표

**목표**
- G1. 세 호스트의 라이프사이클 이벤트를 손실 없이 OTLP span 으로 forward.
- G2. tool 게이트 이벤트에서 guard 로 allow/deny + 사유(reason) 출력.
- G3. **fail-open**: 어댑터/네트워크 오류가 호스트 작업을 절대 막지 않음.
- G4. `pinta-cc` core(otlp/transport/retry-queue/redact/guard/trace) 재사용.
- G5. 호스트 업데이트 회귀를 잡는 **재현 가능한 검증 도구**(`tools/hook-verify.ts`) 동반.

**비목표**
- N1. 호스트별 제품 버전을 강하게 구분(텔레메트리 서브라벨은 best-effort, §9.4).
- N2. Antigravity 의 흐름제어(injectSteps/terminationBehavior, Stop "continue") 활용 — 관측/차단만.
- N3. Gemini `BeforeModel`/`AfterModel`/`BeforeToolSelection` 캡처(노이즈/저가치 — 기본 미등록).

---

## 3. 호스트 통합 모델 (NORMATIVE)

### 3.1 두 메커니즘이 세 앱을 커버
- Gemini CLI 는 **extension** 으로 설치한다. settings.json hooks 는 **folder-trust 게이트**(`isTrustedFolder()`)에 막히지만, extension hooks(`ConfigSource.Extensions`)는 **무조건 실행**된다. → 어댑터는 extension 경로를 MUST 사용.
- Antigravity(agy + 2.0)는 **전역 `~/.gemini/config/hooks.json`** 하나를 같은 camelCase 프로토콜로 읽는다. 하나의 `antigravity` 프로파일이 둘 다 커버한다.
- extension 은 **Gemini 전용**이다(Antigravity 는 `~/.gemini/extensions/` 를 읽지 않음). 두 메커니즘을 모두 설치해야 3개 앱이 커버된다.

### 3.2 이벤트 식별 (DG1, 확정)
- 호스트는 hook subprocess 에 이벤트 이름·우리 env 를 주지 않는다(Antigravity), 또는 다른 키 이름을 쓴다.
- 따라서 **이벤트·agent 식별의 유일한 수단은 install 시 command 에 박는 `--agent`/`--event` 인자**다.
- 어댑터는 `process.argv` 만 읽어 분기하며 payload 추론에 의존하지 **않는다**. (실측: 3개 호스트 모두 인자 보존, 누락 0건.)

### 3.3 설치 산출물 (정확 규격)

**gemini** → `~/.gemini/extensions/pinta-gemini/`
- `gemini-extension.json`: `{ "name": "pinta-gemini", "version": "<x>" }` (name·version MUST).
- `hooks/hooks.json`: `{ "hooks": { "<Event>": [ { "matcher"?: "", "hooks": [ {handler} ] } ] } }`.
- 모든 등록 이벤트가 `{matcher?, hooks:[handler]}` 단일 구조. `timeout` 단위 = **ms**(기본 60000).
- 등록 이벤트(8): `SessionStart, BeforeAgent, BeforeTool, AfterTool, AfterAgent, PreCompress, Notification, SessionEnd`. (tool 이벤트 `BeforeTool/AfterTool` 에 `matcher:""`.)
- 디렉터리 drop-in 으로 자동 활성. **변경 후 gemini 재시작 필요.**

**antigravity** → `~/.gemini/config/hooks.json` (전역; `--workspace DIR` 시 `<DIR>/.agents/hooks.json`)
- named-hook 루트: `{ "pinta-gemini": { "<Event>": [...] } }` — 우리 키만 교체, 사용자 기존 키 보존, 최초 1회 `.pinta-bak` 백업.
- **구조가 이벤트 종류별로 다르다(치명적):**
  - tool 이벤트(`PreToolUse`,`PostToolUse`): `[ { "matcher": "", "hooks": [ {handler} ] } ]`
  - lifecycle 이벤트(`PreInvocation`,`PostInvocation`,`Stop`): `[ {handler} ]` ← 핸들러 **직접**, matcher/hooks 래퍼 없음. (래퍼로 감싸면 agy 가 파싱 못 해 **발사 안 됨**.)
- `handler` = `{ "type": "command", "command": "<node> <abs dist/index.js> --agent antigravity --event <E>", "timeout": 30 }`. `timeout` 단위 = **초**(기본 30).
- 등록 이벤트(5): `PreInvocation, PreToolUse, PostToolUse, PostInvocation, Stop`.

---

## 4. 아키텍처 & 데이터 흐름

```
호스트 hook 발사
  → node dist/index.js --agent <a> --event <e>   (stdin = 이벤트 JSON)
    1. loadEnvFile()        ~/.gemini/pinta-gemini.env → process.env (unset 키만)
    2. parse argv           --agent, --event
    3. read stdin           raw 이벤트 payload
    4. normalize()          호스트 payload → canonical (snake/camel 흡수)
    5. guard (gate 이벤트만) PINTA_GUARD_ENDPOINT POST, 50ms, fail-open
    6. forward()            OTLP span POST (실패 시 retry-queue)
    7. formatDecision()     호스트별 allow/deny JSON
    8. logInvocation()      (DEBUG 시) invocations.jsonl 감사 로그
  → stdout 에 JSON 1개, exit 0  (항상)
```

core 레이어(`pinta-cc` 재사용): `otlp.ts`, `transport.ts`(5s timeout), `retry-queue.ts`(JSONL, cap 1000, 파일락), `redact.ts`(시크릿 마스킹+102KB truncation), `guard.ts`, `trace.ts`(ULID).

---

## 5. 어댑터 CLI 인터페이스

```
node dist/index.js --agent <gemini|antigravity> --event <HostEvent>
```
- `--agent gemini` → Gemini 프로토콜(snake, gate=`BeforeTool`, prefix=`gemini`).
- 그 외 모든 라벨 → Antigravity 프로토콜(camel, gate=`PreToolUse`, prefix=`antigravity`). (라벨 무관 처리.)
- stdin: 호스트 이벤트 JSON. stdout: **정확히 1개** JSON 객체. exit: **항상 0**.

---

## 6. 정규화 (Normalization)

호스트 payload → canonical `{ hook, session_id, cwd, tool_name, tool_input }`:

| canonical | gemini (snake) | antigravity (camel) |
|---|---|---|
| `hook` | `--event`(= `hook_event_name`) | `--event` |
| `session_id` | `session_id` | `conversationId` |
| `cwd` | `cwd` | `workspacePaths[0]` |
| `tool_name` | `tool_name` | `toolCall?.name` |
| `tool_input` | `tool_input` | `toolCall?.args` (PascalCase) |

- 원본 모든 top-level 필드는 Bronze flatten 으로 보존(§9).
- **주의(실측):** Antigravity `PostToolUse.toolCall` 은 `null` 일 수 있다 → PostToolUse 에서 `tool_name` 부재 허용 MUST.

---

## 7. Hook I/O 계약 (allow/deny)

### 7.1 입력
stdin 으로 호스트 이벤트 JSON(원본 그대로). 어댑터는 payload 의 이벤트 이름 필드에 의존하지 않는다(§3.2).

### 7.2 게이트 이벤트
guard 평가는 gate 이벤트에서만: gemini=`BeforeTool`, antigravity=`PreToolUse`.

### 7.3 출력 (호스트별, NORMATIVE)

| 상황 | gemini | antigravity |
|---|---|---|
| guard DENY | `{"decision":"deny","reason":<msg>,"systemMessage":<msg>}` | `{"decision":"deny","reason":<msg>}` (systemMessage 없음) |
| allow / 비게이트 | `{}` | gate(`PreToolUse`): `{"decision":"allow"}` (필수) · 그 외: `{}` |

- `reason` = guard `userMessage` ?? `reason` ?? `"guard_deny"`.
- stdout 은 **항상 단일 JSON**(빈 객체라도). 이유: Gemini 가 stdout 이 비면 stderr 를 systemMessage 로 노출(`stdout.trim() || stderr.trim()`)하므로, 진단 stderr 누출 방지.
- exit code 로 차단(exit 2)에 **의존 금지** — Antigravity exit semantics 미문서화. 항상 `{decision}` + exit 0.

---

## 8. Guard 통합

- 엔드포인트: `PINTA_GUARD_ENDPOINT` (없으면 guard skip = ALLOW). `PINTA_GUARD_DISABLED=1` 로 비활성.
- 요청: `POST { "input": { spanId, toolName, toolInput, rawTextFields:{toolInput} } }`, 헤더 `x-pinta-relay-token: $PINTA_RELAY_TOKEN`.
- 타임아웃 50ms, **fail-open**(timeout/비200/에러 → ALLOW).
- 응답: `{ decision:'ALLOW'|'DENY'|'REVIEW', reason, userMessage?, durationMs? }`.
- MCP/PascalCase 인자도 `rawTextFields.toolInput`(JSON 문자열)에 포함해 정책 매칭 가능하게 한다.

---

## 9. 텔레메트리 (OTLP forward)

### 9.1 엔드포인트 해석 (우선순위)
`GEMINI_PLUGIN_OPTION_ENDPOINT` > `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` > `OTEL_EXPORTER_OTLP_ENDPOINT`(+`/v1/traces`). 헤더: `GEMINI_PLUGIN_OPTION_HEADERS` > `OTEL_EXPORTER_OTLP_HEADERS`(+`GEMINI_PLUGIN_OPTION_API_KEY`→`x-pinta-relay-token`). namespaced 변수 우선(Gemini 자체 OTLP 충돌 방지).

### 9.2 span
- 이름: `<ingest>.<snake(hook)>` (예: `gemini.before_tool`, `antigravity.pre_tool_use`).
- resource: `service.name` = `gemini-cli`(gemini) | `antigravity`(antigravity), `host.*`/`process.*`.
- attributes: `ingest.type`(=`gemini`|`antigravity`, Bronze 판별자), `<prefix>.hook`, `<prefix>.agent`, `<prefix>.<원본필드>`(flatten), guard 시 `pinta.guard.decision`/`.matched_rule`.
- traceId: ULID→32hex. spanId: 8byte hex.

### 9.3 Bronze flatten
모든 top-level 이벤트 필드를 `<prefix>.<key>` 속성으로. 문자열은 redact+truncate(§11). prefix = `gemini` | `antigravity`.

### 9.4 제품 서브라벨 (best-effort, 실측 기반)
agy 와 Antigravity 2.0 은 `transcriptPath` 로 구분 가능:
- agy: `.../antigravity-cli/brain/<id>/.../transcript_full.jsonl`
- 2.0: `.../antigravity/brain/<id>/.../transcript.jsonl`
SHOULD: `antigravity.product` 속성을 `transcriptPath` 패턴으로 파생(`agy`|`antigravity2`|`unknown`). 식별 불가 시 생략.

---

## 10. Trace 상관

- 저장: `<dataDir>/trace.json` 을 **session_id/conversationId 로 keyed map** (동시 실행 충돌 방지).
- 새 trace: gemini=`BeforeAgent`, antigravity=`PreInvocation` 첫 발생(또는 conversationId 미존재 시). 그 외 reuse.
- 실측: Antigravity `PreInvocation` 은 모델 호출마다 발화(턴당 다수) → conversationId 단위 reuse 로 처리.

---

## 11. 시크릿 마스킹 (pinta-cc redact.ts 재사용)
- Tier1: AWS/GitHub/JWT/DB URL/CLI password 등 고신뢰 패턴 → `[REDACTED:<type>]`.
- Tier3: 문자열당 102,400 byte truncation → `…[TRUNCATED:<n>]`.
- skip-list: `<prefix>.{hook,tool_name,session_id,transcript_path,cwd}` 등 식별자.
- bash 컨텍스트: `<prefix>.tool_input`/`tool_response` 에 한해 context-gated 패턴 적용.

---

## 12. 설정 & 환경

- env 파일: `~/.gemini/pinta-gemini.env` (`loadEnvFile`, unset 키만 병합). 실제 호스트가 hook subprocess 에 우리 env 를 안 주므로 **주입 벡터는 이 파일**이다.
- data dir: `GEMINI_PLUGIN_DATA` || `~/.gemini/pinta-gemini-data/` (cwd 독립, 안정 경로). 포함: `trace.json`, `failed-spans.jsonl`(retry), `invocations.jsonl`(DEBUG 감사).
- `PINTA_GEMINI_DEBUG=1`: 매 호출을 `invocations.jsonl` 에 기록(argv·raw payload·normalized·guard·decision). 검증/디버그용, 기본 off.

---

## 13. 실패 모드

| 실패 | 동작 |
|---|---|
| guard timeout/에러 | ALLOW (fail-open) |
| OTLP POST 실패 | retry-queue enqueue, 다음 호출에 flush, **차단 안 함** |
| 엔드포인트 미설정 | telemetry silent disable |
| stdin 파싱 실패 / 어댑터 예외 | `{}` 출력 + exit 0 (fail-open) |
| 항상 | stdout 단일 JSON + **exit 0** |

---

## 14. 검증 & 수용 기준 (Acceptance)

검증 도구: `tools/hook-verify.ts` (watch/report/teardown/selftest), `tools/install-hooks.ts`. 감사 로그 = `invocations.jsonl`.

**수용 기준 (실측 2026-06-15 충족):**
- AC1. 이벤트 커버리지: gemini **8/8**, antigravity **5/5**. ✅
- AC2. `--event`/`--agent` 인자 보존 누락 **0건**(3개 호스트). ✅
- AC3. payload 형상이 PART F.3 키셋과 일치(gemini snake+`hook_event_name`, antigravity camel+`conversationId`/`toolCall`). ✅
- AC4. deny 출력이 §7.3 형식과 일치(gemini `systemMessage` 포함, antigravity 미포함; PreToolUse allow=`{decision:"allow"}`). ✅
- AC5. 정규화가 실제 payload 에서 `tool_name`/`cwd`/`session_id` 추출(PostToolUse `toolCall:null` 허용). ✅
- AC6. 모든 호출 exit 0, stdout 단일 JSON. ✅
- **AC7. (수동) deny 가 실제 CLI 에서 툴을 차단** — 육안 확인 필요. ⏳

→ AC1~6 충족. **AC7 확인 후 본개발 진입.**

회귀 검증: 호스트(gemini-cli/agy/antigravity2) 업데이트마다 `hook-verify` 재실행 → 커버리지/형상/계약 변화 감지.

---

## 15. 패키징 & 배포

- 패키지: `@pinta-ai/pinta-gemini`, 라이선스 PolyForm-Noncommercial-1.0.0, `type: module`.
- 빌드: `esbuild src/index.ts → dist/index.js` (bundle, esm, node18+).
- 스크립트: `build`, `install-hooks`, `uninstall-hooks`, `doctor`, `e2e`, `test`.
- 설치 채널: OSS(git clone + `install-hooks`) / Pinta Manager(enroll, §16).

---

## 16. 미해결 / 향후 작업

- O1. **AC7**: deny 실차단 육안 확인(호스트별 1회).
- O2. Antigravity exit-code semantics 미문서화 — 계속 의존 금지.
- O3. `antigravity.product` 서브라벨(`transcriptPath` 파생) 구현(§9.4) — 선택.
- O4. Gemini `BeforeModel`/`BeforeToolSelection` 등록 옵션(저노이즈, 필요 시).
- O5. SessionEnd best-effort(호스트가 완료 대기 안 함) — log 기록을 forward 전에 수행할지 검토.
- O6. 백엔드 연동(별도 repo): aware-backend `ingest.type∈{gemini,antigravity}` slice, `pinta-catalog` 등록, `pinta-manager` enroll(3호스트). relay/guard 무변경.

---

## 17. 핵심 결정 추적 (DG, BACKGROUND_RESEARCH 연계)

| ID | 결정 | 상태 |
|---|---|---|
| DG1 | `--agent`/`--event` 인자가 유일 식별자 | ✅ 확정(누락 0건) |
| DG2 | 정규화 레이어(snake/camel 흡수) | ✅ |
| DG3 | agent별 prefix/ingest.type/service.name | ✅ |
| DG4 | 호스트별 install(gemini=extension/antigravity=전역 config) | ✅ 교정·확정 |
| DG5 | 호스트별 deny/allow 출력 | ✅ |
| DG6 | 항상 stdout 단일 JSON + exit 0 | ✅ |
| DG7 | trace keyed map(session/conversationId) | ✅ |
| DG8 | guard gate = BeforeTool/PreToolUse | ✅ |
| DG9 | 공유 env 파일 `~/.gemini/pinta-gemini.env` | ✅ |
| DG10 | advisory 이벤트는 텔레메트리만 | ✅ |
| **DG11** | `transcriptPath` 로 제품 서브라벨 파생(agy/2.0) | 🆕 후보 |
