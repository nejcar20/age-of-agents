// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "./Terminal";
import { TerminalStageProvider } from "../terminalStage";
import type { SwitchTarget } from "../agentSwitcher";
import type { Agent, Attention } from "../world";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const agent: Agent = {
  pane_id: "w7:p1",
  workspace_id: "w7",
  status: "working",
  attention: "working",
  title: "fixing the bug",
  kind: null,
  is_worktree: false,
  cwd: "/p/pocketAlarm",
};

const ROOT = "/p/pocketAlarm";

function paneRead(text: string, truncated = false) {
  return Promise.resolve({ text, revision: 0, truncated });
}

beforeEach(() => {
  // Same technique `useWindowFocused.test.tsx` uses — forces the real hook
  // (used unmocked here, on purpose: proving the polling actually respects
  // it) to report "focused" deterministically in jsdom, rather than
  // depending on whatever `document.hasFocus()` happens to report under a
  // headless test runner.
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "pane_read") return paneRead("hello from the pane");
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function surface() {
  return screen.getByRole("application");
}

function sends() {
  return invokeMock.mock.calls.filter(([cmd]) => cmd === "pane_send_text" || cmd === "pane_send_keys");
}

describe("Terminal", () => {
  it("shows the attachment — pane id, root, and title — so it's never ambiguous what this mirrors", async () => {
    render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
    expect(screen.getByText("fixing the bug")).toBeTruthy();
    expect(screen.getByText(`${agent.pane_id} · ${ROOT}`)).toBeTruthy();
    await screen.findByText("hello from the pane");
  });

  it("reads the pane on mount, passing expected_root", async () => {
    render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
    expect(invokeMock).toHaveBeenCalledWith("pane_read", { paneId: "w7:p1", expectedRoot: ROOT });
    await screen.findByText("hello from the pane");
  });

  it("renders real ANSI colour, reusing ansi.ts rather than a second parser", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "pane_read") return paneRead("\x1b[32mgreen text\x1b[0m");
      return Promise.resolve(undefined);
    });
    render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
    const span = await screen.findByText("green text");
    expect(span.tagName).toBe("SPAN");
    expect((span as HTMLElement).style.color).not.toBe("");
  });

  it("shows the truncated badge as its own element, separate from the transcript", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "pane_read") return paneRead("some text", true);
      return Promise.resolve(undefined);
    });
    render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
    await screen.findByText(/truncated/i);
    expect(screen.getByText("some text").textContent).toBe("some text");
  });

  it("shows an honest error when the pane read fails (e.g. a closed pane)", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "pane_read") return Promise.reject(new Error("w7:p1 isn't a live pane anymore"));
      return Promise.resolve(undefined);
    });
    render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/isn't a live pane anymore/);
  });

  describe("polling", () => {
    it("polls pane_read on a 250ms timer while mounted and the window is focused", async () => {
      vi.useFakeTimers();
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(invokeMock).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(invokeMock).toHaveBeenCalledTimes(4);
    });

    it("stops polling once unmounted", async () => {
      vi.useFakeTimers();
      const { unmount } = render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(invokeMock).toHaveBeenCalledTimes(1);
    });

    it("does not re-render the screen when a poll returns identical text (revision is not trusted)", async () => {
      vi.useFakeTimers();
      let reads = 0;
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "pane_read") {
          reads += 1;
          // `revision` stuck at 0 on every call — exactly what the backend
          // measured against a real Herdr — proving this component diffs
          // `text` itself rather than trusting it.
          return paneRead("unchanged screen");
        }
        return Promise.resolve(undefined);
      });
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await vi.waitFor(() => screen.getByText("unchanged screen"));
      const before = screen.getByText("unchanged screen");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(reads).toBe(2);
      const after = screen.getByText("unchanged screen");
      // Same DOM node — React never re-rendered this subtree, because
      // `setState` was never called for an identical read.
      expect(after).toBe(before);
    });
  });

  // ---------------------------------------------------------------------
  // TYPING LATENCY (the author, after using this for real work: typing was
  // fast in the real terminal and slow here). The cause was entirely the
  // poll timer: a keystroke was sent and then nothing asked the pane
  // anything until the next scheduled read, so the echo arrived an average
  // of ~125ms and at worst 250ms later. The fix is to ASK SOONER — and
  // ONLY to ask sooner. See the honesty test at the bottom of this block:
  // the character must still come from a real read.
  // ---------------------------------------------------------------------
  describe("typing latency", () => {
    it("refreshes real output while an accepted keystroke is still waiting for its acknowledgement", async () => {
      vi.useFakeTimers();
      let visible = "before input";
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "pane_read") return paneRead(visible);
        if (cmd === "pane_send_text") { visible = "echo from pane"; return new Promise(() => {}); }
        return Promise.resolve();
      });
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await act(async () => { await Promise.resolve(); });
      act(() => surface().focus());
      fireEvent.keyDown(surface(), { key: "x" });
      await act(async () => { await vi.advanceTimersByTimeAsync(16); });
      expect(surface().textContent).toContain("echo from pane");
    });
    /** A pane that echoes what it is sent, the way a real one does — but
     * only once herdr has actually been told, never before. */
    function echoingPane() {
      let echoed = "";
      invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "pane_read") return paneRead(`> ${echoed}`);
        if (cmd === "pane_send_text") {
          echoed += String(args?.text ?? "");
          return Promise.resolve(undefined);
        }
        return Promise.resolve(undefined);
      });
    }

    it("reads the pane as soon as a keystroke lands, instead of waiting for the poll timer", async () => {
      vi.useFakeTimers();
      echoingPane();
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await vi.waitFor(() => expect(surface().textContent).toContain(">"));
      const readsBefore = invokeMock.mock.calls.filter(([cmd]) => cmd === "pane_read").length;

      const el = surface();
      act(() => el.focus());
      fireEvent.keyDown(el, { key: "a" });
      // NOT `advanceTimersByTime` — nothing is waited out here. The only
      // thing that happens between the keypress and the character being on
      // screen is the send resolving and the read it triggers coming back.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "pane_read").length).toBeGreaterThan(
        readsBefore,
      );
      expect(surface().textContent).toContain("> a");
    });

    it("keeps reading at one frame while the user is typing, then relaxes back to 250ms", async () => {
      vi.useFakeTimers();
      echoingPane();
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await vi.waitFor(() => expect(surface().textContent).toContain(">"));
      const el = surface();
      act(() => el.focus());

      fireEvent.keyDown(el, { key: "a" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const afterKey = invokeMock.mock.calls.filter(([cmd]) => cmd === "pane_read").length;

      // 100ms of the typing window: at 16ms that is several reads, where
      // the idle rate would not have managed even one.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      const fast = invokeMock.mock.calls.filter(([cmd]) => cmd === "pane_read").length - afterKey;
      expect(fast).toBeGreaterThanOrEqual(4);

      // Let the typing window (500ms) lapse with no further keystrokes,
      // then measure another 100ms: back to the idle rate, which cannot
      // fit more than one read into that window.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
      const settled = invokeMock.mock.calls.filter(([cmd]) => cmd === "pane_read").length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      const relaxed = invokeMock.mock.calls.filter(([cmd]) => cmd === "pane_read").length - settled;
      expect(relaxed).toBeLessThanOrEqual(1);
    });

    it("never reads twice at once, however fast the keys come", async () => {
      vi.useFakeTimers();
      let open = 0;
      let peak = 0;
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "pane_read") {
          open += 1;
          peak = Math.max(peak, open);
          return new Promise((resolve) => {
            // A slow herdr answer — the ~105ms stall this machine really
            // does produce in bursts — while keys keep arriving.
            window.setTimeout(() => {
              open -= 1;
              resolve({ text: "busy pane", revision: 0, truncated: false });
            }, 105);
          });
        }
        return Promise.resolve(undefined);
      });
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      const el = surface();
      act(() => el.focus());
      for (let i = 0; i < 20; i += 1) {
        fireEvent.keyDown(el, { key: "x" });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(12);
        });
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(peak).toBe(1);
    });

    it("a keystroke does not resurrect polling in a blurred window", async () => {
      vi.useFakeTimers();
      echoingPane();
      const { unmount } = render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await vi.waitFor(() => expect(surface().textContent).toContain(">"));
      const el = surface();
      act(() => el.focus());
      unmount();
      const reads = invokeMock.mock.calls.filter(([cmd]) => cmd === "pane_read").length;
      // The send's own promise resolving after teardown must not be able to
      // start a read for a terminal that no longer exists.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "pane_read").length).toBe(reads);
    });

    // THE LINE THIS ROUND MUST NOT CROSS. Faster polling is allowed to make
    // the echo arrive sooner; nothing is allowed to make it arrive before
    // the pane has actually produced it. A pane that swallows input (a
    // password prompt, a program with echo off, a pane that is simply busy)
    // must leave this surface showing exactly what it last read.
    it("shows NOTHING until the pane itself echoes — no local echo, no prediction", async () => {
      vi.useFakeTimers();
      invokeMock.mockImplementation((cmd: string) => {
        // A pane that never echoes anything, whatever it is sent.
        if (cmd === "pane_read") return paneRead("password: ");
        return Promise.resolve(undefined);
      });
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await vi.waitFor(() => expect(surface().textContent).toContain("password:"));
      const el = surface();
      act(() => el.focus());
      fireEvent.keyDown(el, { key: "s" });
      fireEvent.keyDown(el, { key: "e" });
      fireEvent.keyDown(el, { key: "c" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(invokeMock).toHaveBeenCalledWith("pane_send_text", {
        paneId: "w7:p1",
        text: "s",
        expectedRoot: ROOT,
      });
      // Three characters went to the pane; not one of them is on screen,
      // because the pane never sent one back.
      expect(surface().textContent).toContain("password:");
      expect(surface().textContent).not.toContain("sec");
    });
  });

  // ---------------------------------------------------------------------
  // Item 2 (terminal-polish round): the pane's own grid, zoomed to fill
  // the panel. jsdom has no layout engine, so the two measured boxes are
  // stubbed with the author's REAL numbers — his live pane is 23 rows by
  // ~55 columns (`herdr pane get w2J:p1` reports `viewport_rows: 23`),
  // which at 13px/1.6 monospace is about 430x478 CSS px inside the
  // panel's ~1170x700 content box.
  // ---------------------------------------------------------------------
  describe("fitting the pane's grid to the panel", () => {
    function stubLayout(grid: { w: number; h: number }, fit: { w: number; h: number }) {
      const isGrid = (el: HTMLElement) => el.classList.contains("terminal__grid-inner");
      vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
        return isGrid(this) ? grid.w : 0;
      });
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
        return isGrid(this) ? grid.h : 0;
      });
      const isFit = (el: HTMLElement) => el.classList.contains("terminal__fit");
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
        return isFit(this) ? fit.w : 0;
      });
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
        return isFit(this) ? fit.h : 0;
      });
    }

    const inner = () => document.querySelector(".terminal__grid-inner") as HTMLElement;

    it("magnifies a small pane to fill the panel, with ONE factor on both axes", async () => {
      stubLayout({ w: 430, h: 478 }, { w: 1170, h: 700 });
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await screen.findByText("hello from the pane");
      fireEvent.click(screen.getByRole("button", { name: "Fit pane" }));
      // 700/478 = 1.464 -> snapped down to 1.46; the width could have gone
      // to 2.7x and deliberately does not, because stretching the cell
      // would distort every glyph the agent prints.
      expect(inner().style.transform).toBe("scale(1.46)");
    });

    it("never sends a resize to the real pane — it only ever changes how WE draw it", async () => {
      stubLayout({ w: 430, h: 478 }, { w: 1170, h: 700 });
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await screen.findByText("hello from the pane");
      fireEvent.click(screen.getByRole("button", { name: "Fit pane" }));
      act(() => window.dispatchEvent(new Event("resize")));
      // `pane.resize` exists in herdr's API and is deliberately outside
      // this app's permitted write surface: his real terminal's layout is
      // not ours to rearrange so our window looks better.
      const commands = invokeMock.mock.calls.map(([cmd]) => cmd);
      expect(commands.every((cmd) => cmd === "pane_read")).toBe(true);
    });

    it("shrinks, rather than clipping, a pane wider than the panel", async () => {
      stubLayout({ w: 2000, h: 300 }, { w: 1000, h: 700 });
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await screen.findByText("hello from the pane");
      fireEvent.click(screen.getByRole("button", { name: "Fit pane" }));
      expect(inner().style.transform).toBe("scale(0.5)");
    });

    it("draws at true size when nothing can be measured, rather than guessing", async () => {
      // No layout stubs at all: jsdom reports zeroes, which is also the
      // state of the very first paint in a real browser.
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await screen.findByText("hello from the pane");
      fireEvent.click(screen.getByRole("button", { name: "Fit pane" }));
      expect(inner().style.transform).toBe("");
    });
  });

  // ---------------------------------------------------------------------
  // THE boundary that matters (the brief's own words): a keystroke must
  // reach the pane only when this surface genuinely holds DOM focus, never
  // from an accidental keypress while the sea/game has focus.
  // ---------------------------------------------------------------------
  describe("the focus boundary", () => {
    it("sends nothing when a key is typed while the surface is NOT focused", async () => {
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await screen.findByText("hello from the pane");
      expect(document.activeElement).not.toBe(surface());
      fireEvent.keyDown(window, { key: "a" });
      fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
      expect(invokeMock).not.toHaveBeenCalledWith("pane_send_text", expect.anything());
      expect(invokeMock).not.toHaveBeenCalledWith("pane_send_keys", expect.anything());
    });

    it("shows an unambiguous 'not focused' indicator before the surface is clicked", async () => {
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await screen.findByText("hello from the pane");
      expect(screen.getByText(/click to type/i)).toBeTruthy();
    });

    it("sends a printable character via pane_send_text once the surface is focused", async () => {
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await screen.findByText("hello from the pane");
      const el = surface();
      act(() => el.focus());
      expect(document.activeElement).toBe(el);
      fireEvent.keyDown(el, { key: "a" });
      expect(invokeMock).toHaveBeenCalledWith("pane_send_text", { paneId: "w7:p1", text: "a", expectedRoot: ROOT });
    });

    // Item 3 (terminal-polish round), the author: "if i click in it it
    // doesnt pass the click through". Herdr has no mouse API at all, so a
    // click cannot be forwarded and we will not fake one — but the click
    // must reliably do the one thing it CAN do, because a terminal that
    // looks live and swallows every keystroke is indistinguishable, from
    // the user's chair, from a click that did nothing.
    it("a mouse click on the surface focuses it, so the very next keystroke reaches the pane", async () => {
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await screen.findByText("hello from the pane");
      const el = surface();
      expect(document.activeElement).not.toBe(el);
      // `mouseDown`, not `.focus()`: jsdom does not implement the
      // browser's own click-to-focus for `tabindex` elements, so this
      // passes only because the component focuses the surface itself —
      // which is exactly the guarantee WKWebView is not worth assuming.
      act(() => {
        fireEvent.mouseDown(el);
      });
      expect(document.activeElement).toBe(el);
      fireEvent.keyDown(el, { key: "a" });
      expect(invokeMock).toHaveBeenCalledWith("pane_send_text", { paneId: "w7:p1", text: "a", expectedRoot: ROOT });
    });

    it("a click sends NOTHING to the pane — no synthesised mouse sequence", async () => {
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await screen.findByText("hello from the pane");
      const el = surface();
      fireEvent.mouseDown(el);
      fireEvent.mouseUp(el);
      fireEvent.click(el);
      // Synthesising xterm mouse-reporting escapes would mean guessing
      // whether the foreground program even has mouse reporting on, and
      // injecting input the user never typed — spec §5.6 forbids exactly
      // that, and herdr offers no mouse primitive to do it honestly with.
      expect(invokeMock).not.toHaveBeenCalledWith("pane_send_text", expect.anything());
      expect(invokeMock).not.toHaveBeenCalledWith("pane_send_keys", expect.anything());
    });

    it("says once, quietly, what the mouse does, what it cannot do, and which key the app keeps", async () => {
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await screen.findByText("hello from the pane");
      const note = screen.getByText(/in-app terminal mouse actions are unavailable/i);
      // The gained abilities...
      expect(note.textContent).toMatch(/⌘C to copy/);
      expect(note.textContent).toMatch(/⌘V to paste/);
      // ...the keys that reach the pane...
      expect(note.textContent).toMatch(/shift\+Tab/);
      // ...the one the app keeps...
      expect(note.textContent).toMatch(/ctrl\+alt\+Tab/);
      // ...and the limitation that did NOT go away.
      expect(note.textContent).toMatch(/application keyboard shortcuts/);
    });

    it("shows the loud 'live' indicator once focused", async () => {
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await screen.findByText("hello from the pane");
      act(() => surface().focus());
      expect(screen.getByText(/live — keys go to the agent/i)).toBeTruthy();
    });

    // The exact requirement: Space is the app's global jump hotkey, and it
    // must type a space here, never jump, while this surface is focused.
    it("Space types a literal space into the pane while focused, and never reaches a window-level listener", async () => {
      const outerListener = vi.fn(); // stands in for useHotkey's own window listener
      window.addEventListener("keydown", outerListener);
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await screen.findByText("hello from the pane");
      const el = surface();
      act(() => el.focus());
      fireEvent.keyDown(el, { key: " " });
      expect(invokeMock).toHaveBeenCalledWith("pane_send_text", { paneId: "w7:p1", text: " ", expectedRoot: ROOT });
      expect(outerListener).not.toHaveBeenCalled();
      window.removeEventListener("keydown", outerListener);
    });

    it("a keydown dispatched directly on window (unfocused) never reaches the pane, even for the same Space key", async () => {
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await screen.findByText("hello from the pane");
      fireEvent.keyDown(window, { key: " " });
      expect(invokeMock).not.toHaveBeenCalledWith("pane_send_text", expect.anything());
    });

    // The named hazard: ctrl+z can suspend an idle shell and take the whole
    // workspace down with it (per the backend report) — the author's own
    // ruling is "do not block or filter keys," so this must go through
    // exactly like any other combination, PROVIDED the surface is focused.
    it("does not filter ctrl+z while focused — the author's explicit ruling", async () => {
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await screen.findByText("hello from the pane");
      const el = surface();
      act(() => el.focus());
      fireEvent.keyDown(el, { key: "z", ctrlKey: true });
      expect(invokeMock).toHaveBeenCalledWith("pane_send_keys", {
        paneId: "w7:p1",
        keys: ["ctrl+z"],
        expectedRoot: ROOT,
      });
    });

    it("ctrl+z typed while NOT focused never reaches the pane", async () => {
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await screen.findByText("hello from the pane");
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      expect(invokeMock).not.toHaveBeenCalledWith("pane_send_keys", expect.anything());
    });
  });

  describe("special keys", () => {
    async function focusedSurface() {
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await screen.findByText("hello from the pane");
      const el = surface();
      act(() => el.focus());
      return el;
    }

    it("Enter -> pane_send_keys(['enter'])", async () => {
      const el = await focusedSurface();
      fireEvent.keyDown(el, { key: "Enter" });
      expect(invokeMock).toHaveBeenCalledWith("pane_send_keys", { paneId: "w7:p1", keys: ["enter"], expectedRoot: ROOT });
    });

    it("Tab -> pane_send_keys(['tab'])", async () => {
      const el = await focusedSurface();
      fireEvent.keyDown(el, { key: "Tab" });
      expect(invokeMock).toHaveBeenCalledWith("pane_send_keys", { paneId: "w7:p1", keys: ["tab"], expectedRoot: ROOT });
    });

    // The one his own session prints at the bottom of the screen ("shift+tab
    // to cycle") — the keyboard equivalent that has to work for Item 3's
    // "use the keyboard instead" to be a real answer rather than a
    // deflection.
    it("shift+Tab -> pane_send_keys(['shift+tab'])", async () => {
      const el = await focusedSurface();
      fireEvent.keyDown(el, { key: "Tab", shiftKey: true });
      expect(invokeMock).toHaveBeenCalledWith("pane_send_keys", {
        paneId: "w7:p1",
        keys: ["shift+tab"],
        expectedRoot: ROOT,
      });
    });

    it("Backspace -> pane_send_keys(['backspace'])", async () => {
      const el = await focusedSurface();
      fireEvent.keyDown(el, { key: "Backspace" });
      expect(invokeMock).toHaveBeenCalledWith("pane_send_keys", {
        paneId: "w7:p1",
        keys: ["backspace"],
        expectedRoot: ROOT,
      });
    });

    it("arrows -> pane_send_keys(['up'|'down'|'left'|'right'])", async () => {
      const el = await focusedSurface();
      fireEvent.keyDown(el, { key: "ArrowUp" });
      fireEvent.keyDown(el, { key: "ArrowDown" });
      fireEvent.keyDown(el, { key: "ArrowLeft" });
      fireEvent.keyDown(el, { key: "ArrowRight" });
      for (const k of ["up", "down", "left", "right"]) {
        expect(invokeMock).toHaveBeenCalledWith("pane_send_keys", { paneId: "w7:p1", keys: [k], expectedRoot: ROOT });
      }
    });

    it("ctrl+c -> pane_send_keys(['ctrl+c'])", async () => {
      const el = await focusedSurface();
      fireEvent.keyDown(el, { key: "c", ctrlKey: true });
      expect(invokeMock).toHaveBeenCalledWith("pane_send_keys", {
        paneId: "w7:p1",
        keys: ["ctrl+c"],
        expectedRoot: ROOT,
      });
    });

    it("shows the backend's own plain-language error when Herdr rejects a key, without swallowing it", async () => {
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "pane_read") return paneRead("hello from the pane");
        if (cmd === "pane_send_keys") return Promise.reject(new Error("herdr didn't recognize a key you sent"));
        return Promise.resolve(undefined);
      });
      const el = await focusedSurface();
      // ctrl+Home, not plain Home: an unmodified Home now travels as the
      // escape bytes a terminal sends (terminal-feel round), and a MODIFIED
      // press is the case that still reaches herdr's key vocabulary and can
      // still be rejected by it.
      fireEvent.keyDown(el, { key: "Home", ctrlKey: true });
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(/didn't recognize/);
    });
  });

  describe("leaving the terminal", () => {
    it("the close button always closes, focused or not", async () => {
      const onClose = vi.fn();
      render(<Terminal agent={agent} root={ROOT} onClose={onClose} />);
      await screen.findByText("hello from the pane");
      act(() => surface().focus());
      fireEvent.click(screen.getByRole("button", { name: "Close terminal" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("Escape closes the terminal when the surface is NOT focused, matching every other dialog", async () => {
      const onClose = vi.fn();
      render(<Terminal agent={agent} root={ROOT} onClose={onClose} />);
      await screen.findByText("hello from the pane");
      expect(document.activeElement).not.toBe(surface());
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    // The one the brief is most explicit about: Escape is a key the AGENT
    // needs (vim, a menu, a prompt) once the surface has focus, so it must
    // reach the pane, never close this dialog out from under the user.
    it("Escape reaches the agent instead of closing, once the surface is focused", async () => {
      const onClose = vi.fn();
      render(<Terminal agent={agent} root={ROOT} onClose={onClose} />);
      await screen.findByText("hello from the pane");
      const el = surface();
      act(() => el.focus());
      fireEvent.keyDown(el, { key: "Escape" });
      expect(invokeMock).toHaveBeenCalledWith("pane_send_keys", {
        paneId: "w7:p1",
        keys: ["escape"],
        expectedRoot: ROOT,
      });
      expect(onClose).not.toHaveBeenCalled();
    });

    it("clicking outside the surface blurs it, after which Escape closes normally", async () => {
      const onClose = vi.fn();
      render(<Terminal agent={agent} root={ROOT} onClose={onClose} />);
      await screen.findByText("hello from the pane");
      const el = surface();
      act(() => el.focus());
      expect(document.activeElement).toBe(el);
      // Clicking a non-focusable area of the panel (the title) blurs the
      // surface, exactly like clicking away from any real text field.
      fireEvent.mouseDown(screen.getByText("fixing the bug"));
      act(() => el.blur());
      expect(document.activeElement).not.toBe(el);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------
// THE SWITCHER (lag-and-switcher round). The author's main ask, twice:
// switching between terminals has to be easy.
// ---------------------------------------------------------------------

function target(
  paneId: string,
  islandName: string,
  attention: Attention = "working",
  title: string | null = null,
): SwitchTarget {
  return {
    agent: {
      pane_id: paneId,
      workspace_id: paneId.split(":")[0] ?? paneId,
      status: attention === "stopped" ? "blocked" : "working",
      attention,
      title,
      kind: "claude",
      is_worktree: false,
      cwd: `/p/${islandName}`,
    },
    root: `/p/${islandName}`,
    islandName,
  };
}

/** The pane every test in this file is attached to is `w7:p1` — its own tab. */
const HERE = target("w7:p1", "pocketAlarm");

function renderWithStage(targets: SwitchTarget[], switchTo = vi.fn()) {
  const stage = { claimScene: () => () => {}, targets, switchTo };
  render(
    <TerminalStageProvider stage={stage}>
      <Terminal agent={agent} root={ROOT} onClose={vi.fn()} />
    </TerminalStageProvider>,
  );
  return { switchTo };
}

function tab(name: RegExp | string) {
  return screen.getByRole("button", { name: typeof name === "string" ? new RegExp(name) : name });
}

describe("Terminal — seen", () => {
  const stopped: Agent = { ...agent, status: "idle", attention: "stopped" };
  const seenCalls = () => invokeMock.mock.calls.filter(([cmd]) => cmd === "mark_agent_seen");

  it("marks a stopped agent seen when its terminal opens", async () => {
    render(<Terminal agent={stopped} root={ROOT} onClose={vi.fn()} />);
    await screen.findByText("hello from the pane");
    expect(seenCalls()).toEqual([["mark_agent_seen", { paneId: "w7:p1" }]]);
  });

  it("does not mark a working agent seen", async () => {
    render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
    await screen.findByText("hello from the pane");
    expect(seenCalls()).toEqual([]);
  });

  it("waits for the window to be focused before marking seen", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    render(<Terminal agent={stopped} root={ROOT} onClose={vi.fn()} />);
    expect(seenCalls()).toEqual([]);
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(seenCalls()).toEqual([["mark_agent_seen", { paneId: "w7:p1" }]]);
  });
});

describe("Terminal — the switcher bar", () => {
  it("shows nothing at all when the stage knows of no agents", async () => {
    renderWithStage([]);
    await screen.findByText("hello from the pane");
    expect(screen.queryByText(/^terminals$/i)).toBeNull();
  });

  it("lists EVERY running agent, not only the ones that have stopped", async () => {
    // The correction this round turned on: this is a tab bar, not a
    // "who needs me" list. A calm agent must be reachable.
    renderWithStage([
      HERE,
      target("wA:p1", "label-studio", "stopped"),
      target("wB:p1", "my-site-next", "working"),
      target("wC:p1", "atlas", "quiet"),
      target("wD:p1", "speech.cpp", "unknown"),
    ]);
    await screen.findByText("hello from the pane");
    expect(screen.getByText("label-studio")).toBeTruthy();
    expect(screen.getByText("my-site-next")).toBeTruthy();
    expect(screen.getByText("atlas")).toBeTruthy();
    expect(screen.getByText("speech.cpp")).toBeTruthy();
  });

  it("keeps the pane it is attached to in the bar, marked, rather than hiding it", async () => {
    // A tab bar that hides the current tab makes you count to work out
    // where you are, and the whole safety story here is "never be unsure
    // which session your keyboard is pointing at".
    renderWithStage([HERE, target("wA:p1", "label-studio", "stopped")]);
    await screen.findByText("hello from the pane");
    const mine = tab(/pocketAlarm/);
    expect(mine.getAttribute("aria-current")).toBe("true");
    expect((mine as HTMLButtonElement).disabled).toBe(true);
    expect(mine.textContent).toMatch(/you are here/i);
    expect(tab(/label-studio/).getAttribute("aria-current")).toBeNull();
  });

  it("says 'needs you' in words on a stopped agent, not only in a colour", async () => {
    renderWithStage([HERE, target("wA:p1", "label-studio", "stopped")]);
    await screen.findByText("hello from the pane");
    expect(tab(/label-studio/).textContent).toMatch(/needs you/i);
    expect(tab(/pocketAlarm/).textContent).not.toMatch(/needs you/i);
  });

  it("says 'you are here' even when the tab you are on is itself a stopped one", async () => {
    // A render caught this: with the attention fill alone, the tab you are
    // attached to looked identical to every other stopped tab, and "which
    // one am I on" is the single most consequential question this bar
    // answers.
    const stoppedHere = target("w7:p1", "pocketAlarm", "stopped");
    renderWithStage([stoppedHere, target("wA:p1", "label-studio", "stopped")]);
    await screen.findByText("hello from the pane");
    const mine = screen.getByText("w7:p1").closest("button")!;
    expect(mine.getAttribute("aria-current")).toBe("true");
    expect(mine.textContent).toMatch(/you are here/i);
    expect(mine.textContent).not.toMatch(/needs you/i);
    expect(tab(/label-studio/).textContent).toMatch(/needs you/i);
  });

  it("names the pane id on every tab, so two agents on one island are distinguishable", async () => {
    renderWithStage([
      HERE,
      target("wD:p1", "space-guardian", "stopped", "waiting on a decision"),
      target("wD:p2", "space-guardian", "working"),
    ]);
    await screen.findByText("hello from the pane");
    // Two tabs, same repository name, told apart only by the pane id —
    // which is exactly why the pane id is always shown and the agent's
    // title never replaces it.
    const one = screen.getByText("wD:p1").closest("button")!;
    const two = screen.getByText("wD:p2").closest("button")!;
    expect(one).not.toBe(two);
    expect(one.textContent).toContain("space-guardian");
    expect(two.textContent).toContain("space-guardian");
    expect(one.textContent).toMatch(/needs you/i);
    expect(two.textContent).not.toMatch(/needs you/i);
  });

  it("clicking a tab asks the sea to re-attach this terminal to that pane", async () => {
    const { switchTo } = renderWithStage([HERE, target("wB:p1", "my-site-next", "quiet")]);
    await screen.findByText("hello from the pane");
    fireEvent.click(tab(/my-site-next/));
    expect(switchTo).toHaveBeenCalledTimes(1);
    expect(switchTo.mock.calls[0]?.[0]?.agent?.pane_id).toBe("wB:p1");
    expect(switchTo.mock.calls[0]?.[0]?.root).toBe("/p/my-site-next");
  });

  it("switching never sends anything to either pane — it re-attaches, it does not type", async () => {
    const { switchTo } = renderWithStage([HERE, target("wB:p1", "my-site-next")]);
    await screen.findByText("hello from the pane");
    fireEvent.click(tab(/my-site-next/));
    expect(switchTo).toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("pane_send_text", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("pane_send_keys", expect.anything());
  });
});

describe("Terminal — the ctrl+alt+Tab switch key", () => {
  const THREE = [HERE, target("wA:p1", "label-studio", "stopped"), target("wB:p1", "my-site-next")];

  it("moves to the next agent even while the surface has the keyboard", async () => {
    // The hard case, and the only one that matters: the user is mid-
    // conversation, every keystroke is going to the agent.
    const { switchTo } = renderWithStage(THREE);
    await screen.findByText("hello from the pane");
    act(() => surface().focus());
    fireEvent.keyDown(surface(), { key: "Tab", ctrlKey: true, altKey: true });
    expect(switchTo).toHaveBeenCalledTimes(1);
    expect(switchTo.mock.calls[0]?.[0]?.agent?.pane_id).toBe("wA:p1");
  });

  it("moves to the PREVIOUS agent with shift held", async () => {
    const { switchTo } = renderWithStage(THREE);
    await screen.findByText("hello from the pane");
    act(() => surface().focus());
    fireEvent.keyDown(surface(), { key: "Tab", ctrlKey: true, altKey: true, shiftKey: true });
    expect(switchTo.mock.calls[0]?.[0]?.agent?.pane_id).toBe("wB:p1");
  });

  it("does NOT reach the pane — not as text, not as keys, focused or not", async () => {
    renderWithStage(THREE);
    await screen.findByText("hello from the pane");
    act(() => surface().focus());
    fireEvent.keyDown(surface(), { key: "Tab", ctrlKey: true, altKey: true });
    fireEvent.keyDown(surface(), { key: "Tab", ctrlKey: true, altKey: true, shiftKey: true });
    act(() => surface().blur());
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, altKey: true });
    expect(invokeMock).not.toHaveBeenCalledWith("pane_send_text", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("pane_send_keys", expect.anything());
  });

  it("a plain Tab still goes to the agent — the shortcut steals nothing", async () => {
    renderWithStage(THREE);
    await screen.findByText("hello from the pane");
    act(() => surface().focus());
    fireEvent.keyDown(surface(), { key: "Tab" });
    expect(invokeMock).toHaveBeenCalledWith("pane_send_keys", {
      paneId: "w7:p1",
      keys: ["tab"],
      expectedRoot: ROOT,
    });
  });

  it("shift+Tab — the key the agent's own screen tells him to press — still goes to the agent", async () => {
    renderWithStage(THREE);
    await screen.findByText("hello from the pane");
    act(() => surface().focus());
    fireEvent.keyDown(surface(), { key: "Tab", shiftKey: true });
    expect(invokeMock).toHaveBeenCalledWith("pane_send_keys", {
      paneId: "w7:p1",
      keys: ["shift+tab"],
      expectedRoot: ROOT,
    });
  });

  it("says so out loud when it is the only agent running, rather than doing nothing visible", async () => {
    const { switchTo } = renderWithStage([HERE]);
    await screen.findByText("hello from the pane");
    act(() => surface().focus());
    fireEvent.keyDown(surface(), { key: "Tab", ctrlKey: true, altKey: true });
    expect(switchTo).not.toHaveBeenCalled();
    expect(await screen.findByText(/nowhere to switch to/i)).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalledWith("pane_send_keys", expect.anything());
  });
});

// ---------------------------------------------------------------------
// TERMINAL-FEEL ROUND (the author: the terminal could not be scrolled or
// clicked, and needed to feel like iTerm2 or Ghostty).
//
// Three separate capabilities, and one rule they all sit under: every one
// of them starts with a real gesture the user made on a focused surface,
// and none of them lets the app act on its own.
// ---------------------------------------------------------------------
describe("Terminal — selection, copy and paste", () => {
  async function focused() {
    render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
    await screen.findByText("hello from the pane");
    const el = surface();
    act(() => el.focus());
    return el;
  }

  function selectTheScreen() {
    const pre = screen.getByText("hello from the pane");
    const range = document.createRange();
    range.selectNodeContents(pre);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  it("copies selected output once the mouse selection finishes, including release outside the pane", async () => {
    await focused();
    fireEvent.mouseDown(screen.getByText("hello from the pane"), { button: 0 });
    selectTheScreen();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "clipboard_write_text")).toHaveLength(0);
    fireEvent.mouseUp(document);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("clipboard_write_text", { text: "hello from the pane" }));
    expect(sends()).toEqual([]);
  });

  it("does not copy outside selections, cross-pane selections, or selections after deactivation", async () => {
    const view = render(<><p>outside content</p><Terminal agent={agent} root={ROOT} embedded active onClose={vi.fn()} /></>);
    await screen.findByText("hello from the pane");
    const output = screen.getByText("hello from the pane");
    const outside = screen.getByText("outside content");
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(outside); selection.removeAllRanges(); selection.addRange(range);
    fireEvent.mouseDown(outside); fireEvent.mouseUp(document);
    fireEvent.mouseDown(output);
    range.setStart(outside.firstChild!, 0); range.setEnd(output.firstChild!, 4);
    selection.removeAllRanges(); selection.addRange(range);
    fireEvent.mouseUp(document);
    fireEvent.mouseDown(output); selectTheScreen();
    view.rerender(<><p>outside content</p><Terminal agent={agent} root={ROOT} embedded active={false} onClose={vi.fn()} /></>);
    fireEvent.mouseUp(document);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "clipboard_write_text")).toHaveLength(0);
  });

  it("surfaces an automatic clipboard copy failure", async () => {
    invokeMock.mockImplementation((cmd: string) => cmd === "clipboard_write_text" ? Promise.reject(new Error("clipboard denied")) : cmd === "pane_read" ? paneRead("hello from the pane") : Promise.resolve());
    await focused();
    fireEvent.mouseDown(screen.getByText("hello from the pane")); selectTheScreen(); fireEvent.mouseUp(document);
    expect((await screen.findByRole("alert")).textContent).toMatch(/copy failed.*clipboard denied/i);
  });

  it("copies the gesture that activates an inactive split after that pane becomes active", async () => {
    const view = render(<Terminal agent={agent} root={ROOT} embedded active={false} onClose={vi.fn()} />);
    await screen.findByText("hello from the pane");
    fireEvent.mouseDown(screen.getByText("hello from the pane"));
    view.rerender(<Terminal agent={agent} root={ROOT} embedded active onClose={vi.fn()} />);
    selectTheScreen(); fireEvent.mouseUp(document);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("clipboard_write_text", { text: "hello from the pane" }));
  });

  it("keeps composer and find selections off the clipboard and copies keyboard-selected output", async () => {
    await focused();
    fireEvent.click(screen.getByRole("button", { name: "Find output" }));
    fireEvent.click(screen.getByRole("button", { name: "Compose prompt" }));
    for (const field of [screen.getByRole("searchbox"), screen.getByRole("textbox", { name: "Agent prompt" })]) {
      fireEvent.mouseDown(field); selectTheScreen(); fireEvent.mouseUp(document);
    }
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "clipboard_write_text")).toHaveLength(0);
    fireEvent.keyDown(surface(), { key: "a", metaKey: true });
    fireEvent.keyUp(surface(), { key: "a", metaKey: true });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("clipboard_write_text", { text: "hello from the pane" }));
  });

  it("does not treat Control-A sent to the application as a copy gesture", async () => {
    await focused(); selectTheScreen();
    fireEvent.keyDown(surface(), { key: "a", ctrlKey: true });
    fireEvent.keyUp(surface(), { key: "a", ctrlKey: true });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "clipboard_write_text")).toHaveLength(0);
    expect(sends()).toEqual([["pane_send_keys", { paneId: "w7:p1", keys: ["ctrl+a"], expectedRoot: ROOT }]]);
  });

  it("⌘C with a selection copies — it neither sends anything to the pane nor blocks the browser's own copy", async () => {
    const el = await focused();
    selectTheScreen();
    invokeMock.mockClear();
    const prevented = !fireEvent.keyDown(el, { key: "c", metaKey: true });
    expect(prevented).toBe(false); // the browser's native copy must still run
    expect(invokeMock).not.toHaveBeenCalledWith("pane_send_text", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("pane_send_keys", expect.anything());
  });

  it("⌘C with nothing selected says so, rather than being a silent no-op or a stray keystroke", async () => {
    const el = await focused();
    window.getSelection()?.removeAllRanges();
    invokeMock.mockClear();
    fireEvent.keyDown(el, { key: "c", metaKey: true });
    expect(await screen.findByText(/nothing is selected/i)).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalledWith("pane_send_keys", expect.anything());
  });

  it("⌘V reads the clipboard once and sends exactly what was on it, with nothing appended", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "pane_read") return paneRead("hello from the pane");
      if (cmd === "clipboard_read_text") return Promise.resolve("npm run tauri dev");
      return Promise.resolve(undefined);
    });
    const el = await focused();
    fireEvent.keyDown(el, { key: "v", metaKey: true });
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("pane_send_text", {
        paneId: "w7:p1",
        text: "npm run tauri dev",
        expectedRoot: ROOT,
      }),
    );
    // No "helpfully" appended newline — §5.6's own words.
    expect(invokeMock).not.toHaveBeenCalledWith("pane_send_keys", {
      paneId: "w7:p1",
      keys: ["enter"],
      expectedRoot: ROOT,
    });
  });

  it("surfaces a refused clipboard read instead of pasting nothing and saying nothing", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "pane_read") return paneRead("hello from the pane");
      if (cmd === "clipboard_read_text")
        return Promise.reject(new Error("could not read the clipboard: denied"));
      return Promise.resolve(undefined);
    });
    const el = await focused();
    fireEvent.keyDown(el, { key: "v", metaKey: true });
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not read the clipboard/i);
  });

  it("⌘A selects the pane's text and nothing the app wrote around it", async () => {
    const el = await focused();
    fireEvent.keyDown(el, { key: "a", metaKey: true });
    const selected = window.getSelection()?.toString() ?? "";
    expect(selected).toContain("hello from the pane");
    expect(selected).not.toMatch(/clicks/i);
    expect(selected).not.toMatch(/⌘C to copy/);
  });

  // The regression this round exists to prevent: herdr ACCEPTS `meta+c`,
  // so before this the copy shortcut put bytes into a live session.
  it("never sends a ⌘ chord the platform reserves for the application", async () => {
    const el = await focused();
    invokeMock.mockClear();
    fireEvent.keyDown(el, { key: "c", metaKey: true });
    fireEvent.keyDown(el, { key: "a", metaKey: true });
    expect(invokeMock).not.toHaveBeenCalledWith("pane_send_keys", expect.anything());
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])("leaves project content search shortcuts to the workspace: %j", async modifier => {
    const el = await focused();
    fireEvent.keyDown(el, { key: "F", shiftKey: true, ...modifier });
    expect(sends()).toEqual([]);
  });
});

describe("Terminal — scrolling", () => {
  const SCREEN = Array.from({ length: 23 }, (_, i) => `visible row ${i}`).join("\n");
  const HISTORY = Array.from({ length: 141 }, (_, i) => `history row ${i}`).join("\n");

  function mockPane(scrollbackText: string) {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "pane_read") return paneRead(SCREEN);
      if (cmd === "pane_read_scrollback")
        return Promise.resolve({ text: scrollbackText, revision: 0, truncated: false });
      return Promise.resolve(undefined);
    });
  }

  async function open() {
    render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
    await screen.findByText(/visible row 0/);
    const el = surface();
    act(() => el.focus());
    return el;
  }

  it("shows the real scrollback when the pane has any, and says the live screen is paused", async () => {
    mockPane(HISTORY);
    const el = await open();
    fireEvent.wheel(el, { deltaY: -120 });
    expect(await screen.findByText(/history row 0/)).toBeTruthy();
    expect(screen.getByText(/the live screen is paused/i)).toBeTruthy();
  });

  // The alternate-screen case — every one of the author's live claude
  // panes. Both sources return the same screen, so there is nothing to
  // show, and the wheel is translated into the scroll key a full-screen
  // program expects. PageUp and not ↑: arrows were measured opening
  // claude's history and rewriting the prompt.
  it("keeps empty-history wheel gestures local instead of injecting page keys into the program", async () => {
    mockPane(SCREEN);
    const el = await open();
    fireEvent.wheel(el, { deltaY: -120 });
    expect(await screen.findByText(/no earlier output/i)).toBeTruthy();
    expect(sends()).toEqual([]);
  });

  it("sends nothing at all when the wheel goes DOWN at the live screen — you are already at the bottom", async () => {
    mockPane(SCREEN);
    const el = await open();
    fireEvent.wheel(el, { deltaY: 120 });
    expect(await screen.findByText(/this is the bottom/i)).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalledWith("pane_send_text", expect.anything());
  });

  it("a long trackpad flick never becomes repeated page keys", async () => {
    mockPane(SCREEN);
    const el = await open();
    for (let i = 0; i < 12; i += 1) {
      fireEvent.wheel(el, { deltaY: -120 });
      await act(async () => { await Promise.resolve(); });
    }
    await vi.waitFor(() => expect(screen.getByText(/no earlier output/i)).toBeTruthy());
    const sends = invokeMock.mock.calls.filter(([cmd]) => cmd === "pane_send_text");
    expect(sends.length).toBe(0);
  });

  it("scrolls the visible local viewport before requesting history even when the wheel targets padding", async () => {
    mockPane(SCREEN);
    const el = await open();
    const fit = document.querySelector(".terminal__fit") as HTMLElement;
    Object.defineProperties(fit, { scrollHeight: { value: 800 }, clientHeight: { value: 200 } });
    fit.scrollTop = 300;
    fireEvent.wheel(el, { deltaY: -42 });
    expect(fit.scrollTop).toBe(258);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "pane_read_scrollback")).toHaveLength(0);
  });

  it("preserves the visible output position when continuing upward into history", async () => {
    mockPane(HISTORY);
    const el = await open();
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function(this: HTMLElement) { return this.classList.contains("terminal__scrollback") ? 1800 : 800; });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
    const fit = document.querySelector(".terminal__fit") as HTMLElement;
    fit.scrollTop = 0;
    fireEvent.scroll(fit);
    fireEvent.wheel(el, { deltaY: -42 });
    await screen.findByText(/history row 0/);
    const history = document.querySelector(".terminal__scrollback") as HTMLElement;
    // The live viewport was already 600px above the bottom before this 42px gesture.
    expect(history.scrollTop).toBe(958);
  });

  it("keeps a mirror pinned to the prompt when its viewport shrinks without moving a reader's scroll position", async () => {
    let height = 200;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => height);
    mockPane(SCREEN);
    await open();
    const fit = document.querySelector(".terminal__fit") as HTMLElement;
    expect(fit.scrollTop).toBe(600);
    height = 80;
    fireEvent(window, new Event("resize"));
    expect(fit.scrollTop).toBe(720);
    fit.scrollTop = 300; fireEvent.scroll(fit);
    height = 100;
    fireEvent(window, new Event("resize"));
    expect(fit.scrollTop).toBe(300);
  });

  it("typing goes straight back to the live screen, the way it does in iTerm2", async () => {
    mockPane(HISTORY);
    const el = await open();
    fireEvent.wheel(el, { deltaY: -120 });
    await screen.findByText(/history row 0/);
    fireEvent.keyDown(el, { key: "x" });
    await vi.waitFor(() => expect(screen.queryByText(/the live screen is paused/i)).toBeNull());
    expect(invokeMock).toHaveBeenCalledWith("pane_send_text", {
      paneId: "w7:p1",
      text: "x",
      expectedRoot: ROOT,
    });
  });

  // The paused mirror must actually be paused: a scrollback view sitting
  // over a poll loop that keeps running would be reading a screen nobody
  // can see, which is the same waste the window-focus gate exists for.
  it("stops reading the live pane while the scrollback view is up", async () => {
    vi.useFakeTimers();
    try {
      mockPane(HISTORY);
      render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
      await act(async () => {
        await Promise.resolve();
      });
      const el = surface();
      fireEvent.wheel(el, { deltaY: -120 });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const before = invokeMock.mock.calls.filter(([cmd]) => cmd === "pane_read").length;
      await act(async () => {
        vi.advanceTimersByTime(3000);
        await Promise.resolve();
      });
      const after = invokeMock.mock.calls.filter(([cmd]) => cmd === "pane_read").length;
      expect(after).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Terminal — the keys herdr has no word for", () => {
  async function focused() {
    render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
    await screen.findByText("hello from the pane");
    const el = surface();
    act(() => el.focus());
    return el;
  }

  // herdr rejects `pageup`/`home`/`delete` outright (measured), so these
  // keys used to do nothing but produce an error. They now travel as the
  // bytes `infocmp xterm-256color` declares, through the same
  // `pane_send_text` a typed character uses.
  it("sends PageUp, Home and Delete as escape sequences rather than as rejected key names", async () => {
    const el = await focused();
    for (const [key, bytes] of [
      ["PageUp", "\x1b[5~"],
      ["Home", "\x1bOH"],
      ["Delete", "\x1b[3~"],
    ] as const) {
      invokeMock.mockClear();
      fireEvent.keyDown(el, { key });
      expect(invokeMock).toHaveBeenCalledWith("pane_send_text", {
        paneId: "w7:p1",
        text: bytes,
        expectedRoot: ROOT,
      });
      expect(invokeMock).not.toHaveBeenCalledWith("pane_send_keys", expect.anything());
    }
  });

  it("still hands a MODIFIED press to herdr, rather than guessing at xterm's modifier encoding", async () => {
    const el = await focused();
    fireEvent.keyDown(el, { key: "Home", ctrlKey: true });
    expect(invokeMock).toHaveBeenCalledWith("pane_send_keys", {
      paneId: "w7:p1",
      keys: ["ctrl+home"],
      expectedRoot: ROOT,
    });
  });

  it("sends a paste that arrives as a DOM event, once, exactly as pasted", async () => {
    const el = await focused();
    fireEvent.paste(el, { clipboardData: { getData: () => "git status" } });
    expect(invokeMock).toHaveBeenCalledWith("pane_send_text", {
      paneId: "w7:p1",
      text: "git status",
      expectedRoot: ROOT,
    });
    const sends = invokeMock.mock.calls.filter(([cmd]) => cmd === "pane_send_text");
    expect(sends.length).toBe(1);
  });
});

describe("workspace terminal controls", () => {
  beforeEach(() => localStorage.clear());
  it("opens ready for keyboard input when explicitly requested by the workbench", async () => {
    render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} embedded autoFocus />);
    await screen.findByText("hello from the pane");
    expect(document.activeElement).toBe(surface());
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(surface(), { key: "Escape" });
    expect(invokeMock).toHaveBeenCalledWith("pane_send_keys", { paneId: agent.pane_id, keys: ["escape"], expectedRoot: ROOT });
  });
  it("keeps the user's text size across terminal switches", async () => {
    const first = render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
    await screen.findByText("hello from the pane");
    fireEvent.click(screen.getByRole("button", { name: "Increase text size" }));
    expect(screen.getByLabelText("Terminal text size").textContent).toBe("15px");
    first.unmount();
    render(<Terminal agent={{ ...agent, pane_id: "w8:p1" }} root={ROOT} onClose={vi.fn()} />);
    expect(screen.getByLabelText("Terminal text size").textContent).toBe("15px");
    await screen.findByText("hello from the pane");
  });
  it("does not close the terminal when Escape belongs to a different open dialog", async () => {
    const onClose = vi.fn();
    render(<><Terminal agent={agent} root={ROOT} onClose={onClose} embedded /><div role="dialog" aria-label="New project"><input aria-label="Project name" /></div></>);
    await screen.findByText("hello from the pane");
    screen.getByRole("textbox").focus();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

it("applies text-size changes to scrollback immediately and retains them on returning live", async () => {
  localStorage.clear();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "pane_read_scrollback") return paneRead("earlier line\nhello from the pane");
    if (cmd === "pane_read") return paneRead("hello from the pane");
    return Promise.resolve(undefined);
  });
  render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
  await screen.findByText("hello from the pane");
  fireEvent.click(screen.getByRole("button", { name: "Scrollback" }));
  await screen.findByText(/earlier line/);
  fireEvent.click(screen.getByRole("button", { name: "Increase text size" }));
  const history = document.querySelector(".terminal__scrollback") as HTMLElement;
  expect(history.style.fontSize).toBe("15px");
  fireEvent.click(screen.getByRole("button", { name: "Back to live" }));
  expect(screen.getByLabelText("Terminal text size").textContent).toBe("15px");
  expect((document.querySelector(".terminal__grid-inner") as HTMLElement).style.transform).toBe("scale(1.1538461538461537)");
});

it("raises the external terminal only from its explicit control", async () => {
  render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
  await screen.findByText("hello from the pane");
  expect(invokeMock.mock.calls.some(([cmd]) => cmd === "focus_pane")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Focus external terminal ↗" }));
  expect(await screen.findByText(/focused fixing the bug in your own terminal/)).toBeTruthy();
  expect(invokeMock).toHaveBeenCalledWith("focus_pane", { paneId: "w7:p1" });
});

it("starts at the prompt when a readable pane is taller than its viewport", async () => {
  localStorage.clear();
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
  render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
  await screen.findByText("hello from the pane");
  const fit = document.querySelector(".terminal__fit") as HTMLElement;
  expect(fit.scrollTop).toBe(600);
});

describe("terminal output tools", () => {
  const promptAgent = { ...agent, kind: "codex" };

  it("finds visible text across ANSI runs and navigates matches without changing pane output", async () => {
    invokeMock.mockImplementation((cmd: string) => cmd === "pane_read"
      ? paneRead("he\x1b[32mllo\x1b[0m there\nhello again") : Promise.resolve(undefined));
    render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
    await screen.findByText("llo");
    fireEvent.click(screen.getByRole("button", { name: "Find output" }));
    const search = screen.getByRole("searchbox", { name: "Find in output" });
    fireEvent.change(search, { target: { value: "HELLO" } });
    expect(screen.getByLabelText("Output match").textContent).toBe("1 of 2");
    const highlights = document.querySelectorAll("mark.terminal__match--current");
    expect([...highlights].map(mark => mark.textContent).join("")).toBe("hello");
    expect((screen.getByText("llo").parentElement as HTMLElement).style.color).not.toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByLabelText("Output match").textContent).toBe("2 of 2");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByLabelText("Output match").textContent).toBe("1 of 2");
    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(screen.getByLabelText("Output match").textContent).toBe("2 of 2");
    expect(surface().querySelector("pre")?.textContent).toBe("hello there\nhello again");
    expect(sends()).toEqual([]);
  });

  it("replaces search results when the current screen changes instead of accumulating snapshots", async () => {
    vi.useFakeTimers();
    let output = "first match";
    invokeMock.mockImplementation((cmd: string) => cmd === "pane_read" ? paneRead(output) : Promise.resolve(undefined));
    render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Find output" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "match" } });
    expect(screen.getByLabelText("Output match").textContent).toBe("1 of 1");
    output = "a new screen";
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.getByLabelText("Output match").textContent).toBe("0 of 0");
    expect(surface().querySelector("pre")?.textContent).toBe("a new screen");
  });

  it("searches the real scrollback when it is opened and returns to current-screen matches when live", async () => {
    invokeMock.mockImplementation((cmd: string) => cmd === "pane_read_scrollback"
      ? paneRead("earlier hello\nhello from the pane") : cmd === "pane_read" ? paneRead("hello from the pane") : Promise.resolve(undefined));
    render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
    await screen.findByText("hello from the pane");
    fireEvent.click(screen.getByRole("button", { name: "Scrollback" }));
    await screen.findByText(/earlier hello/);
    fireEvent.click(screen.getByRole("button", { name: "Find output" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "hello" } });
    expect(screen.getByLabelText("Output match").textContent).toBe("1 of 2");
    fireEvent.click(screen.getByRole("button", { name: "Back to live" }));
    expect(screen.getByLabelText("Output match").textContent).toBe("1 of 1");
  });

  it("sends a multiline prompt only from the explicit button and never paints it as pane output", async () => {
    const switchTo = vi.fn();
    render(<TerminalStageProvider stage={{ claimScene: () => () => {}, targets: [HERE, target("w8:p1", "other")], switchTo }}>
      <Terminal agent={promptAgent} root={ROOT} onClose={vi.fn()} />
    </TerminalStageProvider>);
    await screen.findByText("hello from the pane");
    fireEvent.click(screen.getByRole("button", { name: "Compose prompt" }));
    const input = screen.getByRole("textbox", { name: "Agent prompt" });
    input.focus();
    fireEvent.change(input, { target: { value: "First line\nSecond line" } });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
    fireEvent.keyDown(input, { key: "Tab", ctrlKey: true, altKey: true });
    fireEvent.keyDown(input, { key: "k", metaKey: true });
    expect(sends()).toEqual([]);
    expect(switchTo).not.toHaveBeenCalled();
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "send_prompt")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Send prompt" }));
    await screen.findByText("Prompt sent.");
    expect(invokeMock).toHaveBeenCalledWith("send_prompt", { paneId: "w7:p1", text: "First line\nSecond line", expectedRoot: ROOT });
    expect((input as HTMLTextAreaElement).value).toBe("");
    expect(surface().querySelector("pre")?.textContent).toBe("hello from the pane");
  });

  it("keeps the draft after send failure and refuses duplicate submissions while pending", async () => {
    let rejectSend!: (error: Error) => void;
    invokeMock.mockImplementation((cmd: string) => cmd === "send_prompt"
      ? new Promise((_, reject) => { rejectSend = reject; }) : cmd === "pane_read" ? paneRead("hello from the pane") : Promise.resolve(undefined));
    render(<Terminal agent={promptAgent} root={ROOT} onClose={vi.fn()} />);
    await screen.findByText("hello from the pane");
    fireEvent.click(screen.getByRole("button", { name: "Compose prompt" }));
    const input = screen.getByRole("textbox", { name: "Agent prompt" });
    fireEvent.change(input, { target: { value: "Keep this draft\nplease" } });
    const send = screen.getByRole("button", { name: "Send prompt" });
    fireEvent.click(send);
    fireEvent.click(send);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "send_prompt")).toHaveLength(1);
    await act(async () => { rejectSend(new Error("pane is no longer available")); });
    expect(screen.getByRole("alert").textContent).toContain("pane is no longer available");
    expect((input as HTMLTextAreaElement).value).toBe("Keep this draft\nplease");
    expect((send as HTMLButtonElement).disabled).toBe(false);
  });

  it("enforces the 20,000 Unicode-character prompt limit without cutting the draft", async () => {
    render(<Terminal agent={promptAgent} root={ROOT} onClose={vi.fn()} />);
    await screen.findByText("hello from the pane");
    fireEvent.click(screen.getByRole("button", { name: "Compose prompt" }));
    const input = screen.getByRole("textbox", { name: "Agent prompt" });
    const send = screen.getByRole("button", { name: "Send prompt" });
    fireEvent.change(input, { target: { value: "🌳".repeat(20_000) } });
    expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(input, { target: { value: "🌳".repeat(20_001) } });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    expect((input as HTMLTextAreaElement).value).toBe("🌳".repeat(20_001));
    fireEvent.click(send);
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "send_prompt")).toBe(false);
  });

  it("does not submit an agent prompt to an unknown shell pane", async () => {
    render(<Terminal agent={agent} root={ROOT} onClose={vi.fn()} />);
    await screen.findByText("hello from the pane");
    fireEvent.click(screen.getByRole("button", { name: "Compose prompt" }));
    expect((screen.getByRole("button", { name: "Send prompt" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/No agent kind is reported/)).toBeTruthy();
  });
});

describe("split terminal input ownership", () => {
  it("lets only the active split autofocus, switch and close from global shortcuts", async () => {
    const inactiveSwitch = vi.fn();
    const activeSwitch = vi.fn();
    const inactiveClose = vi.fn();
    const activeClose = vi.fn();
    render(<>
      <TerminalStageProvider stage={{ claimScene: () => () => {}, targets: [HERE, target("w8:p1", "other")], switchTo: inactiveSwitch }}>
        <Terminal agent={agent} root={ROOT} onClose={inactiveClose} embedded autoFocus active={false} />
      </TerminalStageProvider>
      <TerminalStageProvider stage={{ claimScene: () => () => {}, targets: [HERE, target("w8:p1", "other")], switchTo: activeSwitch }}>
        <Terminal agent={{ ...agent, pane_id: "w8:p1", title: "active agent" }} root="/p/other" onClose={activeClose} embedded autoFocus active />
      </TerminalStageProvider>
    </>);
    const inactive = within(screen.getByRole("region", { name: "Terminal: fixing the bug" }));
    const active = within(screen.getByRole("region", { name: "Terminal: active agent" }));
    await waitFor(() => expect(active.getByText("hello from the pane")).toBeTruthy());
    expect(document.activeElement).toBe(active.getByRole("application"));
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, altKey: true });
    expect(activeSwitch).toHaveBeenCalledTimes(1);
    expect(inactiveSwitch).not.toHaveBeenCalled();
    inactive.getByRole("button", { name: "Keyboard help" }).focus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(activeClose).toHaveBeenCalledTimes(1);
    expect(inactiveClose).not.toHaveBeenCalled();
    inactive.getByRole("application").focus();
    fireEvent.keyDown(inactive.getByRole("application"), { key: "x" });
    expect(sends()).toEqual([]);
  });

  it("does not steal focus from a split's own composer when that split becomes active", async () => {
    const view = render(<Terminal agent={{ ...agent, kind: "codex" }} root={ROOT} onClose={vi.fn()} embedded autoFocus active={false} />);
    await screen.findByText("hello from the pane");
    expect(document.activeElement).not.toBe(surface());
    fireEvent.click(screen.getByRole("button", { name: "Compose prompt" }));
    const input = screen.getByRole("textbox", { name: "Agent prompt" });
    input.focus();
    view.rerender(<Terminal agent={{ ...agent, kind: "codex" }} root={ROOT} onClose={vi.fn()} embedded autoFocus active />);
    expect(document.activeElement).toBe(input);
  });

  it("keeps the selected search input focused when reactivating a split with an open composer", async () => {
    const view = render(<Terminal agent={{ ...agent, kind: "codex" }} root={ROOT} onClose={vi.fn()} embedded autoFocus active={false} />);
    await screen.findByText("hello from the pane");
    fireEvent.click(screen.getByRole("button", { name: "Compose prompt" }));
    fireEvent.click(screen.getByRole("button", { name: "Find output" }));
    const search = screen.getByRole("searchbox");
    search.focus();
    view.rerender(<Terminal agent={{ ...agent, kind: "codex" }} root={ROOT} onClose={vi.fn()} embedded autoFocus active />);
    expect(document.activeElement).toBe(search);
  });
});
