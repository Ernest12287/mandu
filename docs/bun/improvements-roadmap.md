---
title: "Mandu × Bun 1.3.x — 격차 분석과 개선 로드맵"
status: proposal
audience: Mandu core team
depends_on:
  - docs/bun/features-catalog.md
created: 2026-04-17
bun_version: "1.3.12"
---

# Mandu × Bun 1.3.x — 격차 분석과 개선 로드맵

> 본 문서는 [`features-catalog.md`](./features-catalog.md)(Bun 1.3.x 기능 전수조사)와 `packages/` 전 디렉토리 실측 조사를 교차 대조해, **어떤 네이티브 기능을 도입할지**, **어떤 재발명을 중단할지**, **어떤 미들웨어를 새로 낼지**를 우선순위화한 제안서입니다. 모든 권고는 file:line 근거를 동반합니다.

---

## TL;DR

- **이미 성숙**: `Bun.serve` / `Bun.file` (140+곳) / `Bun.write` / `Bun.spawn` / `Bun.build` / `Bun.Glob` / `bun:test` (149파일). 핵심 파이프라인은 네이티브 기반.
- **가장 큰 격차**: 1.3 에서 대거 추가된 **웹 스택 유틸** (`Bun.CookieMap`, `Bun.CSRF`, `Bun.password`, `Bun.secrets`, `Bun.sql`, `Bun.cron`) 을 **전혀 쓰지 않음**. 프레임워크가 유저에게 제공할 "배터리 포함" 미들웨어 소재로 바로 활용 가능.
- **재발명 중**: 커스텀 Trie 라우터(`core/src/runtime/router.ts`), 커스텀 쿠키 매니저, 자체 HMR WebSocket 프로토콜.
- **의도적 유지**: `chokidar` (debounce 필요), `ate/`의 `node:fs` / `node:child_process` (Node 이식성), `node:crypto.createHash` (deterministic hash). **건드리지 말 것.**
- **결론**: 권고안을 Quick win 5 / Platform upgrade 4 / **신규 미들웨어 6** / 전략적 베팅 3 으로 구분. 신규 미들웨어가 사용자 가치 최대 지점.

---

## 1. 이미 잘하고 있는 것 — 과잉 리팩터링 금지 구역

| 영역 | 현황 | 평가 |
|---|---|---|
| 테스트 러너 | `bun:test` 149파일, vitest 잔존 0 (이번 PR로 정리 완료) | ✅ 완전 |
| 파일 I/O | `Bun.file`/`Bun.write` 140+ 곳, Node fs 잔존은 `ate/`에만 (의도) | ✅ 완전 |
| HTTP 서버 | `Bun.serve` 기반, handler는 Cloudflare Workers도 고려한 추상화 | ✅ 합리적 |
| 번들러 | `Bun.build` + 자체 아일랜드/런타임 조립 | ✅ 필요한 재발명 |
| 프로세스 | 프레임워크 코어는 `Bun.spawn`. `ate/`는 `node:child_process` (Node 이식성 의도) | ✅ 균형 |
| 패키지 배포 | `bun publish` 로 전환 완료 (workspace:* 처리) | ✅ 완료 |

> **경계**: `ate/` 는 "Bun 없이도 돌아가는 테스트 러너 툴킷" 을 의도. 여기서 Node 표준 API 쓰는 것은 버그가 아니라 설계. 건드리지 말 것.

---

## 2. Quick Wins — 반나절 이하, 확실한 이득

### 2.1 `Bun.CookieMap` + `request.cookies` 전환 🔥

- **현재**: 커스텀 CookieManager. `ctx.cookies.set() / getSigned() / delete()` 패턴 사용 (`core/tests/server/cookie-ssr.test.ts` 참조). 쿠키 파싱/서명을 수동 구현.
- **대체**: 1.3 부터 `Bun.serve` 내부에서 `request.cookies` 가 `Bun.CookieMap` 인스턴스로 주입되고, 응답 시 변경된 쿠키가 **자동으로 `Set-Cookie` 헤더로 반영**됨.
- **작업량**: 반나절. 런타임 레이어에서 `ctx.cookies` 프록시만 `Bun.CookieMap` 으로 교체, signed 쿠키는 catalog의 ["10. 쿠키/폼/헤더"](./features-catalog.md) 참조 (서명 필드가 1.3 에서 네이티브 제공되면 그대로, 아니면 기존 HMAC 유지).
- **리스크**: Cloudflare Workers 호환성(코드에 `handler` 추상화 있음). CookieMap 은 Bun 전용이므로 adapter 계층에서 polyfill 필요.

### 2.2 `Bun.nanoseconds` 기반 perf 측정 도입

- **현재**: 성능 로그 없음. `core/src/bundler/dev.ts` HMR rebuild 시간, `core/src/runtime/streaming-ssr.ts` 렌더 시간, `core/src/router/fs-scanner.ts` 스캔 시간을 눈으로 추정.
- **도입**: `const t0 = Bun.nanoseconds(); ...; logger.debug('rebuild ms=', (Bun.nanoseconds()-t0)/1e6)` 패턴. 환경변수 `MANDU_PERF=1` 일 때만 활성.
- **작업량**: 파일당 5분, 전체 ~2시간.

### 2.3 CI 테스트 `--randomize --retry=2` 추가

- **현재**: `.github/workflows/ci.yml` 에서 `bun run test:core` 등 단순 실행. flaky 시 재시도 없음.
- **도입**: `bun test --randomize --seed $GITHUB_RUN_ID --retry=2` 로 순서 의존 버그 조기 탐지 + transient 실패 완화. 1.3 지원 (`features-catalog.md` — "4. 테스트").
- **작업량**: 워크플로 1파일 편집, 10분.

### 2.4 `Bun.Glob.scanAsync()` 로 비차단화

- **현재**: `core/src/change/snapshot.ts:47,247`, `core/src/change/integrity.ts:66`, `core/src/router/fs-scanner.ts:118` 모두 `glob.scan()` sync 호출.
- **도입**: 대규모 프로젝트에서 이벤트 루프 블로킹 완화. `for await (const f of glob.scanAsync(...))`.
- **리스크**: 호출부가 이미 async 인지 확인 필요. `change/snapshot.ts` 는 스냅샷 원자성 때문에 sync 유지가 맞을 수도 있음 (선별 도입).
- **작업량**: 파일당 30분 × 4 = 2시간.

### 2.5 `crypto.randomUUIDv7` 도입 (시간 순서 정렬 ID)

- **현재**: uuid id 생성 지점 확인 후 v4 쓰고 있다면 대체 후보. HMR client id, request correlation id, session id 등.
- **도입**: `crypto.randomUUIDv7()` (1.3) — 시간 정렬성 있어 로그 인덱스·DB 기본키에 유리.
- **작업량**: 30분.

---

## 3. Platform Upgrades — 1~2주, 인프라 개편

### 3.1 `Bun.serve({ routes })` 네이티브 라우팅 **혼합 도입**

- **현재**: `core/src/runtime/router.ts` 에 자체 Hybrid Trie 라우터 (v5.0). Static Map O(1) + Dynamic Trie O(k). `req.params` 추출, 중복 탐지, `%2f` 보안 필터 등 **네이티브에 없는 검증 다수**.
- **제안**: **전면 교체 아님**. 프레임워크 내장 엔드포인트 (`/__mandu/healthz`, `/__mandu/manifest.json`, OpenAPI spec serving `cli/src/commands/openapi.ts`, static assets)를 `Bun.serve` routes 로 위임. 사용자 정의 라우트는 기존 Trie 유지.
- **시너지**: `server.reload({ routes })` 로 HMR 중 라우트 테이블만 핫스왑 → 전체 재시작 제거.
- **작업량**: 3~5일. 기존 handler 추상화를 깨지 않도록 adapter 계층에서 Bun routes 를 소비.
- **참조**: `features-catalog.md` "1. HTTP 서버".

### 3.2 `--linker=isolated` workspace 검증 & 채택

- **현재**: 루트 `bun.lock` 만 존재, 기본 hoisted. phantom dependency 가능성.
- **제안**: 1.3 에서 workspaces 기본이 isolated 로 변경. `bun install --linker=isolated` 로 전체 테스트 1라운드 → phantom 발견 시 package.json dependency 보강 → 정식 채택.
- **리스크**: 일부 패키지가 간접 의존 노출에 의존 중일 수 있음 (특히 `packages/cli/src/util/bun.ts`의 bundled-importer 로직).
- **작업량**: 1~2일 (테스트 사이클 포함).

### 3.3 `import.meta.hot` Vite 호환 HMR 어댑터

- **현재**: 자체 WebSocket HMR 프로토콜 (`core/src/bundler/dev.ts`, SSR/streaming-ssr.ts 에 `css-update`, popstate handler 존재).
- **제안**: 클라이언트 측 HMR 수용 API 를 `import.meta.hot.accept/dispose` 형태로 제공. 내부적으론 기존 WS 채널 유지하되 **유저 코드가 Vite 생태계와 동일한 API 로 작성 가능**.
- **파급**: 외부 플러그인 저자가 Mandu 전용 HMR 런타임을 배우지 않아도 됨. `import.meta.hot` 은 1.3 에서 Bun 공식 지원.
- **작업량**: 1주. 내부 프로토콜 매핑 레이어만 추가.

### 3.4 `catalog:` 의존성 중앙 버전 관리

- **현재**: `package.json` 루트/패키지별 `react ^19.0.0`, `zod ^3.22.0` 등 중복 선언.
- **제안**: `package.json` 상단 `catalog:` 블록으로 React/Zod/React-DOM 을 선언하고 각 패키지에선 `"react": "catalog:react"` 로 참조. 1.3 `bun install` 네이티브.
- **작업량**: 반나절. `bun publish` 가 catalog 을 자동 치환하는지 검증 필요.

---

## 4. 신규 미들웨어 — Mandu의 "배터리 포함" 존

> 이 섹션이 **개발하고 싶다**는 요구에 가장 잘 맞음. 모두 `@mandujs/core/middleware/*` 또는 신규 `@mandujs/middleware-*` 패키지로 출시 가능.

### 4.1 `auth/password` — `Bun.password` 기반 패스워드 해싱

- **Bun API**: `Bun.password.hash(plain, { algorithm: "argon2id" })` / `Bun.password.verify(plain, hash)` — 네이티브 argon2·bcrypt.
- **제안 API**:
  ```ts
  // @mandujs/core/middleware/auth
  import { hashPassword, verifyPassword } from "@mandujs/core/auth";

  export async function POST(req: Request) {
    const { email, password } = await req.json();
    const hash = await hashPassword(password);          // argon2id
    await db.users.insert({ email, password_hash: hash });
  }
  ```
- **가치**: `bcrypt`/`argon2` npm 의존성 제거. bcrypt 는 prebuilt native 필요, Bun 네이티브는 평균 5~20배 빠름.
- **작업량**: 3일 (API 설계 + 테스트 + 문서).

### 4.2 `security/csrf` — `Bun.CSRF` 기반 토큰 미들웨어 🆕 (1.3)

- **Bun API**: `Bun.CSRF.generate(secret)` / `Bun.CSRF.verify(token, secret)`.
- **제안 API**:
  ```ts
  // spec/routes/api/submit.ts 등에서
  import { csrf } from "@mandujs/core/security/csrf";

  export const middleware = [csrf({ cookieName: "__csrf", secret: env.CSRF_SECRET })];

  export async function POST(req: Request) {
    // 자동으로 X-CSRF-Token 또는 form field 검증됨
  }
  ```
- **가치**: Mandu spec-routes 에 선언형 CSRF. 구현 없이 `csrf()` 한 줄.
- **작업량**: 2~3일.

### 4.3 `session/sqlite` — `bun:sqlite` + `Bun.CookieMap` 결합

- **Bun API**: `Database` from `bun:sqlite` (zero-dep, 네이티브), `Bun.CookieMap`.
- **제안**:
  - session id 는 쿠키 (서명), 값은 `bun:sqlite` row.
  - dev 기본 `.mandu/sessions.db`, 프로덕션은 커스터마이즈 가능.
  - TTL 자동 만료 (쿼리 시 expired row 필터링 + `Bun.cron` 로 GC).
- **API**:
  ```ts
  import { session } from "@mandujs/core/session/sqlite";
  // manifest 레벨에 장착
  startServer(manifest, { middleware: [session({ ttl: "7d" })] });
  // 핸들러에서
  export async function GET(req: Request) {
    const user = req.session.get("user");
  }
  ```
- **가치**: Redis/IORedis 없이 dev 부터 스테이징까지 session 지원. 스케일 필요 시 `Bun.redis` 어댑터로 교체 가능.
- **작업량**: 1주.

### 4.4 `scheduler/cron` — `Bun.cron` 인프로세스 스케줄러 🆕 (1.3.12)

- **Bun API**: `Bun.cron("0 * * * *", handler)` 인프로세스, 외부 의존성 0.
- **제안**:
  ```ts
  // mandu.config.ts 또는 별도 파일
  import { defineCron } from "@mandujs/core/scheduler";

  export default defineCron({
    "sessions:gc":    { schedule: "*/15 * * * *", run: async () => { ... } },
    "reports:daily":  { schedule: "0 4 * * *",   run: async () => { ... } },
  });
  ```
- **가치**: `node-cron`, `agenda`, `bullmq` 없이 일일 리포트/세션 GC/캐시 리프레시. dev 모드에선 등록 스킵 옵션.
- **작업량**: 3일. 중복 실행 방지 (multi-instance 배포용) 는 optional — 초기엔 single-instance 전제.

### 4.5 `storage/s3` — `Bun.s3` 기반 업로드 미들웨어

- **Bun API**: `Bun.s3.file("key").write(blob)`, `Bun.s3.file("key").presign({...})`.
- **제안**: multipart form 업로드 → 직접 S3 PUT. 대용량 파일 streaming presigned URL 발급.
  ```ts
  import { s3Upload, presignedUpload } from "@mandujs/core/storage/s3";

  export async function POST(req: Request) {
    const form = await req.formData();
    const key = await s3Upload(form.get("file") as Blob, { bucket: "uploads" });
    return Response.json({ key });
  }
  ```
- **가치**: `@aws-sdk/client-s3` (수십 MB) 완전 대체. Bun.s3 는 zero-dep + 네이티브.
- **작업량**: 4일.

### 4.6 `db/sql` — `Bun.sql` 어댑터 (Postgres/MySQL/SQLite 통합)

- **Bun API**: 1.3 부터 `Bun.sql` 이 Postgres + MySQL + SQLite 어댑터 통합. tagged template, connection pool, transaction 기본 제공.
- **제안**: Mandu `resource` 레이어의 기본 DB 어댑터. ORM 강제 없이 raw SQL + 타입 추론.
  ```ts
  // packages/core/src/db/sql.ts (신규)
  import { sql } from "@mandujs/core/db";

  const users = await sql`SELECT * FROM users WHERE active = ${true}`;
  ```
- **가치**: `pg`, `postgres`, `mysql2`, `better-sqlite3` 의존성 제거. Mandu 튜토리얼에서 "DB 없이 시작" → "DB 추가" 전환이 매끄러워짐.
- **작업량**: 1~2주 (리소스 레이어 통합 포함).

---

## 5. 전략적 베팅 — 1개월 단위, 실험성 높음

### 5.1 CLI `--compile` 단일 바이너리 배포

- **1.3.10** 의 `--compile --target=browser` 는 정적 SPA 까지 단일 HTML 로 packing. 여기선 일반 `--compile` (서버 바이너리).
- **현재**: `@mandujs/cli` 는 `bunx mandu ...` 로 실행. Bun 런타임 필수.
- **제안**: `bun build ./packages/cli/src/main.ts --compile --outfile=mandu` 로 **Bun 없는 머신에서도 돌아가는 `mandu` 바이너리** 배포. Linux/macOS/Windows 각각.
- **가치**: 초기 설치 UX (bun 설치 → mandu 사용) 이 (`mandu 다운로드` → 즉시 사용) 로 단축.
- **리스크**: CI 크로스 컴파일 파이프라인 구축, 바이너리 배포 채널 (GitHub Releases).
- **작업량**: 2주.

### 5.2 `Bun.plugin onBeforeParse` 로 빌드 속도 가속

- **Bun API**: 1.3 의 `onBeforeParse` 는 NAPI 네이티브 훅. JS 플러그인 오버헤드 없이 Rust/C 확장에서 직접 변환 가능.
- **후보**: `packages/cli/src/util/bun.ts:200` bundled importer, `core/src/bundler/build.ts` 의 island 번들 단계.
- **리스크**: NAPI 네이티브 작성 비용. 먼저 프로파일링으로 병목 확인 후 진행.
- **작업량**: 2~4주 (네이티브 코드 포함).

### 5.3 Windows 워크어라운드 정리 (1.3.10 ARM64 + 1.3.12 네트워킹 개선 반영)

- **현재 workaround**:
  - `core/src/bundler/css.ts:22` — Bun.spawn PATH 불안정 주석
  - `cli/src/util/bun.ts:212` — Bun.build `onResolve` Windows panic 우회
  - `core/src/bundler/dev.ts:77-79` — case-insensitive path normalization
- **제안**: 1.3.10+ 에서 Windows ARM64 정식 지원, 1.3.12 에서 `EADDRINUSE`/Unix socket 개선. 각 workaround 를 제거 PR 로 묶어 재측정 → 가능한 것만 원복.
- **가치**: 유지보수 부담 감소. 코드 가독성 개선.
- **작업량**: 1주. 회귀 테스트 중요.

---

## 6. 의식적으로 유지 — "이건 바꾸지 말자"

| 항목 | 이유 |
|---|---|
| `chokidar` (`core/src/watcher/*`, 4곳) | Bun fs.watch 1.3.12 에서 개선됐지만 **debounce/aggregation** 레이어는 여전히 userland. Mandu 빌드 큐잉은 이 aggregation 에 의존. |
| `ate/` 전체의 `node:fs` / `node:child_process` | ATE 는 "Bun 없이도 돌릴 수 있는 독립 툴킷" 을 목표. Node 표준 API 로 일부러 제약. |
| `node:crypto.createHash` (`core/src/utils/hasher.ts:13`) | deterministic config integrity 용. `Bun.hash` 는 byte hash, API shape 이 다름. 현 상태 유지. |
| 커스텀 HMR 프로토콜 | 4.3 으로 `import.meta.hot` 어댑터 추가하되, 내부 프로토콜 자체는 유지 (스트리밍 SSR + island re-mount 최적화). |
| 커스텀 Trie 라우터 | 2.1 의 혼합 도입으로 충분. 전면 교체는 보안 필터/중복 탐지 때문에 과함. |

---

## 7. 우선순위 매트릭스

가치 × 작업량 매트릭스 (🔥=즉시 / ⚡=다음 스프린트 / 🎯=분기 목표 / 🧪=실험).

| 🔥 즉시 (반나절~1일) | ⚡ 다음 스프린트 (3~5일) | 🎯 분기 목표 (1~2주) | 🧪 실험 (1개월+) |
|---|---|---|---|
| CI `--randomize --retry` (2.3) | CSRF middleware (4.2) | Session middleware (4.3) | CLI `--compile` (5.1) |
| `Bun.nanoseconds` perf (2.2) | `Bun.serve({routes})` 혼합 (3.1) | Auth middleware (4.1) | `Bun.plugin onBeforeParse` (5.2) |
| `Glob.scanAsync` (2.4) | Cron middleware (4.4) | S3 upload middleware (4.5) | Windows workaround 정리 (5.3) |
| `randomUUIDv7` (2.5) | Catalogs 적용 (3.4) | `Bun.sql` DB 어댑터 (4.6) | |
| `Bun.CookieMap` 전환 (2.1) | `--linker=isolated` 검증 (3.2) | `import.meta.hot` HMR (3.3) | |

---

## 8. 추천 실행 순서

1. **Week 1 — 전부 🔥 + CI/lockfile 정리**
   - 2.1 ~ 2.5 모두 소화. 토대 마련.
2. **Week 2–3 — ⚡ 중 미들웨어 우선**
   - 4.2 CSRF → 4.4 Cron → 3.1 Bun.serve routes 혼합.
   - 이유: 새 미들웨어 2개는 유저에게 즉시 보여줄 "신규 기능" + Bun 1.3 홍보 효과.
3. **Week 4–6 — 🎯 중 사용자 가치 큰 것**
   - 4.1 Auth → 4.3 Session → 4.5 S3 upload → 4.6 `Bun.sql` 어댑터 순.
   - 각각 예제 데모 앱 1개씩 (demo/ 하위) 동반 추천.
4. **Week 7+ — 🧪**
   - 5.1 `--compile` 은 릴리즈 파이프라인까지 포함이라 별도 트랙.

---

## 9. 성공 판정 기준

- **사용자 가치**: "Mandu 로 풀스택 앱 만들 때 외부 npm 의존성을 5개 이상 줄였다" 를 문서화할 수 있을 것.
- **성능**: HMR rebuild latency p50 < 300ms, SSR render p50 < 20ms (Bun.nanoseconds 계측 기반).
- **일관성**: `@mandujs/core/middleware/*` 가 모두 동일한 미들웨어 인터페이스 (`(ctx) => Response|void`) 를 따를 것.
- **호환성**: `--linker=isolated` 로 전 CI 매트릭스(Ubuntu/Windows/macOS) 통과.

---

## 10. 참조

- [`features-catalog.md`](./features-catalog.md) — Bun 1.3.x 전체 기능 카탈로그 (14 도메인, 하이라이트, 각주 URL 포함)
- 실측 조사: mandu-survey 에이전트 결과 (이 문서 생성 시점 기준, 회차 번호 없음 — 재실행 시 `packages/` 기준 재측정 필요)
- 출처: https://bun.com/docs, https://bun.com/blog (canonical)

*이 로드맵은 제안이며, 각 항목은 별도 RFC/이슈로 분리해 코어 팀 리뷰 후 착수하는 것을 권장합니다.*
