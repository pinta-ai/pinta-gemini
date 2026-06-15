# pinta-gemini

단일 어댑터로 **세 호스트**의 hook 이벤트를 받아 (1) OTLP/HTTP span 으로 forward(관측),
(2) tool 호출을 원격 guard 로 allow/deny(집행)한다. `pinta-cc`/`pinta-codex`/`pinta-copilot` 의 자매 어댑터.

| 호스트 | `--agent` | hook 메커니즘 (실측 검증) |
|---|---|---|
| Google Gemini CLI | `gemini` | **extension** `~/.gemini/extensions/pinta-gemini/` (folder-trust 우회) |
| Antigravity CLI (agy v1.0.x) | `antigravity` | 전역 `~/.gemini/config/hooks.json` |
| Antigravity 2.0 | `antigravity` | 전역 `~/.gemini/config/hooks.json` (동일) 또는 workspace `.agents/hooks.json` |

> 상태: **prototype / 검증 완료**. 2026-06-15 실측에서 gemini 8/8, antigravity 5/5 이벤트 커버리지 +
> payload 형상·deny/allow·인자보존 확인. 본개발 진입 가능 — 자세한 건 [`docs/SPEC.md`](./docs/SPEC.md) 참조.

## 문서
- **[docs/SPEC.md](./docs/SPEC.md)** — 구현 스펙(normative). 설치 경로·구조·payload 형상·I/O 계약·수용 기준.
- **[docs/BACKGROUND_RESEARCH.md](./docs/BACKGROUND_RESEARCH.md)** — 배경 연구·타당성·실측 검증 결과(**PART F = 진실 소스**).

## 저장소 구조
```
src/index.ts              어댑터 (self-contained, 라벨 무관 normalize; 실제 구현은 pinta-cc core 재사용 예정)
tools/
  install-hooks.ts        호스트별 설치 (gemini=extension / antigravity=전역 config; lifecycle=flat 구조)
  hook-verify.ts          실측 검증 watcher (watch/report/teardown/selftest) — 호스트 업데이트마다 재실행
  e2e-hooks.ts            오프라인 계약 테스트 (mock guard+collector + 내장 reference stub)
  e2e-from-config.ts      오프라인 install→read→fire 테스트 (sandbox)
  demo-trace.ts           모든 이벤트 발사 + payload 관측 데모
docs/                     SPEC + 배경연구
```

## 빠른 시작
```bash
npm run build                  # esbuild → dist/index.js (install 전 필수)

# 오프라인 검증 (호스트 불필요)
npm test                       # hook-verify selftest (scorer 검증)
npm run e2e                    # 계약 테스트 (3 호스트 형상)

# 실제 호스트 검증 (CLI 는 직접 실행)
npm run verify                 # ~/.gemini 에 설치 + watcher; 다른 터미널서 gemini/agy 실행
#   antigravity2 workspace:  npm run verify -- --workspace /path/to/project
npx tsx tools/hook-verify.ts report     # 누적 invocations.jsonl 채점
npx tsx tools/hook-verify.ts teardown   # 원복 (hook 제거, jsonl 보존)
```

## 동작 계약 (요약 — 상세 SPEC §7)
- 이벤트/agent 식별: install 시 command 에 박는 `--agent`/`--event` 인자가 유일 수단(인자보존 실측 확정).
- 출력: stdout 에 **항상 단일 JSON**, **항상 exit 0**(fail-open).
- deny: gemini `{decision,reason,systemMessage}` / antigravity `{decision,reason}`. allow: gemini `{}` / antigravity PreToolUse `{decision:"allow"}`.
- guard: `PINTA_GUARD_ENDPOINT` POST, 50ms, fail-open. 텔레메트리: `OTEL_EXPORTER_OTLP_*` / `GEMINI_PLUGIN_OPTION_*`.
- 설정 주입: 호스트가 hook 에 env 를 안 주므로 `~/.gemini/pinta-gemini.env`(어댑터가 읽음)로 주입.

## 라이선스
PolyForm Noncommercial 1.0.0
