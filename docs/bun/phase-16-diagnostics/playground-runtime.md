---
title: "Phase 16 R0 — Browser Playground runtime 설계"
status: research
created: 2026-04-19
author: Phase 16 R0 diagnostics agent
depends_on:
  - docs/bun/phases-11-plus.md §Phase 16 (optional, 2 weeks)
---

> **Status update (2026-04-19)**: Phase 16.2 scaffolding landed in
> `packages/playground-runner/`. The Worker + Durable Object + adapter
> layer is code-complete against the MockAdapter; `CloudflareSandboxAdapter`
> is a stub that throws loudly until live wiring is finished (§6 below).
> See `docs/playground/deployment.md` for the operator runbook and
> `docs/playground/security.md` for the hardening checklist. The scaffold
> is `private: true` and NOT on the npm publish pipeline.

# Phase 16 R0 — Browser Playground runtime

## 0. Executive summary

**Verdict: Cloudflare Sandbox SDK (officially-supported, Bun-preinstalled).**

- WebContainers / Sandpack / Nodebox는 **Bun 미지원** (WebContainers 이슈 #1891 2025-06부터 open, 진전 없음).
- **Cloudflare Sandboxes GA 2026-04-13** — 공식 base Dockerfile `FROM oven/bun:${BUN_VERSION}`, Workers-side TypeScript SDK (`exec`, `writeFile`, `proxyToSandbox`), 이그레스 프록시.
- 이로써 원래 딜레마 ("브라우저에서 Bun 실행 불가") 해소.

**Phase 계획**:
1. **16.1 Static preview + share URL** (2-3일, zero backend)
2. **16.2 Live Bun runtime on Cloudflare Sandboxes** (2주, ~$8/month cost ceiling)
3. **16.3 Tutorial with live code cells**

## 1. Browser runtime feasibility

### 1.1 @webcontainer/api (StackBlitz)
- Bun 지원 없음, 로드맵에도 없음. 공식 이슈 `stackblitz/webcontainer-core#1891` (2025-06, open).
- Node-fallback은 Phase 15 Workers adapter 매핑 테이블과 동일 — Bun-true 세만틱 잃음.
- **불가**.

### 1.2 Sandpack / Nodebox (CodeSandbox)
- Nodebox는 Node.js만 in-browser 실행. Bun 지원 없음.
- 커스텀 runtime hook 없음.
- **불가**.

### 1.3 @stackblitz/sdk
- 동일한 WebContainer 기반 → 1.1과 같은 문제.

### 1.4 Bun WASM
- Oven-SH: WASM 포트 계획 없음. `packages/bun-wasm`는 bundler만 (esbuild-wasm 같은 범위), runtime 아님.
- **불가**.

### 1.5 Cloudflare Sandboxes (선택)
- **GA 2026-04-13**.
- Base image: `oven/bun:${BUN_VERSION}` + Node 20 LTS preinstalled.
- Workers SDK: `sandbox.exec('bun run /work/index.ts')`, `sandbox.writeFile`, `sandbox.proxyToSandbox(req)`.
- 이그레스: 프로그래머블 outbound proxy (credential injection, per-host allow/deny).
- Cold start: sub-second (bare), 30s (npm install 포함 E2E).

## 2. Server-side sandbox economics

### 2.1 Cloudflare Containers / Sandboxes (primary)
- Workers Paid $5/month 베이스 필수.
- Memory: 25 GiB-hours 포함, +$0.0000025/GiB-sec.
- CPU: 375 vCPU-minutes 포함, +$0.000020/vCPU-sec (active-CPU billing).
- Egress: NA/EU 1 TB 무료, 이후 $0.025/GB.
- **모델링**: 30k runs/month, 256 MiB, 5s CPU avg, 30s wall, 10 MB egress
  - CPU overage: ~$2.55
  - Memory overage: ~$0.34
  - **총 ~$8/month** (Workers Paid $5 + 비용 $3)
- Scale-to-zero (idle snapshot free).
- **Limits**: standard-4 max 4 vCPU / 12 GiB / 20 GB.

### 2.2 Fly.io Machines (fallback)
- ~$0.0027/hr for 256 MB shared. 30k runs/month × 30s = $0.67 compute.
- Blocker: 수동 seccomp/egress 구축, 머신 시작 rate limit.

### 2.3 Drop: Railway/Render (idle-heavy), self-host Firecracker (ops overhead too high).

### 2.4 추천
- **Primary**: Cloudflare Sandboxes (cost ceiling **$25/month**)
- **Fallback**: Fly.io Machines (adapter 인터페이스 뒤)

## 3. Security boundary design

| 위협 | CF Sandbox 방어 | Mandu-side |
|---|---|---|
| 파일 read (/etc/passwd) | 격리 컨테이너 | `/work` lock, `..` 거부 |
| HTTP exfiltration | outbound Worker allowlist | deny-by-default |
| CPU DoS | active-CPU billing + `exec` timeout | 30s wall + 15s CPU ceiling |
| Memory bomb | 256 MiB cap | OOM → "Out of memory" |
| 메타데이터 pivot | CF no IMDS | egress proxy default-deny |
| Abuse flood | CF bot management | Turnstile + IP token bucket (20/hr) |
| 크립토 마이닝 | CPU cap + idle kill | coin host denylist |

**구체 방어**:
- `AbortSignal.timeout(30_000)` wall-clock
- `dev` instance (0.5 vCPU / 512 MiB) 선호
- Egress allowlist: `localhost`, `127.0.0.1`, sandbox-self only
- Output cap: 64 KiB stdout/stderr, ANSI strip
- `<iframe sandbox="allow-scripts">` (NOT `allow-same-origin`), CSP `frame-ancestors https://mandujs.com`

## 4. Editor + UX

### 4.1 Editor: **CodeMirror 6** (Monaco 제외)
- CM6: 80 KB gz (tsx + search + autocomplete)
- Monaco: 700 KB+ gz 최소
- `@codemirror-toolkit/react` 1.5 KB gz
- Shiki twoslash는 mandujs.com이 이미 dep

### 4.2 Code share
- `lz-string.compressToEncodedURIComponent` (~3.4 KB lib)
- 1 KB TSX → ~400-600 chars (안전 URL 길이)
- `#code=...` hash fragment (서버에 안 감)

### 4.3 Preview 전략
- **16.1 (static)**: mandujs.com 빌드 시점에 SSR prerender → `public/playground/<slug>.html` → `<iframe sandbox>`로 로드
- **16.2 (live)**: Worker → Sandbox → `proxyToSandbox`가 `sbx-<id>.mandujs.dev` 반환 → iframe 교체 + SSE로 stdout

### 4.4 File system UX
- MVP: **single-file** `page.tsx`
- 16.2+: fixed 3-file 탭 (page + filling + island)

## 5. Phase 16.1 MVP (static, no server)

### 5.1 Demo source 매핑
| Demo | 사용 여부 |
|---|---|
| `demo/starter/` | **YES** (minimal SSR+hydration) |
| `demo/todo-app/` | 부분 (routes/todos만) |
| `demo/auth-starter/` | **YES** (filling+session) |
| `demo/ai-chat/` | **YES** (island pattern) |
| `demo/edge-workers-starter/` | **YES** (pure SSR) |
| `demo/desktop-starter/` | NO (Tauri) |

### 5.2 5 starter examples
1. **Hello Mandu** — minimal page.tsx, SSR
2. **Filling loader** — `Mandu.filling<T>().loader()` pattern
3. **Island hydration** — `data-island` + counter island
4. **API + Zod contract** — route handler + validation
5. **Auth filling** — session cookie reading

### 5.3 Preview 전략 (static)
- `scripts/prebuild-examples.ts` → CI에서 각 예제 `mandu build` 실행 → `public/playground/<slug>/` HTML+CSS
- 로컬 에디터가 정적 preview 로드 (첫 paint 즉시)

### 5.4 파일 계획 (mandujs.com only)

**신규**:
- `app/[lang]/playground/page.tsx` — playground route
- `app/[lang]/playground/editor.island.tsx` — CodeMirror + preview + share
- `app/[lang]/playground/preview-frame.tsx` — iframe sandbox wrapper
- `src/shared/utils/client/playground-share.ts` — lz-string encode/decode
- `src/shared/utils/client/playground-examples.ts` — `{slug, title, file, prerenderedHtml}[]`
- `src/client/features/playground/index.ts` — FSD barrel
- `content/playground/examples/{hello-mandu,filling-loader,island-hydration,api-zod,auth-filling}.tsx`
- `scripts/prebuild-examples.ts`
- `public/playground/<slug>/{index.html,style.css}` (generated)

**수정**:
- `package.json` — `codemirror`, `@codemirror/lang-javascript`, `@codemirror/theme-one-dark`, `@codemirror-toolkit/react`, `lz-string` 추가
- `app/[lang]/layout.tsx` — nav "Playground" 링크
- i18n `playground.*` 키
- **mandu.config.ts: 변경 없음**

**Mandu core 변경 없음** — 순수 소비자 레이어.

### 5.5 DoD (Phase 16.1)
- [ ] 5 예제 렌더 결과 == `bun dev` (Playwright screenshot diff)
- [ ] 편집 → preview 로컬 업데이트만 (네트워크 없음)
- [ ] Share URL roundtrip (Playwright: URL → editor 복원)
- [ ] Lighthouse ≥ 95 on `/playground`
- [ ] 방문자 시점 Bun runtime 의존도 0
- [ ] CSP iframe SecurityHeaders A 등급

## 6. Phase 16.2 live-run scope

### 6.1 API 계약
```
POST /api/playground/run
body { code, example }
SSE:
  event: sandbox-url    data: "https://sbx-<id>.mandujs.dev"
  event: stdout/stderr  data: "<chunk>"
  event: exit           data: { code, durationMs }
  event: error          data: { reason: "timeout"|"oom"|"compile" }
```

### 6.2 Security 구체
- Container: CF Sandbox base + layer (`bun install @mandujs/core react react-dom` into `/vendor`)
- Worker front: Turnstile required after 5 runs/15min/IP
- Sandbox lifecycle: one DO per sandbox-id, `alarm(30s)` kill
- Network: egress Worker allowlist only (`jsr.io`, same-origin)
- Logging: run IDs + exit codes only (no user code)

### 6.3 DoD (Phase 16.2)
- [ ] "Filling loader" live run == local `bun dev` `renderedAt`
- [ ] Cold start ≤ 2s (warm pool 3)
- [ ] Abuse: 1000 req/1 IP → ≤20 통과
- [ ] OOM test clear
- [ ] Egress block test clear
- [ ] $/week budget tracking + alert $10/week

## 7. Phase 16.3 tutorial

**"Build a todo list in Mandu"** — 5 code cells:
1. Routing (add `app/todos/page.tsx`)
2. Filling loader (`.filling().loader()`)
3. Island (`<TodoInput />`)
4. API + Zod contract (POST handler + shared schema)
5. Deploy narrative (config target switch, no runtime change)

누적 filesystem, reset per cell. Content: `content/playground/tutorial/*.mdx`.

## 8. Dropped scope

- WebContainers / StackBlitz SDK (Bun 미지원)
- Sandpack (Node only)
- Bun WASM (불가)
- Self-host Firecracker (ops overhead)
- Monaco (bundle size)
- Multi-file project editor (단일 파일 per example)
- "Publish to Cloudflare" 버튼 (Phase 13 territory)
- AI chat in playground (Phase 14)

## 9. Open decisions (defaults)

| ID | 질문 | Default |
|---|---|---|
| D16-A | Editor | **CodeMirror 6** (80KB) |
| D16-B | Runtime sandbox | **Cloudflare Sandboxes primary + Fly.io fallback** |
| D16-C | MVP scope | **Static (16.1) → Live (16.2)** |
| D16-D | Example source | **content/playground/examples/*.tsx in mandujs.com** (decoupled from `demo/`) |
| D16-E | Mandu core 변경 | **Zero** (필요시 `--playground-snapshot` 플래그만 future) |

## 10. References

- [WebContainer #1891 Bun request](https://github.com/stackblitz/webcontainer-core/issues/1891)
- [Cloudflare Sandboxes GA 2026-04-13](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/)
- [Cloudflare Sandbox SDK repo](https://github.com/cloudflare/sandbox-sdk)
- [Cloudflare Sandbox Dockerfile](https://developers.cloudflare.com/sandbox/configuration/dockerfile/)
- [CF Containers pricing](https://developers.cloudflare.com/containers/pricing/)
- [CF Sandbox outbound auth](https://blog.cloudflare.com/sandbox-auth/)
- [CodeMirror 6 bundle](https://codemirror.net/examples/bundle/)
- [lz-string](https://github.com/pieroxy/lz-string)
- [MDN sandboxed iframes](https://web.dev/articles/sandboxed-iframes)
