---
title: "Mandu × Bun 1.3.x — Phase 설계"
status: execution-plan
audience: Mandu core team
depends_on:
  - docs/bun/features-catalog.md
  - docs/bun/improvements-roadmap.md
created: 2026-04-17
bun_version: "1.3.12"
---

# Mandu × Bun 1.3.x — Phase 설계

> [`improvements-roadmap.md`](./improvements-roadmap.md) 가 **무엇을/왜** 라면, 이 문서는 **언제/어떻게** 입니다. 각 phase 는 독립적으로 배포 가능하고, 리스크를 앞으로 당기며, 한 테마만 다룹니다.

---

## 0. 설계 원칙

1. **Shippable per phase** — phase 종료 시 릴리즈 가능한 상태. 어정쩡한 WIP 금지.
2. **Front-loaded risk** — Cookie 추상화(Workers 호환성)·Trie 라우터 공존 등 아키텍처 리스크는 Phase 1 에 배치.
3. **One theme** — 한 phase 에 한 테마. 파이프라인·보안·데이터·운영 섞지 않음.
4. **Feedback via demo** — 새 기능은 항상 `demo/` 앱 1개로 검증. 내부 테스트만으로 종료 안 함.
5. **Parallel split declared** — 솔로 작업 중에도 "이 phase 를 두 PR 로 나누면 어디서 쪼개는지" 명시.
6. **Exit = 측정 가능** — 체크리스트로 "끝났다" 판정. 코드 완성만으로 종료 X.
7. **테스트 동반 — 예외 없음** — 모든 ticket 은 테스트와 함께 머지. 각 phase 마다 (a) ticket 별 단위 테스트, (b) phase 전체 통합 테스트, (c) 기존 suite 회귀 통과 3단계 게이트. **테스트 없는 PR 머지 금지.** 아래 각 phase 의 "테스트 계획" 절이 필수.

### Definition of Done (모든 PR 공통)
- [ ] 해당 ticket 의 단위 테스트 추가 (`bun test` 로 실행)
- [ ] 기존 테스트 전부 통과 (`bun run test:packages`)
- [ ] CI 3회 `--randomize` 실행 통과
- [ ] 해당 phase 의 통합/E2E 테스트 추가 또는 업데이트
- [ ] 문서·changelog·migration note (해당 시)

### 하지 않는 것 (scope 외)
- Node.js 의존 없애기 (ate/ 및 chokidar 는 의식적 유지 — [roadmap §6 참조](./improvements-roadmap.md))
- Cloudflare Workers 적합성 희생 — 핸들러 추상화 유지, Bun-only 기능은 adapter 뒤에 격리
- 지금 없는 테스트 러너/언어 도입 금지 — bun:test 단일

---

## 1. Phase 개요

| Phase | 기간 | 테마 | 주요 산출 | 신규 패키지 | 릴리즈 |
|---|---|---|---|---|---|
| **0** | 1주 | 기반 정비 | 측정 인프라 + CI + linker + catalogs | — | core patch |
| **1** | 2주 | HTTP 파이프라인 현대화 | CookieMap 전환 + Bun.serve routes 혼합 | — | core 0.22.0 |
| **2** | 2~3주 | 세션·인증·CSRF | 3대 보안 미들웨어 + demo | session, auth, csrf | minor + 3 × 0.1.0 |
| **3** | 1~2주 | 스케줄러·스토리지 | cron + s3 미들웨어 | scheduler, storage-s3 | patch + 2 × 0.1.0 |
| **4** | 3주 | 데이터 계층 | Bun.sql 어댑터 + resource 통합 | db | core 0.24.0 (breaking 가능) |
| **5** (optional) | 2주 | HMR 정렬 + 배포 실험 | import.meta.hot + CLI --compile | — | core 0.25.0 |

**총 예상**: 11~15주. Phase 5 제외 시 9~13주.

**Gantt 관점 — 순차 vs 병렬**:
```
Phase 0 ───────────────────────────────────────────────
        └─ Phase 1 ─────────────────────────────────
                   └─ Phase 2 ──────────────────
                               │   └─ Phase 3 ──  (병렬 가능)
                               └─ Phase 4 ──────  (Phase 2 완료 후 시작 가능)
                                          └─ Phase 5
```
Phase 3 은 Phase 2 와 병렬 개시 가능 (독립 테마). Phase 4 는 반드시 Phase 2 완료 후 (session/auth 가 DB 통합 예시로 사용됨).

---

## 2. Phase 0 — 기반 정비 (1주)

### 목표
후속 phase 의 효과를 **수치로** 증명할 인프라. 지금 깔지 않으면 이후 "빨라졌다/안정됐다" 가 전부 주관 판단이 됨.

### 범위 (5 tickets)

| ID | 작업 | 작업량 | 근거 |
|---|---|---|---|
| 0.1 | `@mandujs/core/perf` 헬퍼 (Bun.nanoseconds) | 3h | [roadmap 2.2](./improvements-roadmap.md#22-bunnanoseconds-기반-perf-측정-도입) |
| 0.2 | CI `--randomize --seed $GITHUB_RUN_ID --retry=2` | 30min | roadmap 2.3 |
| 0.3 | `crypto.randomUUIDv7` 통합 (`@mandujs/core/id`) | 2h | roadmap 2.5 |
| 0.4 | `--linker=isolated` 검증·채택 | 1~2일 | roadmap 3.2 |
| 0.5 | Catalogs 이주 (react, zod, ts 등) | 4h | roadmap 3.4 |

### 순서
0.2 → 0.1 → 0.3 → 0.5 → 0.4 (linker 가 가장 파장 큼, 마지막).

### 테스트 계획
| Ticket | 단위 테스트 | 통합/수동 검증 |
|---|---|---|
| 0.1 perf | `MANDU_PERF=1` 시 `mark/measure` 가 ms 로그 출력 / 미설정 시 noop / 마커 없이 measure 호출 시 안전 무시 | `bun run dev` 로 5개 측정점 로그 눈 확인 (스크린샷 첨부) |
| 0.2 CI | — (워크플로 변경만) | `--retry=2` 전 CI 잡 통과. **`--randomize`는 Phase 0.6 로 분리** (Bun.build 병렬 워커 간 충돌 이슈로 bundler 테스트 2개가 실패 — 해결책 논의 후 적용) |
| 0.3 id | `newId()` 가 v7 포맷 (timestamp prefix) 반환, 정렬성 검증 (연속 호출 시 단조증가) | 기존 v4 ID 와 동일 정규식/컬럼에 저장 가능 확인 |
| 0.4 linker | 기존 1928 테스트 전부 통과 | Ubuntu/Windows/macOS 3개 CI runner 통과, `node_modules` 심볼릭 링크 구조 검증 |
| 0.5 catalogs | `bun publish --dry-run` 출력에 `catalog:` → 실제 버전 치환 확인 | `scripts/pre-publish-check.ts` 에 assertion 추가 |

**Phase 0 게이트**: 전 ticket 테스트 추가 + 기존 suite 회귀 없음 + CI 매트릭스 green.

### 종료 조건
- [ ] `import { mark, measure } from "@mandujs/core/perf"` 로 최소 5개 측정점 (HMR rebuild, SSR render, route scan, island bundle, CSS bundle) 계측 중
- [ ] `MANDU_PERF=1 bun run dev` 실행 시 각 구간 ms 로그 출력
- [ ] CI 가 `--randomize --retry=2` 로 3회 실행 통과
- [ ] `crypto.randomUUIDv7` 헬퍼 채택, 기존 uuid 호출부 전수 조사·교체
- [ ] `bun install --linker=isolated` 로 전 CI (ubuntu/windows/macos) 통과
- [ ] `bunfig.toml` 에 `linker = "isolated"` 영구 설정
- [ ] root `package.json` 에 최소 3개 `catalog:` 의존성 (react, react-dom, zod)
- [ ] `bun publish --dry-run` 으로 catalog → 실제 버전 치환 확인
- [ ] Changeset 생성, 릴리즈: `@mandujs/core` patch

### 리스크
| ID | 리스크 | 완화 |
|---|---|---|
| R0-A | `--linker=isolated` 로 `packages/cli/src/util/bun.ts` bundled-importer 파손 (hoisting 전제 깨짐) | 로컬 사전 실행 → 파손 시 해당 로직만 explicit external 보강 |
| R0-B | Catalogs 를 `bun publish` 가 치환 못함 | dry-run 으로 선검증. 치환 안 되면 workspace:* 패턴과 동일하게 별도 스크립트 추가 |
| R0-C | uuid v4 호출부 외부 API/DB 에 이미 저장돼 있어 v7 혼용으로 정렬 이슈 | id 컬럼 전수 조사, 신규 행만 v7, 기존 테이블은 유지 |

### 병렬 분할
0.1 + 0.2 + 0.3 은 완전 독립 (각자 PR). 0.4 + 0.5 는 lockfile 충돌하니 순차.

### 즉시 시작 가능한 첫 PR
**0.2 CI 플래그 추가** — 10분 PR, 효과 즉시. `.github/workflows/ci.yml` 의 모든 `bun test ...` 라인 끝에 `--randomize --retry=2` 추가. (seed 는 CI env 사용.)

---

## 3. Phase 1 — HTTP 파이프라인 현대화 (2주)

### 목표
기존 커스텀 쿠키/스캐너/내부 엔드포인트를 Bun 네이티브 기반으로 정렬. **아키텍처 리스크 해결** — CookieMap 이 Workers adapter 와 공존 가능한지 증명.

### 범위 (3 tickets)

| ID | 작업 | 작업량 | 근거 |
|---|---|---|---|
| 1.1 | `ctx.cookies` → `Bun.CookieMap` 전환 (+ Workers polyfill) | 4~6일 | roadmap 2.1 |
| 1.2 | 내부 엔드포인트 `Bun.serve({ routes })` 혼합 | 3~5일 | roadmap 3.1 |
| 1.3 | `Bun.Glob.scanAsync()` 선택적 도입 (router scanner) | 1일 | roadmap 2.4 |

### 순서
1.3 (독립, 워밍업) → 1.1 (최대 리스크) → 1.2 (CookieMap 이 안정된 후).

### 테스트 계획
| Ticket | 단위 테스트 | 통합/E2E 검증 |
|---|---|---|
| 1.1 CookieMap | `BunCookieAdapter`: set/get/delete/serialize/parse. `WorkersCookieAdapter` 동일 API. `signedCookie` wrapper: 구 secret 으로 서명된 값을 새 코드가 읽음 (마이그레이션 가드). expire/maxAge/secure/sameSite 속성 정확 반영 | request → handler → response 왕복 테스트 (Bun.serve 기동 후 실제 HTTP). 기존 `cookie-ssr.test.ts` 전부 통과 |
| 1.2 Bun.serve routes | 우선순위 3 케이스 (exact > dynamic > wildcard, Bun routes > Trie fallback). `server.reload({ routes })` 호출 후 구라우트 404, 신규라우트 200 | dev 모드에서 파일 변경 → reload → 새 라우트 적용까지 E2E (Playwright, <500ms) |
| 1.3 scanAsync | 100 개 route 가상 디렉토리 스캔이 non-blocking (setTimeout 0 동안 최소 1개 microtask 실행 증거) | 대규모 프로젝트 (demo/ai-chat) 에서 dev 시작 p50 측정, 기준선 대비 회귀 없음 (Phase 0 perf helper 사용) |

**Phase 1 게이트**:
- (a) 단위 테스트 전부 추가·통과
- (b) `cookie-ssr.test.ts` + 기존 server.ts 테스트 통과
- (c) **마이그레이션 E2E**: 기존 secret 으로 서명된 쿠키 값을 fixture 로 저장해두고, 새 코드가 읽는 테스트 — 세션 쓸림 방지
- (d) Workers adapter smoke (wrangler dev 또는 miniflare 간단 기동) 통과
- (e) Phase 0 perf 기준선 대비 HMR rebuild p50 회귀 없음 (허용 오차 +10%)

### 설계 결정 필요 (phase 시작 전 기록)
- **D1. Workers adapter 경로**: `handler.ts` 추상화를 유지하되, CookieMap 은 Bun 전용 경로에서만 활성. Workers 경로는 기존 Map-like 구현 유지. → 두 구현을 `BunCookieAdapter` / `WorkersCookieAdapter` 로 분리, `ctx.cookies` 인터페이스는 그대로.
- **D2. Signed cookie**: Bun.CookieMap 이 HMAC 서명을 직접 지원하지 않는다면, `signedCookie(map, secret)` wrapper 를 `@mandujs/core/security` 로 분리. 기존 secret 값을 그대로 읽어야 기존 세션 안 쓸림.
- **D3. Trie 라우터와 Bun.serve routes 우선순위**: Bun routes 가 먼저 매칭 시도 → 미스 시 Trie 라우터 fallback. 반대로 하면 사용자가 내부 경로 override 할 수 있어 위험. 명시적 순서 테스트 작성.

### 종료 조건
- [ ] `ctx.cookies` 의 public API 동일 유지. 내부 구현만 CookieMap 기반
- [ ] 기존 `core/tests/server/cookie-ssr.test.ts` 포함 cookie 관련 테스트 전부 통과
- [ ] Workers adapter 에서 동일 API 동작 (최소 smoke 테스트)
- [ ] Signed cookie 마이그레이션 가드: **기존 secret 으로 서명된 쿠키를 새 코드가 읽을 수 있음** 테스트
- [ ] `/__mandu/healthz`, `/__mandu/manifest.json` 이 Bun routes 로 처리
- [ ] `server.reload({ routes })` 로 dev 모드 라우트 hot-swap 작동 (HMR log 관찰)
- [ ] 우선순위 테스트: 동일 경로 Bun routes + Trie 둘 다 등록 시 Bun routes 우선
- [ ] `core/src/router/fs-scanner.ts:118` 이 `scanAsync` 기반, 대규모 프로젝트 (100+ route) 에서 dev 서버 시작이 non-blocking
- [ ] Phase 0 perf 로 측정: route scan p50 이전 vs 이후 (회귀 없는지)
- [ ] 릴리즈: `@mandujs/core@0.22.0`
- [ ] `docs/migration/0.22-cookies.md` 작성

### 리스크
| ID | 리스크 | 완화 |
|---|---|---|
| R1-A | Signed cookie 포맷 불일치로 운영 중인 세션 쓸림 | 스테이징 환경에서 기존 쿠키 읽기 테스트. 포맷 불일치 시 legacy 쿠키 양쪽 읽기 기간(2주) 운영 |
| R1-B | Trie + Bun routes 라우팅 충돌 | 3개 우선순위 케이스 (exact match, dynamic, wildcard) 테스트 사전 작성 |
| R1-C | scanAsync 도입이 dev 시작 타이밍 어긋남 → HMR 초기 이벤트 놓침 | scanner 완료 후 HMR 서버 바인드. 타이밍 E2E 테스트 |

### 병렬 분할
1.3 은 **0.1 완료 직후 병렬 시작 가능**. 1.1 과 1.2 는 `server.ts` 같은 파일 편집해 충돌 → 순차.

### 산출물
- `@mandujs/core@0.22.0` 배포
- `docs/migration/0.22-cookies.md` — signed cookie 마이그레이션 가이드
- 내부 엔드포인트 라우팅 예시 (`docs/internals/routing.md`)

---

## 4. Phase 2 — 세션·인증·CSRF (2~3주)

### 목표
"Mandu 로 로그인 있는 앱" 의 primitive 3개 — **Mandu 를 "배터리 포함" 프레임워크로 포지셔닝하는 분기점**.

### 범위 (3 tickets + 1 demo)

| ID | 작업 | 작업량 | 근거 |
|---|---|---|---|
| 2.1 | `@mandujs/session` — bun:sqlite store + CookieMap | 5~7일 | roadmap 4.3 |
| 2.2 | `@mandujs/auth` — Bun.password + session 연동 | 3~5일 | roadmap 4.1 |
| 2.3 | `@mandujs/csrf` — Bun.CSRF double-submit | 2~3일 | roadmap 4.2 |
| 2.4 | `demo/auth-starter/` — 회원가입/로그인/보호라우트/폼 제출 | 2일 | — |

### 순서
2.1 (기반) → 2.2 + 2.3 (병렬 가능, 둘 다 세션 위에 얹음) → 2.4 (통합 검증).

### 테스트 계획
| Ticket | 단위 테스트 | 통합/E2E 검증 |
|---|---|---|
| 2.1 session | `SqliteSessionStore`: CRUD + TTL 만료 + sliding expiry + concurrent write 안전성 (WAL). `session()` 미들웨어: 쿠키 없을 때 신규 발급, 있을 때 재사용, destroy 시 쿠키 clear | Bun.serve 기동 후 2개 request 가 같은 session id 로 상태 공유 확인 |
| 2.2 auth | `hashPassword` argon2id 기본값, 해시 길이/포맷. `verifyPassword`: 정답/오답/변조 해시. `requireAuth`: 인증시 통과, 미인증시 401 or redirect option 동작. `login`/`logout` 이 세션 상태 전이 | login → protected route → logout 플로우 (Playwright) |
| 2.3 csrf | `Bun.CSRF.generate/verify` wrapper. double-submit: 쿠키 + 헤더 모두 일치해야 통과. GET/HEAD skip. POST 토큰 없으면 403. `<CsrfInput />` 컴포넌트가 쿠키 토큰을 hidden field 로 렌더 | 폼 POST 에서 토큰 없을 때 403, 있을 때 200 |
| 2.4 demo | — | Playwright E2E: signup → login → dashboard → logout → login 재시도 전 플로우. 각 스텝에 assertion |

**Phase 2 게이트**:
- (a) 단위 테스트 3 × ticket 전부 추가·통과
- (b) Playwright E2E (`demo/auth-starter/`) 통과, video 저장 (`demo/auth-starter/test-results/`)
- (c) 보안 smoke: 잘못된 argon2 해시로 verify 시 상수시간 동작 확인 (timing attack 기초 방어)
- (d) `docs/middleware/*.md` 3개 문서에 "동작 예시 + 테스트 실행법" 섹션

### 설계 결정 필요
- **D4. Session store 인터페이스**: `SessionStore { get, set, destroy, gc }` 추상 인터페이스 정의. 기본 구현은 `SqliteSessionStore`. `RedisSessionStore` 는 Phase 4 에서.
- **D5. Auth 범위**: 패스워드 해싱 + 세션 기반 로그인만. OAuth/SSO 는 out-of-scope (별도 phase 에 이후 제안).
- **D6. CSRF 범위**: double-submit cookie 패턴 (세션 없이도 동작). 세션 동기 방식은 session/auth 콤비네이션에서 자동 활성.
- **D7. 미들웨어 인터페이스 통일**: `(ctx) => Response | void | Promise<...>` 로 통일. manifest 레벨(전역) + 라우트 레벨(지역) 두 모두 지원.

### 종료 조건
- [ ] `@mandujs/session@0.1.0` 배포: `session({ store: new SqliteSessionStore({ path: ".mandu/sessions.db" }), ttl: "7d" })`
- [ ] `@mandujs/auth@0.1.0` 배포: `hashPassword`, `verifyPassword`, `login(ctx, userId)`, `logout(ctx)`, `requireAuth(ctx)`
- [ ] `@mandujs/csrf@0.1.0` 배포: `csrf({ secret })` 미들웨어, `<CsrfInput />` 컴포넌트, `useCsrfToken()` hook
- [ ] `demo/auth-starter/` 앱 동작:
  - [ ] `/signup` — 폼, argon2 해싱, sqlite 저장
  - [ ] `/login` — 인증, 세션 쿠키 발급
  - [ ] `/dashboard` — `requireAuth` 로 보호, 미인증시 `/login` 리디렉트
  - [ ] `/logout` — 세션 destroy + 쿠키 clear
  - [ ] POST 폼에 CSRF 토큰 자동 포함, 토큰 없으면 403
- [ ] E2E (Playwright) 테스트: signup → login → protected → logout 플로우 통과
- [ ] 문서 3종: `docs/middleware/session.md`, `docs/middleware/auth.md`, `docs/middleware/csrf.md`
- [ ] 릴리즈: `@mandujs/core@0.23.0` + 3 × new@0.1.0
- [ ] `demo/auth-starter/` 가 `mandu init --template auth-starter` 템플릿으로 승격 (optional, Phase 2 end or Phase 3)

### 리스크
| ID | 리스크 | 완화 |
|---|---|---|
| R2-A | `Bun.password` argon2 가 요청 스레드를 100ms+ 블록 (워커 풀 부재 시) | 공식 문서 확인. 블록이면 `await`-기반 사용만 허용, spinner UX 가이드 |
| R2-B | `Bun.CSRF` 가 1.3 experimental 일 수 있음 | catalog 문서 stability 재확인. experimental 이면 wrapper 두고 flag 환경변수로 opt-in |
| R2-C | bun:sqlite WAL 모드에서 동시 write 이슈 (solo dev DB) | WAL + busy_timeout 설정. 고부하 시 Redis 로 교체 안내 |
| R2-D | argon2 파라미터 선택 (memory cost) — 약하면 보안 위험, 강하면 모바일 서버 느림 | Bun 기본값 사용, `authOptions.argon2` 로 override 가능 |

### 병렬 분할
2.1 완료 후 2.2 와 2.3 은 **완전 병렬** (서로 의존 없음). 2.4 는 둘 다 완료 후.

### 산출물
- 3 개 신규 패키지 — Mandu 의 첫 "확장 미들웨어" 트랙
- `demo/auth-starter/` → 향후 `mandu init --template auth-starter`

---

## 5. Phase 3 — 스케줄러 + 스토리지 (1~2주)

### 목표
실제 프로덕션 배포 직전에 필요한 운영 primitive — 백그라운드 작업 + 파일 업로드.

### 범위 (2 tickets + demo 확장)

| ID | 작업 | 작업량 | 근거 |
|---|---|---|---|
| 3.1 | `@mandujs/scheduler` — `Bun.cron` 래퍼 | 2~3일 | roadmap 4.4 |
| 3.2 | `@mandujs/storage-s3` — `Bun.s3` 업로드 헬퍼 | 3~4일 | roadmap 4.5 |
| 3.3 | `demo/auth-starter/` 확장: 프로필 이미지 업로드 + 일일 session GC | 1일 | — |

### 순서
3.1 + 3.2 **완전 병렬 가능** (독립 도메인). 3.3 은 둘 다 완료 후.

### 테스트 계획
| Ticket | 단위 테스트 | 통합/E2E 검증 |
|---|---|---|
| 3.1 scheduler | cron 파싱, 다음 실행 시각 계산. 중복 실행 방지: 이전 실행이 끝나기 전에 틱 와도 skip. dev 모드 skip flag 동작. `Bun.cron` 이 experimental 이면 wrapper 호출 후 fake timer 로 검증 | 15s 간격 short cron 1개 등록 후 60s 동안 4회만 실행됨 확인 (실제 시간 테스트, CI tag `@slow`) |
| 3.2 storage-s3 | presign URL 포맷 (AWS sig v4), key escape, content-type 추론 | MinIO 도커 컨테이너 기동 → upload/download/presign 3 경로 E2E. R2 호환 endpoint env 변경 시 동작 확인. CI matrix: 실제 AWS 는 수동 토큰 필요시 skip |
| 3.3 demo 확장 | — | 이미지 업로드 UI → MinIO 저장 → 목록 표시. session GC cron 이 하루 뒤 만료된 row 제거 (fake clock 으로 시간 압축) |

**Phase 3 게이트**:
- (a) `@slow` 태그 테스트 (CI 에서 `bun test --timeout=120000`) 통과
- (b) MinIO 컨테이너 docker-compose 설정 `tests/fixtures/s3/docker-compose.yml` 추가
- (c) scheduler 가 프로세스 재시작 후 스케줄 재등록되는지 수동 검증 (at-most-once 문서화 포함)

### 설계 결정 필요
- **D8. scheduler — single vs multi instance**: 초기 버전은 single instance 전제 (중복 실행 방지는 lock 파일 또는 sqlite row). multi-instance 는 out-of-scope.
- **D9. storage-s3 — 전송 방식**: 서버 경유 (multipart → server → s3) + presigned URL (클라이언트 직접 upload) 두 모드 제공.
- **D10. S3 공급자 호환성**: AWS S3, Cloudflare R2, MinIO 는 동일 API. endpoint 만 다름. 기본은 환경변수 `S3_ENDPOINT`.

### 종료 조건
- [ ] `@mandujs/scheduler@0.1.0` — `defineCron({ jobs: { "clean:sessions": { schedule: "*/15 * * * *", run: ... } } })`
- [ ] dev 모드에서 scheduler 자동 skip (flag 로 override 가능)
- [ ] 중복 실행 방지 테스트 (이전 실행이 끝나기 전에 다음 틱이 와도 skip)
- [ ] `@mandujs/storage-s3@0.1.0` — `s3Upload(blob, { bucket, key })`, `presignPut({ bucket, key, expires })`
- [ ] R2 와 MinIO 둘 다 E2E 테스트 (dockerized MinIO 로 CI)
- [ ] `demo/auth-starter/` 에 프로필 이미지 업로드 + 세션 GC cron 추가
- [ ] 릴리즈: 2 × new@0.1.0, core patch

### 리스크
| ID | 리스크 | 완화 |
|---|---|---|
| R3-A | `Bun.cron` 이 프로세스 재시작 시 "이미 실행했어야 할" 작업 유실 | at-most-once 문서화. exactly-once 원하면 queue 시스템 사용 가이드 |
| R3-B | Bun.s3 API 가 AWS SDK 동작과 미묘하게 다름 (e.g., presign 포맷) | E2E 로 AWS/R2/MinIO 각각 검증 |

### 병렬 분할
3.1 과 3.2 는 완전 독립 — 같은 개발자가 해도 별도 PR.

---

## 6. Phase 4 — 데이터 계층 (3주)

### 목표
Mandu `resource` 레이어의 **기본 DB 어댑터** 로 `Bun.sql` 통합. 이 phase 가 **가장 크고 가장 위험**. RFC 먼저 쓰는 것 권장.

### 선행 조건
- **RFC 작성** (Phase 3 진행 중 병렬): resource 레이어의 현재 public API, 제안할 변경, 마이그레이션 경로, 호환 레이어 유지 기간.
- Phase 2 session store 인터페이스 확정 (여기서 Redis adapter 도 추가하면서 재검증).

### 범위 (3 tickets)

| ID | 작업 | 작업량 | 근거 |
|---|---|---|---|
| 4.1 | `@mandujs/db` — Bun.sql 래퍼 (postgres/mysql/sqlite) | 1주 | roadmap 4.6 |
| 4.2 | `resource/generator.ts` 가 Bun.sql 기반 CRUD 생성 | 1주 | — |
| 4.3 | 마이그레이션 도구 선택·통합 (drizzle-kit 또는 자체 rolling) | 1주 | — |

### 순서
4.1 → 4.2 → 4.3 완전 순차 (각각 이전에 의존).

### 테스트 계획
| Ticket | 단위 테스트 | 통합/E2E 검증 |
|---|---|---|
| 4.1 db | query 파라미터 binding, SQL injection escape, transaction commit/rollback, connection pool 고갈 시 대기/타임아웃, tagged template 타입 추론 | **3 공급자 매트릭스**: SQLite (메모리 — unit 에서 직접), Postgres (docker `postgres:16`), MySQL (docker `mysql:8`). 각각 CRUD + 트랜잭션 + 동시성 (2 커넥션) 시나리오 |
| 4.2 resource generator | 생성된 CRUD 코드 snapshot 테스트 (출력 변경 감지). User 리소스 정의 → 생성 코드 → 빌드 통과 | 실제 resource 호출이 DB 에 persist 되는 E2E (`demo/auth-starter/` 가 Postgres 로 전환) |
| 4.3 migration | migration 파일 파싱, up/down 순서, 체크섬 검증 | SQLite → Postgres 전환 시 schema 차이 없이 전환 가능한지 실제 실행 |

**Phase 4 게이트**:
- (a) DB 매트릭스 (SQLite/Postgres/MySQL) 3 × 통과
- (b) 기존 resource 사용자 앱 (`demo/todo-app`, `demo/ai-chat`) 변경 없이 빌드·테스트 통과 (하위 호환 증명)
- (c) RFC 문서 `docs/rfcs/0001-db-layer.md` 작성
- (d) 마이그레이션 codemod 제공 시 codemod 자체도 단위 테스트 포함
- (e) 벤치: Postgres 왕복 latency p50 이 `postgres.js` 대비 ±15% 이내 (문서화)

### 설계 결정 필요
- **D11. 마이그레이션 도구**: 자체 롤링 마이그레이션 구현 vs drizzle-kit 통합. drizzle 은 성숙하지만 의존성 추가. 자체는 유지보수 비용.
- **D12. Resource 레이어의 ORM 제공 여부**: Bun.sql 은 raw SQL. 타입 추론 필요하면 zod 스키마 → SQL 타입 매핑 도구 (`@mandujs/db/types`) 별도 제공.
- **D13. 기존 리소스 사용자 마이그레이션**: 기존 리소스 CRUD 인터페이스 유지. 내부만 Bun.sql 로 교체. deprecation cycle 2 minor.
- **D14. SQLite dev / Postgres prod 전환 UX**: `mandu.config.ts` 에 `db: { provider: "sqlite" | "postgres" | "mysql", url: env.DATABASE_URL }`. CI/staging/prod 환경변수만 다르게.

### 종료 조건
- [ ] `@mandujs/db@0.1.0` 배포, tagged template API 동작
- [ ] Postgres + MySQL + SQLite 3 개 공급자 E2E (Docker)
- [ ] Resource 하나 (`User`) 가 Bun.sql 로 실제 Postgres 에 persist 되는 데모 (`demo/auth-starter/` 확장)
- [ ] 마이그레이션 도구 결정·통합, SQLite → Postgres 전환 가이드 문서
- [ ] 기존 resource API 호환 — 기존 테스트 전부 통과
- [ ] 릴리즈: `@mandujs/core@0.24.0` (minor, 공식 deprecation notice)
- [ ] RFC 문서 `docs/rfcs/0001-db-layer.md` 공개

### 리스크
| ID | 리스크 | 완화 |
|---|---|---|
| R4-A | resource 레이어 public API 변경이 기존 유저 앱 파손 | 호환 레이어 유지. deprecation notice 2 minor. 마이그레이션 codemod 제공 |
| R4-B | Bun.sql Postgres 성능·기능이 `pg`/`postgres.js` 대비 부족 | 벤치 먼저. 부족 시 adapter 인터페이스 두고 fallback 옵션 |
| R4-C | SQLite → Postgres 전환 시 SQL 방언 차이 | Bun.sql 이 공통 부분만 보장하는지 문서 확인. 방언별 escape 가이드 |

### 병렬 분할
4.1 과 4.3 은 순차여야 하지만, 4.3 설계 (RFC) 는 4.1 구현 중 병렬로 가능.

---

## 7. Phase 5 — HMR 정렬 + 배포 실험 (2주, optional)

### 목표
외부 생태계 호환성 + 배포 UX. **optional** — 시간 되면.

### 범위 (3 tickets)

| ID | 작업 | 작업량 | 근거 |
|---|---|---|---|
| 5.1 | `import.meta.hot` Vite-compatible HMR 어댑터 | 1주 | roadmap 3.3 |
| 5.2 | CLI `--compile` 단일 바이너리 배포 (GitHub Releases) | 1주 | roadmap 5.1 |
| 5.3 | Windows workaround 재측정·정리 | 2~3일 | roadmap 5.3 |

### 순서
5.3 먼저 (cleanup) → 5.1 + 5.2 병렬.

### 테스트 계획
| Ticket | 단위 테스트 | 통합/E2E 검증 |
|---|---|---|
| 5.1 import.meta.hot | accept/dispose/invalidate 콜백 호출 순서, 잘못된 호출 경고 | Playwright: 컴포넌트 수정 → state 보존 확인 |
| 5.2 --compile | — | 바이너리 smoke: `./mandu --version` / `./mandu init --dry-run` 3 OS matrix (GitHub Actions artifacts 검증) |
| 5.3 Windows workaround 정리 | 제거된 workaround 의 원래 케이스가 재현되지 않는지 단위 회귀 | Windows CI 에서 전 suite 통과 |

**Phase 5 게이트**: 3 OS 바이너리 smoke, HMR E2E, Windows 회귀 없음.

### 종료 조건
- [ ] `import.meta.hot.accept/dispose/invalidate` API 가 Mandu HMR 에서 동작
- [ ] `bun build ./packages/cli/src/main.ts --compile --outfile=mandu` 로 Linux/macOS/Windows 바이너리 생성
- [ ] GitHub Releases 에 3 개 OS 바이너리 자동 업로드 workflow
- [ ] 설치 스크립트 `curl -fsSL https://... | sh`
- [ ] `core/src/bundler/css.ts:22`, `cli/src/util/bun.ts:212` 의 Windows workaround 중 **Bun 1.3.10+ 에서 해소된 것 최소 1개 원복**
- [ ] 릴리즈: `@mandujs/core@0.25.0`

### 리스크
- R5-A: `--compile` 이 Windows code signing 필요 (미서명 바이너리 SmartScreen 경고) — 사내 서명 인프라 없으면 문서로 안내
- R5-B: Vite HMR API 전부 재현은 어려움 — 가장 많이 쓰는 `accept/dispose` 만 우선

---

## 8. 버전 전략

- **Phase 0** → `core` patch (0.21.x) — infra only, no API change
- **Phase 1** → `core` 0.22.0 — internal implementation change, API 호환
- **Phase 2** → `core` 0.23.0 + 3 new packages `@mandujs/{session,auth,csrf}@0.1.0`
- **Phase 3** → `core` patch + 2 new packages `@mandujs/{scheduler,storage-s3}@0.1.0`
- **Phase 4** → `core` 0.24.0 + `@mandujs/db@0.1.0` — **resource 레이어 변경 있음, deprecation notice 동반**
- **Phase 5** → `core` 0.25.0

**1.0.0 후보 시점**: Phase 4 종료 후. 이유 — 핵심 레이어 (http, cookie, session, auth, db) 전부 안정된 시점. 또는 Phase 5 종료 후 전체 "배터리 포함" 완성 시점.

---

## 9. 당장 시작할 수 있는 첫 PR (Today)

**선택지 3개** (가장 위험 낮은 순):

### A. 10분 — Phase 0.2: CI 플래그 추가
```yaml
# .github/workflows/ci.yml 의 모든 test 라인
- run: bun run test:core -- --randomize --seed ${{ github.run_id }} --retry=2
- run: bun run test:cli  -- --randomize --seed ${{ github.run_id }} --retry=2
...
```
리스크: 없음. CI 1회 돌려보고 머지.

### B. 30분~1시간 — Phase 0.1: perf 헬퍼
`packages/core/src/perf/index.ts` 신규:
```ts
const enabled = () => process.env.MANDU_PERF === "1";
const marks = new Map<string, bigint>();
export function mark(name: string) { if (enabled()) marks.set(name, Bun.nanoseconds()); }
export function measure(name: string, start: string) {
  if (!enabled()) return;
  const ns = Bun.nanoseconds() - (marks.get(start) ?? 0n);
  console.log(`[perf] ${name}: ${Number(ns) / 1e6}ms`);
}
```
그리고 `core/src/bundler/dev.ts`, `core/src/runtime/streaming-ssr.ts` 등에 계측 포인트 5곳 추가.

### C. 2시간 — Phase 0.3: randomUUIDv7 통합
`packages/core/src/id/index.ts` 신규:
```ts
export const newId = () => crypto.randomUUIDv7();
```
기존 uuid v4 호출부 grep → 교체. 마이그레이션 없이 (신규 ID 만 v7, 기존 v4 ID 는 DB 에서 그대로 읽힘).

**추천**: A → B → C 순. A 는 즉시 머지, B 는 당일 머지, C 는 다음 날.

---

## 10. Phase 중단·전환 조건

각 phase 종료 전 **이 중 하나라도 해당하면 phase 중단하고 재설계**:

- **중단**: Bun 1.3.x 의 해당 API 가 deprecated/broken 판명 → 다음 minor 기다림
- **전환**: phase 중 더 큰 리스크 발견 (예: Workers adapter 전면 재설계 필요) → RFC 로 전환
- **축소**: 단일 개발자 리소스 부족 → 미들웨어 개수를 Phase 내에서 줄임 (예: Phase 2 에서 CSRF 만 하고 auth 다음 phase)

---

## 11. 리뷰 체크포인트

- **Phase 0 종료 시**: Phase 1 의 "D1~D3 설계 결정" 확정. 작성되지 않았으면 Phase 1 시작 금지.
- **Phase 1 종료 시**: Phase 2 demo 앱 스펙 (`demo/auth-starter/` 요구사항) 문서화.
- **Phase 3 종료 시**: Phase 4 RFC 초안 공개. 최소 1주 의견 수렴.
- **매 phase 종료 시**: [`improvements-roadmap.md`](./improvements-roadmap.md) 의 우선순위 재평가 — 사용자 피드백·Bun 릴리즈 따라 다음 phase 가 바뀔 수 있음.

---

## 12. 참조

- [`features-catalog.md`](./features-catalog.md) — Bun 1.3.x 전수 조사
- [`improvements-roadmap.md`](./improvements-roadmap.md) — 격차 분석 + 우선순위
- 공식 출처: https://bun.com/docs, https://bun.com/blog

*이 plan 은 실행 시작 전의 제안이며, Phase 0 종료 후 1회 재검토를 권장합니다 (실제 작업량·리스크 조정).*
