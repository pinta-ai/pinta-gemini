# pinta-gemini — Background Research & Feasibility

> 목적: `pinta-cc`(Claude Code), `pinta-codex`(OpenAI Codex CLI), `pinta-copilot`(GitHub Copilot)
> 와 동일한 역할의 **`pinta-gemini`** 어댑터를 만든다. 단, 하나의 어댑터로 **3개 호스트를 동시 지원**한다:
>
> 1. **Gemini CLI** (Google, 오픈소스 — `gemini-cli/`)
> 2. **Antigravity CLI 1.0** (Google DeepMind, 클로즈드 바이너리 — `~/.gemini/antigravity-cli/`)
> 3. **Antigravity 2.0** (Google, 문서화된 hook 스펙 — `.agents/` / `~/.gemini/config/`)
>
> 본 문서는 (A) 기존 3개 어댑터의 역할/규약, (B) 3개 타깃 호스트의 hook 분석과 능력 검증,
> (C) **2개 프로토콜 패밀리** 간 hook 차이 매칭, (D) 통합 어댑터 설계·구현 TODO 를 정리한다.

작성일: 2026-06-12 (multi-host 개정)
근거 코드/문서:
- `/Users/pintaai/PINTA/{pinta-cc,pinta-codex,pinta-copilot}` (선례 어댑터)
- `/Users/pintaai/PINTA/gemini-cli/` (Gemini CLI 소스 + `HOOKS.md`)
- `/Users/pintaai/PINTA/gemini-cli/ANTIGRAVITY_ANALYSIS.md`, `ANTIGRAVITY_HOOKS.md` (Antigravity 1.0 바이너리 분석)
- `/Users/pintaai/PINTA/gemini-cli/ANTIGRAVITY2_HOOKS.md` (Antigravity 2.0 공식 hook 스펙)

---

## 0. TL;DR (결론 먼저)

**3개 호스트 모두 단일 어댑터로 동시 지원 가능하다.** 단, **2개의 hook 프로토콜 패밀리**를 흡수하는
normalization 레이어가 필요하다 (pinta-copilot 이 CLI/ext payload 를 흡수한 것과 동일 전략).

| 요구 능력 | Gemini CLI | Antigravity 1.0 | Antigravity 2.0 |
|---|---|---|---|
| 라이프사이클 이벤트 구독 | ✅ 11종 (settings.json) | ✅ 5종 (named hooks.json) | ✅ 5종 (named hooks.json) |
| Tool use **allow/deny** | ✅ `decision:"deny"` | ✅ `PreToolHookResult` (바이너리) | ✅ `decision:"deny"` (+`ask`/`force_ask`) |
| **사유(reason) 출력** | ✅ `reason`(+`systemMessage`) | ✅ (proto 상 지원) | ✅ `reason` |
| OTLP 텔레메트리 forward | ✅ hook→OTLP POST | ✅ 동일 | ✅ 동일 |
| event 이름이 payload 에 있나 | ✅ `hook_event_name` | ❌ 없음 | ❌ 없음 |
| 필드 casing | snake_case | camelCase | camelCase |
| 설치 위치 (실측 교정 → **PART F**) | **`~/.gemini/extensions/pinta-gemini/`** (extension; settings.json은 trust 게이트에 막힘) | **`~/.gemini/config/hooks.json`** (전역; agy v1.0.7 실측) | `~/.gemini/config/hooks.json`(전역) or `.agents/`(workspace) |
| timeout 단위 | ms (기본 60000) | **초** (기본 30) | **초** (기본 30) |

→ **핵심 난점은 "Antigravity payload 에 이벤트 이름이 없다"는 점**. handler config 에 `env` 필드도 없어
환경변수로 stamp 도 불가. → **설치 시 command 에 `--agent`/`--event` 인자를 박아 넣는 것을 1차(확정) 수단**으로
구분한다 (DG1). payload-shape 추론은 probe 실패 시에만 켜는 보조 수단으로 강등.
나머지는 normalization 으로 흡수하면 pinta-cc core(otlp/transport/retry-queue/redact/guard/trace)를 그대로 재사용한다.

> ✅ **2026-06-15 실측 검증 완료**: 3개 호스트 모두 실제로 hook을 발사해 payload를 캡처·검증함
> (gemini 8/8, antigravity 5/5 커버리지). **확정된 설치 경로·구조·payload 형상은 § PART F 참조**
> — 이 표의 가정들은 PART F에서 교정/확정되었다. Antigravity 1.0(agy v1.0.7)은 2.0과 **동일 프로토콜·동일 전역 경로**로 확인됨.

---

## PART A — 기존 어댑터가 하는 일 (선례)

세 선례 어댑터는 동일 패턴이다 (pinta-copilot DESIGNDOC D1: "fork pinta-cc, reuse core").

- **역할**: 호스트의 hook 이벤트 → (1) OTLP/HTTP span 으로 변환·forward(관측), (2) 선택적으로 tool 호출을 원격 guard 로 allow/deny(집행).
- **통신**: 호스트가 `node dist/index.js` spawn → 이벤트 JSON 을 **stdin** → deny 시 **stdout** JSON → **exit 0**.
- **공유 core**: `otlp.ts`(Bronze flatten, ULID→traceId), `transport.ts`(OTLP POST+timeout), `retry-queue.ts`(JSONL, cap1000, 파일락), `trace.ts`(턴당 ULID), `redact.ts`(시크릿 마스킹+truncation), `guard.ts`(`PINTA_GUARD_ENDPOINT` POST, 50ms, **fail-open**), `config.ts`/env 로더.
- **Fail-open**: 텔레메트리/guard 실패가 호스트를 막지 않음. 항상 exit 0.
- **Guard 요청**: `{ input:{ spanId, toolName, toolInput, rawTextFields:{toolInput} } }`, 헤더 `x-pinta-relay-token`.
- **Guard 응답**: `{ decision:'ALLOW'|'DENY'|'REVIEW', reason, userMessage?, durationMs }`.
- **배포**: `@pinta-ai/pinta-<host>` npm, PolyForm Noncommercial, OSS+Manager 2채널.

호스트별 인터랙션 차이 요약:

| | Claude Code | Codex | Copilot |
|---|---|---|---|
| 등록 | plugin marketplace `hooks.json`(자동) | `~/.codex/hooks.json`(수동)+`config.toml` | `~/.copilot/hooks/*.json`(수동) |
| 이벤트 수 | 14 | 5 | 12 (CLI+ext+cloud) |
| deny 키 | `permissionDecision:"deny"`+`permissionDecisionReason` | 동일 | `permissionDecision` or `behavior:"deny"`+`message` |
| fail 정책 | fail-open | fail-open | **fail-closed**→exit0 필수 |
| 특이점 | userConfig→env | env 미주입→env파일 | snake/camel 흡수, `PINTA_COPILOT_EVENT` env fallback |

→ pinta-gemini 가 흡수해야 할 패턴: **stdin JSON 파싱 → 정규화 → OTLP forward → guard deny stdout JSON → 항상 exit 0**.

---

## PART B — 타깃 호스트 능력 검증 (코드/문서 근거)

### B.1 Gemini CLI (오픈소스, 신뢰도 높음)

근거: `gemini-cli/packages/core/src/hooks/`, `HOOKS.md`

- **이벤트(11)**: `BeforeTool`, `AfterTool`, `BeforeAgent`, `AfterAgent`, `SessionStart`, `SessionEnd`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `PreCompress`, `Notification`.
- **CC 호환 클론**: command hook 이 stdin 에 `JSON.stringify(input)` 주입, stdout 을 `HookOutput` 으로 parse, 그리고 hook env 에 `CLAUDE_PROJECT_DIR` 까지 하위호환 주입 (`hookRunner.ts:354`).
- **등록**: `~/.gemini/settings.json` 의 `hooks` 키 (또는 `.gemini/hooks.json`, 확장). 구조: `{ "hooks": { "BeforeTool": [{ matcher, sequential?, hooks:[{name,type:"command",command,timeout}] }] } }`. **timeout=ms** (기본 60000).
- **입력(snake_case)**: base `{session_id, transcript_path, cwd, hook_event_name, timestamp}`. BeforeTool: `+{tool_name, tool_input, mcp_context?, original_request_name?}`.
- **allow/deny**: `HookDecision = 'ask'|'block'|'deny'|'approve'|'allow'`. BeforeTool deny → `scheduler/hook-utils.ts:64` `getBlockingError()` → `POLICY_VIOLATION` 에러로 tool 차단, reason 을 모델에 surface.
- **deny 출력(top-level)**: `{"decision":"deny","reason":"...","systemMessage":"..."}`. exit 2 = emergency block(stderr→reason).
- **주의**: `hookRunner.ts:455` 가 `stdout.trim() || stderr.trim()` 로 parse → **stdout 이 비면 stderr 가 systemMessage 로 노출**. 우리 어댑터는 항상 stdout 에 JSON(`{}` 이상)을 써야 함.
- **AfterModel 은 청크마다 발화**(`HOOKS.md §AfterModel`) → 등록 금지(span 폭발).

### B.2 Antigravity CLI 1.0 (바이너리 분석, 신뢰도 중간)

근거: `ANTIGRAVITY_ANALYSIS.md §4`, `ANTIGRAVITY_HOOKS.md`

- **정체**: Go 1.27 google3 사내 빌드, Antigravity(DeepMind 에이전트 코딩 도구) CLI. 원본 소스 ❌.
- **hook 지원 확정**: 문자열 `exa.hooks_pb / hooks_go_proto`, `"loaded %d named hooks from %d hooks.json file(s)"`, `DefaultHooksPath/UserConfigPath/enableJsonHooks`.
- **이벤트(5)**: `PreInvocation`, `PreToolUse`(proto: PreTool), `PostToolUse`(PostTool), `PostInvocation`, `Stop`(+`enableAfkStopHook`).
- **설치 위치/구조**: `~/.gemini/antigravity-cli/hooks.json`, **named-hook** 구조:
  ```json
  { "a": { "PreInvocation": null, "PostInvocation": null, "Stop": null,
           "PreToolUse": [{ "matcher": "", "hooks": [{ "type":"command", "command":"echo 1", "timeout":0 }] }],
           "PostToolUse": null } }
  ```
- **allow/deny(guard gate)**: proto `PreToolHookResult` = 툴 차단/수정. `HookInjectedStep_UserMessage/SystemMessage` = 프롬프트 주입(PreInvocation).
- **로컬 command + HTTP 웹훅**(`webhookUrl`/`webhookId`) 둘 다 지원. TUI 편집기 존재.
- **I/O 필드 상세**: 바이너리에서 미복구 → **2.0 과 동일하다고 가정** (named-hook + 이벤트셋이 2.0 과 일치하므로 합리적). 실측 검증 필요.

### B.3 Antigravity 2.0 (공식 문서, 신뢰도 높음)

근거: `ANTIGRAVITY2_HOOKS.md` (전체)

- **설치 위치**: `hooks.json` — 워크스페이스 `.agents/` 또는 사용자 `~/.gemini/config/`.
- **구조(named-hook)**: 최상위 키 = hook **이름**, 그 아래 이벤트 키. `enabled:false` 로 비활성 가능.
  ```json
  { "safety-gate": { "enabled": false,
      "PreToolUse": [{ "matcher":"run_command", "hooks":[{ "type":"command","command":"./safety.sh","timeout":10 }] }] } }
  ```
- **이벤트(5)**: `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`.
- **matcher**: PreToolUse/PostToolUse 는 **tool 이름 정규식**(`""`/`"*"`=all, `"browser_.*"` 등). 나머지는 무시.
- **handler 필드**: `type`("command" 기본), `command`(필수), `timeout`(**초**, 기본 30). → **`env` 필드 없음** (이벤트 stamp 불가).
- **I/O 계약 (camelCase)**: stdin JSON, stdout JSON.
  - **공통 입력**: `conversationId`, `workspacePaths`(string 배열!), `transcriptPath`, `artifactDirectoryPath`. **→ `session_id`/`cwd`/`hook_event_name` 없음.**
  - **PreToolUse 입력**: `{ toolCall:{ name, args }, stepIdx, ...공통 }`. (args 는 PascalCase: `CommandLine`,`Cwd`,`TargetFile`…)
  - **PreToolUse 출력**: `{ decision:"allow"|"deny"|"ask"|"force_ask"(필수), reason?, permissionOverrides?:string[] }`. **decision 은 필수** → allow 도 `{"decision":"allow"}` 명시 필요.
  - **PostToolUse**: 입력 `{ stepIdx, error? }`, 출력 `{}`.
  - **PreInvocation**: 입력 `{ invocationNum, initialNumSteps }`, 출력 `{ injectSteps:[{toolCall|userMessage|ephemeralMessage}] }`.
  - **PostInvocation**: 입력=PreInvocation, 출력 `{ injectSteps, terminationBehavior:"force_continue"|"terminate"|"" }`.
  - **Stop**: 입력 `{ executionNum, terminationReason, error?, fullyIdle }`, 출력 `{ decision:"continue"(재진입)|기타, reason? }`.
- **지원 tool 이름**: `view_file, write_to_file, replace_file_content, multi_replace_file_content, list_dir, find_by_name, grep_search, search_web, read_url_content, run_command, manage_task, schedule, list_permissions, ask_permission, invoke_subagent, define_subagent, send_message, manage_subagents, ask_question, generate_image`.

### B.4 텔레메트리/Guard (공통)

- 세 호스트 모두 hook 에서 **직접 OTLP span 을 만들어 pinta collector 로 forward** (Gemini 자체 OTLP 와 별개, vendor-neutral).
- guard: `BeforeTool`(Gemini)/`PreToolUse`(Antigravity) 에서 `PINTA_GUARD_ENDPOINT` POST → DENY 시 deny 출력. **fail-open**.
- 공유 env 파일 `~/.gemini/pinta-gemini.env` 를 세 호스트 모두 읽을 수 있음 (전부 `~/.gemini/` 하위).

---

## PART C — Hook 차이 매칭 (2개 프로토콜 패밀리)

### C.1 정규화(canonical) 이벤트 매핑

| Canonical 역할 | Gemini CLI | Antigravity 1.0 | Antigravity 2.0 | guard? | trace |
|---|---|---|---|:--:|---|
| **tool gate** | `BeforeTool` | `PreToolUse` | `PreToolUse` | ✅ | reuse |
| tool result | `AfterTool` | `PostToolUse` | `PostToolUse` | – | reuse |
| 턴/호출 시작 | `BeforeAgent` | `PreInvocation` | `PreInvocation` | – | new |
| 턴/호출 종료 | `AfterAgent` | `PostInvocation` | `PostInvocation` | – | reuse |
| stop | (`AfterAgent`) | `Stop` | `Stop` | – | reuse |
| session 시작 | `SessionStart` | — | — | – | reuse |
| session 종료 | `SessionEnd` | — | — | – | reuse |

- Antigravity 엔 SessionStart/End 없음. `PreInvocation` 은 **유저 프롬프트가 아니라 모델 호출 직전**(턴당 여러 번). → trace 시작 신호로 `invocationNum===1` 사용, 아니면 conversationId 로 reuse.

### C.2 I/O 계약 비교 (Gemini CLI ↔ Antigravity 2.0)

| 항목 | Gemini CLI | Antigravity 2.0 |
|---|---|---|
| config 파일 | `~/.gemini/settings.json`(`hooks`) / `.gemini/hooks.json` | `~/.gemini/config/hooks.json` 또는 `.agents/hooks.json` |
| config 구조 | `event → [{matcher, hooks}]` | `name → { event → [{matcher, hooks}], enabled? }` |
| payload 에 event 이름 | ✅ `hook_event_name` | ❌ 없음 → **command 인자로 stamp** |
| 필드 casing | snake_case | camelCase |
| 공통 입력 | `session_id, cwd, transcript_path, timestamp` | `conversationId, workspacePaths[], transcriptPath, artifactDirectoryPath` |
| tool 필드 | `tool_name, tool_input` | `toolCall.name, toolCall.args`(args PascalCase) |
| **deny 출력** | `{decision:"deny", reason, systemMessage}` | `{decision:"deny", reason, permissionOverrides?}` |
| decision 값 | `allow/deny/block/ask/approve` | `allow/deny/ask/force_ask` |
| allow 출력 | `{}`(또는 `{"decision":"allow"}`) | PreToolUse: **`{"decision":"allow"}` 필수**; 그 외 `{}` |
| timeout 단위 | ms (기본 60000) | **초** (기본 30) |
| exit 2 emergency | ✅ stderr→reason | 문서화 안 됨 → **의존 금지**, 항상 JSON+exit0 |

### C.3 핵심 차이 요약

1. **공통점(쉬움)**: 둘 다 stdin JSON → stdout JSON, deny 가 **top-level `{decision,reason}`** 로 거의 동일. guard DENY → `{decision:"deny",reason}` 한 형태가 양쪽에서 동작.
2. **차이1 — event 식별**: Antigravity 는 payload 에 event 이름이 없고 handler 에 `env` 도 없음 → **command 에 `--agent`/`--event` 인자 baking** 이 유일하게 신뢰 가능. (fallback: payload shape 추론.)
3. **차이2 — casing/필드**: snake vs camel, `cwd` vs `workspacePaths[0]`, `session_id` vs `conversationId`, `tool_input` vs `toolCall.args` → normalization 레이어로 흡수.
4. **차이3 — config 구조/위치/단위**: settings.json(event-map, ms) vs named-hook hooks.json(name-map, 초). → 호스트별 install 로직 분리.
5. **차이4 — allow 출력**: Antigravity PreToolUse 는 `decision` 필수 → allow 도 명시.
6. **공통 안전장치**: 항상 stdout 에 JSON, 항상 exit 0 (Gemini 의 stderr-leak, Antigravity 의 미문서 exit semantics 양쪽 회피).

---

## PART D — 통합 어댑터 설계 결정 (DG) & 구현 TODO

### D.1 설계 결정 (pinta-copilot DESIGNDOC 스타일)

- **DG1 — 단일 바이너리 + CLI 인자 stamp (확정 primary)**: `node dist/index.js --agent <gemini|antigravity1|antigravity2> --event <HostEvent>`. Antigravity payload 에 event 이름이 없고 handler `env` 도 없으므로, **이벤트·agent 식별의 유일한 1차 수단은 install 시 command 에 박는 `--event`/`--agent` 인자**다. 런타임은 `process.argv` 만 읽어 분기하며 payload 추론에 의존하지 않는다 (host 가 command 를 shell 문자열로 그대로 실행 → 인자 자동 전달).
  - **선행 검증(필수, 구현 전 1회)**: Antigravity 가 등록된 multi-token command 를 인자 보존하여 실행하는지 probe — 예: `"command": "node dist/index.js --event PROBE; echo \"$@\" >> /tmp/pinta-probe"` 로 `--event` 가 전달되는지 확인. (`ANTIGRAVITY_HOOKS.md` 샘플은 `"echo 1"` 단일 토큰뿐이라 미확인.)
  - **fallback(probe 실패 시에만)**: payload-shape 추론 — `toolCall`→PreToolUse, `invocationNum`→PreInvocation, `executionNum`/`terminationReason`→Stop, `stepIdx`+`error`&toolCall없음→PostToolUse. **기본 비활성**; probe 가 인자 미보존을 증명할 때만 켠다.
- **DG2 — normalization 레이어**: 호스트 payload → canonical `{ agent, hook, session_id, cwd, transcript_path, tool_name, tool_input, raw }`. 매핑: `conversationId→session_id`, `workspacePaths[0]→cwd`, `toolCall.name→tool_name`, `toolCall.args→tool_input`. 원본 필드는 손실 없이 Bronze flatten 유지.
- **DG3 — Bronze prefix / ingest.type per agent**: `gemini.*`+`ingest.type="gemini"`+`service.name="gemini-cli"`; `antigravity.*`+`ingest.type="antigravity"`+`service.name="antigravity-cli"`. 하나의 codebase, 런타임에 agent 판별.
- **DG4 — 호스트별 install**:
  - gemini → `~/.gemini/settings.json` 의 `hooks` 머지 (event-map, **ms**). 단일 entrypoint 가 `hook_event_name` 으로 라우팅(인자 stamp 도 병행 가능).
  - antigravity1 → `~/.gemini/antigravity-cli/hooks.json` named-hook (**초**), command 에 `--agent antigravity1 --event <E>`.
  - antigravity2 → `~/.gemini/config/hooks.json`(user) 및/또는 `.agents/hooks.json`(workspace) named-hook (**초**), `--agent antigravity2 --event <E>`.
  - 머지는 우리 hook 이름(`pinta-gemini`) 키만 덮어쓰기(idempotent), 타 설정 보존.
- **DG5 — deny/allow 출력 (host-aware `formatDecision`)**:
  - guard DENY → gemini: `{decision:"deny",reason,systemMessage:userMessage}`; antigravity: `{decision:"deny",reason}`.
  - allow → gemini: `{}`; antigravity **PreToolUse**: `{"decision":"allow"}`(필수); antigravity 그 외: `{}`.
  - 항상 stdout 에 정확히 1개 JSON.
- **DG6 — 항상 exit 0(fail-open)**: 어댑터 오류가 tool/턴을 막지 않게. stderr 진단이 systemMessage 로 새지 않게 stdout JSON 보장.
- **DG7 — trace store(멀티호스트 안전)**: `~/.gemini/pinta-gemini-data/trace.json` 를 **session_id/conversationId 로 keyed map** 저장(동시 실행 충돌 방지, pinta-copilot 방식). gemini `BeforeAgent`=새 trace; antigravity `PreInvocation invocationNum===1`=새 trace; 그 외 reuse.
- **DG8 — guard gate**: gemini `BeforeTool`, antigravity `PreToolUse`. `mcp_context`(gemini) / `toolCall.args`(antigravity) 를 guard `rawTextFields` 에 포함. (선택) antigravity `permissionOverrides` 로 REVIEW 허용 전달 — 후순위.
- **DG9 — 공유 env 파일**: `~/.gemini/pinta-gemini.env` (endpoint/headers/`PINTA_GUARD_ENDPOINT`/`PINTA_RELAY_TOKEN`). namespaced `GEMINI_PLUGIN_OPTION_*` 우선, `OTEL_*` fallback (Gemini 자체 OTLP 충돌 방지).
- **DG10 — Stop/Notification 등 advisory**: 텔레메트리만. antigravity `Stop` 은 `{}`(정지 허용), `PostInvocation` 은 `{}`(주입 없음). 모델 강제 재진입 같은 흐름제어는 범위 외.

### D.2 구현 TODO

스캐폴딩
- [ ] pinta-cc fork → core(`otlp/transport/retry-queue/redact/guard/trace`) 재사용.
- [ ] `package.json`: `@pinta-ai/pinta-gemini`, scripts `install-hooks`/`uninstall-hooks`/`doctor`/`mock-server`.

런타임 분기
- [ ] `src/agent.ts`: `--agent`/`--event` 파싱 + payload-shape fallback. agent∈{gemini,antigravity1,antigravity2}.
- [ ] `src/core/normalize.ts`: 호스트 payload → canonical event (snake/camel, workspacePaths, toolCall 흡수).
- [ ] `src/core/otlp.ts`: agent 별 prefix/ingest.type/service.name.
- [ ] `src/handlers/`: tool-gate(guard+deny), telemetry(나머지). host-aware `formatDecision`.
- [ ] trace store: keyed map + agent 별 new-trace 규칙.

설치/설정
- [ ] `tools/install-hooks.ts`: `--agent` 별 분기 — gemini(settings.json/ms) · antigravity1(antigravity-cli/hooks.json/초) · antigravity2(config|.agents/hooks.json/초). 모두 command 에 abs path + `--agent`/`--event` baking.
- [ ] `tools/doctor.ts`: 호스트별 hook 등록/endpoint/guard 헬스체크.
- [ ] `tools/mock-server.ts`: 로컬 OTLP collector.

검증
- [ ] golden fixture: 3호스트 실제 payload(Gemini BeforeTool snake / Antigravity2 PreToolUse camel / Antigravity1 실측) 회귀 테스트.
- [ ] e2e: 각 agent 모드로 spawn → stdin 이벤트 → span POST + guard deny stdout(형식별) → 항상 exit 0.

백엔드 (선례와 동일 패턴, 본 repo 범위 밖)
- [ ] `aware-backend`: `ingest.type∈{gemini,antigravity}` slice, `GEMINISPAN#`/`ANTIGRAVITYSPAN#`.
- [ ] `pinta-catalog`: `pinta-gemini/<ver>.yaml`. `pinta-manager`: enroll(3호스트). relay/guard 무변경.

---

## PART F — 실측 검증 결과 (VERIFIED 2026-06-15) ⭐

> **이 섹션이 실제 개발의 1차 진실 소스다.** Part B~E의 일부 가정은 실제 호스트(gemini-cli,
> agy v1.0.7, Antigravity 2.0)에서 hook을 발사해 `~/.gemini/pinta-gemini-data/invocations.jsonl`로
> 캡처·검증한 결과로 **교정/확정**되었다. 검증 도구: `tools/hook-verify.ts`(watcher) + `tools/install-hooks.ts`.
> 결과: **gemini 8/8, antigravity 5/5 이벤트 커버리지 달성.**

### F.1 확정된 설치 모델 (Part C/DG4 교정)

| 호스트 | 읽는 위치 (실측) | 설치 방식 | 비고 |
|---|---|---|---|
| **gemini-cli** | `~/.gemini/extensions/pinta-gemini/` | **extension** (`gemini-extension.json` + `hooks/hooks.json`) | settings.json hooks는 **folder-trust 게이트**에 막힘(`hookRegistry`: `getHooks()`는 `isTrustedFolder()`일 때만). extension hooks는 `ConfigSource.Extensions`라 **trust 무조건 우회**. 디렉터리 drop-in만으로 자동 활성. **gemini 재시작 필요.** |
| **antigravity-cli (agy v1.0.x)** | `~/.gemini/config/hooks.json` (전역) | named-hook | 바이너리 분석 문서의 `~/.gemini/antigravity-cli/hooks.json`은 **안 읽힘**(오인식). |
| **Antigravity 2.0** | `~/.gemini/config/hooks.json` (전역, **agy와 동일 파일**) | named-hook (동일) | 또는 `<workspace>/.agents/hooks.json`(프로젝트 한정). 둘 다 같은 camelCase 프로토콜. |

→ **gemini는 extension, antigravity(둘 다)는 전역 config/hooks.json** = 2개 설치 메커니즘이 3개 앱을 커버.
extension은 **gemini 전용**(antigravity는 안 읽음 — antigravity 문서에 `extensions/` 언급 전무, 별도 Go hook 로더).

### F.2 hooks.json 구조 규칙 (치명적 — 잘못하면 발사 안 됨)

Antigravity named-hook에서 **이벤트 종류별로 구조가 다르다**:
- **Tool 이벤트**(PreToolUse/PostToolUse): `[{ "matcher": "", "hooks": [ {handler} ] }]` (matcher+hooks 래퍼)
- **Lifecycle 이벤트**(PreInvocation/PostInvocation/Stop): `[ {handler} ]` — **핸들러를 배열에 직접**, matcher/hooks 래퍼 **없음** (문서: *"a list of handlers directly under the event key, matcher ignored"*).
- ⚠ lifecycle을 tool처럼 `[{hooks:[...]}]`로 감싸면 **agy가 파싱 못 해 발사 안 됨** (실제로 이 버그로 PreInvocation/PostInvocation/Stop이 0개였다가, flat 교정 후 발사됨).

Gemini extension hooks.json은 **모든 이벤트가 `{ "hooks": { "<Event>": [ {matcher?, hooks:[handler]} ] } }`** 단일 구조. `timeout`=ms(기본 60000). Antigravity `timeout`=초(기본 30).

### F.3 확정된 이벤트별 payload 형상 (실측 키셋)

**Gemini (snake_case, `hook_event_name`·`session_id`·`cwd`·`transcript_path`·`timestamp` 공통):**

| 이벤트 | 추가 필드(실측) |
|---|---|
| SessionStart | `source` (startup/resume/clear) |
| BeforeAgent | `prompt` |
| BeforeTool | `tool_name`, `tool_input`(snake 인자 예: `{dir_path:"."}`) — 빌트인은 `tool_use_id`/`mcp_context` **없음** |
| AfterTool | `tool_name`, `tool_input`, `tool_response` |
| AfterAgent | `prompt`, `prompt_response`, `stop_hook_active` |
| PreCompress | `trigger` |
| Notification | `notification_type`, `message`, `details` |
| SessionEnd | `reason` |

**Antigravity (camelCase, `conversationId`·`workspacePaths[]`·`transcriptPath`·`artifactDirectoryPath` 공통, `hook_event_name` 없음):**

| 이벤트 | 추가 필드(실측) |
|---|---|
| PreInvocation | `invocationNum`, `initialNumSteps` |
| PreToolUse | `toolCall:{name, args(PascalCase 예: CommandLine/DirectoryPath)}`, `stepIdx` |
| PostToolUse | `stepIdx`, `error`, **`toolCall`(nullable — `null`일 수 있음)** ← 문서엔 없던 보강 |
| PostInvocation | `invocationNum`, `initialNumSteps` |
| Stop | `executionNum`, `terminationReason`, `error`, `fullyIdle` |

### F.4 확정 사항 (가정 → 사실)

- **DG1 인자 보존: 확정** — `--event`/`--agent` 누락 0건(3개 호스트 전부). payload-shape fallback은 dead code, **미탑재 확정**.
- **deny/allow 형식: 확정** — gemini deny=`{decision,reason,systemMessage}`, antigravity deny=`{decision,reason}`(systemMessage 없음); antigravity PreToolUse allow=`{decision:"allow"}`(필수), gemini allow=`{}`. 실측 일치.
- **정규화: 확정** — `conversationId→session_id`, `workspacePaths[0]→cwd`, `toolCall.name/args→tool_name/tool_input` 정상 동작. (단 PostToolUse `toolCall`은 null 가능 → tool_name 의존 금지.)
- **agy vs Antigravity 2.0 런타임 구분 가능(신규)** — 같은 config를 읽지만 `transcriptPath`로 구별됨:
  agy = `.../antigravity-cli/brain/<id>/.../transcript_full.jsonl`, 2.0 = `.../antigravity/brain/<id>/.../transcript.jsonl`.
  → 제품별 텔레메트리 서브라벨이 필요하면 `transcriptPath` 패턴으로 파생(향후 DG11 후보). 단일 `antigravity` 라벨 + 파생 속성으로 충분.
- **계측 메커니즘: 확정** — 실제 호스트는 hook subprocess에 우리 env를 안 줌 → `~/.gemini/pinta-gemini.env`(어댑터 `loadEnvFile`이 읽음)로 `PINTA_GEMINI_DEBUG`/endpoints 주입. `invocations.jsonl`은 **첫 호출 때 lazy 생성**.

### F.5 개발 진입 게이트: ✅ 통과 가능

3개 호스트 모두 이벤트 풀커버리지 + payload 형상 + deny/allow + 인자보존이 실측 확인됨.
남은 수동 항목은 **deny가 실제로 툴을 차단했는지**(H6) 육안 확인 1건뿐. → **본개발(@pinta-ai 백엔드 연동 등) 진입 가능.**

---

## PART E — 리스크 / 미검증 가정 (대부분 PART F에서 해소됨)

1. ~~**Antigravity 1.0 I/O 계약**~~ → **해소**: agy v1.0.7은 2.0과 동일 camelCase 프로토콜·동일 전역 config 경로(F.1/F.3). 단일 `antigravity` 프로파일로 통합.
2. **Antigravity exit-code semantics 미문서화**: 여전히 exit 2 의존 금지. 항상 `{decision}` JSON + exit 0 (유지).
3. ~~**event 식별(인자 보존)**~~ → **해소(확정)**: 누락 0건(F.4). fallback 미탑재.
4. **PreInvocation 빈도**: 실측상 conversation당 여러 번 발화(모델 호출마다) 확인 → trace 경계는 `conversationId` 키 재사용으로 처리(턴 경계 신호 없음). 세분화 허용.
5. ~~**config 위치 다중성**~~ → **해소**: 전역 `~/.gemini/config/hooks.json` 기본, `.agents/`는 `--workspace` 옵션(F.1).
6. **timeout 단위**: Gemini=ms / Antigravity=초 — install 코드에서 분리됨(유지).
7. ~~**1.0/2.0 동시 설치**~~ → **해소**: 같은 전역 config 1파일·1라벨, `transcriptPath`로 런타임 구분(F.4).

---

## 부록 — 핵심 파일/문서 레퍼런스

| 목적 | 위치 |
|---|---|
| Gemini hook 타입/decision | `gemini-cli/packages/core/src/hooks/types.ts` (HookDecision:130, isBlockingDecision:212) |
| Gemini command hook 실행 | `gemini-cli/packages/core/src/hooks/hookRunner.ts` (stdin:413, parse:455, exit2→deny:553) |
| Gemini BeforeTool deny 집행 | `gemini-cli/packages/core/src/scheduler/hook-utils.ts:64` (POLICY_VIOLATION) |
| Gemini hook 작성 가이드 | `gemini-cli/HOOKS.md` |
| Antigravity 1.0 바이너리 분석 | `gemini-cli/ANTIGRAVITY_ANALYSIS.md §4`, `ANTIGRAVITY_HOOKS.md` |
| Antigravity 2.0 hook 스펙 | `gemini-cli/ANTIGRAVITY2_HOOKS.md` |
| 선례 어댑터 | `pinta-cc`(core), `pinta-copilot`(payload 흡수/install), `pinta-codex`(env-file/수동 install) |
| **어댑터 (prototype)** | `pinta-gemini/src/index.ts` → `dist/index.js` (multi-host, 라벨 무관 normalize) |
| **설치기** | `pinta-gemini/tools/install-hooks.ts` (gemini=extension / antigravity=전역 config; lifecycle=flat 구조) |
| **실측 검증 watcher** | `pinta-gemini/tools/hook-verify.ts` (watch/report/teardown/selftest — 호스트 업데이트마다 재실행) |
| **검증 데이터** | `~/.gemini/pinta-gemini-data/invocations.jsonl` (호출별 argv·raw payload·정규화·guard·decision 감사 로그) |
