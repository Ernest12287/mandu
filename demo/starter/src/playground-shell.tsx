import React from "react";

export type Tone = "neutral" | "success" | "warning" | "error";

export interface LabEntryView {
  id: number;
  title: string;
  detail: string;
  tone: Tone;
  time: string;
}

export interface StarterPlaygroundModel {
  control: {
    streamLabel: string;
    busyLabel: string;
    entries: LabEntryView[];
    streamOpen: boolean;
  };
  idle: {
    statusLabel: string;
    modeLabel: string;
    bodyLines: string[];
  };
  visible: {
    stateLabel: string;
    bodyLines: string[];
  };
  interaction: {
    stateLabel: string;
    count: number;
    armed: boolean;
    buttonLabel: string;
    helper: string;
  };
}

export interface StarterPlaygroundActions {
  onPingHealth?: () => void;
  onDelayedGet?: () => void;
  onPostPayload?: () => void;
  onDeletePayload?: () => void;
  onOpenSse?: () => void;
  onCloseSse?: () => void;
  onRuntimeError?: () => void;
  onPromiseRejection?: () => void;
  onRefreshIdle?: () => void;
  onInteractionIntent?: () => void;
  onInteractionCount?: () => void;
}

export function createInitialPlaygroundModel(): StarterPlaygroundModel {
  return {
    control: {
      streamLabel: "SSE idle",
      busyLabel: "Ready for the next probe",
      streamOpen: false,
      entries: [
        {
          id: 1,
          title: "Lab ready",
          detail: "Use the buttons below while watching the floating DevTools panel.",
          tone: "neutral",
          time: "Ready",
        },
      ],
    },
    idle: {
      statusLabel: "Pending",
      modeLabel: "idle",
      bodyLines: [
        "idle hydration after-mount probe is waiting.",
        "The first request will run after the page settles.",
      ],
    },
    visible: {
      stateLabel: "Waiting for scroll",
      bodyLines: [
        "Scroll into the lower section to arm the visibility probe.",
        "When it fires, a delayed fetch result will appear here.",
      ],
    },
    interaction: {
      stateLabel: "Waiting for interaction",
      count: 0,
      armed: false,
      buttonLabel: "Arm interaction counter",
      helper: "Hover or click this card to activate the counter.",
    },
  };
}

const shell = {
  page: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "24px",
    maxWidth: "1120px",
    margin: "0 auto",
  },
  hero: {
    display: "grid",
    gridTemplateColumns: "1.5fr 1fr",
    gap: "20px",
  },
  heroCard: {
    borderRadius: "28px",
    padding: "28px",
    border: "1px solid rgba(148, 163, 184, 0.2)",
    background:
      "linear-gradient(160deg, rgba(15, 23, 42, 0.96), rgba(30, 41, 59, 0.88))",
    boxShadow: "0 24px 48px rgba(15, 23, 42, 0.18)",
  },
  sideCard: {
    borderRadius: "24px",
    padding: "24px",
    border: "1px solid rgba(148, 163, 184, 0.16)",
    background:
      "linear-gradient(180deg, rgba(255, 255, 255, 0.84), rgba(248, 250, 252, 0.96))",
    boxShadow: "0 20px 40px rgba(148, 163, 184, 0.12)",
  },
  eyebrow: {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 12px",
    borderRadius: "999px",
    background: "rgba(251, 146, 60, 0.14)",
    color: "#9a3412",
    fontSize: "12px",
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
  },
  h1: {
    margin: "18px 0 12px",
    fontSize: "56px",
    lineHeight: 1.05,
    letterSpacing: "-0.04em",
    color: "#f8fafc",
    fontWeight: 800,
  },
  lead: {
    margin: 0,
    maxWidth: "700px",
    color: "rgba(226, 232, 240, 0.82)",
    fontSize: "18px",
    lineHeight: 1.7,
  },
  heroGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: "14px",
    marginTop: "24px",
  },
  metricCard: {
    borderRadius: "20px",
    padding: "16px",
    border: "1px solid rgba(148, 163, 184, 0.14)",
    background: "rgba(255, 255, 255, 0.04)",
  },
  metricLabel: {
    fontSize: "12px",
    color: "rgba(226, 232, 240, 0.7)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
  },
  metricValue: {
    display: "block",
    marginTop: "10px",
    color: "#f8fafc",
    fontSize: "26px",
    fontWeight: 700,
  },
  section: {
    borderRadius: "28px",
    padding: "28px",
    border: "1px solid rgba(148, 163, 184, 0.14)",
    background: "rgba(255, 255, 255, 0.76)",
    boxShadow: "0 20px 44px rgba(148, 163, 184, 0.12)",
  },
  sectionTitle: {
    margin: 0,
    fontSize: "28px",
    color: "#0f172a",
    fontWeight: 700,
    letterSpacing: "-0.03em",
  },
  sectionLead: {
    margin: "10px 0 0",
    color: "#475569",
    fontSize: "15px",
    lineHeight: 1.7,
  },
  checklist: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "12px",
    marginTop: "20px",
  },
  step: {
    borderRadius: "18px",
    padding: "16px",
    border: "1px solid rgba(148, 163, 184, 0.16)",
    background: "#ffffff",
  },
  stepNo: {
    display: "inline-flex",
    width: "28px",
    height: "28px",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "999px",
    background: "#0f172a",
    color: "#f8fafc",
    fontSize: "13px",
    fontWeight: 700,
  },
  stepTitle: {
    display: "block",
    marginTop: "14px",
    color: "#0f172a",
    fontWeight: 700,
    fontSize: "15px",
  },
  stepBody: {
    margin: "8px 0 0",
    color: "#64748b",
    fontSize: "14px",
    lineHeight: 1.6,
  },
  demoGrid: {
    display: "grid",
    gridTemplateColumns: "1.4fr 1fr",
    gap: "16px",
    marginTop: "20px",
  },
  islandShell: {
    borderRadius: "24px",
    border: "1px solid rgba(148, 163, 184, 0.16)",
    background:
      "linear-gradient(180deg, rgba(255, 255, 255, 0.92), rgba(248, 250, 252, 0.96))",
    minHeight: "280px",
    overflow: "hidden",
  },
  cardBody: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "18px",
    height: "100%",
    padding: "22px",
    background:
      "linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(248, 250, 252, 0.96))",
  },
  fallbackTitle: {
    fontSize: "18px",
    fontWeight: 700,
    color: "#0f172a",
  },
  fallbackBody: {
    margin: 0,
    color: "#64748b",
    fontSize: "14px",
    lineHeight: 1.7,
  },
  badgeRow: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "8px",
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    padding: "6px 10px",
    borderRadius: "999px",
    background: "rgba(15, 23, 42, 0.06)",
    color: "#334155",
    fontSize: "12px",
    fontWeight: 600,
  },
  links: {
    display: "grid",
    gap: "10px",
    marginTop: "20px",
  },
  linkRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    padding: "14px 16px",
    borderRadius: "16px",
    background: "#ffffff",
    border: "1px solid rgba(148, 163, 184, 0.14)",
  },
  code: {
    fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
    fontSize: "13px",
    color: "#0f172a",
  },
  anchor: {
    color: "#c2410c",
    fontWeight: 700,
    textDecoration: "none",
  },
  spacer: {
    height: "60vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#64748b",
    fontSize: "14px",
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
  },
  buttonGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "10px",
  },
  button: {
    border: "none",
    borderRadius: "14px",
    padding: "12px 14px",
    background: "#0f172a",
    color: "#f8fafc",
    fontSize: "13px",
    fontWeight: 700,
    cursor: "pointer",
  },
  statusRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    fontSize: "12px",
    color: "#64748b",
  },
  entryGrid: {
    display: "grid",
    gap: "10px",
    padding: "6px 0 0",
  },
  entryCard: {
    borderRadius: "16px",
    padding: "14px",
    border: "1px solid rgba(148, 163, 184, 0.16)",
    background: "#ffffff",
  },
  metricGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "10px",
  },
  metricPanel: {
    borderRadius: "18px",
    padding: "14px",
    background: "#ffffff",
    border: "1px solid rgba(148, 163, 184, 0.16)",
  },
  metricPanelLabel: {
    fontSize: "12px",
    color: "#64748b",
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
  },
  metricPanelValue: {
    marginTop: "10px",
    fontSize: "22px",
    fontWeight: 700,
    color: "#0f172a",
  },
  bodyPanel: {
    borderRadius: "18px",
    padding: "16px",
    background: "#ffffff",
    border: "1px solid rgba(148, 163, 184, 0.16)",
    minHeight: "110px",
  },
} as const;

const quickSteps = [
  {
    title: "Route island 열기",
    body: "오른쪽 하단 패널을 열고 Issues와 Network 탭을 먼저 띄운 뒤 Control Lab 버튼들을 눌러보세요.",
  },
  {
    title: "SSE 스트림 확인",
    body: "Open SSE를 누르면 Network 탭에 스트리밍 요청이 남고 로그에 progress 이벤트가 쌓입니다.",
  },
  {
    title: "오류 수집 보기",
    body: "Runtime Error와 Promise Rejection 버튼으로 에러 패널과 오버레이 동작을 확인할 수 있습니다.",
  },
  {
    title: "Scroll / interaction probe",
    body: "아래로 내려가면 visible probe가 작동하고, Interaction Gate에 hover나 click을 주면 카운터가 활성화됩니다.",
  },
];

const apiLinks = [
  { label: "Health", href: "/api/health", method: "GET" },
  { label: "Lab JSON", href: "/api/lab?mode=summary&delay=320", method: "GET" },
  { label: "Lab Error", href: "/api/lab?mode=error&delay=240", method: "GET" },
  { label: "Lab Stream", href: "/api/lab/stream", method: "SSE" },
  { label: "Kitchen", href: "/__kitchen", method: "UI" },
];

const toneStyles: Record<Tone, React.CSSProperties> = {
  neutral: { background: "rgba(15, 23, 42, 0.05)", color: "#334155" },
  success: { background: "rgba(16, 185, 129, 0.12)", color: "#047857" },
  warning: { background: "rgba(245, 158, 11, 0.14)", color: "#b45309" },
  error: { background: "rgba(239, 68, 68, 0.12)", color: "#b91c1c" },
};

export interface StarterPlaygroundShellProps {
  model: StarterPlaygroundModel;
  actions?: StarterPlaygroundActions;
  visibleRef?: React.RefObject<HTMLDivElement | null>;
}

export function StarterPlaygroundShell({
  model,
  actions,
  visibleRef,
}: StarterPlaygroundShellProps) {
  return (
    <main style={shell.page}>
      <section style={shell.hero}>
        <div style={shell.heroCard}>
          <span style={shell.eyebrow}>Starter Playground</span>
          <h1 style={shell.h1}>Mandu starter, now tuned for DevTools.</h1>
          <p style={shell.lead}>
            최소 예제를 넘어서 DevTools 신호를 의도적으로 만드는 실험장으로 확장했습니다.
            이 페이지 하나에서 네트워크, route hydration, SSE, 런타임 오류를 바로 재현할 수 있습니다.
          </p>

          <div style={shell.heroGrid}>
            <div style={shell.metricCard}>
              <span style={shell.metricLabel}>Mode</span>
              <span style={shell.metricValue}>Route island</span>
            </div>
            <div style={shell.metricCard}>
              <span style={shell.metricLabel}>Signals</span>
              <span style={shell.metricValue}>Network / Error / SSE</span>
            </div>
            <div style={shell.metricCard}>
              <span style={shell.metricLabel}>Focus</span>
              <span style={shell.metricValue}>DevTools probes</span>
            </div>
          </div>
        </div>

        <aside style={shell.sideCard}>
          <h2 style={{ ...shell.sectionTitle, fontSize: "22px" }}>Quick route surface</h2>
          <p style={{ ...shell.sectionLead, marginTop: "8px" }}>
            starter에서도 여러 탭이 비지 않게 즉시 확인할 수 있는 엔드포인트와 UI 진입점을 준비했습니다.
          </p>
          <div style={shell.links}>
            {apiLinks.map((link) => (
              <div key={link.href} style={shell.linkRow}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <span style={{ ...shell.badge, background: "rgba(251, 146, 60, 0.12)", color: "#9a3412" }}>
                    {link.method}
                  </span>
                  <span style={shell.code}>{link.href}</span>
                </div>
                <a href={link.href} style={shell.anchor}>
                  Open
                </a>
              </div>
            ))}
          </div>
        </aside>
      </section>

      <section style={shell.section}>
        <h2 style={shell.sectionTitle}>Try this sequence</h2>
        <p style={shell.sectionLead}>
          떠 있는 DevTools 패널을 열어둔 상태에서 아래 순서대로 움직이면 대부분의 탭이 바로 채워집니다.
        </p>
        <div style={shell.checklist}>
          {quickSteps.map((step, index) => (
            <article key={step.title} style={shell.step}>
              <span style={shell.stepNo}>{index + 1}</span>
              <span style={shell.stepTitle}>{step.title}</span>
              <p style={shell.stepBody}>{step.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section style={shell.section}>
        <h2 style={shell.sectionTitle}>Live probes</h2>
        <p style={shell.sectionLead}>
          route island 하나 안에서 immediate action, idle fetch, scroll observer, interaction gate를 순차적으로 시험할 수 있습니다.
        </p>

        <div style={shell.demoGrid}>
          <div style={shell.islandShell}>
            <div style={shell.cardBody}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "flex-start" }}>
                <div>
                  <div style={shell.fallbackTitle}>Control Lab</div>
                  <p style={shell.fallbackBody}>
                    fetch, SSE, 오류 이벤트를 직접 만드는 메인 probe입니다.
                  </p>
                </div>
                <span
                  style={{
                    ...shell.badge,
                    ...(model.control.streamOpen
                      ? { background: "rgba(16, 185, 129, 0.12)", color: "#047857" }
                      : {}),
                  }}
                >
                  {model.control.streamLabel}
                </span>
              </div>

              <div style={shell.buttonGrid}>
                <button type="button" style={shell.button} onClick={actions?.onPingHealth}>
                  Ping health
                </button>
                <button type="button" style={shell.button} onClick={actions?.onDelayedGet}>
                  Delayed GET
                </button>
                <button type="button" style={shell.button} onClick={actions?.onPostPayload}>
                  POST payload
                </button>
                <button type="button" style={shell.button} onClick={actions?.onDeletePayload}>
                  DELETE payload
                </button>
                <button type="button" style={shell.button} onClick={actions?.onOpenSse}>
                  Open SSE
                </button>
                <button type="button" style={shell.button} onClick={actions?.onCloseSse}>
                  Close SSE
                </button>
                <button type="button" style={{ ...shell.button, background: "#7c2d12" }} onClick={actions?.onRuntimeError}>
                  Runtime error
                </button>
                <button type="button" style={{ ...shell.button, background: "#991b1b" }} onClick={actions?.onPromiseRejection}>
                  Promise rejection
                </button>
              </div>

              <div style={shell.statusRow}>
                <span>{model.control.busyLabel}</span>
                <span>Floating panel: Issues + Network + Kitchen</span>
              </div>

              <div style={shell.entryGrid}>
                {model.control.entries.map((entry) => (
                  <article key={entry.id} style={shell.entryCard}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
                      <strong style={{ color: "#0f172a", fontSize: "14px" }}>{entry.title}</strong>
                      <span
                        style={{
                          padding: "5px 9px",
                          borderRadius: "999px",
                          fontSize: "11px",
                          fontWeight: 700,
                          ...toneStyles[entry.tone],
                        }}
                      >
                        {entry.time}
                      </span>
                    </div>
                    <pre
                      style={{
                        margin: "10px 0 0",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        fontSize: "12px",
                        lineHeight: 1.6,
                        color: "#475569",
                        fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
                      }}
                    >
                      {entry.detail}
                    </pre>
                  </article>
                ))}
              </div>
            </div>
          </div>

          <div style={shell.islandShell}>
            <div style={shell.cardBody}>
              <div>
                <div style={shell.fallbackTitle}>Idle Metrics</div>
                <p style={shell.fallbackBody}>
                  mount 후 idle 슬롯에서 자동 요청을 보내는 가벼운 probe입니다.
                </p>
              </div>

              <div style={shell.metricGrid}>
                <div style={shell.metricPanel}>
                  <div style={shell.metricPanelLabel}>status</div>
                  <div style={shell.metricPanelValue}>{model.idle.statusLabel}</div>
                </div>
                <div style={shell.metricPanel}>
                  <div style={shell.metricPanelLabel}>mode</div>
                  <div style={shell.metricPanelValue}>{model.idle.modeLabel}</div>
                </div>
              </div>

              <div style={shell.bodyPanel}>
                <div style={{ display: "grid", gap: "8px", fontSize: "13px", color: "#475569" }}>
                  {model.idle.bodyLines.map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </div>
              </div>

              <button type="button" style={{ ...shell.button, alignSelf: "flex-start" }} onClick={actions?.onRefreshIdle}>
                Refresh idle probe
              </button>
            </div>
          </div>
        </div>
      </section>

      <div style={shell.spacer}>Scroll zone for visibility probe</div>

      <section style={shell.section}>
        <h2 style={shell.sectionTitle}>Lower fold probes</h2>
        <p style={shell.sectionLead}>
          아래 섹션은 scroll observer와 interaction gate로 작동합니다. 이 상태는 Network와 Issues 탭에서 함께 보기 좋습니다.
        </p>

        <div style={shell.demoGrid}>
          <div ref={visibleRef} style={shell.islandShell}>
            <div style={shell.cardBody}>
              <div>
                <div style={shell.fallbackTitle}>Visible Report</div>
                <p style={shell.fallbackBody}>
                  이 카드가 뷰포트에 들어오면 delayed fetch를 수행합니다.
                </p>
              </div>

              <div style={shell.bodyPanel}>
                <div style={{ display: "grid", gap: "8px", fontSize: "13px", color: "#475569" }}>
                  <strong style={{ color: "#0f172a" }}>{model.visible.stateLabel}</strong>
                  {model.visible.bodyLines.map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </div>
              </div>

              <div style={{ ...shell.badge, width: "fit-content" }}>observer-driven</div>
            </div>
          </div>

          <div
            style={shell.islandShell}
            onMouseEnter={actions?.onInteractionIntent}
            onFocus={actions?.onInteractionIntent}
            onPointerDown={actions?.onInteractionIntent}
          >
            <div style={shell.cardBody}>
              <div>
                <div style={shell.fallbackTitle}>Interaction Gate</div>
                <p style={shell.fallbackBody}>
                  hover, focus, click 같은 사용자 입력 이후에만 counter가 활성화됩니다.
                </p>
              </div>

              <div style={shell.metricGrid}>
                <div style={shell.metricPanel}>
                  <div style={shell.metricPanelLabel}>state</div>
                  <div style={shell.metricPanelValue}>{model.interaction.stateLabel}</div>
                </div>
                <div style={shell.metricPanel}>
                  <div style={shell.metricPanelLabel}>counter</div>
                  <div style={shell.metricPanelValue}>{model.interaction.count}</div>
                </div>
              </div>

              <button
                type="button"
                style={{
                  ...shell.button,
                  background: model.interaction.armed ? "#0f172a" : "#475569",
                }}
                onClick={model.interaction.armed ? actions?.onInteractionCount : actions?.onInteractionIntent}
              >
                {model.interaction.buttonLabel}
              </button>

              <p style={{ margin: 0, color: "#64748b", fontSize: "13px", lineHeight: 1.7 }}>
                {model.interaction.helper}
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
