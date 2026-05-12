# AI Agent Instructions for Mandu Project

이 프로젝트는 **Mandu Framework**로 구축되었습니다. AI 에이전트가 이 프로젝트를 다룰 때 아래 지침을 따라주세요.

## 패키지 매니저: Bun (필수)

**⚠️ 중요: 이 프로젝트는 Bun만 사용합니다. npm/yarn/pnpm을 사용하지 마세요.**

```bash
# ✅ 올바른 명령어
bun install              # 의존성 설치
bun add <package>        # 패키지 추가
bun remove <package>     # 패키지 제거
bun run dev              # 개발 서버 시작
bun run build            # 프로덕션 빌드
bun test                 # 테스트 실행

# ❌ 사용 금지
npm install / yarn install / pnpm install
```

## Agent-Native 작업 프로토콜

파일을 바로 수정하기 전에 Mandu MCP와 설치된 Mandu skills를 먼저 확인하세요.

1. 작업 도메인을 분류하세요: route, API, contract, slot, island, guard, debug, deploy, release, docs.
2. 해당 Mandu skill이 있으면 먼저 사용하세요.
3. route/contract/slot/guard/hydration/build/diagnosis 작업은 MCP tool이 있으면 우선 사용하세요.
4. MCP나 skill을 사용할 수 없으면 이유를 기록하고 CLI/source fallback을 사용하세요.

도구 선택 기준:

| 작업 | 우선 경로 |
|------|----------|
| route/page/API 생성 | MCP route/scaffold tools 또는 `mandu-fs-routes`, `mandu-create-api` skill |
| contract 변경 | contract MCP tools, contract validation |
| slot/filling 변경 | `mandu-slot` skill, slot MCP tools |
| architecture/import 문제 | Guard MCP tools, `mandu-guard-guide` skill |
| island/hydration 문제 | `mandu-hydration` skill, hydration/build checks |
| 오류 조사 | `mandu-debug` skill, `mandu_doctor`/targeted tests |

작업 완료 보고에는 선택한 skill, 사용한 MCP tool, fallback, 변경 파일, 검증 명령을 포함하세요.

## 프로젝트 구조

```
├── app/                  # FS 기반 라우팅 (페이지, API)
│   ├── page.tsx         # / 라우트
│   ├── layout.tsx       # 루트 레이아웃
│   ├── globals.css      # Tailwind CSS (v4)
│   └── api/             # API 라우트
├── src/
│   ├── client/          # 클라이언트 코드 (FSD 구조)
│   │   ├── shared/      # 공용 UI, 유틸리티
│   │   ├── entities/    # 엔티티 컴포넌트
│   │   ├── features/    # 기능 컴포넌트
│   │   └── widgets/     # 위젯/Island 컴포넌트
│   ├── server/          # 서버 코드 (Clean Architecture)
│   │   ├── domain/      # 도메인 모델
│   │   ├── application/ # 비즈니스 로직
│   │   └── infra/       # 인프라/DB
│   └── shared/          # 클라이언트-서버 공유 코드
│       ├── contracts/   # API 계약 타입
│       └── types/       # 공용 타입
└── mandu.config.ts      # Mandu 설정 (선택)
```

## 주요 규칙

### 1. Island 컴포넌트
클라이언트 상호작용이 필요한 컴포넌트는 `*.island.tsx`로 명명:
```tsx
// src/client/widgets/counter/Counter.island.tsx
"use client";
export function CounterIsland() { ... }
```

### 2. API 라우트
`app/api/` 폴더에 `route.ts` 파일로 정의:
```typescript
// app/api/users/route.ts
import { Mandu } from "@mandujs/core";
export default Mandu.filling()
  .get((ctx) => ctx.ok({ users: [] }))
  .post(async (ctx) => { ... });
```

### 3. Tailwind CSS v4
CSS-first 설정 사용 (`tailwind.config.ts` 없음):
```css
/* app/globals.css */
@import "tailwindcss";
@theme {
  --color-primary: hsl(222.2 47.4% 11.2%);
}
```

### 4. Import Alias
`@/` = `src/` 경로:
```typescript
import { Button } from "@/client/shared/ui/button";
```

## 실행 방법

```bash
bun install     # 최초 설치
bun run dev     # 개발 서버 (http://localhost:3333)
bun run build   # 프로덕션 빌드
bun run guard   # 아키텍처 검증
```

## AI 에이전트 MCP 설정

이 프로젝트는 `@mandujs/mcp` MCP 서버를 통해 AI 에이전트와 통합됩니다.
`mandu init` 시 자동으로 설정 파일이 생성됩니다:

| 에이전트 | 설정 파일 | 비고 |
|----------|-----------|------|
| Claude Code | `.mcp.json` | 자동 연결 |
| Claude Desktop | `.claude.json` | 로컬 범위 |
| Gemini CLI | `.gemini/settings.json` | 자동 연결 |

MCP 서버가 제공하는 도구: `mandu_negotiate`, `mandu_generate_scaffold`, `mandu_guard` 등

## 기술 스택

- **Runtime**: Bun 1.x
- **Framework**: Mandu (React 19 + Bun native)
- **Styling**: Tailwind CSS v4
- **Language**: TypeScript 5.x
