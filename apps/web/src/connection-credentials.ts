type CredentialSource = (request: { fresh: boolean }) => Promise<string | null>;

let source: CredentialSource | undefined;
let required: () => Promise<boolean> = async () => false;
let waiting: ((source: CredentialSource | undefined) => void) | undefined;

// A cached page connects before the provider SDK loads, so its first attempt carries only the
// session cookie. When the server rejects it, the fresh retry waits for the provider instead of
// signing out. The first attempt does not wait because auth settings can stall on a dead connection.
export function requireConnectionCredentials(value: () => Promise<boolean>): void {
  required = value;
}

export function registerConnectionCredentials(operation: CredentialSource): () => void {
  source = operation;
  waiting?.(operation);
  waiting = undefined;
  return () => {
    if (source === operation) source = undefined;
  };
}

async function credentialSource(fresh: boolean): Promise<CredentialSource | undefined> {
  if (!fresh || source) return source;
  if (!(await required()) || source) return source;
  // A slow provider outlasts the connection deadline, and only the latest attempt is still live.
  waiting?.(undefined);
  return new Promise((resolve) => {
    waiting = resolve;
  });
}

export async function prepareWebConnection(request = { fresh: false }): Promise<void> {
  const operation = await credentialSource(request.fresh);
  await operation?.(request);
}

export async function readConnectionToken(): Promise<string | null | undefined> {
  return (await credentialSource(false))?.({ fresh: false });
}
