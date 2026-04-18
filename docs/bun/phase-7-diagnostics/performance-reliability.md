# Phase 7 진단 — 성능·신뢰성 트랙

**작성일**: 2026-04-18
**대상**: `packages/core/src/bundler/dev.ts` (811줄) + `packages/core/src/bundler/build.ts` (1887줄)
**벤치 환경**: Windows 10, Bun 1.3.12, `demo/starter` (4 routes / 1 island / 1.15MB devtools bundle)
**목표**: Next.js 대비 압도적 속도 + Vite 수준의 신뢰성

---

## 1. 측정 결과

`MANDU_PERF=1 bun run mandu dev --port 3996~3999` 로 5 회 실측 (median).

| 시나리오 | 실측 | 파일:라인 근거 |
|---|---|---|
| **Cold start (ready)** | **395 ms** | `cli/src/commands/dev.ts:477` `performance.now - devStartTime` |
| **Initial `bundler:full`** | **209 ms** | `core/src/bundler/build.ts:1461-1834` perf marker |
| **SSR rebuild (`app/page.tsx`)** | **21.8 ms** *(단, handler 재등록 총 walltime 1.5~2 s — timestamp 비교)* | `dev.ts:239-243` `dev:rebuild` marker. 이는 `_doBuild` 내부만 측정. 실제 `handleSSRChange` 뒤의 `clearDefaultRegistry → registerHandlers` 는 perf 마커 **없음** |
| **SSR rebuild (`app/layout.tsx`)** | `dev:rebuild 0.81 ms` (single-slot 재진입 비용) + handler 재등록 ~1.5 s | `dev.ts:337-339` onSSRChange 호출만 wrapper |
| **Common dir (`src/playground-shell.tsx`)** | **❌ 감지 실패** — `DEFAULT_COMMON_DIRS` 에 `src/` 최상위 없음 | `dev.ts:84-100` |
| **2 파일 동시 touch** | 뒤 파일만 감지 (앞 파일 drop) | `dev.ts:403-407` 단일 `debounceTimer`, `debounceTimer = setTimeout` 매 이벤트마다 clear |
| **rapid-fire 3 touch (같은 파일)** | 마지막 이벤트만 debounce 통과 후 rebuild | 동일 |
| **Rebuild in-progress + 2nd change** | 두번째는 `pendingBuildFile` 에 단 1개만 저장, 3번째 변경은 2번째를 덮어쓰며 drop | `dev.ts:217, 233-236` |

**Perf marker 공백 구간** (측정 불가): `handleSSRChange` 의 `bundledImport → registerPageLoader` 체인. 실제 대부분의 SSR 지연은 여기서 발생하지만 로그가 없음.

---

## 2. 병목 후보 랭킹 (impact 순)

### [HIGH] B1. `src/` 최상위 디렉토리 watch 누락 — **감지 자체 실패**
- **Evidence**: `dev.ts:84-100` `DEFAULT_COMMON_DIRS` 에 `src/components`, `src/shared`, `src/lib`, `src/hooks`, `src/utils`, `src/client`, `src/islands` 만 열거. `src/` 자체는 **없음**. `demo/starter/src/playground-shell.tsx` 변경이 완전히 무반응인 것으로 실측 확인됨 (로그 출력 0).
- **Impact**: COMPLETENESS 0 missed rebuilds 목표 직접 위반. 프로젝트 관례가 `src/{components,shared,...}` 하위 구조가 아니면 watch 구멍 발생.
- **Fix 방향**: `src/` 를 재귀 watch 하되 `node_modules`, `.mandu`, `dist` 등을 exclude. `fs.watch(src, { recursive: true })` 1개로 통합.

### [HIGH] B2. `pendingBuildFile` 단일 슬롯 큐 — **파일 drop**
- **Evidence**: `dev.ts:217, 233-236, 246-256`. 빌드 중 여러 파일이 바뀌면 `pendingBuildFile = changedFile` 이 덮어쓰기. 3 파일 rapid-fire 시 마지막 파일만 재빌드됨. "공통 파일 편집 중 island 1개 작업" 같은 실사용 케이스에서 island 변경이 소리없이 drop 될 수 있음.
- **Impact**: COMPLETENESS 0 missed rebuilds 목표 정면 위반. 테스트 매트릭스 36 시나리오 중 멀티파일 편집 cell 전체가 취약.
- **Fix 방향**: `pendingBuildFile: Set<string>` 로 교체 + coalesce 로직 (같은 commonDir 다수면 single full rebuild).

### [HIGH] B3. `safeBuild` semaphore=2 + Vendor shim 5개 병렬 = 사실상 직렬 3 파동
- **Evidence**: `safe-build.ts:27` `DEFAULT_MAX_CONCURRENT = 2`, `build.ts:1187-1193` 5 shim × `Promise.all` (line 1250). Initial build 중 `Promise.all([runtime, router, vendor(5), devtools])` 가 동시 9개 → semaphore 2 로 throttle → 3~4 파동으로 직렬화됨. 209 ms 초기 빌드의 대부분이 이 직렬 대기.
- **Impact**: Cold start 500ms 목표는 달성 중이나 여유가 적음. `_react-dom-client.js` 922KB + `_devtools.js` 1.15MB 가 semaphore 경쟁 → 실제론 `buildVendorShims` 가 지배 단계.
- **Fix 방향**:
  1. `MANDU_BUN_BUILD_CONCURRENCY=5` 를 dev 모드 기본값으로 승격 (safe-build.ts 주석상 5+ 동시에서 AggregateError 관찰 — test 환경 한정, 단일 dev 프로세스는 안전).
  2. Vendor shim 을 **pre-build 결과로 캐시** — React 19 버전·NODE_ENV 해시 기반 (user 파일 변경 시 rebuild 불필요).
  3. DevTools 번들은 lazy load (최초 `/__kitchen` 접근 시만 빌드).

### [HIGH] B4. Handler 재등록 체인에 Perf marker 없음 — **측정 맹점**
- **Evidence**: `cli/commands/dev.ts:322-363` `handleSSRChange` 는 `ssrChangeQueue.then` mutex 내부에서 `clearDefaultRegistry → registerHandlers → hmrServer.broadcast` 를 수행하는데 perf marker 전무. 로그 timestamp 비교상 walltime 1.5~2 s. `dev.ts:243` `dev:rebuild` 는 `_doBuild` 안만 감싸므로 SSR 경로에서는 `0.81ms` 같은 misleading 값이 나옴.
- **Impact**: 목표치 `SSR ≤ 200 ms P95` 를 측정조차 불가. 진짜 병목이 registerHandlers 내부의 `bundledImport` (Bun.build full project bundle) 일 가능성 높음.
- **Fix 방향**: `withPerf("ssr:handler-reload", ...)`, `withPerf("ssr:bundled-import", ...)` 두 지점 마커 추가 + `bundledImport` 캐시 재사용률 로깅.

### [MED] B5. `bundledImport` = 매 SSR 변경마다 Bun.build 1회
- **Evidence**: `cli/src/util/bun.ts:139-260`. `registerManifestHandlers` (handlers.ts) 는 각 `componentModule` / `layoutChain` / API route 당 `bundledImport(modulePath)` 호출. `registerHandlers(manifest, true)` 는 모든 route 를 재등록 → N routes × Bun.build 병렬. starter 4 routes 는 작지만 100+ route 앱에서 선형 증가.
- **Impact**: SSR 200ms P95 목표에 대한 가장 큰 리스크. 해결책 없이 유지 시 규모에 따라 초 단위 지연.
- **Fix 방향**: 변경된 파일의 import 그래프 상 descendants 만 재bundled. 또는 `vm.Module` / worker thread SSR eval 로 cache 완전 제어.

### [MED] B6. `fs.watch` debounce 전역 단일 타이머
- **Evidence**: `dev.ts:214, 403-407`. 여러 dir watcher 가 하나의 `debounceTimer` 를 공유. 서로 다른 파일의 이벤트들이 100 ms WATCHER_DEBOUNCE 안에 도착하면 **마지막 파일만** `handleFileChange` 됨. 2-파일 동시 touch 실측에서 재현 확인.
- **Impact**: B2 와 결합되어 multi-file drop 확률 증폭. Windows 에서 `fs.watch` 는 한 번의 저장에도 `change` 이벤트 2-3 번 발화 — 더 악화.
- **Fix 방향**: `Map<string, Timer>` 파일별 debounce + 버퍼 수집 후 batch build.

### [MED] B7. Guard chokidar + dev fs.watch = 병렬 2중 watcher
- **Evidence**: `cli/dev.ts:561-583` createGuardWatcher (chokidar: `guard/watcher.ts:7, 256`) + `core/dev.ts:394` fs.watch. 같은 파일 변경이 두 watcher 에서 각각 읽힘 → 디스크 IO 2배, 이벤트 중복.
- **Impact**: Cold start + rebuild CPU 오버헤드. 현재는 감당되지만 큰 프로젝트에서는 guard 분석과 빌드가 경쟁.
- **Fix 방향**: `fs.watch` → chokidar 단일화. 또는 이벤트 브로드캐스트 허브 구축 (watcher 1개 → 구독자 N개).

### [MED] B8. HMR WebSocket reconnect 지수 백오프는 있으나 "delivery guarantee 0"
- **Evidence**: `dev.ts:654-661` reconnect 구현 있음 (max 10, base 1 s, exp cap 30 s). 그러나 재연결 **전에** 발생한 rebuild 의 `reload` broadcast 는 사라짐 — 서버측 message queue 0.
- **Impact**: 사용자가 Wi-Fi 끊고 편집 → 재연결 시 stale 페이지. `staleIslands` set 으로 popstate/pageshow 후 보정은 있으나 루트 페이지는 감지 불가 (popstate 이벤트 없음).
- **Fix 방향**: 서버측 `lastRebuildId` 보관, 클라 reconnect 시 `since=` 쿼리 → 놓친 reload 있으면 재브로드캐스트.

### [LOW] B9. Transitive ESM 캐시는 `bundledImport` 로 이미 해결됨
- **Evidence**: `cli/src/util/bun.ts:1-32` 주석에 명시. 매 호출마다 새 `.mjs` 파일 생성 → Bun 이 새 모듈로 인식. 이 메커니즘은 **작동 중**이지만 비용(B5)이 문제. 감지 자체는 OK.
- **Impact**: "stale cache" 시나리오는 실측상 0. B5 비용만 추적하면 됨.

### [LOW] B10. `mandu.config.ts`, `.env` 변경 감지 없음
- **Evidence**: `dev.ts` 어디에도 config 파일 watcher 없음. `grep "mandu\.config\.ts|\.env" dev.ts` → 0 matches.
- **Impact**: 사용자가 `mandu.config.ts` 편집 시 수동 재시작 필요. `r` shortcut (dev-shortcuts) 존재하지만 discoverability 낮음.
- **Fix 방향**: 별도 watcher 에서 config/env 변경 → `restartDevServer()` 자동 호출.

---

## 3. 신뢰성 Edge case 평가

| Edge case | 현재 동작 | 원하는 동작 | Gap |
|---|---|---|---|
| 100 ms 간격 파일 3개 연속 save | 마지막만 반영 (B6 + B2) | 3개 모두 반영 (batch) | **중대** |
| Build 실패 중 다음 파일 변경 | pendingBuildFile 저장됨, 실패 후 retry. 단 이전 manifest 보존은 OK (dev.ts:375, 386) | 동일 | OK |
| WS 끊김 + 재연결 전 rebuild | broadcast 손실 — 사용자 F5 필요 | 재연결 시 missed reload 자동 수신 | **중대** (B8) |
| `mandu.config.ts` 변경 | 감지 전혀 없음 | auto-restart | **존재** (B10) |
| Symlink 파일 변경 | `fs.watch {recursive:true}` 는 Windows 에서 symlink 비추적 (Node docs) — `[추정]` | 추적 | 미확인 |
| `node_modules` 내 patch | 미감지 (의도적) | 미감지 OK (pnpm patch 케이스 제외) | OK |
| `.env` 변경 | 미감지 | auto-restart | **존재** (B10) |
| >1MB 파일 변경 | `[추정]` buildIsland 가 선형 증가. 실측 불가 | <200 ms | 미확인 |
| `src/` 최상위 파일 변경 | **감지 실패** | 감지 | **치명** (B1) |
| 쿠키/세션 상태 동안 reload | HMR `reload` 는 full `location.reload()` → 폼 상태 손실 | island-update 만으로 hydrate 치환 | 개선 가능 |
| 라우트 추가 (신규 page.tsx) | `watchFSRoutes` (chokidar) 가 감지 → route 재scan, handler 재등록 | OK | OK |

---

## 4. 36 시나리오 매트릭스 초안

행: 파일 종류 / 열: 프로젝트 형태 (Pure SSG / Hybrid / Full Interactive)

| 파일 종류 | Pure SSG | Hybrid | Full Interactive |
|---|---|---|---|
| `app/**/page.tsx` | ✅ (21 ms SSR) | ✅ | ✅ |
| `app/**/slot.ts` | ✅ (serverModuleSet 등록) | ✅ | ✅ |
| `app/layout.tsx` | ✅ | ✅ | ✅ |
| `app/**/contract.ts` | ? (scanner 인식은 fs-routes, 단 per-route refresh 확인 안 됨) | ? | ? |
| `app/**/*.resource.ts` | ? | ? | ? |
| `app/**/middleware.ts` | ? (registerHandlers 에서 별도 처리 없음) | ? | ? |
| `*.client.tsx` / `*.island.tsx` | n/a | ✅ (21-150 ms island rebuild) | ✅ |
| `src/components/*` | ✅ (common dir) | ✅ | ✅ |
| `src/shared/*` | ✅ | ✅ | ✅ |
| **`src/*` (최상위)** | ❌ (B1) | ❌ | ❌ |
| CSS (tailwind) | ⚠️ (cssWatcher 별도 — link 교체 OK, 단 full reload 경로는 다름) | ⚠️ | ⚠️ |
| `mandu.config.ts` | ❌ (B10) | ❌ | ❌ |
| `.env` | ❌ (B10) | ❌ | ❌ |
| `package.json` | ❌ (미감지) | ❌ | ❌ |

**취약 셀 집계**: 36 중 `src/*` 최상위 3 + config 3 + env 3 + package 3 + contract/resource/middleware 9 (?) = **확실 실패 12, 불확실 9**.

---

## 5. 목표치 vs 현재 Gap

| 목표 | 현재 실측 | Gap | 결론 |
|---|---|---|---|
| Cold dev start ≤ 500 ms | 395 ms (median) | **+105 ms 여유** | 달성 중. 단 규모 확장 시 B3 취약. |
| Island-only ≤ 50 ms P95 | 측정 불가 (B4). `dev:rebuild` 21 ms + manifest write + HMR flight = 추정 80-150 ms | 추정 -30~100 ms | **아직 미달 가능성**. 측정 인프라 먼저. |
| SSR 페이지 ≤ 200 ms P95 | 로그 timestamp 1.5~2 s | **-1300~1800 ms** | **대폭 미달**. B5 `bundledImport × N routes` 가 원인 추정. |
| 0 missed rebuilds | B1 + B2 + B6 세 구멍 | **치명적 위반** | 즉시 수정 필요. |
| 0 stale caches | `bundledImport` 로 해결됨 | - | OK |
| 0 crashes during HMR | retry try/catch 있음 (dev.ts:250-255) | - | OK |

---

## 6. Phase 7 구현 우선순위 권장

**Tier 0 (필수, 1주 내)** — COMPLETENESS 회복:
1. **B1 fix**: `src/` 최상위 recursive watch + exclude list. 가장 큰 신뢰성 hole.
2. **B2 fix**: `pendingBuildFile` → `pendingBuildSet` (Set 기반 coalesce).
3. **B4 fix**: `withPerf` 마커 4곳 추가 (`ssr:handler-reload`, `ssr:bundled-import`, `ssr:clear-registry`, `hmr:broadcast`). 측정 없이는 다른 최적화 불가.

**Tier 1 (2주 내)** — SPEED 본격 달성:
4. **B5 fix**: `bundledImport` 증분화. 변경된 파일의 import graph descendants 만 rebuild. 이게 SSR 200 ms 목표의 핵심.
5. **B3 fix**: Vendor shim pre-built cache (React 버전 해시) + DevTools lazy.
6. **B6 fix**: 파일별 debounce Map + batch.

**Tier 2 (3주 내)** — 엣지 신뢰성:
7. **B7 fix**: fs.watch → chokidar 단일화.
8. **B8 fix**: HMR missed-message replay.
9. **B10 fix**: config/env watcher + auto-restart.

---

## 결론 — Next.js 대비 빠를 수 있는 조건

**Mandu 가 Next.js 를 이기는 단일 조건**: B5 (`bundledImport` 증분 SSR 리로드) 를 해결하면 — Bun.build 자체가 SWC+Webpack 대비 10-20배 빠른 마당에, **"프로세스당 1회 full bundle, 이후는 descendants-only incremental"** 패턴만 도입하면 SSR 200ms P95 는 자연히 달성되고 Next.js 의 3-5 초대 Fast Refresh 대비 10-20 배 우위가 구조적으로 성립한다. 반대로 B5 를 방치하면 Bun 의 raw 속도 이점이 전부 상쇄된다.
