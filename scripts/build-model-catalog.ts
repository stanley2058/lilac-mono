import { decodeModelsDevRegistry } from "../packages/utils/model-catalog-schema";

const response = await fetch("https://models.dev/api.json", {
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
const catalog = decodeModelsDevRegistry(await response.json());
if (!catalog || Object.keys(catalog).length === 0) throw new Error("Invalid models.dev catalog");
await Bun.write(
  new URL("../packages/utils/model-catalog-snapshot.json.txt", import.meta.url),
  `${JSON.stringify(catalog, null, 1)}\n`,
);
