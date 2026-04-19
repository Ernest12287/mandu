---
phase: 9c
round: R0
status: diagnostic
date: 2026-04-18
verdict: GREEN — webview-bun 2.4.0 FFI 래핑으로 즉시 착수 가능 (Windows 실측 확인)
bun_version_tested: 1.3.12
sources:
  - https://github.com/tr1ckydev/webview-bun
  - https://www.npmjs.com/package/webview-bun
  - https://github.com/webview/webview
  - https://github.com/webviewjs/webview
  - https://github.com/theseyan/bunview
  - https://github.com/blackboardsh/electrobun
  - https://bun.com/docs/bundler/executables
  - https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution
  - https://github.com/tr1ckydev/webview-bun/issues
---

# Phase 9c R0 — 서드파티 webview-bun FFI 데스크톱 통합 가능성 조사

## TL;DR

Bun 1.3.12 + [`webview-bun@2.4.0`](https://www.npmjs.com/package/webview-bun) 은 **Mandu 가 Tauri 포지션을 프레임워크 안에서 재현할 실용 경로**. Windows 10 실측 결과: (a) FFI `dlopen` 성공, (b) WebView2 runtime 자동 감지 + 창 렌더, (c) `bind()` 로 Bun↔페이지 비동기 IPC 양방향 동작, (d) **`bun build --compile` 단일 112 MB `.exe` + node_modules 없는 격리 환경 정상 기동** (prebuilt `libwebview.dll` 이 번들러에 의해 자동 임베딩). R0.1 (`webview-api.md`) 의 전략 E 를 **실행 가능한 Phase 9c** 로 격상. 판정 **🟢 GREEN**. 완화할 운영 이슈 3 건: (1) webview-bun 메인테이너 1명 → fallback 명시, (2) Linux 는 GTK4/WebKitGTK6 사용자 설치 필요, (3) Windows 10 은 WebView2 Evergreen Bootstrapper 동반 배포.

---

## 1. 라이브러리 후보 비교

| 라이브러리 | 최근 활동 | ★ | 라이선스 | 백엔드 | 판정 |
|---|---|---|---|---|---|
| [`webview-bun`](https://github.com/tr1ckydev/webview-bun) (tr1ckydev) | 2.4.0 / main 2025-04 / issue #44 2026-02 | 426 | MIT | WebView2 / WKWebView / WebKitGTK 6 | **✅ 선정** — Bun 네이티브 FFI, `bun --compile` 내장 지원, 프리빌트 DLL 번들 |
| [`webviewjs/webview`](https://github.com/webviewjs/webview) | v0.1.4, 2026-01 | 48 | MIT | 동일 | Node/Deno/Bun 멀티타깃 (napi-rs). README "not ready for production" |
| [`bunview`](https://github.com/theseyan/bunview) | v0.0.3, 2022-12 | 88 | 표기 없음 | 동일 | 3년 정체 — **사실상 deprecated** |
| [`electrobun`](https://github.com/blackboardsh/electrobun) | 활발 | 11.4k | MIT | Zig 런처 + 시스템 WebView | 올인원 프레임워크 — Mandu 와 **역할 중복**, Phase 9c 범위 밖 |
| [`webview/webview`](https://github.com/webview/webview) (C++ 상류) | 636 커밋 | 14k+ | MIT | 모든 플랫폼 | 직접 바인딩은 Mandu 범위 과다 — 단 webview-bun **fallback 경로**로 기록 |

**공급망 리스크 완화**: webview-bun 메인테이너 1 + 기여자 3. 상류 C++ `webview/webview` 는 안정. 최악의 경우 Mandu 가 FFI 부분(~50 LOC) 을 `@mandujs/core/desktop` 내부에 **인라인 재작성** 가능 — 이 fallback 을 Phase 9c.E 로 문서화.

## 2. webview-bun API Surface (실측)

`node_modules/webview-bun/src/webview.ts` 전문 확인:

```ts
class Webview {
  constructor(debug?: boolean, size?: Size, window?: Pointer | null);
  set title(title: string);
  set size({ width, height, hint }: Size);
  navigate(url: string): void;
  setHTML(html: string): void;
  init(source: string): void;    // 각 페이지 load 직전 주입
  eval(source: string): void;    // 호스트 → 페이지 단방향
  bind(name, cb): void;          // JS 전역 async fn 등록, JSON 자동 직렬화 + Promise await
  bindRaw(name, cb): void;       // low-level (seq/req)
  unbind(name): void;
  return(seq, status, result): void;
  run(): void;                   // blocking, 종료 시 destroy() 자동 호출
  destroy(): void;
  get unsafeHandle / unsafeWindowHandle: Pointer;  // HWND/NSWindow/GtkWindow
}
```

원안(질문) 의 `onMessage`, `show`, `close`, `dispatch` 는 **없음**. `setTitle`/`setSize` 는 JS setter 형태로 제공 — 기능 동치. 페이지→호스트 이벤트 채널은 `bind()` 를 bus emit 으로 쓰는 관용구로 대체. 라이프사이클 훅 부재 — `init()` + `bind("mandu_close", ...)` 로 앱 레벨 shutdown 조립.

## 3. OS 매트릭스

| OS | 백엔드 | 프리빌트 | 사용자 요구 |
|---|---|---|---|
| Windows 11 | WebView2 (Chromium Evergreen) | `libwebview.dll` 107 KB | 기본 탑재 |
| Windows 10 | WebView2 | 동일 | [Evergreen Bootstrapper](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) 1.8 MB **설치 필요** |
| macOS 11+ | WKWebView | `libwebview.dylib` 182 KB | 없음 |
| Linux (GTK) | WebKitGTK 6.0 + GTK 4 | `libwebview-{x64,arm64}.so` 67–71 KB | `libgtk-4-1 libwebkitgtk-6.0-4` (Debian 24.04+) |

**경고**: Ubuntu 22.04 기본 저장소에 WebKitGTK6 없음 — ppa:webkitgtk 필요. Windows 10 WebView2 부재 시 `webview_create` 가 무응답 (에러 안 던짐) — `mandu doctor` presence 체크 필수. R0.1 가 틀렸던 **"Windows: WebView2 / Linux: WebKitGTK"** 는 `Bun.WebView` (내장) 경로에 한정된 오류 — **webview-bun 경로에서는 이 매트릭스가 정확**함.

## 4. 번들 크기 + 성능 (실측)

### 4.1 디스크

| 항목 | 크기 |
|---|---|
| `libwebview.dll` / `.dylib` / `.so` | 71–182 KB |
| `bun --compile` 결과 (webview-bun + 21 LOC probe) | **112 MB** |
| webview-bun 순증분 | +2 MB (DLL + JS 바인딩) |

Bun 런타임 110 MB 가 지배적. Electron 150 MB 대비 25% 절감, Tauri 10 MB 대비 열세 — 단 Mandu 는 "하나의 `.exe` 에 웹서버 + 데스크톱 창 + JS 런타임" 포함.

### 4.2 런타임 성능 (`probe3.ts` 실측)

| 모드 | ctor | IPC 왕복 |
|---|---|---|
| `bun run` (콜드) | 2.1 s | 5–6 ms |
| `--compile` 바이너리 (isolated) | **851 ms** | 5 ms |

WebView2 콜드 캐시 제외 시 실질 창 띄우기 < 1 s.

## 5. Mandu 통합 시나리오 — 권장

| | 설명 | 판정 |
|---|---|---|
| **A.** `mandu dev --desktop` | HTTP 서버 Worker + webview 창 래퍼. ~60 LOC. HMR/Kitchen 그대로 재사용 | 🟢 1차 권장 (1주) |
| **B.** `mandu build --target=desktop` | prod `--compile` 바이너리 + webview 래퍼 내장. 3 OS GHA 매트릭스 | 🟢 2차 (2주, Phase 7.2 와 합류) |
| **C.** SSG + `file://` | HTTP 없이 정적 파일 로드 | 🟡 Optional (file:// 이슈 [#43/38](https://github.com/tr1ckydev/webview-bun/issues/43), 수요 불명) |

**Worker 분리 필수** ([examples/webserver](https://github.com/tr1ckydev/webview-bun/blob/main/examples/webserver/index.ts)): `wv.run()` 이 블로킹이므로 `Bun.serve` 는 반드시 `new Worker()` 안에서. 메인 스레드는 창 이벤트 루프 전용.

```ts
// packages/core/src/desktop/main.ts (신규)
const worker = new Worker(new URL("./server-worker.ts", import.meta.url));
const { port } = await once(worker, "message");
const wv = new Webview(false, { width: 1280, height: 800, hint: SizeHint.NONE });
wv.title = manifest.appName;
wv.navigate(`http://127.0.0.1:${port}`);
worker.addEventListener("close", () => wv.destroy());
wv.run();
```

## 6. IPC 보안 모델

- `bind()` 는 Mandu 가 명시 허용한 함수만 JS 전역 노출 — Electron `contextBridge` 유사. **원격 URL 금지, 127.0.0.1 전용** 원칙.
- `eval()` 은 호스트→페이지 코드 주입. 모든 호출을 `packages/core/src/desktop/bridge.ts` 화이트리스트에 격리.
- Sandbox: WebView2/WKWebView 시스템 sandbox 상속 — 페이지 JS 는 호스트 FS 직접 접근 불가. `bind()` 노출 함수만 사용 가능.
- CSP: `setHTML()` 초기 HTML 에 `<meta http-equiv="CSP" content="default-src 'self' http://127.0.0.1:*;">` 삽입 권고.
- 알려진 제약: [#44](https://github.com/tr1ckydev/webview-bun/issues/44) — `bind()` 는 request-response 만, 서버→페이지 푸시는 `eval()` + `init()` 으로 조립.

## 7. `bun --compile` 호환성 (실측)

1. `bun build --compile probe3.ts --outfile probe3-exe` — 2.1 s / 112 MB
2. `probe3-exe.exe` 를 `node_modules` 와 무관한 `C:\tmp\probe3-isolated.exe` 로 이동
3. 실행 → 창 정상 렌더, ctor 0.85 s, bind IPC 왕복 OK

**결론**: webview-bun 의 `ffi.ts` 가 `await import("../build/libwebview.dll")` 로 DLL 을 모듈 그래프에 명시 → Bun 번들러가 자동 asset-embed. R0.2 의 Mandu CLI 템플릿 임베딩 문제 (상대경로 loader) 와 다름. **별도 `with { type: "file" }` 설정 불요**. Code signing: R0.2 의 `--windows-icon/title/version/publisher` 플래그 조합 그대로 상속.

## 8. Tauri/Electron 대비 포지셔닝

| | Tauri 2 | Electron | **Mandu + webview-bun** |
|---|---|---|---|
| 크기 | ~10 MB | ~150 MB | ~112 MB |
| 언어 | Rust + Web | Node + Web | **Bun TS 단일 스택** |
| 풀스택 통합 | 별도 backend | npm eco | **Mandu slot/filling 그대로** ⭐ |
| 통합 난이도 | 높음 (Rust) | 매우 높음 | **낮음** (Bun 네이티브) |
| IPC | `invoke` | `ipcMain/Renderer` | `bind()` (JSON 자동) |

**차별화**: "동일한 Mandu slot/filling/contract 코드로 웹 + 데스크톱". Tauri 대비 무거우나, **웹 앱을 이미 Mandu 로 개발 중인 팀이 추가 학습 0** 으로 데스크톱 타깃 확보.

## 9. Windows 10 실측 결과 (2026-04-18)

### 9.1 환경

`platform=win32 x64`, `bun=1.3.12`, `webview-bun=2.4.0 (MIT)`, prebuilt DLL 107 KB.

### 9.2 `bun run` (개발 모드)

```
[+0ms]     start
[+2121ms]  Webview ctor ok       # WebView2 콜드 기동 포함
[+2142ms]  setHTML ok
[+2177ms]  bind hit #1 payload=a   # JS → Bun RPC
[+2183ms]  bind hit #2 payload=b
```

창 정상 렌더, 양방향 RPC 2회 연속 성공.

### 9.3 `--compile` 바이너리 (isolated)

```
$ bun build --compile probe3.ts --outfile probe3-exe
  [44ms]   bundle  5 modules
  [2.111s] compile  probe3-exe.exe   # 112 MB
$ cp probe3-exe.exe C:\tmp\            # node_modules 없는 폴더
$ C:\tmp\probe3-isolated.exe
[+0ms]     start
[+851ms]   Webview ctor ok            # 1.3s 단축
[+885ms]   bind hit #1 payload=a
```

DLL 동반 파일 불요 — 단일 `.exe` 만 배포.

### 9.4 관찰된 주의점

- **`wv.destroy()` 타이머 기반 호출이 `run()` 을 즉시 반환시키지 않음** — probe2.ts 확인. [#35 Nonblocking](https://github.com/tr1ckydev/webview-bun/issues/35) 와 연관. 앱 수준 shutdown 은 `init()` + `bind("mandu_close")` 로 설계.
- Linux `file://` navigation 이슈 [#43/38](https://github.com/tr1ckydev/webview-bun/issues/43) — 시나리오 C 보류 근거.
- macOS `SizeHint.NONE` 시 창 invisible — README 명시.

## 10. Phase 9c 판정 + D 에이전트 브리핑

| 축 | 판정 | 근거 |
|---|---|---|
| 기술 가능성 | 🟢 GREEN | 창 + IPC + `--compile` 전부 Windows 실측 동작 |
| 공급망 안정성 | 🟡 YELLOW | 메인테이너 1명 — fallback(상류 C++ 직접 FFI) 문서화로 완화 |
| 플랫폼 커버리지 | 🟡 YELLOW | Linux GTK4, Windows 10 WebView2 사용자 설치 — `mandu doctor` + 설치 문서로 완화 |
| Mandu 적합도 | 🟢 GREEN | `bun --compile`, Bun.serve, Worker, SSR 그대로 재사용 |
| 번들 크기 | 🟡 YELLOW | 112 MB — 풀스택 포함 가치로 정당화 |

**종합: 🟢 GREEN — 즉시 착수**. YELLOW 3건은 모두 문서 + CI 완화되는 운영 이슈.

### 10.1 Phase 9c.R1 범위 (D 에이전트)

- **9c.A (1주)**: `mandu dev --desktop` — Worker + webview 창 + `bind()` 최소셋
- **9c.B (2주)**: `mandu build --target=desktop` — 3 OS GHA 매트릭스
- 종료 조건: `@mandujs/core/desktop` 배럴 + `packages/cli/src/commands/desktop.ts` + `demo/desktop-starter/` + 3 OS 릴리스 CI + `mandu doctor` WebView2/GTK4 체크

### 10.2 초기 API 제안

```ts
// @mandujs/core/desktop
export interface DesktopWindowOptions {
  url: string;                    // 필수 — http://127.0.0.1:<port>
  title: string;
  width?: number;
  height?: number;
  fixed?: boolean;                // SizeHint.FIXED 매핑
  debug?: boolean;                // ctor(debug=true)
  handlers?: Record<string, (...args: any[]) => any>;   // bind() 일괄 등록
  onReady?: () => void;
  onClose?: () => void;
}
export async function createWindow(opts: DesktopWindowOptions): Promise<void>;
```

### 10.3 리스크 체크리스트

| 리스크 | 완화 |
|---|---|
| `destroy()` 가 run() 즉시 반환 안 시킴 | `init()` + `bind("mandu_close")` 앱 shutdown signal |
| Worker↔메인 포트 협상 | Bun.serve `port: 0` → Worker `postMessage({port})` → await after navigate |
| Linux GTK4 미설치 | `mandu doctor` 에서 `pkg-config --exists webkit2gtk-6.0` 체크 + 설치 스크립트 안내 |
| Windows 10 WebView2 부재 | Registry `HKLM\SOFTWARE\WOW6432Node\...\EdgeUpdate\Clients\{F3017226-...}` 체크. installer 에 Evergreen Bootstrapper 동반 |
| webview-bun 공급망 | `@mandujs/core/desktop` 안에 FFI 인라인 대안(~50 LOC) 준비 — 상류 정체 시 fork |
| macOS Gatekeeper / Windows SmartScreen | Phase 7.2 서명 가이드 + notarization |

### 10.4 참고 자료 (D 에이전트 필독)

- webview-bun: https://github.com/tr1ckydev/webview-bun (examples/webserver 필수)
- WebView2 distribution: https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution
- `docs/bun/phase-9-diagnostics/compile-binary.md` (R0.2) — 크로스 컴파일 + 서명 매트릭스 이미 확립
- `docs/bun/phase-9-diagnostics/webview-api.md` (R0.1) — `Bun.WebView` 가 왜 이 경로를 대체 못하는지 배경

---

**다음 단계**:
1. `docs/bun/phases-4-plus.md` §9.1 을 "원안 → webview-bun FFI" 로 재작성, Phase 번호 9c 확정
2. `MEMORY.md` 에 Phase 9c 판정(GREEN) + 실측 증거 경로 추가
3. D 에이전트 kickoff → `packages/core/src/desktop/main.ts` 스켈레톤부터
