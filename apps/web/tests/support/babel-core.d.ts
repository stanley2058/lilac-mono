// Babel 7 ships without types, and the compiler scan needs only this call.
declare module "@babel/core" {
  export function transformAsync(code: string, options: Record<string, unknown>): Promise<unknown>;
}
