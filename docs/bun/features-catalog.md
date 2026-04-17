---
title: "Bun 1.3.x Feature Catalog (for Mandu maintainers)"
status: research
audience: Mandu core team
bun_version: "1.3.12 (2026-04-17 기준)"
updated: "2026-04-17"
---

# Bun 1.3.x Feature Catalog

> Bun은 런타임, 번들러, 테스트 러너, 패키지 매니저를 하나의 바이너리로 통합한 **올인원 JS/TS 툴킷**입니다. 이 문서는 1.3.x 표면적을 14개 도메인으로 분해해, Mandu(풀스택 Bun 프레임워크)가 **중복 구현 중인 항목**과 **아직 활용하지 않은 네이티브 기능**을 식별하기 위한 레퍼런스입니다.

- 본 문서의 모든 사실은 `https://bun.com/docs` 및 `https://bun.com/blog` 를 1차 출처로 삼았습니다. 각 항목 끝과 문서 말미 각주에서 URL을 명시합니다.
- 🆕 **(1.3.x)** 는 1.3 ~ 1.3.12 구간에 추가·확장된 기능입니다.
- 🔥 = 현재 Mandu가 즉시 도입/대체를 검토할 가치가 큼 (필자 판단).
- `> 확인 필요 (source TBD)` 는 3회 이내 공식 소스로 검증되지 않은 항목입니다.

---

## 하이라이트 — Mandu가 "즉시 흡수" 할 후보 Top 10

Mandu는 이미 자체 라우터, island hydration, 빌드 파이프라인, guard 프리셋 등을 갖추고 있으므로, 아래 항목은 **재발명 중지 또는 네이티브로 대체**를 적극 검토할 가치가 있습니다.

| # | 기능 | 이유 |
|---|------|------|
| 1 | 🔥 `Bun.serve({ routes })` 네이티브 라우팅 (1.2.3+) & `req.params` / 메서드별 핸들러 | Mandu의 SSR 서버 어댑터와 겹침. 정적 `Response`/`Bun.file()`도 route object 값으로 직접 가능. |
| 2 | 🔥 `Bun.serve` HTML entrypoint + `development: { hmr, console }` (1.3+) | 프론트엔드 HMR과 브라우저 콘솔 터미널 스트리밍이 기본 제공. Mandu dev 서버의 WebSocket HMR 채널과 중복 가능성. |
| 3 | 🔥 `Bun.CookieMap` + `request.cookies` 자동 `Set-Cookie` (1.3) | 별도 cookie 파서 없이 Map API 사용, 변경 시 응답 헤더에 자동 반영. |
| 4 | 🔥 `Bun.sql` 통합 어댑터 (Postgres/MySQL/SQLite) (1.3에서 SQLite·MySQL 확장) | DB 추상화 레이어 없이 tagged template + 트랜잭션/프리페어/풀링 기본 제공. |
| 5 | 🔥 `Bun.CSRF.generate/verify` (1.3) & `Bun.secrets` (1.3, 실험적) | 자체 CSRF/시크릿 저장 구현을 대체. |
| 6 | `Bun.build({ plugins })` + `onBeforeParse` 네이티브 훅 | Mandu 번들러 훅이 JS 단일 스레드인 경우, NAPI 네이티브 훅으로 zero-copy 변환 가능. |
| 7 | `--compile --target=browser` (1.3.10) / 풀스택 `--compile` (1.2.17+) | Mandu 프로젝트를 단일 실행 파일로 배포 가능 (Windows 메타데이터·code signing까지). |
| 8 | `bun:test` — `test.concurrent`, `mock.module`, `--retry`, `--randomize/--seed` (1.3) | Mandu 코어 테스트가 Jest 계열이라면 `bun:test` 네이티브로 교체 시 속도 이득. |
| 9 | `bun install --linker=isolated` (워크스페이스 기본, 1.3) + Catalogs | Mandu 모노레포의 phantom dependency 방지, `workspace:*`·`catalog:` 자동 치환. |
| 10 | `import.meta.hot` API (Vite 호환) + `bun:beforeUpdate`/`afterUpdate` 이벤트 | Mandu 자체 HMR 프로토콜을 표준 API에 맞출 수 있음. |

비고: **`Bun.cron` 인프로세스 스케줄러 (1.3.12)** 는 스케줄러가 필요하면 외부 의존성 없이 바로 쓸 수 있는 보너스 카드.

---

## 1. HTTP 서버

Mandu의 런타임 코어가 가장 많이 의존하는 영역.

### `Bun.serve({ routes })` — 객체 기반 라우팅
- **Stability**: stable
- **Introduced**: Bun 1.2.3 (매개변수화 라우팅 + 메서드별 핸들러). 1.3 에서 HTML entrypoint·`development` 옵션으로 확장.
- **Summary**: 라우트를 객체 리터럴로 선언. 값은 `Response` / `Bun.file()` / 함수 / 메서드별 핸들러 맵 / HTML 모듈 중 어느 것이든 가능.
- **Signature/Example**:
  ```ts
  Bun.serve({
    routes: {
      "/api/status": new Response("OK"),                  // 정적
      "/users/:id": req => Response.json({ id: req.params.id }),
      "/api/posts": {
        GET: () => new Response("List posts"),
        POST: async req => Response.json(await req.json()),
      },
      "/api/*": Response.json({ message: "Not found" }, { status: 404 }),
      "/favicon.ico": Bun.file("./favicon.ico"),           // 정적 파일 (지연 로드)
    },
  });
  ```
- **Why a web framework cares**: 별도 라우팅 패키지 없이 `:param`, wildcard, method-specific 핸들러 제공. `server.reload({ routes })` 로 핫 스왑 가능.

### Path parameters & wildcards
- **Stability**: stable
- **Introduced**: Bun 1.2.3
- **Summary**: `:name` 동적 세그먼트, `/*` 와일드카드. `req.params` 로 접근.
- **Example**:
  ```ts
  "/org/:org/repo/:repo": req => {
    const { org, repo } = req.params;
    return new Response(`${org}/${repo}`);
  }
  ```
- **Why a web framework cares**: 네이티브 라우팅으로 regex 매처를 직접 작성할 필요 없음.

### `server.reload(options)` / `server.stop()` / `server.requestIP()` / `server.timeout(req, s)`
- **Stability**: stable
- **Introduced**: `reload` 1.0+, `timeout` 1.1.25 이후 refining.
- **Summary**: 서버 재시작 없이 `fetch`, `error`, `routes` 교체 가능. 요청별 idle timeout 설정. 클라이언트 IP 추출.
- **Example**:
  ```ts
  const server = Bun.serve({ ... });
  server.reload({ routes: { "/new": new Response("v2") } });
  server.timeout(req, 0); // SSE: idle timeout 비활성화
  const { address, port } = server.requestIP(req) ?? {};
  ```
- **Why a web framework cares**: HMR 서버, 그레이스풀 셧다운, 요청별 타임아웃에 직접 활용 가능.

### Streaming responses (ReadableStream, async generator)
- **Stability**: stable
- **Introduced**: 1.0+, async generator body는 1.2+.
- **Summary**: `Response` body로 async generator 또는 ReadableStream 허용. SSE·chunked JSON·스트리밍 SSR에 적합.
- **Example**:
  ```ts
  return new Response(
    (async function* () {
      for (let i = 0; i < 10; i++) yield `data: ${i}\n\n`;
    })(),
    { headers: { "Content-Type": "text/event-stream" } }
  );
  ```
- **Why a web framework cares**: Mandu streaming SSR이 이 패턴을 그대로 쓸 수 있음.

### Static responses (`Bun.file`, Blob)
- **Stability**: stable
- **Introduced**: 1.0+
- **Summary**: 라우트 값으로 `Bun.file("./path")` 를 그대로 넘기면 지연 로딩 + 적절한 Content-Type 으로 응답.
- **Example**:
  ```ts
  "/robots.txt": Bun.file("./public/robots.txt")
  ```
- **Why a web framework cares**: 정적 자산 핸들러 재발명 불필요.

### HTTPS / TLS
- **Stability**: stable
- **Introduced**: 1.0+
- **Summary**: `tls: { cert, key, ca, passphrase, serverName, lowMemoryMode }`. SNI, 암호화된 키, 멀티 호스트 인증서 지원.
- **Example**:
  ```ts
  Bun.serve({
    tls: {
      cert: Bun.file("./cert.pem"),
      key: Bun.file("./key.pem"),
      passphrase: Bun.env.CERT_PASS,
    },
    fetch(req) { return new Response("secure"); }
  });
  ```
- **Why a web framework cares**: HTTPS 서버 부트스트랩에 별도 http2/tls 모듈 래핑 불필요.

### HTTP/2 support status
- **Stability**: partial (Node.js compat 계층)
- **Introduced**: `node:http2` 클라이언트·서버 모두 구현됨. gRPC 테스트의 95.25% 통과.
- **Summary**: `Bun.serve` 자체는 HTTP/1.1 중심. HTTP/2는 `node:http2` 를 통해 사용. `allowHTTP1`, `enableConnectProtocol`, `pushStream` 미구현.
- **Why a web framework cares**: 현재 `Bun.serve` 로는 HTTP/2 서버 선언이 불가 → Mandu가 HTTP/2/3 를 지원하려면 `node:http2` 어댑터 필요. (Node compat 페이지 참조)

### Body parsing — `req.json()`, `req.text()`, `req.formData()`, `req.arrayBuffer()`, `req.bytes()`, `req.blob()`
- **Stability**: stable (Web standard)
- **Introduced**: 1.0+
- **Summary**: Fetch Request 의 표준 메서드. `formData()` 는 multipart 자동 파싱.
- **Why a web framework cares**: 별도 body parser 미들웨어 불필요. 파일 업로드도 `req.formData().then(fd => fd.get("file"))`.

### `request.cookies` (CookieMap) 및 자동 `Set-Cookie`
- **Stability**: stable
- **Introduced**: 🆕 (1.3) — Bun.serve 에서 `req.cookies` 가 `CookieMap` 인스턴스로 노출되고, 변경 시 자동 `Set-Cookie` 부여.
- **Summary**: Request에서 Cookie 를 읽고, 같은 map 에 set 하면 응답 헤더에 자동 반영.
- **Example**:
  ```ts
  routes: {
    "/": req => {
      const session = req.cookies.get("session");
      req.cookies.set("visited", "true");
      return new Response("ok");
    }
  }
  ```
- **Why a web framework cares**: cookie 파싱·직렬화 미들웨어 대체. 섹션 10 참조.

### `development: { hmr, console, chromeDevToolsAutomaticWorkspaceFolders? }`
- **Stability**: stable
- **Introduced**: 🆕 (1.3)
- **Summary**: `hmr: true` 로 HMR, `console: true` 로 브라우저 `console.*` 로그를 터미널로 스트리밍.
- **Example**:
  ```ts
  Bun.serve({
    development: { hmr: true, console: true },
    routes: { "/": homepage /* index.html */ },
  });
  ```
- **Why a web framework cares**: 개발 서버에서 자체 WS 채널로 로그를 포워딩하고 있다면 내장 기능으로 교체 가능.

### 메트릭 & 라이프사이클 (`pendingRequests`, `pendingWebSockets`, `subscriberCount(topic)`)
- **Stability**: stable
- **Introduced**: 1.1+
- **Summary**: 읽기 전용 서버 속성으로 실시간 로드/토픽 구독자 수 조회.

---

## 2. WebSocket

### `server.upgrade(req, { data, headers })`
- **Stability**: stable
- **Introduced**: 1.0+
- **Summary**: HTTP 요청을 WebSocket 으로 업그레이드. `data` 는 연결마다 보존되는 컨텍스트.
- **Example**:
  ```ts
  Bun.serve({
    fetch(req, server) {
      if (server.upgrade(req, { data: { userId: getUser(req) } })) return;
      return new Response("Upgrade failed", { status: 500 });
    },
    websocket: {
      open(ws) { ws.send(`welcome ${ws.data.userId}`); },
      message(ws, msg) { ws.send(msg); },
    },
  });
  ```
- **Why a web framework cares**: 업그레이드 + 컨텍스트 부여가 한 호출로 끝.

### Pub/Sub topics (`subscribe`, `publish`, `unsubscribe`, `isSubscribed`)
- **Stability**: stable
- **Introduced**: 1.0+
- **Summary**: uWebSockets 기반 토픽 브로드캐스트. `ws.publish(topic, msg)` 는 **자기 제외**, `server.publish(topic, msg)` 는 모든 구독자에 전송.
- **Example**:
  ```ts
  open(ws)        { ws.subscribe("room:" + ws.data.room); },
  message(ws, m)  { ws.publish("room:" + ws.data.room, m); },
  close(ws)       { /* 자동 unsubscribe */ },
  ```
- **Why a web framework cares**: 채팅/협업 기능에 Redis pub/sub 없이도 단일 노드 내 브로드캐스트 가능.

### Compression — `perMessageDeflate`
- **Stability**: stable
- **Introduced**: 1.0+, 협상 로직 🆕 (1.3) RFC 6455 subprotocol negotiation 개선.
- **Summary**: `perMessageDeflate: true | { compress, decompress }` + `.send(msg, compress)` 로 메시지별 압축 제어.
- **Example**:
  ```ts
  websocket: { perMessageDeflate: { compress: "shared", decompress: "shared" } }
  ```

### Backpressure — `send()` 반환값
- **Stability**: stable
- **Summary**: `-1` enqueued, `0` dropped, `>0` bytes sent. `backpressureLimit` + `closeOnBackpressureLimit` 로 한계 제어. `drain(ws)` 핸들러로 재개 알림.

### Per-connection data (`ws.data`)
- **Stability**: stable
- **Summary**: 업그레이드 시 넘긴 `data` 가 타입-안전하게 보존 (`websocket<T>` 의 `data: T`).

### Ping/pong & timeouts
- **Stability**: stable
- **Summary**: `sendPings: true` (기본), `idleTimeout: 120s`, `maxPayloadLength: 16MB`, `publishToSelf: false`.

### Subprotocol negotiation / header overrides
- **Stability**: stable
- **Introduced**: 🆕 (1.3) — RFC 6455 준수 subprotocol 협상, 클라이언트에서 `Host`, `Sec-WebSocket-Key` 등 특수 헤더 오버라이드 가능.
- **Example**:
  ```ts
  new WebSocket("ws://host", ["chat.v2"]);
  ```

---

## 3. 번들러 / 프론트엔드

### `Bun.build(options)`
- **Stability**: stable
- **Introduced**: 1.0+ (대규모 개선 지속)
- **Summary**: JS/TS/JSX/TSX, CSS, HTML, JSON, TOML, YAML, TXT 로더 내장. ESM/CJS/IIFE 출력.
- **Signature**:
  ```ts
  await Bun.build({
    entrypoints: ["./src/index.tsx"],
    outdir: "./dist",
    target: "browser" | "bun" | "node",
    format: "esm" | "cjs" | "iife",
    splitting: true,
    minify: true, // 또는 { whitespace, syntax, identifiers }
    sourcemap: "none" | "linked" | "inline" | "external",
    external: ["react"],
    packages: "bundle" | "external",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".png": "file" },
    naming: "[dir]/[name]-[hash].[ext]",
    banner: '"use client"',
    plugins: [myPlugin],
    jsx: { runtime: "automatic", importSource: "react" },
    drop: ["console", "debugger"],
    tsconfig: "./tsconfig.build.json",
  });
  ```
- **Why a web framework cares**: Mandu 자체 번들 파이프라인과 직접 대응.

### `Bun.plugin(plugin)` / build.plugins
- **Stability**: stable
- **Hooks**: `onStart`, `onResolve({ filter, namespace })`, `onLoad({ filter, namespace })`, `onBeforeParse` (NAPI native, multi-thread), `onEnd(BuildOutput)`.
- **Loaders**: `js|jsx|ts|tsx|json|jsonc|toml|yaml|file|napi|wasm|text|css|html`.
- **Example**:
  ```ts
  Bun.plugin({
    name: "yaml",
    setup(build) {
      build.onLoad({ filter: /\.ya?ml$/ }, async args => ({
        contents: JSON.stringify(Bun.YAML.parse(await Bun.file(args.path).text())),
        loader: "json",
      }));
    },
  });
  ```
- **Why a web framework cares**: Mandu 의 guard / DNA / resource 훅을 Bun 네이티브 플러그인으로 옮기면 빌드 속도·다중 스레드 이점.

### CSS 번들링
- **Stability**: stable
- **Introduced**: 1.1+
- **Summary**: `.css` 를 `import` 하면 단일 스타일시트로 번들링. HTML entrypoint 의 `<link>` 자동 병합·hash 삽입.
- **Why a web framework cares**: 별도 PostCSS 파이프라인 필요성 감소.

### `--compile` standalone executables
- **Stability**: stable
- **Introduced**: 1.1+, 풀스택은 1.2.17+, `--target=browser` 단일 HTML 출력은 🆕 (1.3.10)
- **Summary**: 전체 프로젝트를 Bun 런타임과 함께 단일 실행 파일로 컴파일. 크로스 컴파일, Windows 메타데이터, macOS code signing 지원.
- **Signature**:
  ```bash
  bun build ./cli.ts --compile --outfile mycli \
    --target=bun-linux-x64-musl \
    --minify --sourcemap --bytecode
  ```
- **Windows 메타데이터**:
  ```ts
  Bun.build({ compile: { windows: { icon, title, publisher, version, hideConsole: true } } })
  ```
- **Asset embedding**: `import icon from "./icon.png" with { type: "file" }`
- **SQLite embedding**: `import db from "./my.db" with { type: "sqlite", embed: "true" }`
- **Why a web framework cares**: Mandu 앱을 Docker 없이 단일 바이너리로 배포하는 옵션.

### HTML imports (`bun ./index.html`)
- **Stability**: stable
- **Introduced**: 🆕 (1.3) — 프로덕션/dev 모드 통합
- **Summary**: HTML 파일을 import 하면 HTMLRewriter 로 `<script>`·`<link>` 를 자동 번들링·해시 처리·data URI 인라인.
- **Example**:
  ```ts
  import homepage from "./index.html";
  import dashboard from "./dashboard.html";
  Bun.serve({
    routes: { "/": homepage, "/dashboard": dashboard },
    development: { hmr: true, console: true },
  });
  ```
- **Why a web framework cares**: Vite/webpack 대체. Mandu 의 dev 서버가 HTML 스캔을 자체 구현하고 있다면 교체 가능.

### Frontend dev server (`bun index.html`)
- **Stability**: stable
- **Introduced**: 🆕 (1.3)
- **Summary**: HTML 파일을 직접 실행해 dev 서버 기동. HMR, React Fast Refresh, CSS 자동 번들링, source maps, 소스 온-디맨드 bundling.

### Bake (실험적 풀스택 프레임워크)
- **Stability**: experimental
- **Introduced**: early 2025 teasers; 1.3에서도 정식화 미완료
- **Summary**: Bun 공식 풀스택 프레임워크 프로젝트. 상세 공개 문서는 아직 제한적.
- **Note**: `> 확인 필요 (source TBD)` — bun.com/docs 상의 공식 Bake 페이지는 현재 라우팅되지 않음. 로드맵/블로그에서만 언급.

### `--hot` vs `--watch`
- **Stability**: stable
- **Introduced**: 1.0+ (네이티브 fs 워처는 🆕 1.3에서 kqueue/inotify/ReadDirectoryChangesW 로 교체)
- **Summary**: `--watch` 는 하드 재시작, `--hot` 은 소프트 리로드 (`globalThis` 보존, HTTP 서버 상속).
- **Example**:
  ```bash
  bun --hot server.ts     # 서버 소프트 리로드
  bun --watch test.ts     # 파일 변경 시 프로세스 재시작
  bun build --watch --no-clear-screen
  ```
- **Why a web framework cares**: Mandu dev 커맨드가 자체 프로세스 supervisor 를 갖고 있다면 `--hot` 으로 일부 대체 가능.

### `import.meta.hot` (HMR API)
- **Stability**: stable
- **Introduced**: 🆕 (1.3)
- **Summary**: Vite 호환 HMR 클라이언트 API. `accept(path|paths|cb)`, `dispose(cb)`, `data`, `on("bun:beforeUpdate")`, `off`, `prune` (WIP).
- **Example**:
  ```ts
  if (import.meta.hot) {
    import.meta.hot.accept(mod => console.log("new", mod));
    import.meta.hot.dispose(() => cleanup());
  }
  ```
- **Why a web framework cares**: Mandu 클라이언트가 자체 HMR 프로토콜 대신 표준 API 를 제공하면 사용자 경험·라이브러리 재사용성 향상.

### `bun init --react[=tailwind|shadcn]`
- **Stability**: stable
- **Introduced**: 🆕 (1.3)
- **Summary**: React 프로젝트 스캐폴딩. Tailwind/shadcn 프리셋 옵션.

---

## 4. 테스트 — `bun:test`

### `test`, `describe`, `expect`
- **Stability**: stable
- **Introduced**: 1.0+
- **Summary**: Jest 호환 API. `expect.extend`, snapshot, matcher 대부분 포함.

### 라이프사이클 훅
- **Stability**: stable
- **Summary**: `beforeAll`, `beforeEach`, `afterEach`, `afterAll` — test 파일 안이나 `--preload` 로 전역 적용.
- **Example**:
  ```ts
  import { beforeAll, afterAll } from "bun:test";
  beforeAll(async () => { await db.migrate(); });
  afterAll(async () => { await db.close(); });
  ```

### `mock()` / `jest.fn()` / `vi.fn()`
- **Stability**: stable
- **Summary**: 호출 추적 + `.mockImplementation`, `.mockReturnValue`, `.mockResolvedValue`, `.mockRejectedValue`, `.mockClear`, `.mockReset`, `.mockRestore`.
- **Example**:
  ```ts
  import { mock, expect } from "bun:test";
  const fn = mock(() => 42);
  fn(); fn();
  expect(fn).toHaveBeenCalledTimes(2);
  ```

### `spyOn(obj, method)`
- **Stability**: stable
- **Summary**: 원본 구현 유지하며 호출만 추적. `.mockImplementation` 로 덮어쓰기 가능.

### `mock.module(path, factory)`
- **Stability**: stable
- **Summary**: 모듈 자체를 mock (ESM/CJS/패키지/상대/절대 경로).
- **Example**:
  ```ts
  mock.module("./api", () => ({ fetchUser: mock(async id => ({ id })) }));
  ```
- **Why a web framework cares**: Mandu 런타임 모듈(resource, contract)을 테스트에서 교체.

### Snapshot testing
- **Stability**: stable
- **Summary**: `.toMatchSnapshot()`, `.toMatchInlineSnapshot()`. `--update-snapshots` 로 갱신. 🆕 (1.3) 인덴테이션 자동 정렬.

### Coverage
- **Stability**: stable
- **Summary**: `--coverage` + `text`, `lcov` 리포터. `--coverage-threshold`.

### `--watch` / concurrent runs
- **Stability**: stable
- **Introduced**: `test.concurrent` + `--concurrent --max-concurrency N` 🆕 (1.3)
- **Summary**: 병렬 실행 + `test.serial()` 로 강제 직렬. 전역 `--concurrent` 플래그 추가.
- **Example**:
  ```ts
  test.concurrent("A", async () => { ... });
  test.concurrent("B", async () => { ... });
  ```

### 신규 매처 & 옵션 🆕 (1.3)
- `toHaveReturnedWith`, `toHaveLastReturnedWith`, `toHaveNthReturnedWith`
- `expectTypeOf(...)` — TypeScript 타입 단위 검증
- `--randomize` / `--seed=N` — 재현 가능 랜덤 순서
- `--retry=N` — 실패 재시도 (1.3.10에서 기본값 설정 가능)
- `--bail`, `--test-name-pattern`, `--reporter=junit`

### `node:test` 호환
- **Stability**: stable
- **Introduced**: 🆕 (1.3)
- **Summary**: `import { test } from "node:test"` 도 bun:test 인프라를 사용. mocks/snapshot/timer 는 일부 미지원.

### Async stack traces
- **Introduced**: 🆕 (1.3)
- **Summary**: 비동기 호출 체인을 에러 메시지에 보존 — 디버깅 UX 대폭 개선.

---

## 5. 패키지 매니저

### Workspaces + `workspace:*` / `workspace:^` / `workspace:~`
- **Stability**: stable
- **Summary**: root `package.json` 의 `"workspaces"` 필드 (glob + 부정). 로컬 패키지 참조는 `"workspace:*"`, `"workspace:^"`, `"workspace:~"`, `"workspace:1.0.2"`.
- **Why a web framework cares**: Mandu 모노레포가 이미 사용 중.

### `bun install --filter <pattern>`
- **Stability**: stable
- **Summary**: 특정 워크스페이스만 선택 설치/스크립트 실행. `--filter "pkg-*" --filter "!pkg-c"`.

### Catalogs (`catalog:` / `catalog:name`)
- **Stability**: stable
- **Introduced**: 🆕 (1.3)
- **Summary**: 모노레포에서 버전 중앙화. root 의 `"catalog"` / `"catalogs": { testing: { ... } }` 정의 후 package 의 dep 값으로 `"catalog:"` / `"catalog:testing"` 참조.
- **Example**:
  ```jsonc
  // root package.json
  { "catalog": { "react": "^19.0.0" }, "catalogs": { "testing": { "jest": "30.0.0" } } }
  // packages/app/package.json
  { "dependencies": { "react": "catalog:", "jest": "catalog:testing" } }
  ```
- **Publish 시**: `bun publish` 가 자동으로 실제 버전으로 치환.
- **Why a web framework cares**: Mandu 의 core/cli/mcp 간 버전 sync 에 적합 (현재 `workspace:*` 와 병용 가능).

### Patches (`bun patch` + `bun patch --commit`)
- **Stability**: stable
- **Summary**: 노드모듈 패키지를 안전하게 수정 → git-friendly `.patch` 파일 생성. `patches/` 디렉토리 + `package.json.patchedDependencies`.
- **Example**:
  ```bash
  bun patch react@17.0.2
  # edit node_modules/react
  bun patch --commit react@17.0.2 --patches-dir=mypatches
  ```
- **Why a web framework cares**: React/ReactDOM shim 수정을 패치로 관리 가능 (현재 Mandu는 자체 generator 사용).

### `bun.lock` 텍스트 포맷
- **Stability**: stable
- **Introduced**: 1.1 후반 텍스트 lockfile 전환 (기본)
- **Summary**: 사람이 읽을 수 있는 text lockfile. `configVersion` 필드가 linker 기본값 결정 (v1.3.2 부터 `configVersion = 1` → isolated 기본).

### `bun install --linker <isolated|hoisted>`
- **Stability**: stable
- **Introduced**: 🆕 (1.3) — 워크스페이스에서 isolated 가 **기본**
- **Summary**: 선언되지 않은 의존성 접근 차단. `bunfig.toml [install] linker = "isolated"`.
- **Why a web framework cares**: phantom dependency 문제를 근원적으로 방지.

### `bun pm` 서브커맨드
- **Stability**: stable
- **Summary**:
  - `bun pm ls [--all]` — 설치된 dep 트리
  - `bun pm bin [-g]` — bin 디렉토리 경로
  - `bun pm cache [rm]` — 글로벌 캐시 경로/삭제
  - `bun pm hash`, `bun pm hash-string`, `bun pm hash-print`
  - `bun pm pack [--dry-run --destination --gzip-level]`
  - `bun pm version patch|minor|major|<v>` + git tag
  - `bun pm whoami`
  - `bun pm trust <pkg>` / `bun pm untrusted` / `bun pm default-trusted`
  - `bun pm migrate` — yarn/npm/pnpm lockfile 변환
  - `bun pm pkg get|set|delete|fix` (dot/bracket 표기)

### `bun publish` — workspace/catalog 자동 치환
- **Stability**: stable
- **Summary**: `workspace:*`, `catalog:` 프로토콜을 lockfile 기준 실제 버전으로 교체 후 npm 에 업로드. `--dry-run`, `--access public|restricted`, 2FA (web / `--auth-type=legacy` / `--otp 123456`), `NPM_CONFIG_TOKEN` 지원. **provenance**는 공식 문서 미언급 → `> 확인 필요 (source TBD)`.
- **Why a web framework cares**: Mandu 의 `scripts/publish.ts` 가 이미 `bun publish` 사용 중. catalog 도입 시 자동 치환됨.

### `bunx` vs `bun x` vs `--package`
- **Stability**: stable
- **Summary**: `bunx <cmd>` = `bun x <cmd>`. 🆕 (1.3) `bunx --package=<pkg>[@version] <bin>` — 다른 패키지의 바이너리 실행.
- **Example**: `bunx --package=typescript@5.5 tsc --noEmit`.

### 신규 CLI 커맨드 🆕 (1.3)
- `bun why <pkg>` — dep 체인 설명
- `bun update --interactive` — 인터랙티브 업데이트 (필터 지원)
- `bun audit` — CVE 스캔
- `bun info <pkg>` — 패키지 메타데이터
- `bun outdated --recursive` — 모든 워크스페이스 outdated

### Security Scanner API 🆕 (1.3)
- **Stability**: stable (플러그인 surface)
- **Summary**: `bunfig.toml` 의 `[install.security] scanner = "@acme/scanner"` 로 커스텀 스캐너 등록. `fatal` / `warn` 심각도, CI 에서는 즉시 실패.

### Minimum release age 🆕 (1.3)
- **Summary**: `minimumReleaseAge = 604800` (초) — 공급망 공격 완화용 신규 패키지 설치 지연.

### `bun install --os <name> --cpu <arch>`
- **Introduced**: 🆕 (1.3)
- **Summary**: 플랫폼별 optional dep 정확히 설치. Docker 멀티아키 빌드에 유용.

---

## 6. 파일 I/O

### `Bun.file(path | fd | URL, opts?)`
- **Stability**: stable
- **Summary**: 지연 로딩 파일 참조. 디스크를 즉시 읽지 않음.
- **Signature**:
  ```ts
  const f = Bun.file("foo.txt");
  f.size;       // bytes
  f.type;       // MIME
  await f.text();
  await f.json();
  await f.arrayBuffer();
  await f.bytes();         // Uint8Array
  f.stream();              // ReadableStream
  await f.exists();
  await f.delete();
  const w = f.writer({ highWaterMark: 1 << 20 });
  ```
- **Why a web framework cares**: 정적 라우트, SSR 템플릿 로드, 업로드 처리까지 단일 API.

### `Bun.write(dest, data)`
- **Stability**: stable
- **Summary**: 경로/FD/BunFile/URL 에 string, Blob, ArrayBuffer, TypedArray, Response 를 씀. 파일-파일 복사·스트리밍 복사 한 줄.

### FileSink (`file.writer()`)
- **Stability**: stable
- **Summary**: `write`, `flush`, `end`, `ref`, `unref` — 대용량 스트리밍 쓰기 최적화.

### `Bun.Glob`
- **Stability**: stable
- **Summary**: 🆕 (1.3.12) scan 2x 속도 개선, Windows 커널 필터로 2.4x 향상.
- **Signature**:
  ```ts
  const g = new Bun.Glob("**/*.ts");
  for await (const p of g.scan({ cwd: ".", dot: false, absolute: false, onlyFiles: true })) {}
  g.scanSync({ ... });
  g.match("src/index.ts");
  ```

### `Bun.FileSystemRouter`
- **Stability**: stable
- **Introduced**: 1.0+ (Next.js 스타일 라우팅)
- **Signature**:
  ```ts
  const router = new Bun.FileSystemRouter({
    dir: "./pages",
    style: "nextjs",
    assetPrefix: "_next/static/",
    fileExtensions: [".tsx", ".ts"],
  });
  const match = router.match(req); // { filePath, kind, pathname, params, query, src }
  router.reload();
  ```
- **Why a web framework cares**: Mandu 의 `fs-scanner` 가 이것과 역할이 겹침 — 특히 dynamic `[slug]`, catch-all `[[...]]` 처리.

### 네이티브 `fs.watch` 🆕 (1.3)
- **Summary**: 운영체제별 네이티브 API (kqueue/inotify/ReadDirectoryChangesW) 로 교체. FD 상한 자동 조정, 재사용. Polling 대비 극적 개선.
- **Why a web framework cares**: Mandu dev 서버의 fs 이벤트가 polling 기반이면 교체 가치.

### `node:fs` 호환성
- **Stability**: 🟢 완전 (Node.js 테스트 92% 통과)

---

## 7. 프로세스

### `Bun.spawn(cmd, opts)` / `Bun.spawnSync(...)`
- **Stability**: stable
- **Signature**:
  ```ts
  const proc = Bun.spawn(["tsc", "--noEmit"], {
    cwd, env, stdin: "pipe" | "inherit" | "ignore" | Blob | ReadableStream | Bun.file(...) | fd,
    stdout: "pipe" | "inherit" | Bun.file(...),
    stderr: "pipe",
    ipc: (msg, sub) => {},
    serialization: "json" | "advanced",
    onExit: (sub, code, signal, err) => {},
    signal: AbortSignal,
    timeout: 5000,
    killSignal: "SIGTERM",
  });
  proc.stdin.write("data"); proc.stdin.end();
  const out = await proc.stdout.text();
  const usage = proc.resourceUsage();
  await proc.exited;
  ```
- **Why a web framework cares**: CLI 내부에서 외부 툴 호출, 서브프로세스 테스트 러너 구동에 최적화.

### IPC
- **Summary**: `subprocess.send(msg)` / `process.on("message")`. Bun ↔ Node.js 간에는 `serialization: "json"` 권장.

### `Bun.$` (Shell)
- **Stability**: stable
- **Summary**: Zig 로 구현된 크로스 플랫폼 셸. 자동 이스케이프, bash 유사 리다이렉트/파이프, JS 값 인터폴레이션, 내장 명령 (`cd`, `ls`, `rm`, `cat`, `mkdir`, `mv`, `which`, `basename`, `dirname`, `yes`, `seq` 등).
- **Signature**:
  ```ts
  import { $ } from "bun";
  const text = await $`echo ${userInput}`.text();
  const json = await $`curl -s ${url}`.json();
  for await (const line of $`cat file.txt`.lines()) {}
  await $`rm -rf ${dir}`.quiet();
  const { stdout, exitCode } = await $`false`.nothrow();
  $.cwd("/tmp"); $.env({ FOO: "bar" }); $.throws(false);
  ```
- **Why a web framework cares**: CLI 도구·DX 스크립트에서 child_process + cross-env 대체 가능.

---

## 8. 데이터베이스/스토리지

### `bun:sqlite`
- **Stability**: stable
- **Introduced**: 1.0+ (better-sqlite3 대비 3–6x)
- **Signature**:
  ```ts
  import { Database } from "bun:sqlite";
  const db = new Database("app.db", { readonly: false, create: true, safeIntegers: false, strict: false });
  const stmt = db.query("SELECT * FROM users WHERE id = ?1");
  stmt.all(1); stmt.get(1); stmt.run(1); stmt.values(); // rows[][]
  for (const row of stmt.iterate()) {}
  stmt.as(UserClass);
  const tx = db.transaction(items => { for (const i of items) stmt.run(i); });
  tx.immediate(items); tx.exclusive(items); tx.deferred(items);
  db.run("PRAGMA journal_mode = WAL;");
  const bytes = db.serialize(); Database.deserialize(bytes);
  db.loadExtension("myext");
  ```

### `Bun.sql` — Postgres 기본 + MySQL/MariaDB/SQLite 🆕 (1.3 통합)
- **Stability**: stable
- **Introduced**: Postgres 는 1.1.25+; MySQL/MariaDB/SQLite 어댑터 통합은 🆕 (1.3).
- **Signature**:
  ```ts
  import { sql, SQL } from "bun";
  // 기본(Postgres): DATABASE_URL/POSTGRES_URL 자동
  await sql`SELECT * FROM users WHERE id = ${userId}`;

  // 어댑터 지정
  const my = new SQL({ adapter: "mysql", hostname, port: 3306, database, max: 20, idleTimeout: 30, ssl: "prefer", onconnect: c => {} });
  const lite = new SQL("sqlite://app.db");

  // 고급
  await sql`UPDATE users SET ${sql(user, "name", "email")}`;        // 동적 컬럼
  await sql`WHERE id IN ${sql([1,2,3])}`;                            // 배열 확장
  await sql`VALUES (${sql.array(["red","blue"])})`;                  // PG 배열
  await sql.begin(async tx => { await tx`INSERT ...`; });            // 트랜잭션
  await sql`SELECT 1; SELECT 2;`.simple();                           // 멀티 스테이트먼트 (PG)
  await sql.file("./queries/select-users.sql", [param]);
  await sql.unsafe(rawSql, params);                                  // 이스케이프 주의
  ```
- **Why a web framework cares**: ORM 없이도 타입 안전한 SQL + 풀링·트랜잭션 기본. Drizzle/Prisma 와도 연계 가능.

### `Bun.redis` / `RedisClient`
- **Stability**: stable (pub/sub 은 일부 experimental)
- **Introduced**: 1.2.20 전후, 🆕 (1.3) 66 commands + Pub/Sub + 자동 재연결 + 7.9x 속도.
- **Signature**:
  ```ts
  import { redis, RedisClient } from "bun";
  await redis.set("k", "v"); const v = await redis.get("k");
  const c = new RedisClient("rediss://user:pass@host:6379", { connectionTimeout: 10000, autoReconnect: true, enableAutoPipelining: true, tls: true });
  await c.hmset("user:1", ["name","alice","age","30"]);
  await c.publish("news", "hi"); await c.subscribe("news", (msg, ch) => {});
  const raw = await c.send("ZADD", ["key", "1", "a"]);
  ```
- **제한**: Redis 7.2+, 트랜잭션(MULTI/EXEC)은 raw, Sentinel/Cluster 미지원.

### `Bun.s3` / `S3Client`
- **Stability**: stable
- **Introduced**: 1.1.25+, 🆕 (1.3) `S3Client.list()`, storage class, virtual hosted-style URL.
- **Signature**:
  ```ts
  import { s3, S3Client } from "bun";
  const client = new S3Client({ accessKeyId, secretAccessKey, bucket, region, endpoint, virtualHostedStyle: true });
  const f = client.file("path/obj.json");
  await f.text(); await f.json(); await f.bytes(); f.stream(); await f.exists(); await f.stat(); await f.delete();
  const slice = f.slice(0, 1024);
  await f.write(Buffer.from("..."), { acl: "public-read", type: "application/json", storageClass: "STANDARD_IA" });
  f.presign({ method: "PUT", expiresIn: 3600, acl: "public-read" });

  // 정적 메서드
  await S3Client.list({ prefix: "logs/" }, creds);

  // s3:// 프로토콜로 fetch/Bun.file
  await fetch("s3://bucket/key", { s3: creds });
  const localLike = Bun.file("s3://bucket/key");
  ```
- **지원 호환 서비스**: AWS S3, Cloudflare R2, DigitalOcean Spaces, GCS, MinIO, Supabase, Backblaze B2.

---

## 9. 암호화 / 해싱

### `Bun.password.hash/verify[Sync]`
- **Stability**: stable
- **Summary**: argon2id (기본) / argon2i / argon2d / bcrypt. 기본 강도 세트 제공.
- **Example**:
  ```ts
  const hash = await Bun.password.hash("pw", { algorithm: "argon2id", memoryCost: 4, timeCost: 3 });
  const ok   = await Bun.password.verify("pw", hash);
  ```

### `Bun.CryptoHasher`
- **Stability**: stable
- **Summary**: 증분 암호학적 해시. blake2b256/512, md4, md5, ripemd160, sha1, sha224/256/384/512, sha3-*, shake128/256. HMAC은 두 번째 인자에 key.
- **Example**:
  ```ts
  const h = new Bun.CryptoHasher("sha256", "secret").update("msg").digest("hex");
  ```

### `Bun.hash` (비암호학)
- **Summary**: `wyhash` (기본 64-bit). `.crc32`, `.adler32`, `.cityHash32/64`, `.xxHash32/64`, `.xxHash3`, `.murmur32v2/v3`, `.murmur64v2`, `.rapidhash`. seed 지원.

### `crypto.randomUUIDv7` / `Bun.randomUUIDv7()`
- **Stability**: stable
- **Summary**: UUIDv7 (시간순 정렬 가능) 지원. `crypto.randomUUID()` 와 동일 전역 표준.

### `node:crypto` 개선 🆕 (1.3)
- DiffieHellman 400x, Cipheriv/Decipheriv 400x, scrypt 6x 속도 향상.
- `crypto.hkdf` / `hkdfSync` 추가.
- `crypto.generateKeyPair` 에 X25519 곡선 지원.

### `Bun.CSRF` 🆕 (1.3)
- **Stability**: stable
- **Summary**: HMAC 서명 + timestamp + nonce 토큰.
- **Signature**:
  ```ts
  const token = Bun.CSRF.generate(secret, { encoding: "base64url", algorithm: "sha256", expiresIn: 86400000 });
  const ok = Bun.CSRF.verify(token, { secret, maxAge: 3600000 });
  ```
- **주의**: secret 미지정 시 스레드당 랜덤값 → 멀티 인스턴스/재시작 후 실패. 프로덕션은 명시 필수.

### `Bun.secrets` 🆕 (1.3, experimental)
- **Summary**: macOS Keychain / Linux libsecret / Windows Credential Manager 래퍼.
- **Example**:
  ```ts
  await Bun.secrets.set({ service: "mandu", name: user }, token);
  const t = await Bun.secrets.get({ service: "mandu", name: user });
  await Bun.secrets.delete({ service: "mandu", name: user });
  ```

---

## 10. 쿠키 / 폼 / 헤더

### `Bun.CookieMap` / `Bun.Cookie` 🆕 (1.3)
- **Stability**: stable
- **Signature**:
  ```ts
  const jar = new Bun.CookieMap(init?); // string | Record | [name,value][]
  jar.get(name); jar.set(name, value); jar.set({ name, value, httpOnly, secure, sameSite: "lax", maxAge, path: "/", domain, expires });
  jar.has(name); jar.delete(name); jar.size; jar.toSetCookieHeaders();

  const c = new Bun.Cookie("k", "v", { httpOnly: true, secure: true, sameSite: "lax" });
  c.isExpired(); c.serialize(); c.toJSON();
  Bun.Cookie.parse(str); Bun.Cookie.from({...});
  ```
- **`request.cookies` in `Bun.serve`**: Yes (1.3). 수정 시 응답 헤더 자동 적용.

### FormData handling
- **Summary**: 표준 `await req.formData()` 가 multipart 자동 파싱. 파일 업로드는 `FormDataEntryValue = File | Blob` — 바로 `Bun.write(dest, file)`.

### CORS helpers
- **Stability**: native helper 는 없음
- **Summary**: 공식 `Bun.cors` 같은 헬퍼는 문서화되어 있지 않음. `headers: { "Access-Control-Allow-Origin": ... }` 수동 설정.  
  `> 확인 필요 (source TBD)` — 1.3 블로그에서 "frontend + backend 가 같은 프로세스라 CORS 가 단순해진다"고 언급.

---

## 11. 런타임 유틸

### `import.meta.{main, dir, path, file, url, env, hot, resolve}`
- **Stability**: stable
- **Summary**:
  - `import.meta.main` — 엔트리 포인트 여부 (`node ... --main` 또는 `bun run` 대상).
  - `import.meta.dir` / `import.meta.path` / `import.meta.file` — 현재 모듈의 디렉토리/전체 경로/파일명.
  - `import.meta.url` — 표준 ES `file://` URL.
  - `import.meta.env` — `.env` 병합된 환경변수.
  - `import.meta.hot` — HMR (섹션 3).
  - `import.meta.resolve(spec)` — 모듈 해석.

### `Bun.env`, `Bun.version`, `Bun.revision`, `Bun.main`
- **Summary**: `Bun.env === process.env`. `Bun.version` = CLI 버전 문자열. `Bun.revision` = 빌드 git sha.

### `Bun.resolve(Sync)(specifier, root)` / `Bun.which(bin, opts)`
- **Summary**: 모듈 해석기 직접 호출. `Bun.which` 는 `$PATH` 검색.

### `Bun.nanoseconds()`, `Bun.sleep(ms|Date)`, `Bun.sleepSync(ms)`
- **Summary**: 프로세스 시작 후 경과 ns. high-res 벤치마크용.

### `Bun.gc(force?)`, `Bun.inspect(obj)`, `Bun.inspect.custom`, `Bun.inspect.table()`, `Bun.peek(promise)`, `Bun.peek.status(promise)`
- **Summary**: GC 강제, `console.log` 포맷과 동일한 직렬화, Promise 동기 접근.

### 스트림 변환 헬퍼
- `Bun.readableStreamToArrayBuffer/Bytes/Text/JSON/Array/Blob`

### 문자열 처리
- `Bun.escapeHTML` (480 MB/s~20 GB/s), `Bun.stringWidth` (~6756x npm 대비), `Bun.stripANSI`, `Bun.wrapAnsi`.

### 압축
- `Bun.gzipSync/gunzipSync`, `Bun.deflateSync/inflateSync`, `Bun.zstdCompress(Sync)/zstdDecompress(Sync)` 🆕 (1.3).

### ReadableStream 편의 메서드 🆕 (1.3)
- **Summary**: `stream.text()`, `.json()`, `.bytes()`, `.blob()` — fetch Response 와 동일 패턴을 일반 ReadableStream 에서도 사용.

### `DisposableStack` / `AsyncDisposableStack` 🆕 (1.3)
- **Summary**: TC39 Explicit Resource Management. `using` / `await using` 지원.
- **Example**:
  ```ts
  using stack = new DisposableStack();
  const db = stack.use(new Database("x.db")); // auto .close() on exit
  ```

### `Bun.cron` 🆕 (1.3.12)
- 섹션 13 에서 상세.

---

## 12. 개발 워크플로

### `--hot` / `--watch` / `--port`
- 섹션 3 참조. `--port` 대신 `PORT`, `BUN_PORT`, `NODE_PORT` 환경변수도 인식.

### Source maps
- **Stability**: stable
- **Summary**: 트랜스파일 결과에 자동 sourcemap 부착. 에러 스택이 원본 TS/JSX 를 가리킴. 빌드 시 `sourcemap: "linked" | "inline" | "external"`.

### 디버거 (Inspector)
- **Stability**: stable (VS Code 통합은 experimental)
- **Flags**: `--inspect`, `--inspect-brk`, `--inspect-wait`.
- **Web 인스펙터**: https://debug.bun.sh (WebKit Inspector 기반).
- **VS Code**: "Bun for Visual Studio Code" 확장.

### `.env` 로딩 순서
- `.env` → `.env.{production|development|test}` → `.env.local`. `$VAR` 인터폴레이션. `--no-env-file` / `--env-file=path` / `bunfig.toml env=false`.

### 타입 확장
```ts
declare module "bun" {
  interface Env { AWESOME: string; }
}
```

### `BUN_OPTIONS` 환경변수
- **Introduced**: 🆕 (1.3)
- **Summary**: 모든 `bun` 실행 앞에 인자 프리펜드 (e.g. `BUN_OPTIONS="--silent"`). `--compile` 바이너리에도 적용.

### `--user-agent`, `--sql-preconnect`, `--console-depth`
- **Introduced**: 🆕 (1.3)

### Telemetry
- **Summary**: Bun 공식 문서에는 원격 텔레메트리가 없습니다 (opt-out 레벨의 수집 미언급). `> 확인 필요 (source TBD)` — 공식 privacy 페이지 링크 필요.

---

## 13. Node 호환성

출처: `https://bun.com/docs/runtime/nodejs-compat` (2026-04 기준).

| 모듈 | 상태 | 비고 |
|------|------|------|
| `node:fs` | 🟢 완전 | Node 테스트 92% 통과 |
| `node:stream` | 🟢 완전 | |
| `node:net` | 🟢 완전 | |
| `node:dgram` | 🟢 완전 | Node 테스트 90%+ 통과 |
| `node:http2` | 🟡 부분 | 클·서버 구현 (gRPC 테스트 95.25% 통과). `allowHTTP1`, `enableConnectProtocol`, `pushStream` 미지원 |
| `node:worker_threads` | 🟡 부분 | `stdin/stdout/stderr`, `trackedUnmanagedFds`, `resourceLimits`, `markAsUntransferable`, `moveMessagePortToContext` 미지원. 🆕 (1.3) `getEnvironmentData`/`setEnvironmentData` 추가 |
| `node:async_hooks` | 🟡 부분 | `AsyncLocalStorage` + `AsyncResource` 만. v8 promise hooks 없음 |
| `node:perf_hooks` | 🟡 부분 | API 구현됨, 테스트 일부 실패 |
| `node:cluster` | 🟡 부분 | Linux 에서만 LB. 핸들/FD 워커 간 전달 불가 |
| `node:tls` | 🟡 부분 | `tls.createSecurePair` 없음 |
| `node:vm` | 🟡 부분 | 🆕 (1.3) `SourceTextModule`, `SyntheticModule`, `compileFunction`, bytecode 캐싱. `vm.measureMemory` 등 일부 미지원 |
| `node:crypto` | 🟡 부분 | 🆕 (1.3) DH/Cipheriv/scrypt 대폭 가속, `hkdf`, X25519 추가. `secureHeapUsed`, `setEngine`, `setFips` 없음 |
| `node:inspector` | 🟡 부분 | Profiler API 만 |
| `node:test` | 🟡 부분 | 🆕 (1.3) bun:test 인프라 위에 구현. mocks/snapshots/timers 일부 미지원 |
| `node:sqlite` | 🔴 미구현 | — (대안: `bun:sqlite`) |
| `require.extensions` | 🟢 | 🆕 (1.3) 커스텀 로더 지원 |

> Mandu가 Node.js 타겟도 지원한다면 위 매트릭스를 의존성 선택 기준으로 사용.

---

## 14. 실험적 / 로드맵

### Bake (풀스택 프레임워크)
- **Stability**: experimental / early
- **Summary**: Bun 공식 풀스택 프레임워크 계획. 블로그/로드맵에서만 언급, 전용 docs 페이지는 아직 라우팅 불가. `> 확인 필요 (source TBD)`.

### `Bun.WebView` 🆕 (1.3.12)
- **Stability**: new (experimental)
- **Summary**: 네이티브 헤드리스 브라우저 자동화. macOS WebKit / 타 OS Chrome 백엔드. 네비게이션/클릭/타이핑/스크린샷/raw CDP 호출. actionability 자동 감지.

### `Bun.markdown.ansi(md, opts)` 🆕 (1.3.12)
- **Summary**: 터미널 마크다운 렌더러. `bun ./file.md` 직접 실행 가능. Kitty Graphics Protocol 로 인라인 이미지.

### `Bun.cron` 인프로세스 스케줄러 🆕 (1.3.12)
- **Signature**:
  ```ts
  const job = Bun.cron("*/5 * * * *", async function () { await sync(); });
  // OS 레벨
  await Bun.cron("./worker.ts", "30 2 * * MON", "weekly-report");
  Bun.cron.parse("@daily");
  await Bun.cron.remove("weekly-report");
  ```
- **특성**: UTC 기본, overlap 방지 (핸들러 settle 후 next 계산), `--hot` 재시작 시 stop/restart.

### Explicit Resource Management (`using` / `await using`) 🆕 (1.3.12)
- **Summary**: JS 엔진 수준 지원. `DisposableStack` / `AsyncDisposableStack` 와 함께 리소스 라이프사이클 자동화.

### 번들러 성능 / 네이티브 ELF / NixOS 포팅 🆕 (1.3.12)
- Linux standalone 실행파일이 `/proc/self/exe` 대신 `.bun` ELF section 사용.
- `--compile` 이 NixOS 에서 정상 portable 바이너리 생성.

### URLPattern 2.3x, stripANSI/stringWidth 4–11x SIMD, build 1.43–1.47x 🆕 (1.3.12)
- 그 외 JIT 개선: `Array.isArray`, `String#includes`, BigInt, promise resolution.

### 1.4 로드맵 (공식 문서상 구체적 발표 없음)
- **Note**: `https://bun.com/docs/project/roadmap` 은 GitHub 이슈(#159)로 리디렉션. 본 catalog 에선 "구체적 1.4 목록 미확정" 으로 기록. `> 확인 필요 (source TBD)`.

### 기타 네트워크/소켓 개선 🆕 (1.3.12)
- Unix domain socket: Node.js 동등한 `EADDRINUSE`, close 시 자동 정리.
- UDP: ICMP 에러 surface, truncated datagram flag.
- HTTPS proxy CONNECT 터널 풀링.
- Linux `TCP_DEFER_ACCEPT` 로 인커밍 latency 감소.
- HTTP 서버가 conflicting `Content-Length` 거부 (request smuggling 완화).

---

## 부록 A — Mandu 적용 체크리스트

| 항목 | Mandu 현황 (추정) | 제안 |
|------|------------------|------|
| Route 정의 | 자체 fs-scanner + manifest | `Bun.FileSystemRouter` + `Bun.serve({routes})` 혼합 검토 |
| 쿠키 | 별도 라이브러리 / 수동 파서? | `Bun.CookieMap` + `req.cookies` |
| HMR 프로토콜 | 자체 WS 채널 | `import.meta.hot` + Bun dev HMR |
| CSS 파이프라인 | Tailwind spawn + custom watcher | Bun 번들러 CSS 로더 + `fs.watch` 네이티브 |
| fs.watch | polling/스크립트 | 네이티브 (1.3) — 별도 코드 불필요 |
| CSRF | 수동 | `Bun.CSRF` |
| 시크릿 저장 | `.env` | `Bun.secrets` (dev 전용) |
| DB | 앱별 선택 | `Bun.sql` 어댑터 가이드 제공 |
| 테스트 | `bun:test` 일부 사용 | `test.concurrent` + `mock.module` + `--retry` 도입 |
| 패키지 배포 | `bun publish` (완료) | `catalog:` 적용으로 버전 중앙화 |
| Monorepo 의존성 | workspace | `--linker=isolated` 기본 유지 |
| 실행 파일 배포 | 없음 | `--compile --target=browser` 로 데모 배포 실험 |

---

## 각주 — 출처 URL

공식 도메인은 `bun.com` 입니다 (구 `bun.sh` 는 migrated). 본 문서의 모든 주장은 아래 페이지에서 크로스체크했습니다.

### 블로그 (release notes)
- https://bun.com/blog/bun-v1.3 — "Bun 1.3" 종합 발표 (2025-10-10)
- https://bun.com/blog/bun-v1.3.10 — REPL, `--compile --target=browser`, TC39 decorators, Windows ARM64
- https://bun.com/blog/bun-v1.3.12 — `Bun.WebView`, `Bun.markdown`, `Bun.cron`, Explicit Resource Management, SIMD/build 가속

### 런타임·API
- https://bun.com/docs — 루트
- https://bun.com/docs/runtime/bun-apis — `Bun.*` 카탈로그
- https://bun.com/docs/runtime/http/server — `Bun.serve`
- https://bun.com/docs/runtime/http/routing — 라우팅 객체 문법
- https://bun.com/docs/runtime/http/cookies — `Bun.CookieMap`
- https://bun.com/docs/runtime/http/tls — TLS 옵션
- https://bun.com/docs/runtime/http/websockets — WebSocket
- https://bun.com/docs/runtime/cookies — Cookie / CookieMap
- https://bun.com/docs/runtime/csrf — `Bun.CSRF`
- https://bun.com/docs/runtime/secrets — `Bun.secrets`
- https://bun.com/docs/runtime/file-io — `Bun.file`, `Bun.write`, FileSink
- https://bun.com/docs/runtime/glob — `Bun.Glob`
- https://bun.com/docs/runtime/file-system-router — `Bun.FileSystemRouter`
- https://bun.com/docs/runtime/child-process — `Bun.spawn`, `Bun.spawnSync`
- https://bun.com/docs/runtime/shell — `Bun.$`
- https://bun.com/docs/runtime/sqlite — `bun:sqlite`
- https://bun.com/docs/runtime/sql — `Bun.sql`
- https://bun.com/docs/runtime/redis — `Bun.redis`
- https://bun.com/docs/runtime/s3 — `Bun.s3`
- https://bun.com/docs/runtime/hashing — `Bun.password`, `Bun.CryptoHasher`, `Bun.hash`
- https://bun.com/docs/runtime/html-rewriter — `HTMLRewriter`
- https://bun.com/docs/runtime/streams — ReadableStream, `Bun.ArrayBufferSink`
- https://bun.com/docs/runtime/utils — 런타임 유틸리티
- https://bun.com/docs/runtime/environment-variables — `.env`, `BUN_OPTIONS`
- https://bun.com/docs/runtime/nodejs-compat — Node.js 호환 매트릭스
- https://bun.com/docs/runtime/workers — Worker API
- https://bun.com/docs/runtime/cron — `Bun.cron`
- https://bun.com/docs/runtime/watch-mode — `--hot` vs `--watch`
- https://bun.com/docs/runtime/debugger — Inspector, VS Code
- https://bun.com/docs/runtime/yaml — `Bun.YAML`
- https://bun.com/docs/runtime/networking/fetch — 확장 `fetch`
- https://bun.com/docs/runtime/networking/tcp — `Bun.listen`, `Bun.connect`
- https://bun.com/docs/runtime/networking/dns — DNS

### 번들러
- https://bun.com/docs/bundler — `Bun.build`
- https://bun.com/docs/bundler/plugins — `Bun.plugin`
- https://bun.com/docs/bundler/executables — `--compile`
- https://bun.com/docs/bundler/fullstack — HTML entrypoints
- https://bun.com/docs/bundler/hot-reloading — HMR
- https://bun.com/docs/bundler/css — CSS 번들링
- https://bun.com/docs/bundler/bytecode — bytecode
- https://bun.com/docs/bundler/standalone-html — `--target=browser --compile`
- https://bun.com/docs/bundler/macros — 빌드 타임 매크로

### 테스트
- https://bun.com/docs/test — 개요
- https://bun.com/docs/test/writing-tests
- https://bun.com/docs/test/lifecycle
- https://bun.com/docs/test/mocks
- https://bun.com/docs/test/snapshots
- https://bun.com/docs/test/code-coverage
- https://bun.com/docs/test/dom

### 패키지 매니저
- https://bun.com/docs/pm/cli/install
- https://bun.com/docs/pm/cli/publish
- https://bun.com/docs/pm/cli/patch
- https://bun.com/docs/pm/cli/why
- https://bun.com/docs/pm/cli/audit
- https://bun.com/docs/pm/cli/info
- https://bun.com/docs/pm/cli/update
- https://bun.com/docs/pm/cli/pm
- https://bun.com/docs/pm/catalogs
- https://bun.com/docs/pm/isolated-installs
- https://bun.com/docs/pm/lockfile
- https://bun.com/docs/pm/workspaces
- https://bun.com/docs/pm/filter
- https://bun.com/docs/pm/security-scanner-api
- https://bun.com/docs/pm/bunx

### 프로젝트
- https://bun.com/docs/project/roadmap (→ GitHub #159)
- https://bun.com/docs/project/license

---

*이 문서는 Mandu 코어 팀의 내부 레퍼런스이며, Bun 상위 버전 릴리스 시 갱신이 필요합니다. 갱신 시 "14. 실험적/로드맵" 섹션부터 검토하는 것을 권장합니다.*
