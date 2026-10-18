import { useEffect, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  displayPath,
  foldFounding,
  INITIAL_FOUNDING_STATE,
  listStatus,
  shouldRescan,
  subtractSettled,
  type Unsettled,
  type UnsettledReport,
} from "../founding";
import { foundSettlement } from "../agents";
import { useAgentKinds } from "../useAgentKinds";
import { FoundingSheet } from "./FoundingSheet";
import type { Island } from "../world";

/**
 * The unsettled-land list.
 *
 * `islands` comes from `App`'s `useWorld()` — the same world the archipelago
 * renders. That is deliberate and is the whole shape of the final review's
 * Critical fix: Rust scans the filesystem and canonicalizes, the world says
 * what already has a workspace, and the subtraction happens right here,
 * once, at render time. Because the world is an input rather than a snapshot
 * taken at fetch time, this list re-derives itself whenever the world
 * changes — no debounced refetch, no optimistic removal, no session-long
 * memo of founded paths.
 */
export function UnsettledList({ islands }: { islands: Island[] }) {
  // `null` until a real `list_unsettled` answer has arrived. It is NOT
  // seeded with an empty report: an empty report is a positive claim
  // ("nothing is out there", "no directories configured", "the agent is
  // claude") and principle 4 forbids stating any of that as fact before we
  // know it. See `error` below.
  const [report, setReport] = useState<UnsettledReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, dispatch] = useReducer(foldFounding, INITIAL_FOUNDING_STATE);
  // Item 4 (terminal-polish round): the founding sheet now offers the same
  // kind picker the settled path has always had, fed by the same
  // `agent_kinds()`. The sheet still OPENS on `report.default_agent` —
  // herdr's own answer for this machine, and the same value
  // `agent_kinds()[0]` carries (pinned in Rust by
  // `every_start_an_agent_path_resolves_the_same_default_agent`) — so a
  // sheet opened before this resolves names the right agent and simply
  // shows no picker until it does, rather than a menu of guesses.
  const kindsState = useAgentKinds();
  // When the last scan finished, for `shouldRescan`'s staleness check and
  // for the "scanned at" line below. A ref because the `focus` listener is
  // attached once (mount effect, `[]` deps) and must always see the latest
  // value rather than the one captured when it was attached; mirrored into
  // state purely so the "scanned at" text re-renders after a scan.
  const lastScanAtRef = useRef(0);
  const [lastScanAt, setLastScanAt] = useState<number | null>(null);
  // A generation counter, bumped on every effect (re)run and on unmount.
  // `scan` can now be triggered from three places — mount, the `focus`
  // listener, and the manual button — so a single `cancelled` local scoped
  // to one effect invocation (`useWorld.ts`'s pattern) is not enough on its
  // own: `useWorld.ts`'s own comment is explicit that a guard must never
  // leak from one mount instance into another, which is exactly what would
  // happen here in React StrictMode's dev double-mount if a plain
  // `mountedRef` boolean were flipped back to `true` by the second mount
  // while the FIRST mount's now-stale scan is still in flight. Capturing
  // the current epoch at call time and comparing it when the promise
  // resolves gives every scan — from any of the three triggers, in any
  // mount instance — the same never-apply-a-stale-result guarantee.
  const epochRef = useRef(0);
  // Fix round 1, Minor: two scans can be in flight at once under the SAME
  // epoch — a manual click while a `focus` scan is still resolving — and
  // network/IPC ordering does not guarantee the one issued first resolves
  // first. Without a sequence number, an earlier-issued response arriving
  // second would silently overwrite a later, more current one. `seqRef`
  // hands out a strictly increasing number per `scan()` call; `appliedSeqRef`
  // records the highest sequence actually applied so far. A response whose
  // sequence is older than what is already applied is dropped, regardless
  // of whether it succeeded or failed — an old failure arriving after a
  // newer success has already rendered must not regress the UI backward
  // either.
  const seqRef = useRef(0);
  const appliedSeqRef = useRef(0);

  const scan = () => {
    const epoch = epochRef.current;
    const seq = ++seqRef.current;
    invoke<UnsettledReport>("list_unsettled")
      .then((r) => {
        if (epoch !== epochRef.current || seq < appliedSeqRef.current) return;
        appliedSeqRef.current = seq;
        setReport(r);
        setError(null);
        dispatch({ kind: "reposLoaded", repos: r.repos });
        const now = Date.now();
        lastScanAtRef.current = now;
        setLastScanAt(now);
      })
      .catch((e) => {
        if (epoch !== epochRef.current || seq < appliedSeqRef.current) return;
        appliedSeqRef.current = seq;
        // IMPORTANT 2 (final whole-branch review): the old code set
        // `loaded = true` and left an empty report in place, so a FIRST
        // failure rendered "no directories to look in" and "No directories
        // are configured to scan" — two confident statements about a scan
        // that never ran. An error is not an empty result; say what
        // failed, and say we do not know what is out there.
        //
        // Fix round 1, Critical: this used to be the only place `error` was
        // ever written, and it had exactly one reader — the branch below
        // guarded by `report === null` — so once a report had loaded once,
        // every later failure set this and nothing downstream ever looked
        // at it again. `error` is now read unconditionally by `listStatus`
        // regardless of whether `report` is null, so a rescan failure after
        // a successful scan is surfaced instead of silently swallowed.
        setError(String(e));
      });
  };

  useEffect(() => {
    epochRef.current += 1; // a fresh mount instance invalidates any scan still in flight from a prior one
    // Mount always scans — `shouldRescan("mount", ...)` is unconditionally
    // true, since there is no prior scan to compare against yet.
    scan();

    // The fix for the Phase 0.5a review's one required-before-daily-use
    // item: a repo cloned while the app is open never appeared until Herdr
    // disconnected and the component remounted. `focus` is the honest
    // moment to check again — the user just came back from wherever they'd
    // plausibly have run `git clone` or `git init`. It is deliberately NOT
    // `world-updated`: the previous implementation refetched on every world
    // update and caused ~279 filesystem scans in 15 seconds, because Herdr
    // pushes far more world updates than the unsettled set actually
    // changes. `shouldRescan` gates `focus` on staleness so alt-tab churn
    // does not re-walk the filesystem on every click.
    const onFocus = () => {
      if (shouldRescan("focus", lastScanAtRef.current, Date.now())) scan();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      epochRef.current += 1; // invalidate anything this instance still has in flight
      window.removeEventListener("focus", onFocus);
    };
    // Mount-only, on purpose: `scan` closes over refs and stable setters, so
    // it never goes stale even though it is not in this dependency array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rescan = () => {
    if (shouldRescan("manual", lastScanAtRef.current, Date.now())) scan();
  };

  // Both openers pass the kind the sheet starts on explicitly — see
  // `FoundingAction`'s own note on why the reducer is never allowed to
  // invent one.
  const openSheet = (repo: Unsettled) =>
    dispatch({ kind: "openSheet", repo, agentKind: initialAgentKind() });

  /** What the sheet opens preselected on: herdr's own resolved default for
   * this machine when a scan has reported one, and `agent_kinds()[0]` (the
   * same value, from the other command that knows it) as the fallback. */
  const initialAgentKind = (): string => {
    if (report !== null) return report.default_agent;
    return kindsState.status === "ready" ? (kindsState.kinds[0] ?? "") : "";
  };

  const browse = async () => {
    const dir = await open({ directory: true });
    if (typeof dir !== "string") return; // cancelled
    // MINOR (final whole-branch review): the dialog hands back a RAW path,
    // which on macOS routinely reaches a repo through a symlink (`/tmp`, an
    // iCloud/Dropbox mount, a symlinked `~/code`). The webview cannot
    // canonicalize, so Rust does it — the same `normalize_path` every
    // scanned path and every pane cwd goes through. Without this, a browsed
    // repo that already has a workspace would never match `subtractSettled`
    // or the backend guard, and the user would be offered a confirm sheet
    // for a second founding.
    const path = await invoke<string>("canonical_path", { path: dir });
    const name = path.split("/").filter(Boolean).pop() ?? path;
    openSheet({ path, name });
  };

  const found = async () => {
    // Guards against a double click (or a second event) issuing a second
    // `found_settlement` call while the first is still in flight —
    // `foldFounding`'s own `foundingStarted` case repeats this guard so the
    // invariant holds even if a caller forgets this line.
    if (state.sheet === null || state.sheet.founding) return;
    const { repo, startAgent, agentKind } = state.sheet;
    dispatch({ kind: "foundingStarted" });
    try {
      // The kind the sheet just printed, passed explicitly (Item 4) — not
      // left to the backend's fallback, which would be a second opinion on
      // a question the user has now answered themselves.
      const founded = await foundSettlement(repo.path, startAgent, agentKind);
      // `agent_name` is what the backend ACTUALLY sent to herdr, which is
      // the only thing worth reporting: the sheet's `name=` line was a
      // prediction made before the call (herdr cannot reserve a name).
      dispatch({
        kind: "foundingSucceeded",
        workspaceId: founded.workspace_id,
        agentName: founded.agent_name,
      });
    } catch (error) {
      // Shown INSIDE the sheet (see the render below), not in a status line
      // elsewhere on the page — `.sheet` is a `position: fixed` overlay that
      // paints on top of everything else regardless of DOM order, so an
      // error rendered outside it is invisible while the sheet is open.
      // Shown verbatim, including the "workspace was created, but the agent
      // did not start" case from the backend — that message already says the
      // workspace exists, so it must reach the user unedited (principle 4).
      dispatch({ kind: "foundingFailed", error: String(error) });
    }
  };

  // Fix round 1, Critical: the two null-report branches below (`loading`,
  // `error-no-data`) and the fact that `report` can no longer be trusted as
  // "and therefore nothing is wrong" are both decided by `listStatus`, a
  // pure function, rather than re-derived ad hoc here — see its doc comment
  // in `founding.ts` for why a report plus an error must render as
  // `stale-with-error`, never fall through to the same markup as `ok`.
  const status = listStatus({ report, error, lastScanAt });

  if (status.kind === "loading") return null;

  if (status.kind === "error-no-data") {
    // No `browse…` and no confirm sheet here, on purpose: the sheet names
    // the agent `found_settlement` will start, and the only honest source
    // for that name is a real report. Offering the sheet with a fabricated
    // `default_agent` of "claude" would show `agent.start name="claude"`
    // while the backend started `codex` — a confirm sheet that names a call
    // other than the one that runs is a principle-1 breach and defeats the
    // point of plumbing `default_agent` through at all.
    return (
      <section className="unsettled">
        <div className="unsettled__header">
          <h2>Unsettled — no herdr workspace yet</h2>
          <button type="button" className="unsettled__rescan" onClick={rescan}>
            rescan
          </button>
        </div>
        <p className="unsettled__error" role="alert">
          Could not scan for repositories, so we do not know what is out there: {status.error}
        </p>
      </section>
    );
  }

  // Only `ok` and `stale-with-error` remain, and both require a real report
  // (see `listStatus`'s four cases) — this is just proving that to the type
  // checker, since `status` and `report` are tracked as separate state.
  if (report === null) return null;

  const visible = subtractSettled(state.repos, islands);
  const rootsShown = report.roots.map((r) => displayPath(r, report.home)).join(", ");
  const rootsLine = report.roots.length > 0 ? `looked in ${rootsShown}` : "no directories to look in";

  return (
    <section className="unsettled">
      <div className="unsettled__header">
        <h2>Unsettled — no herdr workspace yet</h2>
        <button type="button" className="unsettled__rescan" onClick={rescan}>
          rescan
        </button>
      </div>
      {/* start-agent-anywhere round: this list's rows have always opened
          the found-a-settlement sheet, and nothing on screen said that was
          how you start an agent in a repo that has no workspace yet — the
          exact gap the author hit trying to start an agent in one). One line, naming the action and its extra step, so the
          HUD list speaks the same language as the island panel's own
          "Start agent…" button. */}
      <p className="unsettled__lede">
        Pick one to start an agent in it — its herdr workspace is created first.
      </p>
      <p className="unsettled__roots">
        {rootsLine}
        {/* Design note: a visible rescan control is an honest affordance —
            it tells the user scanning is a thing that happens at a moment,
            not a mystery process they have no reason to trust after cloning
            a new repo. Naming that moment here is the other half of it.
            Fix round 1, Critical: labeled "last successful scan", not
            "scanned at" — the value is frozen at the last SUCCESSFUL scan
            and does not advance on a failed rescan, so a generic "scanned
            at" label would read as current when it may not be. */}
        {lastScanAt !== null && (
          <> · last successful scan at {new Date(lastScanAt).toLocaleTimeString()}</>
        )}
      </p>

      {status.kind === "stale-with-error" && (
        // Fix round 1, Critical: the whole point of this branch. Without
        // it, a rescan failure after a successful scan was invisible — the
        // old list stayed on screen next to a frozen timestamp, which reads
        // as current and is not. The list itself stays visible (still the
        // best information available; principle 4 asks for honesty, not
        // discarding known-good data), but the most recent attempt to
        // refresh it must be named as having failed.
        <p className="unsettled__error" role="alert">
          Last rescan failed, so this list may be out of date: {status.error}
        </p>
      )}

      {state.lastFounded !== null && (
        // Named for the thing that was actually created, not for the
        // metaphor, so the outcome line matches the sheet that produced it
        // ("Create workspace & start agent"). The id is herdr's own
        // workspace id, verbatim.
        // The agent's name is herdr's own handle for it and the string the
        // author reads in herdr's list, so the outcome names it — and names
        // the one that was ACTUALLY used, not the one the sheet predicted.
        <p className="unsettled__outcome">
          created workspace {state.lastFounded}
          {state.lastAgentName !== null && <> — agent {state.lastAgentName}</>}
        </p>
      )}

      {visible.length === 0 ? (
        <p className="empty">
          {report.roots.length > 0
            ? `No unsettled repos found under ${rootsShown}. Try "browse…" to pick a folder directly.`
            : 'No directories are configured to scan. Try "browse…" to pick a folder directly.'}
        </p>
      ) : (
        <ul className="unsettled__list">
          {visible.map((repo) => (
            <li key={repo.path}>
              <button type="button" className="unsettled__row" onClick={() => openSheet(repo)}>
                <span className="unsettled__name">{repo.name}</span>
                <span className="unsettled__path">{displayPath(repo.path, report.home)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <button type="button" className="unsettled__browse" onClick={browse}>
        browse…
      </button>

      {state.sheet !== null && (
        <FoundingSheet
          sheet={state.sheet}
          kindsState={kindsState}
          onChooseAgentKind={(agentKind) => dispatch({ kind: "chooseAgentKind", agentKind })}
          onToggleStartAgent={() => dispatch({ kind: "toggleStartAgent" })}
          onCancel={() => dispatch({ kind: "closeSheet" })}
          onConfirm={found}
        />
      )}
    </section>
  );
}
