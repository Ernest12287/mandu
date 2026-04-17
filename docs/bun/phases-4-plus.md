---
title: "Mandu × Bun 1.3.x — Phase 4+ 확장 계획"
status: proposal
audience: Mandu core team
created: 2026-04-18
supersedes: phases-plan.md §6–§7 (Phase 4/5 초안)
bun_version: "1.3.12"
---

# Phase 4+ 확장 계획

> [`phases-plan.md`](./phases-plan.md) 원안(Phase 0–5)에서 Phase 0~3 는 완료. 이 문서는 **Phase 4 이후** 를 (a) 원안 Phase 4/5 보정 (b) 경험으로 드러난 새 필요(OAuth·email·rate limit·DX 헬퍼·observability) 를 반영해 재설계.

---

## 0. 지금까지 완성한 것 (Phase 0–3)

| Phase | 산출 | 상태 |
|---|---|---|
| 0 | perf/id/safeBuild/linker/catalogs + CI --randomize 게이트 | ✅ 1631 test |
| 1.1 | Cookie codec abstraction (Bun.CookieMap + Legacy) | ✅ 46 test |
| 2 | password/CSRF/session/login + auth barrel + demo | ✅ 76 신규 test + 7 E2E |
| 3 | scheduler (Bun.cron) + S3 (Bun.s3) | ✅ 61 신규 test + 3.3 진행 중 |
| DX | page loader / cookie get / layout cookies / loader redirect | ✅ 50 신규 test |

**현재 퍼블릭 API**: `@mandujs/core` + subpaths `perf`, `id`, `auth`, `auth/login`, `auth/password`, `middleware/{cors,jwt,compress,logger,timeout,csrf,session}`, `scheduler`, `storage/s3`, `bundler/safe-build`.

**보조 발견 (후속 반영 필요)**:
- Bun 1.3.10 `CookieMap.toSetCookieHeaders()` Expires day-of-week 버그 — 1.3.12 에서 해소됐는지 재검증 필요
- Phase 2.6 통합에서 4개 DX 버그 노출 → 모두 수정. 유사한 rough edge 가 더 있을 가능성
- Bun.build 교차-워커 경합 (Phase 0.6 gate로 우회) — upstream 개선 시 gate 제거 가능

**"배터리 포함" 관점에서 아직 못한 것**:
- DB 계층 (Phase 4 원안)
- 소셜 로그인 (OAuth)
- 이메일 발송 (signup verification, password reset)
- 요청 비율 제한 (rate limit)
- 보안 헤더 번들 (Helmet 대체)
- HMR 표준 호환 (import.meta.hot)
- 단일 바이너리 배포 (--compile)
- 관측성 (request tracing, metrics)

---

## 1. Phase 4+ 로드맵 요약

| Phase | 기간 | 테마 | 주요 산출 | 1.0.0 마일스톤? |
|---|---|---|---|---|
| **4** | 3주 | 데이터 계층 | `Bun.sql` 어댑터 + SQLite session store + resource 통합 | — |
| **5** | 3주 | 인증 생태계 확장 | OAuth 미들웨어 + 이메일 + verification/reset 플로우 | — |
| **6** | 2주 | 프로덕션 하드닝 | rate limit + secure headers + `notFound()` + 에러 페이지 규약 | **1.0.0 목표** |
| **7** | 2주 | HMR·배포 | `import.meta.hot` + CLI `--compile` | 1.0.x |
| **8** (optional) | 2주 | 관측성 | request tracing + metrics export | 1.1.0 |

**총**: 필수(4~7) 10주, 옵션(8) 포함 12주.

**의존성**:
```
Phase 4 (DB) ──┬─→ Phase 5 (auth 생태계, user store 필요)
               └─→ Phase 6 (rate limit store 옵션)
Phase 5 ──┬─→ Phase 6 (auth demo 완성 후 하드닝)
Phase 6 ──→ 1.0.0 RELEASE
Phase 7 (HMR·compile) — 병렬 가능 (Phase 5/6 와 독립)
Phase 8 — Phase 6 완료 후
```

---

## 2. Phase 4 — 데이터 계층 (3주)

### 목표
Mandu 앱이 **in-memory Map 을 넘어 실제 DB 에 persist** 할 수 있도록. `Bun.sql` (1.3 Postgres + MySQL + SQLite 통합) 을 얇게 래핑하고, Mandu resource 레이어에 통합한다.

### 범위 (4a / 4b / 4c)

**4a — `@mandujs/core/db` (1주, 독립)**
- `@mandujs/core/db`: `Bun.sql` wrapper
  - `createDb({ provider, url, pool })` — Postgres/MySQL/SQLite
  - tagged template: `` await db`SELECT * FROM users WHERE id = ${id}` ``
  - transaction: `await db.transaction(async (tx) => { ... })`
  - prepared statement cache
  - connection pool config
- 테스트: SQLite unit + Postgres/MySQL 도커 통합 (CI 게이트)

**4b — SQLite 세션 스토어 (3일, Phase 2.5 에서 이관)**
- `@mandujs/core/filling/session-sqlite`: 기존 `SessionStorage` 인터페이스 구현
- `bun:sqlite` + WAL + busy_timeout
- 세션 id 쿠키 / 데이터 DB row
- TTL lazy expiry + `Bun.cron` 으로 GC (Phase 3.1 scheduler 재사용)
- Demo: auth-starter 에 SQLite 스토어 옵션 추가

**4c — Resource 레이어 통합 (2주, RFC 먼저)**
- RFC `docs/rfcs/0001-db-resource-layer.md` (1주 의견 수렴)
- `spec/resources/*.resource.ts` 가 `Bun.sql` 기반 CRUD 생성하도록 `resource/generator.ts` 확장
- 현재 generator 는 contract/slot/client 만. DB persist 레이어 추가
- 마이그레이션 도구: drizzle-kit 통합 vs 자체 rolling migration (RFC 에서 결정)
- 기존 사용자 하위 호환 — 새 resource 필드 opt-in

### 종료 조건
- [ ] `@mandujs/core/db` 배포
- [ ] Postgres/MySQL/SQLite 3 공급자 E2E
- [ ] SQLite 세션 스토어 + demo/auth-starter 옵션
- [ ] Resource RFC + 구현
- [ ] 호환 레이어 — 기존 resource 사용자 앱 unchanged
- [ ] `docs/db/` 가이드 (quickstart + 마이그레이션)
- [ ] 릴리즈: `core 0.24.0` (minor; deprecation notice 있음)

### 리스크
- R4-A: resource API 변경이 기존 사용자 파손 → deprecation cycle 2 minor, codemod 제공
- R4-B: Bun.sql Postgres 성능이 `postgres.js` 대비 부족 → 벤치 먼저, 부족하면 adapter 인터페이스만 유지하고 실 구현 교체 가능하게
- R4-C: SQLite → Postgres 전환 방언 차이 → `Bun.sql` 공통 부분만 사용하도록 lint

---

## 3. Phase 5 — 인증 생태계 확장 (3주)

### 목표
Phase 2 가 "패스워드 로그인" 까지. 현대 앱은 **OAuth + email verification + password reset** 까지 필수. Phase 4 DB 를 소비해 사용자 테이블에 persist.

### 범위 (5.1 / 5.2 / 5.3)

**5.1 — OAuth 미들웨어 (1.5주)**
- `@mandujs/core/middleware/oauth` — provider 플러그인 시스템
- 기본 지원: GitHub, Google. 추가 provider 는 사용자가 setup 객체로 등록
- OAuth 2.0 authorization code flow (PKCE 포함)
- state/nonce 관리 (CSRF 패턴)
- `Bun.secrets` (1.3 experimental) 로 로컬 dev 크레덴셜 관리 검토
- Demo: auth-starter 에 "Continue with GitHub" 버튼

**5.2 — 이메일 primitive (1주)**
- `@mandujs/core/email` — 추상 인터페이스 `send({ to, subject, html, text })`
- Adapter 3종:
  - `smtp` — 표준 SMTP (nodemailer 대체, `node:net` 기반 최소 구현)
  - `resend` — Resend HTTP API (API key 만 필요)
  - `memory` — dev/테스트용 in-memory spool
- provider 선택: `createEmailSender({ adapter: "resend", apiKey })`

**5.3 — verification / reset 플로우 (2.5일)**
- `@mandujs/core/auth/verification` — email verification token 생성/검증
- `@mandujs/core/auth/reset` — password reset token (single-use, expiring)
- 토큰은 Phase 4 DB 에 persist
- Demo: auth-starter 에 `/signup` 후 email verification + `/forgot-password` 플로우

### 종료 조건
- [ ] `@mandujs/core/middleware/oauth` + 2 provider (GitHub/Google)
- [ ] `@mandujs/core/email` + 3 adapter
- [ ] `@mandujs/core/auth/verification` + `/reset`
- [ ] Demo E2E 확장: 10 → 15 tests (OAuth mock + verify + reset)
- [ ] 릴리즈: `core 0.25.0`

### 리스크
- R5-A: OAuth provider API 변경(deprecation) → 공식 OIDC discovery 기반으로 최대한 동적 로드
- R5-B: SMTP 최소 구현 복잡도 → `smtp` adapter 는 v0.1 에서 Resend/Postmark 만 하고 SMTP 는 다음 minor
- R5-C: email deliverability — 문서로 DKIM/SPF 안내

---

## 4. Phase 6 — 프로덕션 하드닝 (2주, **1.0.0 후보**)

### 목표
"개발자 앱을 프로덕션에 올릴 준비". 보안 기본값 + 비율 제한 + DX 완성도. 이 phase 종료가 **1.0.0 릴리즈** 조건.

### 범위 (6.1 / 6.2 / 6.3 / 6.4)

**6.1 — Rate limiting 미들웨어 (3일)**
- `@mandujs/core/middleware/rate-limit`
- Sliding window 알고리즘
- Store 2종: in-memory (default), SQLite (Phase 4 db 재사용) — 향후 Redis adapter 확장 용이
- IP 기반 기본 + key 함수 커스터마이즈
- 429 응답 + `Retry-After` 헤더

**6.2 — `middleware/secure` 보안 헤더 번들 (2일)**
- CSP (Content-Security-Policy)
- HSTS (Strict-Transport-Security)
- X-Frame-Options (또는 CSP frame-ancestors)
- X-Content-Type-Options, Referrer-Policy, Permissions-Policy
- opinionated 기본값 + override 옵션
- Helmet 대체

**6.3 — DX 헬퍼 (3일)**
- `notFound(reason?)` — Phase DX-3 의 `redirect()` 짝: loader/handler 에서 404 반환
- `unauthorized()`, `forbidden()` — 이미 ctx 에 있지만 독립 import 가능하게
- Error boundary auto-generation — `app/error.tsx` 규약 정리, stack/digest 일관 노출
- `app/not-found.tsx` 규약 (route 미매칭 시 렌더)

**6.4 — 1.0.0 릴리즈 준비 (2일)**
- CHANGELOG migration guide (0.x → 1.0)
- 기존 모든 deprecation 실제 제거 or 유지 결정
- API stability 선언: breaking change 시 major bump
- `mandu init --template auth-starter` 템플릿 공식화 (demo → template)

### 종료 조건
- [ ] `rate-limit`, `secure` 미들웨어 배포
- [ ] `notFound`, error helper 4종 배포
- [ ] `app/not-found.tsx` 규약 적용
- [ ] 1.0.0 릴리즈 — `core 1.0.0`, 모든 subpath 패키지 1.0.0 정렬
- [ ] 마이그레이션 가이드 공개

### 리스크
- R6-A: 1.0.0 API stability 선언 시 이후 변경 비용 급증 → Phase 6 전에 모든 public API 리뷰 1주 (RFC 아님, 감사)
- R6-B: Helmet 수준 보안 헤더 호환성 — CSP 기본값이 너무 strict 면 dev 모드 불편 → 개발 모드 완화 스위치

---

## 5. Phase 7 — HMR·배포 (2주, 원 Phase 5 수정)

### 목표
개발 경험 (HMR 표준 호환) + 배포 UX (단일 바이너리). 1.0.0 후 follow-up.

### 범위 (7.1 / 7.2 / 7.3)

**7.1 — `import.meta.hot` Vite 호환 (1주)**
- 내부 WS 프로토콜 위에 Vite 호환 API 레이어: `accept()`, `dispose()`, `invalidate()`
- 유저 코드 `if (import.meta.hot)` 가드 지원
- Playwright E2E: 컴포넌트 수정 → state 보존

**7.2 — CLI `--compile` 단일 바이너리 (1주)**
- `bun build packages/cli/src/main.ts --compile --outfile=mandu`
- GitHub Releases workflow: Linux/macOS/Windows 3 OS 매트릭스
- 설치 스크립트 `curl -fsSL https://mandu.dev/install.sh | sh`
- Windows code signing 이슈 문서

**7.3 — Windows workaround 정리 (2일)**
- Bun 1.3.12 로 CI 올라왔으므로 `core/src/bundler/css.ts:22`, `cli/src/util/bun.ts:212` 워크어라운드 재검증. 해소된 것 최소 1개 원복

### 종료 조건
- [ ] `import.meta.hot` API 동작
- [ ] 3 OS 바이너리 자동 배포
- [ ] Windows workaround 정리 ≥ 1건
- [ ] 릴리즈: `core 1.0.x` patch + 배포 파이프라인

---

## 6. Phase 8 — 관측성 (2주, optional, 1.1.0)

### 목표
운영 팀 친화. request tracing + metrics + admin inspection.

### 범위
- 8.1 Request tracing 미들웨어 — OpenTelemetry 호환 span 발행 또는 structured log 포맷
- 8.2 Metrics export — Prometheus `/metrics` 엔드포인트 (요청 수/레이턴시 히스토그램/에러율)
- 8.3 Kitchen 대시보드 확장 — dev 에서 이미 있는 kitchen UI 에 관측성 패널 추가

---

## 7. 새로 파악된 "필요하면 끼워 넣을" 미니 기능

Phase 3.3 데모 작업 중 쉽게 추가 가능:
- **Session flash 메시지** — `session.setFlash("msg", "Logged in!")` → 다음 요청 1회만 표시. 이미 `Session` 클래스에 `flash` Map 있음, 미들웨어만 얇게.
- **`Bun.secrets` dev 크레덴셜 헬퍼** — OAuth secret 을 `.env` 대신 OS 키체인에. Phase 5.1 에서 흡수 가능.

---

## 7A. Bun 1.3.12 새 OS 통합 기능 — 전용 phase 후보

**`Bun.WebView` (1.3.12, native OS WebView 통합)** 와 **`Bun.markdown` (1.3.12, 터미널 마크다운 렌더링)** 은 Mandu 의 수직 스토리를 확장할 수 있는 네이티브 기능. Phase 4~6 이 "웹 앱 백엔드" 라면 이것은 **데스크톱 / CLI UX 확장**.

### Phase 9 (신규 제안, optional) — Desktop & CLI 통합 (2~3주)

**9.1 — `Bun.WebView` 기반 데스크톱 배포 (2주)**
- Mandu 앱을 OS 네이티브 WebView 로 번들링 (macOS: WKWebView, Windows: WebView2, Linux: WebKitGTK)
- Electron/Tauri 없이 **Bun 단일 바이너리 + Web UI** — 용량/성능 이득
- Phase 7 의 `--compile` 바이너리와 결합: `mandu build --target=desktop`
- 구조 예시:
  ```ts
  // desktop/main.ts
  import { createWebView } from "@mandujs/core/desktop";
  import { startServer } from "@mandujs/core";
  import manifest from "./.mandu/manifest.json" with { type: "json" };

  const server = startServer(manifest, { port: 0, hostname: "127.0.0.1" });
  await createWebView({ url: `http://127.0.0.1:${server.port}`, title: "My App" });
  ```
- 주의: `Bun.WebView` 가 1.3.12 experimental 인지 stable 인지 catalog 재확인
- 사용자 가치: **동일 Mandu 앱 코드 → 웹 + 데스크톱 두 타깃**. Tauri 대체.

**9.2 — `Bun.markdown` 기반 CLI UX (3~5일)**
- `mandu init` 실행 시 랜딩 마크다운 터미널 렌더 (설명/다음 단계/링크)
- `mandu --help`, `mandu doctor` 출력이 구조화된 마크다운
- 에러 메시지 (CLI_E0*) 를 마크다운 템플릿으로 통일 → code block / 링크 / 강조 자동
- 사용자 가치: CLI 첫인상 + 진단 출력 품질 향상. 의존성 0.
- `@mandujs/cli` 내부에서만 사용 — 공개 API 아님

### 위치
- 9.1 은 별도 phase 로 우선순위 낮지만 **"Bun 으로 풀스택 + 데스크톱" 이라는 포지셔닝** 에 결정적. 1.0.0 이후 시도 추천
- 9.2 는 Phase 7 (HMR/compile) 과 같이 묶어 CLI 전반 DX 정리 가능

---

## 8. 의사결정 필요 — 사용자 확인

Phase 4~8 실행 순서로 바로 진입하기 전에 확인 사항:

### D4-A. Phase 4 DB 공급자 우선순위
- SQLite (dev zero-config) → Postgres (prod) → MySQL 순서 제안
- 실제 사용할 프로덕션 DB 가 무엇인지에 따라 조정 가능

### D4-B. 마이그레이션 도구
- **자체 롤링**: 유지보수 비용, 완전 컨트롤
- **drizzle-kit 통합**: 성숙, dep 추가
- 추천: 자체 구현 (Mandu "zero-deps" 철학 유지)

### D5-A. OAuth 2 개 우선순위
- GitHub + Google 이 기본 (가장 보편)
- Discord, Twitter, Microsoft 등은 사용자 기여로 확장

### D5-B. 이메일 adapter 우선순위
- 추천: Resend (현대적, API 간단) 우선 → SMTP 다음 minor
- 사용자가 원하는 provider 있으면 조정

### D6-A. 1.0.0 타이밍
- Phase 6 종료 시점 (추천): 프로덕션 레디
- Phase 7 종료 시점: 배포까지 완성
- 선택 필요

---

## 9. 즉시 착수 가능한 첫 PR (Phase 4 시작)

**Phase 4a — `Bun.sql` 어댑터 PoC** (1일)
- `packages/core/src/db/index.ts` — 최소 인터페이스만
- `@mandujs/core/db` subpath export
- SQLite 공급자 unit test 10개
- Postgres/MySQL 은 도커 CI 로 다음 PR

이거 하나 머지하면 이후 4b (session SQLite) 가 바로 올라갈 수 있어 체감 좋음.

---

## 10. 참조

- [`phases-plan.md`](./phases-plan.md) — 원안 (Phase 0–5)
- [`improvements-roadmap.md`](./improvements-roadmap.md) — 격차 분석
- [`features-catalog.md`](./features-catalog.md) — Bun 1.3.x 전체 기능
- [`phase-2-design.md`](./phase-2-design.md) — Phase 2 revised design

*이 문서는 Phase 4 착수 전 제안. D4-A, D4-B, D5-A, D5-B, D6-A 결정 후 각 phase 진입.*
