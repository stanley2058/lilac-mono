import { KeybindingsSettings } from "./KeybindingsSettings";
import { NotificationSettings } from "./NotificationSettings";
import type { SettingsTab } from "../router";
import { useWorkspace } from "../workspace-context";
import { useStore } from "zustand";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { configOptions, userOptions, useNativeOnline } from "../queries";
import { DeploymentSettings } from "./DeploymentSettings";
import { SidebarPreferences } from "./SidebarPreferences";
import { AccountProfile } from "./AccountProfile";
import { AgentIdentity } from "./AgentIdentity";
import { AppearanceSettings } from "./AppearanceSettings";
import type { ActorIdentity } from "./ActorAvatar";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RefreshCw, Save, UserPlus } from "lucide-react";
import type { NativeRpcOutputs, NativeUser } from "@stanley2058/lilac-client-protocol";
import { attempt, ErrorNotice, IconButton, VirtualList } from "./ui";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import "./settings.css";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { CodeEditor } from "./CodeEditor";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

import {
  completeConfigSave,
  editConfig,
  type ConfigEditors,
  type ConfigKind,
} from "../config-editor";
function subscribeToSettingsWidth(onChange: () => void) {
  const media = window.matchMedia("(max-width: 40rem)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
const isNarrowSettings = () => window.matchMedia("(max-width: 40rem)").matches;

export function Settings({
  onClose,
  tab,
  onTabChange,
  theme,
  onTheme,
  agent,
  viewer,
}: {
  viewer: NativeUser;
  onClose: () => void;
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  theme: string;
  agent: ActorIdentity & { discordUserId?: string };
  onTheme: (value: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const narrow = useSyncExternalStore(subscribeToSettingsWidth, isNarrowSettings);
  const { client, preferences, keybindings, notifications, accountProfile } = useWorkspace();
  const animation = useStore(preferences, (state) => state.animation);
  const [editors, setEditors] = useState<ConfigEditors>({});
  const [error, setError] = useState<string>();
  const [reloads, setReloads] = useState<NativeRpcOutputs["config"]["reloadMcp"]>();
  const [saving, setSaving] = useState<Partial<Record<ConfigKind, boolean>>>({});
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const saveRequests = useRef({ core: 0, mcp: 0 });
  const savingKinds = useRef(new Set<ConfigKind>());
  const editor = tab === "core" || tab === "mcp" ? editors[tab] : undefined;
  const document = editor?.document;
  const text = editor?.text ?? "";
  const status = editor?.status ?? "";
  const online = useNativeOnline(client);
  const queries = useQueryClient();
  const loadConfig = open && online && viewer.role === "owner";
  const coreConfig = useQuery({
    ...configOptions(client, "core"),
    enabled: loadConfig && !editors.core,
  });
  const mcpConfig = useQuery({
    ...configOptions(client, "mcp"),
    enabled: loadConfig && !editors.mcp,
  });
  const config = tab === "mcp" ? mcpConfig : coreConfig;
  useEffect(() => {
    for (const value of [coreConfig.data, mcpConfig.data]) {
      if (!value) continue;
      setEditors((current) =>
        current[value.kind]
          ? current
          : {
              ...current,
              [value.kind]: {
                document: value,
                text: value.text,
                editRevision: 0,
              },
            },
      );
    }
  }, [coreConfig.data, mcpConfig.data]);
  async function save() {
    const rpc = client.rpc;
    if (!rpc || !document || !editor || savingKinds.current.has(document.kind)) return;
    savingKinds.current.add(document.kind);
    const request = { kind: document.kind, editRevision: editor.editRevision };
    const sequence = ++saveRequests.current[request.kind];
    setSaving((current) => ({ ...current, [request.kind]: true }));
    setError(undefined);
    const saved = await attempt(
      () =>
        rpc.config.save({
          kind: request.kind,
          expectedRevision: document.revision,
          text,
        }),
      (message) => {
        if (tabRef.current === request.kind) setError(message);
      },
    );
    if (saveRequests.current[request.kind] !== sequence) return;
    savingKinds.current.delete(request.kind);
    setSaving((current) => ({ ...current, [request.kind]: false }));
    if (!saved) return;
    void queries.invalidateQueries({ queryKey: ["config", request.kind] });
    setEditors((current) => completeConfigSave(current, request, saved));
  }
  async function reload() {
    if (!client.rpc) return;
    const result = await attempt(() => client.rpc!.config.reloadMcp({}), setError);
    if (result) setReloads(result);
  }
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="settings-dialog flex w-[min(64rem,_calc(100vw_-_calc(var(--ui-space-unit)*8)))] max-w-none sm:max-w-none h-[min(48rem,_calc(100dvh_-_calc(var(--ui-space-unit)*8)))] p-6 overflow-hidden">
        <DialogTitle className="sr-only absolute w-px h-px overflow-hidden [clip:rect(0,_0,_0,_0)] whitespace-nowrap">
          Settings
        </DialogTitle>
        <Tabs
          className="settings-layout flex-1 min-w-0 min-h-0 gap-6"
          orientation={narrow ? "horizontal" : "vertical"}
          value={tab}
          onValueChange={(value) => {
            if (
              value === "account" ||
              value === "options" ||
              value === "keybindings" ||
              value === "deployment" ||
              value === "core" ||
              value === "mcp" ||
              value === "agent" ||
              value === "users"
            ) {
              onTabChange(value);
              setError(undefined);
            }
          }}
        >
          <TabsList
            activateOnFocus
            variant="navigation"
            className="settings-navigation w-40 flex-none items-stretch justify-start self-stretch h-auto overflow-y-auto overflow-x-hidden min-w-0 py-4 px-0 gap-6 bg-transparent"
            aria-label="Settings sections"
          >
            <div className="settings-navigation-group flex flex-col gap-1">
              <span
                className="settings-navigation-label mt-0 mx-0 mb-2 px-3 text-sm font-semibold text-foreground"
                aria-hidden="true"
              >
                Preferences
              </span>
              <TabsTrigger tabIndex={0} value="account">
                Account
              </TabsTrigger>
              <TabsTrigger tabIndex={0} value="options">
                Settings
              </TabsTrigger>
              <TabsTrigger tabIndex={0} value="keybindings">
                Keybindings
              </TabsTrigger>
            </div>
            {viewer.role === "owner" ? (
              <div className="settings-navigation-group flex flex-col gap-1">
                <span
                  className="settings-navigation-label mt-0 mx-0 mb-2 px-3 text-sm font-semibold text-foreground"
                  aria-hidden="true"
                >
                  Runtime
                </span>
                <TabsTrigger tabIndex={0} value="deployment">
                  Deployment
                </TabsTrigger>
                <TabsTrigger tabIndex={0} value="core">
                  Core
                </TabsTrigger>
                <TabsTrigger tabIndex={0} value="mcp">
                  MCP
                </TabsTrigger>
                <TabsTrigger tabIndex={0} value="agent">
                  Agent
                </TabsTrigger>
                <TabsTrigger tabIndex={0} value="users">
                  User
                </TabsTrigger>
              </div>
            ) : null}
          </TabsList>
          <div className="settings-options flex-1 min-w-0 min-h-0 my-4 p-6 overflow-y-auto wrap-anywhere rounded-lg bg-background text-foreground">
            <ErrorNotice
              message={
                error ?? (tab === "core" || tab === "mcp" ? config.error?.message : undefined)
              }
              onDismiss={error ? () => setError(undefined) : undefined}
            />
            <TabsContent value="account" className="settings-section">
              {accountProfile ?? (
                <>
                  <h2>Account</h2>
                  <AccountProfile viewer={viewer} />
                </>
              )}
            </TabsContent>
            <TabsContent value="keybindings" className="settings-section">
              <KeybindingsSettings store={keybindings} />
            </TabsContent>
            <TabsContent value="options" className="settings-section">
              <h2>Appearance</h2>
              <AppearanceSettings theme={theme} onTheme={onTheme} />
              <div className="settings-row flex items-start justify-between gap-6 mb-8">
                <div className="settings-row-description min-w-0">
                  <span>Animation speed</span>
                  <p className="muted text-muted-foreground">
                    Animation speed is saved for your account on this device. Reduced motion follows
                    your system preference.
                  </p>
                </div>
                <Select
                  items={[
                    { value: "off", label: "Off" },
                    { value: "fast", label: "Fast" },
                    { value: "slow", label: "Slow" },
                  ]}
                  value={animation}
                  onValueChange={(value) => {
                    if (value === "off" || value === "fast" || value === "slow")
                      preferences.getState().setAnimation(value);
                  }}
                >
                  <SelectTrigger aria-label="Animation speed">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">Off</SelectItem>
                    <SelectItem value="fast">Fast</SelectItem>
                    <SelectItem value="slow">Slow</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <h2>Thread</h2>
              <SidebarPreferences />
              <NotificationSettings preferences={notifications} />
              <h2>Access</h2>
              <dl className="settings-account grid gap-4 mb-6">
                <div>
                  <dt>Role</dt>
                  <dd>{viewer.role}</dd>
                </div>
                <div>
                  <dt>Tool access</dt>
                  <dd>{viewer.toolMode === "full" ? "Full access" : "Restricted"}</dd>
                </div>
              </dl>
            </TabsContent>
            {viewer.role === "owner" ? (
              <TabsContent value="deployment" className="settings-section">
                <h2>Deployment</h2>
                <DeploymentSettings />
              </TabsContent>
            ) : null}
            <TabsContent value="agent" className="settings-section">
              <h2>Agent</h2>
              <AgentIdentity client={client} identity={agent} />
            </TabsContent>
            <TabsContent value="users" className="settings-section">
              <h2>User</h2>
              <People />
            </TabsContent>
            {tab === "core" || tab === "mcp" ? (
              <TabsContent
                value={tab}
                className="settings-section settings-config flex h-full min-h-0 flex-col gap-3"
              >
                <header className="config-header flex flex-wrap items-center gap-2">
                  <h2 className="flex-1 m-0 text-lg font-semibold">
                    {tab === "core" ? "Core" : "MCP"}
                  </h2>
                  <span role="status" className="text-sm text-muted-foreground">
                    {status}
                    {tab === "mcp" && status === "Saved" ? ". Reload to apply changes." : ""}
                  </span>
                  {tab === "mcp" ? (
                    <Button variant="secondary" size="sm" onClick={() => void reload()}>
                      <RefreshCw />
                      Reload MCP
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    disabled={!document || !!saving[document.kind] || text === document.text}
                    onClick={() => void save()}
                  >
                    <Save />
                    Save
                  </Button>
                </header>
                <div className="config-editor flex flex-1 min-h-0 overflow-hidden rounded-md border border-border">
                  <CodeEditor
                    key={tab}
                    language="yaml"
                    configKind={tab}
                    uri={`file:///lilac-settings/${tab}-config.yaml`}
                    label={`${tab === "core" ? "Core" : "MCP"} configuration YAML`}
                    value={document ? text : ""}
                    readOnly={!document}
                    onChange={(value) => setEditors((current) => editConfig(current, tab, value))}
                    onSave={() => void save()}
                  />
                </div>
                {tab === "mcp" && reloads ? (
                  <div className="reload-results flex-none max-h-40 overflow-auto text-sm">
                    {reloads.servers.map((server) => (
                      <div key={server.name}>
                        <strong>{server.name}</strong>
                        <span>{server.state}</span>
                        {server.error ? (
                          <p className="error-text text-danger text-sm">{server.error}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </TabsContent>
            ) : null}
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

export function People() {
  const { client } = useWorkspace();
  const online = useNativeOnline(client);
  const queries = useQueryClient();
  const userQuery = useInfiniteQuery({
    ...userOptions(client),
    enabled: online,
  });
  const users = userQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const [providerId, setProviderId] = useState("");
  const [mode, setMode] = useState<"restricted" | "full">("restricted");
  const change = useMutation({
    mutationFn: (
      input:
        | { providerUserId: string; toolMode: "full" | "restricted" }
        | { userId: string; toolMode: "full" | "restricted" },
    ) => {
      const rpc = client.rpc;
      if (!rpc) return Promise.resolve(undefined);
      if ("providerUserId" in input) return rpc.users.add(input);
      return rpc.users.setToolMode(input);
    },
    onSuccess: async (user, input) => {
      if (!user) return;
      if ("providerUserId" in input) setProviderId("");
      await Promise.all([
        queries.invalidateQueries({ queryKey: ["participants"] }),
        queries.invalidateQueries({ queryKey: ["users"] }),
      ]);
    },
  });
  const mutating = change.isPending;
  return (
    <section className="people">
      <ErrorNotice
        message={change.error?.message ?? userQuery.error?.message}
        onDismiss={change.error ? () => change.reset() : undefined}
      />
      <div className="inline-form flex gap-2 mb-4 items-center">
        <Input
          aria-label="Existing Clerk user ID"
          placeholder="Clerk user ID"
          value={providerId}
          onChange={(event) => setProviderId(event.target.value)}
        />
        <Select
          items={[
            { value: "restricted", label: "Restricted" },
            { value: "full", label: "Full access" },
          ]}
          value={mode}
          onValueChange={(value) => setMode(value === "full" ? "full" : "restricted")}
        >
          <SelectTrigger aria-label="Tool access for added user">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="restricted">Restricted</SelectItem>
            <SelectItem value="full">Full access</SelectItem>
          </SelectContent>
        </Select>
        <IconButton
          label="Add existing user"
          disabled={!online || mutating || !providerId.trim()}
          onClick={() => change.mutate({ providerUserId: providerId.trim(), toolMode: mode })}
        >
          <UserPlus />
        </IconButton>
      </div>
      <VirtualList
        items={users}
        itemKey={(user) => user.id}
        label="People"
        className="people-list h-80"
        render={(user) => (
          <div className="person-row flex items-center gap-2 py-2 px-0 text-sm">
            <span>{user.displayName}</span>
            <small>{user.role}</small>
            <Select
              items={[
                { value: "restricted", label: "Restricted" },
                { value: "full", label: "Full access" },
              ]}
              disabled={!online || mutating || user.role !== "participant"}
              value={user.toolMode}
              onValueChange={(value) =>
                change.mutate({
                  userId: user.id,
                  toolMode: value === "full" ? "full" : "restricted",
                })
              }
            >
              <SelectTrigger aria-label={`Tool access for ${user.displayName}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="restricted">Restricted</SelectItem>
                <SelectItem value="full">Full access</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      />
      {userQuery.hasNextPage ? (
        <Button
          type="button"
          variant="ghost"
          className="text-primary py-2 px-3 text-sm"
          disabled={userQuery.isFetching}
          onClick={() => {
            if (!userQuery.isFetching) void userQuery.fetchNextPage({ cancelRefetch: false });
          }}
        >
          Load more people
        </Button>
      ) : null}
    </section>
  );
}
