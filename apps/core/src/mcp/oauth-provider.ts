import { captureError } from "../shared/error-capture.js";
import { randomBytes } from "node:crypto";

import {
  auth,
  UnauthorizedError,
  type OAuthAuthorizationServerInformation,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from "@ai-sdk/mcp";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import {
  readMcpOAuthCredentialFile,
  updateMcpOAuthCredentialFile,
  type McpOAuthClientInformation,
  type McpOAuthCredential,
} from "./credential-file";
import {
  type McpAuthorizationCodeAuth,
  type McpServerDefinition,
  type McpValueSource,
  type UniversalMcpConfig,
} from "./config-types";
import { rethrowPanic, safeMcpErrorText } from "./error-format";
import { resolveMcpValueSource, type McpValueResolutionContext } from "./value-source";

export const MCP_OAUTH_CALLBACK_URL = "http://localhost:1456/mcp/oauth/callback";
export const MCP_OAUTH_NATIVE_CALLBACK_PATH = "/api/mcp/oauth/callback";

export function resolveMcpOAuthCallbackUrl(native: {
  readonly enabled: boolean;
  readonly publicUrl: string;
}): string {
  if (!native.enabled) return MCP_OAUTH_CALLBACK_URL;
  return new URL(MCP_OAUTH_NATIVE_CALLBACK_PATH, native.publicUrl).href;
}

const MAX_PENDING_AUTHORIZATIONS = 32;
const PENDING_AUTHORIZATION_TTL_MS = 15 * 60 * 1000;

type OAuthFetchFunction = NonNullable<Parameters<typeof auth>[1]["fetchFn"]>;

type PendingAuthorization = {
  readonly state: string;
  readonly createdAt: number;
  status: "starting" | "pending" | "completing";
  codeVerifier?: string;
  authorizationUrl?: string;
  /** Set when the stored dynamic client was registered for another callback URL. */
  replacingClient?: boolean;
  /** The replacement registration, saved with the tokens once the code exchange succeeds. */
  stagedClient?: OAuthClientInformation;
  stagedServerInformation?: OAuthAuthorizationServerInformation;
};

function bindClientInformationToAuthorizationServer(
  credential: McpOAuthCredential,
  authorizationServerInformation: OAuthAuthorizationServerInformation,
): McpOAuthCredential {
  const clientInformation = credential.clientInformation;
  if (!clientInformation) {
    return { ...credential, authorizationServerInformation };
  }

  return {
    ...credential,
    authorizationServerInformation,
    clientInformation: {
      ...clientInformation,
      issuer: authorizationServerInformation.issuer,
      authorization_server: authorizationServerInformation.authorizationServerUrl,
      token_endpoint: authorizationServerInformation.tokenEndpoint,
    },
  };
}

export type McpOAuthStartResult =
  | { readonly status: "authorized" }
  | {
      readonly status: "authorization_required";
      readonly authorizationUrl: string;
      readonly callbackUrl: string;
    };

export class McpOAuthProviderError extends TaggedError("McpOAuthProviderError")<{
  readonly serverId: string;
  readonly operation: "start" | "complete" | "credentials";
  readonly cause?: unknown;
  readonly message: string;
}> {
  constructor(options: {
    readonly serverId: string;
    readonly operation: "start" | "complete" | "credentials";
    readonly cause?: unknown;
  }) {
    let action: string;
    switch (options.operation) {
      case "start":
        action = "start MCP OAuth authorization";
        break;
      case "complete":
        action = "complete MCP OAuth authorization";
        break;
      case "credentials":
        action = "load MCP OAuth client credentials";
        break;
    }
    super({
      ...options,
      message: `Could not ${action} for server ${JSON.stringify(options.serverId)}${
        options.cause === undefined ? "" : `: ${safeMcpErrorText(options.cause)}`
      }`,
    });
  }
}

function oauthProviderError(
  serverId: string,
  operation: McpOAuthProviderError["operation"],
  cause?: unknown,
): McpOAuthProviderError {
  return new McpOAuthProviderError({ serverId, operation, cause });
}

async function captureOAuthAttempt<T>(options: {
  readonly serverId: string;
  readonly operation: "start" | "complete";
  readonly run: () => Promise<T>;
}): Promise<ResultType<T, McpOAuthProviderError>> {
  const captured = await Result.tryPromise({
    try: options.run,
    catch: captureError,
  });
  return captured.match<() => ResultType<T, McpOAuthProviderError>>({
    ok: (value) => () => Result.ok(value),
    err:
      ({ cause }) =>
      () => {
        rethrowPanic(cause);
        return Result.err(oauthProviderError(options.serverId, options.operation, cause));
      },
  })();
}

export class McpOAuthCredentialResolutionError extends TaggedError(
  "McpOAuthCredentialResolutionError",
)<{
  readonly serverId: string;
  readonly field: "client_id" | "client_secret";
  readonly cause: unknown;
  readonly message: string;
}> {}

export class McpOAuthProvider implements OAuthClientProvider {
  readonly serverId: string;
  readonly serverUrl: string;
  readonly redirectUrl: string;

  private readonly authConfig: McpAuthorizationCodeAuth;
  private readonly dataDir: string;
  private readonly valueContext: McpValueResolutionContext;
  private readonly fetchFn?: OAuthFetchFunction;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingAuthorization>();

  constructor(options: {
    readonly serverId: string;
    readonly serverUrl: string;
    readonly authConfig: McpAuthorizationCodeAuth;
    readonly dataDir: string;
    readonly valueContext: McpValueResolutionContext;
    readonly redirectUrl?: string;
    readonly fetchFn?: OAuthFetchFunction;
    readonly now?: () => number;
  }) {
    this.serverId = options.serverId;
    this.serverUrl = options.serverUrl;
    this.authConfig = options.authConfig;
    this.dataDir = options.dataDir;
    this.valueContext = options.valueContext;
    this.fetchFn = options.fetchFn;
    this.now = options.now ?? Date.now;
    this.redirectUrl = options.redirectUrl ?? MCP_OAUTH_CALLBACK_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "Lilac Core",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method:
        this.authConfig.client.type === "static" && this.authConfig.client.clientSecret
          ? "client_secret_post"
          : "none",
      ...(this.authConfig.scopes?.length ? { scope: this.authConfig.scopes.join(" ") } : {}),
    };
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.readCredential())?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.updateCredential((credential) => ({ ...credential, tokens }));
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): Promise<void> {
    if (scope === "verifier") return;
    await this.updateCredential((credential) => this.invalidateCredential(credential, scope));
  }

  redirectToAuthorization(_authorizationUrl: URL): void {
    this.rejectImplicitAuthorization();
  }

  saveCodeVerifier(_codeVerifier: string): void {
    this.rejectImplicitAuthorization();
  }

  codeVerifier(): string {
    return this.rejectImplicitAuthorization();
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const information = await this.clientInformationForSdkAttempt();
    if (this.authConfig.client.type === "dynamic" && information === undefined) {
      throw new UnauthorizedError("Interactive MCP authorization requires explicit mcp.auth");
    }
    return information;
  }

  async saveClientInformation(_clientInformation: OAuthClientInformation): Promise<void> {
    this.rejectImplicitAuthorization();
  }

  private async clientInformationForAuthorization(): Promise<
    ResultType<McpOAuthClientInformation | undefined, McpOAuthCredentialResolutionError>
  > {
    if (this.authConfig.client.type === "dynamic") {
      const information = (await this.readCredential())?.clientInformation;
      if (
        information?.client_secret_expires_at !== undefined &&
        information.client_secret_expires_at !== 0 &&
        information.client_secret_expires_at <= this.now() / 1000
      ) {
        return Result.ok(undefined);
      }
      return Result.ok(information);
    }

    const client = this.authConfig.client;
    const clientId = await this.resolveStaticCredential(client.clientId, "client_id");
    return clientId.match({
      err: (error) => async () => Result.err(error),
      ok: (resolvedClientId) => async () => {
        if (client.clientSecret === undefined) {
          return Result.ok({ client_id: resolvedClientId });
        }
        const clientSecret = await this.resolveStaticCredential(
          client.clientSecret,
          "client_secret",
        );
        return clientSecret.map((resolvedClientSecret) => ({
          client_id: resolvedClientId,
          client_secret: resolvedClientSecret,
        }));
      },
    })();
  }

  private async clientInformationForSdkAttempt(): Promise<McpOAuthClientInformation | undefined> {
    const result = await this.clientInformationForAuthorization();
    return result.match({
      ok: (value) => () => value,
      err: (error) => () => {
        throw oauthProviderError(this.serverId, "credentials", error);
      },
    })();
  }

  /**
   * The client for an authorization attempt. A dynamic client registered for another callback
   * URL would be rejected, so the attempt registers a replacement and hides the old client's
   * tokens. The stored client and tokens stay usable until the new sign-in completes.
   */
  private async attemptClientInformation(
    pending: PendingAuthorization,
  ): Promise<OAuthClientInformation | undefined> {
    if (pending.stagedClient) return pending.stagedClient;
    const information = await this.clientInformationForSdkAttempt();
    if (this.authConfig.client.type !== "dynamic" || !information) return information;
    // Registrations saved before redirect_uris was stored used the loopback callback.
    const registered = information.redirect_uris ?? [MCP_OAUTH_CALLBACK_URL];
    if (registered.includes(this.redirectUrl)) return information;
    pending.replacingClient = true;
    return undefined;
  }

  private async attemptTokens(pending: PendingAuthorization): Promise<OAuthTokens | undefined> {
    await this.attemptClientInformation(pending);
    return pending.replacingClient ? undefined : this.tokens();
  }

  private async resolveStaticCredential(
    source: McpValueSource,
    field: "client_id" | "client_secret",
  ): Promise<ResultType<string, McpOAuthCredentialResolutionError>> {
    const resolved = await resolveMcpValueSource(source, this.valueContext);
    return resolved.mapError(
      (error) =>
        new McpOAuthCredentialResolutionError({
          serverId: this.serverId,
          field,
          cause: error,
          message: `Could not resolve OAuth ${field === "client_id" ? "client ID" : "client secret"} for MCP server ${JSON.stringify(this.serverId)}`,
        }),
    );
  }

  async authorizationServerInformation(): Promise<OAuthAuthorizationServerInformation | undefined> {
    return (await this.readCredential())?.authorizationServerInformation;
  }

  async saveAuthorizationServerInformation(
    authorizationServerInformation: OAuthAuthorizationServerInformation,
  ): Promise<void> {
    await this.updateCredential((credential) =>
      bindClientInformationToAuthorizationServer(credential, authorizationServerInformation),
    );
  }

  state(): string {
    return this.rejectImplicitAuthorization();
  }

  saveState(_state: string): void {
    this.rejectImplicitAuthorization();
  }

  storedState(): string | undefined {
    return undefined;
  }

  hasPendingState(state: string): boolean {
    this.pruneExpiredPending();
    return this.pending.has(state);
  }

  discardPendingAuthorizations(): void {
    this.pending.clear();
  }

  async startAuthorizationResult(): Promise<
    ResultType<McpOAuthStartResult, McpOAuthProviderError>
  > {
    const pendingResult = this.createPendingAuthorization();
    if (pendingResult.isErr()) return Result.err(pendingResult.error);
    const pending = pendingResult.value;
    const authorized = await captureOAuthAttempt({
      serverId: this.serverId,
      operation: "start",
      run: () =>
        auth(this.providerForAttempt(pending), {
          serverUrl: this.serverUrl,
          ...(this.authConfig.scopes?.length ? { scope: this.authConfig.scopes.join(" ") } : {}),
          ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
        }),
    });
    if (authorized.isErr()) {
      this.deletePending(pending);
      return Result.err(authorized.error);
    }
    if (authorized.value === "AUTHORIZED") {
      this.deletePending(pending);
      return Result.ok<McpOAuthStartResult>({ status: "authorized" });
    }

    const authorizationUrl = pending.authorizationUrl;
    if (!authorizationUrl || !pending.codeVerifier || !this.isActive(pending)) {
      this.deletePending(pending);
      return Result.err(oauthProviderError(this.serverId, "start"));
    }
    this.awaitAuthorizationCallback(pending);
    return Result.ok<McpOAuthStartResult>({
      status: "authorization_required",
      authorizationUrl,
      callbackUrl: this.redirectUrl,
    });
  }

  async startAuthorization(): Promise<McpOAuthStartResult> {
    const started = await this.startAuthorizationResult();
    return started.match({
      ok: (value) => () => value,
      err: (error) => () => {
        throw error;
      },
    })();
  }

  async completeAuthorizationResult(
    authorizationCode: string,
    callbackState: string,
    callbackIssuer?: string,
  ): Promise<ResultType<void, McpOAuthProviderError>> {
    this.pruneExpiredPending();
    const pending = this.pending.get(callbackState);
    if (!pending || pending.status !== "pending" || authorizationCode.length === 0) {
      return Result.err(oauthProviderError(this.serverId, "complete"));
    }

    pending.status = "completing";
    const completed = await captureOAuthAttempt({
      serverId: this.serverId,
      operation: "complete",
      run: () =>
        auth(this.providerForAttempt(pending), {
          serverUrl: this.serverUrl,
          authorizationCode,
          callbackState,
          ...(callbackIssuer === undefined ? {} : { callbackIssuer }),
          ...(this.authConfig.scopes?.length ? { scope: this.authConfig.scopes.join(" ") } : {}),
          ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
        }),
    });
    return completed.match({
      err: (error) => () => {
        if (this.isActive(pending)) pending.status = "pending";
        return Result.err(error);
      },
      ok: (status) => () => {
        if (status !== "AUTHORIZED") {
          if (this.isActive(pending)) pending.status = "pending";
          return Result.err(oauthProviderError(this.serverId, "complete"));
        }
        this.deletePending(pending);
        return Result.ok();
      },
    })();
  }

  async completeAuthorization(
    authorizationCode: string,
    callbackState: string,
    callbackIssuer?: string,
  ): Promise<void> {
    const completed = await this.completeAuthorizationResult(
      authorizationCode,
      callbackState,
      callbackIssuer,
    );
    completed.match({
      ok: () => () => undefined,
      err: (error) => () => {
        throw error;
      },
    })();
  }

  private createPendingAuthorization(): ResultType<PendingAuthorization, McpOAuthProviderError> {
    this.pruneExpiredPending();
    if (this.pending.size >= MAX_PENDING_AUTHORIZATIONS) {
      for (const [state, pending] of this.pending) {
        if (pending.status !== "pending") continue;
        this.pending.delete(state);
        break;
      }
    }
    if (this.pending.size >= MAX_PENDING_AUTHORIZATIONS) {
      return Result.err(oauthProviderError(this.serverId, "start"));
    }

    let state: string;
    do {
      state = randomBytes(32).toString("hex");
    } while (this.pending.has(state));
    const pending: PendingAuthorization = { state, createdAt: this.now(), status: "starting" };
    this.pending.set(state, pending);
    return Result.ok(pending);
  }

  private providerForAttempt(pending: PendingAuthorization): OAuthClientProvider {
    const attemptProvider = {
      redirectUrl: this.redirectUrl,
      clientMetadata: this.clientMetadata,
      tokens: () => this.attemptTokens(pending),
      saveTokens: async (tokens: OAuthTokens) => {
        this.assertActive(pending, "complete");
        const staged = pending.stagedClient;
        const stagedServer = pending.stagedServerInformation;
        await this.updateCredentialForAttempt(pending, "complete", (credential) => ({
          ...credential,
          ...(staged ? { clientInformation: staged } : {}),
          ...(stagedServer ? { authorizationServerInformation: stagedServer } : {}),
          tokens,
        }));
      },
      invalidateCredentials: async (scope: "all" | "client" | "tokens" | "verifier") => {
        this.assertActive(pending, "complete");
        if (scope === "verifier") return;
        await this.updateCredentialForAttempt(pending, "complete", (credential) =>
          this.invalidateCredential(credential, scope),
        );
      },
      redirectToAuthorization: (authorizationUrl: URL) => {
        this.assertActive(pending, "start");
        if (
          pending.authorizationUrl !== undefined ||
          authorizationUrl.searchParams.get("state") !== pending.state
        ) {
          throw oauthProviderError(this.serverId, "start");
        }
        pending.authorizationUrl = authorizationUrl.href;
      },
      saveCodeVerifier: (codeVerifier: string) => {
        this.assertActive(pending, "start");
        pending.codeVerifier = codeVerifier;
      },
      codeVerifier: () => {
        this.assertActive(pending, "complete");
        if (!pending.codeVerifier) {
          throw oauthProviderError(this.serverId, "complete");
        }
        return pending.codeVerifier;
      },
      clientInformation: () => this.attemptClientInformation(pending),
      saveClientInformation: async (clientInformation: OAuthClientInformation) => {
        this.assertActive(pending, "start");
        if (pending.replacingClient) {
          pending.stagedClient = clientInformation;
          return;
        }
        await this.updateCredentialForAttempt(pending, "start", (credential) => ({
          ...credential,
          clientInformation,
        }));
      },
      authorizationServerInformation: async () =>
        pending.stagedServerInformation ?? (await this.authorizationServerInformation()),
      saveAuthorizationServerInformation: async (
        authorizationServerInformation: OAuthAuthorizationServerInformation,
      ) => {
        this.assertActive(pending, "start");
        if (pending.replacingClient) {
          pending.stagedServerInformation = authorizationServerInformation;
          return;
        }
        await this.updateCredentialForAttempt(pending, "start", (credential) =>
          bindClientInformationToAuthorizationServer(credential, authorizationServerInformation),
        );
      },
      state: () => pending.state,
      saveState: (state: string) => {
        this.assertActive(pending, "start");
        if (state !== pending.state) {
          throw oauthProviderError(this.serverId, "start");
        }
      },
      storedState: () => pending.state,
    };
    return attemptProvider;
  }

  private isActive(pending: PendingAuthorization): boolean {
    if (this.pending.get(pending.state) !== pending) return false;
    if (pending.createdAt + PENDING_AUTHORIZATION_TTL_MS > this.now()) return true;
    this.pending.delete(pending.state);
    return false;
  }

  private assertActive(pending: PendingAuthorization, operation: "start" | "complete"): void {
    if (!this.isActive(pending)) throw oauthProviderError(this.serverId, operation);
  }

  private awaitAuthorizationCallback(pending: PendingAuthorization): void {
    pending.authorizationUrl = undefined;
    pending.status = "pending";
  }

  private deletePending(pending: PendingAuthorization): void {
    if (this.isActive(pending)) this.pending.delete(pending.state);
  }

  private pruneExpiredPending(): void {
    const now = this.now();
    for (const [state, pending] of this.pending) {
      if (pending.createdAt + PENDING_AUTHORIZATION_TTL_MS <= now) this.pending.delete(state);
    }
  }

  private rejectImplicitAuthorization(): never {
    throw new UnauthorizedError("Interactive MCP authorization requires explicit mcp.auth");
  }

  private async readCredential(): Promise<McpOAuthCredential | undefined> {
    const credential = await readMcpOAuthCredentialFile({
      dataDir: this.dataDir,
      serverId: this.serverId,
    });
    return credential?.serverUrl === this.serverUrl ? credential : undefined;
  }

  private async updateCredential(
    update: (credential: McpOAuthCredential) => McpOAuthCredential,
  ): Promise<void> {
    await updateMcpOAuthCredentialFile({
      dataDir: this.dataDir,
      serverId: this.serverId,
      serverUrl: this.serverUrl,
      update,
    });
  }

  private async updateCredentialForAttempt(
    pending: PendingAuthorization,
    operation: "start" | "complete",
    update: (credential: McpOAuthCredential) => McpOAuthCredential,
  ): Promise<void> {
    await updateMcpOAuthCredentialFile({
      dataDir: this.dataDir,
      serverId: this.serverId,
      serverUrl: this.serverUrl,
      update: (credential) => {
        this.assertActive(pending, operation);
        return update(credential);
      },
    });
  }

  private invalidateCredential(
    credential: McpOAuthCredential,
    scope: "all" | "client" | "tokens",
  ): McpOAuthCredential {
    const { clientInformation, tokens, ...retained } = credential;
    if (scope === "tokens") {
      return clientInformation ? { ...retained, clientInformation } : retained;
    }
    if (scope === "client") return tokens ? { ...retained, tokens } : retained;
    return retained;
  }
}

type ProviderEntry = {
  readonly fingerprint: string;
  readonly provider: McpOAuthProvider;
};

export class McpOAuthProviderService {
  private readonly dataDir: string;
  private readonly valueContext: McpValueResolutionContext;
  private readonly redirectUrl: string;
  private readonly fetchFn?: OAuthFetchFunction;
  private readonly now: () => number;
  private readonly providers = new Map<string, ProviderEntry>();

  constructor(options: {
    readonly dataDir: string;
    readonly configBaseDir?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly redirectUrl?: string;
    readonly fetchFn?: OAuthFetchFunction;
    readonly now?: () => number;
  }) {
    this.dataDir = options.dataDir;
    this.redirectUrl = options.redirectUrl ?? MCP_OAUTH_CALLBACK_URL;
    this.valueContext = {
      baseDir: options.configBaseDir ?? options.dataDir,
      env: options.env ?? process.env,
    };
    this.fetchFn = options.fetchFn;
    this.now = options.now ?? Date.now;
  }

  reconcile(config: UniversalMcpConfig): void {
    const configured = new Set<string>();
    for (const definition of Object.values(config.servers)) {
      const oauth = authorizationCodeOAuthOptions(definition);
      if (!oauth) continue;
      configured.add(definition.id);
      const fingerprint = oauthFingerprint(oauth);
      const existing = this.providers.get(definition.id);
      if (existing?.fingerprint === fingerprint) continue;
      existing?.provider.discardPendingAuthorizations();

      this.providers.set(definition.id, {
        fingerprint,
        provider: new McpOAuthProvider({
          serverId: definition.id,
          serverUrl: oauth.serverUrl,
          authConfig: oauth.authConfig,
          dataDir: this.dataDir,
          valueContext: this.valueContext,
          redirectUrl: this.redirectUrl,
          ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
          now: this.now,
        }),
      });
    }

    for (const serverId of this.providers.keys()) {
      if (configured.has(serverId)) continue;
      this.providers.get(serverId)?.provider.discardPendingAuthorizations();
      this.providers.delete(serverId);
    }
  }

  getProvider(serverId: string): McpOAuthProvider | undefined {
    return this.providers.get(serverId)?.provider;
  }

  /**
   * The provider for exactly this server definition. A provider reconciled from another read of
   * the file may hold tokens for a different URL, so a mismatch returns none.
   */
  getProviderForDefinition(definition: McpServerDefinition): McpOAuthProvider | undefined {
    const oauth = authorizationCodeOAuthOptions(definition);
    const entry = this.providers.get(definition.id);
    if (!oauth || !entry || entry.fingerprint !== oauthFingerprint(oauth)) return undefined;
    return entry.provider;
  }

  getProviderForState(state: string): McpOAuthProvider | undefined {
    for (const entry of this.providers.values()) {
      if (entry.provider.hasPendingState(state)) return entry.provider;
    }
    return undefined;
  }

  async startAuthorization(serverId: string): Promise<McpOAuthStartResult> {
    const started = await this.startAuthorizationResult(serverId);
    return started.match({
      ok: (value) => () => value,
      err: (error) => () => {
        throw error;
      },
    })();
  }

  async startAuthorizationResult(
    serverId: string,
  ): Promise<ResultType<McpOAuthStartResult, McpOAuthProviderError>> {
    const provider = this.providers.get(serverId)?.provider;
    if (!provider) return Result.err(oauthProviderError(serverId, "start"));
    return await provider.startAuthorizationResult();
  }
}

function oauthFingerprint(oauth: {
  readonly serverUrl: string;
  readonly authConfig: McpAuthorizationCodeAuth;
}): string {
  return JSON.stringify([oauth.serverUrl, oauth.authConfig]);
}

function authorizationCodeOAuthOptions(definition: McpServerDefinition):
  | {
      readonly serverUrl: string;
      readonly authConfig: McpAuthorizationCodeAuth;
    }
  | undefined {
  const transport = definition.transportConfig;
  if (transport.transport !== "http" || transport.auth?.grant !== "authorization_code") {
    return undefined;
  }
  return { serverUrl: transport.url, authConfig: transport.auth };
}
