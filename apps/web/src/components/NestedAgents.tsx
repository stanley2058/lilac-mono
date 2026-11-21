import type { SubagentSummary } from "@stanley2058/lilac-client-protocol";
import { toolLabelSubagentProfile } from "../activity-presentation";
import { AgentAvatar } from "./AgentAvatar";
import { subagentProfileName, type SubagentRelations } from "./subagent-context";
import { AvatarGroup } from "./ui/avatar";

const STACK_LIMIT = 3;

/** The agents a running subagent delegated to, while at least one of them still runs. */
export function activeNestedAgents(
  agent: { id?: string; state: SubagentSummary["state"] },
  children: SubagentRelations["children"],
): readonly SubagentSummary[] | undefined {
  if (agent.state !== "running" || !agent.id) return undefined;
  const nested = children.get(agent.id);
  return nested?.some((child) => child.state === "running") ? nested : undefined;
}

export function nestedAgentsLabel(nested: readonly SubagentSummary[]): string {
  const running = nested.filter((agent) => agent.state === "running").length;
  const noun = nested.length === 1 ? "agent" : "agents";
  if (running === nested.length) return `${running} ${noun} running`;
  return `${running} of ${nested.length} ${noun} running`;
}

/**
 * Core titles a running subagent with its active tool's label. A nested delegation's label is the
 * multi-line progress display, so it reads as the delegated profile instead.
 */
export function subagentTitle(title: string): string {
  const profile = toolLabelSubagentProfile(title);
  return profile ? `Delegating to ${subagentProfileName(profile)}` : title;
}

/** Up to three avatars, running agents first; the label beside it carries the count. */
export function NestedAgentStack({
  nested,
  colors,
}: {
  nested: readonly SubagentSummary[];
  colors: SubagentRelations["colors"];
}) {
  const shown = [
    ...nested.filter((agent) => agent.state === "running"),
    ...nested.filter((agent) => agent.state !== "running"),
  ].slice(0, STACK_LIMIT);
  return (
    <AvatarGroup
      aria-hidden="true"
      className="nested-agents shrink-0 items-center -space-x-1 *:data-[slot=avatar]:size-4 *:data-[slot=avatar]:ring-0"
    >
      {shown.map((agent) => (
        <AgentAvatar
          key={agent.id}
          decorative
          profile={agent.profile}
          displayName={subagentProfileName(agent.profile)}
          color={colors.get(agent.id)}
          size="sm"
        />
      ))}
    </AvatarGroup>
  );
}
