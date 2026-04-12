# Mandu 공식 사이트 기획서 (mandujs.dev)

> 3명 전문가 (디자인, 콘텐츠, 기술) 분석 종합
>
> 날짜: 2026-04-12

---

## 기술 결정: 하이브리드 (Mandu 랜딩 + Starlight 문서)

| 영역 | 도구 | 이유 |
|------|------|------|
| **랜딩 페이지** | Mandu (dogfooding) | "우리 프레임워크로 만들었다" — 개발자 신뢰도 |
| **문서** | Astro Starlight | 검색, 사이드바, i18n, MDX 내장 — 문서 품질 타협 불가 |
| **호스팅** | Cloudflare Pages | 무료, 글로벌 CDN, 빠른 빌드 |
| **도메인** | mandujs.dev | / = 랜딩, /docs = 문서 |
| **검색** | Pagefind (내장) | 로컬, 무료, 빠름 |
| **i18n** | ko + en | Starlight 내장 |

---

## 저장소 구조

```
workspace/mandujs.dev/
├── landing/                    # Mandu 앱 (dogfooding)
│   ├── app/
│   │   ├── page.tsx            # 히어로 + 피처
│   │   ├── layout.tsx
│   │   └── globals.css
│   ├── src/
│   │   └── components/         # 랜딩 컴포넌트
│   ├── public/
│   │   └── images/
│   └── mandu.config.ts
├── docs/                       # Starlight
│   ├── src/content/
│   │   ├── docs/ko/            # 한국어 문서
│   │   └── docs/en/            # 영어 문서
│   ├── astro.config.mjs
│   └── package.json
├── .github/
│   └── workflows/deploy.yml
└── package.json
```

---

## 랜딩 페이지 설계

### 디자인 시스템

- **배경**: 아이보리 #F5F0E8 (따뜻한 만두색)
- **텍스트**: 딥 브라운 #2D1B0E
- **강조**: 코랄 #FF6B4A
- **폰트**: Inter (본문) + JetBrains Mono (코드)
- **다크모드**: 지원

### 섹션 구성 (위→아래)

#### 1. Hero

> **Bun 위에서 만두를 빚다.**
>
> Contract-first API, Islands Architecture, 그리고 AI-native MCP 통합.
> 풀스택 TypeScript 프레임워크의 새로운 기준.

```bash
bun create mandu my-app
```

CTA: `시작하기` | `GitHub`

#### 2. Feature Cards (6개)

| 카드 | 제목 | 핵심 |
|------|------|------|
| 1 | Islands Architecture | 5가지 hydration 전략, Zero-JS 기본 |
| 2 | Filling API | 8단계 lifecycle, 체이닝 핸들러 |
| 3 | Guard System | 6개 프리셋, 실시간 import 감시 |
| 4 | Contract API | Zod 스키마 → 타입추론 + 검증 + OpenAPI |
| 5 | AI-Native MCP | 85개 도구, AI 에이전트 직접 조작 |
| 6 | Zero-JS + ISR/SWR | 0바이트 기본, 캐시 + 백그라운드 재생성 |

#### 3. Code Showcase

Contract + Filling + Action을 보여주는 ~20줄 코드:

```typescript
// Contract 정의
export default Mandu.contract({
  request: {
    POST: { body: z.object({ title: z.string().min(1) }) },
  },
  response: {
    201: z.object({ todo: TodoSchema }),
  },
});

// Route Handler
export default Mandu.filling()
  .loader(async () => ({ todos: await db.list() }), { revalidate: 30 })
  .action("create", async (ctx) => {
    const { title } = await ctx.body();
    return ctx.created({ todo: await db.create(title) });
  });
```

#### 4. Comparison Table

| 기능 | **Mandu** | Next.js | Astro | Remix |
|------|-----------|---------|-------|-------|
| Runtime | **Bun** | Node | Node | Node |
| 기본 JS | **0 바이트** | ~85KB | 0 바이트 | ~60KB |
| Islands | **5 전략** | — | 3 전략 | — |
| Contract API | **Zod 내장** | — | — | — |
| Guard | **6 프리셋** | — | — | — |
| MCP | **85 도구** | — | — | — |
| ISR/SWR | **내장** | 내장 | — | 수동 |
| WebSocket | **체이닝** | 별도 | 별도 | 별도 |

#### 5. Quick Start

> 3줄이면 충분합니다

```bash
bun create mandu my-app
cd my-app
bun run dev
```

> `localhost:3333`에서 만두가 익고 있습니다.

#### 6. Social Proof

- GitHub stars 배지
- npm 주간 다운로드
- Built with Mandu: todo-app, ai-chat

#### 7. Footer

Docs | GitHub | npm | Discord | Twitter
Made with 🥟 by LamySolution | MPL-2.0

---

## 문서 구조 (/docs)

### Getting Started
- 5분 퀵스타트 (bun create → dev → build → deploy)

### Core Concepts
- Island Architecture (5 hydration 전략)
- Filling API (8단계 lifecycle)
- Guard System (6 프리셋)
- Contract API (Zod + OpenAPI)
- Slot (서버 데이터 로더)

### Guides
- 인증 (JWT + Session)
- CRUD API (Contract + Slot)
- 실시간 (SSE + WebSocket)
- 배포 (Docker + CI/CD)

### API Reference
- Core API (자동 생성)
- CLI Reference (38 commands)
- MCP Reference (85 tools)
- Skills Reference (9 skills)

---

## CI/CD

```yaml
# .github/workflows/deploy.yml
on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2

      # Landing (Mandu)
      - run: cd landing && bun install && bun run mandu build

      # Docs (Starlight)
      - run: cd docs && bun install && bun run build

      # Merge outputs
      - run: |
          mkdir -p dist
          cp -r landing/.mandu/static/* dist/
          cp -r docs/dist/* dist/docs/

      # Deploy to Cloudflare Pages
      - uses: cloudflare/pages-action@v1
        with:
          directory: dist
```

---

## 마일스톤

| 주차 | 목표 |
|------|------|
| 1주 | 랜딩 페이지 MVP (Hero + Features + Comparison) |
| 2주 | Starlight 문서 셋업 + Getting Started + Core Concepts |
| 3주 | Guides (Auth, CRUD, Deploy) + API Reference 자동생성 |
| 4주 | i18n (en) + 검색 + 다크모드 + 최종 디자인 |
| 5주 | Cloudflare Pages 배포 + 도메인 연결 + 공개 |
