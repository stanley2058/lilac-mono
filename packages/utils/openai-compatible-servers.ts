import type { OpenAICompatibleServerConfig } from "./core-config/types";

export type OpenAICompatibleServers = Readonly<Record<string, OpenAICompatibleServerConfig>>;

let activeOpenAICompatibleServers: OpenAICompatibleServers = {};

/** Sets the servers used when a caller passes no config snapshot. */
export function configureOpenAICompatibleServers(servers: OpenAICompatibleServers): void {
  activeOpenAICompatibleServers = servers;
}

export function getActiveOpenAICompatibleServers(): OpenAICompatibleServers {
  return activeOpenAICompatibleServers;
}
