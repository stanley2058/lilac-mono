import { AgentAvatar } from "../components/AgentAvatar";
import { RequestActiveContext } from "../components/ActivityLog";
import {
  HtmlPreviewBlock,
  HtmlPreviewFrame,
  HtmlPreviewMessageContext,
} from "../components/HtmlPreview";
import { FileSource } from "../components/FileSource";
import { useState } from "react";
import { Check } from "lucide-react";
import type { DisplayMessage } from "@stanley2058/lilac-client-protocol";
import logo from "../assets/logo.svg";
import weekendPdf from "../assets/design-system/weekend.pdf";
import { MessageIdentityContext } from "../components/message-identity";
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "../components/ui/avatar";
import { Bubble, BubbleContent } from "../components/ui/bubble";
import { Marker, MarkerContent, MarkerIcon } from "../components/ui/marker";
import { Message, ThinkingIndicator } from "../components/Timeline";
import { QuestionDemo } from "../components/QuestionDemo";
import { ConversationWelcome } from "../components/ConversationWelcome";
import { MessageGroupingDemo } from "../components/MessageGroupingDemo";
import { TimelineRailDemo } from "../components/TimelineRailDemo";
import { QueuedMessage, QueuedMessages } from "../components/QueuedMessage";
import { CodeFallback } from "../components/CodeEditor";
import {
  SkeletonCode,
  SkeletonConversation,
  SkeletonLines,
  SkeletonRows,
} from "../components/ui/skeleton";
import { now, noop, identities, messageFixtures, Section, Specimen } from "./shared";
import { reactionDemoNames } from "./Threads";
import { galleryPreviewSrc } from "./ComposerSection";
import { ThinkingSpinnerDemo } from "./Attachments";

export function Messages() {
  const [reactionMessages, setReactionMessages] = useState<DisplayMessage[]>([
    {
      id: "gallery-reactions-short",
      role: "user",
      metadata: { authorId: "alex", createdAt: now },
      parts: [
        { type: "text", text: "Coffee and a bookstore sounds perfect. Let's meet by the river." },
        {
          type: "data-reactions",
          id: "short-reactions",
          data: {
            items: [
              {
                emoji: "❤️",
                count: 1,
                reacted: false,
                userNames: ["Morgan Lee"],
                overflowCount: 0,
              },
              {
                emoji: "👍",
                count: 2,
                reacted: true,
                userNames: ["Alex Chen", "Morgan Lee"],
                overflowCount: 0,
              },
            ],
          },
        },
      ],
    },
    {
      id: "gallery-reactions-wrap",
      role: "assistant",
      metadata: { createdAt: now },
      parts: [
        { type: "text", text: "A good weekend plan." },
        {
          type: "data-reactions",
          id: "wrapped-reactions",
          data: {
            items: ["👍", "❤️", "🎉", "🔥", "👀", "🙏", "😂", "🚀", "✅", "💯", "🤔", "📚"].map(
              (emoji, index) => ({
                emoji,
                count: index === 3 ? 12 : (index % 5) + 1,
                reacted: false,
                userNames: reactionDemoNames.slice(0, index === 3 ? 5 : (index % 5) + 1),
                overflowCount: index === 3 ? 7 : 0,
              }),
            ),
          },
        },
      ],
    },
  ]);
  function react(messageId: string, emoji: string, active: boolean) {
    setReactionMessages((messages) =>
      messages.map((message) =>
        message.id !== messageId
          ? message
          : {
              ...message,
              parts: message.parts.map((part) => {
                if (part.type !== "data-reactions") return part;
                const existing = part.data.items.find((item) => item.emoji === emoji);
                if (!existing)
                  return {
                    ...part,
                    data: {
                      items: [
                        ...part.data.items,
                        {
                          emoji,
                          count: 1,
                          reacted: true,
                          userNames: ["Alex Chen"],
                          overflowCount: 0,
                        },
                      ],
                    },
                  };
                return {
                  ...part,
                  data: {
                    items: part.data.items
                      .map((item) => {
                        if (item.emoji !== emoji) return item;
                        const count = item.count + (active ? 1 : -1);
                        const otherCount = count - (active ? 1 : 0);
                        const names = reactionDemoNames.slice(0, Math.min(5, otherCount));
                        const userNames = (active ? ["Alex Chen", ...names] : names).slice(0, 5);
                        return {
                          ...item,
                          count,
                          reacted: active,
                          userNames,
                          overflowCount: Math.max(0, count - userNames.length),
                        };
                      })
                      .filter((item) => item.count > 0),
                  },
                };
              }),
            },
      ),
    );
  }
  return (
    <Section
      id="messages"
      title="Messages"
      description="The same message renderer used in conversations, with sample content."
    >
      <MessageIdentityContext value={identities}>
        <div className="ds-conversation flex flex-col gap-6 py-3">
          {reactionMessages.map((message) => (
            <Message
              key={message.id}
              message={message}
              canEdit
              resourceUrl={(id) => id}
              onAction={noop}
              onReaction={react}
            />
          ))}
          {messageFixtures.map((message) => (
            <Message
              key={message.id}
              message={message}
              resourceUrl={(id) => (id === "gallery-shared-pdf" ? weekendPdf : logo)}
              canEdit={false}
              onAction={noop}
              onReaction={noop}
            />
          ))}
        </div>
        <Specimen title="Queued and unsent messages">
          <QueuedMessages className="px-0 pb-0 max-workspace:px-0 max-workspace:pb-0">
            <QueuedMessage
              text="A second message sent before the first one starts"
              state="sending"
            />
            <QueuedMessage
              text="Use the staging database instead"
              state="sending"
              label="Steering"
            />
            <QueuedMessage text="Then write the release notes" state="sending" label="Follow-up" />
            <QueuedMessage
              text="Then write the release notes"
              state="queued"
              label="Follow-up"
              removeLabel="Remove queued message"
              onRemove={noop}
            />
            <QueuedMessage
              text={
                "Compare both proposals.\nKeep the summary short.\nList open questions.\nCite the spec section for each claim.\nFlag anything that changes the timeline.\nEnd with a recommendation."
              }
              state="queued"
              label="Follow-up"
              removeLabel="Remove queued message"
              onRemove={noop}
            />
            <QueuedMessage
              text="Summarize the failing tests"
              state="failed"
              error="Thread history is changing"
              onRetry={noop}
              onRemove={noop}
            />
            <QueuedMessage
              text="Summarize the failing tests"
              state="failed"
              error="Send not confirmed. Retry safely when connected."
              onRetry={noop}
              onRemove={noop}
            />
            <QueuedMessage
              text="Option B"
              state="failed"
              error="This question closed before your answer arrived."
              retryLabel="Send as message"
              onRetry={noop}
              onRemove={noop}
            />
            <QueuedMessage
              text="Plan the migration"
              state="failed"
              error="Conversation could not be created."
              onRetry={noop}
            />
            <QueuedMessage
              text="Summarize the failing tests"
              state="failed"
              error="You no longer have permission to send to this conversation."
              onRemove={noop}
            />
          </QueuedMessages>
        </Specimen>
        <Specimen title="Grouping and time gaps">
          <MessageGroupingDemo />
        </Specimen>
        <Specimen title="Turn rail">
          <TimelineRailDemo />
        </Specimen>
        <Specimen title="Turn rail in a DM">
          <TimelineRailDemo dm />
        </Specimen>
        <Specimen title="New conversation">
          <div className="grid grid-cols-1 workspace:grid-cols-2 gap-6">
            <ConversationWelcome />
            <ConversationWelcome existing />
          </div>
        </Specimen>
      </MessageIdentityContext>
      <div className="ds-grid grid grid-cols-1 workspace:grid-cols-2 gap-6">
        <Specimen title="Avatars">
          <div className="ds-row flex items-center flex-wrap gap-2">
            {(["sm", "default", "lg"] as const).map((size) => (
              <Avatar key={size} size={size}>
                <AvatarImage src={logo} alt="Lilac" />
                <AvatarFallback>LI</AvatarFallback>
              </Avatar>
            ))}
            <Avatar>
              <AvatarFallback>AC</AvatarFallback>
              <AvatarBadge />
            </Avatar>
            <AvatarGroup>
              <Avatar>
                <AvatarFallback>AC</AvatarFallback>
              </Avatar>
              <Avatar>
                <AvatarFallback>ML</AvatarFallback>
              </Avatar>
              <AvatarGroupCount>+2</AvatarGroupCount>
            </AvatarGroup>
          </div>
        </Specimen>
        <Specimen title="Agent avatars">
          <div className="ds-row flex items-center flex-wrap gap-4">
            {(["full", "restricted", "self"] as const).map((profile) => (
              <div key={profile} className="flex items-center gap-2">
                <AgentAvatar profile={profile} displayName={`${profile} agent`} size="lg" />
                <span className="text-sm capitalize">{profile}</span>
              </div>
            ))}
            <MessageIdentityContext value={identities}>
              <div className="flex items-center gap-2">
                <AgentAvatar profile="self" displayName="Self with configured avatar" size="lg" />
                <span className="text-sm">Self with custom avatar</span>
              </div>
            </MessageIdentityContext>
          </div>
        </Specimen>
        <Specimen title="Bubble variants">
          <div className="ds-stack">
            {(
              [
                "default",
                "secondary",
                "muted",
                "tinted",
                "outline",
                "ghost",
                "destructive",
              ] as const
            ).map((variant) => (
              <Bubble key={variant} variant={variant}>
                <BubbleContent>{variant}</BubbleContent>
              </Bubble>
            ))}
          </div>
        </Specimen>
      </div>
      <ThinkingSpinnerDemo />
      <Specimen title="Questions">
        <QuestionDemo />
      </Specimen>
      <Specimen title="HTML preview">
        <HtmlPreviewFrame src={galleryPreviewSrc} title="weekly-runs.html" />
      </Specimen>
      <Specimen title="Loading states">
        <div className="grid grid-cols-1 gap-6 workspace:grid-cols-2">
          <SkeletonConversation label="Loading conversation" />
          <div className="flex flex-col gap-4">
            <SkeletonRows label="Loading files" rows={4} />
            <SkeletonRows label="Loading people" rows={2} avatar />
            <SkeletonLines label="Loading preview" />
            <SkeletonCode label="Loading file" lines={5} />
          </div>
        </div>
      </Specimen>
      <Specimen title="Editor loading">
        <div className="flex h-40 rounded-lg bg-background">
          <CodeFallback
            value={
              'export const weekend = { pace: "slow" };\nexport const stops = ["river", "bookstore"];\n\nconsole.log(weekend, stops);'
            }
          />
        </div>
      </Specimen>
      <Specimen title="HTML file preview">
        <div className="h-96">
          <FileSource
            name="weekly-runs.html"
            href={galleryPreviewSrc}
            text={{
              status: "ready",
              text: decodeURIComponent(galleryPreviewSrc.split(",")[1] ?? ""),
              truncated: false,
            }}
          />
        </div>
      </Specimen>
      <Specimen title="HTML preview loading">
        <HtmlPreviewMessageContext value={{ threadId: "gallery", messageId: "gallery" }}>
          <RequestActiveContext value>
            <HtmlPreviewBlock source="/work/weekly-runs.html" />
          </RequestActiveContext>
        </HtmlPreviewMessageContext>
      </Specimen>
      <Specimen title="Markers">
        <div className="ds-stack">
          <ThinkingIndicator />
          <Marker variant="separator">
            <MarkerContent>Conversation compacted</MarkerContent>
          </Marker>
          <Marker variant="border">
            <MarkerIcon>
              <Check />
            </MarkerIcon>
            <MarkerContent>Finished in 8 seconds</MarkerContent>
          </Marker>
        </div>
      </Specimen>
    </Section>
  );
}
