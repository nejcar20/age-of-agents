import { describe, expect, it } from "vitest";
import { createProjectSummary, isValidProjectName, startAgentSummary } from "./actions";

describe("startAgentSummary", () => {
  it("names the exact call, including the chosen kind", () => {
    expect(startAgentSummary("/p/pocketAlarm", "claude", false)).toEqual([
      'agent.start  root="/p/pocketAlarm"  kind="claude"',
    ]);
  });

  it("never claims a kind before agent_kinds() has resolved one", () => {
    expect(startAgentSummary("/p/pocketAlarm", "", false)).toEqual(['agent.start  root="/p/pocketAlarm"']);
  });

  it("names resume explicitly when true, never silently", () => {
    expect(startAgentSummary("/p/pocketAlarm", "claude", true)).toEqual([
      'agent.start  root="/p/pocketAlarm"  kind="claude"  resume=true',
    ]);
  });

  it("never mentions resume when false", () => {
    const lines = startAgentSummary("/p/pocketAlarm", "claude", false);
    expect(lines.join("\n")).not.toMatch(/resume/);
  });
});

describe("createProjectSummary", () => {
  it("lists every real step, in order, when starting an agent", () => {
    expect(createProjectSummary("~/Projects", "widget", true, "claude")).toEqual([
      "mkdir  ~/Projects/widget",
      "git init  ~/Projects/widget",
      'workspace.create  cwd="~/Projects/widget"  label="widget"',
      'agent.start  kind="claude"',
    ]);
  });

  it("omits the agent.start line entirely when not starting an agent", () => {
    const lines = createProjectSummary("~/Projects", "widget", false, "claude");
    expect(lines.some((l) => l.includes("agent.start"))).toBe(false);
  });
});

describe("isValidProjectName", () => {
  it("accepts an ordinary name", () => {
    expect(isValidProjectName("widget")).toBe(true);
  });

  it("rejects empty or whitespace-only names", () => {
    expect(isValidProjectName("")).toBe(false);
    expect(isValidProjectName("   ")).toBe(false);
  });

  it("rejects '.' and '..'", () => {
    expect(isValidProjectName(".")).toBe(false);
    expect(isValidProjectName("..")).toBe(false);
  });

  it("rejects a name that would escape the chosen parent directory", () => {
    expect(isValidProjectName("../elsewhere")).toBe(false);
    expect(isValidProjectName("sub/dir")).toBe(false);
    expect(isValidProjectName("a\\b")).toBe(false);
  });
});
