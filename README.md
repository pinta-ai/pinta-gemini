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

## 라이선스
PolyForm Noncommercial 1.0.0
