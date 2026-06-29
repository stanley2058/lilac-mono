export function resolveDiscordSurfaceEditTarget(input: {
  authorId?: string | null;
  selfUserId: string;
  embedCount: number;
  content?: string | null;
}): "content" | "embed_description" {
  if (input.authorId !== input.selfUserId) {
    throw new Error(
      "surface.messages.edit only supports messages authored by the Lilac Discord bot",
    );
  }

  if (typeof input.content === "string" && input.content.trim().length > 0) {
    return "content";
  }

  if (input.embedCount <= 0) {
    return "content";
  }

  if (input.embedCount === 1) {
    return "embed_description";
  }

  throw new Error(
    "surface.messages.edit only supports Discord messages with plain content or a single embed",
  );
}

export function resolveEffectiveSessionModelOverride(input: {
  sessionId: string;
  parentChannelId?: string | null;
  overrides: ReadonlyMap<string, string>;
}): string | undefined {
  const threadOverride = input.overrides.get(input.sessionId);
  if (threadOverride) return threadOverride;

  const parentChannelId = input.parentChannelId?.trim();
  if (!parentChannelId) return undefined;
  return input.overrides.get(parentChannelId);
}
