import { ModelCatalogCache } from "../../model-catalog-cache";
import type { ModelsDevRegistry } from "../../model-catalog-schema";

declare const self: Worker;

type OpenRequest = { type: "open"; cachePath: string; snapshot: ModelsDevRegistry };
type ReadRequest = { type: "read" };

let cache: ModelCatalogCache | undefined;

self.addEventListener("message", (event: MessageEvent<OpenRequest | ReadRequest>) => {
  if (event.data.type === "open") {
    const { cachePath, snapshot } = event.data;
    cache = new ModelCatalogCache({ cachePath, snapshot });
  }
  self.postMessage(cache?.current().providerIds());
});
self.postMessage("ready");
