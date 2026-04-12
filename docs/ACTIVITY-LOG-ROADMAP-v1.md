# Mandu Activity Log & Observability Roadmap v1.0

> 날짜: 2026-04-12

---

## 아키텍처: EventBus + 3 Consumers

```
                    ┌─ 터미널 1: mandu dev (요청 1줄 + Guard 경고)
                    │
  EventBus ─────────┼─ 터미널 2: mandu monitor (MCP 도구 호출 상세)
  (통합 이벤트)      │
                    └─ 브라우저: /__kitchen (전부 시각화)
```

같은 이벤트 스트림을 3곳에서 각자의 방식으로 소비.

---

## 현재 상태

| 시스템 | 파일 | 역할 | 문제 |
|--------|------|------|------|
| ActivityMonitor | `mcp/activity-monitor.ts` (845줄) | MCP 도구 호출 추적 | Logger와 분리 |
| Runtime Logger | `core/runtime/logger.ts` (677줄) | HTTP 요청/응답 로깅 | ActivityMonitor와 연결 안 됨 |
| Kitchen DevTools | `core/kitchen/` + `devtools/` | 에러 수집, 대시보드 | 인메모리 50개, 재시작 시 소실 |
| Monitor CLI | `cli/commands/monitor.ts` (300줄) | 로그 파일 follow | 필터링 없음 |

---

## Phase 1: 통합 EventBus

### 1-1. EventBus 코어 (`packages/core/src/observability/event-bus.ts`)

```typescript
type EventType = "http" | "mcp" | "guard" | "build" | "error" | "cache" | "ws";

interface ObservabilityEvent {
  id: string;              // 고유 이벤트 ID
  correlationId?: string;  // 요청 추적용 (Request ID)
  type: EventType;
  severity: "info" | "warn" | "error";
  source: string;          // "server" | "mcp" | "guard" | "bundler"
  timestamp: number;
  message: string;
  data?: Record<string, unknown>;
  duration?: number;       // ms
}

class ManduEventBus {
  private listeners = new Map<string, Set<(event: ObservabilityEvent) => void>>();
  
  on(type: EventType | "*", handler): unsubscribe
  emit(event: ObservabilityEvent): void
  getRecent(count?: number): ObservabilityEvent[]
}

export const eventBus = new ManduEventBus();
```

### 1-2. Logger → EventBus 연결

`core/runtime/logger.ts`의 sink 옵션 활용:
```typescript
import { eventBus } from "../observability/event-bus";

// Logger sink가 HTTP 이벤트를 EventBus로 전달
const loggerSink = (entry: LogEntry) => {
  eventBus.emit({
    type: "http",
    correlationId: entry.requestId,
    message: `${entry.method} ${entry.path} ${entry.status}`,
    duration: entry.duration,
    data: { method: entry.method, path: entry.path, status: entry.status },
  });
};
```

### 1-3. ActivityMonitor → EventBus 연결

MCP 도구 호출 이벤트를 EventBus로 전달:
```typescript
// MCP 도구 호출 시
eventBus.emit({
  type: "mcp",
  message: `${toolName} → ${success ? "✅" : "❌"}`,
  duration: elapsed,
  data: { tool: toolName, args, success },
});
```

### 1-4. Correlation ID 전파

HTTP 요청 → MCP 도구 호출 → 슬롯 실행까지 같은 ID로 추적:
```
[req-abc123] GET /dashboard 200 45ms
  └─ [req-abc123] mandu.slot.read {routeId: "dashboard"} 12ms
  └─ [req-abc123] renderSSR 28ms
```

---

## Phase 2: dev 터미널 강화

### 2-1. 요청 1줄 로그

`mandu dev` 실행 중 HTTP 요청을 1줄로 표시:
```
[14:32:01] GET / 200 12ms
[14:32:03] POST /api/chat 200 45ms (SSE)
[14:32:15] 🛡️ Guard: layer-violation in src/client/features/auth.ts
```

EventBus `http` + `guard` 이벤트 구독.

### 2-2. MCP Activity 토글 (m 키)

`m` 키를 누르면 MCP 도구 호출도 인라인 표시:
```
[14:32:20] 🤖 mandu.route.add → ✅ 42ms
[14:32:21] 🤖 mandu.contract.create → ✅ 18ms
```

`m` 다시 누르면 끔. EventBus `mcp` 이벤트 구독 토글.

---

## Phase 3: Monitor CLI 강화

### 3-1. 필터링

```bash
mandu monitor                           # 전체 이벤트
mandu monitor --type mcp                # MCP 도구만
mandu monitor --type http               # HTTP 요청만
mandu monitor --severity error          # 에러만
mandu monitor --trace req-abc123        # 특정 요청 추적
```

### 3-2. 통계 모드

```bash
mandu monitor --stats
# 최근 5분:
#   HTTP: 142 req, avg 23ms, 2 errors
#   MCP:  38 calls, avg 45ms, 0 failures
#   Guard: 1 violation
#   Cache: 87% hit rate
```

### 3-3. EventBus 기반

현재 파일 기반(`.mandu/activity.jsonl`)에서 EventBus SSE 스트림 기반으로 전환.
파일 저장은 영속화 용도로 유지.

---

## Phase 4: Kitchen 대시보드 확장

### 4-1. Requests 탭 (NEW)

HTTP 요청 목록 + 상세 트레이스:
```
GET /           200  12ms  HIT
POST /api/chat  200  45ms  SSE stream
GET /api/users  500  120ms ERROR
```

클릭하면 상세: Request → Slot → Render → Response 타임라인.

### 4-2. Activity 탭 (NEW)

MCP 도구 호출 타임라인:
```
14:32:20  mandu.route.add         ✅  42ms
14:32:21  mandu.contract.create   ✅  18ms
14:32:22  mandu.guard.check       ⚠️  35ms  1 violation
```

### 4-3. Cache 탭 (NEW)

ISR/SWR 캐시 통계:
```
Entries: 42/1000
Hit rate: 87%
Stale: 3
Tags: posts(12), users(8), products(22)
```

### 4-4. Errors 영속화

인메모리 50개 → `.mandu/errors.jsonl` 파일 저장:
- 서버 시작 시 파일에서 로드
- 새 에러 발생 시 append
- MAX_STORED_ERRORS 제한 유지

### 4-5. Metrics 탭 (NEW)

프레임워크 고유 성능 메트릭:
- TTFB 분포 (p50, p95, p99)
- SSR 렌더링 시간
- Island 하이드레이션 시간
- 번들 크기 추이

---

## Phase 5: AI 에이전트 관찰성

### 5-1. 에이전트별 활동 추적

```typescript
eventBus.emit({
  type: "mcp",
  data: {
    agentId: mcpSessionId,   // MCP 세션별 식별
    tool: "mandu.guard.check",
    ...
  },
});
```

### 5-2. 도구 사용 패턴 분석

Kitchen `/__kitchen/api/agent-stats`:
```json
{
  "agents": {
    "session-abc": {
      "toolCalls": 38,
      "failures": 2,
      "topTools": ["mandu.guard.check", "mandu.route.add"],
      "avgDuration": 45
    }
  }
}
```

### 5-3. MCP Prompts/Resources 활용

`mandu://activity` 리소스:
```json
{
  "recent": [...last 20 events],
  "stats": { "http": { "count": 142, "avgMs": 23 }, "mcp": {...} }
}
```

---

## Phase 6: 영구 저장 + 분석

### 6-1. SQLite 저장소 (장기)

`.mandu/observability.db`:
```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  correlation_id TEXT,
  type TEXT,
  severity TEXT,
  source TEXT,
  message TEXT,
  data JSON,
  duration_ms INTEGER,
  timestamp INTEGER
);

CREATE INDEX idx_type ON events(type);
CREATE INDEX idx_correlation ON events(correlation_id);
CREATE INDEX idx_timestamp ON events(timestamp);
```

### 6-2. 시계열 쿼리

```bash
mandu monitor --stats --since 1h      # 지난 1시간 통계
mandu monitor --stats --compare 24h   # 어제 대비 변화
```

### 6-3. Export

```bash
mandu monitor --export jsonl > events.jsonl
mandu monitor --export otlp > traces.json    # OpenTelemetry 호환
```

---

## 우선순위 매트릭스

```
임팩트 ↑
극대  │  EventBus(1-1)        Correlation ID(1-4)
      │  dev 요청로그(2-1)
      │
 대   │  Logger연결(1-2)      Kitchen Requests(4-1)
      │  MCP연결(1-3)         Kitchen Activity(4-2)
      │
 높   │  Monitor필터(3-1)     Kitchen Cache(4-3)
      │  dev MCP토글(2-2)     에러영속화(4-4)
      │
 중   │  Monitor통계(3-2)     에이전트추적(5-1)
      │  Kitchen Metrics(4-5) SQLite(6-1)
      │
      └─────────────────────────────────→ 난이도
           하                  중        상
```

---

## 핵심 원칙

> **EventBus 하나 + Consumer 3개**
> 같은 이벤트를 터미널(dev), 터미널(monitor), 브라우저(kitchen)에서 각자의 방식으로 소비

> **터미널 = 흐름** (1줄 요약)
> **Monitor = 상세** (필터링, 트레이스)
> **Kitchen = 시각화** (탭, 차트, 타임라인)
