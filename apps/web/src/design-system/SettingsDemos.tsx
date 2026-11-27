import { CodeEditor } from "../components/CodeEditor";
import { WorkspaceTreeView } from "../components/WorkspaceTree";
import { KeybindingsSettings } from "../components/KeybindingsSettings";
import { createKeybindings } from "../keybindings";
import { NotificationSettings } from "../components/NotificationSettings";
import { createNotificationPreferences, sendTestNotification } from "../notifications";
import { useLocation } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ConfigDraftContext, createConfigDraftStore } from "../config-ui/draft-store";
import { coreManifest } from "../config-ui/core-manifest";
import { ConfigPage } from "../components/config/ConfigPage";
import { ConfigScopeContext } from "../components/config/use-config-field";
import { Bell } from "lucide-react";
import type { NativeDeploymentSettings } from "@stanley2058/lilac-client-protocol";
import { toast } from "../components/ui/toast";
import { Button } from "../components/ui/button";
import { DeploymentSettingsForm } from "../components/DeploymentSettings";
import { Result } from "better-result";
import {
  McpServerSetupDialog,
  type McpServerState,
  type McpSetupApi,
} from "../components/config/McpServerSetup";

export function KeybindingsDemo() {
  const [store] = useState(() => createKeybindings());
  return <KeybindingsSettings store={store} />;
}

export function DeploymentSettingsDemo() {
  const [settings, setSettings] = useState<NativeDeploymentSettings>({
    transport: "auto",
    titleModel: "fast",
    outputStreaming: "complete",
    dmContextGapMs: 7_200_000,
    dmTimestampGapMs: 1_800_000,
    oldMessageSelectionMaxAgeMs: null,
    storageRetentionMaxAgeMs: null,
    crossThreadSend: { triggerRun: true },
  });
  return <DeploymentSettingsForm value={settings} onChange={setSettings} />;
}

export function NotificationSettingsDemo() {
  const threadId = useLocation({ select: (location) => location.state.chatThreadId });
  const [sending, setSending] = useState(false);
  async function testNotification() {
    setSending(true);
    const result = await sendTestNotification(threadId);
    result.match({
      ok: () => toast.add({ title: "Test notification sent", type: "success" }),
      err: (message) => toast.add({ title: message, type: "error" }),
    });
    setSending(false);
  }
  const [preferences] = useState(() =>
    createNotificationPreferences({ installationId: "design-system", principalId: "preview" }),
  );
  return (
    <div className="max-w-xl">
      <NotificationSettings preferences={preferences} preview />
      <Button variant="outline" disabled={sending} onClick={() => void testNotification()}>
        <Bell /> Test notification
      </Button>
    </div>
  );
}

export const editorDemoPaths = ["src/app.ts", "src/settings.yaml", "README.md"];
export function WorkspaceEditorDemo() {
  const [text, setText] = useState(
    '# YAML editor\nname: "Lilac"\nproviders: [firecrawl, exa]\nenabled: true\nretries: 3\nqueueTtl: 3s\n',
  );
  const [selected, setSelected] = useState("src/settings.yaml");
  return (
    <div className="flex flex-col h-96 min-h-0 bg-background text-foreground">
      <div className="flex h-40 min-h-0">
        <WorkspaceTreeView paths={editorDemoPaths} onOpen={setSelected} />
      </div>
      <div className="px-3 py-1 text-xs text-muted-foreground">{selected}</div>
      <CodeEditor value={text} onChange={setText} language="yaml" label="Example YAML editor" />
    </div>
  );
}

const CONFIG_DEMO_SECTIONS: Record<string, readonly string[]> = {
  models: ["Catalog", "Rules"],
  discord: ["Replies", "Tables and math", "Aliases"],
  runs: ["Transcripts"],
  subagents: ["Permission profiles"],
};

const CONFIG_DEMO_TEXT = [
  "configVersion: 3",
  "models:",
  "  catalog:",
  "    providers: { openai: enabled }",
  "  rules:",
  '    - match: "openai/gpt-5*"',
  "      reasoning: medium",
  "      options: { response_commentary: true }",
  "surface:",
  "  discord:",
  "    outputMode: preview",
  "    markdownTableRender: { style: image }",
  "entity:",
  "  users:",
  '    alice: { discord: "123456789012345678", comment: Maintainer }',
  "agent:",
  "  transcriptRetention:",
  "    maxAge: 90d",
  "",
].join("\n");

/** The Core settings form on demo values, without a Core connection to save to. */
export function ConfigFormDemo() {
  const [store] = useState(() => {
    const drafts = createConfigDraftStore();
    drafts.getState().load({ kind: "core", revision: "demo", text: CONFIG_DEMO_TEXT });
    return drafts;
  });
  const page = useMemo(
    () => ({
      id: "demo",
      title: "Demo",
      sections: coreManifest.pages.flatMap((candidate) =>
        candidate.sections.filter((section) =>
          CONFIG_DEMO_SECTIONS[candidate.id]?.includes(section.title),
        ),
      ),
    }),
    [],
  );
  return (
    <ConfigDraftContext value={store}>
      <ConfigScopeContext value={CONFIG_DEMO_SCOPE}>
        <div className="max-w-3xl">
          <ConfigPage page={page} yamlPage="yaml" />
        </div>
      </ConfigScopeContext>
    </ConfigDraftContext>
  );
}

const CONFIG_DEMO_SCOPE = { kind: "core", base: [], disabled: false } as const;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Simulated Core: hosts containing "fail" do not connect; OAuth completes 3s after sign-in opens. */
function demoMcpApi(): McpSetupApi {
  const servers = new Map<string, { url?: string; oauth: boolean; signedInAt?: number }>([
    ["linear", { url: "https://mcp.linear.app/mcp", oauth: true }],
  ]);
  const state = (id: string): McpServerState => {
    const server = servers.get(id);
    if (!server) return { state: "missing" };
    if (server.url?.includes("fail"))
      return { state: "unavailable", error: "fetch failed: ECONNREFUSED" };
    if (server.oauth && (!server.signedInAt || Date.now() < server.signedInAt))
      return { state: "authentication_required" };
    return { state: "available", toolCount: server.url ? 7 : 3 };
  };
  return {
    callbackUrl: "https://lilac.example/api/mcp/oauth/callback",
    async save(id, server) {
      await pause(400);
      servers.set(id, {
        ...(typeof server.url === "string" ? { url: server.url } : {}),
        oauth: server.auth !== undefined,
      });
      return Result.ok();
    },
    async connect(id) {
      await pause(700);
      return Result.ok(state(id));
    },
    async status(id) {
      return Result.ok(state(id));
    },
    async authorize(id) {
      await pause(300);
      const server = servers.get(id);
      if (server) server.signedInAt = Date.now() + 3_000;
      return Result.ok({
        status: "authorization_required",
        authorizationUrl: "https://example.com/",
      });
    },
  };
}

const ADD_MODE = { kind: "add", takenIds: ["github", "linear"] } as const;
const SIGN_IN_MODE = { kind: "signIn", serverId: "linear" } as const;

export function McpServerSetupDemo() {
  const [open, setOpen] = useState<"add" | "signIn">();
  const [api] = useState(demoMcpApi);
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => setOpen("add")}>
        Add MCP server
      </Button>
      <Button variant="outline" onClick={() => setOpen("signIn")}>
        Sign in to linear
      </Button>
      {open ? (
        <McpServerSetupDialog
          open
          onOpenChange={(next) => {
            if (!next) setOpen(undefined);
          }}
          mode={open === "add" ? ADD_MODE : SIGN_IN_MODE}
          api={api}
        />
      ) : null}
    </div>
  );
}
