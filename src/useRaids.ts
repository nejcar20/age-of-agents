import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { RaidReport } from "./raids";

export type RaidScanners = { osv: boolean; npm: boolean };

/**
 * Raid reports for every scouted island. Reports are cached on the backend,
 * so mount just reads them; scans happen only on request (`scoutAll` /
 * `scoutIsland`) and arrive as `raid-report` events, one per finished island.
 *
 * `previous` holds the report each event REPLACED, so a caller can diff the
 * two (`sunkFindings`) and show ships going down. It is only populated by
 * events — the first report an island ever gets has nothing to sink.
 *
 * Outside Tauri there is no special case here: the screenshot harness
 * (`townshot.tsx`) stubs `invoke`/`listen` and serves `fixtures/raids.json`
 * through the same commands, exactly as it does for `get_world`.
 */
export function useRaids(): {
  reports: Map<string, RaidReport>;
  scanners: RaidScanners | null;
  scouting: { done: number; total: number } | null;
  error: string | null;
  scoutAll(): Promise<void>;
  /** Resolves to this scout's own failure message, or `null` on success —
   * so a caller showing one island (the raid panel) can say it failed even
   * where the HUD that shows `error` is not on screen (inside a town). */
  scoutIsland(root: string): Promise<string | null>;
  previous: Map<string, RaidReport>;
} {
  // One state object so `previous` can be derived from `reports` inside a
  // single PURE updater (StrictMode double-invokes updaters; a nested
  // setState there would be a side effect).
  const [data, setData] = useState<{
    reports: Map<string, RaidReport>;
    previous: Map<string, RaidReport>;
  }>({ reports: new Map(), previous: new Map() });
  const { reports, previous } = data;
  const [scanners, setScanners] = useState<RaidScanners | null>(null);
  const [scouting, setScouting] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read inside the event handler without re-subscribing on every change.
  const scoutingRef = useRef(false);
  // Bumped when a scout starts and when it finishes, so a `scout_all`
  // response that arrives after `raid-scout-done` (or after a newer scout)
  // can tell it is no longer the live one and must not touch `scouting`.
  const scoutGenRef = useRef(0);
  // Same dead-mount guard as `useWorld` (StrictMode mount/cleanup/remount).
  const epochRef = useRef(0);

  useEffect(() => {
    const epoch = ++epochRef.current;
    const live = () => epoch === epochRef.current;

    // An event that lands before the initial fetch settles is newer than the
    // fetch; the fetch must only fill islands no event has reported yet.
    invoke<RaidReport[]>("raid_reports")
      .then((list) => {
        if (!live()) return;
        setData((current) => {
          const next = new Map(current.reports);
          for (const r of list) if (!next.has(r.root)) next.set(r.root, r);
          return { ...current, reports: next };
        });
      })
      .catch((e) => {
        if (live()) setError(String(e));
      });
    invoke<RaidScanners>("raid_scanners")
      .then((s) => {
        if (live()) setScanners(s);
      })
      .catch((e) => {
        if (live()) setError(String(e));
      });

    const unlistenReport = listen<RaidReport>("raid-report", (event) => {
      if (!live()) return;
      const report = event.payload;
      setData((current) => {
        const old = current.reports.get(report.root);
        return {
          reports: new Map(current.reports).set(report.root, report),
          previous: old ? new Map(current.previous).set(report.root, old) : current.previous,
        };
      });
      if (scoutingRef.current) {
        setScouting((s) => (s ? { ...s, done: s.done + 1 } : s));
      }
    });
    const unlistenDone = listen("raid-scout-done", () => {
      if (!live()) return;
      scoutingRef.current = false;
      scoutGenRef.current += 1;
      setScouting(null);
    });

    return () => {
      epochRef.current += 1;
      unlistenReport.then((f) => f());
      unlistenDone.then((f) => f());
    };
  }, []);

  const scoutAll = useCallback(async () => {
    // One scout at a time; the backend would reject a second anyway, and
    // rolling back on that rejection must not wipe the live one's progress.
    if (scoutingRef.current) return;
    setError(null);
    // Optimistic, BEFORE invoking: `raid-report`/`raid-scout-done` can be
    // processed before the command's own response, so ordering must not
    // matter. `total` is 0 (unknown) until the response fills it in.
    const gen = ++scoutGenRef.current;
    scoutingRef.current = true;
    setScouting({ done: 0, total: 0 });
    try {
      const total = await invoke<number>("scout_all");
      if (gen !== scoutGenRef.current) return; // already finished
      if (total === 0) {
        // Nothing to scan; `raid-scout-done` may never be seen as live.
        scoutingRef.current = false;
        setScouting(null);
      } else {
        setScouting((s) => (s ? { ...s, total } : s));
      }
    } catch (e) {
      if (gen === scoutGenRef.current) {
        scoutingRef.current = false;
        setScouting(null);
      }
      setError(String(e));
    }
  }, []);

  const scoutIsland = useCallback(async (root: string): Promise<string | null> => {
    setError(null);
    try {
      // The result also arrives as a `raid-report` event, which is what
      // updates state; awaiting here is only for error reporting.
      await invoke<RaidReport>("scout_island", { root });
      return null;
    } catch (e) {
      setError(String(e));
      return String(e);
    }
  }, []);

  return { reports, scanners, scouting, error, scoutAll, scoutIsland, previous };
}
