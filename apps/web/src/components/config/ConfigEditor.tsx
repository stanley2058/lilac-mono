import { useEffect, useMemo, type KeyboardEvent } from "react";
import { cn } from "cn";
import { FlaskConical } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { configLineAtPath, isConfigObject } from "@stanley2058/lilac-utils/config-document";
import { Tabs } from "@base-ui/react/tabs";
import { Button } from "../ui/button";
import { SkeletonLines } from "../ui/skeleton";
import { ErrorNotice } from "../ui";
import { CodeEditor } from "../CodeEditor";
import { configOptions, useNativeOnline } from "../../queries";
import { useWorkspace } from "../../workspace-context";
import { useConfigDraftStore, useConfigDrafts } from "../../config-ui/draft-store";
import type { Manifest } from "../../config-ui/manifest";
import { FORM_CORE_CONFIG_VERSION, type ConfigKind } from "../../config-ui/schemas";
import { ConfigPage } from "./ConfigPage";
import { ConfigSaveBar } from "./ConfigSaveBar";
import { ConfigSearch } from "./ConfigSearch";
import { McpItemStatus, McpReloadButton } from "./McpServerStatus";
import { ConfigScopeContext, type ConfigScope } from "./use-config-field";

export const YAML_PAGE = "yaml";

const PAGE_TAB =
  "relative flex-none border-b-2 border-transparent px-0.5 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground data-[active]:border-foreground data-[active]:text-foreground";

const mcpStatus = (key: string) => <McpItemStatus serverId={key} />;

/** Pages for one config file, with its YAML as the last tab. */
export function ConfigEditor<P extends string>({
  kind,
  title,
  manifest,
}: {
  kind: ConfigKind;
  title: string;
  manifest: Manifest<P>;
}) {
  const { client } = useWorkspace();
  const online = useNativeOnline(client);
  const store = useConfigDraftStore();
  const loaded = useConfigDrafts((state) => state.drafts[kind] !== undefined);
  const query = useQuery({ ...configOptions(client, kind), enabled: online && !loaded });
  useEffect(() => {
    if (query.data) store.getState().load(query.data);
  }, [query.data, store]);
  const firstPage = manifest.pages[0]?.id ?? YAML_PAGE;
  const page = useConfigDrafts((state) => state.pages[kind]) ?? firstPage;
  const parseError = useConfigDrafts((state) => state.drafts[kind]?.parseError);
  const version = useConfigDrafts((state) => {
    const value = state.drafts[kind]?.value;
    return isConfigObject(value) ? value.configVersion : undefined;
  });
  const unsupported =
    kind === "core" && loaded && !parseError && version !== FORM_CORE_CONFIG_VERSION;
  const scope = useMemo<ConfigScope>(
    () => ({ kind, base: [], disabled: !online || unsupported || parseError !== undefined }),
    [kind, online, unsupported, parseError],
  );
  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "s" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    document.querySelector<HTMLButtonElement>(`[data-config-save="${kind}"]`)?.click();
  }
  return (
    <ConfigScopeContext value={scope}>
      <div className="flex h-full min-h-0 flex-col gap-3" onKeyDown={onKeyDown}>
        <header className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 mr-auto text-lg font-semibold">{title}</h2>
          {kind === "mcp" ? <McpReloadButton /> : null}
          {manifest.pages.length > 1 ? <ConfigSearch manifest={manifest} /> : null}
        </header>
        <Tabs.Root
          value={page}
          onValueChange={(next) => {
            if (typeof next === "string") store.getState().setPage(kind, next);
          }}
          className="flex min-h-0 flex-1 flex-col gap-3"
        >
          <Tabs.List
            aria-label={`${title} settings pages`}
            className="flex h-9 flex-none items-stretch gap-4 overflow-x-auto overflow-y-hidden border-b border-border"
          >
            {manifest.pages.map((item) => (
              <Tabs.Tab
                key={item.id}
                value={item.id}
                className={cn(PAGE_TAB, "flex items-center gap-1")}
              >
                {item.title}
                {item.experimental ? (
                  <FlaskConical
                    aria-label="Experimental"
                    className="size-3.5 text-muted-foreground"
                  />
                ) : null}
              </Tabs.Tab>
            ))}
            <Tabs.Tab value={YAML_PAGE} className={cn(PAGE_TAB, "ml-auto")}>
              YAML
            </Tabs.Tab>
          </Tabs.List>
          {!loaded && query.error ? <ErrorNotice message={query.error.message} /> : null}
          {!loaded && !query.error ? (
            <SkeletonLines label={`Loading ${title} settings`} lines={8} className="py-2" />
          ) : null}
          {loaded ? (
            <>
              {page !== YAML_PAGE && parseError ? (
                <Notice
                  message={`The YAML has a syntax error: ${parseError}`}
                  action="Fix in YAML"
                  onAction={() => store.getState().setPage(kind, YAML_PAGE)}
                />
              ) : null}
              {page !== YAML_PAGE && unsupported ? (
                <Notice
                  message={`This file uses configVersion ${String(version ?? 1)}. The form edits version ${FORM_CORE_CONFIG_VERSION}; see docs/core-config-migrations.md to upgrade.`}
                  action="Edit YAML"
                  onAction={() => store.getState().setPage(kind, YAML_PAGE)}
                />
              ) : null}
              {manifest.pages.map((item) => (
                <Tabs.Panel
                  key={item.id}
                  value={item.id}
                  className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto -ml-1 pl-1 pr-4 outline-none"
                >
                  {item.experimental ? (
                    <p className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
                      <FlaskConical className="size-4 flex-none" />
                      Experimental. These settings may change or be removed.
                    </p>
                  ) : null}
                  <ConfigPage
                    page={item}
                    yamlPage={YAML_PAGE}
                    status={kind === "mcp" ? mcpStatus : undefined}
                  />
                </Tabs.Panel>
              ))}
              <Tabs.Panel value={YAML_PAGE} className="flex min-h-0 flex-1 outline-none">
                <YamlView kind={kind} title={title} />
              </Tabs.Panel>
            </>
          ) : null}
        </Tabs.Root>
        <ConfigSaveBar manifest={manifest} />
      </div>
    </ConfigScopeContext>
  );
}

function Notice({
  message,
  action,
  onAction,
}: {
  message: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div
      role="status"
      className="flex flex-none items-center gap-3 rounded-md bg-warning/10 px-3 py-2 text-sm"
    >
      <span className="min-w-0 flex-1">{message}</span>
      <Button variant="outline" size="sm" onClick={onAction}>
        {action}
      </Button>
    </div>
  );
}

function YamlView({ kind, title }: { kind: ConfigKind; title: string }) {
  const store = useConfigDraftStore();
  const text = useConfigDrafts((state) => state.drafts[kind]?.text ?? "");
  const focus = useConfigDrafts((state) => state.focus[kind]);
  const line = useMemo(
    () =>
      focus ? configLineAtPath(store.getState().drafts[kind]?.text ?? "", focus.path) : undefined,
    [focus, kind, store],
  );
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden rounded-md border border-border">
      <CodeEditor
        language="yaml"
        configKind={kind}
        uri={`file:///lilac-settings/${kind}-config.yaml`}
        label={`${title} configuration YAML`}
        value={text}
        line={line}
        navigation={focus}
        onChange={(value) => store.getState().setText(kind, value)}
        onSave={() =>
          document.querySelector<HTMLButtonElement>(`[data-config-save="${kind}"]`)?.click()
        }
      />
    </div>
  );
}
