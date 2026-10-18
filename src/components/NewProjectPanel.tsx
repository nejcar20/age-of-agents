import { useEffect, useReducer, useRef, useState } from "react";
import { useEscapeKey } from "../useEscapeKey";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { foldActionSheet } from "../actionSheet";
import { createProjectSummary, isValidProjectName } from "../actions";
import { createProject } from "../agents";
import { useAgentKinds } from "../useAgentKinds";

type Draft = { parentPath: string; name: string; withAgent: boolean; kind: string };

/**
 * "Found a new project" (Item 4): the author's original vision — a brand
 * new town on empty water, created directly from the game rather than a
 * terminal. Two steps in ONE dialog (never two overlapping ones): pick a
 * parent directory and a name first, then a confirm step naming the exact
 * calls `create_project` will make — the same "nothing runs unseen"
 * standard the existing founding sheet already meets, because this creates
 * a REAL directory and a REAL git repository on the user's machine.
 *
 * `role="dialog"` for the same reason every other confirm surface in this
 * codebase uses it: `useHotkey`'s `isModalOpen()` picks it up structurally,
 * so the Space/jump hotkey cannot fire while this is open, and this
 * component's own Escape listener (below) is what actually closes it.
 */
export function NewProjectPanel({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  /** `undiscoverableReason` mirrors `create_project`'s own field: `null`
   * when the same scan the archipelago uses will find the new project (an
   * island will appear), or the human-readable reason it won't when it's
   * not `null`. Called only AFTER the user has acknowledged an
   * `undiscoverableReason !== null` outcome on this panel's own "created,
   * but…" screen below (see `outcome`) — never silently, since that is
   * exactly the case a user could otherwise mistake for nothing having
   * happened at all. */
  onCreated: (path: string, undiscoverableReason: string | null) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>(
      'input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), [tabindex="0"]',
    )];
    const focusFirst = () => (focusable()[0] ?? dialog).focus();
    const containFocus = (event: FocusEvent) => {
      if (!dialog.contains(event.target as Node)) focusFirst();
    };
    const trapTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey) return;
      const elements = focusable();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); dialog.focus(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    focusFirst();
    document.addEventListener("focusin", containFocus);
    dialog.addEventListener("keydown", trapTab);
    return () => {
      document.removeEventListener("focusin", containFocus);
      dialog.removeEventListener("keydown", trapTab);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const kindsState = useAgentKinds();
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [withAgent, setWithAgent] = useState(true);
  const [kind, setKind] = useState("");
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [sheet, dispatch] = useReducer(foldActionSheet<Draft>, null);
  // Security review: `create_project` now reports (rather than silently
  // dropping) the case where the project was created in full — directory,
  // git repo, herdr workspace, and any requested agent, all real — but sits
  // somewhere the archipelago's own scan cannot see, so NO island will ever
  // draw for it. `null` means either nothing has been created yet, or it
  // was created and IS discoverable (the ordinary path, handled entirely by
  // `onCreated` below, exactly as before this round). Non-null means "hold
  // this screen open until the user has actually read it" — an auto-closing
  // sheet or a five-second toast is exactly the kind of feedback a user
  // could miss and then reasonably conclude the whole thing failed.
  const [outcome, setOutcome] = useState<{ path: string; reason: string } | null>(null);

  const effectiveKind = kind || (kindsState.status === "ready" ? (kindsState.kinds[0] ?? "") : "");

  // The shared dialog Escape (`useEscapeKey`), with this panel's own two
  // conditions kept exactly as they were: nothing happens while a real
  // `create_project` call is in flight (closing would unmount the sheet
  // waiting for its result), and while `outcome` is showing Escape
  // ACKNOWLEDGES it — the same thing its own "Got it" button does — rather
  // than closing the panel out from under an unread explanation.
  useEscapeKey(
    () => {
      if (outcome !== null) {
        const { path, reason } = outcome;
        setOutcome(null);
        onCreated(path, reason);
        return;
      }
      onClose();
    },
    { enabled: !(sheet?.busy ?? false) },
  );

  const browse = async () => {
    setBrowseError(null);
    try {
      const dir = await open({ directory: true });
      if (typeof dir !== "string") return; // cancelled
      // Same canonicalization every other path in this app goes through
      // before being compared or displayed — see `UnsettledList.browse`'s
      // own doc comment for why a raw dialog path (often reached through a
      // symlink on macOS) is never trustworthy as-is.
      const canonical = await invoke<string>("canonical_path", { path: dir });
      setParentPath(canonical);
    } catch (error) {
      setBrowseError(String(error));
    }
  };

  const trimmedName = name.trim();
  const canSubmit = parentPath !== null && isValidProjectName(trimmedName);

  const openConfirm = () => {
    if (!canSubmit || parentPath === null) return;
    // No kind is drafted at all when not starting an agent — `confirm`
    // below turns an empty string into `undefined` before calling
    // `createProject`, so a kind the user never even saw a picker for can
    // never be sent.
    dispatch({
      kind: "open",
      draft: { parentPath, name: trimmedName, withAgent, kind: withAgent ? effectiveKind : "" },
    });
  };

  const confirm = async () => {
    if (sheet === null || sheet.busy) return;
    dispatch({ kind: "started" });
    try {
      const { path, undiscoverable_reason } = await createProject(
        sheet.draft.parentPath,
        sheet.draft.name,
        sheet.draft.withAgent,
        sheet.draft.kind || undefined,
      );
      dispatch({ kind: "succeeded" });
      if (undiscoverable_reason !== null) {
        // Hold the panel open on the "created, but…" screen below instead
        // of calling `onCreated` (which closes this whole panel) right
        // away — see `outcome`'s doc comment for why this case must not be
        // allowed to vanish on its own.
        setOutcome({ path, reason: undiscoverable_reason });
      } else {
        onCreated(path, null);
      }
    } catch (error) {
      dispatch({ kind: "failed", error: String(error) });
    }
  };

  const acknowledgeOutcome = () => {
    if (outcome === null) return;
    const { path, reason } = outcome;
    setOutcome(null);
    onCreated(path, reason);
  };

  return (
    <div ref={dialogRef} className="sheet" role="dialog" aria-modal="true" aria-label="Found a new project" tabIndex={-1}>
      <div className="sheet__panel">
        {outcome !== null ? (
          <>
            <h3>Created — but not visible yet</h3>
            <p className="sheet__hint">
              Created <strong>{outcome.path}</strong> — the directory, the git repository, and its herdr
              workspace all exist and are real. It will <strong>not</strong> appear as an island on the sea:
              {" "}
              {outcome.reason}
            </p>
            <div className="sheet__actions">
              <button type="button" onClick={acknowledgeOutcome}>
                Got it
              </button>
            </div>
          </>
        ) : sheet === null ? (
          <>
            <h3>Found a new project</h3>
            <div className="sheet__field">
              <button type="button" onClick={browse}>
                browse…
              </button>
              <span className="sheet__field-value">{parentPath ?? "no parent directory chosen"}</span>
            </div>
            {browseError !== null && (
              <p className="sheet__error" role="alert">
                {browseError}
              </p>
            )}
            <label className="sheet__field">
              Name:
              <input
                type="text"
                value={name}
                placeholder="my-new-project"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="sheet__checkbox">
              <input type="checkbox" checked={withAgent} onChange={() => setWithAgent((v) => !v)} />
              start an agent
            </label>
            {withAgent && kindsState.status === "ready" && kindsState.kinds.length > 0 && (
              <label className="sheet__field">
                Kind:
                <select value={effectiveKind} onChange={(event) => setKind(event.target.value)}>
                  {kindsState.kinds.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="sheet__actions">
              <button type="button" onClick={onClose}>
                cancel
              </button>
              <button type="button" onClick={openConfirm} disabled={!canSubmit}>
                Next…
              </button>
            </div>
          </>
        ) : (
          <>
            <h3>Create project</h3>
            <pre className="sheet__calls">
              {createProjectSummary(sheet.draft.parentPath, sheet.draft.name, sheet.draft.withAgent, sheet.draft.kind).join(
                "\n",
              )}
            </pre>
            {sheet.error !== null && (
              <p className="sheet__error" role="alert">
                {sheet.error}
              </p>
            )}
            <div className="sheet__actions">
              <button type="button" onClick={() => dispatch({ kind: "close" })} disabled={sheet.busy}>
                back
              </button>
              <button type="button" onClick={confirm} disabled={sheet.busy}>
                {sheet.busy ? "creating…" : "Create project"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
