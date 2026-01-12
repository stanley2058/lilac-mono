import type z from "zod";
import type { BridgeFnHelpResponse } from "../schema";

export type ServerToolListResult = z.infer<typeof BridgeFnHelpResponse>[];

export interface ServerTool {
  id: string;

  init(): Promise<void>;
  destroy(): Promise<void>;
  list(): Promise<ServerToolListResult>;
  call(
    callableId: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
