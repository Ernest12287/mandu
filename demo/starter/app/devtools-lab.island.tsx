import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  StarterPlaygroundShell,
  createInitialPlaygroundModel,
  type LabEntryView,
  type Tone,
} from "../src/playground-shell";

const HEALTH_URL = "/api/health";
const LAB_URL = "/api/lab";
const STREAM_URL = "/api/lab/stream";

function formatTime() {
  return new Date().toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatPayload(payload: unknown) {
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload, null, 2);
}

export default function DevtoolsLabIsland() {
  const initial = createInitialPlaygroundModel();
  const [entries, setEntries] = useState<LabEntryView[]>(initial.control.entries);
  const [busyLabel, setBusyLabel] = useState(initial.control.busyLabel);
  const [streamLabel, setStreamLabel] = useState(initial.control.streamLabel);
  const [streamOpen, setStreamOpen] = useState(initial.control.streamOpen);
  const [idleStatus, setIdleStatus] = useState(initial.idle.statusLabel);
  const [idleMode, setIdleMode] = useState(initial.idle.modeLabel);
  const [idleLines, setIdleLines] = useState(initial.idle.bodyLines);
  const [visibleState, setVisibleState] = useState(initial.visible.stateLabel);
  const [visibleLines, setVisibleLines] = useState(initial.visible.bodyLines);
  const [interactionState, setInteractionState] = useState(initial.interaction.stateLabel);
  const [interactionCount, setInteractionCount] = useState(initial.interaction.count);
  const [interactionArmed, setInteractionArmed] = useState(initial.interaction.armed);
  const [interactionButton, setInteractionButton] = useState(initial.interaction.buttonLabel);
  const [interactionHelper, setInteractionHelper] = useState(initial.interaction.helper);
  const streamRef = useRef<EventSource | null>(null);
  const visibleRef = useRef<HTMLDivElement | null>(null);
  const visibleLoadedRef = useRef(false);

  const appendEntry = useCallback((title: string, detail: string, tone: Tone) => {
    setEntries((current) => [
      {
        id: Date.now() + current.length,
        title,
        detail,
        tone,
        time: formatTime(),
      },
      ...current,
    ].slice(0, 8));
  }, []);

  const runRequest = useCallback(async (
    label: string,
    url: string,
    init?: RequestInit,
  ) => {
    setBusyLabel(`${label} in flight`);
    try {
      const response = await fetch(url, init);
      const text = await response.text();
      let payload: unknown = text;

      try {
        payload = JSON.parse(text);
      } catch {
        // keep raw text
      }

      appendEntry(
        `${init?.method ?? "GET"} ${response.status}`,
        `${label}\n${formatPayload(payload)}`,
        response.ok ? "success" : "error",
      );
    } catch (error) {
      appendEntry(
        label,
        error instanceof Error ? error.message : "Unknown network error",
        "error",
      );
    } finally {
      setBusyLabel("Ready for the next probe");
    }
  }, [appendEntry]);

  const refreshIdle = useCallback(async () => {
    setIdleStatus("Pending");
    setIdleMode("idle");
    setIdleLines([
      "idle hydration after-mount probe is running.",
      "Waiting for the latest summary payload.",
    ]);

    try {
      const response = await fetch(`${LAB_URL}?mode=summary&delay=540`);
      const payload = await response.json();

      setIdleStatus(response.ok ? "Ready" : "Error");
      setIdleMode(payload.mode ?? "idle");
      setIdleLines([
        `requestId: ${payload.requestId ?? "unknown"}`,
        `delay: ${payload.delayMs ?? "?"}ms`,
        `updated: ${payload.at ? new Date(payload.at).toLocaleTimeString("ko-KR") : "n/a"}`,
      ]);
    } catch (error) {
      setIdleStatus("Error");
      setIdleMode("idle");
      setIdleLines([
        error instanceof Error ? error.message : "Unknown idle error",
      ]);
    }
  }, []);

  const loadVisibleProbe = useCallback(async () => {
    if (visibleLoadedRef.current) return;
    visibleLoadedRef.current = true;
    setVisibleState("Visible probe active");
    setVisibleLines([
      "Element entered the viewport.",
      "Fetching delayed visible payload...",
    ]);

    try {
      const response = await fetch(`${LAB_URL}?mode=visible&delay=820`);
      const payload = await response.json();

      setVisibleState(response.ok ? "Visible probe complete" : "Visible probe error");
      setVisibleLines([
        `requestId: ${payload.requestId ?? "unknown"}`,
        `delay: ${payload.delayMs ?? "?"}ms`,
        `updated: ${payload.at ? new Date(payload.at).toLocaleTimeString("ko-KR") : "n/a"}`,
      ]);
    } catch (error) {
      setVisibleState("Visible probe error");
      setVisibleLines([
        error instanceof Error ? error.message : "Unknown visible error",
      ]);
    }
  }, []);

  const armInteraction = useCallback(() => {
    if (interactionArmed) return;
    setInteractionArmed(true);
    setInteractionState(`Armed at ${formatTime()}`);
    setInteractionButton("Count interaction");
    setInteractionHelper("Counter is now active. Click again to increment it.");
  }, [interactionArmed]);

  const closeStream = useCallback(() => {
    streamRef.current?.close();
    streamRef.current = null;
    setStreamOpen(false);
    setStreamLabel("SSE idle");
  }, []);

  useEffect(() => {
    const idleHandle = "requestIdleCallback" in window
      ? window.requestIdleCallback(() => {
          void refreshIdle();
        })
      : window.setTimeout(() => {
          void refreshIdle();
        }, 220);

    return () => {
      if (typeof idleHandle === "number") {
        window.clearTimeout(idleHandle);
      } else if ("cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleHandle);
      }
      streamRef.current?.close();
    };
  }, [refreshIdle]);

  useEffect(() => {
    const target = visibleRef.current;
    if (!target || visibleLoadedRef.current) return;

    if (!("IntersectionObserver" in window)) {
      void loadVisibleProbe();
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        void loadVisibleProbe();
      }
    }, { rootMargin: "40px" });

    observer.observe(target);
    return () => observer.disconnect();
  }, [loadVisibleProbe]);

  const model = useMemo(() => ({
    control: {
      streamLabel,
      busyLabel,
      streamOpen,
      entries,
    },
    idle: {
      statusLabel: idleStatus,
      modeLabel: idleMode,
      bodyLines: idleLines,
    },
    visible: {
      stateLabel: visibleState,
      bodyLines: visibleLines,
    },
    interaction: {
      stateLabel: interactionState,
      count: interactionCount,
      armed: interactionArmed,
      buttonLabel: interactionButton,
      helper: interactionHelper,
    },
  }), [
    busyLabel,
    entries,
    idleLines,
    idleMode,
    idleStatus,
    interactionArmed,
    interactionButton,
    interactionCount,
    interactionHelper,
    interactionState,
    streamLabel,
    streamOpen,
    visibleLines,
    visibleState,
  ]);

  return (
    <StarterPlaygroundShell
      model={model}
      visibleRef={visibleRef}
      actions={{
        onPingHealth: () => {
          void runRequest("Health check", HEALTH_URL);
        },
        onDelayedGet: () => {
          void runRequest("Delayed summary", `${LAB_URL}?mode=summary&delay=900`);
        },
        onPostPayload: () => {
          void runRequest("Create sample payload", `${LAB_URL}?delay=320`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "create-sample", source: "starter" }),
          });
        },
        onDeletePayload: () => {
          void runRequest("Delete sample payload", `${LAB_URL}?mode=cleanup&delay=240`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target: "starter-sample" }),
          });
        },
        onOpenSse: () => {
          if (streamRef.current) return;
          setStreamLabel("SSE connecting");
          const source = new EventSource(STREAM_URL);
          streamRef.current = source;

          source.addEventListener("progress", (event) => {
            setStreamOpen(true);
            setStreamLabel("SSE active");
            appendEntry("SSE progress", (event as MessageEvent).data, "success");
          });

          source.addEventListener("done", (event) => {
            appendEntry("SSE done", (event as MessageEvent).data, "neutral");
            closeStream();
          });

          source.onerror = () => {
            appendEntry("SSE error", "Event stream closed or failed.", "warning");
            closeStream();
          };
        },
        onCloseSse: () => {
          appendEntry("SSE closed", "Connection closed from the starter lab.", "warning");
          closeStream();
        },
        onRuntimeError: () => {
          window.setTimeout(() => {
            throw new Error("Starter runtime error from the DevTools control lab.");
          }, 0);
        },
        onPromiseRejection: () => {
          Promise.reject(
            new Error("Starter unhandled rejection from the DevTools control lab."),
          );
        },
        onRefreshIdle: () => {
          void refreshIdle();
        },
        onInteractionIntent: armInteraction,
        onInteractionCount: () => {
          armInteraction();
          setInteractionCount((value) => value + 1);
        },
      }}
    />
  );
}
