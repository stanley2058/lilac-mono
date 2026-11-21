import { AgentAvatar, type AgentProfile } from "./AgentAvatar";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";

export type ActorIdentity = {
  displayName: string;
  avatarUrl?: string;
  agentProfile?: AgentProfile;
  agentColor?: number;
};

export function initials(name: string): string {
  return (
    name
      .replace(/\s+\([^)]*\)\s*$/u, "")
      .trim()
      .split(/\s+/u)
      .slice(0, 2)
      .map((word) => [...word][0] ?? "")
      .join("")
      .toLocaleUpperCase() || "?"
  );
}

export function ActorAvatar({
  displayName,
  avatarUrl,
  agentProfile,
  agentColor,
  size = "default",
}: ActorIdentity & { size?: "default" | "sm" | "lg" }) {
  if (agentProfile)
    return (
      <AgentAvatar
        profile={agentProfile}
        displayName={displayName}
        size={size}
        avatarUrl={avatarUrl}
        color={agentColor}
      />
    );
  return (
    <Avatar size={size} role="img" aria-label={displayName}>
      {avatarUrl ? <AvatarImage src={avatarUrl} alt="" referrerPolicy="no-referrer" /> : null}
      <AvatarFallback>{initials(displayName)}</AvatarFallback>
    </Avatar>
  );
}
