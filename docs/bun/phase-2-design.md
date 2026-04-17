---
title: "Phase 2 설계 — 인증·CSRF·세션 (revised after recon)"
status: design
audience: Mandu core team
supersedes: phases-plan.md §4 (Phase 2 초안)
created: 2026-04-17
---

# Phase 2 설계 — 인증·CSRF·세션

> 최초 제안(로드맵·phases-plan)은 신규 `@mandujs/session`, `@mandujs/auth`, `@mandujs/csrf` 3 패키지 추가였으나, 실측 조사 결과 **코어가 이미 광범위한 미들웨어 인프라**를 갖추고 있어 패키지 신설은 **프로젝트 컨벤션과 충돌**. 이 문서가 최종 설계.

---

## 실측 결과 (Phase 1 recon + 추가 조사)

### 이미 존재하는 것
| 위치 | 내용 | 재사용 |
|---|---|---|
| `core/src/middleware/index.ts` | cors, jwt, compress, logger, timeout 5개 미들웨어 barrel | 컨벤션 기준 |
| `core/src/filling/session.ts` | `createCookieSessionStorage` — 쿠키에 서명된 JSON 저장 | 기반 활용 |
| `core/src/filling/auth.ts` | `AuthenticationError`/`AuthorizationError` + `requireUser`/`requireRole` 가드 | 확장 |
| `core/src/filling/context.ts` | `CookieManager` (Phase 1.1에서 내부 구현만 `Bun.CookieMap` 기반으로 교체 중) | 그대로 사용 |

### 미들웨어 계약 (기존 컨벤션)
```ts
type Middleware = (ctx: ManduContext) => Promise<Response | void>;
// void → 다음 핸들러 진행
// Response → 조기 반환 (체인 중단)
```

체인 API: `Mandu.filling().use(mw1).use(mw2).get(handler)`

## Phase 2 실제 갭

| 필요 | 현황 | 조치 |
|---|---|---|
| 패스워드 해싱 (argon2id) | 없음 | **새 모듈** `core/src/auth/password.ts` |
| CSRF 보호 | 없음 | **새 미들웨어** `core/src/middleware/csrf.ts` |
| Session 미들웨어 (ctx.session 자동 attach) | `createCookieSessionStorage`는 있으나 수동 호출 | **새 미들웨어** `core/src/middleware/session.ts` |
| Session SQLite 스토어 (큰 세션 데이터) | 없음 (쿠키 스토리지만) | **새 모듈** `core/src/filling/session-sqlite.ts` |
| 로그인/로그아웃 헬퍼 | 없음 (유저가 직접 `session.set("userId", ...)`) | `core/src/auth/login.ts` |

## D4~D7 설계 결정 (확정)

### D4. 패키지 구조
**결정**: 신규 패키지 **생성 안 함**. `packages/core` 내부에 추가.

근거:
- 기존 미들웨어 5개 전부 `core/src/middleware/` 에 있음
- 유저는 이미 `import { cors, jwt } from "@mandujs/core/middleware"` 패턴 학습
- 별도 패키지는 버전 조화 비용 + 설치 마찰

### D5. 미들웨어 인터페이스
**결정**: 기존 `(ctx) => Promise<Response | void>` 유지. 확장 금지.

새 미들웨어 3종 전부 이 시그니처 준수:
```ts
export function session(options): Middleware
export function csrf(options): Middleware
// password는 미들웨어가 아닌 순수 함수
```

### D6. Session 저장 전략
**결정**: **두 가지 스토어 지원**.

1. **Cookie store (기본)** — `createCookieSessionStorage`. 이미 존재. 큰 데이터(>4KB) 불가.
2. **SQLite store (옵션)** — 신설. 세션 id만 쿠키에, 실제 데이터는 `bun:sqlite` row.

`session()` 미들웨어가 storage 인터페이스를 받아 둘 다 수용:
```ts
interface SessionStorage {
  getSession(cookies: CookieManager): Promise<Session>;
  commitSession(session: Session): Promise<string>; // Set-Cookie 문자열
  destroySession(session: Session): Promise<string>;
}
```
(이미 존재하는 인터페이스 그대로 — 새 코드 추가 최소화)

### D7. CSRF 전략
**결정**: **Stateless double-submit** 기본 + **session-synced** 옵션.

- 기본: 쿠키에 토큰 + 요청에 동일 토큰 (헤더 또는 폼 필드). 세션 불필요.
- 옵션: 세션 미들웨어 장착 시 세션에 토큰 보관하는 더 강한 모드.
- 메서드: POST/PUT/PATCH/DELETE 자동 검증. GET/HEAD/OPTIONS skip.

`Bun.CSRF.generate/verify` (1.3 네이티브) 를 wrapper 로 사용. Bun 미지원 시 `crypto.randomUUID` + HMAC fallback.

### D8 (추가). 의존 그래프 & 실행 순서
```
password.ts  ┐
             ├→ login.ts ─┐
session.ts   ┘            │
                          ├→ demo/auth-starter
csrf.ts ──────────────────┤
session-sqlite.ts ────────┘
```

실행 순서:
1. **2.1** `auth/password.ts` — 패스워드 해싱 (독립, 15분)
2. **2.2** `middleware/csrf.ts` — CSRF (독립, 반나절)
3. **2.3** `middleware/session.ts` — session attach (반나절)
4. **2.4** `auth/login.ts` — loginUser/logoutUser (세션 위에 얹음, 30분)
5. **2.5** `filling/session-sqlite.ts` — SQLite 스토어 (optional, 하루)
6. **2.6** `demo/auth-starter/` — 통합 demo + E2E (2~3일)

2.1/2.2 는 병렬 가능, 2.3/2.4 는 2.1·2.2 완료 후 직렬, 2.5 는 선택.

## 작업 범위 상세

### 2.1 `core/src/auth/password.ts`
```ts
export async function hashPassword(plain: string, options?: {
  algorithm?: "argon2id" | "argon2d" | "argon2i" | "bcrypt";
  memoryCost?: number;
  timeCost?: number;
}): Promise<string>;

export async function verifyPassword(plain: string, hash: string): Promise<boolean>;
```
- `Bun.password.hash/verify` 직접 호출. 기본값 argon2id.
- 에러 처리: bcrypt 해시에 argon2 verify 호출 등을 Bun이 내부적으로 알고리즘 자동 감지.
- 타입: `never any`, 전부 문자열 in/out.
- 테스트 8개: 정답/오답/변조/cross-algorithm/옵션 오버라이드.

### 2.2 `core/src/middleware/csrf.ts`
```ts
export interface CsrfMiddlewareOptions {
  secret: string;               // 토큰 서명용 (required)
  cookieName?: string;           // default "__csrf"
  headerName?: string;           // default "x-csrf-token"
  fieldName?: string;            // default "_csrf" (form POST)
  safeMethods?: string[];        // default ["GET","HEAD","OPTIONS"]
  cookieOptions?: Partial<CookieOptions>;
}

export function csrf(options: CsrfMiddlewareOptions): Middleware;
```
- 요청 시: double-submit 검증 (cookie === header || form field)
- 응답 시: 토큰 없으면 새 발행
- 403 on mismatch
- 테스트 10+: 안전 메서드, unsafe 메서드 (토큰 있음/없음/불일치), 헤더 vs 폼, 토큰 생성/재사용.

### 2.3 `core/src/middleware/session.ts`
```ts
export interface SessionMiddlewareOptions {
  storage: SessionStorage;       // 기존 인터페이스 재사용
  attach?: "session" | string;   // default "session" — ctx.set("session", ...) 키
}

export function session(options: SessionMiddlewareOptions): Middleware;
```
- 요청 진입: `storage.getSession(ctx.cookies)` → `ctx.set(key, session)`
- 응답 마무리: 세션이 dirty면 `storage.commitSession(session)` → Set-Cookie header append
- 컨텍스트 훅: `ctx.beforeResponse(() => ...)` 패턴이 없으면 **핸들러 실행 후 체크** 방식으로 구현
- 테스트: attach 검증, 변경 시 자동 commit, 변경 없으면 commit 안 함, destroy 시 쿠키 삭제.

### 2.4 `core/src/auth/login.ts`
```ts
export function loginUser(ctx: ManduContext, userId: string, extras?: Record<string, unknown>): void;
export function logoutUser(ctx: ManduContext): Promise<void>;
export function currentUser<T = BaseUser>(ctx: ManduContext): T | null;
```
- `ctx.get("session")` 을 읽어 `userId` set/delete
- session 미들웨어 선행 필수 — 없으면 명확한 에러 throw.

### 2.5 `core/src/filling/session-sqlite.ts` (선택)
```ts
export interface SqliteSessionStorageOptions {
  cookie: CookieSessionOptions["cookie"];
  dbPath?: string;              // default ".mandu/sessions.db"
  table?: string;               // default "mandu_sessions"
}

export function createSqliteSessionStorage(options: SqliteSessionStorageOptions): SessionStorage;
```
- `bun:sqlite` + WAL + busy_timeout.
- 세션 id는 쿠키에 서명 저장, 데이터는 DB row.
- TTL 만료 row는 lazy delete (get 시 검사) + `bun:cron` 옵션.
- 테스트: CRUD + 동시성 + TTL 만료.

### 2.6 `demo/auth-starter/`
- 페이지: /signup, /login, /dashboard (보호), /logout
- 폼에 CSRF 토큰 자동 포함 (`<CsrfInput />` helper)
- Playwright E2E: signup → login → dashboard → logout 전 플로우
- 이 데모가 향후 `mandu init --template auth-starter` 후보

## 테스트 게이트 (Phase 2 종료 조건)

- [ ] `packages/core/src/auth/password.test.ts` — 8+ test, argon2id 해시/검증 통과
- [ ] `packages/core/src/middleware/csrf.test.ts` — 10+ test, stateless double-submit + stateful 모드
- [ ] `packages/core/src/middleware/session.test.ts` — 6+ test, cookie 스토어 기반 attach + commit
- [ ] `packages/core/src/auth/login.test.ts` — 5+ test, loginUser → currentUser → logoutUser 왕복
- [ ] `packages/core/src/filling/session-sqlite.test.ts` — SQLite CRUD + 동시성 (optional)
- [ ] `demo/auth-starter/tests/e2e/*.spec.ts` — 전 플로우 E2E
- [ ] 기존 1955 테스트 regression 0
- [ ] `bun run typecheck` 4 packages green
- [ ] `docs/middleware/csrf.md`, `docs/middleware/session.md`, `docs/auth/password.md`, `docs/auth/login.md`

## 비주행 (non-goals)

- OAuth, SSO, SAML, magic-link, WebAuthn/Passkey — out of scope (별도 phase)
- Rate-limit 미들웨어 (Phase 3 스케줄러 미들웨어와 같이 고려)
- Multi-tenant session partitioning — 스코프 외

## 출력물

- 4 new source files + 4 test files in `packages/core`
- 1 new demo app under `demo/auth-starter/`
- 4 middleware docs under `docs/middleware/` 또는 `docs/auth/`
- Changeset 항목: `@mandujs/core` minor bump (신규 public API 추가)

## 리스크

| ID | 리스크 | 완화 |
|---|---|---|
| R2-A | `Bun.CSRF` 가 experimental 일 수 있음 | 실행 전 bun.com/docs 검증. experimental 이면 헤더 prefix 로 구분 |
| R2-B | `Bun.password` argon2 가 단일 스레드 블록 (100ms+) | 기본값 유지, 과부하 테스트에서 확인 후 문서화 |
| R2-C | session 미들웨어가 응답 직전에 commit 할 훅이 없음 | 현행 `ctx.withCookies()` 패턴 확인, 없으면 핸들러 직후 체크로 대체 |
| R2-D | `bun:sqlite` WAL 동시 write 이슈 | busy_timeout + 단일 connection 패턴 |

---

*Phase 1.1 (CookieMap) 완료 후 이 plan 으로 Phase 2 착수. 에이전트 파견 전 사용자 승인 필수 — 현재 design 문서 단계.*
