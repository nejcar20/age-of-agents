import { invoke } from "@tauri-apps/api/core";

/**
 * Thin, centralized wrappers around the new Tauri commands this round adds
 * (`start_agent`, `agent_kinds`, `create_project`, `focus_workspace`) — one
 * place to adapt if a signature differs once the Rust side actually lands,
 * per the coordinator's own instruction ("build against this contract; if a
 * signature differs when it lands, adapt"). Every caller in this codebase
 * goes through these functions rather than calling `invoke` directly, so a
 * rename or a parameter-shape change is a one-line fix here instead of a
 * hunt through every button.
 */

/**
 * The agent kinds this herdr actually accepts, configured default first —
 * never hardcoded here, so the choice cannot silently rot (the
 * coordinator's own wording) if the user reconfigures or a new kind is
 * added on the herdr side.
 */
export function agentKinds(): Promise<string[]> {
  return invoke<string[]>("agent_kinds");
}

/**
 * Starts a new agent for a repository that already has a workspace, or
 * creates one first if it doesn't (additive: a repo may run several
 * agents). Returns the new pane id.
 *
 * `resume` (Item 8, second coordinator round) asks the agent to resume its
 * previous conversation rather than start fresh — meaningful only for a
 * kind `resumable_agent_kinds()` actually lists; the confirm sheet
 * (`StartAgentSheet`) is what enforces that the toggle exists only when the
 * backend already verified a real resume flag for that kind, so this
 * function itself does no gating — it just forwards whatever the sheet
 * decided.
 *
 * Deliberately does NOT update any local state on success — Item 6's (first
 * round) honesty rule, carried into this round: the new villager must come
 * from the real `world-updated` push once herdr actually reports the pane,
 * never from the frontend assuming its own call worked.
 */
export function startAgent(root: string, kind: string | undefined, resume: boolean): Promise<string> {
  return invoke<string>("start_agent", { root, kind, resume });
}

/**
 * The NAME an agent started in `root` will be given — herdr's own globally
 * unique handle for it, which is NOT the same thing as its kind.
 *
 * Read-only on the backend (a single `agent.list`), so a confirm sheet may
 * call it merely from being opened without violating spec §5.6's "nothing
 * runs until the confirm button" rule.
 *
 * WHY THIS EXISTS. Every `agent.start` this app made used to pass the kind
 * as the name. herdr requires names to be globally unique and refuses a
 * duplicate outright, so the first `claude` claimed the name `claude` for
 * the whole herdr session and every later start failed with
 * `agent_name_taken` — four orphaned workspaces on the author's machine
 * before anyone noticed. Rust now derives a name from the repository and
 * checks it against `agent.list`; this command is how the sheet prints the
 * real one instead of a paraphrase.
 *
 * The answer is a snapshot: herdr has no way to reserve a name, so a name
 * free now can in principle be claimed before the user confirms. Rust
 * resolves again at call time with the same function and returns what it
 * actually used (`FoundedSettlement.agent_name`).
 */
export function proposedAgentName(root: string): Promise<string> {
  return invoke<string>("proposed_agent_name", { root });
}

/** The agent kinds whose resume flag herdr has actually verified (e.g.
 * `claude --resume`, `codex resume`) — never every kind `agent_kinds()`
 * lists. The coordinator's own instruction: a kind absent here must not get
 * a resume toggle that looks available but silently does nothing. */
export function resumableAgentKinds(): Promise<string[]> {
  return invoke<string[]>("resumable_agent_kinds");
}

/**
 * Submits a prompt to a running agent's pane via Herdr's `agent.prompt` —
 * spec §5.6's Phase 0.6 write, sanctioned specifically because it is
 * Herdr's own submission primitive (defined semantics, state waiting), not
 * raw keystroke injection. Every call here must be a prompt the user
 * personally composed and deliberately sent — never originated, re-sent, or
 * auto-retried by this app (§5.6's own non-negotiable list).
 *
 * `expectedRoot` (security-review round): the island's `root` the prompt
 * was composed for. Herdr recycles `w<N>:p1`-style pane ids once a
 * workspace closes, so a stale pane id this frontend is still holding could
 * otherwise deliver the user's prompt to a different agent in a different
 * repository, silently, with a success response. Passing it lets Rust
 * refuse a mismatch (`validate_send_prompt`) instead of misdelivering.
 * Every real caller has an island in hand and should pass it; it stays
 * optional only because Rust's own signature allows omitting it.
 */
export function sendPrompt(paneId: string, text: string, expectedRoot?: string): Promise<void> {
  return invoke("send_prompt", { paneId, text, expectedRoot });
}

/**
 * Reads an agent's recent terminal output — the read-only `agent.read` half
 * of the same Phase 0.6 authorization. A SNAPSHOT taken at call time, never
 * a live tail (see `AgentActions`'s own doc comment for why this must never
 * be polled at sea level).
 *
 * Returns `{ text, truncated }` (security review, MINOR 5): `truncated`
 * used to be spliced as literal text ahead of the agent's own untrusted
 * output, indistinguishable from something the agent itself printed (and an
 * agent could print that exact sentence). Callers must render `truncated`
 * as their own UI affordance and never concatenate it back into `text`.
 */
export function readAgent(paneId: string, lines?: number): Promise<{ text: string; truncated: boolean }> {
  return invoke<{ text: string; truncated: boolean }>("read_agent", { paneId, lines });
}

/**
 * Creates a brand-new project: makes the directory, `git init`s it, creates
 * its herdr workspace, and — if `withAgent` — starts an agent in it.
 *
 * Returns `{ path, undiscoverable_reason }` (security review): `path` is
 * the canonical path of the new repository, created in full regardless of
 * `undiscoverable_reason`. `undiscoverable_reason` is `null` when the same
 * scan the archipelago uses will find it (an island will appear), or a
 * human-readable reason when the project is real and fully founded but
 * sits somewhere that scan cannot see — so no island will ever appear for
 * it until the user moves it or widens the scan. Callers MUST surface a
 * non-null reason; silence here reads as "nothing happened" to a user who
 * just watched a project get created.
 *
 * `withAgent` (not `startAgent`, to avoid colliding with this module's own
 * `startAgent` function name) is sent to Rust under the key `startAgent` —
 * Tauri's own camelCase convention for the Rust parameter `start_agent`,
 * the same convention `found_settlement`'s existing `startAgent` argument
 * already uses.
 */
export function createProject(
  parent: string,
  name: string,
  withAgent: boolean,
  kind?: string,
): Promise<{ path: string; undiscoverable_reason: string | null }> {
  return invoke<{ path: string; undiscoverable_reason: string | null }>("create_project", {
    parent,
    name,
    startAgent: withAgent,
    kind,
  });
}

/** What `found_settlement` returns — snake_case verbatim, like every other
 * Tauri payload in this codebase. `pane_id` is the root pane of the new
 * workspace: the one `agent.start` was called on. */
export type FoundedSettlement = {
  workspace_id: string;
  pane_id: string;
  /** The name herdr was actually told to give the agent, or `null` when no
   * agent was started. The after-the-fact truth behind the sheet's
   * prediction — see `proposedAgentName` for the race it closes. */
  agent_name: string | null;
};

/**
 * Creates a herdr workspace for a repository that has none, and — if
 * `startAgent` — starts an agent of `kind` in its root pane.
 *
 * `kind` (terminal-polish round, Item 4) is what the founding sheet's
 * picker chose. It is optional only because the Rust side owns the
 * fallback (`resolved_kind` -> `default_agent`); a caller that has a real
 * choice in hand must always pass it, so the name the sheet printed is the
 * name that runs.
 *
 * Centralized here for the same reason every other command in this module
 * is: this used to be two hand-written `invoke("found_settlement", …)`
 * calls in two components, which is how two callers of one command drift
 * apart when its signature changes. Both go through this now.
 */
export function foundSettlement(
  path: string,
  startAgent: boolean,
  kind?: string,
): Promise<FoundedSettlement> {
  return invoke<FoundedSettlement>("found_settlement", { path, startAgent, kind });
}

/** Raises the terminal hosting a repository's workspace — the island-level
 * counterpart to `focusPane` (which aims at one specific pane). */
export function focusWorkspace(root: string): Promise<void> {
  return invoke("focus_workspace", { root });
}

/**
 * Raises the user's own terminal window on ONE specific pane (herdr's
 * `pane.focus`/`agent.focus`). This LEAVES THE APP, which is why it is only
 * ever reached from a button that says so — see `externalTerminal.ts` for
 * the shared label and wording, and §5.6's town amendment for why it is no
 * longer what a click on a villager silently does.
 *
 * Centralized here like every other command in this module, and for a
 * concrete reason: this one was called by two hand-written
 * `invoke("focus_pane", …)` sites in two components, which is exactly how
 * two callers of one command drift apart.
 *
 * Rust validates `paneId` against the live world before calling herdr (see
 * `commands::focus_pane`), so a stale id herdr has recycled is refused
 * rather than raising the wrong terminal.
 */
export function focusPane(paneId: string): Promise<void> {
  return invoke("focus_pane", { paneId });
}

/**
 * Tells Rust the user has looked at this agent, so a finished one turns
 * from Herdr's filled "done" dot into its hollow "seen" ring. Local to this
 * app — nothing is written to herdr (see `commands::mark_agent_seen`).
 */
export function markAgentSeen(paneId: string): Promise<void> {
  return invoke("mark_agent_seen", { paneId });
}

/**
 * Phase 0.7 (spec §5.6): the interactive terminal's own read primitive.
 * Returns the pane's CURRENT VISIBLE SCREEN, ANSI preserved (Herdr always
 * reads with `source: "visible", format: "ansi"` server-side — see
 * `terminal-backend-report.md`) — a snapshot to be re-rendered whole on
 * every poll, never a stream to append to (`Terminal.tsx`'s own doc comment
 * explains why that distinction matters).
 *
 * `revision` is deliberately NOT part of this return type: the backend
 * measured it live and found it stuck at `0` across every read for a local
 * pane, even as content demonstrably changed (see the backend report's
 * "Change detection" section). Trusting it would mean the mirror silently
 * stops updating forever after the first paint, so callers must diff `text`
 * themselves — `Terminal.tsx` does exactly that.
 */
export function readPane(
  paneId: string,
  expectedRoot?: string,
): Promise<{ text: string; truncated: boolean }> {
  return invoke<{ text: string; revision: number; truncated: boolean }>("pane_read", {
    paneId,
    expectedRoot,
  }).then(({ text, truncated }) => ({ text, truncated }));
}

/**
 * Terminal-feel round: the pane's SCROLLBACK (`pane.read` with `source:
 * "recent"`), read once when the user scrolls up — never on the poll loop.
 * Same read-only tier and same `expected_root` discipline as `readPane`.
 *
 * Its other job is telling the two worlds apart. A pane running a
 * full-screen program returns exactly the visible screen here, because the
 * alternate screen has no scrollback; a shell pane that has scrolled
 * returns much more. `terminalScroll.ts`'s `hasScrollback` does the
 * comparison and the terminal says which case it is in out loud, rather
 * than scrolling silently doing nothing.
 */
export function readPaneScrollback(
  paneId: string,
  expectedRoot?: string,
): Promise<{ text: string; truncated: boolean }> {
  return invoke<{ text: string; revision: number; truncated: boolean }>("pane_read_scrollback", {
    paneId,
    expectedRoot,
  }).then(({ text, truncated }) => ({ text, truncated }));
}

/**
 * Terminal-feel round: the system clipboard, as text, for ⌘V in the
 * embedded terminal. Called from exactly one place — a real `keydown` on a
 * focused terminal surface — and never on the app's own initiative. See
 * `commands::clipboard_read_text` for why this goes through Rust instead
 * of `navigator.clipboard`.
 */
export function readClipboardText(): Promise<string> {
  return invoke<string>("clipboard_read_text");
}

/** Copy output after the user finishes selecting it inside a terminal pane. */
export function writeClipboardText(text: string): Promise<void> {
  return invoke("clipboard_write_text", { text });
}

/**
 * Phase 0.7: sends literal text the user typed straight into a pane, no
 * newline appended. This is the largest capability the app has (spec
 * §5.6) — every call here must originate from a keystroke the user
 * physically typed into a FOCUSED terminal surface; never a composed
 * string, never a retry, never "helpfully" completed on their behalf.
 * `expectedRoot` is the island's `root` the terminal is attached to, same
 * discipline as `sendPrompt`.
 */
export function sendPaneText(paneId: string, text: string, expectedRoot?: string): Promise<void> {
  return invoke("pane_send_text", { paneId, text, expectedRoot });
}

/**
 * Phase 0.7: sends one or more named keys (Herdr's own logical-key
 * vocabulary — `enter`, `ctrl+c`, `up`, ... — see
 * `terminal-backend-report.md` for the verified accepted/rejected list)
 * straight into a pane. Same one-keystroke-in, one-call-out discipline as
 * `sendPaneText`: this is never used to batch several physical keypresses
 * into one call (that would start to look like the macro/replay §5.6
 * explicitly forbids).
 */
export function sendPaneKeys(paneId: string, keys: string[], expectedRoot?: string): Promise<void> {
  return invoke("pane_send_keys", { paneId, keys, expectedRoot });
}
