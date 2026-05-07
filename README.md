<p align="center">
  <img src="https://raw.githubusercontent.com/konamgil/mandu/main/mandu_only_simbol.png" alt="Mandu Logo" width="180" />
</p>

<h1 align="center">Mandu</h1>

<p align="center">
  <strong>Agent-Native Fullstack Framework</strong><br/>
  Architecture that doesn't break even when AI agents write your code
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mandujs/core"><img src="https://img.shields.io/npm/v/@mandujs/core?label=core" alt="npm core" /></a>
  <a href="https://www.npmjs.com/package/@mandujs/cli"><img src="https://img.shields.io/npm/v/@mandujs/cli?label=cli" alt="npm cli" /></a>
  <a href="https://www.npmjs.com/package/@mandujs/mcp"><img src="https://img.shields.io/npm/v/@mandujs/mcp?label=mcp" alt="npm mcp" /></a>
  <a href="https://www.npmjs.com/package/@mandujs/ate"><img src="https://img.shields.io/npm/v/@mandujs/ate?label=ate" alt="npm ate" /></a>
  <a href="https://www.npmjs.com/package/@mandujs/skills"><img src="https://img.shields.io/npm/v/@mandujs/skills?label=skills" alt="npm skills" /></a>
  <img src="https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun" alt="Bun" />
  <img src="https://img.shields.io/badge/language-TypeScript-3178c6?logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/frontend-React-61dafb?logo=react" alt="React" />
  <img src="https://img.shields.io/badge/package%20tests-passing-success" alt="package tests passing" />
  <img src="https://img.shields.io/badge/license-MPL--2.0-blue" alt="license" />
</p>

<p align="center">
  <a href="./README.ko.md">한국어</a> | English
</p>

---

## Product Direction

Mandu is an **Agent-Native Fullstack Framework** for supervised AI development: agents can write code while Mandu keeps architecture, contracts, runtime behavior, and release gates observable and enforceable.

- [Agent-Native Framework Strategy v1](./docs/product/02_agent_native_framework_strategy.md)
- [Agent-Native Framework Launch Plan](./docs/plans/17_agent_native_launch_plan.md)
- [Mandu Agent Workflow](./docs/guides/07_agent_workflow.md)
- [Agent DevTools Plan](./docs/devtools/AGENT_DEVTOOLS_PLAN.md)

## Quick Start

### Install Mandu

Two install paths — pick whichever matches how you plan to use it. Full details in [docs/install.md](./docs/install.md).

**Standalone binary** — no prerequisites, one file:

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/konamgil/mandu/main/install.sh | sh

# Windows (PowerShell)
iwr https://raw.githubusercontent.com/konamgil/mandu/main/install.ps1 -useb | iex
```

**npm / Bun package** — smaller download, requires Bun 1.3.12+:

```bash
bun install -g @mandujs/cli
```

Trade-offs: the binary bundles the Bun runtime (~132 MB, zero prerequisites), the npm package is ~5 MB but needs Bun pre-installed. Both expose the same `mandu` command.

```bash
# Verify either install
mandu --version
```

### 1. Create a New Project

```bash
mandu init my-app        # if you installed the binary or `bun install -g @mandujs/cli`
# or
bunx @mandujs/cli init my-app    # zero-install alternative
cd my-app
bun install
```

Realtime chat starter template:

```bash
bunx @mandujs/cli init my-chat-app --template realtime-chat
```

### 2. Start Development Server

```bash
bun run dev
```

The generated app maps `bun run dev` to `mandu dev`.

Your app is now running at `http://localhost:3333`

### 3. Create Your First Page

Create `app/page.tsx`:

```tsx
export default function Home() {
  return (
    <div>
      <h1>Welcome to Mandu!</h1>
      <p>Edit this file and see changes instantly.</p>
    </div>
  );
}
```

### 4. Add an API Route

Create `app/api/hello/route.ts`:

```typescript
export function GET() {
  return Response.json({ message: "Hello from Mandu!" });
}
```

Now visit `http://localhost:3333/api/hello`

### 5. Build for Production

```bash
bun run build
```

That's it! You're ready to build with Mandu.

---

## Beginner's Guide

If you're new to Mandu, this section will help you understand the basics.

### Project Structure After Init

```
my-app/
├── app/                    # Your code goes here (FS Routes)
│   ├── page.tsx           # Home page (/)
│   └── api/
│       └── health/
│           └── route.ts   # Health check API (/api/health)
├── src/                    # Architecture layers
│   ├── client/             # Client (FSD)
│   ├── server/             # Server (Clean)
│   └── shared/             # Universal shared
│       ├── contracts/      # Client-safe contracts
│       ├── types/
│       ├── utils/
│       │   ├── client/     # Client-safe utils
│       │   └── server/     # Server-only utils
│       ├── schema/         # Server-only schema
│       └── env/            # Server-only env
├── spec/
│   └── routes.manifest.json  # Route definitions (auto-managed)
├── .mandu/                 # Build output (auto-generated)
├── package.json
└── tsconfig.json
```

### File Naming Conventions

| File Name | Purpose | URL |
|-----------|---------|-----|
| `app/page.tsx` | Home page | `/` |
| `app/about/page.tsx` | About page | `/about` |
| `app/users/[id]/page.tsx` | Dynamic user page | `/users/123` |
| `app/api/users/route.ts` | Users API | `/api/users` |
| `app/layout.tsx` | Shared layout | Wraps all pages |

### Common Tasks

#### Add a New Page

Create `app/about/page.tsx`:

```tsx
export default function About() {
  return (
    <div>
      <h1>About Us</h1>
      <p>Welcome to our site!</p>
    </div>
  );
}
```

Visit `http://localhost:3333/about`

#### Add a Dynamic Route

Create `app/users/[id]/page.tsx`:

```tsx
export default function UserProfile({ params }: { params: { id: string } }) {
  return (
    <div>
      <h1>User Profile</h1>
      <p>User ID: {params.id}</p>
    </div>
  );
}
```

Visit `http://localhost:3333/users/123`

#### Add an API with Multiple Methods

Create `app/api/users/route.ts`:

```typescript
// GET /api/users
export function GET() {
  return Response.json({
    users: [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" }
    ]
  });
}

// POST /api/users
export async function POST(request: Request) {
  const body = await request.json();
  return Response.json({
    message: "User created",
    user: body
  }, { status: 201 });
}
```

#### Add a Layout

Create `app/layout.tsx`:

```tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <head>
        <title>My Mandu App</title>
      </head>
      <body>
        <nav>
          <a href="/">Home</a>
          <a href="/about">About</a>
        </nav>
        <main>{children}</main>
        <footer>© 2025 My App</footer>
      </body>
    </html>
  );
}
```

### CLI Commands for Beginners

| Command | What it does |
|---------|--------------|
| `bunx @mandujs/cli init my-app` | Create a new project called "my-app" |
| `bun install` | Install all dependencies |
| `bun run dev` | Start development server at http://localhost:3333 |
| `bun run build` | Build for production (`mandu build`) |
| `bun run test` | Run tests |

#### More CLI Commands

```bash
# Check all available commands
bunx mandu --help

# Show all routes in your app
bunx mandu routes list

# Check architecture rules
bunx mandu guard arch

# Watch for architecture violations (real-time)
bunx mandu guard arch --watch

# Setup and run automated E2E tests
bunx mandu add test
bunx mandu test:auto
```

### Tech Stack

| Technology | Version | Purpose |
|------------|---------|---------|
| **Bun** | 1.0+ | JavaScript runtime & package manager |
| **React** | 19.x | UI library |
| **TypeScript** | 5.x | Type safety |

### Next Steps

1. **Read the [FS Routes](#fs-routes) section** to understand routing patterns
2. **Try [Mandu Guard](#mandu-guard)** to enforce architecture rules
3. **Explore [MCP Server](#mcp-server-ai-integration)** for AI agent integration

### Troubleshooting

| Problem | Solution |
|---------|----------|
| `command not found: bun` | Install Bun: `curl -fsSL https://bun.sh/install \| bash` |
| Port 3333 already in use | Stop other servers or use `PORT=3334 bun run dev` |
| Changes not reflecting | Restart dev server with `bun run dev` |
| TypeScript errors | Run `bun install` to ensure types are installed |

---

## What is Mandu?

**Mandu** is a **Bun + TypeScript + React fullstack framework** designed for AI-assisted development.

### The Problem We Solve

> Not "how fast AI can code" but
> **enforcing architecture that AI cannot break**

Current AI coding has a fundamental problem: the more agents code, the more architecture deteriorates. Mandu solves this with:

- **FS Routes**: File-system based routing (like Next.js) - structure IS the API
- **Mandu Guard**: Real-time architecture enforcement - violations detected instantly
- **Slot System**: Isolated spaces where agents safely write business logic

```
┌─────────────────────────────────────────────────────────────┐
│                     Mandu Architecture                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   📁 app/              File-System Routes (structure = API)  │
│        ↓                                                     │
│   🛡️ Guard             Real-time architecture enforcement    │
│        ↓                                                     │
│   🎯 Slot              Agent's permitted workspace           │
│        ↓                                                     │
│   🏝️ Island            Selective client-side hydration       │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Why Mandu — What's Actually Different

Most modern frameworks cover one or two render modes well. Mandu ships **every render mode** in one framework **and** a contract-driven, agent-native layer on top.

### Render Mode Matrix (all shipped today)

| Mode | Mandu | Next.js (App) | Astro | SvelteKit | Remix | Qwik |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Dynamic SSR | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| ISR (revalidate) | ✅ | ✅ | ❌ | ⚠️ adapter | ❌ | ❌ |
| SWR cache | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| PPR (streaming shell + hole) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Static prerender | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| **Island (partial hydration)** | ✅ | ❌ | ✅ | ❌ | ❌ | — |
| `hydration: "none"` (SSR, zero client JS) | ✅ | ⚠️ implicit | ✅ | ❌ | ❌ | ✅ |
| SPA-nav (client router + view transitions + hash preservation) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Per-route choice | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ |

Every row is orthogonal — pick `dynamic` for the dashboard, `isr` for product pages, `static` for marketing, `hydration:none` for docs, and `island` for the navbar — in **one app**.

```ts
// app/products/[id]/page.tsx
export default route().render("isr", { revalidate: 120 }).handle(...);

// app/docs/[[...slug]]/page.tsx
export default route().render("static").hydration("none").handle(...);

// app/dashboard/page.tsx — PPR: static shell, streaming holes
export default route().render("ppr").handle(...);
```

→ **Full render × hydration matrix with 20 practical recipes**: [`docs/rendering.md`](./docs/rendering.md).

### The Part Nobody Else Has

Render modes are table stakes. The real gap is **what sits above them**:

| Capability | Mandu | Next.js | Astro | SvelteKit | Remix |
|---|:---:|:---:|:---:|:---:|:---:|
| Zod contract → runtime validation | ✅ | ❌ | ❌ | ❌ | ❌ |
| Contract → auto OpenAPI 3.1 (`/__mandu/openapi.json`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Contract → boundary probe (18 Zod types) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Contract → property-based test scaffold | ✅ | ❌ | ❌ | ❌ | ❌ |
| Contract-semantic mutation testing (9 operators) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Typed RPC (zero-dep, `createRpcClient<typeof router>()`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Real-time architecture Guard (6 presets: FSD / Clean / Hexagonal / Atomic / CQRS / Mandu) | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Agent-native MCP (16 tools) for Cursor / Claude Code / Codex** | ✅ | ❌ | ❌ | ❌ | ❌ |
| `mandu info --json` / diagnose — single-blob env + health dump | ✅ | ❌ | ❌ | ❌ | ❌ |

### One Zod Schema, Seven Jobs

```ts
// spec/contracts/signup.contract.ts
export default defineContract({
  name: "SignupContract",
  methods: {
    POST: {
      body: z.object({
        email: z.string().email(),
        password: z.string().min(8),
        role: z.enum(["user", "admin"]),
      }),
      response: {
        201: z.object({ userId: z.string().uuid() }),
        409: z.object({ error: z.literal("EMAIL_TAKEN") }),
      },
    },
  },
});
```

That single file drives:

1. **Runtime validation** — request / response are Zod-parsed, 400 on violation.
2. **Typed RPC client** — `createRpcClient<typeof router>()` gives the browser fully inferred types end-to-end.
3. **OpenAPI 3.1 spec** — served at `/__mandu/openapi.json` when enabled, fed to Postman / codegen / Swagger UI.
4. **Boundary probes** — `mandu_ate_boundary_probe` generates invalid email / empty password / enum violation / type-mismatch cases deterministically.
5. **Property test scaffold** — `kind: property_based` prompt wraps Zod into fast-check arbitraries.
6. **Mutation testing** — 9 contract-semantic operators (remove required field, narrow type, widen enum, flip nullable, rename field, swap sibling type, skip middleware, early return, bypass validation) produce **meaningful** mutants, not random `a+b → a-b` noise.
7. **Coverage oracle** — `mandu_ate_coverage` flags contracts with no boundary test as `high` severity gaps.

Next.js / Astro / SvelteKit have zero of this. Not "a little less" — **zero**. The combination is structurally impossible without a Zod-contract-first architecture and an MCP server, and Mandu was designed around both from day one.

### Agent-Native by Construction

Mandu ships **16 MCP tools** (see [`docs/ate/roadmap-v2-agent-native.md`](./docs/ate/roadmap-v2-agent-native.md)). Every tool is designed for an LLM to consume:

- `mandu_ate_context({ scope, id })` — serialized route + contract + middleware + guard + fixtures + existing specs in one JSON blob. An agent that has this blob can write idiomatic Mandu tests on the first try.
- `mandu_ate_prompt({ kind })` — curated system prompts (9 kinds) that teach the LLM Mandu-specific primitives (`testFilling`, `createTestServer`, `createTestSession`, `expectContract`, `waitForIsland`…). Generic LLMs write Jest + React Testing Library style; with Mandu's prompt they write the idiomatic version.
- `mandu_ate_run({ spec })` — runs the spec and returns **structured failure JSON** (8 discriminated kinds: `selector_drift`, `contract_mismatch`, `redirect_unexpected`, `hydration_timeout`, `rate_limit_exceeded`, `csrf_invalid`, `fixture_missing`, `semantic_divergence`). The agent reads the JSON, proposes a heal, and loops.
- `mandu_ate_mutate` / `mandu_ate_mutation_report` — contract-semantic mutation testing that asks "does your test suite actually catch the change?"
- `mandu_ate_oracle_*` — queue `expectSemantic("the user clearly sees the error")` judgments for the agent to resolve in a local session. Deterministic CI is never blocked.

You don't integrate Mandu into your agent workflow. **Your agent integrates Mandu into its workflow**, via MCP, for free, in Cursor / Claude Code / Codex / any client that speaks the protocol.

### Bun-Native, Not Bun-Compatible

Every other framework is Node-first with Bun as an afterthought. Mandu is the other way around:

- `Bun.serve` for the HTTP server (including WebSocket upgrades — see [`filling/ws.ts`](./packages/core/src/filling/ws.ts)).
- `Bun.sql` for the database adapter (PostgreSQL / MySQL / SQLite unified).
- `Bun.CookieMap` + `Bun.password` (argon2id) for auth.
- `Bun.cron` for the scheduler.
- `Bun.s3` for storage.
- `Bun.hash` + `bun:sqlite` for session store.
- `Bun.CSRF` where available.
- `bun:test` everywhere, parallel by default.

Cold start is ~100ms. TTFB on a warm ISR route is single-digit milliseconds. Because Bun.

---

## Key Features

### 🏗️ Architecture & Routing

| Feature | Description |
|---------|-------------|
| **FS Routes** | File-system based routing — `app/users/page.tsx` → `/users` |
| **Mandu Guard** | Real-time architecture checker with **6 presets** (FSD, Clean, Hexagonal, Atomic, **CQRS**, Mandu) |
| **Self-Healing Guard** | Detect violations AND provide actionable fix suggestions with auto-fix |
| **Decision Memory** | ADR storage for AI to reference past architecture decisions |
| **Architecture Negotiation** | AI-Framework dialog before implementation |
| **Slot System** | Isolated areas where agents safely write business logic |
| **Semantic Slots** | Purpose & constraints validation for AI-generated code |

### ⚡ Runtime & Performance

| Feature | Description |
|---------|-------------|
| **Filling API** | 8-stage lifecycle (loader → guard → action → render) with fluent chaining |
| **Island Architecture** | **5 hydration strategies**: `load`, `idle`, `visible`, `media`, `never` — Zero-JS by default |
| **ISR/SWR Cache** | Built-in incremental regeneration with `revalidatePath` / `revalidateTag` |
| **PPR (Partial Prerendering)** | Cached shell + fresh dynamic data |
| **Streaming SSR** | React 19 streaming with deferred data |
| **Per-Island Code Splitting** | Independent JS bundles per island file |
| **WebSocket** | Built-in `filling.ws()` chaining handlers |
| **Session Management** | Cookie-based with HMAC signing + secret rotation |
| **Image Handler** | Built-in `/_mandu/image` with optimization |
| **Middleware** | CORS, JWT, compress, logger, timeout — all built-in |
| **Form (Progressive Enhancement)** | `<Form>` works without JS, enhanced when JS loads |
| **View Transitions API** | Smooth navigation transitions with state preservation |

### 🔒 Type Safety & Contracts

| Feature | Description |
|---------|-------------|
| **Contract API** | One Zod schema → type inference + runtime validation + OpenAPI 3.0 |
| **Client/Server Type Inference** | End-to-end type safety from Contract to client fetch |
| **SEO Module** | Next.js Metadata API compatible, sitemap/robots generation, JSON-LD helpers |

### 🤖 AI-Native Integration

| Feature | Description |
|---------|-------------|
| **MCP Server** | **85+ tools, 4 resources, 3 prompts** for AI agents to directly manipulate the framework |
| **Claude Code Skills** | **9 SKILL.md plugins** (`@mandujs/skills`) for guided AI workflows |
| **Transaction API** | Atomic changes with snapshot-based rollback |
| **Activity Log Observability** | EventBus + correlation ID tracking + SQLite store + OpenTelemetry export |
| **`mandu://activity` resource** | AI agents can query observability data directly |

### 🧪 Testing & Quality

| Feature | Description |
|---------|-------------|
| **ATE (Automation Test Engine)** | AI-driven E2E testing — Extract → Generate → Run → Heal |
| **Smart Test Selection** | Git-diff based intelligent route selection with priority scoring |
| **Coverage Gap Detection** | Find untested route transitions, API calls, form actions |
| **Pre-commit Hook** | Auto-detect changes that need testing before commit |
| **Self-Healing Tests** | 7-category failure classification + history-based confidence boost |
| **L0/L1/L2/L3 Oracle Levels** | Smoke → structural → contract → behavioral assertions |

### 🔥 Developer Experience

| Feature | Description |
|---------|-------------|
| **HMR Support** | Hot reload for SSR pages, API routes, CSS, and islands |
| **Kitchen DevTools** | Built-in dashboard at `/__kitchen` with 7 tabs (Errors, Network, Islands, Requests, MCP, Cache, Metrics) |
| **`mandu monitor` CLI** | EventBus-based observability stream with filtering and stats |
| **Tailwind v4 Auto-build** | Self-managed CSS watcher (no `--watch` needed) |
| **Lockfile Validation** | Config integrity check before dev/build |

---

## Workflow

### Modern Workflow (Recommended)

```bash
# 1. Create project
bunx @mandujs/cli init my-app

# 2. Create pages in app/ folder
#    app/page.tsx        → /
#    app/users/page.tsx  → /users
#    app/api/users/route.ts → /api/users

# 3. Start development (Guard auto-enabled)
bunx mandu dev

# 4. Build for production
bunx mandu build
```

### CLI Commands

**Project Lifecycle**
| Command | Description |
|---------|-------------|
| `mandu create <name>` | Scaffold a new Mandu project into a new folder (templates: default, realtime-chat). |
| `mandu init` | Retrofit Mandu into the current folder (existing files preserved unless `--force`). |
| `mandu dev` | Start dev server (FS Routes + Guard + HMR auto-enabled) |
| `mandu dev:safe` | Start dev with lockfile pre-validation |
| `mandu build` | Build for production |
| `mandu start` | Start production server |
| `mandu check` | Run integrated routes + architecture + config checks |
| `mandu lock` | Generate/refresh lockfile for config integrity |

**Architecture & Quality**
| Command | Description |
|---------|-------------|
| `mandu guard arch` | Run architecture check |
| `mandu guard arch --watch` | Real-time architecture violation detection |
| `mandu guard heal` | Apply auto-fix suggestions to violations |
| `mandu routes list` | Show all routes |
| `mandu manifest validate` | Validate route manifest schema |

**Observability**
| Command | Description |
|---------|-------------|
| `mandu monitor` | Live event stream from dev server (HTTP/MCP/Guard/Build) |
| `mandu monitor --type mcp` | Filter by event type |
| `mandu monitor --severity error` | Filter by severity |
| `mandu monitor --trace <id>` | Show all events for a correlation ID |
| `mandu monitor --stats --since 5m` | Aggregated stats over time window |

**Testing (ATE)**
| Command | Description |
|---------|-------------|
| `mandu add test` | Setup ATE (Automation Test Engine) |
| `mandu test:auto` | Run automated E2E tests |
| `mandu test:auto --ci` | CI mode (exit 1 on failure) |
| `mandu test:heal` | Auto-heal failed tests with confidence scoring |

**MCP & Skills**
| Command | Description |
|---------|-------------|
| `bunx mandu-mcp` | Start MCP server (manual mode) |
| `bunx @mandujs/skills` | Install Claude Code skills |

---

## Configuration

Mandu loads configuration from `mandu.config.ts`, `mandu.config.js`, or `mandu.config.json`.
For guard-only overrides, `.mandu/guard.json` is also supported.

- `mandu dev` and `mandu build` validate the config and print errors if invalid
- CLI flags override config values

```ts
// mandu.config.ts
export default {
  server: {
    port: 3333,
    hostname: "localhost",
    cors: false,
    streaming: false,
    rateLimit: {
      windowMs: 60_000,
      max: 100,
    },
  },
  dev: {
    hmr: true,
    watchDirs: ["src/shared", "shared"],
  },
  build: {
    outDir: ".mandu",
    minify: true,
    sourcemap: false,
  },
  guard: {
    preset: "mandu",
    srcDir: "src",
    exclude: ["**/*.test.ts"],
    realtime: true,
    // rules/contractRequired are used by legacy spec guard
  },
  seo: {
    enabled: true,
    defaultTitle: "My App",
    titleTemplate: "%s | My App",
  },
};
```

`server.rateLimit` applies to API routes only (`client IP + route` key). Exceeded requests return `429` with `X-RateLimit-*` headers.

---

## FS Routes

Create routes by simply adding files to the `app/` directory:

```
app/
├── page.tsx              → /
├── layout.tsx            → Layout for all pages
├── users/
│   ├── page.tsx          → /users
│   ├── [id]/
│   │   └── page.tsx      → /users/:id
│   └── [...slug]/
│       └── page.tsx      → /users/* (catch-all)
├── api/
│   └── users/
│       └── route.ts      → /api/users (API endpoint)
└── (auth)/               → Route group (no URL segment)
    ├── login/
    │   └── page.tsx      → /login
    └── register/
        └── page.tsx      → /register
```

### Special Files

| File | Purpose |
|------|---------|
| `page.tsx` | Page component |
| `layout.tsx` | Shared layout wrapper |
| `route.ts` | API endpoint handler |
| `loading.tsx` | Loading state |
| `error.tsx` | Error boundary |
| `slot.ts` | Server-side business logic |
| `client.tsx` | Client-side interactive component (Island) |

---

## Mandu Guard

Real-time architecture enforcement with preset support.

### Architecture Presets (6)

| Preset | Description | Use Case |
|--------|-------------|----------|
| `mandu` | FSD + Clean Architecture hybrid (default) | Fullstack projects |
| `fsd` | Feature-Sliced Design | Frontend-focused |
| `clean` | Clean Architecture | Backend-focused |
| `hexagonal` | Hexagonal / Ports & Adapters | Domain-driven |
| `atomic` | Atomic Design | UI component libraries |
| `cqrs` | Command Query Responsibility Segregation | Event-sourced apps |

### Usage

```bash
# One-time check
bunx mandu guard arch

# Watch mode
bunx mandu guard arch --watch

# CI mode (exit 1 on errors)
bunx mandu guard arch --ci

# With specific preset
bunx mandu guard arch --preset fsd

# Generate report
bunx mandu guard arch --output report.md --report-format markdown
```

### Layer Hierarchy (Mandu Preset)

```
Client (FSD)               Shared (strict)              Server (Clean)
──────────────────         ───────────────              ─────────────────
client/app                 shared/contracts             server/api
  ↓                        shared/types                 ↓
client/pages               shared/utils/client          server/application
  ↓                        shared/schema (server-only)  ↓
client/widgets             shared/utils/server          server/domain
  ↓                        shared/env (server-only)     ↓
client/features                                          server/infra
  ↓                                                     ↓
client/entities                                         server/core
  ↓
client/shared
```

Upper layers can only import from lower layers. Guard detects violations in real-time.

---

## Slot System

Write business logic in isolated slot files:

```typescript
// spec/slots/users.slot.ts
import { Mandu } from "@mandujs/core";

export default Mandu.filling()
  .guard((ctx) => {
    if (!ctx.get("user")) return ctx.unauthorized("Login required");
  })
  .get(async (ctx) => {
    const users = await db.users.findMany();
    return ctx.ok({ data: users });
  })
  .post(async (ctx) => {
    const body = await ctx.body<{ name: string; email: string }>();
    const user = await db.users.create({ data: body });
    return ctx.created({ data: user });
  });
```

### Context API

| Method | Description |
|--------|-------------|
| `ctx.ok(data)` | 200 OK |
| `ctx.created(data)` | 201 Created |
| `ctx.error(message)` | 400 Bad Request |
| `ctx.unauthorized(message)` | 401 Unauthorized |
| `ctx.notFound(message)` | 404 Not Found |
| `ctx.body<T>()` | Parse request body |
| `ctx.params` | Route parameters |
| `ctx.query` | Query parameters |

---

## Island Architecture

**Zero-JS by default.** Ship interactive components only where needed, with **5 hydration strategies**.

### Hydration Strategies (5)

| Strategy | When JS Loads | Use Case |
|----------|---------------|----------|
| `load` | Immediately on page load | Critical interactive UI (chat, forms) |
| `idle` | During browser idle (`requestIdleCallback`) | Non-critical widgets |
| `visible` | When element enters viewport (default) | Below-the-fold components |
| `media` | When CSS media query matches | Mobile-only or desktop-only widgets |
| `never` | Never hydrated (pure SSR HTML) | Static content |

### Declarative Pattern

```tsx
// app/page.tsx
import { island } from "@mandujs/core";
import Counter from "@/client/widgets/counter";

const VisibleCounter = island("visible", Counter);

export default function Home() {
  return (
    <main>
      <h1>Welcome</h1>
      <VisibleCounter initial={0} />
    </main>
  );
}
```

### Client Island Pattern

```tsx
// app/widgets/counter.client.tsx — must import from "@mandujs/core/client"
import { island } from "@mandujs/core/client";
import { useState } from "react";

export default island<{ initial: number }>({
  setup: ({ props }) => ({ count: props.initial }),
  render: ({ data }) => {
    const [count, setCount] = useState(data.count);
    return (
      <div>
        <p>{count}</p>
        <button onClick={() => setCount(c => c + 1)}>+</button>
      </div>
    );
  },
});
```

### Per-Island Code Splitting

Each island file is bundled independently. The browser only downloads the JS for islands actually used on the current page.

---

## Contract API

Type-safe API contracts with full inference:

```typescript
import { Mandu } from "@mandujs/core";
import { z } from "zod";

// Define contract
const userContract = Mandu.contract({
  request: {
    GET: { query: z.object({ id: z.string() }) },
    POST: { body: z.object({ name: z.string(), email: z.string().email() }) }
  },
  response: {
    200: z.object({ data: z.any() }),
    400: z.object({ error: z.string() })
  }
});

// Create handlers (fully typed)
const handlers = Mandu.handler(userContract, {
  GET: (ctx) => ({ data: fetchUser(ctx.query.id) }),
  POST: (ctx) => ({ data: createUser(ctx.body) })
});

// Type-safe client
const client = Mandu.client(userContract, { baseUrl: "/api/users" });
const result = await client.GET({ query: { id: "123" } });
```

---

## Filling API

8-stage lifecycle for route handlers with fluent chaining.

```typescript
// app/api/todos/route.ts
import { Mandu } from "@mandujs/core";
import { db } from "@/server/infra/db";
import { jwtMiddleware, corsMiddleware } from "@mandujs/core/middleware";

export default Mandu.filling()
  // 1. Middleware (composable)
  .use(corsMiddleware({ origin: "*" }))
  .use(jwtMiddleware({ secret: process.env.JWT_SECRET! }))

  // 2. Guard (early return on failure)
  .guard((ctx) => {
    if (!ctx.user) return ctx.unauthorized("Login required");
  })

  // 3. Loader (cached with ISR)
  .loader(async (ctx) => {
    return { todos: await db.todos.list(ctx.user.id) };
  }, { revalidate: 30, tags: ["todos"] })

  // 4. Named actions (auto-revalidate after mutation)
  .action("create", async (ctx) => {
    const { title } = await ctx.body<{ title: string }>();
    const todo = await db.todos.create(ctx.user.id, title);
    return ctx.created({ todo });
  })

  .action("delete", async (ctx) => {
    const { id } = ctx.params;
    await db.todos.delete(id);
    return ctx.noContent();
  })

  // 5. Render mode
  .render("isr", { revalidate: 60 });
```

### Lifecycle Stages

1. **Middleware** — composable plugins (cors, jwt, compress, logger, timeout)
2. **Guard** — early return for auth/permissions
3. **Loader** — fetch data (cached with ISR/SWR/PPR)
4. **Actions** — named mutation handlers with auto-revalidation
5. **Layout chain** — nested route data loading (parallel)
6. **Render** — SSR with hydration strategy
7. **Response** — apply cookies, headers, mapResponse hooks
8. **Cache** — store result by route + query

### Render Modes

| Mode | Behavior |
|------|----------|
| `dynamic` | Always SSR fresh (default) |
| `isr` | Cache full HTML, regenerate on stale + tag invalidation |
| `swr` | Serve stale, regenerate in background |
| `ppr` | Cache shell, fresh dynamic data per request |

---

## Middleware

Built-in middleware plugins. All return `MiddlewarePlugin` (`beforeHandle` + `afterHandle` + `mapResponse`).

```typescript
import { Mandu } from "@mandujs/core";
import {
  corsMiddleware,
  jwtMiddleware,
  compressMiddleware,
  loggerMiddleware,
  timeoutMiddleware,
} from "@mandujs/core/middleware";

export default Mandu.filling()
  .use(corsMiddleware({ origin: ["https://example.com"], credentials: true }))
  .use(jwtMiddleware({ secret: process.env.JWT_SECRET!, algorithms: ["HS256"] }))
  .use(compressMiddleware({ threshold: 1024 }))
  .use(loggerMiddleware())
  .use(timeoutMiddleware({ ms: 30_000 }))
  .loader(async (ctx) => ({ user: ctx.user })); // ctx.user typed by jwtMiddleware
```

| Middleware | Features |
|------------|----------|
| `corsMiddleware` | Origin allowlist, credentials, preflight |
| `jwtMiddleware` | HS256/HS384/HS512, algorithm allowlist, nbf validation, 8KB token limit |
| `compressMiddleware` | gzip/deflate with threshold |
| `loggerMiddleware` | Structured request logging |
| `timeoutMiddleware` | Per-request timeout with abort |

---

## Session Management

Cookie-based sessions with HMAC signing and secret rotation.

```typescript
import { createCookieSessionStorage } from "@mandujs/core";

const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: "_mandu_session",
    secrets: [process.env.SESSION_SECRET!, process.env.OLD_SECRET], // rotation
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 7, // 7 days
  },
});

// In a route
export default Mandu.filling()
  .loader(async (ctx) => {
    const session = await sessionStorage.getSession(ctx.request.headers.get("cookie"));
    const user = session.get("user");
    return { user };
  })
  .action("login", async (ctx) => {
    const session = await sessionStorage.getSession(ctx.request.headers.get("cookie"));
    session.set("user", { id: 1, name: "Alice" });
    session.flash("message", "Welcome back!"); // one-time message

    return ctx.ok({ ok: true }, {
      headers: { "Set-Cookie": await sessionStorage.commitSession(session) },
    });
  });
```

---

## Cache (ISR / SWR / PPR)

Built-in incremental static regeneration with tag-based invalidation.

```typescript
import { Mandu, revalidatePath, revalidateTag } from "@mandujs/core";

// Cache for 60s, tag with "posts"
export default Mandu.filling()
  .loader(async () => ({ posts: await db.posts.list() }), {
    revalidate: 60,
    tags: ["posts"],
  });

// Invalidate from a mutation handler
export async function POST() {
  await db.posts.create({ ... });
  revalidateTag("posts");        // invalidate all tagged caches
  revalidatePath("/blog");       // invalidate specific path
  return new Response(null, { status: 201 });
}
```

| Mode | Behavior |
|------|----------|
| **ISR** | Cache full HTML; regenerate on stale or tag invalidation |
| **SWR** | Serve stale immediately, regenerate in background |
| **PPR** | Cache shell only (HTML structure), fetch fresh data per request |

---

## Observability

EventBus-based observability with **6 phases** of features. Every HTTP request, MCP tool call, Guard violation, and build event flows through a unified bus.

### EventBus

```typescript
import { eventBus } from "@mandujs/core/observability";

// Subscribe to all events
const unsubscribe = eventBus.on("*", (event) => {
  console.log(event.type, event.message, event.duration);
});

// Subscribe to specific type
eventBus.on("http", (event) => {
  if (event.severity === "error") {
    console.error("HTTP error:", event.message);
  }
});

// Emit custom events
eventBus.emit({
  type: "build",
  severity: "info",
  source: "my-plugin",
  message: "Custom build step completed",
  duration: 120,
});
```

### Correlation ID Tracking

Every HTTP request gets a `correlationId` (from `x-mandu-request-id` header or auto-generated UUID). All events triggered by that request share the same ID, enabling distributed tracing.

### `mandu monitor` CLI

```bash
# Live event stream
mandu monitor

# Filter by type
mandu monitor --type mcp

# Filter by severity
mandu monitor --severity error

# Trace a specific request
mandu monitor --trace req-abc-123

# Aggregated stats over 5 minutes
mandu monitor --stats --since 5m
```

### Kitchen DevTools Tabs (7)

Visit `http://localhost:3333/__kitchen` to see:

| Tab | Description |
|-----|-------------|
| **Errors** | Persistent error log (`.mandu/errors.jsonl`) with stack traces |
| **Network** | Fetch/XHR proxied requests (with response bodies) |
| **Islands** | Active island bundles and hydration status |
| **Requests** | HTTP request log with **correlation-linked detail view** |
| **MCP** | MCP tool call timeline grouped by correlation ID |
| **Cache** | ISR/SWR cache stats (entries, hit rate, stale, tags) |
| **Metrics** | TTFB p50/p95/p99, MCP avg duration, error rate |

### SQLite Persistent Store

```typescript
import {
  startSqliteStore,
  queryEvents,
  queryStats,
  exportJsonl,
  exportOtlp,
} from "@mandujs/core/observability";

// Auto-started by `mandu dev` (configurable via dev.observability)
await startSqliteStore(rootDir); // → .mandu/observability.db

// Query historical events
const events = queryEvents({
  type: "http",
  severity: "error",
  sinceMs: Date.now() - 60_000,
  limit: 100,
});

// Aggregated stats over time window
const stats = queryStats(5 * 60 * 1000); // last 5 minutes

// Export for external tools
const jsonl = exportJsonl({ type: "http" });
const otlp = exportOtlp({}); // OpenTelemetry-compatible
```

### MCP Resource for AI Agents

```
mandu://activity → Recent 20 events + 5-minute stats
```

AI agents can query observability data directly via MCP without parsing log files.

---

## ATE (Automation Test Engine)

AI-driven end-to-end testing automation with self-healing capabilities.

### What is ATE?

ATE automatically:
1. **Extracts** your app's interaction graph from source code (AST-based)
2. **Generates** Playwright test specs with domain-aware assertions (4 scenario kinds: ssr-verify, island-hydration, sse-stream, form-action)
3. **Runs** E2E tests with detailed reporting and `--grep` filtering
4. **Heals** failures with **7-category classification** and history-based confidence scoring
5. **Smart-selects** routes to test based on git diff (Phase 5)
6. **Detects coverage gaps** in the interaction graph (Phase 5)

### Quick Start

```bash
# 1. Setup ATE
bunx mandu add test

# 2. Run automated E2E tests
bunx mandu test:auto

# 3. If tests fail, auto-heal them
bunx mandu test:heal
```

### Features

| Feature | Description |
|---------|-------------|
| **AST-based Extraction** | Analyzes TypeScript/React code to find routes, contracts, islands, SSE, actions |
| **Domain Detection** | Auto-detects domain type (ecommerce, blog, dashboard, auth, generic) |
| **Oracle Levels (4)** | L0 smoke → L1 structural → L2 contract schema → L3 behavioral assertions |
| **Mandu Scenario Kinds** | `ssr-verify`, `island-hydration`, `sse-stream`, `form-action` |
| **Selector Fallback** | 4-tier fallback chain: mandu-id → text → class → role → xpath |
| **Trace Parser** | Analyzes Playwright traces to identify failure causes |
| **Impact Analysis** | Git diff-based subset testing (only test affected routes) |
| **Smart Test Selection** *(Phase 5)* | Priority scoring: contract→HIGH, guard→HIGH, route→MEDIUM, shared→LOW |
| **Coverage Gap Detection** *(Phase 5)* | Find untested route transitions, API calls, form actions, island interactions |
| **Pre-commit Hook** *(Phase 5)* | Auto-detect staged changes that need testing |
| **Auto-Healing** | 7-category classification (selector-stale, api-shape-changed, race-condition, timeout, etc.) |
| **Heal History Learning** | Past success rate boosts auto-apply confidence (≥80% → +2 priority) |
| **testFilling Unit Tests** | Generate Bun unit tests in addition to Playwright E2E |
| **MCP Integration** | **12 MCP tools** (9 ATE + 3 Phase 5) for AI agents |

### MCP Tools (for AI Agents)

```typescript
// Pipeline automation
mandu.ate.auto_pipeline    // Extract → Generate → Run → Report → Heal

// Individual steps
mandu.ate.extract          // Extract interaction graph
mandu.ate.generate         // Generate Playwright specs
mandu.ate.run              // Run tests
mandu.ate.report           // Generate reports (JSON/HTML)
mandu.ate.heal             // Generate heal suggestions
mandu.ate.impact           // Calculate affected routes

// Feedback loop
mandu.ate.feedback         // Analyze failures with 7-category classification
mandu.ate.apply_heal       // Apply heal diffs safely (with backup)

// Phase 5: Intelligent test selection (NEW)
mandu.test.smart           // Smart route selection from git diff
mandu.test.coverage        // Detect coverage gaps in interaction graph
mandu.test.precommit       // Pre-commit hook: should we test before committing?
```

### Example: Auto-Pipeline

```bash
# AI agent can run the entire pipeline with one MCP call:
{
  "tool": "mandu.ate.auto_pipeline",
  "arguments": {
    "repoRoot": "/path/to/project",
    "baseURL": "http://localhost:3333",
    "oracleLevel": "L1",
    "useImpactAnalysis": true,
    "autoHeal": true
  }
}
```

### CI/CD Integration

ATE includes GitHub Actions templates:

```yaml
# .github/workflows/ate-e2e.yml (auto-generated)
name: ATE E2E Tests
on: [pull_request, push]
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bunx playwright install --with-deps chromium
      - run: bun run test:e2e:ci
      - uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: .mandu/reports/
```

### Documentation

- [ATE MCP Integration Guide](./packages/ate/docs/mcp-integration.md)
- [ATE Architecture](./packages/ate/docs/architecture.md)
- [ATE API Reference](./packages/ate/README.md)

---

## MCP Server (AI Integration)

Mandu includes a full MCP (Model Context Protocol) server with **85+ tools, 4 resources, and 3 prompts** for AI agent integration.

### Setup

```json
// .mcp.json
{
  "mcpServers": {
    "mandu": {
      "command": "bunx",
      "args": ["mandu-mcp"],
      "cwd": "/path/to/project"
    }
  }
}
```

> **Note**: Use `mandu-mcp` (not `@mandujs/mcp`) to avoid conflicts with Python's `mcp` CLI on PATH (#174).

### Tool Categories (85+)

| Category | Tools | Examples |
|----------|-------|----------|
| **Project** | 4 | `mandu.project.init`, `mandu.dev.start`, `mandu.dev.stop` |
| **Routes** | 5 | `mandu.route.list`, `mandu.route.add`, `mandu.route.delete`, `mandu.route.get`, `mandu.manifest.validate` |
| **Generate** | 2 | `mandu.generate`, `mandu.generate.status` |
| **Guard** | 4 | `mandu.guard.check`, `mandu.guard.analyze`, `mandu.guard.heal`, `mandu.guard.explain` |
| **Decisions** | 4 | `mandu.decision.save`, `mandu.decision.check`, `mandu.decision.list`, `mandu.decision.architecture` |
| **Negotiate** | 3 | `mandu.negotiate`, `mandu.negotiate.analyze`, `mandu.negotiate.scaffold` |
| **Slot** | 3 | `mandu.slot.read`, `mandu.slot.validate`, `mandu.slot.constraints` |
| **Hydration** | 4 | `mandu.island.add`, `mandu.island.list`, `mandu.hydration.set`, `mandu.hydration.addClientSlot` |
| **Contract** | 7 | `mandu.contract.create`, `mandu.contract.validate`, `mandu.contract.openapi`, `mandu.contract.sync`, etc. |
| **Resource** | 5 | `mandu.resource.create`, `mandu.resource.list`, `mandu.resource.get`, `mandu.resource.addField`, `mandu.resource.removeField` |
| **Brain** | 4 | `mandu.brain.doctor`, `mandu.brain.architecture`, `mandu.brain.checkImport`, `mandu.brain.checkLocation` |
| **Runtime** | 5 | `mandu.runtime.config`, `mandu.runtime.contractOptions`, `mandu.runtime.loggerConfig`, etc. |
| **SEO** | 6 | `mandu.seo.analyze`, `mandu.seo.jsonld`, `mandu.seo.sitemap`, `mandu.seo.robots`, `mandu.seo.preview`, `mandu.seo.write` |
| **History** | 3 | `mandu.history.snapshot`, `mandu.history.list`, `mandu.history.prune` |
| **Transaction** | 4 | `mandu.tx.begin`, `mandu.tx.commit`, `mandu.tx.rollback`, `mandu.tx.status` |
| **Watch** | 3 | `mandu.watch.start`, `mandu.watch.stop`, `mandu.watch.status` |
| **Kitchen** | 1 | `mandu.kitchen.errors` |
| **ATE** | 9 | `mandu.ate.extract`, `mandu.ate.generate`, `mandu.ate.run`, `mandu.ate.report`, `mandu.ate.heal`, `mandu.ate.impact`, `mandu.ate.auto_pipeline`, `mandu.ate.feedback`, `mandu.ate.apply_heal` |
| **Test (Phase 5)** | 4 | `mandu.test.smart`, `mandu.test.coverage`, `mandu.test.precommit`, `mandu.test.route` |
| **Composite** | 7 | `mandu.feature.create`, `mandu.diagnose`, `mandu.middleware.add`, `mandu.deploy.check`, `mandu.cache.manage`, etc. |
| **Build** | 2 | `mandu.build`, `mandu.build.status` |
| **Component** | 1 | `mandu.component.add` |

All tools use **dot notation** (`mandu.guard.check`) with backward-compatible underscore aliases (`mandu_guard_check`).

### Resources

| URI | Description |
|-----|-------------|
| `mandu://routes` | Current routes manifest |
| `mandu://config` | Parsed `mandu.config.ts` settings |
| `mandu://errors` | Recent build and runtime errors |
| `mandu://activity` | **NEW**: Recent observability events + 5-minute stats from EventBus |

### Profiles

Filter tools by profile via `MANDU_MCP_PROFILE` env var:

| Profile | Tools | Use Case |
|---------|-------|----------|
| `minimal` | ~15 | Read-only operations, safe for autonomous agents |
| `standard` | ~50 | Default — most common operations |
| `full` | 85+ | All tools including destructive operations |

---

## Skills (Claude Code Plugin)

Mandu ships with **9 SKILL.md plugins** for Claude Code at `@mandujs/skills`.

```bash
bunx @mandujs/skills install
```

| Skill | Purpose |
|-------|---------|
| `create-feature` | Guided feature scaffolding with Guard validation |
| `create-api` | API route + Contract + Filling generation |
| `debug` | Root cause analysis with Mandu observability |
| `explain` | Code explanation with framework context |
| `guard-guide` | Architecture preset selection guide |
| `deploy` | Production deployment checklist |
| `slot` | Slot file authoring with semantic constraints |
| `fs-routes` | FS Routes patterns and conventions |
| `hydration` | Island hydration strategy selection |

---

## Project Structure

### Generated Project

```
my-app/
├── app/                    # FS Routes (pages, layouts, API)
│   ├── page.tsx
│   └── api/
├── spec/
│   ├── routes.manifest.json  # Route definitions
│   └── slots/                # Business logic
├── .mandu/
│   ├── client/               # Built bundles
│   └── manifest.json         # Bundle manifest
└── package.json
```

### Framework Monorepo

```
mandu/
├── packages/
│   ├── core/       # @mandujs/core - Runtime, Guard, Router, Bundler, Observability
│   ├── cli/        # @mandujs/cli - 38+ CLI commands
│   ├── mcp/        # @mandujs/mcp - MCP server (85+ tools, 4 resources, 3 prompts)
│   ├── ate/        # @mandujs/ate - Automation Test Engine (Phase 1-6)
│   └── skills/     # @mandujs/skills - Claude Code skills plugin
├── docs-site/      # Astro Starlight documentation site
└── docs/           # Roadmaps, RFCs, architecture decisions
```

---

## Tech Stack

| Area | Technology |
|------|------------|
| **Runtime** | Bun 1.3.12+ (`bun:sqlite`, `Bun.spawn`, `Bun.serve`, `Bun.cron`) |
| **Language** | TypeScript 5.x |
| **Frontend** | React 19 (Streaming SSR, Suspense, useTransition) |
| **Validation** | Zod (Contract API) |
| **Testing** | Bun Test + Playwright (via ATE) |
| **AI Protocol** | MCP (Model Context Protocol) |
| **Build** | Bun bundler + Tailwind CSS v4 (Oxide) |
| **Storage** | bun:sqlite (observability), JSONL (errors, activity) |

---

## Roadmap

### v0.20.x (Current — Released)

**Core Runtime**
- [x] Filling API with 8-stage lifecycle + named actions + auto-revalidation
- [x] Streaming SSR with React 19
- [x] Middleware composition (cors, jwt, compress, logger, timeout)
- [x] Runtime logger with structured output
- [x] Cookie-based session storage with HMAC signing + secret rotation
- [x] WebSocket via `filling.ws()` chaining
- [x] Image handler (`/_mandu/image`)
- [x] Form Progressive Enhancement
- [x] View Transitions API integration

**Routing & Layout**
- [x] FS Routes (scanner, patterns, generator, watcher)
- [x] Nested layout chain with parallel data loading
- [x] Advanced routes (catch-all, optional params, route groups)
- [x] Client-side router (Link, NavLink, hooks, prefetch)
- [x] Race-condition-free navigation with AbortController

**Architecture (Guard)**
- [x] **6 presets** (mandu, fsd, clean, hexagonal, atomic, **cqrs**)
- [x] AST-based import analysis
- [x] Real-time violation detection with file watcher
- [x] Self-Healing Guard with auto-fix suggestions
- [x] Decision Memory (ADR storage + consistency checking)
- [x] Semantic Slots (purpose & constraint validation)
- [x] Architecture Negotiation (AI-Framework pre-implementation dialog)

**Cache & Performance**
- [x] **ISR** (Incremental Static Regeneration) with tag invalidation
- [x] **SWR** (stale-while-revalidate) with background regeneration
- [x] **PPR** (Partial Prerendering) — cached shell + fresh data
- [x] `revalidatePath` / `revalidateTag` global API
- [x] LRU memory cache with tag index
- [x] ETag + 304 Not Modified for static files

**Hydration**
- [x] **5 island strategies** (load, idle, visible, media, never)
- [x] Per-island code splitting (independent JS bundles)
- [x] Declarative + client island patterns
- [x] React Internals shim for Bun compatibility
- [x] HMR support for SSR pages, API routes, CSS, islands

**Type Safety & Contracts**
- [x] Contract API with Zod
- [x] Type-safe handlers & clients with end-to-end inference
- [x] OpenAPI 3.0 generator
- [x] Schema normalization (strip/strict/passthrough)
- [x] `defineContract` low-level API

**SEO**
- [x] Next.js Metadata API compatible types
- [x] Layout chain metadata merging
- [x] Open Graph & Twitter Cards
- [x] JSON-LD structured data (12 helpers)
- [x] Sitemap.xml & robots.txt generation
- [x] SSR integration with `<head>` injection

**AI Integration (RFC-001: From Guard to Guide)**
- [x] **MCP server: 85+ tools, 4 resources, 3 prompts**
- [x] Tool profiles (minimal/standard/full) via `MANDU_MCP_PROFILE`
- [x] Brain (Doctor, Watcher, Architecture analyzer)
- [x] Transaction API with snapshots (`tx-lock` for multi-agent safety)
- [x] **9 Claude Code skills** (`@mandujs/skills` plugin)

**ATE (Automation Test Engine)**
- [x] **Phase 1-3**: Extract → Generate → Run → Report → Heal pipeline
- [x] **Phase 1**: L0/L1/L2/L3 Oracle levels
- [x] **Phase 2**: Mandu scenario kinds (ssr-verify, island-hydration, sse-stream, form-action)
- [x] **Phase 3**: testFilling unit codegen + `--grep` filtering
- [x] **Phase 4**: Heal 7-category classification + history-based confidence
- [x] **Phase 5.1**: Smart test selection (git diff → priority scoring)
- [x] **Phase 5.2**: Coverage gap detection
- [x] **Phase 5.3**: Pre-commit hook helper
- [x] **Phase 6.1**: SSR rendering tests (36 tests)
- [x] 12 MCP tools (9 ATE + 3 Phase 5)

**Activity Log & Observability (NEW)**
- [x] **Phase 1**: EventBus core + correlation ID + Logger/MCP adapters
- [x] **Phase 2**: dev terminal 1-line logs + `m` key MCP toggle
- [x] **Phase 3**: Monitor CLI with filtering, stats, SSE streaming
- [x] **Phase 4**: Kitchen DevTools 5 new tabs (Requests, MCP, Cache, Metrics, Errors persistence)
- [x] **Phase 5**: AI agent observability (sessionId tracking, `mandu://activity` resource)
- [x] **Phase 6**: SQLite persistent store + time-series queries + JSONL/OTLP export

**Security**
- [x] Path traversal prevention (realpath verification)
- [x] Port validation
- [x] LFI vulnerability protection
- [x] Null byte attack detection
- [x] JWT algorithm allowlist + nbf validation + 8KB token limit
- [x] HMAC session signing with secret rotation
- [x] Rate limiting (per-IP + per-route)

**Developer Experience**
- [x] HMR for SSR-only pages (no islands required)
- [x] API route hot-reload (route.ts changes auto-reload)
- [x] Tailwind v4 self-managed CSS watcher
- [x] Improved error messages (10 critical paths)
- [x] `.well-known/` directory serving (RFC 8615)
- [x] Cache-Control headers in dev mode
- [x] `<link>` tag auto-hoisting (body → head)

### v0.21.x (Next)

**ATE Advanced**
- [ ] L2 Oracle deep contract validation (Zod schema parsing + edge case generation)
- [ ] L3 Oracle behavioral verification (LLM-based state change assertions)
- [ ] ATE Watch mode (`mandu test --watch`)
- [ ] Accessibility (a11y) testing with `@axe-core/playwright`
- [ ] devtools/brain/watcher test coverage (currently 0)
- [ ] CI E2E job + codecov integration

**Build & Integration** *(Astro/Fresh-inspired)*
- [ ] Build Hooks (start/setup/done lifecycle)
- [ ] Plugin API for build extensions
- [ ] Integration hooks with timeout warnings & dedicated logger
- [ ] Bundle analyzer with size reporting
- [ ] `bun --hot` server module integration

**Data Layer** *(Astro-inspired)*
- [ ] Loader API with LoaderContext (store, meta, logger, watcher)
- [ ] File Loader & API Loader implementations
- [ ] Cache Store adapter (Redis, KV)
- [ ] Content collections with type-safe queries

### v0.22.x (Future)

**AOT Optimization** *(Elysia-inspired)*
- [ ] AOT Handler Generation (runtime precompile)
- [ ] Context inference for minimal runtime overhead
- [ ] JIT/AOT mode selection (`mandu build --aot`)

**Advanced Hydration** *(Qwik/Fresh-inspired)*
- [ ] React Fast Refresh integration (state-preserving HMR)
- [ ] Client Reviver (DOM marker-based restoration)
- [ ] Resumable POC / QRL-lite (lazy event handler loading)
- [ ] Serializer Registry (pluggable type serializers)

**Realtime** *(Phoenix-inspired)*
- [ ] WebSocket Channels (join/handle_in/handle_out pattern)
- [ ] Channel/Socket separation model
- [ ] Presence tracking
- [ ] Pub/Sub with adapters

**Developer Experience**
- [ ] Error overlay in development with source maps
- [ ] Enhanced TypeScript inference for Filling chains
- [ ] More project templates (e-commerce, blog, dashboard)
- [ ] Visual route inspector

---

## Test Coverage

The package suite is script-driven so the README does not carry a stale static
test count.

| Scope | Command |
|-------|---------|
| All maintained packages | `bun run test:packages` |
| Template smoke tests | `bun run test:smoke` |
| Publish readiness | `bun run check:publish` |
| One-off Bun test run | `bun test <path>` |

---

## Documentation

- `docs/README.md` — Documentation index
- `docs/api/api-reference.md` — API reference
- `docs/status.md` — Implementation status
- `docs/specs/` — Technical specifications

---

## Contributing

```bash
git clone https://github.com/konamgil/mandu.git
cd mandu && bun install
bun test
```

---

## Why "Mandu"?

Like a dumpling (mandu), the **wrapper (generated code) stays consistent** while the **filling (slot) can vary infinitely**. No matter how much agents code, the dumpling shape (architecture) is preserved. 🥟

---

## License

MPL-2.0

---

<p align="center">
  <sub>Built with 🥟 by the Mandu Team</sub>
</p>
