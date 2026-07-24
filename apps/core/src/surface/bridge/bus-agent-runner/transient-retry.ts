import {
  computeTransientRetryDelayMs,
  createTransientModelRetryController as createSharedTransientModelRetryController,
  isRetryableTransientModelError,
} from "@stanley2058/lilac-agent";
import { createLogger, type CoreConfig } from "@stanley2058/lilac-utils";

import { formatUnknownErrorForDisplay } from "./error-display";

type AgentRetryConfig = CoreConfig["agent"]["retry"];

export { computeTransientRetryDelayMs, isRetryableTransientModelError };

export function createTransientModelRetryController(params: {
  retry: AgentRetryConfig;
  logger: ReturnType<typeof createLogger>;
  requestId: string;
  sessionId: string;
  modelSpec: string;
}) {
  return createSharedTransientModelRetryController({
    ...params,
    formatError: formatUnknownErrorForDisplay,
  });
}
