import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RunSnapshot, RunTrace } from "../../types/api";
import { mergeRealtimeEvent } from "./merge";
import type { RealtimeRunEvent, RunConnectionState } from "./types";

const terminal = new Set(["completed", "blocked", "failed", "aborted"]);
export function useRunRealtimeStream(runId: string, enabled: boolean, onState?: (state: RunConnectionState) => void): RunConnectionState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<RunConnectionState>(enabled ? "connecting" : "closed");
  const degradedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { onState?.(state); }, [onState, state]);
  useEffect(() => {
    if (!enabled || !runId || typeof EventSource === "undefined") { setState(enabled ? "offline" : "closed"); return; }
    const source = new EventSource(`/v1/runs/${encodeURIComponent(runId)}/events`); let disposed = false;
    const update = (next: RunConnectionState) => { if (!disposed) { setState(next); onState?.(next); } };
    const onOpen = () => { if (degradedTimer.current) clearTimeout(degradedTimer.current); void queryClient.invalidateQueries({ queryKey: ["run", runId] }); void queryClient.invalidateQueries({ queryKey: ["trace", runId] }); update("live"); };
    const onError = () => { update("reconnecting"); if (degradedTimer.current) clearTimeout(degradedTimer.current); degradedTimer.current = setTimeout(() => update("degraded"), 3_000); };
    const onEvent = (message: MessageEvent<string>) => {
      try {
        const event = JSON.parse(message.data) as RealtimeRunEvent; if (event.runId !== runId) return;
        const current = queryClient.getQueryData<RunTrace>(["trace", runId]); const merged = mergeRealtimeEvent(current?.rawEvents ?? [], event, runId);
        if (!merged.ignored && current) queryClient.setQueryData<RunTrace>(["trace", runId], { ...current, rawEvents: merged.events });
        if (event.type === "run.settled" || event.type === "run.error") { const data = event.data as Record<string, unknown>; const status = event.type === "run.error" ? "failed" : typeof data.status === "string" ? data.status : undefined; if (status && terminal.has(status)) { queryClient.setQueryData<RunSnapshot>(["run", runId], (snapshot) => snapshot ? { ...snapshot, status: status as RunSnapshot["status"] } : snapshot); void queryClient.invalidateQueries({ queryKey: ["run", runId] }); void queryClient.invalidateQueries({ queryKey: ["trace", runId] }); source.close(); update("closed"); } }
        if (merged.gapDetected) { void queryClient.invalidateQueries({ queryKey: ["trace", runId] }); void queryClient.invalidateQueries({ queryKey: ["run", runId] }); }
      } catch { update("degraded"); }
    };
    source.addEventListener("open", onOpen); source.addEventListener("error", onError); source.addEventListener("run-event", onEvent as EventListener);
    return () => { disposed = true; if (degradedTimer.current) clearTimeout(degradedTimer.current); source.close(); };
  }, [enabled, onState, queryClient, runId]);
  return state;
}
