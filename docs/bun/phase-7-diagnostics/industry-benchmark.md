---
title: "Phase 7 — 풀스택 HMR 업계 벤치마크"
status: research
updated: 2026-04-18
scope: Vite 6 / Next.js 15 (App Router) / Remix·React Router 7 / SvelteKit 2 / SolidStart (Vinxi) / Nuxt 3
purpose: Mandu Phase 7 (HMR/배포) 설계 참고 — Bun 네이티브 + island 철학 관점에서 "무엇을 따라하고 무엇을 의도적으로 다르게 갈지" 도출
---

> **이 문서의 사용법**: 섹션 3(Minimum feature set) → 섹션 4(구현 전략) → 섹션 5(함정) 순으로 읽으면 Phase 7 스코프 의사결정에 바로 쓸 수 있다. 섹션 1·2는 참조용.

---

## 1. 비교 표

횡: 프레임워크 / 종: 시스템 리마인더의 질문 8개. 모두 공식 문서 또는 1차 이슈 기반.

| # | 질문 | Vite 6 | Next.js 15 (App Router) | Remix / RR7 (Vite) | SvelteKit 2 | SolidStart (Vinxi) | Nuxt 3 |
|---|------|--------|-------------------------|--------------------|-------------|---------------------|--------|
| 1 | `import.meta.hot` API surface | **full**: accept / dispose / prune / invalidate / decline(no-op) / on / off / send / data | partial: Webpack `module.hot` 노출하지만 사용자 API는 Fast Refresh로 추상화 | partial: Vite 위임 (`import.meta.hot` 그대로) | full (Vite 위임). 단 Svelte 5 이후 `@hmr:keep` 디렉티브 더 이상 동작 안 함 | full (Vite 위임) + `solid-refresh` babel | full (Vite 위임) |
| 2 | CSS HMR | **style-only swap** (`<link>`/`<style>` 교체, 풀 리로드 없음) | style-only swap (Vercel/webpack-hmr). 단 middleware 존재 시 매번 style 재주입 버그 리포트됨 | style-only (Vite) | style-only (Vite) | style-only (Vite) | style-only. 단 단일 포트 미설정 시 MIME/CORS로 full reload 떨어지는 리포트 다수 |
| 3 | 서버 코드 수정 시 브라우저 반영 | v5: 서버 HMR 없음 → full reload. v6: ModuleRunner로 HMR 지원 | Fast Refresh 스코프 밖 → **full reload** + `x-nextjs-revalidate` 헤더로 RSC 재요청 | Remix Vite: **HDR** (Hot Data Revalidation) — 컴포넌트 state 유지하고 loader 데이터만 refetch | 서버 훅 수정 시 Vite ssrLoadModule 무효화 후 컴포넌트 re-render. full reload 드묾 | 서버 핸들러 수정 시 페이지 리로드 | vite-node로 0.01ms급 SSR 무효화. 컴포넌트는 유지, 서버 모듈만 교체 |
| 4 | Prerender된 SSR HTML 변경 트리거 | SSR은 Vite가 직접 처리 안 함. 프레임워크 책임 | 서버 모듈 변경 → 페이지 캐시 무효화 + RSC stream 재전송 | HDR이 loader만 refetch (페이지 재생성 X) | dev 모드는 항상 on-demand SSR (prerender 재생성 개념 없음) | 기본 on-demand SSR | 동일 — vite-node로 즉시 재렌더 |
| 5 | Scroll/form state 보존 | **preserve** (HMR 경로). full reload 시 손실 | preserve (Fast Refresh). full reload fallback 시 손실 | preserve (Fast Refresh + HDR) | preserve. 단 Svelte 5에서 local state reset 회귀 (sveltejs/svelte#14434) | preserve via solid-refresh | preserve. HMR 루프 버그 때 손실 (#25298) |
| 6 | Error overlay | 내장 (`vite:error` 이벤트 + 빨간 오버레이) | 내장 (contextual overlay, syntax error 자동 dismiss) | 내장 (Vite 오버레이 + Remix 커스텀 래퍼) | 내장 (Vite) | 내장 (Vite) | 내장 (Vite) + Nuxt devtools |
| 7 | 전송 레이어 | **WebSocket** (`HotChannel` 추상화, token 검증). payload: `connected` / `update` / `full-reload` / `prune` / `error` | Webpack WebSocket (`_next/webpack-hmr`). Turbopack도 WS | WebSocket (Vite) | WebSocket (Vite) | WebSocket (Vite) | WebSocket (Vite). HMR port 고정 권장 |
| 8 | OS별 동작 차이 | Windows: chokidar `EBUSY`(pagefile/hiberfil) 빈발, WSL2에서 `usePolling:true` 강제 필요. v7: chokidar v4. | Windows: 일반적으로 동작. Docker 환경에서 polling 필요 | Vite 상속 | Vite 상속 | Docker/WSL에서 `[vite] server connection lost` 자주 (#159) | Windows/Docker에서 HMR port/host 수동 고정 필수 (#1036, 블로그 다수) |

**핵심 관찰**:
- 6개 중 5개가 Vite에 정착 → 사실상 `import.meta.hot` 이 **업계 표준 surface**.
- 서버 코드 HMR은 **Remix의 HDR이 가장 선명한 철학**(loader만 refetch, UI state 유지) → Mandu의 slot 컨셉과 정확히 매핑.
- Windows 지원은 어디나 취약. chokidar `EBUSY`가 가장 흔한 원인.

---

## 2. `import.meta.hot` API 상세 (Vite spec)

Vite는 이 API의 모든 접근을 `if (import.meta.hot)` 가드로 감싸 **프로덕션에서 트리 셰이킹**되도록 강제한다. 아래 시그니처는 [Vite HMR API 공식 문서](https://vite.dev/guide/api-hmr) 기준.

### 2.1 `accept` — 4가지 오버로드

```ts
// (a) No-op self-accept: "나는 업데이트 받아들일 수 있어" 플래그만 세움
import.meta.hot.accept()

// (b) Self-accept with callback: 교체된 내 모듈 네임스페이스 수신
import.meta.hot.accept((newModule) => {
  render(newModule.default)
})

// (c) Dep-accept: 특정 의존성이 바뀌면 내가 처리
import.meta.hot.accept('./foo.js', (newFoo) => {
  newFoo?.foo()
})

// (d) Multi-dep-accept: 여러 의존성 배치 수신
import.meta.hot.accept(['./foo.js', './bar.js'], ([newFoo, newBar]) => { /* ... */ })
```

**정적 분석 제약**: `import.meta.hot.accept(` 문자열이 원본 소스에 **그대로** 나타나야 Vite가 HMR 바운더리로 인식. 동적 참조 불가.

### 2.2 `dispose` / `prune` — 라이프사이클 분리

- `dispose(cb)`: 모듈이 **교체되기 직전** — 사이드 이펙트 정리.
- `prune(cb)`: 모듈이 더 이상 어디서도 import 안 되어 **완전히 제거될 때** 한 번만.

```ts
let timer: Timer
export function start() { timer = setInterval(...) }

if (import.meta.hot) {
  import.meta.hot.dispose(() => clearInterval(timer))  // 매 교체마다
  import.meta.hot.prune(() => console.log('fully gone')) // 완전 제거 시 1회
}
```

### 2.3 `invalidate(msg?)` — "나 포기할래, 위로 전파해줘"

self-accept 콜백 안에서 조건부로 호출. 풀 리로드 대신 **상위 importer 체인으로 HMR propagation**을 에스컬레이트.

```ts
import.meta.hot.accept((mod) => {
  if (breakingChange(mod)) {
    import.meta.hot.invalidate('schema incompatible, retry upstream')
  }
})
```

### 2.4 `on` / `off` / `send` — 이벤트 채널

내장 이벤트 8종 (`vite:beforeUpdate` / `vite:afterUpdate` / `vite:beforeFullReload` / `vite:beforePrune` / `vite:invalidate` / `vite:error` / `vite:ws:disconnect` / `vite:ws:connect`) + 플러그인 커스텀 이벤트.

```ts
if (import.meta.hot) {
  import.meta.hot.on('vite:beforeFullReload', (payload) => {
    analytics.flush()
  })
  import.meta.hot.send('custom:profile', { at: Date.now() })
}
```

### 2.5 `data` — HMR 사이클 간 상태 저장

```ts
import.meta.hot.data.counter ??= 0  // 재할당 금지, mutation만 지원
import.meta.hot.data.counter++
```

**주의**: `decline()` 은 backward-compat 용 no-op. 새 코드는 `invalidate()` 만 사용.

---

## 3. Mandu가 따라잡아야 할 minimum feature set

Phase 7 v0.1 / 7.1 / 7.2+ 3단계로 분류. 각 항목은 **사용자 가치**와 **Mandu 철학 적합성**으로 판단.

### 3.1 Must have — Phase 7 v0.1

- [ ] **`import.meta.hot.accept` / `dispose` / `data`** — Vite와 시그니처 호환
  - *이유*: 업계 표준 API. 커뮤니티 플러그인/스니펫/AI 코드가 전부 이 surface를 전제로 쓴다. 호환 안 하면 모든 외부 자산이 무용.
  - *가치*: 사용자가 Vite 문서/GitHub 예제를 그대로 복붙 가능.
- [ ] **Island 컴포넌트 Fast Refresh** — React 19 + `react-refresh` 통합
  - *이유*: Mandu의 유일한 "stateful" 존은 island. 나머지는 SSR이라 상태 보존 이슈 적음.
  - *가치*: island 파일 수정 시 form input/scroll 유지 → 실제 개발 체감 UX의 90%.
- [ ] **CSS style-only swap** — `<link>` 태그 timestamp 교체
  - *이유*: Tailwind/globals.css 수정이 전 페이지 full reload를 일으키면 사용자가 devtool을 끄는 편을 선택한다.
  - *가치*: 이미 v0.18.6에서 `fs.watch(outputPath)` 로 CSS 파일 워처는 구축됨 — HMR payload만 만들면 됨.
- [ ] **Pure-SSR 프로젝트에서 공통 파일 수정 시 prerender 재생성** — *이슈 #188 해결*
  - *이유*: 현재 island 없는 프로젝트에서 layout/util 수정이 브라우저에 반영 안 됨. **이게 Phase 7 본연의 동기**.
  - *가치*: `auth-starter` 같은 순수 SSR 데모가 dev 모드에서 제대로 동작.
- [ ] **WebSocket 재연결 + exponential backoff** — 기존 ssr.ts / streaming-ssr.ts 이미 있음, 단일 클라이언트 모듈로 통합
  - *이유*: dev 서버 재시작 시 클라이언트가 자동 복구 안 되면 사용자가 F5 누르게 된다.

### 3.2 Should have — Phase 7.1

- [ ] **`import.meta.hot.invalidate` + `on` 이벤트 채널** — `vite:beforeFullReload` / `vite:afterUpdate` 최소한
  - *이유*: 프레임워크 레이어(Mandu 내부 client runtime)가 자기 자신의 업데이트를 관측하기 위해 필요.
- [ ] **Loader(slot) HMR = Remix HDR 스타일** — slot 함수만 바뀌면 페이지 재생성 없이 데이터만 refetch
  - *이유*: Mandu slot = Remix loader 개념 1:1 대응. HDR 아이디어가 완벽히 맞음.
  - *가치*: DB 쿼리 수정 → 페이지 리마운트 없이 fresh props 주입.
- [ ] **Resource schema 변경 시 타입 재생성 트리거** — `.mandu/generated/**` watch + 클라이언트에 `schema:updated` 브로드캐스트
  - *이유*: Mandu는 code-gen 강한 프레임워크. DDL 바꾸고 리스타트해야 한다면 DX 미완성.
- [ ] **Error overlay 한국어/영어 토글 + stack trace source-map**
  - *가치*: Bun source-map이 v8 기본보다 나음 — 이걸 살린 오버레이.

### 3.3 Nice to have — Phase 7.2+

- [ ] **`import.meta.hot.prune` + plugin 이벤트 send/on**
  - *이유*: 파워유저/플러그인 생태계 생길 때 필요. v0.1엔 불필요.
- [ ] **HMR 토큰 인증** — Vite v5+ 추가한 보안 기능 (localhost 바인딩 외 원격 dev 시)
  - *이유*: Bun.WebView Phase 9 / 원격 협업 dev 시나리오 열릴 때.
- [ ] **Single-port HMR** — dev 서버와 HMR WebSocket이 같은 포트
  - *이유*: Nuxt HMR CSS Fix 블로그가 지적한 방화벽/프록시 친화성. 초기엔 포트 분리도 OK.
- [ ] **`import.meta.hot.decline` 호환 no-op** — 레거시 코드 그대로 동작.

---

## 4. 구현 전략 권장

### 4.1 Vite 호환 API를 subset으로 구현 — 권장

**Mandu가 전체를 구현할 필요 없음**. 다음 subset만:

```
v0.1: accept(self), accept(self + cb), dispose, data
v0.2: accept(dep, cb), invalidate, on('vite:beforeUpdate'|'vite:afterUpdate'|'vite:beforeFullReload'|'vite:error')
v1.0: accept([deps], cb), prune, send, off, 나머지 이벤트
```

**근거**:
1. 업계 관찰 — Next.js도 Webpack `module.hot` 은 있지만 사용자는 Fast Refresh로만 쓴다. 즉 **풀스택 프레임워크에서 `import.meta.hot` 은 프레임워크 내부 runtime 전용 API**다. 95% 사용자는 직접 안 쓴다.
2. Mandu의 첫 소비자는 **Mandu 자체 client runtime** (island 하이드레이터, router). 이 쪽만 만족시키면 됨.
3. Vite spec 전체 재구현하면 "왜 Vite 안 쓰지?" 질문이 커진다. **차별점은 Bun 네이티브 + island**이지 HMR surface가 아님.

### 4.2 SSR prerender 재생성 vs Fast Refresh — **둘 다 하이브리드**

| 변경 타입 | 전략 | 이유 |
|----------|------|------|
| Island (`.client.tsx`) | **Fast Refresh** (react-refresh) | state 보존 필수 |
| Slot (`.slot.ts` 서버 데이터) | **HDR 스타일 refetch** | UI state 유지 + fresh data |
| Layout/page component (서버 렌더) | **Prerender 재생성 + WS `full-reload` broadcast** | state 없는 SSR이라 full reload가 오히려 정직 |
| Resource/manifest | **재생성 + full reload** | type mismatch 위험 — clean slate가 안전 |
| CSS | **style swap** | state 영향 zero |

**근거**: Remix HDR 패턴이 Mandu slot/island 분리와 완벽히 직교. Next.js가 서버 컴포넌트 수정 시 RSC stream 재전송으로 해결하는 건 우리가 따라갈 필요 없음 (React Server Component 안 쓰므로).

### 4.3 WebSocket 프로토콜 compat layer — **선택적**

- Vite HMR payload (`type: 'update' | 'full-reload' | 'prune' | 'error'`) 구조를 **서버→클라이언트** 한 방향만 흉내내면 외부 툴(브라우저 devtools 확장, IDE 연동)이 그대로 동작.
- 클라이언트→서버는 굳이 호환 불필요 (`send` 는 Phase 7.2+).

**제안 메시지 스키마** (Vite 호환):
```ts
type HMRPayload =
  | { type: 'connected' }
  | { type: 'update', updates: Array<{ type: 'js-update'|'css-update', path: string, timestamp: number }> }
  | { type: 'full-reload', path?: string }
  | { type: 'prune', paths: string[] }
  | { type: 'error', err: { message: string, stack?: string, loc?: { file: string, line: number, column: number } } }
```

`path` 만 Mandu 규약으로 `.mandu/generated/...` 포함해도 Vite 클라이언트는 열어보지 않음 — **wire 포맷만 맞추고 내부 해석은 자유**.

### 4.4 파일 워처 — chokidar 유지

이미 메모리에 기록됨: "Bun fs.watch는 debounce/aggregation 없음 → chokidar 유지". Phase 7에서도 이 결정 유지. 단:
- chokidar v4로 상향 (Vite v7 행보 추종)
- Windows `EBUSY` 대응: `ignored` 에 `**/pagefile.sys`, `**/hiberfil.sys`, `**/DumpStack.log` 기본 추가

---

## 5. 주의해야 할 함정 (각 프레임워크 실제 보고된 버그)

### 5.1 Vite
1. **심볼릭 링크 경로 → HMR 깨짐** ([vitejs/vite#10558](https://github.com/vitejs/vite/issues/10558)) — monorepo에서 `pnpm` 심볼릭 링크가 ModuleGraph 노드 중복 생성. → **Mandu 대응**: `realpath` 정규화를 FS scanner에 강제.
2. **Windows chokidar `EBUSY`** — 루트 경로 잘못 추가 시 `pagefile.sys` 같은 시스템 파일 watch 시도 → 크래시. → **Mandu 대응**: 4.4의 기본 ignore 리스트.
3. **HMR 토큰 미검증 경로** ([029dcd6 커밋](https://github.com/vitejs/vite/commit/029dcd6d77d3e3ef10bc38e9a0829784d9760fdb)) — 원격 dev 시 WS 하이재킹 가능했음. → **Mandu 대응**: v0.1은 localhost-only, 원격 노출 시 토큰 필수.

### 5.2 Next.js
4. **middleware.ts 있을 때 매 편집마다 style 재주입 (FOUC)** (LogRocket 리포트 + vercel/next.js 다수 이슈). → **Mandu 대응**: middleware-like 개념 추가 시 style 토큰 안정성 테스트.
5. **Config file 수정은 HMR 스코프 외 → manual restart** ([nextjs.org/docs/messages/fast-refresh-reload](https://nextjs.org/docs/messages/fast-refresh-reload)). → **Mandu 대응**: `mandu.config.ts` 변경 자동 서버 재시작 명시. Nuxt 처럼 사용자 기대치 관리.
6. **Anonymous arrow component → Fast Refresh OFF** — `export default () => <div />` 전부 state reset. → **Mandu 대응**: 린트 규칙 + `// @refresh reset` 같은 directive 지원.

### 5.3 Remix / React Router 7
7. **Cyclic imports → HMR 호출 스택 초과** (2026 릴리즈노트 언급). → **Mandu 대응**: 순환 import 감지 시 HMR 무력화 + full reload로 graceful.
8. **User-defined route export → 전체 full reload** — Remix는 `loader/action/meta/links/headers` 외 export는 모두 포기. → **Mandu 대응**: slot 파일의 "허용 export" 화이트리스트를 문서화.

### 5.4 SvelteKit
9. **Svelte 5에서 `@hmr:keep-all` / `preserveLocalState` 모두 미동작** ([sveltejs/svelte#14434](https://github.com/sveltejs/svelte/issues/14434)) — svelte-hmr deprecated 후 내장으로 이전하며 regress. → **Mandu 교훈**: HMR 엔진 교체 시 state 보존 회귀 테스트 필수.

### 5.5 SolidStart / Vinxi
10. **Entrypoint 파일은 HMR 불가 — 항상 hard reload** (공식 문서). → **Mandu 대응**: entry (예상: `manifest.ts`, root layout) 범위를 명시 + UI로 "entrypoint 편집 감지 → 재시작 중..." 토스트.
11. **Docker/WSL `[vite] server connection lost`** ([solidjs/vite-plugin-solid#159](https://github.com/solidjs/vite-plugin-solid/issues/159)) — `usePolling` 기본 필요. → **Mandu 대응**: `MANDU_DEV_WATCH=polling` env 지원.

### 5.6 Nuxt 3
12. **3.9.0+ 무한 폴더 생성 루프** ([nuxt/nuxt#25298](https://github.com/nuxt/nuxt/issues/25298)) — WS 프로토콜 강제 설정이 원인. → **Mandu 교훈**: WS 프로토콜 auto-detect가 사용자 override보다 안전.
13. **3.15.3 HMR 완전 회귀** ([nuxt-modules/storybook#891](https://github.com/nuxt-modules/storybook/issues/891)) — 외부 통합 깨짐. → **Mandu 교훈**: HMR 계약 변경은 semver major.

---

## 부록. 참고 링크

- [Vite HMR API — 공식](https://vite.dev/guide/api-hmr)
- [Vite HMR 아키텍처 — DeepWiki](https://deepwiki.com/vitejs/vite/5-hot-module-replacement-(hmr))
- [Next.js Fast Refresh](https://nextjs.org/docs/architecture/fast-refresh)
- [Next.js "had to perform full reload"](https://nextjs.org/docs/messages/fast-refresh-reload)
- [Remix HMR (v2 docs)](https://v2.remix.run/docs/discussion/hot-module-replacement)
- [React Router 7 Vite 통합](https://remix.run/blog/react-router-v7)
- [svelte-hmr npm](https://www.npmjs.com/package/svelte-hmr)
- [Svelte 5 state preservation issue](https://github.com/sveltejs/svelte/issues/14434)
- [SolidStart Vinxi README](https://github.com/nksaraf/vinxi)
- [solid-refresh](https://github.com/solidjs/solid-refresh)
- [ViteRuntime / ModuleRunner 안정화 논의](https://github.com/vitejs/vite/discussions/15774)
- [LogRocket: 7 common Next.js HMR issues](https://blog.logrocket.com/7-common-next-js-hmr-issues/)
- [Nuxt HMR CSS Fix 블로그](https://blog.walterclayton.com/nuxt-hmr-css-fix/)
- [Vite 심볼릭 링크 HMR 버그](https://github.com/vitejs/vite/issues/10558)
- [Vite HMR 토큰 검증 커밋](https://github.com/vitejs/vite/commit/029dcd6d77d3e3ef10bc38e9a0829784d9760fdb)
- [Nuxt HMR 무한 루프 이슈](https://github.com/nuxt/nuxt/issues/25298)
