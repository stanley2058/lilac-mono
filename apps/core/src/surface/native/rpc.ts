import { implement, ORPCError } from "@orpc/server";
import {
  nativeContract,
  type NativeRpcInputs,
  type NativeRpcOutputs,
  type NativeUser,
  type NativeErrorCode,
} from "@stanley2058/lilac-client-protocol";
import type { Result } from "better-result";
import type { NativeAuthenticator, NativePrincipal } from "./auth";

export type NativeServiceError = Error & { code?: string; currentRevision?: string | number };
type ServiceOutput<T> =
  T extends AsyncIterable<infer Event> ? AsyncGenerator<Event, void, void> : T;
type Awaitable<T> = T | Promise<T>;
export type NativeRpcServices = {
  [Group in Exclude<keyof NativeRpcInputs, "connection">]: {
    [Method in keyof NativeRpcInputs[Group]]: (
      principal: NativePrincipal,
      input: NativeRpcInputs[Group][Method],
      signal?: AbortSignal,
    ) => Awaitable<
      Result<
        ServiceOutput<
          Method extends keyof NativeRpcOutputs[Group] ? NativeRpcOutputs[Group][Method] : never
        >,
        NativeServiceError
      >
    >;
  };
};
export type NativeRpcContext = {
  principal: NativePrincipal;
  request: Request;
  auth: NativeAuthenticator;
  refreshed: () => void;
  loggedOut: () => void;
};

function nativeErrorCode(error: NativeServiceError): NativeErrorCode {
  switch (error.code) {
    case "unauthorized":
    case "expired":
      return "UNAUTHENTICATED";
    case "forbidden":
      return "FORBIDDEN";
    case "not-found":
      return "NOT_FOUND";
    case "conflict":
    case "stale":
      return "CONFLICT";
    case "invalid":
    case "handshake":
      return "INVALID_INPUT";
    default:
      return "NOT_READY";
  }
}

export function nativeRpcFailure(error: NativeServiceError): never {
  const code = nativeErrorCode(error);
  const message =
    code === "NOT_READY" ? "Native service is unavailable" : error.message.slice(0, 4096);
  throw new ORPCError(code, {
    message,
    data: {
      message,
      ...(error.currentRevision !== undefined ? { currentRevision: error.currentRevision } : {}),
    },
  });
}

export function nativeRpcValue<T>(result: Result<T, NativeServiceError>): T {
  const settle = result.match({
    ok: (value) => () => value,
    err: (error) => () => nativeRpcFailure(error),
  });
  return settle();
}

export function createNativeRouter(
  services: NativeRpcServices,
  getViewer: (userId: string) => Result<NativeUser, NativeServiceError>,
) {
  const api = implement(nativeContract).$context<NativeRpcContext>();
  const secured = api.use(({ context, next }) => {
    nativeRpcValue(context.auth.checkSession(context.principal));
    return next();
  });
  return api.router({
    references: {
      range: secured.references.range.handler(async ({ input, context }) =>
        nativeRpcValue(await services.references.range(context.principal, input)),
      ),
      resolve: secured.references.resolve.handler(async ({ input, context }) =>
        nativeRpcValue(await services.references.resolve(context.principal, input)),
      ),
      read: secured.references.read.handler(async ({ input, context }) =>
        nativeRpcValue(await services.references.read(context.principal, input)),
      ),
    },
    links: {
      preview: secured.links.preview.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.links.preview(context.principal, input, signal)),
      ),
    },
    connection: {
      reauthenticate: api.connection.reauthenticate.handler(async ({ input, context }) => {
        const headers = new Headers(context.request.headers);
        headers.set("authorization", `Bearer ${input.token}`);
        const request = new Request(context.request.url, { headers });
        const principal = nativeRpcValue(
          await context.auth.reauthenticate(context.principal, request),
        );
        Object.assign(context.principal, principal);
        context.request = request;
        context.refreshed();
        return nativeRpcValue(getViewer(principal.userId));
      }),
      logout: secured.connection.logout.handler(async ({ context }) => {
        nativeRpcValue(await context.auth.logout(context.request));
        context.loggedOut();
        return { ok: true };
      }),
    },
    bootstrap: {
      get: secured.bootstrap.get.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.bootstrap.get(context.principal, input, signal)),
      ),
      watch: secured.bootstrap.watch.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.bootstrap.watch(context.principal, input, signal)),
      ),
    },
    sidebar: {
      preferences: secured.sidebar.preferences.handler(async ({ context, input, signal }) =>
        nativeRpcValue(await services.sidebar.preferences(context.principal, input, signal)),
      ),
      configure: secured.sidebar.configure.handler(async ({ context, input, signal }) =>
        nativeRpcValue(await services.sidebar.configure(context.principal, input, signal)),
      ),
      list: secured.sidebar.list.handler(async ({ context, input, signal }) =>
        nativeRpcValue(await services.sidebar.list(context.principal, input, signal)),
      ),
      move: secured.sidebar.move.handler(async ({ context, input, signal }) =>
        nativeRpcValue(await services.sidebar.move(context.principal, input, signal)),
      ),
    },
    threads: {
      get: secured.threads.get.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.threads.get(context.principal, input, signal)),
      ),
      list: secured.threads.list.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.threads.list(context.principal, input, signal)),
      ),
      create: secured.threads.create.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.threads.create(context.principal, input, signal)),
      ),
      update: secured.threads.update.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.threads.update(context.principal, input, signal)),
      ),
      delete: secured.threads.delete.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.threads.delete(context.principal, input, signal)),
      ),
      sync: secured.threads.sync.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.threads.sync(context.principal, input, signal)),
      ),
      watch: secured.threads.watch.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.threads.watch(context.principal, input, signal)),
      ),
      hydrate: secured.threads.hydrate.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.threads.hydrate(context.principal, input, signal)),
      ),
      turnPage: secured.threads.turnPage.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.threads.turnPage(context.principal, input, signal)),
      ),
      rewind: secured.threads.rewind.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.threads.rewind(context.principal, input, signal)),
      ),
      markRead: secured.threads.markRead.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.threads.markRead(context.principal, input, signal)),
      ),
    },
    participants: {
      list: secured.participants.list.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.participants.list(context.principal, input, signal)),
      ),
      set: secured.participants.set.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.participants.set(context.principal, input, signal)),
      ),
      remove: secured.participants.remove.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.participants.remove(context.principal, input, signal)),
      ),
    },
    profile: {
      get: secured.profile.get.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.profile.get(context.principal, input, signal)),
      ),
      update: secured.profile.update.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.profile.update(context.principal, input, signal)),
      ),
    },
    identity: {
      update: secured.identity.update.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.identity.update(context.principal, input, signal)),
      ),
    },
    users: {
      list: secured.users.list.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.users.list(context.principal, input, signal)),
      ),
      add: secured.users.add.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.users.add(context.principal, input, signal)),
      ),
      setToolMode: secured.users.setToolMode.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.users.setToolMode(context.principal, input, signal)),
      ),
    },
    inputs: {
      submit: secured.inputs.submit.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.inputs.submit(context.principal, input, signal)),
      ),
    },
    runs: {
      cancel: secured.runs.cancel.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.runs.cancel(context.principal, input, signal)),
      ),
      queue: secured.runs.queue.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.runs.queue(context.principal, input, signal)),
      ),
      removeQueued: secured.runs.removeQueued.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.runs.removeQueued(context.principal, input, signal)),
      ),
    },
    catalogs: {
      get: secured.catalogs.get.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.catalogs.get(context.principal, input, signal)),
      ),
    },
    files: {
      resolve: secured.files.resolve.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.files.resolve(context.principal, input, signal)),
      ),
    },
    resources: {
      reserve: secured.resources.reserve.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.resources.reserve(context.principal, input, signal)),
      ),
      get: secured.resources.get.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.resources.get(context.principal, input, signal)),
      ),
    },
    config: {
      readDeployment: secured.config.readDeployment.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.config.readDeployment(context.principal, input, signal)),
      ),
      setDeployment: secured.config.setDeployment.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.config.setDeployment(context.principal, input, signal)),
      ),
      read: secured.config.read.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.config.read(context.principal, input, signal)),
      ),
      save: secured.config.save.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.config.save(context.principal, input, signal)),
      ),
      reloadMcp: secured.config.reloadMcp.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.config.reloadMcp(context.principal, input, signal)),
      ),
    },
    search: {
      query: secured.search.query.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.search.query(context.principal, input, signal)),
      ),
    },
    subagents: {
      list: secured.subagents.list.handler(async ({ context, input }) =>
        nativeRpcValue(await services.subagents.list(context.principal, input)),
      ),
      read: secured.subagents.read.handler(async ({ context, input }) =>
        nativeRpcValue(await services.subagents.read(context.principal, input)),
      ),
    },
    external: {
      list: secured.external.list.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.external.list(context.principal, input, signal)),
      ),
      read: secured.external.read.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.external.read(context.principal, input, signal)),
      ),
    },
    actions: {
      invoke: secured.actions.invoke.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.actions.invoke(context.principal, input, signal)),
      ),
    },
    reactions: {
      set: secured.reactions.set.handler(async ({ input, context, signal }) =>
        nativeRpcValue(await services.reactions.set(context.principal, input, signal)),
      ),
    },
  });
}
