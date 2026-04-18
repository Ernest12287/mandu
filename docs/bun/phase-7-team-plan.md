---
title: "Phase 7.0 — HMR 완전성·속도 확보 에이전트 팀 실행 계획"
status: execution-plan
audience: Mandu core team + dispatched agents
depends_on:
  - docs/bun/phases-4-plus.md
  - docs/bun/phase-7-diagnostics/hmr-internals.md
  - docs/bun/phase-7-diagnostics/industry-benchmark.md
  - docs/bun/phase-7-diagnostics/issues-and-coverage.md
  - docs/bun/phase-7-diagnostics/performance-reliability.md
created: 2026-04-18
---

# Phase 7.0 — HMR 완전성·속도 확보 에이전트 팀 실행 계획

**Next.js 는 너무 느리다. Mandu 는 빠르고 완벽해야 한다.**

Phase 4c 와 동일한 7-agent × 4-라운드 병렬 압축. 4개 진단 에이전트의 실측·벤치마크·이슈 수집 결과를 모두 반영.

---

## 0. 4개 진단 문서 요약 (의사결정의 근거)

| 진단 | 핵심 발견 |
|---|---|
| Internals (`hmr-internals.md`) | 12 파일 타입 분기 매트릭스 — contract/resource/config/.env/package.json/middleware 미감지. layout-update 서버 송신 미구현. pendingBuildFile 단일 슬롯. HMR E2E 0. |
| Industry (`industry-benchmark.md`) | Vite `import.meta.hot` subset + Remix HDR + island Fast Refresh + CSS style-swap + #188 prerender 재생성 — 5 Must-have. SSR 변경은 prerender 재생성 + WS full-reload 하이브리드 권장. |
| Issues (`issues-and-coverage.md`) | Open 이슈 #188 단 1건. #184/#185/#186 트리오로 대부분 critical 해결. 테스트 59 유닛 / **E2E 0**. slot/contract/resource 감시 공백. |
| Performance (`performance-reliability.md`) | Cold 395ms ✅ / SSR walltime **1.5~2s** (목표 200ms의 8-10× 초과). B1(`src/` 미감시), B2(pendingBuildFile drop), B6(전역 debounce) 3개 치명적 hole 실측 재현. B5(bundledImport 증분화)가 SPEED 목표의 핵심. |

---

## 1. 핵심 목표 (변경 불가)

### SPEED 타겟 (P95)

| 지표 | 타겟 | 현재 실측 | Gap |
|---|---|---|---|
| Cold dev start | ≤ 500 ms | 395 ms | ✅ |
| Island-only rebuild | ≤ 50 ms | 측정 불가 (B4) | 측정 인프라 먼저 |
| **SSR page rebuild** | **≤ 200 ms** | **1.5~2 s** | **-1300~1800 ms (치명)** |

### COMPLETENESS 타겟

- 0 missed rebuilds (B1 + B2 + B6 수정으로 달성)
- 0 stale caches (`bundledImport` 가 이미 해결 — B9)
- 0 crashes during HMR path
- **36 시나리오 매트릭스 100%** (3 프로젝트 형태 × 12 파일 종류)

### 경쟁 우위 1문장

> B5 (`bundledImport` 증분화) 를 해결하면, **Bun.build raw 속도 × descendants-only incremental** = Next.js Fast Refresh 대비 구조적 10-20배 우위. 이게 Mandu 고유 가치의 단일 핵심.

---

## 2. 분리 가능한 7 concerns

| # | Concern | 라운드 | Agent | 전문성 |
|---|---|---|---|---|
| 1 | Reliability 기초 + #188 prerender 재생성 (B1/B2/B4/B6 + common-dir 재생성 트리거) | R1 | A | backend-architect |
| 2 | bundledImport 증분화 (B5) — **SPEED 핵심** | R1 | B | backend-architect (복잡도 최상) |
| 3 | Vite-compat `import.meta.hot` subset + HMR replay (B8) + layout-update 구현 | R1 | C | frontend-architect |
| 4 | Contract/Resource/Middleware/Config/.env 감시 확장 | R2 | D | backend-architect |
| 5 | 36 시나리오 E2E 매트릭스 테스트 하니스 | R2 | E | quality-engineer |
| 6 | 성능 검증 + 벤치마크 리포트 | R3 | F | root-cause-analyst |
| 7 | Security audit (HMR XSS/CSRF/WS 인증) | R4 | G | security-engineer |

**스코프 제외 (Phase 7.1 follow-up)**: `--compile` 단일 바이너리 배포 / Windows workaround 원복 검증 / Remix HDR 풀버전 (slot 리페치 without UI remount).

---

## 3. 공유 타입·인프라 계약 — 사전 확정 (Pre-R1, 내가 직접)

**R1 시작 전 내가 작성**해 3 에이전트가 동일 계약 consume.

### 3.1 `packages/core/src/bundler/hmr-types.ts` (신규)

Vite 호환 WS payload + 내부 메시지:

```ts
// Vite 호환 wire format (외부 툴 + 플러그인 호환성)
export type ViteCompatHMRPayload =
  | { type: "connected" }
  | { type: "update"; updates: Array<{ type: "js-update"|"css-update"; path: string; timestamp: number }> }
  | { type: "full-reload"; path?: string }
  | { type: "prune"; paths: string[] }
  | { type: "error"; err: { message: string; stack?: string; loc?: { file: string; line: number; column: number } } };

// Mandu 내부 확장 (layout-update, island-update, kitchen:*)
export type ManduHMRMessage = ViteCompatHMRPayload | {
  type: "island-update" | "layout-update" | "guard-violation" | "kitchen:file-change" | "kitchen:guard-decision";
  // ...
};

// import.meta.hot API 타입 (subset)
export interface ManduHot {
  readonly data: any;
  accept(cb?: (newMod: any) => void): void;
  accept(dep: string, cb: (newMod: any) => void): void;
  dispose(cb: () => void): void;
  invalidate(message?: string): void;
  on(event: ViteHotEvent, cb: (payload: any) => void): void;
}
```

### 3.2 `packages/core/src/perf/hmr-markers.ts` (신규)

B4 해결 — 측정 인프라:

```ts
export const HMR_PERF_MARKERS = {
  FILE_DETECT: "hmr:file-detect",
  DEBOUNCE: "hmr:debounce",
  REBUILD_TOTAL: "hmr:rebuild-total",        // 파일 save → WS broadcast 완료까지
  SSR_HANDLER_RELOAD: "ssr:handler-reload",   // ← B4 신규
  SSR_BUNDLED_IMPORT: "ssr:bundled-import",   // ← B4 신규
  SSR_CLEAR_REGISTRY: "ssr:clear-registry",   // ← B4 신규
  HMR_BROADCAST: "hmr:broadcast",              // ← B4 신규
  ISLAND_REBUILD: "island:rebuild",
  PRERENDER_REGEN: "prerender:regen",          // ← #188 신규
} as const;
```

### 3.3 `packages/core/src/bundler/scenario-matrix.ts` (신규)

36 시나리오 enum — R2 E 테스트 + R3 F 검증에서 공유:

```ts
export const PROJECT_FORMS = ["pure-ssg", "hybrid", "full-interactive"] as const;
export const CHANGE_KINDS = [
  "app/page.tsx",
  "app/slot.ts",
  "app/layout.tsx",
  "app/contract.ts",
  "spec/resource.ts",
  "app/middleware.ts",
  "island.client.tsx",
  "src/shared/**",
  "src/top-level.ts",     // ← B1 신규 커버
  "css",
  "mandu.config.ts",      // ← D 신규 커버
  ".env",                 // ← D 신규 커버
] as const;
// 36 = 3 × 12
```

---

## 4. 에이전트 I/O 명세

### Agent A — Reliability + #188 Fix (backend-architect, R1)

**파일**:
- `packages/core/src/bundler/dev.ts` (수정 — watch/debounce/common-dir handler)
- `packages/cli/src/commands/dev.ts` (수정 — handleSSRChange perf marker wiring + #188 prerender regen)
- `packages/core/src/bundler/__tests__/dev-reliability.test.ts` (신규)

**Input**: `hmr-types.ts`, `hmr-markers.ts`, `scenario-matrix.ts`

**Output**:
- **B1**: `DEFAULT_COMMON_DIRS` 제거 → `src/` 최상위 recursive watch + exclude (`node_modules`, `.mandu`, `dist`, `build`, `pagefile.sys`, `hiberfil.sys`)
- **B2**: `pendingBuildFile: string | null` → `pendingBuildSet: Set<string>` + coalesce 로직
- **B4**: `withPerf("ssr:handler-reload", ...)` 등 4곳 마커 추가 (`hmr-markers.ts` 사용)
- **B6**: 전역 `debounceTimer` → `Map<string, Timer>` 파일별 debounce + batch collect
- **#188 Fix**: `isInCommonDir` 분기에서 `buildClientBundles` 뒤에 **prerender 재실행**. hydration: none 프로젝트에서도 full-reload 트리거.

**단위 테스트 ≥15**: rapid-fire 3 파일, 동시 touch 2 파일, 빌드 중 변경 drop 방지, `src/top-level.ts` 감지, #188 재현 (manifest route들에 대한 prerender 재호출 확인).

### Agent B — Incremental bundledImport (backend-architect, R1)

**파일**:
- `packages/cli/src/util/bun.ts` (수정 — `createBundledImporter` 증분화)
- `packages/cli/src/util/import-graph.ts` (신규 — import graph tracker)
- `packages/cli/src/util/__tests__/incremental-bundled-import.test.ts` (신규)

**Input**: `hmr-markers.ts` (SSR_BUNDLED_IMPORT marker)

**Output**:
- Bun.build `outputs[].imports` 배열 활용해 **각 소스의 import graph 추적** (파일 → descendants 맵)
- `bundledImport(rootPath, { changedFile })` 시그니처 확장: 변경된 파일이 root 의 descendants 에 없으면 **이전 번들 재사용** (no rebuild).
- 변경된 파일이 descendants 에 있으면 **해당 root 만** 재번들 (기존 동작 유지).
- 첫 호출 (cold) 은 full build — 이후 캐시.
- GC: import graph 기준 unreachable 번들 정리.

**단위 테스트 ≥12**: 무변경 시 cache hit, descendants 변경 시 해당 root rebuild, sibling 변경 시 무반응, transitive 체인 (A→B→C) 변경, alias (`@/*`) 경로, 순환 import 감지 → graceful fallback to full rebuild.

**이 에이전트가 Phase 7 전체의 SPEED 목표 달성 핵심**. 구현 품질이 가장 중요.

### Agent C — Vite-compat `import.meta.hot` subset + HMR Replay (frontend-architect, R1)

**파일**:
- `packages/core/src/bundler/dev.ts` (수정 — HMR client script + broadcast 재발송 큐)
- `packages/core/src/runtime/hmr-client.ts` (신규 — `import.meta.hot` runtime 구현)
- `packages/core/src/bundler/__tests__/hmr-client.test.ts` (신규)

**Input**: `hmr-types.ts` (`ManduHot`, `ViteCompatHMRPayload`)

**Output**:
- **Vite subset**: `import.meta.hot.accept(cb?)` / `accept(dep, cb)` / `dispose(cb)` / `data` / `invalidate(msg?)` / `on(event, cb)` (최소 4 이벤트: `vite:beforeUpdate`, `vite:afterUpdate`, `vite:beforeFullReload`, `vite:error`). `prune` / `send` / multi-dep accept 는 7.1.
- **layout-update 구현**: 현재 타입만 있고 서버 송신 코드 없음 (`hmr-internals.md §3.1`). `layout.tsx` 변경 시 `{ type: "layout-update", ... }` broadcast → 클라이언트는 full reload.
- **HMR replay (B8)**: 서버에 `lastRebuildId` 보관. 클라 reconnect 시 `ws://.../?since=<id>` 쿼리 파라미터로 놓친 broadcast 재발송.
- **Vite-compat wire format**: 기존 HMRMessage 는 내부 유지하되, Vite 호환 payload 도 함께 send — 외부 devtool 호환.

**단위 테스트 ≥12**: accept self-callback 동작, accept dep-callback, dispose 순서 (교체 전 호출), invalidate 시 full reload, WS 끊김 후 재연결 시 missed reload 수신, layout-update payload 전송, Vite `on('vite:beforeUpdate')` 콜백 발동.

### Agent D — Extended File Watch (backend-architect, R2)

**파일**:
- `packages/core/src/bundler/dev.ts` (수정 — 새 watcher 연결)
- `packages/cli/src/commands/dev.ts` (수정 — config/env restart 핸들러)
- `packages/core/src/bundler/__tests__/extended-watch.test.ts` (신규)

**Input**: R1 산출물 (`pendingBuildSet`, perf markers)

**Output**:
- `spec/contracts/*.contract.ts` 변경 → 해당 route 핸들러 재등록 (기존 slot path 에 묶음).
- `spec/resources/*.resource.ts` 변경 → `generateResourceArtifacts` 자동 실행 + 핸들러 재등록.
- `app/**/middleware.ts` 변경 → 라우트 재스캔.
- `mandu.config.ts` / `.env*` 변경 → `restartDevServer()` 자동 호출 (토스트 메시지 포함).
- `package.json` 변경 → 감지 후 "restart required" 알림만 (자동 재시작은 risky).

**단위 테스트 ≥10**: 각 파일 종류별 감지 → 핸들러 재등록 확인, config 변경 → 재시작 트리거, env 재로드.

### Agent E — 36-Scenario E2E Matrix (quality-engineer, R2)

**파일**:
- `packages/core/tests/hmr-matrix/` (신규 디렉토리)
- `packages/core/tests/hmr-matrix/fixture-ssg.ts` / `fixture-hybrid.ts` / `fixture-full.ts` (3 fixture demo 또는 기존 demo 확장)
- `packages/core/tests/hmr-matrix/matrix.spec.ts` (Playwright + dev server spawn)

**Input**: R1 + R2 D 산출물 + `scenario-matrix.ts`

**Output**:
- **3 프로젝트 형태 × 12 파일 종류 = 36 cells**. 각 cell 에 대해:
  1. dev 서버 spawn
  2. 대상 파일 수정
  3. HMR 메시지 수신 또는 브라우저 HTML 변경 확인
  4. 목표 latency 달성 여부 측정 (soft assertion — R3 F 에서 hard)
- Windows + Linux 양쪽에서 돌아가도록 path normalize 테스트 포함
- `MANDU_SKIP_BUNDLER_TESTS=1` gate 사용 (CI 성능 보호)

**단위 테스트 ≥36 (1 per cell) + 5 regression** (#188, rapid-fire, reconnect, stale island, layout-update).

### Agent F — Perf Validation + Benchmarks (root-cause-analyst, R3)

**파일**:
- `docs/bun/phase-7-benchmarks.md` (신규 — 최종 벤치 리포트)
- `scripts/hmr-bench.ts` (신규 — 반복 실행 스크립트)

**Input**: Rounds 1/2 전부

**Output**:
- 36 cell × N 회 측정 → P50/P95/P99 latency 표
- 목표치 대비 pass/fail 판정
- 추가 회귀 발견 시 원인 pin-point (파일:라인 + 병목 후보)
- Phase 7.1 로 미루는 gap 명시

**Hard assertion**:
- SSR ≤ 200 ms P95 (B5 fix 후)
- Island ≤ 50 ms P95
- Cold ≤ 500 ms

### Agent G — Security Audit (security-engineer, R4)

**파일**: `docs/security/phase-7-audit.md` + 발견 시 fix

**Focus**:
- HMR WebSocket 인증 (Vite 교훈 — 029dcd6 커밋)
- Error overlay XSS (#118 재발 방지)
- HMR `full-reload` 메시지 스푸핑 가능성
- `bundledImport` 에서 쓰는 tmp 경로 path traversal
- Dev server localhost binding 강제
- `mandu.config.ts` auto-restart 시 config injection
- WS broadcast queue (replay) 에 민감정보 노출 여부

**Deliverable**: 감사 리포트 + Critical/High 즉시 fix.

---

## 5. 의존성 DAG

```
[Pre-R1 (me)]
  hmr-types.ts + hmr-markers.ts + scenario-matrix.ts
        ↓
[R1 병렬 3 — 공유 타입만 공유, 파일 겹침 관리]
  A: Reliability + #188       ─┐
     (dev.ts watch/common-dir)  ├─→ merge ──┐
  B: Incremental bundledImport ─┤           │
     (cli/util/bun.ts 독립)      │          │
  C: import.meta.hot + replay  ─┘            │
     (dev.ts HMR client + broadcast)          │
                                              ↓
[R2 병렬 2 — R1 산출물 consume]
  D: Extended watch                ─┐
  E: 36-scenario E2E                ─┴→ merge ──┐
                                                  ↓
[R3 단일 — 최종 검증]
  F: Perf benchmark + hard assertion
                                        ↓
[R4 단일]
  G: Security audit
```

**병렬 시 파일 충돌 관리**:
- A: `dev.ts:60~230` (watch/debounce/handleFileChange 영역) + `dev.ts:260~340` (common-dir 블록)
- B: `packages/cli/src/util/bun.ts` (완전 독립)
- C: `dev.ts:440~811` (HMR 클라이언트 스크립트 + broadcast)

A 와 C 가 같은 파일의 다른 섹션. 에이전트 브리핑에서 **"너의 수정 범위는 line X~Y, 그 외 변경 금지"** 명시. Phase 4c 때보다 조심.

---

## 6. v1 스코프 경계 (명시적 주지)

**포함 (Phase 7.0)**:
- B1 / B2 / B4 / B6 신뢰성 hole
- B5 증분 bundledImport (SPEED 핵심)
- B3 vendor shim cache (optional, 시간 되면 A 에 포함)
- Issue #188 prerender 재생성
- Vite `import.meta.hot` subset (accept/dispose/data/invalidate/on 4 이벤트)
- HMR replay (B8)
- layout-update 서버 송신
- Contract/Resource/Middleware/Config/Env 감시
- 36-scenario E2E matrix
- Vite 호환 wire format (읽기 전용)

**제외 (Phase 7.1+)**:
- `mandu build --compile` 단일 바이너리 (`docs/bun/phases-4-plus.md §5 7.2`)
- Windows workaround 원복 검증 (§5 7.3)
- `import.meta.hot.prune / send / off` — 플러그인 생태계 생길 때
- HMR 토큰 인증 — 원격 dev 시나리오 생길 때
- Remix HDR 풀버전 (slot 리페치 without UI remount)
- Single-port HMR (현재 port+1 유지)

---

## 7. 품질 게이트

모든 에이전트 merge 조건:
1. 자신의 모듈 단위 테스트 요구 수량 달성 (A ≥15, B ≥12, C ≥12, D ≥10, E ≥36)
2. `bun run test:core` 2147+ pass, 0 fail (Phase 4c 기준선)
3. `bun run test:cli` 160+ pass
4. `bun run typecheck` 4 패키지 clean
5. R2+: auth-starter E2E 14/14 유지 (regression 금지)
6. R3 특수: 목표 latency **hard assertion** (SSR ≤200ms P95, Island ≤50ms P95, Cold ≤500ms)

---

## 8. 리스크 & 방어

| 리스크 | 담당 | 방어 |
|---|---|---|
| R7-A: A 와 C 가 `dev.ts` 다른 섹션 동시 수정 — merge conflict | A + C | 브리핑에서 line 범위 명시 + 순차 검증 (내가 A 먼저, 그 다음 C apply) |
| R7-B: B 증분 로직 버그 — import graph 오판 → stale SSR | B + F | Bun.build `outputs[].imports` 만 신뢰, tsconfig alias 통과 테스트 6종, 순환 import graceful fallback |
| R7-C: B5 목표 미달 시 SPEED 전체 실패 | B + F | Tier 1 집중. 미달 시 Phase 7.1 로 분리 + SSR 200ms 목표 300ms 로 완화 고려 |
| R7-D: #188 재현 E2E 가 Windows 에서 flaky | E + F | `MANDU_DEV_WATCH=polling` env 옵션 제공, Linux 에서 hard assertion + Windows 에서 soft |
| R7-E: 36 cell 모두 통과 어려움 (불확실 cell) | E | 불확실 9 cell 은 D 의 감지 확장 후 최종 판정 |
| R7-F: HMR XSS 재발 (#118 교훈) | C + G | error overlay 메시지 escape 유지 + G 감사 hard check |
| R7-G: Ghost WebSocket (끊김 후 재연결 실패) | C | exponential backoff 최대 30 s 유지 + server `lastRebuildId` 로 idempotent replay |

---

## 9. 커밋 전략

라운드별 커밋 (bisect 용이):
- `feat(core,cli): Phase 7.0.R1 — HMR reliability + #188 fix + incremental bundled import + Vite-compat subset`
- `feat(core,cli): Phase 7.0.R2 — extended file watch + 36-scenario E2E matrix`
- `test(bench): Phase 7.0.R3 — perf validation with hard assertions`
- `security(core): Phase 7.0.R4 — audit report + fixes`

각 커밋 pre-push typecheck 필수.

---

## 10. 예상 완료 시간

- Pre-R1 (me): 10~15분 (3 파일 작성)
- R1 (병렬 3, B 가장 복잡): 35~50분
- R2 (병렬 2, E 가장 큼): 30~40분
- R3 단일: 20~30분
- R4 단일: 15~20분

**전체 wall clock**: 2~3시간.

---

## 11. 실행 순서 체크리스트

- [x] 4 진단 에이전트 완료 + 통합 보고 (2026-04-18)
- [x] 이 팀 플랜 문서 작성
- [ ] Pre-R1: 공유 타입 3파일 작성
- [ ] R1 3 에이전트 브리핑 + 파견 (A 와 C dev.ts 라인 범위 명시)
- [ ] R1 완료 검증 + merge (A → C 순서로 apply 권장)
- [ ] R1 커밋 + 푸시
- [ ] R2 2 에이전트 브리핑 + 파견
- [ ] R2 완료 검증 + 커밋 + 푸시
- [ ] R3 Perf validation — hard assertion pass 여부
- [ ] R3 커밋 + 푸시
- [ ] R4 보안 감사 파견
- [ ] R4 감사 리포트 검토 + 발견 사항 fix + 커밋 + 푸시
- [ ] Phase 7.0 종료 보고 (Phase 7.1 스코프 확정)

*이 문서는 실행 중 업데이트 금지. 변경 필요 시 ADR/RFC 추가.*
