import type { ConfigValue } from "@stanley2058/lilac-utils/config-document";

/** Where a secret comes from: typed into the config file, an environment variable, or a file. */
export type SecretSource = "text" | "env" | "file";

export type SecretDraft = { readonly source: SecretSource; readonly value: string };

export type EnvDraft = SecretDraft & { readonly key: string; readonly name: string };

export type McpServerDraft = {
  readonly id: string;
  readonly transport: "http" | "stdio";
  readonly url: string;
  /** The full command line, such as `npx -y @modelcontextprotocol/server-github`. */
  readonly command: string;
  readonly access: "none" | "token" | "oauth";
  readonly header: string;
  readonly prefix: string;
  readonly token: SecretDraft;
  readonly client: "dynamic" | "static";
  readonly clientId: SecretDraft;
  readonly clientSecret: SecretDraft;
  readonly scopes: string;
  readonly env: readonly EnvDraft[];
};

export const EMPTY_MCP_SERVER_DRAFT: McpServerDraft = {
  id: "",
  transport: "http",
  url: "",
  command: "",
  access: "none",
  header: "Authorization",
  prefix: "Bearer ",
  token: { source: "text", value: "" },
  client: "dynamic",
  clientId: { source: "text", value: "" },
  clientSecret: { source: "text", value: "" },
  scopes: "",
  env: [],
};

const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export type McpDraftErrors = Partial<Record<string, string>>;

/** Splits a command line into words, honoring quotes and backslash escapes. */
export function splitCommandLine(line: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }
    if (char === "\\" && index + 1 < line.length) {
      index += 1;
      word += line[index];
      started = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else word += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    }
    word += char;
    started = true;
  }
  if (quote) return undefined;
  if (started) words.push(word);
  return words;
}

function secretProblem(secret: SecretDraft, label: string): string | undefined {
  const value = secret.value.trim();
  if (!value) return `Enter the ${label}`;
  if (secret.source === "env" && !ENV_NAME.test(value))
    return "Use a variable name such as API_TOKEN";
  return undefined;
}

function present(errors: Record<string, string | undefined>): McpDraftErrors {
  return Object.fromEntries(Object.entries(errors).filter(([, error]) => error !== undefined));
}

function idError(id: string, takenIds: readonly string[]): string | undefined {
  if (!id) return "Enter a name";
  if (!SERVER_ID.test(id) || id.length > 64)
    return "Use letters, digits, - or _, starting with a letter or digit";
  if (takenIds.includes(id)) return "That name is taken";
  return undefined;
}

function urlError(url: string): string | undefined {
  if (!url) return "Enter the server URL";
  if (!URL.canParse(url) || !/^https?:$/u.test(new URL(url).protocol))
    return "Enter an http:// or https:// URL";
  return undefined;
}

function commandError(command: string): string | undefined {
  const words = splitCommandLine(command);
  if (!words) return "Close the quote";
  if (words.length === 0) return "Enter the command that starts the server";
  return undefined;
}

/** Problems with the server name and connection, keyed by field. */
export function connectionErrors(
  draft: McpServerDraft,
  takenIds: readonly string[],
): McpDraftErrors {
  const id = idError(draft.id.trim(), takenIds);
  if (draft.transport === "http") return present({ id, url: urlError(draft.url.trim()) });
  return present({ id, command: commandError(draft.command) });
}

function envErrors(env: readonly EnvDraft[]): McpDraftErrors {
  const errors: Record<string, string | undefined> = {};
  const names = new Set<string>();
  for (const variable of env) {
    const name = variable.name.trim();
    if (!ENV_NAME.test(name)) errors[`env.${variable.key}.name`] = "Use a name such as API_TOKEN";
    else if (names.has(name)) errors[`env.${variable.key}.name`] = "Already set";
    names.add(name);
    errors[`env.${variable.key}.value`] = secretProblem(variable, "value");
  }
  return present(errors);
}

function tokenErrors(draft: McpServerDraft): McpDraftErrors {
  const header = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(draft.header.trim())
    ? undefined
    : "Enter a header name";
  return present({ header, token: secretProblem(draft.token, "token") });
}

function staticClientErrors(draft: McpServerDraft): McpDraftErrors {
  const secret = draft.clientSecret.value.trim()
    ? secretProblem(draft.clientSecret, "client secret")
    : undefined;
  return present({
    clientId: secretProblem(draft.clientId, "client ID"),
    clientSecret: secret,
  });
}

/** Problems with the credentials, keyed by field. */
export function accessErrors(draft: McpServerDraft): McpDraftErrors {
  if (draft.transport === "stdio") return envErrors(draft.env);
  if (draft.access === "token") return tokenErrors(draft);
  if (draft.access === "oauth" && draft.client === "static") return staticClientErrors(draft);
  return {};
}

function secretValue(secret: SecretDraft, prefix = ""): ConfigValue {
  const value = secret.value.trim();
  if (secret.source === "text") return `${prefix}${value}`;
  const source: Record<string, ConfigValue> =
    secret.source === "env" ? { env: value } : { file: value };
  if (prefix) source.prefix = prefix;
  return source;
}

/** The `servers.<id>` entry the draft describes. */
export function mcpServerConfig(draft: McpServerDraft): Record<string, ConfigValue> {
  if (draft.transport === "stdio") {
    const [command = "", ...args] = splitCommandLine(draft.command) ?? [];
    const server: Record<string, ConfigValue> = { transport: "stdio", command };
    if (args.length > 0) server.args = args;
    if (draft.env.length > 0)
      server.env = Object.fromEntries(
        draft.env.map((variable) => [variable.name.trim(), secretValue(variable)]),
      );
    return server;
  }
  const server: Record<string, ConfigValue> = { transport: "http", url: draft.url.trim() };
  if (draft.access === "token")
    server.headers = { [draft.header.trim()]: secretValue(draft.token, draft.prefix) };
  if (draft.access === "oauth") {
    const scopes = draft.scopes.split(/[\s,]+/u).filter(Boolean);
    const client: Record<string, ConfigValue> =
      draft.client === "dynamic"
        ? { type: "dynamic" }
        : { type: "static", clientId: secretValue(draft.clientId) };
    if (draft.client === "static" && draft.clientSecret.value.trim())
      client.clientSecret = secretValue(draft.clientSecret);
    server.auth = {
      type: "oauth",
      grant: "authorization_code",
      ...(scopes.length > 0 ? { scopes } : {}),
      client,
    };
  }
  return server;
}
