import { describe, expect, it } from "vitest";
import { buildTradePrompt, decodeTradeRoutes, type TradeRoute } from "./tradeRoutes";

describe("trade route briefs", () => {
  const input = {
    source: { root: "/work/mini editor", name: "mini editor" },
    destination: { root: "/work/app", name: "app" },
    cwd: "/work/app-worktree", brief: "Bring the editor into the app.",
  };
  it("identifies the reference, destination, and actual working tree, with review before edits", () => {
    const prompt = buildTradePrompt({ ...input, mode: "plan" });
    expect(prompt).toContain('"/work/mini editor"');
    expect(prompt).toContain('"/work/app"');
    expect(prompt).toContain('"/work/app-worktree"');
    expect(prompt).toContain(input.brief);
    expect(prompt).toMatch(/read-only/);
    expect(prompt).toMatch(/Wait for my approval before changing/);
  });
  it("only requests implementation when that mode was chosen", () => {
    expect(buildTradePrompt({ ...input, mode: "implement" })).toMatch(/Implement the brief/);
  });
});

describe("saved trade routes", () => {
  const route: TradeRoute = {
    id: "r1", sourceRoot: "/mini", sourceName: "mini", targetRoot: "/main", targetName: "main",
    paneId: "w1:p1", agentTitle: "Builder", agentKind: "codex", targetCwd: "/main", mode: "plan",
    brief: "Use the editor", prompt: "Full reviewed prompt", createdAt: 1234,
  };
  it("round-trips the exact submitted prompt without deriving agent progress", () => {
    expect(decodeTradeRoutes(JSON.stringify({ version: 1, routes: [route] }))).toEqual([route]);
  });
  it("rejects malformed storage rather than silently overwriting saved history", () => {
    for (const bad of ["no json", '{"version":2,"routes":[]}', JSON.stringify({ version: 1, routes: [{ ...route, targetRoot: "/mini" }] })]) {
      expect(() => decodeTradeRoutes(bad)).toThrow();
    }
  });
  it("rejects timestamps that cannot be displayed as dates", () => {
    for (const createdAt of [-1, 1e20]) {
      expect(() => decodeTradeRoutes(JSON.stringify({ version: 1, routes: [{ ...route, createdAt }] }))).toThrow();
    }
  });
});
