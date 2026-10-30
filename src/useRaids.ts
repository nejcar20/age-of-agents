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
 * `stale` is only ever computed by `raid_reports` (from the lockfiles on
 * disk at that moment), so the reports are read again whenever the window
 * regains focus — the moment a lockfile edited elsewhere could have changed —
 * with the same in-flight/epoch discipline as `useArchipelago`. (The
 * archipelago itself refreshes on that same focus, and on founding a
 * project, which has no report yet: hooking its refresh too would only
 * read the same reports twice.) A refetch never touches `previous`: it
 * re-scouted nothing.
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
  /** Asks the backend again which scanners are installed. */
  refreshScanners(): void;
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
  const fetchScannersRef = useRef<() => void>(() => {});

  useEffect(() => {
    const epoch = ++epochRef.current;
    const live = () => epoch === epochRef.current;

    // Per-effect-instance, like `useArchipelago`'s (see its doc comment for
    // why these must not be refs).
    let inFlight = false;
    let pendingRefetch = false;
    const fetchReports = () => {
      if (inFlight) {
        pendingRefetch = true;
        return;
      }
      inFlight = true;
      invoke<RaidReport[]>("raid_reports")
        .then((list) => {
          if (!live()) return;
          setData((current) => {
            const reports = mergeFetched(current.reports, list);
            return reports === current.reports ? current : { ...current, reports };
          });
        })
        .catch((e) => {
          if (live()) setError(String(e));
        })
        .finally(() => {
          inFlight = false;
          if (live() && pendingRefetch) {
            pendingRefetch = false;
            fetchReports();
          }
        });
    };
    const fetchScanners = () => {
      invoke<RaidScanners>("raid_scanners")
        .then((s) => {
          if (live()) setScanners(s);
        })
        .catch((e) => {
          if (live()) setError(String(e));
        });
    };
    fetchScannersRef.current = fetchScanners;
    fetchReports();
    fetchScanners();
    window.addEventListener("focus", fetchReports);

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
      window.removeEventListener("focus", fetchReports);
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

  // Which scanners are installed can change while the app is open
  // (`brew install osv-scanner`); the scout sheet asks again on opening.
  const refreshScanners = useCallback(() => fetchScannersRef.current(), []);

  return { reports, scanners, scouting, error, scoutAll, scoutIsland, previous, refreshScanners };
}

/** Folds a `raid_reports` answer into the held reports. A fetched report
 * replaces the held one only when it is at least as new (`scanned_at`), so a
 * refetch can flip `stale` while an event-delivered report that is newer
 * than the fetch (it landed while the fetch was in flight) always wins. An
 * unchanged report keeps its identity, and nothing changed returns `held`
 * itself, so a routine refocus re-renders nothing. */
function mergeFetched(held: Map<string, RaidReport>, list: RaidReport[]): Map<string, RaidReport> {
  let next: Map<string, RaidReport> | null = null;
  for (const r of list) {
    const old = held.get(r.root);
    if (old && (r.scanned_at < old.scanned_at || (r.scanned_at === old.scanned_at && r.stale === old.stale))) {
      continue;
    }
    next ??= new Map(held);
    next.set(r.root, r);
  }
  return next ?? held;
}
