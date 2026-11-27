import { CONFIG_UI_KEY, type ConfigFieldUi } from "../config-schema";

/** Zod `.meta()` payload that the editor schema carries as `x-lilac`. */
export function configUi(ui: ConfigFieldUi): { [CONFIG_UI_KEY]: ConfigFieldUi } {
  return { [CONFIG_UI_KEY]: ui };
}
