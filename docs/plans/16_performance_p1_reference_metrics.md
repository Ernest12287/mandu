# 16. Mandu Performance P1 Reference Metrics

작성일: 2026-05-01  
대상: P1 reference app 확장 및 non-HTTP metric 연결

---

## 0. 결론

P1에서는 P0의 `todo-app` home route 기준선을 더 넓은 프레임워크 표면으로 확장했다.

| 영역 | 상태 | 구현 |
|---|---|---|
| Hello SSR reference | 완료 | `hello-ssr-home`을 `demo/starter` 기반 active scenario로 승격 |
| CRUD/contract reference | 완료 | `blog-crud-contract-list`를 `demo/todo-app` 기반 active scenario로 승격 |
| Route scan metric | 완료 | `route_scan_p95_ms`를 `generateManifest()` wall-clock 측정으로 연결 |
| Resource generation metric | 완료 | `resource_generation_p95_ms`를 `parseResourceSchemas()` + `generateResourcesArtifacts()` 측정으로 연결 |
| HMR metric | 완료 | `auth-starter-hmr-island` manual scenario와 `perf:expanded` 스크립트 추가 |
| Hydration metric | 보류 | Windows browser launch 실패 환경에서는 계속 `unsupported` artifact로 기록 |

---

## 1. Frozen Baselines

2026-05-01 local Windows run 기준:

| Scenario | Metric | Baseline |
|---|---|---:|
| `hello-ssr-home` | `ssr_ttfb_p95_ms` | 2.0 |
| `hello-ssr-home` | `initial_js_bundle_kb` | 1043.7 |
| `blog-crud-contract-list` | `ssr_ttfb_p95_ms` | 1.7 |
| `blog-crud-contract-list` | `initial_js_bundle_kb` | 1041.9 |
| `blog-crud-contract-list` | `route_scan_p95_ms` | 35.1 |
| `blog-crud-contract-list` | `resource_generation_p95_ms` | 168.1 |
| `auth-starter-hmr-island` | `hmr_latency_p95_ms` | 24.2 |

---

## 2. Runner Behavior

- Default `bun run perf:ci` runs only `active` scenarios.
- `manual` scenarios are excluded from default CI, but can be run by explicit `--scenario`.
- `bun run perf:expanded` currently runs `auth-starter-hmr-island`.
- Browser benchmark failure is cached per `perf:run`; after the first failed launch, later hydration metrics are marked `unsupported` immediately.
- Resource generation measures derived artifact generation only:
  - contract
  - types
  - client
  - repo
- Resource slot files are intentionally excluded so perf runs never overwrite human-authored slots.

---

## 3. Reference Demo Fix

`demo/todo-app/spec/resources/note/note.resource.ts` was still shaped like a legacy Zod-only resource module. That made the resource generator path fail before it could be measured.

The file now keeps the exported Zod schemas for compatibility, but its default export is a current `defineResource()` definition. This makes the demo useful as a resource-generation benchmark without changing app-facing contracts.

---

## 4. Verification

Required checks for this P1 slice:

```bash
bun run perf:baseline:check
bun run perf:ci
bun run perf:expanded
bun run typecheck
```

Recommended full release-confidence checks before push:

```bash
bun run lint
bun run test:smoke
bun run check:publish
bun run test:packages
```

---

## 5. Remaining P2 Work

1. Make browser hydration reliable on Windows or provide a non-Playwright fallback.
2. Split `demo/starter` into a smaller pure SSR reference if the 1 MB JS payload is not acceptable for the hello scenario.
3. Move the CRUD/resource reference from `todo-app` into a dedicated `blog-crud-contract` demo once the sample app is created.
4. Promote `perf:expanded` into CI only after HMR watcher timings are stable across Windows and Linux runners.
