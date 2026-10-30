/**
 * Pure logic for "raids" — a repo's dependency-vulnerability scan drawn as
 * attackers on its island. Mirrors `src-tauri`'s raid module's `Serialize`d
 * structs field-for-field (no case conversion on this wire, same discipline
 * as `archipelago.ts`). DOM/WebGL-free so every drawing decision is unit
 * testable before any scene code exists. (`three`'s `Color` below is plain
 * colour math, no renderer: it is here so the stale mix happens in the same
 * colour space the scenes light in.)
 */
import { Color } from "three";
import { formatLastChanged } from "./lastChanged";

export type Severity = "critical" | "high" | "moderate" | "low" | "unknown";

export type Finding = {
  id: string;
  summary: string;
  severity: Severity;
  package: string;
  installed: string | null;
  fixed_in: string | null;
  lockfile: string;
  url: string;
};

/** Tagged by `kind`, exactly as the Rust enum serializes. */
export type RaidStatus =
  | { kind: "clean" }
  | { kind: "raided"; findings: Finding[] }
  | { kind: "unscouted"; reason: string };

export type RaidReport = {
  root: string;
  scanned_at: number;
  scanner: string | null;
  covered: string[];
  uncovered: string[];
  status: RaidStatus;
  /** Computed by the backend: the lockfiles changed since this scan. */
  stale: boolean;
};

/** Ceiling on ships drawn per island; the rest become an "+N more" count. */
export const MAX_SHIPS = 6;

/** Sail colour per severity, shared by the ships at sea and the raiders in
 * town so one severity reads as one colour everywhere. "unknown" sails as
 * moderate: we were told something is wrong, not how badly. */
export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "#1b1b1b",
  high: "#c8432f",
  moderate: "#e0a43a",
  unknown: "#e0a43a",
  low: "#e9e2cf",
};

/** Stale colours are mixed this far toward grey: still there (the finding
 * was real when scanned), visibly no longer current. */
const STALE_GREY = new Color("#9a9a9a");
const STALE_MIX = 0.6;

/** A severity's colour as drawn — a ship's sail at sea, a raider in town —
 * greyed when the report is stale. One function so the two never drift. */
export function raidColor(severity: Severity, stale: boolean): string {
  if (!stale) return SEVERITY_COLOR[severity];
  return "#" + new Color(SEVERITY_COLOR[severity]).lerp(STALE_GREY, STALE_MIX).getHexString();
}

/** Worst first — the order ships are drawn and groups are ranked in. */
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  moderate: 2,
  low: 3,
  unknown: 4,
};

export function findingsOf(report: RaidReport | undefined): Finding[] {
  return report?.status.kind === "raided" ? report.status.findings : [];
}

function bySeverity(a: Finding, b: Finding): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
}

export function shipsFor(report: RaidReport | undefined): { ships: Finding[]; overflow: number } {
  // `slice().sort` — the report is shared React state, never mutate it.
  const sorted = findingsOf(report).slice().sort(bySeverity);
  return { ships: sorted.slice(0, MAX_SHIPS), overflow: Math.max(0, sorted.length - MAX_SHIPS) };
}

/** Smoke over an island means "serious": a critical, or three highs. A stale
 * report never smokes — we no longer know the lockfiles still say that. */
export function hasSmoke(report: RaidReport | undefined): boolean {
  if (!report || report.stale) return false;
  const findings = findingsOf(report);
  return (
    findings.some((f) => f.severity === "critical") ||
    findings.filter((f) => f.severity === "high").length >= 3
  );
}

/** The all-clear flag: only a clean AND fresh scan. Unscouted is not clean. */
export function showsCleanFlag(report: RaidReport | undefined): boolean {
  return report?.status.kind === "clean" && !report.stale;
}

/** Stale findings still count: they were real when scanned and nothing has
 * shown them fixed, so hiding them would be the dishonest direction. */
export function isUnderAttack(report: RaidReport | undefined): boolean {
  return findingsOf(report).length > 0;
}

const MANIFEST_FOR_LOCKFILE: Record<string, string> = {
  "package-lock.json": "package.json",
  "yarn.lock": "package.json",
  "pnpm-lock.yaml": "package.json",
  "Cargo.lock": "Cargo.toml",
  "poetry.lock": "pyproject.toml",
  "go.sum": "go.mod",
  "Gemfile.lock": "Gemfile",
};

/** Mirror of the Rust mapping, keeping the directory prefix. Anything not
 * recognised is returned unchanged rather than guessed at. */
export function manifestForLockfile(lockfile: string): string {
  const slash = lockfile.lastIndexOf("/");
  const dir = slash === -1 ? "" : lockfile.slice(0, slash + 1);
  const manifest = MANIFEST_FOR_LOCKFILE[lockfile.slice(slash + 1)];
  return manifest === undefined ? lockfile : dir + manifest;
}

export type RaiderGroup = {
  /** The manifest building the raiders gather at; null when that file is not
   * a building in the city, so they gather on the coast instead. */
  anchorPath: string | null;
  manifest: string;
  findings: Finding[];
  worst: Severity;
};

export function raiderGroups(
  report: RaidReport | undefined,
  buildingPaths: ReadonlySet<string>,
): RaiderGroup[] {
  const byManifest = new Map<string, Finding[]>();
  for (const finding of findingsOf(report)) {
    const manifest = manifestForLockfile(finding.lockfile);
    const list = byManifest.get(manifest);
    if (list) list.push(finding);
    else byManifest.set(manifest, [finding]);
  }
  const groups: RaiderGroup[] = [];
  for (const [manifest, findings] of byManifest) {
    const sorted = findings.slice().sort(bySeverity);
    groups.push({
      anchorPath: buildingPaths.has(manifest) ? manifest : null,
      manifest,
      findings: sorted,
      worst: sorted[0].severity,
    });
  }
  // Worst group first, ties by manifest so the order is deterministic.
  return groups.sort(
    (a, b) => SEVERITY_RANK[a.worst] - SEVERITY_RANK[b.worst] || a.manifest.localeCompare(b.manifest),
  );
}

export function defendPrompt(root: string, findings: Finding[], agentCwd: string | null): string {
  const lines = findings.map(
    (f) =>
      `- ${f.severity} ${f.id} in ${f.package}${f.installed ? `@${f.installed}` : ""} ` +
      `(fix: ${f.fixed_in ?? "none known"}) — ${f.summary} [${f.lockfile}]`,
  );
  const out = [`Dependency vulnerabilities were found in ${root}:`, "", ...lines, ""];
  if (agentCwd && agentCwd !== root) {
    out.push(`You are working in the worktree ${agentCwd}, not the main checkout at ${root}.`);
  }
  out.push(
    "Please upgrade each affected package to a fixed version, update the lockfile accordingly, " +
      "and run the project's tests. Report anything you could not fix, and why.",
  );
  return out.join("\n");
}

/** One finding's identity across scans (and across UI rows): the same
 * advisory in the same package of the same lockfile. */
export const findingKey = (f: Finding) => `${f.id}\u0000${f.package}\u0000${f.lockfile}`;

/** Findings present in the previous report but gone after a re-scout — the
 * ships to sink. Only a fresh, completed scan can prove a fix: an unscouted
 * or stale `after` says nothing about what is still there, so it sinks
 * nothing. An absent `before` has nothing to compare against. */
export function sunkFindings(before: RaidReport | undefined, after: RaidReport): Finding[] {
  if (after.stale || (after.status.kind !== "clean" && after.status.kind !== "raided")) return [];
  const still = new Set(findingsOf(after).map(findingKey));
  return findingsOf(before).filter((f) => !still.has(findingKey(f)));
}

/** The island panel's one-line "Threats" fact: "3 raiders (1 critical)",
 * "Clean, scouted 2 days ago", the unscouted reason, or "Not scouted yet".
 * Stale findings are still counted (see `isUnderAttack`), and say so. */
export function threatsSummary(report: RaidReport | undefined, nowMs: number = Date.now()): string {
  if (!report) return "Not scouted yet";
  switch (report.status.kind) {
    case "unscouted":
      return report.status.reason;
    case "clean":
      // A stale clean scan proves nothing about the lockfiles as they are
      // now (`showsCleanFlag` raises no flag for it either): it WAS clean.
      return report.stale
        ? `Was clean ${formatLastChanged(report.scanned_at, nowMs)} · lockfiles changed since — rescout`
        : `Clean, scouted ${formatLastChanged(report.scanned_at, nowMs)}`;
    case "raided": {
      const findings = report.status.findings;
      const worst = findings.slice().sort(bySeverity)[0]?.severity;
      const worstCount = findings.filter((f) => f.severity === worst).length;
      const head = `${findings.length} ${findings.length === 1 ? "raider" : "raiders"}`;
      const detail = worst ? ` (${worstCount} ${worst})` : "";
      return head + detail + (report.stale ? " · lockfiles changed since" : "");
    }
  }
}
