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
  scoutIsland(root: string): Promise<void>;
  previous: Map<string, RaidReport>;
} {
  const [reports, setReports] = useState<Map<string, RaidReport>>(new Map());
  const [previous, setPrevious] = useState<Map<string, RaidReport>>(new Map());
  const [scanners, setScanners] = useState<RaidScanners | null>(null);
  const [scouting, setScouting] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read inside the event handler without re-subscribing on every change.
  const scoutingRef = useRef(false);
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
        setReports((current) => {
          const next = new Map(current);
          for (const r of list) if (!next.has(r.root)) next.set(r.root, r);
          return next;
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
      setReports((current) => {
        const old = current.get(report.root);
        if (old) setPrevious((p) => new Map(p).set(report.root, old));
        return new Map(current).set(report.root, report);
      });
      if (scoutingRef.current) {
        setScouting((s) => (s ? { ...s, done: s.done + 1 } : s));
      }
    });
    const unlistenDone = listen("raid-scout-done", () => {
      if (!live()) return;
      scoutingRef.current = false;
      setScouting(null);
    });

    return () => {
      epochRef.current += 1;
      unlistenReport.then((f) => f());
      unlistenDone.then((f) => f());
    };
  }, []);

  const scoutAll = useCallback(async () => {
    setError(null);
    try {
      const total = await invoke<number>("scout_all");
      scoutingRef.current = true;
      setScouting({ done: 0, total });
    } catch (e) {
      // Keep `scouting` as it was (null) — nothing started, or one is already
      // running and its own progress stays authoritative.
      setError(String(e));
    }
  }, []);

  const scoutIsland = useCallback(async (root: string) => {
    setError(null);
    try {
      // The result also arrives as a `raid-report` event, which is what
      // updates state; awaiting here is only for error reporting.
      await invoke<RaidReport>("scout_island", { root });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  return { reports, scanners, scouting, error, scoutAll, scoutIsland, previous };
}
