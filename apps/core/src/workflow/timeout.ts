export type WorkflowTimeoutResult = {
  kind: "timeout";
  timeoutAt: number;
  ts: number;
};
