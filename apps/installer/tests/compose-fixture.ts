import path from "node:path";
import { parseDocument, type Document } from "yaml";
import type { ExistingDeployment, ResolvedDeployment } from "../src/compose-inspection";

type ResolvedService = ResolvedDeployment["services"]["lilac"];
type ServiceFixture = {
  image?: string;
  build?: string | { context?: string };
  environment?: Record<string, string | number | boolean | null> | string[];
  networks?: string[] | Record<string, object | null>;
  network_mode?: string;
  volumes?: (string | ResolvedService["volumes"][number])[];
  tmpfs?: string | string[];
  volumes_from?: string[];
  user?: string | number;
};

function resolveVolume(
  volume: NonNullable<ServiceFixture["volumes"]>[number],
): ResolvedService["volumes"][number] {
  if (typeof volume !== "string") return volume;
  const [source = "", target, mode] = volume.split(":");
  if (target === undefined) return { type: "volume", target: source };
  const type = source.startsWith(".") || source.startsWith("/") ? "bind" : "volume";
  return {
    type,
    source: type === "bind" ? path.resolve("/example/instance", source) : source,
    target,
    read_only: mode?.split(",").includes("ro") ?? false,
  };
}

function resolveService(service: ServiceFixture): ResolvedService {
  const environment: ResolvedService["environment"] = {};
  if (Array.isArray(service.environment)) {
    for (const entry of service.environment) {
      const separator = entry.indexOf("=");
      const name = separator === -1 ? entry : entry.slice(0, separator);
      environment[name] = separator === -1 ? null : entry.slice(separator + 1);
    }
  } else {
    for (const [name, value] of Object.entries(service.environment ?? {})) {
      environment[name] = value === null ? null : String(value);
    }
  }
  const networkNames = Array.isArray(service.networks)
    ? service.networks
    : Object.keys(service.networks ?? {});
  if (!networkNames.length && service.network_mode === undefined) networkNames.push("default");
  return {
    image: service.image,
    build: typeof service.build === "string" ? { context: service.build } : service.build,
    environment,
    networks: Object.fromEntries(networkNames.map((name) => [name, {}])),
    network_mode: service.network_mode,
    volumes: (service.volumes ?? []).map(resolveVolume),
    tmpfs: typeof service.tmpfs === "string" ? [service.tmpfs] : (service.tmpfs ?? []),
    volumes_from: service.volumes_from ?? [],
    user: service.user === undefined ? undefined : String(service.user),
  };
}

export function existingDeploymentFixture(document: Document): ExistingDeployment {
  const source: { services: { lilac: ServiceFixture; "computer-use-gateway"?: ServiceFixture } } =
    parseDocument(document.toString(), { merge: true }).toJS();
  const services: ResolvedDeployment["services"] = { lilac: resolveService(source.services.lilac) };
  if (source.services["computer-use-gateway"]) {
    services["computer-use-gateway"] = resolveService(source.services["computer-use-gateway"]);
  }
  return { document, resolved: { services } };
}
