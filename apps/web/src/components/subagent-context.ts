import { createContext, useContext } from "react";
import type { SubagentSummary } from "@stanley2058/lilac-client-protocol";
import type { AgentTabTarget } from "../panel-store";

/** Matches the `[data-agent-color]` palette in `theme/tokens.css`. */
const AGENT_COLOR_COUNT = 8;

export type SubagentRelations = {
  /** Palette index by subagent `id`; every run of a child session shares one color. */
  colors: ReadonlyMap<string, number>;
  /** The newest run of each child session a subagent delegated, by its newest `id`. */
  children: ReadonlyMap<string, readonly SubagentSummary[]>;
  /** The newest run of each run's child session, by run `id`. */
  latest: ReadonlyMap<string, SubagentSummary>;
};

function colorHash(id: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % AGENT_COLOR_COUNT;
}

/** Follow-ups continue a child session, which its first run names. */
const sessionOf = (agent: SubagentSummary) => agent.firstRunId ?? agent.id;

/** A run another loaded run continues is older; otherwise the later start wins. */
export function latestRuns(agents: readonly SubagentSummary[]) {
  const continued = new Set(
    agents.flatMap((agent) => (agent.previousId ? [agent.previousId] : [])),
  );
  const newest = new Map<string, SubagentSummary>();
  for (const agent of agents) {
    const current = newest.get(sessionOf(agent));
    const newer =
      !current ||
      (continued.has(current.id) && !continued.has(agent.id)) ||
      (continued.has(current.id) === continued.has(agent.id) &&
        agent.startedAt > current.startedAt);
    if (newer) newest.set(sessionOf(agent), agent);
  }
  return new Map(agents.map((agent) => [agent.id, newest.get(sessionOf(agent))!]));
}

/**
 * Each child session takes one color from its key; one that would match its parent takes the
 * next color. Follow-up runs of one session count as one agent.
 */
export function subagentRelations(agents: readonly SubagentSummary[]): SubagentRelations {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const latest = latestRuns(agents);
  // Runs of one session can name different parent runs; any loaded one gives the parent color.
  const parents = new Map<string, SubagentSummary>();
  for (const agent of agents) {
    const parent = agent.parentId ? byId.get(agent.parentId) : undefined;
    if (parent && !parents.has(sessionOf(agent))) parents.set(sessionOf(agent), parent);
  }
  const sessionColors = new Map<string, number>();
  const color = (session: string, depth: number): number => {
    const known = sessionColors.get(session);
    if (known !== undefined) return known;
    const parent = parents.get(session);
    const own = colorHash(session);
    const index =
      (parent && depth < 64 && color(sessionOf(parent), depth + 1) === own ? own + 1 : own) %
      AGENT_COLOR_COUNT;
    sessionColors.set(session, index);
    return index;
  };
  const colors = new Map(agents.map((agent) => [agent.id, color(sessionOf(agent), 0)]));
  const children = new Map<string, Set<SubagentSummary>>();
  for (const agent of agents) {
    if (!agent.parentId) continue;
    const parentId = latest.get(agent.parentId)?.id ?? agent.parentId;
    const siblings = children.get(parentId) ?? new Set();
    children.set(parentId, siblings.add(latest.get(agent.id)!));
  }
  return {
    colors,
    children: new Map([...children].map(([id, siblings]) => [id, [...siblings]])),
    latest,
  };
}

/** Agents to list: each child session once, as its newest run. */
export function latestAgents(
  agents: readonly SubagentSummary[],
  latest: SubagentRelations["latest"],
): SubagentSummary[] {
  return agents.filter((agent) => latest.get(agent.id) === agent);
}

export type SubagentContextValue = SubagentRelations & {
  agents: ReadonlyMap<string, SubagentSummary>;
  open: (agent: AgentTabTarget, aliasId?: string) => void;
};

export function subagentContextValue(
  agents: readonly SubagentSummary[],
  open: (agent: AgentTabTarget, aliasId?: string) => void,
): SubagentContextValue {
  const relations = subagentRelations(agents);
  return {
    ...relations,
    agents: new Map(agents.map((agent) => [agent.activityId, agent])),
    // A follow-up continues its session, so every run opens the session's newest one.
    open: (agent, aliasId) => {
      const latest = relations.latest.get(agent.agentId);
      open(latest ? agentTabTarget(latest) : agent, aliasId);
    },
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
