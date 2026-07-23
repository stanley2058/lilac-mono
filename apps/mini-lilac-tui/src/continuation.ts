import { DEFAULT_SERVER_URL } from "./cli";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function continuationCommand(server: string, sessionId: string): string {
  const serverOption = server === DEFAULT_SERVER_URL ? "" : ` --server ${shellQuote(server)}`;
  return `mini-lilac${serverOption} --session ${shellQuote(sessionId)}`;
}
