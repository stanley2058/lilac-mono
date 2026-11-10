import { CodeEditor } from "../components/CodeEditor";
import { WorkspaceTreeView } from "../components/WorkspaceTree";
import { KeybindingsSettings } from "../components/KeybindingsSettings";
import { createKeybindings } from "../keybindings";
import { NotificationSettings } from "../components/NotificationSettings";
import { createNotificationPreferences, sendTestNotification } from "../notifications";
import { useLocation } from "@tanstack/react-router";
import { useState } from "react";
import { Bell } from "lucide-react";
import type { NativeDeploymentSettings } from "@stanley2058/lilac-client-protocol";
import { toast } from "../components/ui/toast";
import { Button } from "../components/ui/button";
import { DeploymentSettingsForm } from "../components/DeploymentSettings";

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
