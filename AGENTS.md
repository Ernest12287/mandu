# Mandu Project Guide

## Overview

Mandu는 **Bun** 기반의 모던 풀스택 프레임워크입니다.

## Package Manager

- **Bun** 사용 (`bun install`, `bun run`, `bun test`)
- pnpm/npm 아님

## Project Structure

```
packages/
├── core/       # @mandujs/core - 핵심 프레임워크
├── cli/        # @mandujs/cli - CLI 도구
└── mcp/        # @mandujs/mcp - MCP 서버
demo/           # 데모 앱들
```

## Agent-Native Workflow

Mandu는 Agent-Native Fullstack Framework다. 에이전트는 파일을 바로 고치기 전에 설치된 Mandu MCP와 Mandu skills를 먼저 고려해야 한다.

작업 전:

1. 작업 도메인을 분류한다: route, API, contract, slot, island, guard, debug, deploy, release, docs.
2. 관련 Mandu skill이 있으면 사용한다.
3. 관련 Mandu MCP tool이 있으면 source 직접 편집보다 우선한다.
4. MCP/skill이 없거나 접근 불가하면 그 사실을 말하고 CLI/source fallback을 쓴다.

도구 선택 기준:

| 작업 | 우선 경로 |
|------|----------|
| route/page/API 생성 | MCP route/scaffold tools 또는 `mandu-fs-routes`, `mandu-create-api` skill |
| contract 변경 | contract MCP tools, contract validation |
| slot/filling 변경 | `mandu-slot` skill, slot MCP tools |
| architecture/import 문제 | Guard MCP tools, `mandu-guard-guide` skill |
| island/hydration 문제 | `mandu-hydration` skill, hydration/build checks |
| 오류 조사 | `mandu-debug` skill, `mandu_doctor`/targeted tests |
| 배포/릴리즈 | release checklist, changeset, `check:publish` |

상세 프로토콜: `docs/guides/07_agent_workflow.md`

## License

- **MPL-2.0** (Mozilla Public License 2.0) 전체 적용
- 수정한 파일은 공개 필수, import해서 만든 앱은 자유

## 배포 (Release)

이 프로젝트는 **Changesets**를 사용합니다.

### 변경사항 기록

```bash
bun changeset
# → 변경된 패키지 선택
# → major/minor/patch 선택
# → 변경 내용 설명
```

### 버전 업데이트 & 배포

```bash
bun run version   # 버전 업데이트 + CHANGELOG 생성
bun run publish   # npm 배포
# 또는
bun run release   # 위 두 명령을 한번에
```

### 주의사항

- `workspace:*` 의존성은 `bun run version` 시 실제 버전으로 자동 변환됨
- demo/* 패키지는 배포 대상에서 제외됨 (.changeset/config.json)

## Git

- 커밋 메시지에 Co-Authored-By 라인을 포함하지 마라.

## Scripts

| 명령어 | 설명 |
|--------|------|
| `bun test` | 테스트 실행 |
| `bun run mandu` | CLI 실행 |
| `bun changeset` | 변경사항 기록 |
| `bun run version` | 버전 업데이트 |
| `bun run publish` | npm 배포 |
| `bun run release` | version + publish |
