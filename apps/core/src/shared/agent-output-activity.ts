import { lilacEventTypes, type AdapterPlatform, type LilacBus } from "@stanley2058/lilac-event-bus";

export type AgentOutputActivitySource = "model" | "tool" | "subagent";

const DEFAULT_PUBLISH_INTERVAL_MS = 30_000;

export function createAgentOutputActivityPublisher(params: {
  bus: LilacBus;
  headers: {
    request_id: string;
    session_id?: string;
    request_client?: AdapterPlatform;
  };
  intervalMs?: number;
  onError?: (error: unknown) => void;
}): (source: AgentOutputActivitySource) => void {
  const intervalMs = params.intervalMs ?? DEFAULT_PUBLISH_INTERVAL_MS;
  let lastPublishedAt: number | null = null;

  return (source) => {
    const now = Date.now();
    if (lastPublishedAt !== null && now - lastPublishedAt < intervalMs) return;
    lastPublishedAt = now;

    void params.bus
      .publish(lilacEventTypes.EvtAgentOutputActivity, { source }, { headers: params.headers })
      .catch((error: unknown) => params.onError?.(error));
  };
}
