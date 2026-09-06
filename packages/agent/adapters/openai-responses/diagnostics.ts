import { createLogger } from "@stanley2058/lilac-utils/logging";
import { redactErrorTextForLog } from "@stanley2058/lilac-utils/tagged-error-log";
import { createLlmWireDebugTrace } from "@stanley2058/lilac-utils/llm-wire-debug";
import { captureAgentOperation, rethrowAgentPanic } from "../../failure-adapters";
import { resultOutcome } from "../../agent-runtime-support";

export type ResponsesDiagnosticFields = Readonly<
  Record<string, string | number | boolean | undefined>
>;

export interface ResponsesDiagnostics {
  withContext(fields: ResponsesDiagnosticFields): ResponsesDiagnostics;
  log(event: string, fields?: ResponsesDiagnosticFields, level?: "debug" | "warn"): void;
  wire(event: string, payload: object | string, fields?: ResponsesDiagnosticFields): void;
  flush(): Promise<void>;
}

export type ResponsesDiagnosticContext = {
  readonly requestId?: string;
  readonly sessionId?: string;
};

export function createResponsesDiagnostics(
  context: ResponsesDiagnosticContext & {
    readonly provider: "openai" | "codex";
    readonly model: string;
  },
  writeLog?: (level: "debug" | "warn", event: string, fields: ResponsesDiagnosticFields) => void,
): ResponsesDiagnostics {
  const logger = createLogger({ module: "agent:responses" });
  const trace = createLlmWireDebugTrace({ provider: context.provider, context });
  const write = writeLog ?? ((level, event, fields) => logger[level](event, fields));
  const child = (fields: ResponsesDiagnosticFields): ResponsesDiagnostics => ({
    withContext: (additional) => child({ ...fields, ...additional }),
    log(event, details, level = "debug") {
      const redacted = Object.fromEntries(
        Object.entries({ ...fields, ...details }).map(([key, value]) => [
          key,
          typeof value === "string" ? redactErrorTextForLog(value) : value,
        ]),
      );
      const logged = resultOutcome(captureAgentOperation(() => write(level, event, redacted)));
      if (!logged.ok) rethrowAgentPanic(logged.error);
    },
    wire(event, payload, details) {
      const logged = resultOutcome(
        captureAgentOperation(() => trace.write(event, payload, { ...fields, ...details })),
      );
      if (!logged.ok) rethrowAgentPanic(logged.error);
    },
    flush: () => trace.flush(),
  });
  return child(context);
}
