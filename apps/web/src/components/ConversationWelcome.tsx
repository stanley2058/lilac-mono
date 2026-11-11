import { useContext, useState } from "react";
import { ActorAvatar } from "./ActorAvatar";
import { MessageIdentityContext } from "./message-identity";

const avatarRing =
  "mb-0.5 grid rounded-full ring-3 ring-[color-mix(in_srgb,var(--ui-primary)_22%,transparent)]";

export function greeting(hour: number) {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
}

/** A new conversation opens like a chat with the agent; an existing empty one says it has no messages. */
export function ConversationWelcome({ existing = false }: { existing?: boolean }) {
  const { agent, viewerId, users } = useContext(MessageIdentityContext);
  const [hour] = useState(() => new Date().getHours());
  const viewer = viewerId ? users.get(viewerId) : undefined;
  const name = viewer?.displayName.trim().split(/\s+/u)[0];
  if (existing)
    return (
      <div
        data-ui="conversation-welcome"
        className="flex flex-col items-center gap-1.5 px-6 pt-6 pb-4 text-center"
      >
        <span aria-hidden className={avatarRing}>
          <ActorAvatar {...agent} size="lg" />
        </span>
        <h2 className="text-lg font-medium text-muted-foreground">No messages yet</h2>
      </div>
    );
  return (
    <div
      data-ui="conversation-welcome"
      className="flex flex-col items-center gap-2 px-6 pt-6 pb-4 text-center"
    >
      <span aria-hidden className={`${avatarRing} [&_[data-slot=avatar]]:size-18`}>
        <ActorAvatar {...agent} size="lg" />
      </span>
      <h2 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">
        {agent.displayName}
      </h2>
      <p className="-mt-1.5 text-lg text-balance text-foreground/70">
        {greeting(hour)}
        {name ? `, ${name}` : ""}. What's on your mind?
      </p>
    </div>
  );
}
