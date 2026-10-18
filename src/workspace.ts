import type { IslandView } from "./archipelago";
import { sortIslands, type Agent, type Island } from "./world";

/** Discovery can finish after live agents arrive. Neither source may hide the other. */
export function workspaceProjects(
  discovered: Pick<IslandView, "root" | "name" | "last_changed_at">[],
  live: Island[],
): Island[] {
  const byRoot = new Map<string, Island>(discovered.map(repo => [repo.root, {
    id: repo.root, name: repo.name, root: repo.root, last_changed_at: repo.last_changed_at,
    attention: "quiet", agents: [],
  }]));
  for (const island of live) byRoot.set(island.root, island);
  return sortIslands([...byRoot.values()]);
}

export function matchesAgent(agent: Agent, project: Pick<Island, "name" | "root">, query: string): boolean {
  return [project.name, project.root, agent.title, agent.kind, agent.pane_id]
    .some(value => value?.toLowerCase().includes(query.trim().toLowerCase()));
}

export function matchesProject(project: Island, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return [project.name, project.root].some(value => value.toLowerCase().includes(needle)) ||
    project.agents.some(agent => matchesAgent(agent, project, needle));
}
