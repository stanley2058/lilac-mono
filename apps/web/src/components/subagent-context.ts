import { createContext, useContext } from "react";
import type { SubagentSummary } from "@stanley2058/lilac-client-protocol";
import type { AgentTabTarget } from "../panel-store";

/** Matches the `[data-agent-color]` palette in `theme/tokens.css`. */
const AGENT_COLOR_COUNT = 8;

export type SubagentRelations = {
  /** Palette index by subagent `id`. */
  colors: ReadonlyMap<string, number>;
  /** Delegated subagents by their parent's `id`, in list order. */
  children: ReadonlyMap<string, readonly SubagentSummary[]>;
};

function colorHash(id: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % AGENT_COLOR_COUNT;
}

/** Colors come from each id; a child that would match its parent takes the next color. */
export function subagentRelations(agents: readonly SubagentSummary[]): SubagentRelations {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const colors = new Map<string, number>();
  const children = new Map<string, SubagentSummary[]>();
  const color = (agent: SubagentSummary, depth: number): number => {
    const known = colors.get(agent.id);
    if (known !== undefined) return known;
    const parent = agent.parentId ? byId.get(agent.parentId) : undefined;
    const own = colorHash(agent.id);
    const index = parent && depth < 64 && color(parent, depth + 1) === own ? own + 1 : own;
    colors.set(agent.id, index % AGENT_COLOR_COUNT);
    return index % AGENT_COLOR_COUNT;
  };
  for (const agent of agents) {
    color(agent, 0);
    if (!agent.parentId) continue;
    const siblings = children.get(agent.parentId);
    if (siblings) siblings.push(agent);
    else children.set(agent.parentId, [agent]);
  }
  return { colors, children };
}

export type SubagentContextValue = SubagentRelations & {
  agents: ReadonlyMap<string, SubagentSummary>;
  open: (agent: AgentTabTarget, aliasId?: string) => void;
};

export function subagentContextValue(
  agents: readonly SubagentSummary[],
  open: (agent: AgentTabTarget, aliasId?: string) => void,
): SubagentContextValue {
  return {
    ...subagentRelations(agents),
    agents: new Map(agents.map((agent) => [agent.activityId, agent])),
    open,
  };
}

export const SubagentContext = createContext<SubagentContextValue>(
  subagentContextValue([], () => {}),
);
export const useSubagents = () => useContext(SubagentContext);
export const subagentProfileName = (profile: SubagentSummary["profile"]) =>
  `${profile.charAt(0).toUpperCase()}${profile.slice(1)} Agent`;

export const agentTabTarget = (
  agent: Pick<SubagentSummary, "id" | "profile" | "taskTitle">,
): AgentTabTarget => ({
  agentId: agent.id,
  title: agent.taskTitle ?? subagentProfileName(agent.profile),
  profile: agent.profile,
});
