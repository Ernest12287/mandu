---
phase: 9.2
status: Green
audience: CLI / DX
last_verified: 2026-04-18
bun_version: 1.3.12
---

# Phase 9 R0.3 — `Bun.markdown` + Mandu CLI UX 통합 전략

## 1. 현황 — Bun.markdown 사용 가능성

- **Bun 1.3.12 에서 안정 제공.** 공식 릴리즈 노트에 `Bun.markdown.ansi()` 가 "new programmatic API" 로 등재됨 ([Bun 1.3.12 blog](https://bun.com/blog/bun-v1.3.12)).
- 본 워크스페이스의 `bun --version = 1.3.12` 로 확인 — 추가 설치/플래그 불필요.
- `typeof Bun.markdown === "object"` / 4 개 메서드 모두 native function 으로 노출: `html`, `ansi`, `render`, `react`.
- Experimental 플래그 아님. 공식 reference 문서 다음 경로에 존재:
  - https://bun.com/reference/bun/markdown
  - https://bun.com/docs/runtime/markdown
- 엔진은 Bun 자체 GFM 파서 (tables / strikethrough / task lists / autolinks 지원, marked-terminal 아님).

## 2. API Surface (실측 + 공식 ref 교차 검증)

```ts
// ANSI (터미널 렌더)
Bun.markdown.ansi(
  input: string | ArrayBufferLike | TypedArray | DataView,
  theme?: {
    colors?: boolean;      // ANSI 컬러/스타일 escape 출력 (기본 true)
    columns?: number;      // 줄바꿈 폭. 0 → 비활성
    hyperlinks?: boolean;  // OSC 8 clickable hyperlinks (모던 터미널)
    kittyGraphics?: boolean; // 인라인 이미지 (Kitty Graphics Protocol)
    light?: boolean;       // 라이트 테마 팔레트
  }
): string

// 기타
Bun.markdown.html(input, options?): string       // → <h1>...</h1>
Bun.markdown.render(input, callbacks?, options?): string  // 콜백 커스텀 렌더
Bun.markdown.react(input, overrides?, { reactVersion?: 18|19 }): React.Element
```

실측 벤치: 1000 회 렌더 총 **23.19 ms** (1 회당 **23 μs**), 23 KB 대형 입력 **1.08 ms** (Opteron dev box, 2026-04-18). `mandu --help` 한번 렌더의 지각 비용은 사실상 0.

## 3. ANSI 지원 수준 (실측 렌더 결과)

| 마크다운 요소 | 렌더 결과 | 비고 |
|---|---|---|
| H1/H2/H3 | Bold + 마젠타/시안/골드 + 언더라인(═/─) | 다크 테마 기본 |
| **bold** | `ESC[1m..ESC[22m` | |
| _italic_ | `ESC[3m..ESC[23m` | |
| `inline code` | 256-color 배경(#236) + 오렌지(#215) | |
| 코드 블록 | `┌─ ts / │ / └─` 프레임 + 키워드/숫자/메서드 syntax highlight | TS/JS 실측 — Prism 급 |
| 리스트 | 시안 `•` bullet, 번호 리스트는 시안 `1. 2. 3.`, 중첩 들여쓰기 자동 | |
| 태스크 리스트 | `☐ todo` / `☒ done` (녹색) | GFM |
| 테이블 | `┌┬┐ ├┼┤ └┴┘` Unicode box + 헤더 bold | GFM |
| 블록쿼트 | `│ quote` 회색 좌측 바 | |
| 링크 | 밑줄 + 파란색 + ` (url)` 명시 | `hyperlinks:true` → OSC 8 |
| 수평선/단락 | 정상 | |
| 이미지 | `kittyGraphics:true` 시 인라인 | 대부분 터미널 비지원 → 대체 텍스트 |

다크/라이트 팔레트 선택은 수동 (`light: true`) — 자동 터미널 배경 감지는 없음 (향후 `light` auto-detect 가능성은 Bun 측 미정).

## 4. Mandu 통합 4 지점

### A. `mandu init` 랜딩 (`packages/cli/src/commands/init.ts:457-516`)

현재 60 줄에 걸친 `console.log` + `theme.*` 수동 포매팅. 항목(Getting started / File structure / AI agent integration / Claude skills / Config integrity)을 단일 마크다운 템플릿으로 전환하면 **템플릿화 + i18n 용이 + 60 줄 → 1 템플릿**.

### B. 에러 메시지 구조화 (`packages/cli/src/errors/messages.ts:89-106`)

현행 `formatCLIError`: 3-줄 고정 포맷(`❌ Error [code]`, message, `💡` suggestion, `📖` docLink). 이를 마크다운 템플릿으로 대체하면 원인/해결/관련 링크를 **헤더+리스트+코드블록** 으로 구조화 가능. docLink 는 `hyperlinks:true` 로 OSC 8 클릭형 링크화.

### C. `mandu doctor` / `mandu info` / `mandu --help` (`packages/cli/src/terminal/help.ts`)

현재 `isRich()` 분기 + `theme.*` 기반 — 테이블 없음. 마크다운 테이블로 옵션/명령 매트릭스 렌더 시 `┌┬┐` 박스 자동 제공. `mandu doctor` 출력(환경 정보, 문제 진단 리스트, 체크섬)도 체크리스트로 구조화.

### D. `mandu generate` / `mandu build` 요약

생성/빌드 완료 시 파일 목록 + 다음 단계 안내 — 이미 `build-summary.ts` 존재. 마크다운 `- path/to/file` 리스트 + `## Next steps` 섹션으로 일관.

## 5. CLI_E* 에러 코드별 마크다운 템플릿 예시 3개

**CLI_E001 (INIT_DIR_EXISTS)**
```md
## ❌ CLI_E001 — Directory already exists

**Path**: `{path}`

### Cause
대상 경로에 이미 파일/디렉토리가 존재합니다.

### Resolution
- 다른 프로젝트 이름을 선택하거나
- 기존 디렉토리를 먼저 제거: `rm -rf {path}`

### See also
- [mandu init docs](https://mandu.dev/docs/cli/init)
```

**CLI_E010 (DEV_PORT_IN_USE)**
```md
## ❌ CLI_E010 — Port {port} already in use

### Cause
`{port}` 포트가 이미 다른 프로세스에 바인딩되어 있습니다.

### Resolution
| 방법 | 명령 |
|------|------|
| 다른 포트 지정 | `PORT=3334 bun run dev` |
| 설정 파일로 지정 | `mandu.config.ts` → `server.port` |
| 충돌 프로세스 찾기 | `lsof -i :{port}` (macOS/Linux) / `netstat -ano \| findstr :{port}` (Windows) |
```

**CLI_E022 (GUARD_VIOLATION_FOUND)**
```md
## ❌ CLI_E022 — {count} architecture violation(s) found

### Resolution
- 위의 상세 출력을 검토해 레이어 경계를 수정하세요.
- CI 통합용 출력이 필요하면: `MANDU_OUTPUT=agent mandu guard check`

### See also
- [Guard presets](https://mandu.dev/docs/guard)
```

## 6. Fallback 전략 (no-TTY / NO_COLOR)

**중요 발견**: `Bun.markdown.ansi()` 는 `NO_COLOR` / `FORCE_COLOR` / `process.stdout.isTTY` 를 **전혀 자동 감지하지 않음**. 실측에서 `NO_COLOR=1` 환경에서도 ANSI escape 를 그대로 방출. CI 로그 오염 방지를 위해 **호출 측에서 명시적 분기 필요**.

권장 래퍼 (기존 `terminal/theme.ts` 의 `isRich()` 재활용):

```ts
import { isRich } from "./terminal/theme";

export function renderMarkdown(md: string, opts?: { columns?: number }): string {
  return Bun.markdown.ansi(md, {
    colors: isRich(),        // NO_COLOR / TTY / TERM=dumb 존중
    columns: opts?.columns ?? (process.stdout.columns ?? 0),
    hyperlinks: isRich(),    // OSC 8 도 plain 환경에서는 비활성
  });
}
```

`colors: false` 실측: ESC 전부 제거된 **플레인 텍스트** 반환 (66 chars vs 211). CI 로그/파이프 안전.

## 7. 성능 영향

- 단일 렌더 평균 23 μs, 최대 단락 집합도 1 ms 이하.
- `mandu --help` / `mandu init` 랜딩 등 단발 경로는 **지각 영향 0**.
- 에러 렌더는 애초에 exit 직전 1 회 — 무시 가능.
- 핫 경로(`watch`/`dev` 재렌더)에서는 템플릿 캐싱 권장 (같은 입력에 동일 출력이므로 WeakMap/Map 캐싱 안전).

## 8. 단계적 마이그레이션 권장

**Phase 9.2-a (1 일)**: 내부 유틸 `packages/cli/src/terminal/markdown.ts` 에 `renderMarkdown(md)` + fallback 래퍼 추가. 테스트는 `bun test` 로 ESC 유무 검증.

**Phase 9.2-b (1-2 일)**: `formatCLIError` 내부를 마크다운 템플릿으로 재작성 — 외부 API (`printCLIError(code, ctx)`) 는 **시그니처 유지**. 기존 콜사이트 무변경. `ERROR_MESSAGES` 의 `message/suggestion/docLink` 필드를 단일 `template` 필드로 점진 전환 (backward compatible).

**Phase 9.2-c (2-3 일)**: `init.ts` 의 "Getting started" 섹션(60 줄)을 `templates/init-landing.md` 로 추출하고 `{{PROJECT_NAME}}` 치환 — 기존 템플릿 변수 기반과 일관.

**Phase 9.2-d (optional)**: `doctor` / `info` / `help` 의 테이블/리스트 출력을 마크다운화. `scripts/phase-9-bench-md.ts` 로 before/after 비교.

## 9. 경쟁 비교

| 대안 | 장점 | 단점 |
|------|------|------|
| `Bun.markdown.ansi` | zero-dep / native / 23μs / GFM / OSC8 / syntax highlight | Bun 전용, 테마 제한, NO_COLOR 수동 |
| `marked-terminal` | Node 호환 / 테마 깊이 | deps ~20, 느림(ms 단위), syntax highlight 불완전 |
| `@clack/prompts` | 인터랙션 중심 | 마크다운 아님, 보완재 |
| 수동 `theme.*` (현행) | 완전 제어 | 템플릿화 불가, 중복 |

Mandu는 이미 **`@mandujs/cli` 내부 전용 + Bun-only** 전제 → `Bun.markdown.ansi` 가 비교우위 명확.

## 10. 실행 가능성 — **Green**

- Bun 1.3.12 필수 (`packages/cli/package.json` `engines.bun` 으로 강제) — 이미 워크스페이스 충족.
- 위험 요소: `NO_COLOR` 미대응은 래퍼 한 줄로 해결. 외부 콜사이트 시그니처 무변경. 롤백 시 마크다운 템플릿 → 기존 `console.log` 복귀 용이.
- 추천 착수 시점: Phase 6 (1.0.0 하드닝) 이후 Phase 9.2 로 진행. Phase 9.1(WebView) 과 독립.

## 참조 URL

- [Bun v1.3.12 blog (ansi API 발표)](https://bun.com/blog/bun-v1.3.12)
- [Bun.markdown API reference](https://bun.com/reference/bun/markdown)
- [Bun markdown runtime docs](https://bun.com/docs/runtime/markdown)
- [오픈릿 파싱 예시](https://blog.openreplay.com/parse-markdown-bun/)
- [bun/docs/runtime/markdown.mdx (main)](https://github.com/oven-sh/bun/blob/main/docs/runtime/markdown.mdx)
