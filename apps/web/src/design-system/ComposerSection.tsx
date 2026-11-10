import { WorkspaceTreeView } from "../components/WorkspaceTree";
import { ModelSelectorDemo } from "../components/ModelSelectorDemo";
import { FloatingChatMenu } from "../components/FloatingChatMenu";
import { ConversationBadge } from "../components/ConversationReference";
import { useStore } from "zustand";
import { createPanelStore, defaultPanelTabs } from "../panel-store";
import { RightPanelTabs } from "../components/FileViewer";
import { FileSource } from "../components/FileSource";
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import logo from "../assets/logo.svg";
import type { Attachment } from "../types";
import type { DisplayCatalog } from "@stanley2058/lilac-client-protocol";
import { HTML_PREVIEW_BOOTSTRAP_MARKUP } from "@stanley2058/lilac-client-protocol";
import { SkillCatalogContext } from "../components/skill-mentions";
import { toast } from "../components/ui/toast";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Markdown } from "../components/Markdown";
import { Composer } from "../components/Composer";
import { noop, Section, Specimen } from "./shared";
import { editorDemoPaths } from "./SettingsDemos";

export const galleryPreviewBars = [
  ["Mon", 42],
  ["Tue", 68],
  ["Wed", 55],
  ["Thu", 81],
  ["Fri", 34],
] as const;
// The same bootstrap the preview route adds, so the sample follows the theme and reports its height.
export const galleryPreviewSrc = `data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><html><head>${HTML_PREVIEW_BOOTSTRAP_MARKUP}<style>.bars{display:flex;align-items:end;gap:12px;height:160px}.bar{flex:1;border-radius:var(--radius) var(--radius) 0 0}.labels{display:flex;gap:12px;margin-top:6px;color:var(--muted-foreground);font-size:12px}.labels span{flex:1;text-align:center}h4{margin:0 0 12px;font-weight:600}</style></head><body><h4>Runs this week</h4><div class="bars">${galleryPreviewBars
    .map(
      ([, value], index) =>
        `<div class="bar" style="height:${value * 1.8}px;background:var(--chart-${index + 1})"></div>`,
    )
    .join("")}</div><div class="labels">${galleryPreviewBars
    .map(([day]) => `<span>${day}</span>`)
    .join("")}</div></body></html>`,
)}`;
export const composerCatalog: DisplayCatalog = {
  revision: "design-system",
  models: [],
  skills: [
    {
      id: "agent-browser",
      name: "agent-browser",
      description: "Browser automation",
      source: "user",
    },
  ],
  commands: [
    {
      id: "custom:tarot",
      name: "tarot",
      description: "Draw tarot cards",
      kind: "custom",
      argumentHint: "<count> [spread] [reversed]",
      arguments: [
        { key: "count", type: "number", required: true, description: "Cards to draw" },
        {
          key: "spread",
          type: "string",
          required: false,
          choices: ["single", "past-present-future", "celtic cross"],
        },
        { key: "reversed", type: "boolean", required: false, description: "Allow reversed cards" },
      ],
    },
  ],
};
export function ComposerSpecimen() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [typeToFocus, setTypeToFocus] = useState(false);
  const [text, setText] = useState(
    "Help me turn these **notes** into a weekend plan with $agent-browser.\n\nCompare [the discussion](/?ref=discord%3Aweekend). Keep Sunday free.\nhttps://example.com/weekend",
  );
  const [skillIds, setSkillIds] = useState(["agent-browser"]);
  const [disabled, setDisabled] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>(() => [
    {
      key: "gallery-notes",
      file: new File([], "lilac.svg", { type: "image/svg+xml" }),
      preview: logo,
      reservation: Promise.resolve("gallery-notes"),
      state: "ready",
      progress: 1,
    },
  ]);
  return (
    <Section
      id="composer"
      title="Composer"
      description="Enable Type anywhere, then click outside the editor and start typing. Try the formatting toolbar, Markdown shortcuts, multiline input, and /tarot arguments."
    >
      <div className="ds-row flex items-center flex-wrap gap-2">
        <Button
          variant="secondary"
          aria-pressed={typeToFocus}
          onClick={() => setTypeToFocus((value) => !value)}
        >
          Type anywhere
        </Button>
        <Button variant="secondary" onClick={() => setDisabled((value) => !value)}>
          {disabled ? "Enable editor" : "Disable editor"}
        </Button>
        <Button
          variant="secondary"
          onClick={() => setText("Review [missing.txt](attachment:missing)")}
        >
          Missing attachment
        </Button>
      </div>
      <Specimen title="Models">
        <ModelSelectorDemo />
      </Specimen>
      <div className="ds-composer my-4">
        <FloatingChatMenu
          sidebarOpen={sidebarOpen}
          rightOpen={rightOpen}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onToggleRight={() => setRightOpen((open) => !open)}
          onNewThread={() => toast.add({ title: "New thread selected", type: "info" })}
          onShare={() => toast.add({ title: "Share selected", type: "info" })}
          onRename={() => toast.add({ title: "Rename selected", type: "info" })}
          onArchive={() => toast.add({ title: "Archive selected", type: "info" })}
          onDelete={() => toast.add({ title: "Delete selected", type: "info" })}
        />
        <Composer
          typeToFocus={typeToFocus}
          text={text}
          onText={setText}
          attachments={attachments}
          onRemoveAttachment={(key) =>
            setAttachments((items) => items.filter((item) => item.key !== key))
          }
          disabled={disabled}
          catalog={composerCatalog}
          skillIds={skillIds}
          onSkills={setSkillIds}
          onCommand={noop}
          onAttach={noop}
          onRetryAttachment={noop}
          active={false}
          canCancel={false}
          onModelChange={noop}
          onSubmit={() => setText("")}
          onCancel={noop}
        />
      </div>
      <Specimen title="Message preview">
        <SkillCatalogContext value={composerCatalog.skills}>
          <Markdown text={text} preserveLineBreaks />
        </SkillCatalogContext>
      </Specimen>
      <Collapsible>
        <CollapsibleTrigger render={<Button variant="ghost" />}>
          <ChevronRight />
          Markdown output
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="ds-source p-4 bg-surface rounded-md whitespace-pre-wrap wrap-anywhere text-sm">
            {text}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </Section>
  );
}
export function FileTabsDemo() {
  const [store] = useState(() => {
    const store = createPanelStore();
    store
      .getState()
      .openFile("demo", { type: "path", path: "/workspace/notes.md", name: "notes.md" });
    store
      .getState()
      .openFile("demo", { type: "path", path: "/workspace/example.ts", name: "example.ts" });
    store
      .getState()
      .openThread(
        "demo",
        { surface: "native", sessionId: "example-thread" },
        "Example conversation",
      );
    return store;
  });
  const tabs = useStore(store, (state) => state.tabs.get("demo") ?? defaultPanelTabs);
  const actions = store.getState();
  return (
    <div style={{ height: 420 }}>
      <RightPanelTabs
        tabs={tabs}
        onFocus={(id) => actions.focusTab("demo", id)}
        onClose={(id) => actions.closeTab("demo", id)}
        onAgents={() => actions.openAgents("demo")}
        onFiles={() => actions.openFiles("demo")}
        renderTab={(tab) => {
          if (tab.type === "thread") return <ConversationBadge target={tab.target} />;
          if (tab.type === "files")
            return (
              <WorkspaceTreeView
                paths={editorDemoPaths}
                root="/workspace"
                onOpen={(path) =>
                  actions.openFile("demo", {
                    type: "path",
                    path: `/workspace/${path}`,
                    name: path.split("/").at(-1) ?? path,
                  })
                }
              />
            );
          return tab.type === "agents" ? (
            <div className="file-status grid place-content-center flex-1 p-4 text-sm text-muted-foreground">
              No subagents yet
            </div>
          ) : (
            <FileSource
              name={tab.target.name}
              heading={
                <span>{tab.target.type === "path" ? tab.target.path : tab.target.name}</span>
              }
              text={{
                status: "ready",
                text: tab.target.name.endsWith(".md")
                  ? Array.from<number, string>(
                      { length: 25 },
                      (_, index) => `- Note ${index + 1}: Each file keeps its own view.`,
                    ).join("\n")
                  : Array.from<number, string>(
                      { length: 180 },
                      (_, index) => `export const line${index + 1} = "A longer source file";`,
                    ).join("\n"),
                truncated: false,
              }}
            />
          );
        }}
      />
    </div>
  );
}
