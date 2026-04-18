# Phase 7 진단: HMR / dev-watch / prerender / hot-reload 이슈 + 테스트 커버리지

조사일: 2026-04-18 · 대상 레포: `konamgil/mandu` · 브랜치: `main`

---

## 1. Open 이슈 (우선순위 높음)

| # | 제목 | 라벨 | 영향 범위 | 비고 |
|---|---|---|---|---|
| **188** | `mandu dev --watch` 공통 디렉터리 변경 시 prerender HTML이 갱신되지 않음 (hydration: none) | — | dev 서버, pure-SSR/static 사이트 | `buildClientBundles` 호출만 하고 prerender 재실행/SSR 캐시 무효화 없음. #184 partial fix의 잔존. **Phase 7 핵심 목표**. |

_총 HMR/dev-watch 관련 open 이슈: **1건**. Closed 39건._

---

## 2. Closed (해결됨) — 최근 우선순위 순

| # | 제목 | 해결 커밋 | 어떻게 해결했나 |
|---|---|---|---|
| **184** | 공통 디렉토리 변경 시 SSR 모듈 캐시 invalidate 안 됨 | `76669b0`, `9722d45`, `4b0a9b4`, `04e74a5` | `createBundledImporter` 도입 — 매 reload마다 user 코드를 단일 ESM bundle로 합쳐 새 URL로 import → Bun ESM 캐시 우회. `SSR_CHANGE_WILDCARD` 시그널로 전체 레지스트리 invalidate. |
| **185** | dev rebuild가 너무 느림 (cold Bun.build 반복, devtools 매번 재빌드) | `9722d45` | `buildClientBundles`에 `skipFrameworkBundles` 옵션 추가. common-dir 변경 시 framework 번들(runtime/router/vendor/devtools) 스킵 → island만 재빌드. |
| **186** | SSR `<title>` / meta 태그 미연결 + hardening 항목 | `ec8a9ae`, `60e6e3b`, `4b0a9b4` | `export const metadata` / `generateMetadata` wiring + corrupt manifest fallback + 필수 필드 검증 + SSR change Promise-chain mutex. |
| **187** | subprocess/worker-based SSR eval (blocks #184) | `76669b0` | Worker 격리 대신 `createBundledImporter` 접근으로 해결 (동일 프로세스 내 bundle-and-import 방식). |
| **180** | Dynamic route 폴더(`[lang]`)의 `layout.tsx` 변경 감지 안 됨 | `640c541` | `normalizeFsPath` 도입 — Windows 드라이브 대소문자/슬래시 표기 차이 해결. |
| **181–183** | (관련 open 이슈 3건) | `640c541` | 배치 처리됨. |
| **175** | `dev.hmr` 기본값 false → devtools WebSocket 실패 | (hotfix) | `hmrEnabled = devConfig.hmr ?? true`로 변경. |
| **176** | DevTools WebSocket URL이 `localhost:3333` 하드코딩 | (hotfix) | `window.location.hostname` 기반 동적 생성. |
| **177** | Dev SSR 응답에 `Cache-Control` 누락 → stale HTML | (hotfix) | dev 모드에서 Cache-Control 헤더 자동 추가. |
| **151** | SSR `page.tsx` HMR reload 안 됨 (서버 재시작 필요) | `4295807` | `serverModuleSet` 추가 + `onSSRChange` 콜백으로 핸들러 재등록. |
| **165** | SSE idle timeout | `4295807` | 배치 처리. |
| **140** | `*.client.tsx` 수정 시 HMR rebuild 미발동 (clientModule mismatch) | `05508af` | basename 매칭 대신 **디렉토리 기반** fallback 매칭 추가. |
| **144** | Kitchen DevTools 자동 마운트 안 됨 | `b7dd73a` | 전용 번들로 교체. |
| **149–150** | DevTools 이모지/버튼 리셋 | `96085ca` | 배치 처리. |
| **121** | 공유 debounce timer로 인한 concurrent build race → `island.js` 손상 | `09354de` | `isBuilding` / `pendingBuildFile` concurrency guard 추가. |
| **122** | 단일 island 변경이 전체 island 재빌드 유발 | `09354de` | `targetRouteIds` 옵션 추가 — 지정 island만 재빌드. |
| **119** | HMR WebSocket 재연결 exponential backoff 없음 | `09354de` | Exponential backoff 추가. |
| **115** | Page navigation 후 island 업데이트 미감지 | `09354de` | `popstate` 이벤트 훅 + stale island 추적. |
| **114** | `generateHMRScript` 중복 정의 + streaming/non-streaming 포맷 불일치 | `09354de` | ssr.ts ↔ streaming-ssr.ts 동기화. |
| **111** | CSS watcher stdout 패턴 불완전 → CSS HMR 미동작 | `92d71a4` | stdout 패턴 → `fs.watch(outputPath)` 파일 워처로 교체. |
| **123** | HMR `css-update` 메시지 silently ignored | `92d71a4` | 클라이언트 css-update 핸들러 추가. |
| **124** | Tailwind CLI stderr 진행 메시지가 에러로 처리됨 | `09354de` | ANSI stripping + 에러 판정 기준 개선. |
| **117** | Windows에서 Tailwind child process leak | `09354de` | SIGKILL 종료 + TIME_WAIT 재시도(3회). |
| **116** | Port conflict 경고 misleading | `09354de` | HMR 포트 할당 실제 수치 보고. |
| **120** | 포트 불일치 시 브라우저가 엉뚱한 WebSocket 포트 접속 | `09354de` | `PORTS.HMR_OFFSET` 합의 + 브라우저 환경변수 주입. |
| **118** | Dev error overlay XSS 취약점 | (hotfix) | 에러 메시지 escape. |
| **126** | Windows 백슬래시가 manifest/콘솔에 노출 | `09354de` | fs-scanner.ts / dev.ts 포워드슬래시 정규화. |
| **128** | `dev:safe` 스크립트 template에 누락 | (hotfix) | template 업데이트. |
| **110** | `@tailwindcss/cli` 미명시 + `bunx` 불안정 | (hotfix) | deps에 추가. |
| **108** | Tailwind 설치 가이드 개선 | (hotfix) | docs 업데이트. |
| **96**, **102**, **95**, **109** | React 19 hydration / layout 이중 HTML 구조 | (multiple) | Runtime/shim 정비. |
| **28** | dev 서버가 startup 직후 exit | `fdf4c27` | 프로세스 lifetime 유지 로직 추가. |
| **20**, **18** | react-dom bundle export 누락 | (hotfix) | vendor shim 재생성. |
| **164**, **152** | Hydration mismatch / ATE 리그레션 | (multiple) | 배치 처리. |

---

## 3. Closed (wontfix)

| # | 제목 | 이유 |
|---|---|---|
| **7** | Unhandled promise rejection in dev bundler | 이후 `#121`과 결합해 `try/catch` + `onError` 콜백으로 resolve됨 — `wontfix` 라벨은 중복 판정. |
| **3** | Race condition in concurrent file operations during build | `_runtime.src.js` unlink race. `safe-build` 세마포어 + unique 경로 채용 후 간접 해결. 원래 리포트는 `wontfix`. |
| **5** | Incomplete string validation after `.pop()` in dev.ts | 실제론 `filename.replace(".client.ts", ...).split("/").pop()` 경로 자체가 `#140`에서 재작성되며 제거됨. 원래 리포트는 `wontfix`. |

_`wontfix` 3건 전원 Jan-28 하루에 등록된 초기 정적 분석 결과. 이후 root-cause fix로 간접 해결됨._

---

## 4. 자주 참조되는 이슈 번호 (코드 주석 기반)

| 이슈 | 참조 위치 | 설명 |
|---|---|---|
| **#10** | `bundler/build.ts:1574` | 빌드 실패 시 이전 manifest 보존 규칙. |
| **#12** | `watcher/watcher.ts:132,176` | Windows 예약 장치 이름 필터링 (`CON`, `PRN` 등). |
| **#121** | `bundler/dev.ts:215,232`, `safe-build.ts` | Concurrent build 방지. |
| **#122** | `bundler/build.ts:1546`, `types.ts:135`, `dev.ts:357` | `targetRouteIds` per-island 빌드. |
| **#115** | `bundler/dev.ts:787` | Page navigation stale island 감지. |
| **#140** | `bundler/dev.ts:144,321` | `*.client.tsx` 디렉토리 기반 fallback. |
| **#151** | `bundler/dev.ts:159,336` | SSR module change (page.tsx, layout.tsx). |
| **#152** | `bundler/css.ts:10,23,110,186` | Tailwind `--watch` hang on Windows → 단발 빌드 + `fs.watch` 파일 감시. |
| **#180** | `bundler/dev.ts:69` | Windows path 정규화. |
| **#184** | `bundler/dev.ts:15,32,280,317`, `cli/dev.ts:166,317` | `SSR_CHANGE_WILDCARD` + `createBundledImporter`. |
| **#185** | `bundler/dev.ts:263,270`, `build.ts:1479,1601,1767`, `types.ts:141` | `skipFrameworkBundles` 최적화. |
| **#186** | `bundler/build.ts:1488,1494,1619`, `runtime/server.ts:404,492,583`, `cli/dev.ts:318` | Metadata API + hardening (mutex, corrupt JSON fallback). |
| **#187** | `cli/dev.ts:166` | bundle-and-import 패턴 (worker 대체). |

---

## 5. 테스트 커버리지 인벤토리

| 경로 | 테스트 수 | 커버 시나리오 | Skip 조건 |
|---|---|---|---|
| `packages/core/src/bundler/build.test.ts` | 4 | Vendor shim React 19 exports, react-dom/client exports, hydration guards embedding | `MANDU_SKIP_BUNDLER_TESTS=1` (CI randomize-mode) |
| `packages/core/src/bundler/safe-build.test.ts` | 4 | `Bun.build` 세마포어: BuildOutput 모양, 에러 전파, concurrency cap, queue drain | — |
| `packages/core/tests/bundler/dev-common-dir.test.ts` | 7 | `SSR_CHANGE_WILDCARD` 상수, island 없는 dev 시작, `skipFrameworkBundles` fallback, corrupt manifest fallback, 필수 필드 누락 fallback, framework 경로 보존 | `MANDU_SKIP_BUNDLER_TESTS=1` |
| `packages/core/tests/prerender/prerender.test.ts` | 6 | Static 렌더 + 파일 출력, size/duration 리포트, non-200 에러, crawl 링크 발견, crawl=false, 중복 렌더 방지 | — |
| `packages/cli/tests/bundled-importer.test.ts` | 10 | **#184 baseline 버그 증명**, transitive edit 전파, multi-hop 체인, per-source GC, stale 번들 정리, tsconfig `@/*` alias, metadata round-trip, 빌드 에러 전파, `onError` 콜백, 이전 세션 잔여 제거 | — |
| `packages/core/tests/config/watcher.test.ts` | 13 | Config 파일 watch, 변경 감지, 섹션 diff, 유효성 | — |
| `packages/core/tests/guard/watcher.test.ts` | 7 | Guard 위반 즉시 탐지 (layer-violation 등) | — |
| `packages/core/tests/runtime/ssr-rendering.test.ts` | 3 (HMR 파트) | `renderToHTML` HMR script 주입: dev, prod 분기, port 미지정 | — |
| `packages/core/tests/streaming-ssr/streaming-ssr.test.ts` | 2 (HMR 파트) | Streaming SSR dev HMR script 포함, prod 미포함 | — |
| `packages/cli/tests/util/dev-shortcuts.test.ts` | 3 | Dev ready summary 렌더, 단축키 매핑 | — |
| `demo/auth-starter/tests/e2e/auth-flow.spec.ts` | 7 (Playwright) | 인증 E2E. **dev HMR 시나리오 없음** | — |

**총 HMR/dev-watch 직접 테스트: 약 59개 (unit) + dev HMR E2E 0건**.

---

## 6. 커버리지 Gap → 관련 이슈

| Gap 시나리오 | 현재 커버 여부 | 관련 이슈 |
|---|---|---|
| **공통 파일 변경 → prerender HTML 재생성** (hydration: none) | **미커버** | **#188 (OPEN)** |
| Island 없는 pure-SSR 프로젝트 dev flow | 부분 (start만 확인) | #188 |
| 동시 다중 파일 변경 → debounce/큐잉 | 부분 (`#121` guard 간접) | 회귀 방지 추가 필요 |
| `*.slot.ts` / `*.slot.tsx` 변경 감지 | **미커버** | 잠재 재발 영역 |
| `contract/*.ts` 변경 → type 재생성 + 핸들러 재등록 | **미커버** | 잠재 재발 영역 |
| `resource/*.ts` 변경 (Resource-Centric Arch) | **미커버** | 잠재 재발 영역 |
| **CSS-only 변경** (Tailwind class / globals.css) | 간접 (SSR script 주입만) | #111 #123 #117 해결됨, 회귀 방지 E2E 없음 |
| **Windows path edge case** (드라이브 대소문자, UNC, `[lang]` 등 특수문자) | 부분 (`normalizeFsPath` 유닛 부재) | #180 해결됨, 단위 테스트 미비 |
| HMR WebSocket 재연결 (backoff + 포트 재할당) | 없음 | #119 #120 해결, 시뮬레이션 없음 |
| Dev 서버 restart 핸들러 (DevTools 버튼) | 없음 | #175 간접 |
| Dev mode Cache-Control 헤더 회귀 | 없음 | #177 해결, 테스트 없음 |
| `mandu dev --watch` Playwright E2E (실파일 수정 → 브라우저 반영) | **0건** | #188 재현 자동화 필요 |

---

## 7. 최근 패치 타임라인 (지난 3개월)

| 커밋 | 해결 이슈 | 요약 |
|---|---|---|
| `04e74a5` (2026-04-14 이후) | #184 | `@mandujs/cli@0.22.1` — bundled importer fix 릴리즈 |
| `76669b0` | #184 #187 | `fix(dev)`: bundled importer로 transitive ESM cache 우회 |
| `4b0a9b4` | #184 #185 #186 | hardening pass (mutex, corrupt JSON fallback, 필수 필드 검증) |
| `9722d45` | #184 #185 | `perf(bundler)`: skipFrameworkBundles on common-dir rebuild + partial SSR invalidation |
| `640c541` | #180 #181 #182 #183 | 4 issue batch fix (Windows path, dynamic route) |
| `60e6e3b` | #186 follow-up | Metadata caching on filling API path |
| `ec8a9ae` | #186 | `export const metadata` / `generateMetadata` → SSR head wiring |
| `b74fc57` | (infra) | Phase 0.6 — CI `--randomize` + bundler 테스트 gating |
| `4295807` | #151 #165 | SSR page.tsx HMR 지원 + SSE idle timeout |
| `6eb70c1` | #166 | bun-types@1.3.x strict TS 컴파일 |
| `b7dd73a` | #144 | Kitchen DevTools 전용 번들 auto-mount |
| `05508af` | #140 | `*.client.tsx` clientModule mismatch |
| `09354de` | #114 #117 #121 #122 #125 #126 | Concurrent build, Windows, per-island, HMR script 동기화 |
| `92d71a4` | #111 #123 | CSS hot reload + CSS watcher ANSI |

---

## 8. 종합 평가

- **#184/#185/#186 3건이 Phase 7 진입점에서 대부분의 critical HMR 문제를 닫았다.** `createBundledImporter`는 이론적으로 올바른 접근 — bundle-and-import로 Bun ESM 캐시를 완전히 우회. transitive edit, alias, metadata 모두 E2E 유닛으로 검증됨.
- **여전히 핵심 공백: #188.** `skipFrameworkBundles: true`로 island만 재빌드하지만 **prerender 재실행 트리거가 없다**. hydration: none 프로젝트에선 `buildClientBundles` 자체가 no-op에 가까우므로 HTML이 stale로 유지된다. Phase 7에서 반드시 닫아야 할 단 하나의 open 이슈.
- **테스트 커버리지 격차가 분명하다.** 현재 bundler 테스트는 artifact 출력 검증 위주이고, **"실제 파일을 수정 → dev 서버가 올바르게 반응" end-to-end 시나리오가 거의 없다**. dev-common-dir.test.ts도 watcher를 실제로 돌리지는 않는다 (manifest/옵션 계약만 확인). demo/auth-starter에 Playwright가 있지만 dev HMR 시나리오는 전무.
- **구조적 위험: slot / contract / resource 변경 경로.** `src/shared`, `src/components` 등 공통 디렉토리는 커버되지만 Mandu 고유 파일 타입(slot 로더, contract 스키마, resource 정의)의 변경 → 서버 핸들러 재등록 흐름은 테스트가 없다. 향후 회귀 위험이 높다.
- **Windows 경로는 `#180`에서 좋아졌지만 단위 테스트가 없다.** `normalizeFsPath`는 드라이브 대소문자 + UNC + dynamic route 특수문자까지 커버해야 하는데, fixture가 부재. 플랫폼 차이에 의한 회귀가 발생해도 CI가 감지하지 못할 가능성이 남아있다.
