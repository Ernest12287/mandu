---
rfc: 0001
title: "Resource Layer DB Integration (Phase 4c)"
status: draft
authors: ["mandu core team"]
created: 2026-04-17
target_release: "core 0.24.0 (minor, deprecation window) → removed in 1.0.0"
supersedes: []
related:
  - docs/bun/phases-4-plus.md §2
  - docs/bun/improvements-roadmap.md §4.6
parallel:
  - Phase 4a — @mandujs/core/db (Bun expert)
  - Phase 4b — SQLite session store (validation engineer)
---

# RFC 0001 — Resource Layer DB Integration

## 1. Summary

Mandu `resource` generator는 오늘 contract/types/slot/client 네 개의 아티팩트만 방출하며 persistence는 각 사용자의 slot 코드에 `// TODO: Implement database query` 주석으로 위임돼 있다 (`packages/core/src/resource/generators/slot.ts:88-91, 113-116`). 본 RFC는 **`@mandujs/core/db` 가 제공하는 `Db` 인스턴스를 `ctx.deps.db` 를 통해 slot 에 주입**하고, **resource 정의에 선언적 `persistence` 필드를 옵트인**하여 SQL DDL / typed CRUD 메서드 / 마이그레이션을 생성하는 방식을 제안한다. 기존 resource 를 쓰는 앱은 persistence 필드를 생략한 채 그대로 동작하며, 새 `*.repo.ts` 아티팩트만 추가되므로 파일 레이아웃과 slot preservation 계약 (`generator.ts:180-192`) 을 보존한다.

## 2. Motivation

현재 상태:

- Slot 템플릿이 TODO 주석만 찍어주고 실제 persistence 는 유저가 각자 구현 (`slot.ts:88`). 한 resource 당 평균 5 개 handler × 5–10줄의 boilerplate 를 사용자가 반복해서 쓴다.
- `ctx.deps.db` 인터페이스는 `filling/deps.ts:13-23` 에 선언돼 있지만 — `query(sql, params)` / `transaction(fn)` 이 있을 뿐 — **실제 구현체가 없고** 어느 generator 도 이것을 consume 하지 않는다. DI 점이 이미 존재하는데 사용되지 않는 상태다.
- Phase 4a 가 `@mandujs/core/db` 를 내놓으면 "데이터베이스가 framework 안에 들어왔다" 는 약속이 되고, 사용자는 자연스럽게 "그럼 resource 에서 DB 를 어떻게 쓰라는 것이냐" 를 묻는다. 이 질문에 코드로 답하지 않으면 4a 는 `Bun.sql` 을 예쁘게 감싼 라이브러리에 그친다.
- 경쟁 상대인 Remix/Next 는 ORM (Prisma) 을 별도로 깔도록 떠넘긴다. Mandu 의 차별점은 **"resource 정의 하나에서 API + DB + 타입이 전부 생성된다"** 는 scaffolding-first 경험이다. 4c 가 없으면 이 차별점이 비어 있다.

왜 지금인가:

1. 4a 와 시점을 맞춰야 한다. 4a API 를 확정하기 전에 consumer 요구사항 (4c) 을 못 박아야 `@mandujs/core/db` 설계가 resource 레이어에 되돌릴 수 없이 박힌다.
2. `phases-4-plus.md §2` 가 4c 를 **RFC 1주 의견 수렴 후 구현 2주** 로 명시했다. 착수 지연 시 Phase 5 (OAuth, email) 가 연쇄 밀린다.
3. 기존 resource 가 아직 적다 (현재 레포 전체에서 `demo/todo-app/spec/resources/note/note.resource.ts` 한 개). 호환성 부담이 최저인 현재가 API breaking cost 가 가장 낮은 시점.

## 3. Current State of the Resource System

### 3.1 Public surface

`packages/core/src/resource/index.ts:7-42` 가 공개 API를 export 한다. 외부에는 다섯 개의 함수와 `ResourceDefinition` 타입이 노출된다. `defineResource` 는 schema 를 받아 기본 옵션 병합 후 그대로 돌려준다 (`schema.ts:120-145`). 필드 타입은 `string | number | boolean | date | uuid | email | url | json | array | object` 10 종 (`schema.ts:12-23`).

### 3.2 What `*.resource.ts` produces today

`parseResourceSchema` (`parser.ts:42-89`) 는 파일을 dynamic `import()` 한 뒤 `module.default` 를 `ResourceDefinition` 으로 취급한다. 파일명은 반드시 `*.resource.ts` (`parser.ts:44-47`). 그 뒤 `generateResourceArtifacts` (`generator.ts:81-127`) 가 네 개의 generator 를 순차 호출한다.

### 3.3 Artifact 매핑

`paths.ts:29-42` 의 `resolveGeneratedPaths` 가 출력 디렉토리를 결정한다. 현재 네 아티팩트는 다음과 같이 떨어진다:

| Artifact | 생성 경로 | 보존 정책 | 담당 generator |
|---|---|---|---|
| Contract | `.mandu/generated/server/contracts/{name}.contract.ts` | 매 회 overwrite | `generators/contract.ts:14-58` |
| Types | `.mandu/generated/server/types/{name}.types.ts` | 매 회 overwrite | `generators/types.ts:13-72` |
| Slot | `spec/slots/{name}.slot.ts` | **존재 시 preserve** (`generator.ts:180-192`) | `generators/slot.ts:15-44` |
| Client | `.mandu/generated/client/{name}.client.ts` | 매 회 overwrite | `generators/client.ts:14-79` |

중요 불변 (invariant): **contract / types / client 는 derived** — 매 build 마다 완전 재생성. **slot 은 user-editable** — 한 번 쓰면 `--force` 없이는 건드리지 않는다 (`generator.ts:181-192`). 이 경계를 4c 가 망가뜨리면 안 된다.

### 3.4 Persistence 가 오늘 어디에 있는가

**어디에도 없다.** `slot.ts:88-91, 113-116, 134-135, 155-158, 177-178` 이 handler 본문에 TODO 주석과 가짜 데이터 (`const mockData = { data: [], ... }`) 를 찍어준다:

```ts
// generators/slot.ts:87-103 에서 emit 하는 LIST handler
.get(async (ctx) => {
  const input = await ctx.input(contract, "GET", ctx.params);
  const { page, limit } = input;

  // TODO: Implement database query
  // const offset = (page - 1) * limit;
  // const items = await db.select().from(...).limit(limit).offset(offset);

  const mockData = { data: [], pagination: { page, limit, total: 0 } };
  return ctx.output(contract, 200, mockData);
})
```

즉 today 는 **user 가 slot 을 열어 수동으로 `db.query(...)` 를 작성**한다. 그러나 `ctx.deps.db` interface 는 `filling/deps.ts:13-23` 에 이미 선언돼 있다 — `query<T>(sql, params)` 와 `transaction<T>(fn)`. 문제는 이 DI 훅을 채우는 구현체가 없고, emit 되는 slot 코드도 이 훅을 가리키지 않는다는 점이다 (mockData 로 대체).

### 3.5 MCP 도구 계약

`packages/mcp/src/tools/resource.ts:26-206` 이 MCP 를 통한 resource 생성/편집 도구를 노출한다. `generateSchemaFileContent` (`resource.ts:262-300`) 이 schema 파일 재작성까지 한다 — 즉 4c 에서 schema 에 `persistence` 키를 추가하려면 MCP 쪽 직렬화도 같이 업데이트 해야 한다.

### 3.6 Slot preservation 테스트

`resource/__tests__/generator.test.ts:102-143` 이 "slot 수정 후 재생성 시 사용자 변경이 유지됨" 을 검증한다. 4c 가 이 계약을 건드리지 않았음을 증명하는 테스트가 반드시 통과해야 한다.

## 4. Design Decisions

### D1 — Generator extension vs adapter injection

**질문**: `generator.ts` 가 새 파일 (`*.repo.ts`) 을 emit 해서 CRUD 를 생성할 것인가, 아니면 emit 된 slot 이 런타임에 `ctx.deps.db` 를 소비하게만 할 것인가?

**옵션 A — 런타임 DI only**: slot 템플릿만 수정해서 TODO 주석 자리를 `const items = await ctx.deps.db.query<User>(\`SELECT ...\`)` 로 채운다. 새 파일 없음.

**옵션 B — Repository 아티팩트 생성**: `generator.ts` 가 다섯 번째 아티팩트 `*.repo.ts` 를 `.mandu/generated/server/repos/{name}.repo.ts` 에 찍는다. 이 파일은 derived (매 회 regenerate) — `findAll`, `findById`, `create`, `update`, `delete` 함수 5 개를 export 하고, 내부에서 `Db` 인스턴스를 argument 로 받는다. Slot 은 이 함수를 호출한다.

**옵션 C — 하이브리드**: repo 는 생성하되, slot 은 repo 를 **경유하지 않고 직접 `ctx.deps.db` 를 써도 된다**. Repo 는 선택적 helper.

**권고: B 하이브리드 (옵션 C 축소판)**. 추론:

1. **관심사 분리**. SQL 이 slot 에 직접 박히면 `ctx.input(contract, ...)` 검증과 DB query 가 한 핸들러에 뒤섞인다. Repo 층이 separate-compiled TypeScript 파일이면 user 가 복잡한 slot 에서 단순 CRUD 만 호출하도록 유도할 수 있다.
2. **Typing 이 깔끔**. Repo 는 `Promise<User[]>` 를 돌려주고, slot 은 contract 의 `z.infer<typeof UserSchema>` 와 맞춰 type narrowing 을 한다. A 방식은 raw `Promise<unknown>` 에서 시작해 user 가 매번 assertion 을 쓰게 한다.
3. **Test 가 단위화**. Repo 는 `Db` 만 주입해 테스트할 수 있다. Slot 테스트는 contract validation 만 보면 된다.
4. **Override escape hatch**. User 가 JOIN 이나 CTE 등 복잡한 쿼리가 필요하면 — C 원칙대로 — 생성된 repo 를 무시하고 slot 에서 `ctx.deps.db.query(...)` 를 직접 호출할 수 있다. Repo 는 **contract + 70% 케이스** 를 해결하는 scaffolding 이지 ORM 의 DSL 이 아니다.

**Downside 인정**: 다섯 번째 아티팩트로 `.mandu/generated/server/repos/` 디렉토리가 생긴다. 유저가 "왜 이런 파일이 또 있지?" 라는 질문을 할 수 있다. 문서로 해소한다 — "repo = slot 이 호출하는 CRUD 함수 번들, 재생성됨".

### D2 — Typed query results

**질문**: Repo 가 `Promise<User[]>` 를 돌려줄 때 `User` 타입을 어디서 얻는가?

**옵션 A**: contract.ts 가 이미 export 하는 zod schema 에서 `z.infer<typeof UserSchema>` 로 파생.
**옵션 B**: `types.ts` generator 에 `UserRow` 인터페이스를 추가로 emit.
**옵션 C**: Bun.sql 의 query builder 타입 추론에 의존 (template-literal return).

**권고: A, 단 types.ts 가 재-export**. `contract.ts` 의 `UserSchema` 는 **request/response shape** 이다. DB row 와 일반적으로 동일하지만 항상은 아니다 (DB 는 `created_at: Date`, API 는 `createdAt: string`). 따라서:

1. `contract.ts` 가 `UserSchema`/`UserCreateSchema`/`UserUpdateSchema` 를 export (today 대로, `contract.ts:77-93`).
2. `types.ts` 가 `export type User = z.infer<typeof UserSchema>` 를 추가로 포함. 오늘 `types.ts` 는 `InferBody` 등만 뽑고 row type 은 없음 (`types.ts:22-68`). 이 부분을 **추가**.
3. Repo 는 `import type { User } from "../types/user.types"` 로 받아 `Promise<User[]>` 반환.

DB-specific field translation (snake_case ↔ camelCase, Date ↔ string) 은 **Phase 4c 범위 아님** — 유저는 현재 자기 필드 이름을 DB 컬럼명과 일치시킨다고 가정. §9 Out of Scope 로 명기.

**Downside**: snake_case DB 와 camelCase 앱을 쓰는 사용자는 매핑을 직접 쓴다. 향후 RFC 0002 에서 `fieldMapping` 옵션으로 해결 가능.

### D3 — Schema source of truth

**질문**: SQL DDL (CREATE TABLE ...) 을 (a) resource 정의에서 자동 파생할 것인가, (b) 별도 `*.sql` 파일을 유저가 쓰게 할 것인가, (c) 외부 migration tool 을 요구할 것인가?

**권고: (a) resource → DDL 자동 파생**. 단, 단방향. Schema 는 resource 가 진실의 원천.

파생 규칙:
- `id: { type: "uuid", required: true }` → `id UUID PRIMARY KEY`
- `email: { type: "email", required: true }` → `email TEXT NOT NULL` (+ UNIQUE 는 D5 의 옵트인 옵션)
- `createdAt: { type: "date", required: true }` → `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` (Postgres) / `created_at TEXT NOT NULL DEFAULT (datetime('now'))` (SQLite)
- Provider 별 dialect 분기는 `generator.ts` 가 `persistence.provider` 를 읽어 분기 (4a 의 `createDb({provider})` 와 align).

DDL 은 `.mandu/generated/server/schema/{name}.sql` 에 추가 아티팩트로 찍힌다. **slot 과 달리 derived** — 매 회 regenerate. 유저 편집 금지.

**Downside 인정**: 복잡한 인덱스, partial index, composite unique constraint 는 표현 못 함. 이 경우 유저는 **추가** migration 을 작성 (`spec/db/migrations/0002_add_users_email_idx.sql` 수동). Resource 정의는 "기본 뼈대", migration 은 "누적 차이" — 두 개가 공존한다.

### D4 — Migration tooling

**질문**: `phases-4-plus.md §D4-B` 에 (a) 자체 rolling, (b) drizzle-kit, (c) 수동 중 선택 요청.

**권고: (a) 자체 rolling, 최소 구현**. 이유:

1. **Mandu 의 zero-deps 철학**. `phases-4-plus.md:301` 이 이미 "자체 구현 (Mandu 'zero-deps' 철학 유지)" 를 추천. RFC 는 이를 재확인.
2. **구현량이 작다**. `spec/db/migrations/0001_init.sql`, `0002_add_xxx.sql` 파일을 lex-sorted 로 읽어 이미 적용된 `__mandu_migrations` 테이블 (versiontext, applied_at timestamp) 과 diff 하고 누락된 것만 `Bun.sql.transaction` 안에서 실행. 핵심 로직 ~150 lines.
3. **drizzle-kit 통합 비용이 크다**. Peer dep 추가, drizzle schema DSL 을 resource 정의와 동기화하는 이중 진실 문제, drizzle 업스트림 breakage 리스크.
4. **Resource → DDL 자동 파생 (D3) 과 깔끔하게 맞물림**. 유저가 resource 에 필드 추가 → `mandu db plan` 이 diff 해 `0002_add_xxx.sql` 템플릿을 찍어줌 → 유저가 내용 검토 → `mandu db apply`.

**Migration runner 의 기본 흐름**:

```
mandu db plan           # 현재 DB 상태 → resource 정의 diff → 새 migration 파일 generate (stub)
mandu db apply          # pending migrations 순서대로 tx 안에서 실행
mandu db status         # applied / pending 리스트
```

Rollback 은 v0.1 에서 **지원하지 않음** — 복잡도 대비 가치 낮음. 유저가 직접 `0003_rollback_foo.sql` 을 쓸 수 있음. §9 Out of Scope.

**Downside 인정**:
1. `mandu db plan` 의 diff 엔진이 단순한 "새 필드 → ADD COLUMN" 정도만 처리한다. DROP COLUMN, RENAME, type change 는 자동 생성 못 하고 stub comment 를 찍고 유저에게 넘긴다. Drizzle-kit 수준의 diff 는 아님.
2. 유저가 SQL 지식이 필요하다. 대신 **Mandu 내부에서 SQL 을 숨기지 않는 건 철학과 일치** (contract 가 Zod 를 숨기지 않는 것과 동일).

### D5 — Backward compatibility

**질문**: 기존 resource 정의는 persistence 가 없다. 어떻게 옵트인하는가?

**옵션 A**: resource 정의에 optional `persistence` 필드 추가.
**옵션 B**: 별도 `*.db.resource.ts` 파일 변형.
**옵션 C**: resource 별 sidecar `*.resource.db.ts`.

**권고: A. `ResourceDefinition` 에 optional `persistence` 필드 추가**.

```ts
// packages/core/src/resource/schema.ts 확장
export interface ResourceDefinition {
  name: string;
  fields: Record<string, ResourceField>;
  options?: ResourceOptions;
  persistence?: ResourcePersistence;   // NEW — optional
}

export interface ResourcePersistence {
  provider: "sqlite" | "postgres" | "mysql";
  table?: string;                      // default: pluralized name (snake_case)
  primaryKey?: string;                 // default: "id"
  timestamps?: boolean;                // auto-add created_at/updated_at (default: true)
  indexes?: ResourceIndex[];
  unique?: string[][];                 // composite unique
}

export interface ResourceIndex {
  name?: string;
  fields: string[];
  type?: "btree" | "hash" | "gin";
  where?: string;                      // partial index predicate
}
```

**Behavior**:
- `persistence === undefined` → 오늘과 **완전히 동일**. repo/schema 아티팩트 생성 안 함. Slot 도 오늘의 TODO 주석 형태 유지.
- `persistence` 존재 → `*.repo.ts`, `*.sql` 추가 생성. Slot 은 새 템플릿 (repo 호출).

Downside A vs B/C:
- A 는 기존 `parser.ts` / `generator.ts` 분기 로직이 많아진다. 그러나 `generateResourceArtifacts` 가 이미 `only` option 으로 분기하고 있어 (`generator.ts:99-115`) 동일한 패턴 확장 비용 낮음.
- B 는 "두 종류의 resource 파일" 이라는 개념 부하. 유저가 어느 쪽 파일을 언제 쓰는지 결정해야 함.
- C 는 sidecar 이름 규칙이 `*.resource.db.ts` — ugly 하고 `parser.ts:44` 의 파일명 정규식과 충돌.

기존 사용자 영향: **0**. 기존 `note.resource.ts` (`demo/todo-app/spec/resources/note/note.resource.ts`) 는 `persistence` 필드가 없으므로 regenerate 해도 새 파일 추가 없음.

### D6 — Transaction semantics

**질문**: Handler 가 자동으로 tx 안에서 실행되는가, 유저가 명시적 `.transaction(...)` 을 불러야 하는가?

**권고: 명시적 `ctx.deps.db.transaction(...)`**. Handler 기본값은 **tx 없음**.

이유:
1. **Predictable failure modes**. 암묵적 tx 는 handler 가 200 을 반환했지만 response 생성 중 throw 시 rollback 범위가 모호하다. Side effect (email 발송, SSE push 등) 와 엉킬 때 복잡.
2. **GET handler 는 tx 필요 없음**. 85% 의 read endpoint 는 single query. 강제 tx 는 오버헤드.
3. **이미 Mandu 가 이 방향을 암시**. `filling/deps.ts:22` 가 `transaction: <T>(fn: () => Promise<T>) => Promise<T>` 를 **explicit 함수** 로 선언했지 `filling()` decorator option 이 아니다.

**Pattern**:
```ts
// create handler (POST) — 자동 tx 안에서 emit
.post(async (ctx) => {
  const input = await ctx.input(contract, "POST");
  return ctx.deps.db.transaction(async (tx) => {
    const row = await userRepo.create(tx, input);
    return ctx.output(contract, 201, { data: row });
  });
})
```

단, **생성된 slot template** 은 mutating endpoint (POST/PUT/PATCH/DELETE) 에 대해 기본적으로 `.transaction()` wrapper 를 emit 한다. 사용자가 보면 바로 "어떻게 쓰는지" 를 학습한다. Read endpoint (GET list/get) 는 tx 없이 직접 호출.

**Downside**: 사용자가 mutation handler 에서 tx wrapper 를 지우면 부분 실패 가능. 그러나 이는 **명시적 선택** 이라 추적 가능 — 암묵적 tx 실패보다 선호.

### D7 — Multi-tenant safety

**질문**: Slot / repo 가 `Db` 인스턴스를 어떻게 얻는가?

**옵션 A — 모듈 레벨 싱글톤**: `import { db } from "~/db"` — 앱 어디서든 같은 인스턴스.
**옵션 B — 요청 스코프 DI**: `ctx.deps.db` — 요청당 다른 인스턴스 가능 (예: tenant 별 connection).
**옵션 C — 둘 다**.

**권고: B 를 공식 경로, A 는 escape hatch**.

이유:
1. **`filling/deps.ts:85` 가 이미 B 를 채택**. `FillingDeps.db` 가 `ctx.deps.db` 에서 읽힌다. 4c 는 이 훅을 그대로 쓰는 것이 자연스럽다. 새 기반을 만드는 게 아니라 기존 것을 **채우기만** 한다.
2. **Multi-tenant 앱이 zero-refactor**. Tenant 별 DB URL 이 필요하면 middleware 가 `ctx.deps.db` 를 request 시점에 교체 (provider 패턴). Singleton 이었다면 전체 앱 재구조화 필요.
3. **Test 가 깔끔**. `createMockDeps({ db: mockDb })` (`filling/deps.ts:160-192`) 가 이미 동작. Singleton 은 module 캐시 mock 이라는 안티패턴을 유발.

**구현**:
- `@mandujs/core/db` 의 `createDb(...)` 가 반환하는 객체는 `FillingDeps["db"]` 와 **구조적 호환**. 즉 `query(sql, params)` / `transaction(fn)` 시그니처를 만족. 4a API 설계 시 이 호환을 요구사항으로 박는다 (§12 open question 아님 — 요구사항).
- `startServer` 에 `db` 를 전달하면 `globalDeps.set({ db })` 를 내부적으로 호출. 유저가 안 넘기면 `ctx.deps.db === undefined` 이고 생성된 repo 는 `"Db not injected — pass db to startServer(...)"` 에러 throw.

**Escape hatch (옵션 A)**: `@mandujs/core/db` 에서 `export { db as defaultDb }` 로 모듈 싱글톤도 노출. Simple apps 에서 middleware 없이 즉시 import. 단, repo 는 항상 `ctx.deps.db` 를 우선 조회하고 없으면 `defaultDb` 로 fallback. 이 fallback 은 **debug mode 경고** 를 띄움 — multi-tenant 가 될 앱에서 silent singleton 캐시가 발생하지 않도록.

**Downside**: 두 경로가 공존해 "나는 어느 쪽을 쓰는가" 혼란 가능. 문서에서 "singleton 은 스크립트/job 전용, request handler 는 `ctx.deps.db`" 가이드.

## 5. Proposed API — Code Sketch

### 5.1 User authored resource with persistence

```ts
// spec/resources/users/users.resource.ts
import { defineResource } from "@mandujs/core";

export default defineResource({
  name: "user",
  fields: {
    id: { type: "uuid", required: true },
    email: { type: "email", required: true },
    name: { type: "string", required: true },
    role: { type: "string", default: "user" },
    createdAt: { type: "date", required: true },
    updatedAt: { type: "date", required: true },
  },
  options: {
    description: "User management API",
    tags: ["users"],
  },
  // NEW — opt-in. 생략하면 오늘과 동일 (persistence 없음).
  persistence: {
    provider: "postgres",
    table: "users",
    primaryKey: "id",
    timestamps: true,
    unique: [["email"]],
    indexes: [{ fields: ["role"] }],
  },
});
```

### 5.2 Files emitted by `generator.ts`

| Path | New? | Derived/user? | Contents |
|---|---|---|---|
| `.mandu/generated/server/contracts/user.contract.ts` | existing | derived | 오늘과 동일 |
| `.mandu/generated/server/types/user.types.ts` | existing | derived | + `export type User = z.infer<typeof UserSchema>` 추가 (D2) |
| `.mandu/generated/server/repos/user.repo.ts` | **NEW** | derived | CRUD 함수 5 개 |
| `.mandu/generated/server/schema/user.sql` | **NEW** | derived | CREATE TABLE DDL |
| `.mandu/generated/client/user.client.ts` | existing | derived | 오늘과 동일 |
| `spec/slots/user.slot.ts` | existing | **user-editable** | 템플릿이 repo 호출 버전으로 업데이트 (처음 생성 시만) |
| `spec/db/migrations/0001_create_users.sql` | **NEW** | user-editable | `mandu db plan` 이 초안 생성, 유저가 검토 |

### 5.3 Generated repo (excerpt)

```ts
// .mandu/generated/server/repos/user.repo.ts — DO NOT EDIT
import type { Db, DbTransaction } from "@mandujs/core/db";
import type { User } from "../types/user.types";
import type { UserPostBody, UserPutBody } from "../types/user.types";

export const userRepo = {
  async findAll(db: Db | DbTransaction, params: { limit: number; offset: number }): Promise<{ rows: User[]; total: number }> {
    const rows = await db<User[]>`SELECT * FROM users ORDER BY created_at DESC LIMIT ${params.limit} OFFSET ${params.offset}`;
    const [{ count }] = await db<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM users`;
    return { rows, total: count };
  },
  async findById(db: Db | DbTransaction, id: string): Promise<User | null> {
    const [row] = await db<User[]>`SELECT * FROM users WHERE id = ${id} LIMIT 1`;
    return row ?? null;
  },
  async create(db: Db | DbTransaction, input: UserPostBody): Promise<User> {
    const [row] = await db<User[]>`
      INSERT INTO users (id, email, name, role, created_at, updated_at)
      VALUES (${crypto.randomUUID()}, ${input.email}, ${input.name}, ${input.role}, NOW(), NOW())
      RETURNING *
    `;
    return row;
  },
  async update(db: Db | DbTransaction, id: string, input: UserPutBody): Promise<User | null> {
    // sparse update — Object.entries(input).filter(defined) 로 SET 구절 동적 조립
    // (full implementation omitted)
    return null as unknown as User;
  },
  async remove(db: Db | DbTransaction, id: string): Promise<boolean> {
    const result = await db`DELETE FROM users WHERE id = ${id}`;
    return result.count > 0;
  },
};
```

### 5.4 New slot template (first generation only)

```ts
// spec/slots/user.slot.ts — 처음 생성 후 --force 없이는 preserve
import { Mandu } from "@mandujs/core";
import contract from "../contracts/user.contract";
import { userRepo } from "../repos/user.repo";

export default Mandu.filling()
  .get(async (ctx) => {
    const input = await ctx.input(contract, "GET");
    if (!ctx.deps.db) throw new Error("Db not injected");
    const offset = (input.page - 1) * input.limit;
    const { rows, total } = await userRepo.findAll(ctx.deps.db, { limit: input.limit, offset });
    return ctx.output(contract, 200, { data: rows, pagination: { page: input.page, limit: input.limit, total } });
  })
  .post(async (ctx) => {
    const input = await ctx.input(contract, "POST");
    if (!ctx.deps.db) throw new Error("Db not injected");
    return ctx.deps.db.transaction(async (tx) => {
      const row = await userRepo.create(tx, input);
      return ctx.output(contract, 201, { data: row });
    });
  })
  // ... get/put/delete 유사
```

### 5.5 Generated DDL and migration seed

```sql
-- .mandu/generated/server/schema/user.sql (derived, regenerated)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);
CREATE INDEX IF NOT EXISTS users_role_idx ON users (role);

-- spec/db/migrations/0001_create_users.sql (user-editable; `mandu db plan` seeds this)
-- edit before `mandu db apply`. Migration runner wraps in transaction.
CREATE TABLE users ( ... );  -- copied from user.sql, user can customize
```

### 5.6 App wiring

```ts
// src/server.ts
import { startServer, globalDeps } from "@mandujs/core";
import { createDb } from "@mandujs/core/db";
import manifest from "./.mandu/routes.manifest.json" with { type: "json" };

const db = createDb({ provider: "postgres", url: process.env.DATABASE_URL! });
globalDeps.set({ db });   // `ctx.deps.db` available in every handler

startServer(manifest, { port: 3333 });
```

## 6. Migration Path for Existing Users

대상: v0.24.0 (4c 도입) 이전에 resource 를 썼던 앱. 즉 현재 레포의 `demo/todo-app/spec/resources/note/note.resource.ts` 와 외부 사용자.

### 6.1 Zero-config path (default)

기존 resource 정의에 `persistence` 필드가 없으면 **아무 변경도 일어나지 않는다**. `mandu generate` 재실행 시 repo/schema/migration 파일 생성되지 않음. 기존 slot 도 preserve (generator.ts:181-192 계약).

### 6.2 Opt-in 단계

```
Step 1: spec/resources/{name}.resource.ts 에 persistence 필드 추가
Step 2: mandu db plan
   → spec/db/migrations/0001_create_{name}.sql 생성 (초안)
   → 유저가 내용 검토
Step 3: mandu generate
   → .mandu/generated/server/repos/{name}.repo.ts 생성
   → spec/slots/{name}.slot.ts 는 이미 존재하면 preserve (!!)
Step 4: mandu db apply (dev DB 에 migration 적용)
Step 5: 기존 slot 을 수동으로 repo 호출 버전으로 업데이트 (또는 --force 로 regenerate)
```

**중요: Step 3 에서 slot 이 preserve 된다.** 즉 기존 slot 의 TODO 주석은 그대로 남는다. 유저는 명시적으로 `mandu generate --force --only=slot -r {name}` 을 돌려야 새 템플릿을 얻는다. 이 명시적 선택은 **기존 slot 변경을 절대 자동으로 덮지 않는다** 는 계약의 연장.

### 6.3 Codemod 제공

`@mandujs/cli` 에 `mandu migrate 0.24` 명령 추가:
- 모든 `spec/resources/*.resource.ts` 스캔
- 각 resource 에 **주석으로** `persistence` 옵션 예시를 삽입 (commented out). 실제 활성화는 유저가 수동.
- 기존 slot 은 건드리지 않음.

### 6.4 Deprecation window

| 버전 | 상태 | 조치 |
|---|---|---|
| 0.24.0 | `persistence` 옵트인 도입 | 기존 앱 무영향 |
| 0.25.0 ~ 0.29.x | 안정화 기간 | bug fix 만, API 변경 없음 |
| 1.0.0 | stability 선언 | `persistence` 공식화, 이후 minor 에서 breaking change 불가 |

즉 `phases-4-plus.md:109` 의 "deprecation cycle 2 minor" 는 이 경우 **기존 API 를 deprecate 하지 않기 때문에 해당 없음**. 새 필드가 추가될 뿐이다. 향후 1.0 에서 persistence API 자체를 수정하려면 다시 deprecation cycle.

## 7. Alternatives Considered

### 7.1 "Why not Drizzle / Prisma / Kysely as primary ORM?"

Drizzle 이 가장 경합 후보였다. Schema DSL 이 좋고, migration (drizzle-kit) 이 성숙하다. 그러나:

1. **이중 진실 문제**. Mandu resource 정의에 fields 가 있고, drizzle schema 에 다시 fields 를 선언해야 한다. 두 개를 sync 하는 codegen 이 필요 — 결국 drizzle schema 를 resource 에서 generate 하게 되는데, 그 순간 drizzle 은 "backend 의 ORM" 이 아니라 "generator 의 출력 포맷" 이 된다. 그러면 왜 더 간단한 raw SQL 로 바로 안 가는가.
2. **Peer dep 부담**. `@mandujs/core` 가 drizzle-orm 에 의존하면 patch 업스트림 리스크. Prisma 는 더 심하다 (rust binary).
3. **Mandu 의 철학**. Contract 가 Zod 를 얇게 쓰는 패턴이다. DB 에서 Drizzle 같은 두터운 DSL 을 쓰면 "얇은 레이어 + 강한 타이핑" 의 일관성이 깨진다.
4. **Escape hatch 는 유저 쪽**. 사용자가 원하면 `spec/slots/user.slot.ts` 에서 drizzle 을 직접 쓸 수 있다 (Mandu 가 금지하지 않음). Framework default 가 drizzle 일 필요 없다.

Kysely 는 더 가볍지만 여전히 additional dep + query builder DSL 학습. Raw SQL template literal (Bun.sql) 이 학습 곡선 최저점이며 "SQL 을 숨기지 않는다" 는 교육적 가치가 있다.

### 7.2 "Why not skip code generation and let users hand-write SQL?"

가능한 선택지. Generator 가 slot 만 emit 하고 user 가 전부 직접 SQL 을 쓰면 Mandu 는 "contract + routing only" framework 로 남는다. 거부 이유:

1. **Scaffolding-first 가치 상실**. `mandu.resource.create` MCP tool (`packages/mcp/src/tools/resource.ts:27`) 이 오늘 4 아티팩트를 한 번에 생성해주는 가치 — "5 분 안에 CRUD" — 가 DB 지점에서 무너진다.
2. **타입 단절**. Contract 에 `UserSchema` 가 있고 slot 에서 raw SQL 결과를 받으면 유저가 수동으로 `as User[]` 를 찍어야 한다. 타입이 제공하는 확신이 깨진다.
3. **보일러플레이트 폭발**. 5 endpoint × N resource × "다들 같은 패턴" 코드를 유저가 반복.

대신 **repo 를 escape-hatchable** 하게 만든 것이 절충 (D1 옵션 C 축소판). Simple 케이스는 generator 가 해주고, 복잡 쿼리는 유저가 직접 `ctx.deps.db` 호출. 두 레벨 모두 공존.

## 8. Risks & Mitigations

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Resource API breaking change — `ResourceDefinition` 에 `persistence` 추가 | Low | Optional 필드라 기존 앱 무영향. Type 변경 없으면 runtime breaking 없음 |
| R2 | `Bun.sql` Postgres 성능이 `postgres.js` 대비 느림 | Medium-High | (a) RFC 와 별개로 4a 에 벤치 게이트 추가 (N=10k round-trip latency 비교). (b) `@mandujs/core/db` 인터페이스가 얇아 교체 비용 낮음. 실 구현만 `postgres.js` 로 swap 가능하도록 설계 요구사항을 4a 에 명시 |
| R3 | Production 에서 migration drift — 유저가 `mandu db apply` 를 안 돌리고 deploy | High | (a) `mandu generate` 가 pending migration 감지 시 빌드 fail (`--allow-pending-migrations` 로만 bypass). (b) Runtime startup 에 `__mandu_migrations` 버전 체크. 마지막 `0001_create_users.sql` 의 checksum 과 DB record 불일치 시 startServer() 가 loud warning |
| R4 | Multi-provider dialect 차이 (DATETIME vs TIMESTAMPTZ, SERIAL vs UUID, SQLite 의 제약 많음) | Medium | (a) D3 에서 provider 별 DDL 분기 책임을 generator 가 짊어짐. (b) Lint rule: resource 가 `provider: sqlite` 일 때 쓰면 안 되는 필드 (예: `json` 복잡 쿼리) 가 있으면 warn (향후 RFC). (c) `phases-4-plus.md:111` 의 R4-C 와 같은 맥락 |
| R5 | Slot preservation 계약 파손 — 새 템플릿이 emit 될 때 기존 slot 실수로 덮음 | High (silent data loss) | (a) `generator.ts:181-192` 의 `slotExists` 체크를 **확장** — `*.repo.ts` 역시 같은 패턴 적용 (단, repo 는 derived 이므로 overwrite 가 의도됨). Slot 은 건드리지 않음을 integration test 로 재차 검증 (신규 테스트 케이스 추가 제안) |
| R6 | MCP 도구 (`packages/mcp/src/tools/resource.ts:262`) 의 `generateSchemaFileContent` 가 `persistence` 필드를 직렬화 못 해서 `addField` 이후 파일이 깨짐 | Medium | 4c.2 에 MCP serialization 업데이트 포함. Test: resource 에 persistence 있는 상태로 addField 호출 → persistence 가 유지되어야 함 |

가장 중대한 것은 **R3 (migration drift)** 과 **R5 (slot data loss)**. R5 는 기존 generator 계약의 연장선에서 해결 가능. R3 는 운영 리스크라 **빌드 게이트 + 런타임 checksum** 두 방어선 필요.

## 9. Out of Scope

이 RFC 에서 다루지 않는 것 (추후 RFC 대상):

- **ORM / query builder**. Drizzle/Kysely 와 같은 DSL. Raw SQL template literal 만 지원.
- **Schema diffing 자동 migration**. `mandu db plan` 은 "새 resource → CREATE TABLE stub" 정도. ALTER TABLE RENAME / DROP COLUMN / CHECK CONSTRAINT CHANGE 등은 유저가 수동 SQL 작성.
- **Introspection** (기존 DB → resource 정의 역생성). Green-field 앱 타겟.
- **Field name translation** (snake_case DB ↔ camelCase app). D2 에서 언급.
- **Rollback / down migrations**. Forward-only.
- **GUI / dashboard** for DB inspection. `kitchen` UI 에 붙이는 건 Phase 8.
- **Seed data management**. `spec/db/seeds/` 같은 것 별도 RFC.
- **Connection pool 튜닝 UX**. 4a `createDb({ pool })` 에서 처리.
- **Read replica routing**. Multi-DB 토폴로지.
- **Cross-resource join helper** — repo 는 단일 table 대상. JOIN 이 필요하면 slot 에서 직접 SQL.

## 10. Implementation Plan (Phase 4c breakdown)

총 2 주 (phases-4-plus.md §2 의 범위). 단일 PR 로는 크므로 5 개 서브-phase 로 분할.

### 4c.1 — Schema & DDL generation (3 일)

- `resource/schema.ts` 에 `persistence` / `ResourcePersistence` / `ResourceIndex` 타입 추가
- `resource/generators/ddl.ts` 신규 — `generateResourceDDL(definition): string`. Provider 별 dialect 분기
- `resolveGeneratedPaths` (`paths.ts:29`) 에 `resourceSchemasDir: ".mandu/generated/server/schema"` 추가
- `generator.ts` 의 `generateResourceArtifacts` 에 5번째 단계 (`generateSchema`) 추가
- Unit tests: DDL generation 3 provider × 기본/인덱스/유니크 조합 ≥ 12 케이스

### 4c.2 — Repo code generation (3 일)

- `resource/generators/repo.ts` 신규 — `generateResourceRepo(definition): string`
- `generator.ts` 에 `generateRepo` 단계 추가. **derived** (매 회 overwrite)
- `generators/types.ts:22-68` 확장: `export type {Pascal}Row = z.infer<typeof {Pascal}Schema>` 추가
- `packages/mcp/src/tools/resource.ts:262` 의 `generateSchemaFileContent` 가 `persistence` 직렬화하도록 업데이트
- Unit tests: repo 메서드 5 개 × 3 provider fixture

### 4c.3 — Migration runner (3 일)

- `packages/core/src/db/migrations/` 모듈 신규
  - `planMigrations(resources, currentDbState): PendingMigration[]`
  - `applyMigrations(db, migrations): ApplyResult` (tx-wrapped, `__mandu_migrations` 관리)
  - `statusMigrations(db): MigrationStatus`
- `packages/cli/src/commands/db.ts` 신규 — `mandu db plan | apply | status`
- 도커 fixture (4c validation engineer 담당) 와 E2E: Postgres + SQLite 각각 fresh → 2 migrations apply → rollforward 일관성

### 4c.4 — DI wiring & slot template update (2 일)

- `filling/deps.ts:13-23` 의 `DbDeps` 를 `@mandujs/core/db` 의 `Db` 타입과 **structural compatible** 로 정렬 (4a 와 계약). 필요 시 4a PR 에 이 compatibility test 추가 요청
- `generators/slot.ts` 의 handler template: `persistence` 있을 때 repo 호출 버전, 없을 때 today 의 TODO 주석 버전으로 분기
- `startServer` 가 `db` 옵션을 받아 `globalDeps.set({ db })` 호출하는 shortcut
- `generator.ts:181-192` slot preservation regression tests 확장

### 4c.5 — Demo migration & docs (2 일)

- `demo/todo-app` 에 persistence 추가하여 E2E 검증 (SQLite 타겟)
- `docs/db/` 가이드: quickstart + 마이그레이션 플로우 + migration troubleshooting
- `CHANGELOG` entry via `bun changeset`
- MCP tool description 갱신 (`tools/resource.ts:32`)

**Total: 13 days.** Phase 4c 2 주 스케줄 안에 맞음. 4c.3 의 migration runner 는 4c.1/2 와 병렬 개발 가능.

## 11. Open Questions

이 항목은 구현 착수 전 **팀 input** 이 필요한 것만. RFC 의 목적은 대부분 닫는 것.

1. **Q1 — `__mandu_migrations` table 구조**. 최소 (`version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ, checksum TEXT`) 로 충분한지, 아니면 migration 스크립트의 full body 를 저장해 drift 감사까지 할 것인지. **추천: 최소 + checksum**. 결정권자: Bun expert (4a DB API 설계자와 함께).
2. **Q2 — `created_at` 기본값의 진실의 원천**. DB `DEFAULT NOW()` vs app-layer `new Date()` insertion. 분산 환경 / clock drift 고려. **추천: DB 기본값** (DB 가 단일 시계). Provider (SQLite 는 `datetime('now')`) 별 문법 차이만 주의.
3. **Q3 — Slot template 의 error 응답 정책**. repo 가 `null` (not found) 을 반환할 때 `ctx.output(contract, 404, ...)` 를 자동으로 emit 하는가, 유저가 직접 분기하는가. **추천: 자동 emit** — 404 는 결정적.

세 개 모두 구현 중 해결 가능하지만 Bun expert (4a) 와 맞춰야 할 부분은 Q1.

---

## Appendix A — Summary of recommendations

| Decision | Choice |
|---|---|
| D1 Generator extension vs adapter | B — emit `*.repo.ts` + repo is optional helper; slot can bypass |
| D2 Typed query results | A + `types.ts` emits `Row` alias from zod schema |
| D3 Schema source of truth | Resource → DDL auto-derived, one-way, dialect-aware |
| D4 Migration tooling | Self-rolled minimal runner (`mandu db plan/apply/status`), no rollback in v0.1 |
| D5 Backward compatibility | Add optional `persistence` field to `ResourceDefinition` |
| D6 Transaction semantics | Explicit `ctx.deps.db.transaction(...)`, generated slot wraps mutations by default |
| D7 Multi-tenant safety | `ctx.deps.db` (request-scoped DI) primary, module singleton as escape hatch |

## Appendix B — Test plan for slot preservation (R5 mitigation)

R5 (silent data loss through slot overwrite) is the highest-impact risk because loss is unrecoverable. The test plan below extends `resource/__tests__/generator.test.ts:102-143`:

| Test case | Setup | Assertion |
|---|---|---|
| TC-1 | Existing slot with custom code, resource has no `persistence` | `generateResourceArtifacts` runs → slot untouched, no repo/schema emitted |
| TC-2 | Existing slot with custom code, resource gets `persistence` added for the first time | `generateResourceArtifacts` runs → slot **still preserved**, repo + schema emitted |
| TC-3 | Existing slot with custom code, run with `force: true, only: ["slot"]` | Slot overwritten with new template (repo-using version) |
| TC-4 | Existing slot, resource `persistence` changed (e.g. add index) | Slot preserved, schema re-emitted (derived), repo re-emitted (derived). DDL diff visible in `mandu db plan` |
| TC-5 | Empty project, first run with `persistence` | All 6 artifacts emitted in one pass, `__mandu_migrations` row present after `mandu db apply` |
| TC-6 | Existing slot with user's `ctx.deps.db.query(...)` direct usage, regenerate | Slot preserved; user code keeps working alongside generated repo |

모든 case 에서 **slot 파일 modification time** 을 before/after 비교해 변경 여부를 byte-for-byte 확인. 재생성 후 `mtime` 이 바뀌면 fail.

## Appendix C — API contract for @mandujs/core/db (Phase 4a ↔ 4c handshake)

Q1 / D7 을 닫기 위해 `@mandujs/core/db` 가 **반드시** 충족해야 할 구조적 인터페이스:

```ts
// 4a must export types satisfying this shape
export interface Db {
  // Tagged template — primary query method
  <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  // Transaction — callback receives a DbTransaction (same Tagged-template shape)
  transaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export interface DbTransaction {
  <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}
```

This is structurally compatible with `filling/deps.ts:13-23` `DbDeps.query/transaction` **but not identical**. Phase 4c.4 requires one of:

- **Option X (preferred)**: 4a exports `Db` that satisfies a **looser** `DbDeps`-compatible type; `filling/deps.ts` 의 `DbDeps` 를 deprecate 하고 `Db` 를 직접 import.
- **Option Y**: `filling/deps.ts` 가 adapter 함수를 제공해 `Db → DbDeps` 변환.

X 를 추천. `DbDeps` 는 4c 착수 시점에 **유일하게 사용처가 없는 타입** 이었음 (모든 이유가 이 RFC 가 채우려는 공백). Deprecate cost 0.

**Handshake item for Bun expert**: 4a 의 `Db` 가 **template literal 첫 인자를 받을 때 generic `<T>` 반환 타입 추론** 을 허용해야 함. `await db<User[]>\`SELECT * FROM users\`` 구문이 repo.ts 생성 코드에서 핵심. `Bun.sql` 기본이 이 형태를 지원하므로 wrapper 가 이 타입 파라미터를 보존하면 됨.

## Appendix D — Files that will change in Phase 4c

Evidence-based listing (전부 file:line 으로 citation).

- `packages/core/src/resource/schema.ts:80-87` — `ResourceDefinition` 확장
- `packages/core/src/resource/generator.ts:81-127` — 5th generator step
- `packages/core/src/resource/generators/types.ts:22` — add Row type export
- `packages/core/src/resource/generators/slot.ts:82-183` — template 분기
- `packages/core/src/resource/generators/repo.ts` — NEW
- `packages/core/src/resource/generators/ddl.ts` — NEW
- `packages/core/src/paths.ts:29-42` — add `resourceSchemasDir` / `resourceReposDir`
- `packages/core/src/filling/deps.ts:13-23` — align `DbDeps` with `@mandujs/core/db` `Db` type
- `packages/core/src/db/migrations/` — NEW (4c.3)
- `packages/cli/src/commands/db.ts` — NEW
- `packages/mcp/src/tools/resource.ts:262-300` — serialize `persistence`
- `packages/core/package.json` — add `"./db": "./src/db/index.ts"` export (if 4a hasn't yet)
- `packages/core/src/resource/__tests__/generator.test.ts:102-143` — extend preservation tests

---

---

## Appendix D — Post-hoc addenda from Phase 4a implementation (2026-04-18)

The Bun expert building `@mandujs/core/db` surfaced 5 concrete realities that
this RFC must absorb before Phase 4c implementation starts:

### D.1 Dialect divergence is load-bearing

- `RETURNING *` is Postgres + SQLite ≥3.35 only. MySQL needs a separate
  `SELECT` after `INSERT` + `LAST_INSERT_ID()`.
- JSON column syntax differs across all three.
- **Decision for 4c**: v1 uses lowest-common-denominator CRUD
  (`INSERT` + `SELECT WHERE id = LAST_INSERT_ID()` on MySQL,
  `INSERT ... RETURNING *` on PG/SQLite). Provider-specialized generators
  land behind `persistence: { provider, flavor: "specialized" }` opt-in.

### D.2 `db.raw()` escape hatch for metadata

- `Bun.SQL` returns array-like results with extra props
  `{ count, command, lastInsertRowid, affectedRows }`. 4a's wrapper strips
  them for API cleanliness.
- Resource CRUD (`create`, `update`) needs `lastInsertRowid` / `affectedRows`
  to produce typed return values.
- **Decision for 4c**: `@mandujs/core/db` exposes `db.raw(strings, ...values)`
  returning the Bun-native array-like verbatim. Generator uses `raw()` on
  write paths, plain `db(...)` on reads.

### D.3 Transaction scope via AsyncLocalStorage

- `Bun.SQL`'s `tx` is a bound handle. Code paths that close over `db`
  (not `tx`) run **outside** the transaction silently.
- Passing `tx` through every function signature pollutes the API.
- **Decision for 4c**: implicit transaction context via `AsyncLocalStorage`.
  Generated CRUD helpers call `getCurrentDb()` which returns `tx` if inside
  an active transaction or the pool handle otherwise. Users never pass
  `tx` manually.

### D.4 SQLite single-writer + WAL

- SQLite default journal mode serializes writes. Concurrent resource
  operations under load queue with ~1ms pauses.
- **Decision for 4c**: the SQLite session store (Phase 4b) must issue
  `PRAGMA journal_mode = WAL` at connection init. Document this in
  `@mandujs/core/db` so any SQLite user knows to enable WAL explicitly.
  Do NOT auto-enable — some embedded deployments need rollback journals.

### D.5 Resource generator must use `createDb`, never `new Bun.SQL`

- 4a's wrapper contains the only URL→options translator that makes
  object-form Bun.SQL configs work (provider fields vs `url` string).
- Generated resource code must import `createDb` from `@mandujs/core/db`,
  never instantiate `Bun.SQL` directly. This keeps the URL/options story
  in one place.

These 5 items are normative for Phase 4c implementation. Cross-reference
from the implementation PR description.

---

*End of RFC 0001.*
