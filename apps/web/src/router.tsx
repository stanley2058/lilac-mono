import { z } from "zod";
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Link,
  redirect,
  type RouterHistory,
  type RouteComponent,
} from "@tanstack/react-router";

const workspaceSearchSchema = z.object({
  ref: z.string().min(1).max(1024).optional(),
  message: z.string().min(1).max(128).optional(),
  range: z.string().min(1).max(258).optional(),
  view: z.enum(["archived", "others"]).optional(),
  otherThread: z.string().min(1).optional(),
  settings: z
    .enum(["account", "options", "keybindings", "deployment", "core", "mcp", "agent", "users"])
    .optional(),
});
export type WorkspaceSearch = z.infer<typeof workspaceSearchSchema>;
export type SettingsTab = NonNullable<WorkspaceSearch["settings"]>;

function decodeWorkspaceSearch(search: Record<string, unknown>): WorkspaceSearch {
  const parsed = workspaceSearchSchema.safeParse(search);
  return parsed.success
    ? parsed.data
    : { view: undefined, otherThread: undefined, settings: undefined };
}

export function createAppRouter(options: {
  shellComponent: RouteComponent;
  onChatEnter: () => void;
  history?: RouterHistory;
}) {
  const rootRoute = createRootRoute({
    component: options.shellComponent,
    notFoundComponent: () => (
      <main className="login-shell w-[min(100%_-_calc(var(--ui-space-unit)*8),_24rem)] min-h-dvh mx-auto flex flex-col justify-center gap-6 py-12">
        <h1>Page not found</h1>
        <Link to="/">Back to chat</Link>
      </main>
    ),
  });
  const chatRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "chat",
    validateSearch: decodeWorkspaceSearch,
    beforeLoad: options.onChatEnter,
  });
  const indexRoute = createRoute({
    getParentRoute: () => chatRoute,
    path: "/",
    beforeLoad: ({ location }) => {
      const threadId = new URLSearchParams(location.searchStr).get("thread");
      if (threadId)
        return redirect({
          to: "/threads/$threadId",
          params: { threadId },
          search: decodeWorkspaceSearch(
            Object.fromEntries(new URLSearchParams(location.searchStr)),
          ),
          hash: location.hash,
          replace: true,
        });
    },
  });
  const threadRoute = createRoute({
    getParentRoute: () => chatRoute,
    path: "/threads/$threadId",
  });
  const designSystemRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/design-system",
    component: lazyRouteComponent(() => import("./DesignSystem")),
  });
  return createRouter({
    routeTree: rootRoute.addChildren([
      chatRoute.addChildren([indexRoute, threadRoute]),
      designSystemRoute,
    ]),
    history: options.history,
    defaultPreload: "intent",
    scrollRestoration: false,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
  interface HistoryState {
    draftThreadId?: string;
    chatThreadId?: string;
  }
}
