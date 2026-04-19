---
phase: 9.1
round: R0.1
status: diagnostic
date: 2026-04-18
verdict: RED — Defer (purpose mismatch, platform gaps)
sources:
  - https://bun.com/reference/bun/WebView
  - https://bun.com/blog/bun-v1.3.12
  - https://deepwiki.com/oven-sh/bun/9.10-webview-api
  - https://github.com/oven-sh/bun/issues?q=is%3Aissue+WebView
---

# Phase 9.1 R0.1 — `Bun.WebView` API 및 OS 제약 전수 조사

## TL;DR

`Bun.WebView` 는 **1.3.12 에 처음 탑재된 헤드리스 브라우저 자동화 API** 이다. Playwright 와 같은 목적 — "프로그램이 웹 페이지를 조작" — 이 설계 의도이며, **데스크톱 앱 창(visible window) 을 띄우는 Tauri/Electron 대체품이 아니다**. 프로토타입에 `show()`/`onMessage()`/`closed` promise 가 존재하지 않고, 실측에서도 `headless: false` 옵션이 **"not yet implemented"** 로 거부된다. 따라서 기존 `phases-4-plus.md` §9.1 의 "Mandu 앱을 OS 네이티브 WebView 로 번들링" 전제는 성립하지 않는다. Phase 9.1 은 **RED (defer)** 로 판정하며, 향후 Bun 이 visible-window API 를 추가할 때까지 재검토를 권장한다.

---

## 1. 현황 — 실제 사용 가능한가

| 항목 | 값 | 출처 |
|---|---|---|
| 최초 도입 | Bun **1.3.12** (2026-04) | [bun-v1.3.12 blog](https://bun.com/blog/bun-v1.3.12) |
| 공식 스테이터스 | **"native headless browser automation built into the runtime"** | 동상 |
| Catalog 표기 | `new (experimental)` | `docs/bun/features-catalog.md:932-934` |
| 대상 유스케이스 | 테스트 자동화, 스크래핑, 스크린샷, `evaluate()` 기반 페이지 조작 | [reference/bun/WebView](https://bun.com/reference/bun/WebView) |
| 데스크톱 창 | **미지원** (실측 `headless: false` → `"headless: false is not yet implemented"`) | 본 문서 §8 |

**결론**: Bun 1.3.12 에 존재하고 `typeof Bun.WebView === "function"` 이나, "experimental headless 자동화 도구" 이며 데스크톱 UI 프레임워크가 **아니다**.

## 2. API Surface (실측 + 공식 문서)

로컬 `bun -e` 로 prototype 을 열거한 실측:

```
navigate(url)          evaluate(script)       screenshot()
cdp(method, params)    click(opts[, opts2])   type(text)
press(key)             scroll(dx, dy)         scrollTo(selector)
resize(w, h)           goBack() / goForward() reload()
close()
— getters: url, title, loading, onNavigated, onNavigationFailed
— static: Bun.WebView.closeAll()
```

Constructor 옵션 ([공식 reference](https://bun.com/reference/bun/WebView)):

```ts
new Bun.WebView({
  backend?: 'webkit' | 'chrome' | { path?, argv? },
  console?: 'capture' | ((type, ...args) => void),
  dataStore?: 'ephemeral' | { directory: string },
  headless?: boolean,   // 현재 true 만 동작
  width?: number,       // 1..16384
  height?: number,
  url?: string,
});
```

**이벤트 / IPC**: 공식적으로 노출된 것은 `onNavigated` / `onNavigationFailed` getter 두 개. 양방향 메시지 채널 (`postMessage` / `onMessage`) 은 **존재하지 않음**. 호스트 ↔ 페이지 통신은 `evaluate(script)` 반환값 (Promise auto-await) 뿐 — 실질적으로 단방향 polling 패턴.

## 3. OS 매트릭스

| OS | 백엔드 | 요구사항 | 상태 |
|---|---|---|---|
| macOS | WebKit (시스템 `WKWebView`) | macOS 표준, 추가 설치 없음 | 기본 경로 |
| macOS | Chrome (CDP) | Chrome/Chromium 설치 | 선택 |
| Linux | Chrome (CDP) 전용 | Chrome/Chromium 설치 필수 | WebKitGTK 미지원 |
| Windows | Chrome (CDP) 전용 | Chrome/Chromium 설치 필수 (`BUN_CHROME_PATH`) | **WebView2 미사용** |

출처: [DeepWiki WebView API](https://deepwiki.com/oven-sh/bun/9.10-webview-api) — *"macOS: WebKit Backend and Chrome CDP Backend both supported. Linux & Windows: Chrome (CDP) only."*

즉 메모리에 기록된 *"Windows: WebView2 / Linux: WebKitGTK"* 는 **사실과 다름** — 이 오류는 `MEMORY.md` 와 `phases-4-plus.md:261` 두 곳에 있으므로 바로잡아야 한다.

### 알려진 이슈 (oven-sh/bun, 2026-04 기준, 총 12건)

1. [#29367] Windows — Chrome spawn 시 `ERR_DLOPEN_FAILED`
2. [#29102] Windows 브라우저 런칭 실패
3. [#29347] Official sample code → timeout
4. [#29156] WebView timeout waiting for actionable
5. [#29237] `BUN_CHROME_PATH` 환경 변수/경로 해석 버그
6. Firefox WebDriver BiDi 지원 feature request

→ **Windows 안정성이 낮고, reference 문서의 샘플 자체가 timeout 나는 상태**.

## 4. IPC / 보안 모델

- **유일한 bridge**: `wv.evaluate("...js...")` — 호스트가 페이지 컨텍스트에 코드 주입 → Promise 결과 회수. 반대 방향 (페이지 → 호스트 신호) 은 공식 API 없음.
- **`cdp(method, params)`**: Chrome DevTools Protocol raw 호출 가능 — 고급 사용자는 `Runtime.bindingCalled` 등으로 수동 IPC 구현 가능하나 공식 문서 보증 없음.
- **Console capture**: 페이지 `console.*` → 호스트 callback. 디버깅용이지 IPC 대용으론 빈약.
- **Sandbox**: 페이지 JS 는 일반 브라우저 sandbox 안. 호스트 filesystem 직접 접근 불가. `evaluate` 로 주입한 코드만 호스트가 명시적으로 허용한 값을 반환.

Electron 의 `ipcMain/ipcRenderer`, Tauri 의 `invoke` 같은 구조화된 RPC 는 없음.

## 5. 경쟁 대비 포지셔닝

| 도구 | 목적 | 번들 크기 | Windows 지원 | Bun.WebView 대비 |
|---|---|---|---|---|
| Electron | 데스크톱 앱 (Chromium 번들) | ~150MB | 완전 자립 | Bun.WebView 는 **비교 대상 아님** (헤드리스) |
| Tauri | 데스크톱 앱 (시스템 WebView) | ~10MB | WebView2 | Bun.WebView 는 visible window 없음 |
| Playwright | 브라우저 자동화 | npm 의존 (다운로드) | ✅ | **직접 경쟁** — Bun.WebView 는 런타임 내장 대안 |
| Puppeteer | 브라우저 자동화 (Chrome) | ✅ | ✅ | 동일 세그먼트 |
| `webview-bun` / `bunview` (3rd party) | FFI 로 `webview` C 라이브러리 바인딩 | ~2MB | WebView2 | **데스크톱 창 필요 시 실제 답** |

**포지셔닝**: `Bun.WebView` 는 Tauri/Electron 대체가 아니라, **Playwright/Puppeteer 의 런타임 내장 대체**이다. 데스크톱 앱 스토리에는 `webview-bun` (FFI) 이 현 시점의 실용 경로.

## 6. Mandu 통합 전략 — 재조정

원문 프롬프트의 A/B/C 전략은 모두 "visible window + local HTTP server" 를 가정한다. API 가 헤드리스만 지원하므로 **세 전략 모두 현 상태에선 구현 불가**. 재조정:

- **전략 D (권장, 단기)**: Phase 9.1 을 "데스크톱 배포" 에서 **"E2E 테스트 런타임"** 으로 재정의. Mandu 의 기존 Playwright 의존을 `Bun.WebView + cdp()` 로 대체 → `@mandujs/core/testing` 의 headless runner. 설치 의존 줄이고 dev 부팅 빠르게. 단 Windows CI 에선 Chrome 사전 설치 필요.
- **전략 E (권장, 중기)**: 데스크톱 배포는 **3rd-party `webview-bun` FFI 바인딩** 으로 별도 Phase 9.1-alt. `@mandujs/core/desktop` 패키지가 `webview-bun` 을 dep 으로 쓰고 `createWindow({ url, title, size })` wrapper 제공. `--compile` 단일 바이너리 (Phase 7) + 시스템 WebView 로 Tauri 포지션 확보.
- **보류 (전략 A/B/C 원안)**: Bun 이 visible-window API 를 추가할 때 (=헤드리스 전용 제약이 풀릴 때) 재평가. 로드맵 불투명 — Bun 1.3.12 reference 어디에도 "visible window soon" 약속 없음.

## 7. Phase 9.1 실행 가능성 판정

| 시나리오 | 판정 | 근거 |
|---|---|---|
| 원안 (`mandu build --target=desktop` + native OS WebView) | 🔴 **RED — Defer** | API 가 headless-only. Windows 에선 Chrome 사전 설치 필수. `phases-4-plus.md:261` 의 WebView2/WebKitGTK 가정 오류. |
| 전략 D (E2E 테스트 런타임 대체) | 🟡 **YELLOW — Partial** | macOS 는 zero-dep WebKit 로 즉시 사용 가능. Linux/Windows 는 Chrome 의존 — Mandu Windows CI 에 영향. 공식 샘플 timeout 이슈 (#29347) 먼저 주시. |
| 전략 E (`webview-bun` FFI 래핑) | 🟢 **GREEN — Feasible** | 서드파티 라이브러리지만 성숙. Windows/macOS/Linux 모두 시스템 WebView 사용. Mandu 는 FFI 로 wrapping 만 하면 됨. |

**권장**: Phase 9.1 원안은 **defer**. `Bun.WebView` 는 Phase 4~6 (auth/DB/하드닝) 의 E2E 테스트 툴체인으로 소비하고, 데스크톱 배포 스토리가 필요하면 **새 Phase 9.1-alt 로 `webview-bun`** 을 정의한다.

## 8. 실측 결과 (Windows 10, Bun 1.3.12, 2026-04-18)

```bash
$ bun --version
1.3.12

$ bun -e 'console.log(typeof Bun.WebView)'
function

$ bun -e 'console.log(Object.getOwnPropertyNames(Bun.WebView.prototype))'
['navigate','evaluate','screenshot','cdp','click','type','press','scroll',
 'scrollTo','resize','goBack','goForward','reload','close',
 'url','title','loading','onNavigated','onNavigationFailed','constructor']

$ bun -e 'new Bun.WebView({ url: "https://example.com", headless: false })'
# → error: headless: false is not yet implemented

$ bun -e 'await new Bun.WebView({ url: "https://example.com" }).evaluate("document.title")'
# → error: Failed to spawn Chrome (set BUN_CHROME_PATH, backend.path, or install Chrome/Chromium)
```

세 결과는 섹션 1~3 의 문서적 주장과 정확히 일치한다: (a) API 존재, (b) headless-only, (c) Windows 에서 Chrome 외부 의존.

## 9. 권장 후속 조치

1. **문서 정정**: `MEMORY.md` 와 `docs/bun/phases-4-plus.md:256-275` 의 "Windows: WebView2 / Linux: WebKitGTK" 표기를 본 문서 §3 의 **Chrome CDP only** 로 교정.
2. **Phase 9.1 재정의**: `phases-4-plus.md` 의 9.1 을 "E2E 테스트 런타임" (전략 D) 로 재작성하고, 데스크톱 배포는 9.1-alt 로 분리.
3. **리스크 워치**: oven-sh/bun 이슈 #29347, #29367 fix 시점 추적 → 다음 마이너 (1.3.13~) 릴리스 노트에서 "visible window" 또는 "WebView2" 키워드 확인.

---

**Sources**
- [Bun.WebView API Reference](https://bun.com/reference/bun/WebView)
- [Bun v1.3.12 Release Notes](https://bun.com/blog/bun-v1.3.12)
- [DeepWiki — WebView API](https://deepwiki.com/oven-sh/bun/9.10-webview-api)
- [oven-sh/bun WebView issues](https://github.com/oven-sh/bun/issues?q=is%3Aissue+WebView)
- [webview-bun (3rd party FFI)](https://github.com/tr1ckydev/webview-bun)
