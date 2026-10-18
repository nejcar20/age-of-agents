import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Archipelago, IslandView } from "./archipelago";

/**
 * The archipelago's own fetch state, kept separate from `useWorld`'s: unlike
 * the world (pushed live by herdr over `world-updated`), `get_archipelago`
 * is a request/response command with real, measurable cost on a cold cache
 * (~450ms across the author's five real repositories — see
 * `archipelago-layout-report.md`), so this is deliberately a plain fetch,
 * never something re-run on every world tick.
 *
 * CRITICAL 4 (Opus frontend review): a `ready` state can now ALSO carry
 * `staleError`/`staleSince` — see `useArchipelago`'s own doc comment for why.
 * Before this, a refresh failure after a successful fetch had nowhere to put
 * the error at all (`ArchipelagoFetchState` had no field for it), so the
 * catch below silently rendered the OLD list as though it were current: an
 * alt-tab back after deleting a repo would keep showing an island that no
 * longer exists, with no indication anything had gone wrong.
 */
export type ArchipelagoFetchState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      islands: IslandView[];
      /** Present only when `islands` is STALE — the most recent refresh
       * attempt failed, and this is the last successful response, not a
       * fresh one. Absent (never present-but-`null`) when `islands` IS the
       * most recent successful fetch, so a caller can branch on the key's
       * mere presence (`"staleError" in state`) rather than a value. */
      staleError?: string;
      /** Unix-seconds timestamp of the fetch that actually produced
       * `islands` — set whenever `staleError` is, so a caller can say WHEN
       * the stale list is from, not just that it's stale. */
      staleSince?: number;
    };

export type ArchipelagoHook = ArchipelagoFetchState & {
  /**
   * Manually re-fetches — beyond mount and window-focus, there is one more
   * honest moment worth an explicit rescan: right after `create_project`
   * (Item 4 of the actions-UI round) succeeds. A brand-new repository has
   * no live-push channel the way an agent's own status does
   * (`world-updated`), so without this the new island would sit invisible
   * until the user happened to alt-tab away and back. This is still never a
   * LOCAL fabrication of the new island — it asks the real backend again,
   * the same request `get_archipelago` always makes, just triggered at a
   * moment the mount/focus heuristic can't see on its own.
   */
  refetch: () => void;
};

/**
 * Fetches the archipelago once on mount, again whenever the window regains
 * focus — the same "the user could plausibly have changed something outside
 * the app" moment `UnsettledList`'s own rescan-on-focus already uses
 * (`founding.ts`'s `shouldRescan`) — and on demand via `refetch` (see its
 * own doc comment above). Deliberately NOT re-fetched on every
 * `world-updated` event — that was the exact mistake
 * `phase-0-followups.md` §5a records fixing for the unsettled list (~279
 * filesystem scans in 15 seconds), and this command is markedly more
 * expensive per call than that one.
 *
 * A failed refresh keeps the last good `islands` on screen rather than
 * blanking the sea — the same "known-good data outlives a transient error"
 * principle `founding.ts`'s `listStatus` documents. CRITICAL 4 (Opus
 * frontend review): keeping the data is right; DROPPING the error was not.
 * `ArchipelagoFetchState` used to have nowhere to put it, so this catch
 * silently rendered a stale list as current — the "stale list presented as
 * current" family this branch had already shipped once elsewhere. The error
 * (and when the surviving data is actually from) now travels alongside
 * `islands` on the SAME `ready` state, rather than being dropped, so
 * `App.tsx` can show it.
 *
 * Opus review (ITEM 2): mount + window-focus fired `get_archipelago` with no
 * in-flight guard, and Tauri runs commands concurrently — alt-tabbing
 * repeatedly during a scan queued up overlapping full 152-repository scans
 * (each spawning up to 32 threads), now serialized behind a per-path lock on
 * the Rust side rather than corrupting the cache, but still wasted work and
 * latency on the app's opening screen. An in-flight flag drops a
 * focus/`refetch()` call that arrives while a scan is already running rather
 * than firing a second overlapping one. It does NOT drop it silently,
 * though: a pending-refetch flag remembers that a call arrived mid-scan and
 * fires exactly ONE trailing refetch once the in-flight one settles. This
 * is deliberate, not just "avoid wasting a call" — a focus event mid-scan
 * means the user alt-tabbed back to the app WHILE a scan was already
 * running, which can only mean they plausibly changed something (switched
 * to a terminal, committed, ran an agent) after that scan had already read
 * the filesystem; showing its result as final without one more look would
 * silently present pre-change data as current, the same "stale-presented-
 * as-current" failure `staleError` above exists to avoid on the error path.
 * Multiple focus events during one scan collapse into a single trailing
 * refetch (a boolean flag, not a queue) — the point is "look again once
 * more," not "look again once per event."
 *
 * BUG (traced against commit `51fe06c`, fixed here): the in-flight and
 * pending-refetch flags used to live in refs, which survive React
 * StrictMode's dev mount -> cleanup -> remount — but the guard is meant to
 * be per-effect-instance state ("is THIS mount's scan running right now"),
 * not state that outlives the effect. Mount 1 would set the ref `true` and
 * issue its invoke; cleanup never reset it; mount 2's `fetchIt` would then
 * see it still `true`, set the pending flag, and return WITHOUT invoking.
 * When mount 1's invoke finally resolved, its epoch no longer matched (mount
 * 2 had bumped `epochRef`), so both the `setState` and the trailing-refetch
 * check bailed — no fetch was ever associated with the live mount, and the
 * hook sat in `loading` forever (the sea never loaded on launch in dev; it
 * only self-healed once a later `focus` event happened to line up with the
 * live epoch). The fix: both flags are now `let`s captured in this effect's
 * own closure instead of `useRef`s, so a fresh mount always starts with its
 * own clean `false`/`false` — a stale effect instance's `.finally` can still
 * run late, but it only ever touches ITS OWN closure's flags, never the live
 * mount's. (Resetting the old refs in the cleanup function was considered
 * and rejected: the stale invoke's `.finally` still shares the same ref as
 * the live mount, so it could clear `inFlightRef` to `false` WHILE the live
 * mount's own invoke is genuinely in flight, letting a focus event during
 * that window slip a second overlapping invoke past the guard.)
 */
export function useArchipelago(): ArchipelagoHook {
  const [state, setState] = useState<ArchipelagoFetchState>({ kind: "loading" });
  // Guards against a stale response landing after a remount (React
  // StrictMode's dev double-mount) the same way `useWorld`'s own `state`
  // variable and `UnsettledList`'s `epochRef` do.
  const epochRef = useRef(0);
  const lastGoodRef = useRef<IslandView[] | null>(null);
  // When `lastGoodRef` was actually fetched — the honest "as of" timestamp a
  // stale-with-error banner needs (see `staleSince`'s own doc comment).
  const lastGoodAtRef = useRef<number | null>(null);
  const fetchRef = useRef<() => void>(() => {});

  useEffect(() => {
    const epoch = ++epochRef.current;
    // Both scoped to THIS effect instance (fresh `false`/`false` on every
    // mount, including StrictMode's dev double-mount) rather than `useRef`s
    // — see the in-flight-guard doc comment above for why a ref here was the
    // bug. A stale effect instance's `.finally` can still run after this
    // mount has taken over, but it only ever reads/writes ITS OWN closure's
    // `inFlight`/`pendingRefetch`, so it can never suppress or falsely clear
    // the live mount's guard.
    let inFlight = false;
    let pendingRefetch = false;

    const fetchIt = () => {
      if (inFlight) {
        pendingRefetch = true;
        return;
      }
      inFlight = true;
      invoke<Archipelago>("get_archipelago")
        .then((a) => {
          if (epoch !== epochRef.current) return;
          lastGoodRef.current = a.islands;
          lastGoodAtRef.current = Math.floor(Date.now() / 1000);
          setState({ kind: "ready", islands: a.islands });
        })
        .catch((e) => {
          if (epoch !== epochRef.current) return;
          // A failed refresh after a successful one still has real data to
          // show — keep it, but never as though nothing happened: the error
          // and the real age of that data travel WITH it.
          if (lastGoodRef.current) {
            setState({
              kind: "ready",
              islands: lastGoodRef.current,
              staleError: String(e),
              staleSince: lastGoodAtRef.current ?? undefined,
            });
          } else {
            setState({ kind: "error", message: String(e) });
          }
        })
        .finally(() => {
          inFlight = false;
          // Never re-fire into an effect that has already been cleaned up
          // (the epoch guard above already protects `setState`; this
          // protects against issuing a whole new `invoke` after unmount).
          if (epoch === epochRef.current && pendingRefetch) {
            pendingRefetch = false;
            fetchIt();
          }
        });
    };

    fetchRef.current = fetchIt;
    fetchIt();
    window.addEventListener("focus", fetchIt);
    return () => {
      epochRef.current += 1;
      window.removeEventListener("focus", fetchIt);
    };
  }, []);

  const refetch = useCallback(() => fetchRef.current(), []);

  return { ...state, refetch };
}
