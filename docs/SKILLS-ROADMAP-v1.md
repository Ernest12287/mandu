# Mandu Skills & Plugin Roadmap v1.0

> 3명 전문가 (워크플로우, 지식/참조, 플러그인 패키징) 분석 기반
>
> 날짜: 2026-04-12

---

## 개요

Mandu의 AI 인터페이스 현황:
- **MCP 도구 76개** → AI가 "할 수 있는 것" (기계적 기능)
- **Skills 0개** → AI가 "어떻게 하는지" (인지적 가이드) ← **이 문서에서 해결**

---

## 구현할 Skills (9개)

### 워크플로우 스킬 (3개)

| # | 스킬 | 호출 | 핵심 시나리오 |
|---|------|------|-------------|
| 1 | `mandu-create-feature` | 자동 + `/mandu-create-feature` | 페이지/API/Island 전체 스캐폴딩 (로그인, 대시보드, 블로그, 채팅 등) |
| 2 | `mandu-create-api` | 자동 + `/mandu-create-api` | REST API + Contract + 테스트 (CRUD, 파일업로드, 인증, 프록시) |
| 3 | `mandu-debug` | 자동 | 8가지 에러 카테고리 진단→분석→수정 파이프라인 |

### 지식/참조 스킬 (3개)

| # | 스킬 | 호출 | 핵심 내용 |
|---|------|------|----------|
| 4 | `mandu-explain` | 자동 | 18개 프레임워크 개념 설명 (레벨별 적응: 초보→중급→고급) |
| 5 | `mandu-guard-guide` | 자동 | 6개 아키텍처 프리셋 + 위반 수정 가이드 |
| 6 | `mandu-deploy` | **수동만** | 배포 파이프라인 + Docker + CI/CD + nginx/Caddy |

### 프레임워크 스킬 (플러그인 내장, 3개)

| # | 스킬 | 핵심 내용 |
|---|------|----------|
| 7 | `mandu-slot` | Filling API, ctx 메서드, lifecycle hooks |
| 8 | `mandu-fs-routes` | 파일 라우팅 규칙, layout (html/head/body 금지) |
| 9 | `mandu-hydration` | island() API, @mandujs/core/client import 규칙 |

---

## 각 스킬 상세

### 1. mandu-create-feature

**5단계 워크플로우**:
1. 요구사항 수집 → `mandu_analyze_structure` + `mandu_get_decisions`
2. 아키텍처 협상 → `mandu_negotiate` + 사용자 승인
3. 파일 생성 → `mandu_generate_scaffold` + `mandu_add_route` + `mandu_create_contract`
4. 구현 → slot/island 작성 + `mandu_validate_slot`
5. 검증 → `mandu_guard_heal` + `mandu_validate_manifest`

**시나리오 분기**:
- 로그인 페이지 → page + form + session + auth middleware
- 검색 필터 추가 → 기존 페이지 수정 + 새 island
- 관리자 대시보드 → layout + nested routes + auth guard
- 블로그 → content collection + 동적 라우트 + SSG
- 실시간 채팅 → WebSocket + island + SSE fallback

### 2. mandu-create-api

**6단계 워크플로우**:
1. 사전 점검 → `mandu_list_routes` + `mandu_list_contracts`
2. 라우트 생성 → `mandu_add_route` (단일/CRUD)
3. Contract 정의 → Zod 스키마 + normalize 모드 선택
4. Slot 구현 → 비즈니스 로직 + `mandu_validate_slot`
5. 코드 생성 → `mandu_generate` + `mandu_sync_contract_slot`
6. 검증 → Guard + Contract + OpenAPI + ATE 테스트

**시나리오 분기**:
- 파일 업로드 → multipart + passthrough normalize
- 인증 API → JWT + session + strict normalize
- SSE 프록시 → streaming response
- 복잡 쿼리 → nested Zod 스키마

### 3. mandu-debug

**8가지 에러 카테고리**:
| 카테고리 | 증상 | 주요 도구 |
|---------|------|----------|
| build-error | 빌드 실패, TypeScript 에러 | doctor, guard_check |
| ssr-blank | 하얀 화면, SSR 실패 | kitchen_errors, read_slot |
| island-dead | Island 클릭 안 됨 | list_islands, build_status |
| api-error | 504, 500, timeout | validate_contracts, read_slot |
| css-broken | CSS 미적용 | build_status, runtime_config |
| hmr-broken | HMR 미작동 | watch_status |
| guard-violation | 아키텍처 위반 | guard_heal, guard_explain |
| contract-mismatch | 스키마 불일치 | validate_contracts, sync_contract_slot |

**진단 플로우**: 7개 소스 병렬 수집 → 카테고리별 분기 → 자동 수정 → 검증 → 포스트모템

### 4. mandu-explain

18개 개념 커버:
Island, Filling, Guard, Contract, Slot, SSR, Streaming SSR, ISR/SWR, Middleware, WebSocket, Content Collections, useHead, useMandu, useFetch, Form/Action, Adapter, View Transitions, SSE

레벨 적응:
- 초보: 비유 + 기본 코드 + 다른 프레임워크 비교
- 중급: 흐름도 + 설정 + 트레이드오프
- 고급: 내부 동작 + 소스 레벨 + 에지 케이스

### 5. mandu-guard-guide

6개 프리셋 상세:
- **fsd**: 프론트엔드 SPA (app→pages→widgets→features→entities→shared)
- **clean**: 백엔드 API (api→infra→application→domain→core→shared)
- **hexagonal**: 포트/어댑터 (adapters→application→ports→domain)
- **atomic**: 디자인 시스템 (pages→templates→organisms→molecules→atoms)
- **cqrs**: 이벤트 드리븐 (commands/queries 격리)
- **mandu**: 풀스택 (FSD 클라이언트 + Clean 서버 + shared 브릿지)

프리셋 선택 가이드:
| 프리셋 | 팀 규모 | 프로젝트 복잡도 |
|--------|--------|--------------|
| mandu | 아무나 | 중간 (권장) |
| fsd | 2-5명 | 중간 |
| clean | 3-8명 | 중간 |
| hexagonal | 5-15명 | 높음 |
| atomic | 1-5명 | 낮음 |
| cqrs | 5-20명 | 높음 |

### 6. mandu-deploy (수동만)

배포 파이프라인:
```
guard-check → contract-validate → bun test → mandu build → mandu start
```

포함 내용:
- 환경변수 설정 (.env.production)
- Adapter 구성
- Multi-stage Dockerfile
- Docker Compose
- GitHub Actions CI/CD (SSH + Docker 방식)
- nginx / Caddy 리버스 프록시
- PM2 프로세스 관리
- 프로덕션 보안 체크리스트

---

## Plugin 패키징

### 패키지 구조
```
packages/skills/
├── .claude-plugin/
│   └── plugin.json              ← 마켓플레이스 메타데이터
├── skills/
│   ├── mandu-create-feature/
│   │   └── SKILL.md
│   ├── mandu-create-api/
│   │   └── SKILL.md
│   ├── mandu-debug/
│   │   └── SKILL.md
│   ├── mandu-explain/
│   │   └── SKILL.md
│   ├── mandu-guard-guide/
│   │   └── SKILL.md
│   ├── mandu-deploy/
│   │   └── SKILL.md
│   ├── mandu-slot.md            ← 프레임워크 스킬
│   ├── mandu-fs-routes.md
│   └── mandu-hydration.md
├── templates/
│   ├── .mcp.json                ← MCP 서버 설정
│   └── .claude/
│       └── settings.json        ← 권한 + 훅
├── src/
│   ├── index.ts                 ← installSkills() API
│   ├── cli.ts                   ← bunx mandu-skills install
│   └── init-integration.ts      ← mandu init 통합
├── package.json                 ← @mandujs/skills
└── README.md
```

### 배포 전략
1. **npm**: `@mandujs/skills` 패키지
2. **mandu init**: 자동 설치 (`.claude/skills/`에 복사)
3. **standalone**: `bunx mandu-skills install`
4. **마켓플레이스**: Anthropic 공식 등록 (향후)

### Hooks 템플릿
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Edit|Write",
      "command": "bunx mandu guard check-file $FILE"
    }],
    "PostToolUse": [{
      "matcher": "Edit|Write",
      "pattern": "spec/contracts/",
      "command": "echo '💡 Contract 수정됨 — mandu contract validate 실행 권장'"
    }]
  }
}
```

### mandu init 통합
```typescript
// init.ts에 추가
import { setupClaudeSkills } from "@mandujs/skills/init-integration";

// 프로젝트 생성 후:
await setupClaudeSkills(targetDir);
// → .claude/skills/ 에 9개 스킬 복사
// → .mcp.json 생성
// → .claude/settings.json 생성 (권한 + 훅)
```

---

## 우선순위

```
임팩트 ↑
극대  │  create-feature(1)     debug(3)
      │  create-api(2)
      │
 대   │  explain(4)            guard-guide(5)
      │  plugin packaging
      │
 높   │  deploy(6)             slot/routes/hydration(7-9)
      │  init 통합
      │
 중   │  hooks 템플릿           마켓플레이스 등록
      │
      └────────────────────────────────────→ 난이도
           하                  중          상
```
