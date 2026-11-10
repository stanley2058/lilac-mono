import "./design-system.css";
import { AppearanceSettings } from "./components/AppearanceSettings";
import { ReconnectionDemo } from "./components/ReconnectionDemo";
import lilacLogo from "./assets/logo.svg";
import { ActivityItem } from "./components/ActivityLog";
import { LinkPreviewAnchor } from "./components/LinkWithFavicon";
import { setThemeMode } from "./theme/theme";
import { Link, useLocation } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { TooltipProvider } from "./components/ui/tooltip";
import { Markdown } from "./components/Markdown";
import { AgentWorkDemo } from "./components/AgentWorkDemo";
import { CitationDemo } from "./components/CitationDemo";
import { WorkingIndicatorsContext } from "./components/WorkVerb";
import {
  sections,
  richText,
  tableExample,
  alertExamples,
  Section,
  Specimen,
} from "./design-system/shared";
import { Foundations } from "./design-system/Foundations";
import { Threads, demoWorkingIndicators } from "./design-system/Threads";
import { Messages } from "./design-system/Messages";
import { ComposerSpecimen } from "./design-system/ComposerSection";
import { Attachments } from "./design-system/Attachments";
import { Controls } from "./design-system/Controls";
import { Overlays } from "./design-system/Overlays";
import { Layout, ComputerDemo } from "./design-system/Layout";
import {
  KeybindingsDemo,
  DeploymentSettingsDemo,
  NotificationSettingsDemo,
} from "./design-system/SettingsDemos";
export default function DesignSystem() {
  const returnThreadId = useLocation({ select: (location) => location.state.chatThreadId });
  const returnDraftId = useLocation({ select: (location) => location.state.draftThreadId });

  const [queries] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "system");
  useEffect(() => {
    const previous = document.documentElement.dataset.theme;
    return () => {
      setThemeMode(previous ?? "system");
    };
  }, []);
  useEffect(() => {
    setThemeMode(theme);
  }, [theme]);
  return (
    <QueryClientProvider client={queries}>
      <TooltipProvider>
        <div className="ds-page h-dvh overflow-auto bg-background">
          <header className="ds-header py-8">
            <Link
              to={returnThreadId ? "/threads/$threadId" : "/"}
              params={returnThreadId ? { threadId: returnThreadId } : {}}
              state={{ draftThreadId: returnDraftId }}
              className="ds-back inline-flex items-center gap-2 text-muted-foreground text-sm mb-8"
            >
              <ArrowLeft />
              Back to chat
            </Link>
            <div className="ds-header-main flex items-start workspace:items-center justify-between gap-6">
              <div>
                <span className="ds-eyebrow text-primary text-sm font-semibold">Lilac</span>
                <h1>Design system</h1>
                <p>Components, states, and patterns used in the native app.</p>
              </div>
              <Select
                value={theme}
                items={[
                  { value: "dark", label: "Dark" },
                  { value: "light", label: "Light" },
                  { value: "system", label: "System" },
                ]}
                onValueChange={(value) => {
                  if (value) setTheme(value);
                }}
              >
                <SelectTrigger aria-label="Preview theme">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dark">Dark</SelectItem>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="system">System</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </header>
          <div className="ds-body block workspace:grid workspace:[grid-template-columns:calc(var(--ui-sidebar-width)_/_2)_minmax(0,_1fr)] gap-8 pb-12">
            <nav
              className="ds-nav static workspace:sticky top-6 self-start flex flex-row workspace:flex-col gap-1 py-2 workspace:pt-6 workspace:pb-0 overflow-x-auto"
              aria-label="Component sections"
            >
              {sections.map(([id, title]) => (
                <a key={id} href={`#${id}`}>
                  {title}
                </a>
              ))}
            </nav>
            <main className="ds-main min-w-0">
              <Foundations />
              <Threads />
              <Messages />
              <Section
                id="agent-work"
                title="Agent work"
                description="Choose a stage to inspect, or play through the examples. Expand work summaries and tool details. These use the conversation renderer with local sample data."
              >
                <WorkingIndicatorsContext value={demoWorkingIndicators}>
                  <AgentWorkDemo />
                </WorkingIndicatorsContext>
              </Section>
              <Section id="appearance" title="Appearance">
                <div className="max-w-2xl">
                  <AppearanceSettings theme={theme} onTheme={setTheme} />
                </div>
              </Section>
              <Section id="keybindings" title="Keybindings">
                <KeybindingsDemo />
              </Section>
              <Section id="notifications" title="Notifications">
                <NotificationSettingsDemo />
              </Section>
              <Section id="deployment" title="Deployment settings">
                <DeploymentSettingsDemo />
              </Section>
              <ComposerSpecimen />
              <Section
                id="citations"
                title="Citations"
                description="Select assistant text to cite it or copy Markdown. Add a comment, save it, and follow the chip back to its source."
              >
                <CitationDemo />
              </Section>
              <Section
                id="reconnection"
                title="Reconnection"
                description="Try the real composer and connection notice with a simulated outage."
              >
                <ReconnectionDemo />
              </Section>
              <Attachments />
              <Section id="content" title="Rich content">
                <div className="ds-content min-w-0">
                  <div className="flex flex-wrap gap-4 mb-4">
                    <LinkPreviewAnchor
                      href="https://example.com/article"
                      preview={{
                        title: "A quiet weekend",
                        description: "A few places to explore, with time to stop along the way.",
                      }}
                    >
                      Preview with text
                    </LinkPreviewAnchor>
                    <LinkPreviewAnchor
                      href="https://example.com/photo"
                      preview={{
                        title: "A quiet weekend",
                        description: "A few places to explore, with time to stop along the way.",
                        image: lilacLogo,
                      }}
                    >
                      Preview with image
                    </LinkPreviewAnchor>
                    <LinkPreviewAnchor href="https://example.com/unavailable" preview={{}}>
                      Unavailable preview
                    </LinkPreviewAnchor>
                    <LinkPreviewAnchor href="https://example.com/loading" loading>
                      Loading preview
                    </LinkPreviewAnchor>
                  </div>
                  <Specimen title="Remote images">
                    <LinkPreviewAnchor
                      href="https://claude.dev/blog/how-we-made-claude-ai-faster/"
                      preview={{
                        title: "How we made claude.ai 3x faster in two weeks",
                        icon: "https://claude.dev/shared/img/favicon.svg",
                        image: "https://claude.dev/blog/how-we-made-claude-ai-faster/og.png",
                      }}
                    >
                      claude.dev
                    </LinkPreviewAnchor>
                    <ActivityItem
                      part={{
                        type: "data-activity",
                        id: "remote-image-preview",
                        data: {
                          kind: "tool",
                          label: "read",
                          state: "complete",
                          detail: 'read {"path":"https://claude.dev/shared/img/favicon.svg"}',
                          file: {
                            path: "https://claude.dev/shared/img/favicon.svg",
                            mediaType: "image/svg+xml",
                          },
                        },
                      }}
                    />
                  </Specimen>
                  <Markdown text={richText} />
                  <Specimen title="Table with Markdown and CSV copy">
                    <Markdown text={tableExample} />
                  </Specimen>
                  <Specimen title="Table in a wrapped preview">
                    <Markdown text={tableExample} wrap />
                  </Specimen>
                  <Specimen title="GitHub alerts">
                    <Markdown text={alertExamples} />
                  </Specimen>
                </div>
              </Section>
              <ComputerDemo />
              <Controls />
              <Overlays />
              <Layout />
            </main>
          </div>
        </div>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
