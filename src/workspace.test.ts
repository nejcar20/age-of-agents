import { describe, expect, it } from "vitest";
import { workspaceProjects, matchesProject, matchesAgent } from "./workspace";
import type { Island } from "./world";

const project: Island = {
  id: "w1", name: "api", root: "/work/api", attention: "working", last_changed_at: null,
  agents: [{ pane_id: "w1:p1", workspace_id: "w1", title: "Fix payments", kind: "codex", status: "working", attention: "working", cwd: "/work/api", is_worktree: false }],
};

describe("workspace projects", () => {
  it("keeps live repositories during discovery and joins by root, never by basename", () => {
    const result = workspaceProjects([
      { root: "/archive/api", name: "api", last_changed_at: null },
      { root: "/work/api", name: "api", last_changed_at: 42 },
    ], [project]);
    expect(result).toHaveLength(2);
    expect(result.find(p => p.root === "/work/api")?.agents[0].title).toBe("Fix payments");
    expect(result.find(p => p.root === "/archive/api")?.agents).toEqual([]);
    expect(workspaceProjects([], [project])).toEqual([project]);
  });
  it("searches agent titles and kinds as well as project paths", () => {
    expect(matchesProject(project, " payments ")).toBe(true);
    expect(matchesProject(project, "CODEX")).toBe(true);
    expect(matchesProject(project, "/work/")).toBe(true);
    expect(matchesProject(project, "missing")).toBe(false);
    expect(matchesAgent(project.agents[0], project, "payments")).toBe(true);
  });
});
