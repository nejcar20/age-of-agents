import { describe, expect, it } from "vitest";
import {
  defendPrompt,
  findingsOf,
  hasSmoke,
  isUnderAttack,
  manifestForLockfile,
  raiderGroups,
  showsCleanFlag,
  shipsFor,
  sunkFindings,
  threatsSummary,
  findingKey,
  type Finding,
  type RaidReport,
  type Severity,
} from "./raids";
import { matchesStateFilter, isSeaIslandMatch, findBestSeaIslandMatch, type SeaIsland } from "./archipelago";

const finding = (id: string, severity: Severity, over: Partial<Finding> = {}): Finding => ({
  id, summary: `${id} summary`, severity, package: `pkg-${id}`, installed: "1.0.0",
  fixed_in: "1.0.1", lockfile: "package-lock.json", url: `https://osv.dev/${id}`, ...over,
});

const report = (status: RaidReport["status"], over: Partial<RaidReport> = {}): RaidReport => ({
  root: "/p/a", scanned_at: 1, scanner: "osv-scanner", covered: ["package-lock.json"],
  uncovered: [], status, stale: false, ...over,
});

const raided = (findings: Finding[], over: Partial<RaidReport> = {}) =>
  report({ kind: "raided", findings }, over);

describe("raids", () => {
  it("finding_key_distinguishes_id_package_and_lockfile", () => {
    const a = finding("X", "high");
    expect(findingKey(a)).toBe(findingKey({ ...a, summary: "other" }));
    expect(findingKey(a)).not.toBe(findingKey({ ...a, lockfile: "web/yarn.lock" }));
    expect(findingKey(a)).not.toBe(findingKey({ ...a, package: "other" }));
  });

  it("threats_summary_names_count_worst_clean_and_reason", () => {
    const now = 1_000_000_000_000;
    const twoDaysAgo = now / 1000 - 2 * 86400;
    expect(threatsSummary(raided([finding("a", "high"), finding("b", "critical"), finding("c", "low")]))).toBe("3 raiders (1 critical)");
    expect(threatsSummary(raided([finding("a", "high")], { stale: true }))).toBe("1 raider (1 high) · lockfiles changed since");
    expect(threatsSummary(report({ kind: "clean" }, { scanned_at: twoDaysAgo }), now)).toBe("Clean, scouted 2 days ago");
    // Stale clean is NOT clean: the lockfiles changed, so it was only clean.
    expect(threatsSummary(report({ kind: "clean" }, { scanned_at: twoDaysAgo, stale: true }), now)).toBe(
      "Was clean 2 days ago · lockfiles changed since — rescout",
    );
    expect(threatsSummary(report({ kind: "unscouted", reason: "no lockfile" }))).toBe("no lockfile");
    expect(threatsSummary(undefined)).toBe("Not scouted yet");
  });

  it("ships_capped_at_six_highest_first_with_overflow", () => {
    const sevs: Severity[] = ["low", "moderate", "high", "unknown", "critical", "low", "high", "moderate", "low"];
    const r = raided(sevs.map((s, i) => finding(`F${i}`, s)));
    const { ships, overflow } = shipsFor(r);
    expect(ships).toHaveLength(6);
    expect(overflow).toBe(3);
    expect(ships[0].severity).toBe("critical");
    expect(findingsOf(r)).toHaveLength(9);
    expect(shipsFor(undefined)).toEqual({ ships: [], overflow: 0 });
  });

  it("smoke_needs_a_critical_or_three_highs_and_not_stale", () => {
    expect(hasSmoke(raided([finding("a", "critical")]))).toBe(true);
    expect(hasSmoke(raided([finding("a", "high"), finding("b", "high"), finding("c", "high")]))).toBe(true);
    expect(hasSmoke(raided([finding("a", "high"), finding("b", "high")]))).toBe(false);
    expect(hasSmoke(raided([finding("a", "critical")], { stale: true }))).toBe(false);
    expect(hasSmoke(undefined)).toBe(false);
  });

  it("clean_flag_only_when_clean_and_fresh", () => {
    expect(showsCleanFlag(report({ kind: "clean" }))).toBe(true);
    expect(showsCleanFlag(report({ kind: "clean" }, { stale: true }))).toBe(false);
    expect(showsCleanFlag(raided([finding("a", "low")]))).toBe(false);
    expect(showsCleanFlag(report({ kind: "unscouted", reason: "no scanner" }))).toBe(false);
    expect(showsCleanFlag(undefined)).toBe(false);
  });

  it("under_attack_counts_stale_findings", () => {
    expect(isUnderAttack(raided([finding("a", "low")], { stale: true }))).toBe(true);
    expect(isUnderAttack(raided([]))).toBe(false);
    expect(isUnderAttack(report({ kind: "clean" }))).toBe(false);
    expect(isUnderAttack(undefined)).toBe(false);
  });

  it("raiders_gather_at_manifest_building_or_coast", () => {
    const r = raided([
      finding("a", "low", { lockfile: "Cargo.lock" }),
      finding("b", "high", { lockfile: "web/yarn.lock" }),
    ]);
    const groups = raiderGroups(r, new Set(["Cargo.toml"]));
    const cargo = groups.find((g) => g.manifest === "Cargo.toml")!;
    const web = groups.find((g) => g.manifest === "web/package.json")!;
    expect(cargo.anchorPath).toBe("Cargo.toml");
    expect(web.anchorPath).toBeNull();
    expect(groups[0]).toBe(web); // worst group first
    expect(web.worst).toBe("high");
  });

  it("manifest_mapping_mirrors_rust", () => {
    expect(manifestForLockfile("package-lock.json")).toBe("package.json");
    expect(manifestForLockfile("pnpm-lock.yaml")).toBe("package.json");
    expect(manifestForLockfile("a/b/poetry.lock")).toBe("a/b/pyproject.toml");
    expect(manifestForLockfile("go.sum")).toBe("go.mod");
    expect(manifestForLockfile("x/Gemfile.lock")).toBe("x/Gemfile");
    expect(manifestForLockfile("weird.lock")).toBe("weird.lock");
  });

  it("defend_prompt_lists_each_finding_and_names_worktree", () => {
    const fs = [
      finding("GHSA-1", "critical", { package: "lodash", installed: "4.0.0", fixed_in: "4.17.21", summary: "Pollution" }),
      finding("GHSA-2", "low", { package: "atty", installed: null, fixed_in: null, summary: "Unsound", lockfile: "Cargo.lock" }),
    ];
    const p = defendPrompt("/p/a", fs, "/p/a-wt");
    expect(p).toContain("- critical GHSA-1 in lodash@4.0.0 (fix: 4.17.21) — Pollution [package-lock.json]");
    expect(p).toContain("- low GHSA-2 in atty (fix: none known) — Unsound [Cargo.lock]");
    expect(p).toContain("/p/a-wt");
    expect(p).toMatch(/run the project's tests/);
    expect(defendPrompt("/p/a", fs, "/p/a")).not.toContain("worktree");
    expect(defendPrompt("/p/a", fs, null)).not.toContain("worktree");
  });

  it("sunk_findings_are_those_gone_after_rescout", () => {
    const a = finding("A", "high");
    const b = finding("B", "low");
    expect(sunkFindings(raided([a, b]), raided([b])).map((f) => f.id)).toEqual(["A"]);
    expect(sunkFindings(undefined, raided([b]))).toEqual([]);
    // Same id in a different lockfile is a different finding.
    expect(sunkFindings(raided([a]), raided([{ ...a, lockfile: "Cargo.lock" }]))).toEqual([a]);
  });

  it("sunk_findings_ignore_unscouted_or_stale_rescouts", () => {
    const a = finding("A", "high");
    const before = raided([a]);
    expect(sunkFindings(before, report({ kind: "unscouted", reason: "x" }))).toEqual([]);
    expect(sunkFindings(before, report({ kind: "clean" }, { stale: true }))).toEqual([]);
    expect(sunkFindings(before, report({ kind: "clean" }))).toEqual([a]);
  });

  it("under_attack_filter_matches_only_raided_islands", () => {
    expect(matchesStateFilter("stopped", "under_attack", true)).toBe(true);
    expect(matchesStateFilter("stopped", "under_attack", false)).toBe(false);
    expect(matchesStateFilter(null, "under_attack")).toBe(false);
    expect(matchesStateFilter("working", "all", false)).toBe(true);

    const sea = (root: string): SeaIsland => ({
      view: { root, name: root.slice(1), plot: { x: 0, z: 0, w: 1, d: 1 },
        city: { status: "unknown", reason: "" }, last_changed_at: null },
      attention: null, agents: [],
    });
    const raids = new Map([["/hit", raided([finding("a", "low")], { root: "/hit" })],
      ["/ok", report({ kind: "clean" }, { root: "/ok" })]]);
    expect(isSeaIslandMatch(sea("/hit"), "", "under_attack", raids)).toBe(true);
    expect(isSeaIslandMatch(sea("/ok"), "", "under_attack", raids)).toBe(false);
    expect(isSeaIslandMatch(sea("/none"), "", "under_attack", raids)).toBe(false);
    expect(findBestSeaIslandMatch([sea("/ok"), sea("/hit")], "h", "under_attack", raids)?.view.root).toBe("/hit");
  });
});
