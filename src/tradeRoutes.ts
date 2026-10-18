export type TradeMode = "plan" | "implement";
export type TradeRoute = {
  id: string;
  sourceRoot: string;
  sourceName: string;
  targetRoot: string;
  targetName: string;
  paneId: string;
  agentTitle: string;
  agentKind: string;
  targetCwd: string;
  mode: TradeMode;
  brief: string;
  prompt: string;
  createdAt: number;
};
export type RoutePreset = { sourceRoot?: string; targetRoot?: string; paneId?: string };
export const TRADE_ROUTES_KEY = "aoa.tradeRoutes.v1";

export function buildTradePrompt({ source, destination, cwd, brief, mode }: {
  source: { root: string; name: string };
  destination: { root: string; name: string };
  cwd: string;
  brief: string;
  mode: TradeMode;
}): string {
  return `Project trade route: ${source.name} → ${destination.name}

Reference repository (read-only): ${JSON.stringify(source.root)}
Destination repository: ${JSON.stringify(destination.root)}
Your working directory / worktree: ${JSON.stringify(cwd)}

My brief:
${brief.trim()}

Inspect the reference project's README and relevant code, then compare it with the destination. Follow the applicable repository instructions. Treat the reference as read-only; adapt useful ideas or code in your destination working tree. If you cannot access either path, tell me what access is needed.

${mode === "plan"
    ? "Propose an integration plan with the files, dependencies, and tests that would change. Wait for my approval before changing any files."
    : "Implement the brief in your destination working tree. Adapt the code to this project's conventions, check relevant tests, and report the changes and any remaining gaps."}`;
}

export function decodeTradeRoutes(raw: string | null): TradeRoute[] {
  if (raw === null) return [];
  const parsed = JSON.parse(raw);
  if (parsed?.version !== 1 || !Array.isArray(parsed.routes)) throw new Error("Unsupported route storage");
  const fields = ["id", "sourceRoot", "sourceName", "targetRoot", "targetName", "paneId", "agentTitle", "agentKind", "targetCwd", "brief", "prompt"] as const;
  const ids = new Set<string>();
  for (const route of parsed.routes) {
    if (!route || fields.some(key => typeof route[key] !== "string" || !route[key].trim()) ||
        !["plan", "implement"].includes(route.mode) || !Number.isFinite(route.createdAt) ||
        route.createdAt < 0 || !Number.isFinite(new Date(route.createdAt).getTime()) ||
        route.sourceRoot === route.targetRoot || ids.has(route.id)) throw new Error("Invalid saved route");
    ids.add(route.id);
  }
  return parsed.routes;
}
