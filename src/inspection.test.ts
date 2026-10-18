import { describe, expect, it } from "vitest";
import { buildScopedPrompt, indexTownFiles, relativeProjectPath, searchTownFiles } from "./inspection";
import type { CityModel } from "./city";

const model: CityModel = { root: "/work/app", name: "app", skipped: 0, submodules: 0, districts: [
  { path: "/work/app/src", name: "src", depth: 1, walled: false, buildings: [
    { path: "/work/app/src/auth.ts", name: "auth.ts", kind: "Source", lines: 20, height: 1 },
    { path: "/work/app/src/auth.test.ts", name: "auth.test.ts", kind: "Test", lines: 40, height: 2 },
  ] },
] };
describe("town file context", () => {
  it("matches filenames and relative paths without confusing a sibling repository", () => {
    expect(relativeProjectPath("/work/app", "/work/app-copy/auth.ts")).toBeNull();
    expect(relativeProjectPath("/work/app/", "/work/app/src/auth.ts")).toBe("src/auth.ts");
    const indexed = indexTownFiles(model);
    expect(searchTownFiles(indexed, "AUTH.TS").map(f => f.path)).toEqual(["src/auth.ts"]);
    expect(searchTownFiles(indexed, "src/auth")).toHaveLength(2);
    expect(indexed[1].districtPath).toBe("/work/app/src");
  });
  it("scopes a file task to the receiving worktree and requests review before edits", () => {
    const prompt = buildScopedPrompt({ root: "/work/app", cwd: "/work/app-feature", path: "src/auth.ts", kind: "file", brief: "Explain and test the token refresh.", mode: "plan" });
    expect(prompt).toContain('"src/auth.ts"');
    expect(prompt).toContain('"/work/app-feature"');
    expect(prompt).toContain("git rev-parse --show-toplevel");
    expect(prompt).toContain("relative to that checkout root");
    expect(prompt).toContain("Wait for my approval");
    expect(prompt).toContain("Explain and test");
  });
  it("does not resolve repository-relative paths against a nested launch directory", () => {
    const prompt = buildScopedPrompt({ root: "/app", cwd: "/app-feature/src", path: "src/auth.ts", kind: "file", brief: "Review this file", mode: "plan" });
    expect(prompt).toContain('"/app-feature/src"');
    expect(prompt).toContain("working directory may be a subdirectory");
    expect(prompt).not.toContain("Resolve the relative path inside your working directory");
  });
  it("requests actual implementation only when selected", () => {
    expect(buildScopedPrompt({ root: "/app", cwd: "/app", path: "src", kind: "directory", brief: "Add tests", mode: "implement" })).toContain("Implement the task");
  });
});
