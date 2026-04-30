# 15. Mandu Performance Baseline Freeze Plan

작성일: 2026-04-30  
실행 갱신: 2026-05-01  
대상: Mandu v0.x 성능 기준선 고정  
범위: `tests/perf`, `scripts/perf-*`, `.github/workflows/ci.yml`, reference demo

---

## 0. 결론

Mandu의 성능 게이트는 이미 골격이 있다.

- `tests/perf/perf-baseline.json`이 metric, scenario, budget을 정의한다.
- `scripts/perf-baseline.ts`가 baseline schema를 검증한다.
- `scripts/perf-run.ts`가 active scenario를 실행하고 `.perf/latest/summary.json`을 만든다.
- `scripts/perf-budget.ts`가 measured value를 budget과 비교한다.
- CI에는 `performance-budget` job이 있고 `perf:ci`를 실행한다.

초기 확인 시점에는 "성능 기준선이 고정됐다"고 말할 수 없었다. active scenario의 baseline 값이 `null`이었고, local verification에서 `bun run perf:ci`가 실패했다. 2026-05-01 실행에서는 먼저 성능 측정 경로를 실제 reference demo에 다시 연결한 뒤, HTTP 기반 active baseline을 freeze했다.

---

## 0.1. 2026-05-01 진행 결과

| 항목 | 상태 | 결과 |
|---|---|---|
| P0-F-0 `perf:ci` green 복구 | 완료 | active scenario를 `demo/todo-app`에 연결하고 `bun run perf:ci`가 끝까지 실행된다. |
| P0-F-1 첫 측정값 채집 | 완료 | `bun run perf:run -- --runs 3 --warmup 1`로 dev/prod HTTP metric을 채집했다. |
| P0-F-2 baseline freeze | 부분 완료 | active scenario의 `ssr_ttfb_p95_ms`, `initial_js_bundle_kb` baseline을 채웠다. Hydration은 browser launch 실패로 `null` 유지. |
| P0-F-3 budget check 정책 | 완료 | `perf:budget:check`는 soft gate이며 report/annotation 중심으로 유지한다. |
| P0-F-4 갱신 절차 문서화 | 완료 | `tests/perf/README.md`에 baseline update 절차를 추가했다. |

Frozen active baseline:

| Scenario | Metric | Baseline |
|---|---|---:|
| `todo-app-home-dev` | `ssr_ttfb_p95_ms` | 74.5 |
| `todo-app-home-dev` | `initial_js_bundle_kb` | 1124.4 |
| `todo-app-home-prod` | `ssr_ttfb_p95_ms` | 2.2 |
| `todo-app-home-prod` | `initial_js_bundle_kb` | 0.0 |

`hydration_p95_ms`는 이 Windows 환경에서 Playwright/browser launch가 실패해 unsupported artifact만 남겼다.

---

## 1. 현재 확인한 상태

2026-04-30 local verification:

| Check | Result | 의미 |
|---|---|---|
| `bun run perf:baseline:check` | Pass | schema와 cross-reference는 유효하다. |
| `bun run perf:ci` | Pass after fix | active scenario 실행과 budget report 생성이 가능하다. |
| `demo/` 실제 목록 | `todo-app`, `ai-chat`, `auth-starter`, `starter`, `desktop-starter`, `edge-workers-starter` | active scenario의 app 이름과 불일치한다. |
| `tests/perf/perf-baseline.json` | active scenario app이 `todo-list-mandu` | 현재 checkout에는 해당 demo directory가 없다. |
| `tests/perf/perf-baseline.json` | active 2개, planned 3개, baseline pending 15개 | freeze 전 상태다. |

초기 실패 증상:

```text
bun run perf:ci
Running perf scenario: todo-list-home-dev
ENOENT: no such file or directory, uv_spawn 'bun'
```

1차 원인은 active scenario가 없는 demo path를 바라보는 것이었다. 이후 `.env`의 `PORT=4567`이 free port를 덮는 문제와 stale local `.mandu/lockfile.json`이 prod start를 막는 문제가 이어서 확인됐고, perf runner에서 CLI `--port`와 측정 전용 `MANDU_LOCK_BYPASS=1`을 사용하도록 정리했다.

---

## 2. Freeze 목표

성능 baseline freeze의 목표는 "Mandu가 빠르다"는 주장을 쓰는 것이 아니다. 목표는 다음이다.

1. 성능 측정이 재현 가능하다.
2. 기준 demo의 SSR, hydration, bundle size가 숫자로 저장된다.
3. PR에서 예산 초과와 측정 불능이 자동으로 드러난다.
4. Windows/CI/browser 불안정성은 `unsupported` artifact로 남기되 HTTP metric은 계속 수집한다.
5. baseline 갱신은 명시적인 리뷰 작업으로만 수행된다.

---

## 3. 공식 metric

현재 유지할 official metric:

| Metric | 단위 | 우선순위 | Freeze 상태 |
|---|---:|---|---|
| `ssr_ttfb_p95_ms` | ms | P0 | active scenario에서 먼저 freeze |
| `hydration_p95_ms` | ms | P0 | browser 안정성 확인 후 freeze, 실패 시 unsupported artifact |
| `initial_js_bundle_kb` | kb | P0 | active scenario에서 먼저 freeze |
| `hmr_latency_p95_ms` | ms | P1 | reference app 확정 뒤 freeze |
| `route_scan_p95_ms` | ms | P1 | route scanner scenario 추가 뒤 freeze |
| `resource_generation_p95_ms` | ms | P1 | resource benchmark 연결 뒤 freeze |

P0에서는 active scenario 2개의 세 metric만 freeze한다.

---

## 4. P0 실행 계획

### P0-F-0. `perf:ci` green 복구

목표: 현재 CI 성능 job이 실제 demo를 실행하게 만든다.

작업:

1. `tests/perf/perf-baseline.json`의 active scenario app을 현재 repo의 실제 reference demo로 맞춘다.
   - 후보: `demo/todo-app`
   - 기존 stale name: `todo-list-mandu`
2. scenario id도 실제 앱 이름과 맞게 정리한다.
   - 예: `todo-app-home-dev`
   - 예: `todo-app-home-prod`
3. `scripts/perf-run.ts`의 active app allowlist를 `todo-app` 기준으로 갱신한다.
4. `bun run perf:ci`를 local에서 통과시킨다.
5. `.perf/latest/summary.json`, `.perf/latest/report.md`, `.perf/latest/budget-check.md`가 생성되는지 확인한다.

완료 기준:

- `bun run perf:baseline:check` pass
- `bun run perf:ci` pass
- `summary.json`에 active scenario 2개가 들어간다.
- 측정 불능 metric은 실패 없이 `unsupported`로 남고 warning artifact가 생성된다.

---

### P0-F-1. Active scenario 첫 측정값 채집

목표: `todo-app` dev/prod home route를 각각 최소 반복으로 측정한다.

명령:

```bash
bun run perf:run -- --scenario todo-app-home-dev --runs 3 --warmup 1
bun run perf:run -- --scenario todo-app-home-prod --runs 3 --warmup 1
bun run perf:budget:check -- --summary .perf/latest/summary.json --markdown-out .perf/latest/budget-check.md
```

작업:

1. dev/prod scenario를 따로 실행해서 실패 원인을 분리한다.
2. HTTP 기반 `ssr_ttfb_p95_ms`, `initial_js_bundle_kb`는 반드시 수집한다.
3. browser 기반 `hydration_p95_ms`는 성공 시 수집하고, 실패 시 `browser-error.txt`를 남긴다.
4. local 측정값을 2~3회 반복해서 변동폭을 확인한다.

완료 기준:

- dev/prod 각각 `summary.json` 결과가 안정적으로 생성된다.
- HTTP metric이 `n/a`가 아니다.
- hydration이 `unsupported`이면 원인 artifact가 있다.

---

### P0-F-2. Baseline 값 freeze

목표: budget 안의 `baseline: null`을 실제 측정값으로 채운다.

원칙:

1. baseline은 budget이 아니다.
   - baseline: 현재 기준값
   - budget: 허용 한계값
2. baseline은 단일 run 값이 아니라 안정 측정값의 보수적 대표값으로 잡는다.
3. P0에서는 active scenario만 채운다.
4. planned scenario의 `baseline: null`은 유지한다.
5. Windows에서 browser metric이 불안정하면 hydration baseline은 `null`로 유지하고 notes에 unsupported 조건을 기록한다.

완료 기준:

- active scenario의 HTTP metric baseline이 `null`이 아니다.
- freeze 기준과 측정 날짜가 `tests/perf/README.md` 또는 plan follow-up에 기록된다.
- `bun run perf:baseline:check`가 baseline 값 포함 상태에서도 pass한다.

---

### P0-F-3. Budget check 정책 고정

목표: CI가 무엇을 차단하고 무엇을 경고로 둘지 명확히 한다.

정책 초안:

| 상태 | local | PR CI | main push |
|---|---|---|---|
| `pass` | 통과 | 통과 | 통과 |
| `warn` | 통과 + report | 통과 + annotation | 통과 + artifact |
| `fail` | `--enforce` 없으면 통과 | 초기에는 warning | main push에서는 fail 후보 |
| `unsupported` | 통과 + artifact | 통과 + annotation | 반복 발생 시 issue |

P0에서는 hard fail보다 visibility를 우선한다. P1에서 main push hard fail을 도입한다.

완료 기준:

- `perf:budget:check` 결과 해석이 docs와 CI에서 동일하다.
- `.perf/latest/budget-check.md`가 artifact로 남는다.
- unsupported metric은 조용히 묻히지 않는다.

---

### P0-F-4. Baseline 갱신 절차 문서화

목표: 성능 숫자를 아무 PR에서나 바꾸지 못하게 한다.

규칙:

1. baseline 변경 PR은 `perf baseline update` 성격으로 분리한다.
2. baseline 변경에는 `.perf/latest/report.md` 요약을 첨부한다.
3. budget 완화는 별도 justification이 있어야 한다.
4. runtime/bundler/client 변경 PR은 baseline을 같이 바꾸지 않는다.

완료 기준:

- `tests/perf/README.md`에 freeze/update 절차가 들어간다.
- baseline 값 변경 시 어떤 명령을 돌렸는지 남길 수 있다.

---

## 5. P1 확장 계획

P0가 끝난 뒤에만 진행한다.

1. `hello-ssr` reference app 추가 또는 기존 `starter`를 공식 `hello-ssr`로 승격한다.
2. `blog-crud-contract` reference app을 `todo-app`에서 분리할지 결정한다.
3. `dashboard-auth-island` 또는 `auth-starter`를 island-heavy scenario로 승격한다.
4. `hmr_latency_p95_ms` 측정 runner를 추가한다.
5. `route_scan_p95_ms`를 CLI/build scanner 경로와 연결한다.
6. `resource_generation_p95_ms`를 resource benchmark와 연결한다.

---

## 6. 리스크와 대응

| Risk | 대응 |
|---|---|
| Windows에서 Playwright launch가 불안정함 | browser metric은 `unsupported`로 남기고 HTTP metric은 계속 수집한다. |
| dev server가 HMR connection 때문에 종료되지 않음 | process tree termination을 유지하고 종료 실패를 warning으로 기록한다. |
| demo 이름/경로가 다시 drift됨 | active scenario app은 실제 `demo/<name>` 존재 여부를 schema check에서 검증한다. |
| budget과 baseline 의미가 섞임 | README에 baseline과 budget 정의를 분리한다. |
| planned scenario가 gate를 오염시킴 | P0에서는 active scenario만 실행한다. |

---

## 7. 첫 PR 체크리스트

첫 PR 제목 후보:

```text
perf: reconnect baseline runner to reference demo
```

체크리스트:

- [x] `tests/perf/perf-baseline.json` active scenario app/id를 `todo-app` 기준으로 갱신
- [x] `scripts/perf-run.ts` active app allowlist를 실제 demo 이름과 맞춤
- [x] `scripts/perf-baseline.ts`가 active scenario의 `demo/<app>` 존재 여부를 검증
- [x] `tests/perf/README.md`에 freeze/update 절차 추가
- [x] `bun run perf:baseline:check`
- [x] `bun run perf:ci`
- [x] `.perf/latest/summary.json` 확인
- [x] `.perf/latest/budget-check.md` 확인

---

## 8. Definition of Done

P0 freeze가 완료됐다고 말하려면 아래가 모두 참이어야 한다.

1. `bun run perf:ci`가 local과 CI에서 통과한다.
2. active scenario가 실제 reference demo를 바라본다.
3. active scenario의 HTTP baseline 값이 `null`이 아니다.
4. hydration이 측정 불능이면 artifact와 정책이 남는다.
5. budget check report가 CI artifact로 남는다.
6. baseline 변경 절차가 문서화되어 있다.

이 상태가 되어야 Mandu의 성능 게이트는 "계획"이 아니라 "운영 가능한 품질 장치"가 된다.
