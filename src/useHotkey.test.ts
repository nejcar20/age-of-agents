// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { decideHotkey, isInteractiveTarget, isModalOpen } from "./useHotkey";

/** A minimal fake `KeyboardEvent`-like object — just enough for `decideHotkey`. */
function keyEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    key: " ",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    repeat: false,
    target: null,
    ...overrides,
  } as unknown as Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "repeat" | "target">;
}

describe("isInteractiveTarget", () => {
  it("is true for form controls that own Space's default action", () => {
    for (const tagName of ["INPUT", "BUTTON", "TEXTAREA", "SELECT"]) {
      expect(isInteractiveTarget({ tagName } as unknown as EventTarget)).toBe(true);
    }
  });

  it("is case-insensitive about tagName", () => {
    expect(isInteractiveTarget({ tagName: "button" } as unknown as EventTarget)).toBe(true);
  });

  it("is true for a contentEditable region even without a matching tag", () => {
    expect(
      isInteractiveTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget),
    ).toBe(true);
  });

  it("is false for ordinary elements", () => {
    expect(isInteractiveTarget({ tagName: "DIV" } as unknown as EventTarget)).toBe(false);
    expect(isInteractiveTarget({ tagName: "CANVAS" } as unknown as EventTarget)).toBe(false);
  });

  it("is false for null or a non-object target", () => {
    expect(isInteractiveTarget(null)).toBe(false);
  });
});

describe("isModalOpen", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("is true when a [role=dialog] element exists", () => {
    const fakeDoc = {
      querySelector: (sel: string) => (sel === '[role="dialog"]:not([aria-modal="false"])' ? {} : null),
    };
    expect(isModalOpen(fakeDoc)).toBe(true);
  });

  it("is false when no dialog is present", () => {
    const fakeDoc = { querySelector: () => null };
    expect(isModalOpen(fakeDoc)).toBe(false);
  });

  // CRITICAL 3 (Opus frontend review): `IslandPanel` is a non-modal card
  // that still needs `role="dialog"` for other reasons (an `aria-label`,
  // consistency with its own nested confirm sheets), but must NOT block a
  // window-level hotkey (the Space jump) the way a real modal does. Real
  // elements (not a fake `querySelector`) here, since the whole point is the
  // `:not([aria-modal="false"])` half of the selector actually working
  // against a real attribute selector engine, not just a string literal.
  it("ignores a [role=dialog] explicitly marked aria-modal=\"false\"", () => {
    const el = document.createElement("div");
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "false");
    document.body.appendChild(el);
    expect(isModalOpen()).toBe(false);
  });

  it("still counts an ordinary [role=dialog] (no aria-modal override) as modal", () => {
    const el = document.createElement("div");
    el.setAttribute("role", "dialog");
    document.body.appendChild(el);
    expect(isModalOpen()).toBe(true);
  });

  it("counts a modal dialog even while a non-modal one is also open", () => {
    const info = document.createElement("div");
    info.setAttribute("role", "dialog");
    info.setAttribute("aria-modal", "false");
    document.body.appendChild(info);
    const confirm = document.createElement("div");
    confirm.setAttribute("role", "dialog");
    document.body.appendChild(confirm);
    expect(isModalOpen()).toBe(true);
  });
});

describe("decideHotkey", () => {
  const base = { key: " ", enabled: true, modalOpen: false };

  it("fires and prevents default in the ordinary case", () => {
    expect(decideHotkey(keyEvent(), base)).toEqual({ fire: true, preventDefault: true });
  });

  it("ignores a different key entirely — no fire, no preventDefault", () => {
    expect(decideHotkey(keyEvent({ key: "Escape" }), base)).toEqual({
      fire: false,
      preventDefault: false,
    });
  });

  it("ignores the key with a modifier held", () => {
    expect(decideHotkey(keyEvent({ metaKey: true }), base)).toEqual({
      fire: false,
      preventDefault: false,
    });
  });

  // IMPORTANT 2 (final whole-branch review), the core regression: pressing
  // Space while the founding confirm sheet's checkbox is focused must not
  // fire the hotkey, AND must not preventDefault — the checkbox needs to see
  // Space to toggle itself, exactly as it would if no window-level hotkey
  // existed at all.
  it("lets a focused interactive control (e.g. the sheet's checkbox) handle Space itself", () => {
    const event = keyEvent({ target: { tagName: "INPUT" } });
    expect(decideHotkey(event, { ...base, modalOpen: true })).toEqual({
      fire: false,
      preventDefault: false,
    });
  });

  it("does the same for a focused button (rescan / browse… / a sheet's confirm / cancel)", () => {
    const event = keyEvent({ target: { tagName: "BUTTON" } });
    expect(decideHotkey(event, base)).toEqual({ fire: false, preventDefault: false });
  });

  // IMPORTANT 2, the explicit "modal is open" term: even when focus is on
  // something non-interactive while a modal is open (so the interactive-
  // target check above does not catch it), the hotkey must still not fire —
  // but preventDefault must still happen, so Space does not scroll the page
  // behind the modal (task-6-design-inputs.md §7.5's existing invariant,
  // extended to this new disabled reason).
  it("bails while a modal is open even when focus is not on an interactive control", () => {
    expect(decideHotkey(keyEvent(), { ...base, modalOpen: true })).toEqual({
      fire: false,
      preventDefault: true,
    });
  });

  it("still respects the plain `enabled: false` case (e.g. the town view is open)", () => {
    expect(decideHotkey(keyEvent(), { ...base, enabled: false })).toEqual({
      fire: false,
      preventDefault: true,
    });
  });

  it("prevents default on a held-key repeat but never fires more than once per physical press", () => {
    expect(decideHotkey(keyEvent({ repeat: true }), base)).toEqual({
      fire: false,
      preventDefault: true,
    });
  });
});
