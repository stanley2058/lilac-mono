import { SPINNERS } from "loading-dev";
import { LoadingSpinner } from "../components/ui/loading-spinner";
import { ConversationBadge } from "../components/ConversationReference";
import { FileIcon } from "../components/FileIcon";
import { FileSource } from "../components/FileSource";
import { useState } from "react";
import logo from "../assets/logo.svg";
import motion from "../assets/design-system/motion.mp4";
import tone from "../assets/design-system/tone.wav";
import weekendPdf from "../assets/design-system/weekend.pdf";
import { AttachmentPreviewBody, ReadyAttachment } from "../components/ResourcePreview";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { ThinkingIndicator } from "../components/Timeline";
import { WorkflowRunBadge, WorkflowRunChip } from "../components/WorkflowRunChip";
import { workflowRunSamples, markdownAttachment, Section, Specimen } from "./shared";
import { FileTabsDemo } from "./ComposerSection";
import { WorkspaceEditorDemo } from "./SettingsDemos";

export function Attachments() {
  return (
    <Section
      id="attachments"
      title="Attachments"
      description="Open a media card to try the viewer. These files are generated preview fixtures."
    >
      <div className="ds-grid grid grid-cols-1 workspace:grid-cols-2 gap-6">
        <Specimen title="File icons">
          <div className="ds-stack">
            {[
              "README.md",
              "App.tsx",
              "example.test.ts",
              "package.json",
              "Dockerfile",
              ".bashrc",
              "report.pdf",
              "archive.zip",
              "photo.png",
              "unknown",
            ].map((name) => (
              <span key={name} className="ds-row flex items-center flex-wrap gap-2">
                <FileIcon name={name} />
                {name}
              </span>
            ))}
          </div>
        </Specimen>
        <Specimen title="Image">
          <ReadyAttachment
            href={logo}
            data={{
              resourceId: "gallery-image",
              name: "lilac.svg",
              mediaType: "image/svg+xml",
              size: 2400,
              state: "ready",
            }}
          />
        </Specimen>
        <Specimen title="Video">
          <ReadyAttachment
            href={motion}
            data={{
              resourceId: "gallery-video",
              name: "motion.mp4",
              mediaType: "video/mp4",
              size: 2400,
              state: "ready",
            }}
          />
        </Specimen>
        <Specimen title="Audio">
          <ReadyAttachment
            href={tone}
            data={{
              resourceId: "gallery-audio",
              name: "tone.wav",
              mediaType: "audio/wav",
              size: 88278,
              state: "ready",
            }}
          />
        </Specimen>
        <Specimen title="Text preview">
          <AttachmentPreviewBody
            name="notes.txt"
            href="data:text/plain,A%20quiet%20weekend"
            kind="text"
            text={{
              status: "ready",
              text: "A quiet weekend\n\n1. Coffee by the river\n2. Browse the bookstore\n3. Leave the afternoon free",
              truncated: false,
            }}
          />
        </Specimen>
        <Specimen title="Markdown preview">
          <AttachmentPreviewBody
            name="notes.md"
            href={`data:text/markdown,${encodeURIComponent(markdownAttachment)}`}
            kind="text"
            text={{ status: "ready", text: markdownAttachment, truncated: false }}
          />
        </Specimen>
        <Specimen title="Workspace editor">
          <WorkspaceEditorDemo />
        </Specimen>
        <Specimen title="Right panel tabs">
          <div className="flex flex-wrap gap-2 mb-3">
            <ConversationBadge target={{ surface: "native", sessionId: "example-thread" }} />
            <WorkflowRunBadge run={workflowRunSamples[0]!} onClick={() => {}} />
            <WorkflowRunBadge run={workflowRunSamples[2]!} onClick={() => {}} />
            <WorkflowRunChip runId="wfrun:unknown-run" />
            <ConversationBadge
              target={{
                surface: "discord",
                sessionId: "123456789012345678",
                messageId: "987654321098765432",
              }}
            />
          </div>
          <FileTabsDemo />
        </Specimen>
        <Specimen title="File source · lines 123–125">
          <div style={{ height: 440 }}>
            <FileSource
              name="example.ts"
              line={123}
              endLine={125}
              text={{
                status: "ready",
                truncated: false,
                text: Array.from<number, string>(
                  { length: 180 },
                  (_, index) =>
                    `export const item${index + 1} = "A long line that wraps naturally in the file viewer without stretching the panel.";`,
                ).join("\n"),
              }}
            />
          </div>
        </Specimen>
        <Specimen title="PDF · long filename">
          <ReadyAttachment
            href={weekendPdf}
            data={{
              resourceId: "gallery-pdf",
              name: "Weekend_travel_itinerary_and_reservations_2026.pdf",
              mediaType: "application/pdf",
              size: 728,
              state: "ready",
            }}
          />
        </Specimen>
        <Specimen title="Truncated text">
          <AttachmentPreviewBody
            name="long-notes.txt"
            href="data:text/plain,Preview%20fixture"
            kind="text"
            text={{ status: "ready", text: "Preview fixture…", truncated: true }}
          />
        </Specimen>
        <Specimen title="Binary file">
          <AttachmentPreviewBody
            name="archive.zip"
            href=""
            kind="text"
            text={{ status: "error", message: "This binary file cannot be previewed as text." }}
          />
        </Specimen>
      </div>
    </Section>
  );
}
export const spinnerOptions = Object.entries(SPINNERS).map(([value, component]) => ({
  value,
  label: value.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase()),
  component,
}));

export function ThinkingSpinnerDemo() {
  const [selected, setSelected] = useState<string | null>("morph");
  const spinner = spinnerOptions.find((option) => option.value === selected)?.component;
  return (
    <Specimen title="Thinking spinner">
      <div className="flex flex-col items-start gap-4" data-ui="thinking-spinner-demo">
        <Select value={selected} onValueChange={setSelected} items={spinnerOptions}>
          <SelectTrigger aria-label="Thinking spinner">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {spinnerOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ThinkingIndicator spinner={<LoadingSpinner spinner={spinner} />} />
      </div>
    </Specimen>
  );
}
