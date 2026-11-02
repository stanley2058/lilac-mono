import { z } from "zod";

export type ComputerGeometry = { x: number; y: number; width: number; height: number };

const stateSchema = z.object({
  type: z.literal("lilac-computer-state"),
  state: z.enum(["ready", "connected", "disconnected", "failed"]),
});
export function decodeComputerState(value: unknown) {
  const parsed = stateSchema.safeParse(value);
  return parsed.success ? parsed.data.state : null;
}

const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("lilac-computer-connect"), password: z.string().min(1).max(256) }),
  z.object({ type: z.literal("lilac-computer-input"), enabled: z.boolean() }),
]);
export function decodeComputerCommand(event: MessageEvent<unknown>) {
  const parsed = commandSchema.safeParse(event.data);
  return parsed.success ? parsed.data : null;
}

export function computerFrameUrl(url: string, parentOrigin: string) {
  const target = new URL(url, parentOrigin);
  target.searchParams.set("parentOrigin", parentOrigin);
  return target.href;
}

export function clampComputerPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  return {
    x: Math.max(8, Math.min(x, viewportWidth - width - 8)),
    y: Math.max(8, Math.min(y, viewportHeight - height - 8)),
  };
}
