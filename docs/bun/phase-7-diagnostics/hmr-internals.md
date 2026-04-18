# Mandu HMR/Dev-Watch 구현 상세 분석

**작성 목적**: Phase 7 착수 전 구현 격차 파악 및 에이전트 팀 기획 자료

---

## 1. 전체 구조 맵

### 1.1 레이어 스택

```
┌─────────────────────────────────────────────────────┐
│ CLI 진입점                                           │
│ packages/cli/src/commands/dev.ts:63 (dev 함수)     │
└────────────────┬────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────┐
│ 개발 서버 + 파일 감시 조직                          │
│ packages/core/src/bundler/dev.ts:106                │
│ • startDevBundler()                                 │
│ • createHMRServer()                                 │
│ • CSS 와처 (startCSSWatch)                          │
└────────────────┬────────────────────────────────────┘
                 │
         ┌───────┴───────┐
         ▼               ▼
    ┌─────────┐     ┌──────────┐
    │ 번들러  │     │ HMR      │
    │rebuild │     │ 서버     │
    └────┬────┘     └────┬─────┘
         │              │
    dev.ts:260          dev.ts:482
    _doBuild()          Bun.serve()
    build.ts:1456       WebSocket
    buildClientBundles()│
         │              │
         └──────┬───────┘
                ▼
        ┌────────────────┐
        │ 브라우저       │
        │ HMR 클라이언트 │
        │(dev.ts:609)    │
        └────────────────┘
```

### 1.2 핵심 파일 역할

| 파일 | 줄 | 역할 |
|------|-----|------|
| dev.ts | 1–811 | HMR/Watch 핵심 엔진 (파일감시, 번들 rebuild, SSR invalidation, HMR 메시지) |
| build.ts | 1456–1842 | buildClientBundles() — Island 번들링 (targetRouteIds, skipFrameworkBundles 옵션) |
| cli/commands/dev.ts | 63–597 | CLI 진입, SSR 핸들러 등록 (bundledImporter #184), 라우트 감시, Guard watcher |
| css.ts | 78–311 | Tailwind v4 CSS watch (단발 빌드 반복, #152 Bun.spawn hang 해결) |
| safe-build.ts | 62–72 | Bun.build 동시성 제한 (기본 2개, #121 경함) |
| cli/util/bun.ts | 139–260 | createBundledImporter() — transitive ESM 캐시 회피 (#184/#187) |

---

## 2. 변경 분기 매트릭스

파일 타입별로 dev.ts의 _doBuild() 경로 분기:

| 파일 종류 | 감지 경로 | rebuild 경로 | SSR invalidate | 클라이언트 메시지 | 결과 |
|--------|---------|-----------|--------------|--------------|------|
| app/**/*.page.tsx | clientModuleToRoute.get() | buildClientBundles({targetRouteIds}) | ❌ | island-update | 단일 island 재빌드 |
| app/**/*.island.tsx | clientModuleToRoute.get() | buildClientBundles({targetRouteIds}) | ❌ | island-update | 단일 island 재빌드 |
| app/**/*.client.tsx | clientModuleToRoute (line:148) | buildClientBundles({targetRouteIds}) | ❌ | island-update | 단일 island 재빌드 |
| app/**/*.layout.tsx | serverModuleSet.has() | onSSRChange(filePath) | ✅ | reload | 전체 SSR 재등록 |
| app/**/*.page.tsx (SSR) | serverModuleSet.has() | onSSRChange(filePath) | ✅ | reload | 전체 SSR 재등록 |
| spec/contracts/*.contract.ts | ❌ 감지 안됨 | ❌ | ❌ | ❌ | 수동 개입 필요 |
| spec/resources/*.resource.ts | ❌ 감시 안됨 | ❌ | ❌ | ❌ | 수동 개입 필요 |
| src/shared/**/*.ts (SSR 의존) | isInCommonDir() | buildClientBundles({skipFrameworkBundles:true}) | ✅ wildcard(*) | reload | 모든 island 재빌드 |
| src/components/**/*.ts | isInCommonDir() | buildClientBundles({skipFrameworkBundles:true}) | ✅ wildcard(*) | reload | 모든 island 재빌드 |
| *.css (입력 파일) | CSS watcher | startCSSWatch→runCSSBuild() | ❌ | css-update | CSS 재빌드, 캐시버스트 |
| *.config.ts (mandu.config) | ❌ 감지 안됨 | ❌ | ❌ | ❌ | 서버 재시작 필요 |
| .env* | ❌ 감지 안됨 | ❌ | ❌ | ❌ | 서버 재시작 필요 |
| package.json | ❌ 감지 안됨 | ❌ | ❌ | ❌ | 서버 재시작 필요 |
| middleware/*.ts | [미확인] | [미확인] | [미확인] | [미확인] | 라우트 재스캔 필요 |

**범례**: ✅=실행됨, ❌=미실행, [미확인]=확인필요

**주요 발견**:

1. **API 라우트 변경** (route.ts): apiModuleSet 등록 (line:174), onAPIChange 호출 (line:343–345), 별도 핸들러 (cli/dev.ts:365–388)

2. **공통 디렉토리** (src/shared): isInCommonDir() (line:220), skipFrameworkBundles:true + SSR_CHANGE_WILDCARD (line:287) 조합
   - **제약**: Bun의 transitive ESM 캐시는 프로세스 레벨 (line:282 주석)

3. **윈도우 경로 정규화**: normalizeFsPath() (line:78–81)
   - resolve → 포워드슬래시 → lowercase (win32)
   - #180 해결: 동적 라우트 ([lang]) 변경 감지 누락 수정

---

## 3. HMR 프로토콜 소프트웨어 레이어

### 3.1 HMRMessage 타입 (dev.ts:453–477)

```typescript
export interface HMRMessage {
  type:
    | "connected"        // WS 연결 성공
    | "reload"           // 전체 페이지 리로드
    | "island-update"    // 특정 island 번들 업데이트
    | "layout-update"    // [미구현] 레이아웃 변경
    | "css-update"       // CSS 파일 업데이트
    | "error"            // 빌드/SSR 에러
    | "ping"             // keep-alive
    | "guard-violation"  // Architecture Guard 위반
    | "kitchen:file-change"     // Kitchen DevTools 파일 변경 신호
    | "kitchen:guard-decision";  // Kitchen DevTools Guard 결정
}
```

**주목**: layout-update 타입은 정의만 되고 서버 송신 코드 없음 (클라이언트 핸들러만 line:687)

### 3.2 HMRServer 구현 (dev.ts:482–603)

**포트 계산**: 서버 3333 → HMR ws://localhost:3334 (port + 1)

**클라이언트 라이프사이클**:
- open(ws): "connected" 메시지 송신
- message(ws, msg): 클라이언트 ping 응답
- close(ws): 클라이언트 제거
- broadcast(msg): 모든 연결된 클라이언트에 JSON 전송

**ping/pong**: 클라이언트 30초마다 ping (line:806), 서버 pong 응답 (line:563)

### 3.3 HMR 클라이언트 스크립트 (dev.ts:609–811)

**재연결 로직**: exponential backoff (최대 30초, 10회 시도)

**메시지 핸들러**:
- reload: location.reload()
- island-update: staleIslands에 추가, 현재 페이지에 있으면 reload
- css-update: <link> href에 ?t=Date.now() 추가 (캐시버스트)
- error: 검은 배경 오버레이 + 에러 메시지 (showErrorOverlay)

**Stale Island 감지** (line:787–801): 네비게이션 후 popstate/pageshow 시 감지

---

## 4. SSR 모듈 캐시 Invalidation

### 4.1 onSSRChange 콜백 (cli/dev.ts:322–363)

```typescript
let ssrChangeQueue: Promise<void> = Promise.resolve();
const handleSSRChange = (filePath: string): Promise<void> => {
  ssrChangeQueue = ssrChangeQueue.then(async () => {
    const isWildcard = filePath === SSR_CHANGE_WILDCARD;
    
    clearDefaultRegistry();      // SSR 핸들러 레지스트리 clear
    registeredLayouts.clear();   // 레이아웃 캐시 clear
    await registerHandlers(manifest, true);  // 재등록
    
    hmrServer?.broadcast({ type: "reload", ... });
  });
  return ssrChangeQueue;
};
```

**동시성 제어** (#186): Promise 체인 뮤텍스 → interleave 방지

### 4.2 SSR_CHANGE_WILDCARD (dev.ts:18)

**의미**: 공통 디렉토리 (src/shared) 변경 → 전체 SSR 모듈 invalidate

**제약**: Bun의 transitive ESM 캐시는 프로세스 레벨 (dev.ts:282–284 주석)
- 근본 해결: subprocess/worker 기반 SSR eval (follow-up)

### 4.3 bundledImporter (#184/#187, cli/util/bun.ts:139–260)

**문제**: ?t=NOW 로도 transitive 의존성 미적용

**해결**: Bun.build로 번들링 → 고유 경로 → 새 모듈로 인식

**external 처리** (line:84–113):
- npm 의존성: external (react, @mandujs/core 등)
- user code: bundle에 inline

**GC** (line:147–152): 각 소스별 이전 번들 파일 삭제

---

## 5. 테스트 커버리지 Inventory

**발견**:
- build.test.ts: 번들 빌드 기능
- safe-build.test.ts: 동시성 제한
- **HMR E2E 테스트 미발견** (dev 모드 통합)

**Test Gate**: MANDU_SKIP_BUNDLER_TESTS=1
- 이유: Bun.build 성능 (CI 시간 단축)

---

## 6. 구조적 한계 + 버그 가능성

### 6.1 pendingBuildFile 단일 저장 (dev.ts:217)

```typescript
let pendingBuildFile: string | null = null;  // 1개만 저장!
```

**한계**: 파일 2개 이상 동시 변경 시 drop
- 예: A, B, C 동시 변경 → B 대기 → C 덮어씀 → B 미처리

**재현**: 빠른 연속 편집

**개선**: Set/Queue로 변경

### 6.2 Windows 경로 (dev.ts:78–81, css.ts:22–28)

**이슈**: Bun.spawn PATH 해석 불안정 (#152)

**해결**: process.execPath (절대 경로) + normalizeFsPath()

**잔여 위험**: 심볼릭 링크, UNC 경로

### 6.3 manifest.json Corruption (#186, build.ts:1480–1515)

**보호**: JSON parse/field validation → full build fallback

**미처리**: manifest 버전 스키마 변경

### 6.4 CSS 감시 (#152, css.ts:194–311)

**문제**: --watch hang 해결 후, 자체 fs.watch 사용

**한계**: app/, src/ 외부 import 파일 미감시

### 6.5 Layout-update 미구현

**현황**: 타입만 정의 (line:458), 클라이언트 핸들러만 (line:687)

**서버 송신 코드**: 없음

---

## 7. 남은 TODO 및 주석

### 코드 주석

**dev.ts**:
- Line 15–18: #184 sentinel (transitive 캐시 부분해결)
- Line 282–284: subprocess/worker 기반 해결 필요
- Line 787: #115 stale island 감지
- Line 180: #140 *.client.tsx 자동 등록

**build.ts**:
- Line 10–13: safe-build 동시성 (5+ 병렬 실패)
- Line 1574–1596: #10 build failure 시 good manifest 유지

**bun.ts**:
- Line 5–32: ESM 캐시 문제 설명
- Line 212–214: onResolve 플러그인 Windows panic

---

## 8. Phase 7 착수 시 주요 작업

| 항목 | 우선순위 | 시간 | 설명 |
|------|---------|------|------|
| pendingBuildFile 큐 확장 | High | 1–2h | 다중 파일 동시 변경 drop 해결 |
| Layout-update 구현 | Medium | 30m | 타입→실제 구현 |
| Transitive ESM 캐시 근본 | Medium | 4–8h | Worker 기반 SSR eval |
| E2E 테스트 | Low | 3–4h | HMR/watch 자동화 |
| Contract/Resource 감시 | Low | 1–2h | 라우트 리스캔 연동 |

---

**분석 대상**: Mandu v0.19+ (dev watch + HMR 구현)  
**파일 기준**: packages/core/src/bundler/dev.ts (811줄), build.ts (1887줄), cli/commands/dev.ts (663줄) 등  
**작성일**: 2026-04-18
