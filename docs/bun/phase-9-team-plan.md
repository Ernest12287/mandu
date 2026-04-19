---
title: "Phase 9 — OS 통합 (CLI UX + 단일 바이너리 + 데스크톱)"
status: execution-plan
created: 2026-04-19
depends_on:
  - docs/bun/phase-9-diagnostics/webview-api.md
  - docs/bun/phase-9-diagnostics/compile-binary.md
  - docs/bun/phase-9-diagnostics/markdown-cli-ux.md
  - docs/bun/phase-9-diagnostics/webview-bun-ffi.md (진행 중)
---

# Phase 9 — OS 통합

**원안 파기, 3-파트 재구성**: `Bun.WebView` 가 데스크톱 API가 아닌 headless automation 이라는 R0 진단 결과에 따라 기존 `phases-4-plus.md §9.1` 은 정정됨. Phase 9 는 이제 **9a CLI UX + 9b 단일 바이너리 + 9c webview-bun FFI 데스크톱** 3 트랙.

---

## 0. 진단 요약

| 영역 | 진단 판정 | 근거 |
|---|---|---|
| Bun.markdown CLI UX | 🟢 GREEN — 1~2일 | ansi 23μs · GFM + OSC 8 · 즉시 사용 가능 |
| bun --compile 바이너리 | 🟡 YELLOW — 9.5일 + signing | template 임베딩 blocker 1건 · 크로스컴파일 실증 |
| webview-bun FFI 데스크톱 | ⏳ R0 진행 중 | webview-bun 라이브러리 조사 대기 |

---

## 1. 팀 구조 (가장 큰 Phase, 이전 7.2 R1 규모 + R0 + 데스크톱)

| Round | Agent | 역할 |
|---|---|---|
| Pre-R1 | 내가 직접 | phases-4-plus.md §9 정정 ✓ · 공유 타입 · 본 문서 작성 |
| R0 (9c) | Phase-9c-R0-WebviewFFI | 파견됨, 실행 중 |
| R1.A | Phase-9a.A (frontend-architect) | Bun.markdown 통합 (CLI UX) |
| R1.B | Phase-9b.B (backend-architect) | Template 임베딩 + --compile config |
| R1.C | Phase-9b.C (backend-architect) | Cross-compile workflow + installer |
| R1.D | Phase-9c.D (frontend-architect, R0 GREEN 시) | webview-bun FFI prototype |
| R2 | 1 에이전트 (quality-engineer) | 통합 bench + cross-platform smoke |
| R3 | 1 에이전트 (security-engineer) | Supply chain + signing 가이드 + FFI audit |

총 7-8 에이전트.

---

## 2. 파일 충돌 관리

- **9a A**: `packages/cli/src/errors.ts`, `packages/cli/src/commands/init.ts`, `packages/cli/src/terminal/theme.ts` 확장, 신규 `packages/cli/src/cli-ux/markdown.ts` + `packages/cli/templates/init-landing.md`
- **9b B**: `packages/cli/src/main.ts` (compile config), 신규 `packages/cli/src/util/templates.ts` (Bun.embeddedFiles), 수정 `packages/cli/src/commands/init.ts` (template 로드 경로) ← A와 같은 파일, **섹션 분리 필수**
- **9b C**: `.github/workflows/release-binaries.yml` 신규, `install.sh` / `install.ps1` 신규 — 소스 코드 건드리지 않음, 완전 독립
- **9c D**: 신규 `packages/core/src/desktop/` 서브트리 + `packages/cli/src/commands/desktop.ts` (새 명령), `mandu build --target=desktop` flag

**init.ts 충돌 관리**: A 는 line 457~516 (랜딩 메시지), B 는 template 로드 경로 (함수 내부 glue). 브리핑에서 line 범위 엄격.

---

## 3. 9c R0 판정별 분기

- **GREEN**: 9c.D 파견, R1 4 에이전트 병렬 (A+B+C+D)
- **YELLOW**: 9c.D 파견하되 OS 제약 문서화 + demo 한정
- **RED**: 9c 이번 Phase 에서 defer, R1 3 에이전트 (A+B+C) 만

---

## 4. 품질 게이트

1. **9a**: `bun test packages/cli/src/cli-ux/` ≥ 8, init 랜딩 visual smoke
2. **9b**: 바이너리 smoke (3 OS × arch) — `bun test --e2e=binary`
3. **9c** (GREEN 시): demo webview launch, IPC smoke
4. R2 hard assertion:
   - CLI 바이너리 < 150MB
   - 바이너리 콜드스타트 < 1s
   - `mandu init` 랜딩 ansi 렌더 < 50ms
5. R3 Critical/High 0

---

## 5. 커밋 전략

- `feat(cli): Phase 9a — Bun.markdown CLI UX`
- `feat(cli): Phase 9b — template embedding + cross-compile binaries`
- `feat(core,cli): Phase 9c — desktop via webview-bun FFI` (GREEN 시)
- `test(cli): Phase 9 — integration bench + smoke`
- `security(cli): Phase 9 — supply chain + code signing + FFI audit`

---

## 6. 예상 시간

- R0 9c: 10~20분
- Pre-R1: 15분
- R1 병렬 3~4: 60~90분 (9b 가 가장 큼)
- R2: 25~35분
- R3: 15~25분

**Wall clock**: 2.5~4시간

---

## 7. Phase 9.1 follow-up (이번 phase 범위 외)

- Code signing 실제 수속 (Apple Developer + Windows cert) — 병렬로 법무/구매 트랙
- Homebrew / winget / choco 배포 manifests
- `mandu upgrade` self-update 명령
- 9c 의 IPC 고도화 (bidirectional message queue)
