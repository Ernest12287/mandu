# Issue #245 — 디자인 시스템 닫는 메커니즘 (DESIGN.md + Guard + MCP + 에이전트 루프)

> 상태: 기획 v2 (2026-04-28)
> 출처: GitHub Issue #245 + DESIGN.md 컨벤션(Google Stitch) + awesome-design-md(VoltAgent, 69개 브랜드 카탈로그)
> 관련: mandujs.com 작업 중 발견된 에이전트 CSS 회귀 패턴

---

## 0. v2 변경 요약 (v1 대비)

v1은 "Mandu가 자체 `CLAUDE.md` 디자인 규약 템플릿을 정의"하는 방향이었음. 외부 리서치(아래 두 출처) 결과 **이미 사실상 표준이 존재**한다는 사실 발견:

- **DESIGN.md (Google Stitch)** — 9-section 마크다운 디자인 시스템 명세. AI 에이전트가 가장 잘 읽는 평문 포맷.
- **awesome-design-md (VoltAgent, MIT)** — Apple / Stripe / Spotify 등 69개 브랜드의 DESIGN.md를 역공학으로 정리한 공개 컬렉션. `npx getdesign@latest add stripe` 같은 CLI도 이미 존재.

→ Mandu가 자체 포맷을 발명하는 대신 **DESIGN.md를 일급 시민으로 채택**하고, 그 위에 enforcement(Guard) / discovery(MCP) / 에이전트 루프(DX) 레이어를 얹는 방향으로 피벗. 결과: 발명 비용 0, 에코시스템 호환 즉시 확보, 사용자가 awesome-design-md에서 바로 가져다 쓰기 가능.

핵심 정합성: "Mandu는 디자인 *내용*을 정해주지 않는다" — DESIGN.md 채택은 *형식*만 표준화하는 거라 이 원칙과 일치. 메모리에 저장된 "framework 본연" 피드백과도 어긋나지 않음 — UI primitive 추가가 아니라 enforcement 인프라.

---

## 1. 문제 정의

### 1.1 증상

mandujs.com 작업 중 반복적으로 발견된 에이전트 회귀:

- 같은 `nav` 코드를 landing 페이지와 docs 페이지 두 군데에 인라인으로 짜고 한쪽만 수정 → CSS 회귀
- `btn-hard` 클래스를 페이지마다 손으로 조합하다가 `whitespace-nowrap` 같은 디테일을 빠뜨림
- 한 번 우회한 인라인 패턴이 코드에 남아 다음 에이전트가 그것을 모방 → 회귀가 누적

### 1.2 근본 원인 두 가지

1. **에이전트는 프로젝트에 어떤 컴포넌트가 이미 있는지 모른다.**
   매번 grep 하고, 못 찾으면 인라인으로 다시 짠다.
2. **디자인 위반이 빌드 게이트가 아니다.**
   `className="btn-hard ..."` 인라인 사용을 lint warning으로조차 안 잡음 → 회귀를 차단하는 자동 메커니즘이 없다.

### 1.3 mandujs.com 사례에서 손으로 막은 결과물

- 컴포넌트 추출: `<MButton>`, `<NavShell/Group/Link/Brand>`, `<LanguageSwitcher>`, `<SiteHeader>`, `<DocsHeader>`
- `CLAUDE.md` 작성: 절대 규칙 6개 + 컴포넌트 카탈로그 + 디자인 토큰 + 검증 체크리스트 + 회귀 패턴 표

이 작업을 만두 사용자 모두가 매번 손으로 해야 한다 → 만두 코어가 메커니즘을 제공해야 한다.

---

## 2. 핵심 통찰

### 2.1 만두는 디자인 *내용*을 정해주면 안 된다

만두 자체에 색/폰트/shadow를 박아넣으면 만두 = "warm cream + peach" 프레임워크가 된다. 그건 컴포넌트 라이브러리지 프레임워크가 아니다. shadcn이 잘 된 이유도 *스타일을 정해주지 않고 코드를 복붙해주는 것*이었다.

**만두가 줘야 할 것은 디자인 시스템의 *내용*이 아니라, 그것을 *닫는 메커니즘*이다.**

| 만두가 줘야 할 것 | 만두가 주면 안 되는 것 |
|---|---|
| 디자인 시스템 *위치/포맷 컨벤션* (= DESIGN.md) | 색 / 폰트 / shadow 스타일 |
| DESIGN.md → Tailwind `@theme` *변환 메커니즘* | 어떤 토큰 값을 써야 하는지 |
| 인라인 우회 *검사 메커니즘* (Guard) | 어떤 클래스를 금지할지 |
| 컴포넌트 *디스커버리 도구* (MCP) | 컴포넌트 자체 |

### 2.2 DESIGN.md (Google Stitch) — 채택할 외부 표준

**왜 마크다운인가**: LLM이 가장 잘 읽는 포맷. Figma export / JSON schema 같은 특수 도구 불필요. 평문 텍스트로 어떤 AI 코딩 에이전트도 즉시 이해 가능.

**9-section 구조**:

| § | 섹션 | 내용 |
|---|---|---|
| 1 | Visual Theme & Philosophy | 시각적 분위기, 디자인 철학 |
| 2 | Color Palette | 색상 (이름 + 16진수 + 기능적 역할) |
| 3 | Typography | 폰트 계층, weight, size, line-height |
| 4 | Components | 버튼/카드/입력/네비 — variant + 상태 |
| 5 | Layout | spacing scale, grid, whitespace 철학 |
| 6 | Depth & Elevation | shadow system, surface 계층 |
| 7 | Do's & Don'ts | 권장/금지 패턴 (= Guard 룰의 자연스러운 입력) |
| 8 | Responsive | breakpoint, touch target, 축소 전략 |
| 9 | Agent Prompts | 색상 참조, 바로 사용 가능한 프롬프트 |

**채택 효과**:
- Mandu 사용자 = `npx getdesign@latest add stripe` 한 줄로 DESIGN.md 받아옴 → Mandu가 그걸 읽어 enforcement / discovery 자동 수행.
- awesome-design-md의 69개 카탈로그 그대로 활용 가능.
- §7 Do's & Don'ts → Guard 룰의 `forbidInlineClasses` 입력으로 직접 매핑.
- §9 Agent Prompts → MCP가 에이전트에게 노출.

### 2.3 ATE 철학과 동일한 패턴

ATE가 테스트 *전략*을 제공하지 *어떤 테스트를 쓸지* 강요하지 않듯이, 디자인 가드도 같은 철학:

- ATE: 테스트 generator + 평가 + 회복 — 무엇을 테스트할지는 사용자
- 디자인 시스템: parser + Guard + MCP — 어떤 클래스를 금지할지는 사용자(또는 awesome-design-md)

---

## 3. 아키텍처 (DESIGN.md 중심)

```
┌─────────────────────────────────────────────────────────────┐
│  사용자 / 에이전트                                              │
│   └─ DESIGN.md (프로젝트 루트, awesome-design-md에서 임포트 가능)  │
└─────────────────────────────────────────────────────────────┘
            │ parse                    │ read
            ▼                          ▼
┌──────────────────────┐  ┌──────────────────────────────────┐
│ Team A — Spec        │  │ Team C — MCP Discovery            │
│  designmd parser     │  │  mandu_design_get (섹션 단위)     │
│  schema / 검증        │  │  mandu_design_check (파일 단위)   │
│  scaffold (init)     │  │  mandu_component_list (인벤토리)   │
│  awesome-design-md   │  │                                  │
│   import 어댑터      │  └──────────────────────────────────┘
└──────────────────────┘                  │
            │                             │ 위반 시
            │ 토큰 / 룰 출력              │
            ▼                             ▼
┌──────────────────────┐  ┌──────────────────────────────────┐
│ Team E — Token Bridge│  │ Team B — Guard Enforcement        │
│ DESIGN.md → Tailwind │  │  forbidInlineClasses (build gate) │
│  @theme 자동 생성    │  │  requireComponent 메시지         │
│ globals.css patch    │  │  AST + regex 매칭                │
└──────────────────────┘  └──────────────────────────────────┘
            │                             │
            └─────────────┬───────────────┘
                          ▼
            ┌──────────────────────────────┐
            │ Team D — Agent Loop / DX     │
            │  CLAUDE.md / AGENTS.md 자동 │
            │   갱신 (DESIGN.md 링크)      │
            │  mandu init --design 통합   │
            │  mandujs.com dogfooding     │
            └──────────────────────────────┘
```

---

### 3.5 DESIGN.md 점진 작성 루프 (가장 중요한 워크플로우)

DESIGN.md는 **처음부터 완성된 산출물이 아니다**. 빈 9-section 골격으로 시작해서 *디자인하면서 조금씩 채워지는* 살아있는 문서. 이 루프 자체를 만두가 메커니즘으로 제공해야 함 — 그게 #245의 진짜 가치.

```
        ┌─────────────────────────────────────────┐
        │  ① 빈 DESIGN.md 골격 (mandu design init) │
        └────────────────────┬────────────────────┘
                             ▼
   ┌──────────────────────────────────────────────────┐
   │  ② 에이전트/사용자가 페이지/컴포넌트 작업 진행      │
   │     - 새 색상/폰트/spacing 등장                   │
   │     - 새 variant 패턴 등장                       │
   │     - 새 회귀 패턴 발견 (Do's & Don'ts 후보)       │
   └────────────────────┬─────────────────────────────┘
                        ▼
  ┌──────────────────────────────────────────────────┐
  │  ③ Mandu가 코드에서 토큰/패턴 추출                  │
  │     mandu design extract       (CLI, 사용자)      │
  │     mandu_design_extract       (MCP, 에이전트)    │
  │     → "이 컬러 #FF8C42가 12곳에 등장. §2에 등록?"  │
  └────────────────────┬─────────────────────────────┘
                       ▼
  ┌──────────────────────────────────────────────────┐
  │  ④ 사용자/에이전트가 패치 검토 후 적용              │
  │     mandu_design_patch ({ section, key, value }) │
  │     → DESIGN.md §2 갱신 (안전하게 섹션 단위 머지)   │
  └────────────────────┬─────────────────────────────┘
                       ▼
  ┌──────────────────────────────────────────────────┐
  │  ⑤ Guard 룰이 자동으로 강화됨                       │
  │     §7 Do's & Don'ts에 추가된 항목 →               │
  │     forbidInlineClasses에 자동 반영                │
  │     (autoFromDesignMd: true일 때)                 │
  └────────────────────┬─────────────────────────────┘
                       │
                       └──→ 다시 ②로 (점진 강화)
```

**핵심**: 에이전트가 작업하면서 DESIGN.md를 *생산자*로서 갱신할 수 있어야 함. 단순 *소비자*만이면 의미 없음. 빈 DESIGN.md → 코드가 늘어남 → 토큰이 굳음 → DESIGN.md가 채워짐 → Guard가 강해짐 → 회귀 차단 → 다음 작업 안전.

**병렬 외부 루프 — awesome-design-md upstream 추적**

```
   로컬 DESIGN.md  ←─( mandu design diff <slug> )─→  awesome-design-md/<slug>/DESIGN.md
                                                       (계속 발전, 새 브랜드 추가, 기존 갱신)
```

awesome-design-md는 계속 갱신됨 (새 브랜드 추가, Stripe 같은 기존 항목 업데이트). 사용자가 자기 DESIGN.md를 특정 슬러그에서 import한 경우, **upstream 갱신 알림 / diff / 부분 머지** 메커니즘이 있어야 외부 표준의 진화에 따라갈 수 있음.

이 두 루프(내부 점진 + 외부 추적)는 **팀 A/C/D 전반에 분산되는 횡단 관심사** — 아래 팀 분담에서 각 팀 Deliverables에 명시적으로 반영.

---

## 4. 에이전트 팀 분담 (5팀)

### 4.1 Team A — Spec & Scaffold (DESIGN.md 일급 지원)

**소유**: DESIGN.md 파싱, 스키마, scaffold, awesome-design-md 통합 + **CLI 인터랙티브 선택 UX**.

**Deliverables**:

1. `@mandujs/core/design` 모듈 신설
   - `parseDesignMd(content: string): DesignSpec` — 9개 섹션을 구조화된 JSON으로
   - `DesignSpec` 타입 (color palette / typography / components / layout / shadows / dos-donts / responsive / agent-prompts)
   - 부분 파싱 허용 — 사용자가 9개 섹션 중 일부만 채워도 동작
2. `@mandujs/core/design/catalog` — awesome-design-md 인덱스 어댑터
   - `fetchCatalog(): Promise<CatalogEntry[]>` — 69개 브랜드 메타(slug, name, tagline, preview-url) 반환
   - 인덱스 소스: `https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/README.md`를 파싱하거나 (JSON 인덱스가 있으면 그걸)
   - `fetchDesignMd(slug: string): Promise<string>` — 특정 슬러그의 raw DESIGN.md
   - 5분 메모리 캐시 + 사용자가 직접 `--no-cache` 가능
3. `mandu design init` 명령 (비-인터랙티브 베이스)
   - 빈 9-section DESIGN.md 템플릿 생성
   - `--from <slug|url>` 플래그: awesome-design-md 슬러그 또는 임의 URL에서 직접 import
   - `src/client/shared/ui/.gitkeep`, `src/client/widgets/.gitkeep` 폴더 생성
   - `CLAUDE.md` / `AGENTS.md` 머지 (Team D와 협의)
4. **`mandu design pick` 명령 (인터랙티브 선택 UX)**
   - 카탈로그를 fetch → terminal-friendly 리스트 + fuzzy filter (`/` 키)
   - 화살표/검색으로 슬러그 선택 → preview (§1 visual theme + §2 컬러 chips ANSI rendering)
   - Enter로 확정 → 내부적으로 `init --from <slug>` 실행
   - `--non-interactive` 플래그: 첫 매치 자동 선택 (CI 호환)
   - 의존: `@inquirer/prompts` 또는 자체 단순 구현 (5팀 모두 같은 picker 컴포넌트 재활용 가능)
5. `mandu design import <slug|url>` — `init` 없이 DESIGN.md만 갱신 (이미 init된 프로젝트용)
6. 기존 DESIGN.md 검증 명령: `mandu design validate`
7. **`mandu design diff [<slug>]` (외부 루프 §3.5)**
   - 인자 생략 시: 마지막 import 출처(메타에 기록) 또는 Git history에서 추정
   - 로컬 DESIGN.md ↔ upstream 슬러그 DESIGN.md 차이를 9-section 단위로 출력
   - 옵션 `--apply <section>` — 특정 섹션만 upstream으로 머지 (사용자가 §2 토큰만 가져오고 §4 컴포넌트는 자기 것 유지하는 시나리오)
   - 마지막 sync 시점/커밋을 `.mandu/design.lock.json`에 기록
8. **`mandu design extract` (내부 루프 §3.5)**
   - 코드베이스(`src/client/**`, `app/**`)를 스캔해서 반복 등장 토큰 후보 추출
     - 색상 리터럴 (`#FF8C42`, `rgb()`, OKLCH) — 출현 빈도 + 위치
     - 폰트 패밀리 / 폰트 사이즈 패턴
     - spacing 그룹 (`px-4 py-2`, `gap-3` 같은 반복 조합)
     - 잠재적 컴포넌트 (3회 이상 동일 className 조합)
   - 후보를 DESIGN.md §2/§3/§5/§4 패치 제안으로 출력 — 사용자가 검토 후 채택
   - `--apply` 플래그로 자동 머지 (Team C `mandu_design_patch`와 같은 머지 엔진 공유)

**의존**: 없음 (다른 팀의 베이스).

**테스트**: 9개 섹션 모두 / 부분 / 잘못된 섹션 / awesome-design-md fixture 5개 이상.

**비범위**: DESIGN.md 내용 정의 (= 사용자/awesome-design-md 책임).

---

### 4.2 Team B — Guard Enforcement (빌드 게이트)

**소유**: 인라인 클래스 위반 검출 + 빌드 차단 + 메시지 포맷.

**Deliverables**:

1. `mandu.config.ts`의 `guard.design` 블록 스키마
   ```ts
   guard: {
     design: {
       designMd?: string;            // 기본 "DESIGN.md"
       forbidInlineClasses?: string[]; // 명시 우선
       autoFromDesignMd?: boolean;   // §7 Do's & Don'ts에서 자동 추출
       requireComponent?: Record<string, string>; // 'btn-hard' → '@/client/shared/ui#MButton'
       exclude?: string[];           // 컴포넌트 정의 자신은 제외
       severity?: 'warning' | 'error'; // dev=warning, build=error 기본
     }
   }
   ```
2. Guard 룰 구현 (`packages/core/src/guard/rules/design-inline-class.ts`)
   - JSX `className`(과 `class`) 안의 클래스 토큰 매칭
   - `clsx()` / `cn()` / `cva()` / 템플릿 리터럴 안의 클래스 처리 (TS AST + 휴리스틱 fallback)
   - Tailwind variant prefix 처리 정책 (`hover:btn-hard`도 잡을지 — 옵션화)
3. 위반 메시지 포맷
   - 파일/라인/컬럼 + 발견된 클래스 + `requireComponent` 안내 + DESIGN.md §7 링크
4. 빌드 통합
   - `mandu build`에서 dev=warning / build=error
   - `mandu guard check`에 노출
   - 기존 6개 프리셋 (`fsd`, `clean`, `hexagonal`, `atomic`, `cqrs`, `mandu`) 위에 추가

**의존**: Team A의 `parseDesignMd` (옵션 — `autoFromDesignMd: true`일 때만).

**테스트**:
- 위반 검출: 단순 `className`, `clsx()`, 템플릿 리터럴, variant prefix
- 옵트인/옵트아웃 전이
- `exclude` 경로
- AST 파싱 실패 graceful fallback

**비범위**: 컴포넌트 자체, 디자인 토큰, 시각 회귀 검증.

---

### 4.3 Team C — MCP Discovery

**소유**: 에이전트가 코드/문서 grep 없이 디자인 시스템을 질의할 수 있는 MCP 도구.

**Deliverables**:

1. `mandu_design_get` — DESIGN.md의 특정 섹션 반환
   ```
   mandu_design_get({ section: 'color-palette' })
   → { tokens: [{ name: 'primary', hex: '#…', role: '…' }, ...] }
   ```
   섹션: `theme | color-palette | typography | components | layout | shadows | dos-donts | responsive | agent-prompts | all`
2. `mandu_design_check` — 한 파일에 대한 Guard 룰 사전 검증 (Team B 룰의 single-file wrapper)
   ```
   mandu_design_check({ file: 'app/[lang]/layout.tsx' })
   → { violations: [{ line, column, class, message, suggestion }] }
   ```
3. `mandu_component_list` — 프로젝트 컴포넌트 인벤토리
   - 폴더 컨벤션(`src/client/shared/ui`, `src/client/widgets`) 스캔
   - JSDoc 첫 줄 = description, props은 TS AST 추출
   - variants는 `cva()` literal 또는 union 타입에서 추출 (heuristic — 실패 시 `null`)
   - `usageCount`는 grep 기반 (alias / re-export는 best-effort)
4. `mandu_design_prompt` — DESIGN.md §9 Agent Prompts를 그대로 노출 (에이전트가 작업 시작 전 프리워밍)
5. **`mandu_design_extract` (내부 루프 §3.5)** — Team A `mandu design extract`의 MCP wrapper
   ```
   mandu_design_extract({ scope?: 'src/client/**' | 'app/**' | 'all', kinds?: ['color' | 'typography' | 'spacing' | 'component'] })
   → { proposals: [
       { section: 'color-palette', key: 'orange-500', value: '#FF8C42',
         occurrences: 12, files: [...], confidence: 0.9 },
       ...
     ] }
   ```
   - 에이전트가 작업 도중 호출 → 새로 생긴 토큰 후보 즉시 발견
6. **`mandu_design_patch` (내부 루프 §3.5)** — DESIGN.md를 섹션 단위로 안전하게 갱신
   ```
   mandu_design_patch({ section: 'color-palette', operation: 'add'|'update'|'remove',
                        key, value, role?, dryRun? })
   → { applied: bool, before, after, conflicts: [...] }
   ```
   - 머지 엔진은 9-section 마크다운 헤더 인식 → 섹션 본문만 교체
   - 사용자가 직접 편집한 free-form 텍스트 보존 (구조화 토큰만 갱신)
   - `dryRun: true` → diff만 반환 (에이전트가 사용자에게 확인받는 패턴)
7. **`mandu_design_diff_upstream` (외부 루프 §3.5)** — Team A `mandu design diff`의 MCP wrapper
   - 에이전트가 "지난주 import한 stripe DESIGN.md가 갱신됐는지" 자율 확인 가능
   - 결과: 섹션별 added/changed/removed 목록 + `mandu_design_patch`로 즉시 적용 가능한 형태
8. **`mandu_design_propose` (점진 루프 통합 인터페이스)**
   - 한 번 호출로 ③+④+⑤ 단계를 묶음: extract → 사용자 승인 패턴(`requireApproval: true`) → patch
   - 에이전트가 "지금까지 작업한 코드에서 DESIGN.md 갱신 후보 정리해서 한 번에 검토" 시 사용

**의존**: Team A (parser, catalog, extract/diff CLI 베이스), Team B (룰).

**테스트**:
- DESIGN.md 부재 시 graceful (`{ note: '...' }`)
- 잘못된 섹션 / 슬러그
- 컴포넌트 인벤토리: cva / 명시적 variant / 미상
- patch dryRun → 실제 머지 결과 일치
- patch가 사용자의 free-form 텍스트 보존 (구조화 토큰만 갱신)
- diff_upstream: 로컬 ↔ upstream 동일 / 부분 변경 / 슬러그 미발견

**비범위**: 컴포넌트 추출 후 *자동 코드 생성* (refactor는 에이전트 책임), 시각 미리보기.

---

### 4.4 Team D — Agent Loop & DX

**소유**: 에이전트의 워크플로우에 DESIGN.md를 자연스럽게 통합.

**Deliverables**:

1. `mandu init` 통합
   - `--design[=<slug>]` 플래그: 새 프로젝트 생성 시 DESIGN.md 동시 스캐폴드
   - 기본은 빈 9-section 템플릿; 슬러그 주면 awesome-design-md에서 import
2. `CLAUDE.md` / `AGENTS.md` 자동 갱신
   - "이 프로젝트는 DESIGN.md를 표준 디자인 시스템 명세로 사용합니다. UI 작업 전 반드시 `mandu_design_get` 또는 `mandu_design_prompt`로 토큰을 확인하세요."
   - 기존 `CLAUDE.md`가 있으면 비파괴 머지(append-if-missing 섹션)
3. `mandu design lint`
   - DESIGN.md 자체의 일관성 검사 (예: §2 색상 16진수 형식, §4 컴포넌트 variant 명명 일관성)
4. mandujs.com dogfooding
   - 우리 사이트에 DESIGN.md 적용 + Guard 룰 활성 + 회귀 측정 → 사례 정리
5. `mandu skills generate`에 design 메타 포함
   - 에이전트 스킬에 "DESIGN.md를 항상 먼저 읽어라" 가이드 자동 삽입
6. **점진 작성 루프 워크플로우 (§3.5 내부 루프)**
   - `CLAUDE.md` / `AGENTS.md`에 표준 루프 섹션 자동 삽입:
     1. UI 작업 시작: `mandu_design_get` 또는 `mandu_design_prompt`로 현재 토큰 확인
     2. 작업 진행 중 새 토큰/패턴 발생 시: `mandu_design_extract`로 후보 추출
     3. 후보 검토 후: `mandu_design_propose` (또는 `mandu_design_patch` 직접) 호출 → 사용자 승인 → DESIGN.md 갱신
     4. 작업 종료 시: `mandu_design_check`로 자기 작업 파일 위반 자가 점검
   - 5스텝짜리 표준 프롬프트를 만두가 제공 — 에이전트는 거의 그대로 따라가면 됨
7. **upstream 추적 자동화 (§3.5 외부 루프)**
   - `mandu doctor` 또는 별도 `mandu design status` 명령에서 마지막 sync 이후 upstream 변화 요약
   - 사용자 옵트인: `mandu.config.ts`의 `design.watchUpstream: true` 설정 시 dev 시작 시점에 비-차단으로 fetch + 콘솔에 한 줄 (`upstream stripe DESIGN.md updated 3 days ago — run \`mandu design diff\``)
   - 차단 동작 절대 안 함 — 네트워크 끊겨도 로컬 작업 영향 0
8. **`mandu skills` × 점진 루프 통합**
   - 에이전트 스킬 정의에 "DESIGN.md를 변경하기 전에 사용자 승인을 받는다" 규칙 자동 포함
   - 자율 모드(헤드리스)에서도 `dryRun: true`로 patch 시뮬만 실행하고 결과를 PR description에 첨부

**의존**: Team A (스캐폴드, extract, diff), Team B (룰), Team C (MCP 8종).

**테스트**:
- 기존 CLAUDE.md / AGENTS.md 비파괴 머지
- `--design=stripe` 플로우 e2e
- mandujs.com 적용 후 기존 회귀 사례가 빌드 fail로 잡히는지

**비범위**: 자체 컴포넌트 라이브러리 / UI primitive 패키지.

---

### 4.5 Team E — Token Bridge (DESIGN.md → Tailwind v4)

**소유**: DESIGN.md의 정량 토큰(§2 색상, §3 타이포, §5 spacing, §6 shadow)을 Tailwind v4 `@theme` 자동 생성.

**Deliverables**:

1. `mandu design sync`
   - DESIGN.md §2,3,5,6 파싱 → `@theme` CSS 블록 생성 → `globals.css` 또는 `app/globals.css`의 `@theme` 영역에 머지
   - 사용자가 직접 편집한 `@theme` 항목은 보존 (마커 주석으로 영역 구분)
2. dev mode watch
   - DESIGN.md 변경 → `@theme` 재생성 → CSS HMR
3. 토큰 충돌 감지
   - DESIGN.md에 `--color-primary: #ff0000`인데 `@theme`이 다른 값이면 경고
4. CSS 변수 명명 규칙
   - `--color-<name>`, `--font-<name>`, `--spacing-<scale>`, `--shadow-<elevation>` (Tailwind v4 컨벤션)
5. 비-Tailwind 어댑터 자리 마련 (vanilla CSS / linaria 등) — 본 phase에서는 안 구현, 인터페이스만 분리

**의존**: Team A (parser).

**테스트**:
- 부분 토큰 / 누락 / 충돌
- 기존 `@theme` 보존
- Tailwind v4 빌드 통과

**비범위**: Tailwind 설치/설정, 다른 CSS 프레임워크 어댑터.

---

## 5. 의존 그래프 / 마일스톤

```
            ┌─ Team A (Spec, scaffold, import) ─┐
            │                                   │
            ▼                                   ▼
       Team B (Guard)                   Team E (Token bridge)
            │
            ▼
       Team C (MCP)
            │
            ▼
       Team D (Agent loop, dogfooding)
```

**M1 — 기반**: A 단독. DESIGN.md parser + scaffold + awesome-design-md import. **산출물 검증**: `mandu design init --from stripe`가 동작하는 빈 프로젝트.

**M2 — 빌드 게이트**: B 추가. 인라인 클래스 위반 빌드 fail. **산출물 검증**: mandujs.com에 적용해서 기존 회귀 케이스 잡힘.

**M3 — 토큰 자동화**: E 추가 (B와 병행 가능). DESIGN.md → `@theme` 자동 sync. **산출물 검증**: stripe DESIGN.md import → `@theme` 자동 생성 → 빌드 통과.

**M4 — MCP 디스커버리**: C 추가. 에이전트가 코드 grep 없이 컴포넌트/토큰 질의. **산출물 검증**: Claude Code에서 `mandu_design_get('color-palette')` 호출 → 실제 토큰 반환.

**M5 — 에이전트 루프**: D 추가. `mandu init --design`, CLAUDE.md/AGENTS.md 자동 갱신, mandujs.com 적용 회고. **산출물 검증**: 새 프로젝트 `mandu init --design=linear` 후 에이전트가 자동으로 DESIGN.md 읽고 작업 시작.

각 마일스톤마다 별도 PR/changeset/릴리즈. M1만 minor bump(`@mandujs/cli` + `@mandujs/core`), M2~M5는 minor에 누적.

---

## 6. 가치/비용 매트릭스 (v2 갱신)

| 팀 | 가치 | 비용 | 비고 |
|---|---|---|---|
| A. Spec | 🔴 큼 (다른 모든 팀의 베이스) | 중간 (parser ~200 + scaffold ~100 + catalog ~150 + pick UI ~150 + extract ~200 + diff ~100 LOC) | DESIGN.md 채택으로 포맷 발명 비용 0; 점진 루프 베이스 추가 |
| B. Guard | 🔴 큼 (유일한 빌드 게이트) | 중간 (~400 LOC, AST 처리 + 룰 통합) | 기존 Guard 인프라 위에 |
| C. MCP | 🔴 큼 (점진 루프의 *핵심* 인터페이스) | 중간~큼 (~600 LOC, 도구 8종) | get/check/list 외에 extract/patch/diff/propose/prompt 추가 |
| D. Agent loop | 🔴 큼 (점진 루프 + upstream 추적 시스템화) | 작음~중간 (~250 LOC + dogfooding) | mandujs.com 적용으로 효과 검증 |
| E. Token bridge | 🟡 중간 (자동화 매력) | 중간 (~250 LOC + Tailwind v4 통합) | 시각 회귀 직접 차단은 못 함 |

v1과 비교:
- **DESIGN.md 채택 → A 비용 절반 감소** (포맷 발명 불요).
- **awesome-design-md 활용 → 사용자 진입 장벽 거의 0** (`mandu design init --from stripe`).
- **Token bridge (E) 신규 추가** — DESIGN.md가 정량 토큰을 보장하므로 자동화 가능.

---

## 7. 핵심 결정 항목

진행 전 확정:

1. **Team A의 awesome-design-md 통합 방식**
   - 옵션 A: HTTP fetch로 `https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/<slug>/DESIGN.md` 직접 가져오기 (오프라인 불가)
   - 옵션 B: `@mandujs/design-presets` 사이드 패키지로 카탈로그 로컬 동봉 (번들 사이즈 ↑)
   - 옵션 C: getdesign.md CLI(`npx getdesign add stripe`)에 위임 (외부 의존)
   - **권장**: A (오프라인은 사용자가 cache 시 동작하니 충분, 카탈로그 sync 부담 0)

2. **Team B의 옵트인 모델**
   - 기본 비활성 (`guard.design` 없으면 no-op) vs 기본 활성 (`DESIGN.md` 존재 시 자동 활성)
   - **권장**: 후자 — DESIGN.md가 있으면 사용자가 의도를 표명한 것

3. **Team C MCP 인벤토리 정확도 vs 범위**
   - cva-only로 변형 추출 vs 모든 패턴 시도 (TypeScript LSP-level)
   - **권장**: cva + 명시적 union 타입 + JSDoc만. 실패 시 `variants: null` 반환 (잘못된 정보보다 없는 정보가 안전)

4. **Team D의 CLAUDE.md/AGENTS.md 머지 정책**
   - 자동 추가 vs 사용자 동의 후 추가 (`mandu design init --update-agents-md`)
   - **권장**: scaffold 시점에는 자동, 기존 프로젝트에 적용할 때는 동의 플래그

5. **Team E의 `@theme` 머지 마커**
   - `/* @mandu-design-sync:start */ ... /* :end */` 같은 명시적 마커 vs 전체 영역 덮어쓰기
   - **권장**: 명시적 마커 — 사용자 편집 보존이 필수

6. **마일스톤 간격**
   - M1~M5를 한 릴리즈에 vs 5번에 나눠
   - **권장**: 5번 — 각 단계 dogfooding으로 다음 단계 결정 보완

7. **점진 루프 — `mandu_design_patch` 자율 실행 정책**
   - 에이전트가 자율 모드에서 DESIGN.md를 *직접* 갱신할 수 있게 할지, 항상 사용자 승인을 강제할지
   - **권장**: 기본 `requireApproval: true`. `dryRun: true` 호출은 자유, 실제 머지는 사용자 OK 또는 명시적 옵트아웃(`design.autonomousPatch: true` 설정) 필요. DESIGN.md 부패는 회귀보다 회복 비용이 큼

8. **upstream 추적 — 빈도와 차단 여부**
   - 동기 fetch (dev start blocking) vs 백그라운드 비-차단 vs 명시 명령(`mandu design status`)만
   - **권장**: 명시 명령 + dev start 시 비-차단 한 줄 알림. 자동 fetch는 절대 차단 안 함

9. **`mandu design extract`의 false-positive 비용**
   - 색상/spacing 후보를 너무 적극적으로 제안하면 노이즈, 너무 보수적이면 가치 없음
   - **권장**: 기본 `minOccurrences: 3`(3회 이상 반복 등장한 토큰만), `--aggressive` 플래그로 1회도 후보화. 신뢰도(`confidence`) 점수 함께 출력해서 에이전트가 필터링 가능

---

## 8. Out of Scope (이 이슈에서 안 다룸)

- 시각 검증 도구 (Storybook / screenshot 회귀) — 별도 이슈
- 디자인 토큰 표준 (Tailwind v4 외) — Team E의 어댑터 인터페이스만 분리, 구현은 별도
- 다국어 라벨 길이 검증 — 별도 이슈
- shadcn / Radix UI 직접 통합 — UI 프리미티브 패키지가 되면 본연 영역 벗어남
- `mandu design publish` (자체 DESIGN.md를 awesome-design-md에 PR) — 외부 커뮤니티 작업

---

## 9. 참고 자료

- **DESIGN.md 컨벤션 — Google Stitch**: 9-section 마크다운 디자인 시스템 표준
- **awesome-design-md (VoltAgent, MIT)**: 69개 브랜드의 DESIGN.md 카탈로그 — `npx getdesign@latest add <slug>` 또는 raw GitHub fetch
- **getdesign.md CLI**: 외부 배포 도구, 우리 통합과 충돌하지 않음
- **mandujs.com 사례** (issue #245 첨부): 컴포넌트 추출 + 자체 CLAUDE.md — 이 기획이 generalize 하려는 손작업
- **Mandu Guard 인프라** (`packages/core/src/guard/`): FSD/Clean/Hexagonal/Atomic/CQRS/Mandu 6개 프리셋 + `Record<GuardPreset, ...>` 패턴 — 디자인 룰을 동일 인프라에
- **ATE 철학** (`packages/ate/`): "전략 제공, 내용은 사용자" — 디자인 가드의 본보기
