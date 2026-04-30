/**
 * MCP Server Status Tracker
 *
 * Symbol 메타데이터를 사용하여 MCP 서버의 연결 상태를 추적
 *
 * @see docs/plans/09_lockfile_integration_plan.md
 */

import {
  type McpServerStatusMetadata,
} from "./symbols.js";

// ============================================
// 타입
// ============================================

export interface McpServerInfo {
  /** 서버 이름 */
  name: string;
  /** 연결 상태 */
  status: McpServerStatusMetadata["status"];
  /** 마지막 체크 시각 */
  lastCheck?: string;
  /** 오류 메시지 */
  error?: string;
  /** 서버 버전 */
  version?: string;
  /** 추가 메타데이터 */
  metadata?: Record<string, unknown>;
}

export interface McpStatusSummary {
  /** 전체 서버 수 */
  total: number;
  /** 연결된 서버 수 */
  connected: number;
  /** 연결 해제된 서버 수 */
  disconnected: number;
  /** 오류 상태 서버 수 */
  error: number;
  /** 알 수 없는 상태 서버 수 */
  unknown: number;
}

export interface McpStatusChangeEvent {
  /** 서버 이름 */
  serverName: string;
  /** 이전 상태 */
  previousStatus: McpServerStatusMetadata["status"];
  /** 현재 상태 */
  currentStatus: McpServerStatusMetadata["status"];
  /** 변경 시각 */
  timestamp: string;
  /** 오류 (있는 경우) */
  error?: string;
}

export type McpStatusListener = (event: McpStatusChangeEvent) => void;

// ============================================
// Status Tracker
// ============================================

/**
 * MCP Server Status Tracker
 *
 * 싱글톤 패턴으로 MCP 서버 상태를 중앙 관리
 *
 * @example
 * ```typescript
 * const tracker = getMcpStatusTracker();
 *
 * // 상태 업데이트
 * tracker.updateStatus("sequential-thinking", "connected");
 *
 * // 상태 조회
 * const status = tracker.getStatus("sequential-thinking");
 * console.log(status); // { status: "connected", lastCheck: "..." }
 *
 * // 이벤트 리스너
 * tracker.onStatusChange((event) => {
 *   console.log(`${event.serverName}: ${event.previousStatus} → ${event.currentStatus}`);
 * });
 * ```
 */
export class McpStatusTracker {
  private statuses = new Map<string, McpServerInfo>();
  private listeners: McpStatusListener[] = [];

  /**
   * 서버 상태 업데이트
   */
  updateStatus(
    serverName: string,
    status: McpServerStatusMetadata["status"],
    options?: {
      error?: string;
      version?: string;
      metadata?: Record<string, unknown>;
    }
  ): void {
    const previous = this.statuses.get(serverName);
    const previousStatus = previous?.status ?? "unknown";
    const now = new Date().toISOString();

    const newInfo: McpServerInfo = {
      name: serverName,
      status,
      lastCheck: now,
      error: options?.error,
      version: options?.version ?? previous?.version,
      metadata: options?.metadata ?? previous?.metadata,
    };

    this.statuses.set(serverName, newInfo);

    // 상태가 변경된 경우 이벤트 발행
    if (previousStatus !== status) {
      const event: McpStatusChangeEvent = {
        serverName,
        previousStatus,
        currentStatus: status,
        timestamp: now,
        error: options?.error,
      };

      this.notifyListeners(event);
    }
  }

  /**
   * 서버 상태 조회
   */
  getStatus(serverName: string): McpServerInfo | undefined {
    return this.statuses.get(serverName);
  }

  /**
   * 모든 서버 상태 조회
   */
  getAllStatuses(): McpServerInfo[] {
    return Array.from(this.statuses.values());
  }

  /**
   * 상태 요약 조회
   */
  getSummary(): McpStatusSummary {
    const servers = Array.from(this.statuses.values());

    return {
      total: servers.length,
      connected: servers.filter(s => s.status === "connected").length,
      disconnected: servers.filter(s => s.status === "disconnected").length,
      error: servers.filter(s => s.status === "error").length,
      unknown: servers.filter(s => s.status === "unknown").length,
    };
  }

  /**
   * 서버 등록 (초기 상태: unknown)
   */
  registerServer(
    serverName: string,
    metadata?: Record<string, unknown>
  ): void {
    if (!this.statuses.has(serverName)) {
      this.statuses.set(serverName, {
        name: serverName,
        status: "unknown",
        metadata,
      });
    }
  }

  /**
   * 서버 등록 해제
   */
  unregisterServer(serverName: string): boolean {
    return this.statuses.delete(serverName);
  }

  /**
   * 상태 변경 리스너 등록
   */
  onStatusChange(listener: McpStatusListener): () => void {
    this.listeners.push(listener);

    // 등록 해제 함수 반환
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * 모든 리스너에 이벤트 전달
   */
  private notifyListeners(event: McpStatusChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[McpStatusTracker] Listener error:", error);
      }
    }
  }

  /**
   * 모든 상태 초기화
   */
  clear(): void {
    this.statuses.clear();
  }
}

// ============================================
// 싱글톤 인스턴스
// ============================================

let trackerInstance: McpStatusTracker | null = null;

/**
 * MCP Status Tracker 싱글톤 인스턴스 획득
 */
export function getMcpStatusTracker(): McpStatusTracker {
  if (!trackerInstance) {
    trackerInstance = new McpStatusTracker();
  }
  return trackerInstance;
}

/**
 * 테스트용 인스턴스 리셋
 */
export function resetMcpStatusTracker(): void {
  trackerInstance = null;
}

// ============================================
// 유틸리티
// ============================================

/**
 * MCP 서버 상태 확인 (간단한 ping)
 *
 * 실제 MCP 프로토콜 체크가 아닌 프로세스 존재 여부 확인
 */
export async function checkMcpServerStatus(
  serverConfig: { command: string; args?: string[] }
): Promise<McpServerStatusMetadata["status"]> {
  try {
    // 간단한 command 존재 확인
    const proc = Bun.spawn([serverConfig.command, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    return exitCode === 0 ? "connected" : "error";
  } catch {
    return "disconnected";
  }
}

/**
 * 여러 MCP 서버 상태 일괄 확인
 */
export async function checkAllMcpServers(
  servers: Record<string, { command: string; args?: string[] }>
): Promise<Record<string, McpServerStatusMetadata>> {
  const results: Record<string, McpServerStatusMetadata> = {};
  const tracker = getMcpStatusTracker();

  await Promise.all(
    Object.entries(servers).map(async ([name, config]) => {
      const status = await checkMcpServerStatus(config);
      tracker.updateStatus(name, status);

      results[name] = {
        status,
        lastChecked: new Date().toISOString(),
      };
    })
  );

  return results;
}

// ============================================
// 포맷팅
// ============================================

/**
 * MCP 상태 요약을 콘솔 출력용 문자열로 변환
 */
export function formatMcpStatusSummary(summary: McpStatusSummary): string {
  const lines: string[] = [];

  lines.push("🔌 MCP Server Status");
  lines.push("───────────────────");
  lines.push(`  전체: ${summary.total}개`);

  if (summary.connected > 0) {
    lines.push(`  ✅ 연결됨: ${summary.connected}개`);
  }
  if (summary.disconnected > 0) {
    lines.push(`  ⚪ 연결 해제: ${summary.disconnected}개`);
  }
  if (summary.error > 0) {
    lines.push(`  ❌ 오류: ${summary.error}개`);
  }
  if (summary.unknown > 0) {
    lines.push(`  ❓ 알 수 없음: ${summary.unknown}개`);
  }

  return lines.join("\n");
}

/**
 * 개별 서버 상태를 문자열로 변환
 */
export function formatMcpServerStatus(info: McpServerInfo): string {
  const icon = getStatusIcon(info.status);
  let line = `${icon} ${info.name}`;

  if (info.version) {
    line += ` (v${info.version})`;
  }

  if (info.error) {
    line += ` - ${info.error}`;
  }

  return line;
}

function getStatusIcon(status: McpServerStatusMetadata["status"]): string {
  switch (status) {
    case "connected": return "✅";
    case "disconnected": return "⚪";
    case "error": return "❌";
    case "unknown": return "❓";
  }
}
