import type ts from "typescript-codegen";

let loaded: typeof ts | undefined;

// Loaded on first property access: the compiler costs about 25 MiB of RSS and many Core processes
// never validate a workflow. Its callers are synchronous, so this cannot use import().
export const typescript = new Proxy<typeof ts>(Object.create(null), {
  get(_target, key) {
    loaded ??= require("typescript-codegen");
    return Reflect.get(loaded!, key);
  },
});
