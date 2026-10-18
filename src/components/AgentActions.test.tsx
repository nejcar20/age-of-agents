// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentActions } from "./AgentActions";
import {
  RAISE_EXTERNAL_TERMINAL_LABEL,
  RAISE_EXTERNAL_TERMINAL_TITLE,
  raisedExternalNote,
} from "../externalTerminal";
import { isInteractiveTarget } from "../useHotkey";
import type { Agent } from "../world";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

beforeEach(() => {
  // `Terminal`'s poll only runs while `useWindowFocused` reports focused —
  // see `Terminal.test.tsx`'s identical setup for why this is asserted
  // explicitly rather than assumed of jsdom's default.
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  vi.restoreAllMocks();
});

const agent: Agent = {
  pane_id: "w1:p1",
  workspace_id: "w1",
  status: "working",
  attention: "working",
  title: "fixing the bug",
  kind: null,
  is_worktree: false,
  cwd: "/p/pocketAlarm",
};

const ROOT = "/p/pocketAlarm";

describe("AgentActions", () => {
  it("fetches and shows a snapshot of the agent's recent output on mount", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_agent") {
        return Promise.resolve({ text: "> implementing the fix\nlooks good", truncated: false });
      }
      return Promise.resolve(undefined);
    });
    render(<AgentActions agent={agent} root={ROOT} onOpenTerminal={vi.fn()} />);
    expect(invokeMock).toHaveBeenCalledWith("read_agent", { paneId: "w1:p1", lines: undefined });
    await screen.findByText(/looks good/);
    // Labelled as a snapshot, never implying a live tail (Item 7).
    expect(screen.getByText(/snapshot/i)).toBeTruthy();
  });

  it("shows an honest error when reading the agent's output fails", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_agent") return Promise.reject(new Error("pane gone"));
      return Promise.resolve(undefined);
    });
    render(<AgentActions agent={agent} root={ROOT} onOpenTerminal={vi.fn()} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/pane gone/);
  });

  // Security review, MINOR 5: `truncated` is now its own structured field on
  // `read_agent`'s result, never spliced into `text` as literal wording —
  // the app's own affordance must render separately from the (untrusted)
  // transcript, so an agent that printed this exact sentence itself could
  // never be confused with the app saying it.
  it("shows a truncated badge as its own element, never inside the transcript text", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_agent") {
        return Promise.resolve({ text: "some recent output", truncated: true });
      }
      return Promise.resolve(undefined);
    });
    render(<AgentActions agent={agent} root={ROOT} onOpenTerminal={vi.fn()} />);
    const badge = await screen.findByText(/truncated/i);
    const transcript = await screen.findByText("some recent output");
    expect(badge).not.toBe(transcript);
    expect(transcript.textContent).toBe("some recent output");
  });

  it("shows no truncated badge when the read was not truncated", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_agent") return Promise.resolve({ text: "all of it", truncated: false });
      return Promise.resolve(undefined);
    });
    render(<AgentActions agent={agent} root={ROOT} onOpenTerminal={vi.fn()} />);
    await screen.findByText("all of it");
    expect(screen.queryByText(/truncated/i)).toBeNull();
  });

  it("re-fetches only when the refresh button is clicked, never on a timer", async () => {
    vi.useFakeTimers();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_agent") return Promise.resolve({ text: "first read", truncated: false });
      return Promise.resolve(undefined);
    });
    render(<AgentActions agent={agent} root={ROOT} onOpenTerminal={vi.fn()} />);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_agent") return Promise.resolve({ text: "second read", truncated: false });
      return Promise.resolve(undefined);
    });
    fireEvent.click(await screen.findByRole("button", { name: "refresh" }));
    await screen.findByText("second read");
  });

  // Phase 0.7: the compose box (Herdr's `agent.prompt`) is now always
  // visible inline on this row, never gated behind opening `Terminal` — see
  // this file's own module doc comment for why the two are now separate
  // controls. `Terminal` itself (its raw pane_read/pane_send_text/keys
  // behaviour) is covered by `Terminal.test.tsx`, not here.

  it("never calls send_prompt just from typing in the box", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_agent") return Promise.resolve({ text: "", truncated: false });
      return Promise.resolve(undefined);
    });
    render(<AgentActions agent={agent} root={ROOT} onOpenTerminal={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/message this agent/i), {
      target: { value: "please add a test" },
    });
    expect(invokeMock).not.toHaveBeenCalledWith("send_prompt", expect.anything());
  });

  it("sends the composed prompt with the island's root as expected_root, and clears the box", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_agent") return Promise.resolve({ text: "", truncated: false });
      if (cmd === "send_prompt") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });
    render(<AgentActions agent={agent} root={ROOT} onOpenTerminal={vi.fn()} />);
    const box = screen.getByPlaceholderText(/message this agent/i) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "please add a test" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("send_prompt", {
        paneId: "w1:p1",
        text: "please add a test",
        expectedRoot: ROOT,
      }),
    );
    await waitFor(() => expect(box.value).toBe(""));
  });

  it("sends on Enter, but a Shift+Enter inserts a newline instead", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_agent") return Promise.resolve({ text: "", truncated: false });
      if (cmd === "send_prompt") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });
    render(<AgentActions agent={agent} root={ROOT} onOpenTerminal={vi.fn()} />);
    const box = screen.getByPlaceholderText(/message this agent/i);
    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(invokeMock).not.toHaveBeenCalledWith("send_prompt", expect.anything());
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("send_prompt", {
        paneId: "w1:p1",
        text: "hello",
        expectedRoot: ROOT,
      }),
    );
  });

  it("shows an honest error when sending fails (e.g. a stale pane reused for a different repo), and keeps the composed text", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_agent") return Promise.resolve({ text: "", truncated: false });
      if (cmd === "send_prompt") return Promise.reject(new Error("agent not ready"));
      return Promise.resolve(undefined);
    });
    render(<AgentActions agent={agent} root={ROOT} onOpenTerminal={vi.fn()} />);
    const box = screen.getByPlaceholderText(/message this agent/i) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "please add a test" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/agent not ready/);
    expect(box.value).toBe("please add a test");
  });

  // SEA/TOWN CONSISTENCY ROUND. This row used to mount its own `Terminal`
  // at sea while delegating to its host in a town — one concept, two
  // implementations. It now always delegates, on both screens, which is
  // what keeps "which pane is the keyboard pointed at" a single piece of
  // state with a single answer (§5.6's own condition on the terminal
  // existing at all).
  it("asks its host to open the terminal, and never mounts one itself", async () => {
    const onOpenTerminal = vi.fn();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_agent") return Promise.resolve({ text: "hello from the agent", truncated: false });
      if (cmd === "pane_read") return Promise.resolve({ text: "hello from the pane", revision: 0, truncated: false });
      return Promise.resolve(undefined);
    });
    render(<AgentActions agent={agent} root={ROOT} onOpenTerminal={onOpenTerminal} />);
    await screen.findByText("hello from the agent");
    fireEvent.click(screen.getByRole("button", { name: /open terminal/i }));
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
    // No second, competing mirror of the same pane: nothing here read the
    // pane, and no terminal surface exists in this subtree.
    expect(screen.queryByRole("application")).toBeNull();
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "pane_read")).toBe(false);
    // And asking for the terminal left this row's own snapshot alone.
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "read_agent")).toHaveLength(1);
  });

  // The explicit way OUT to the user's own terminal window, which lives
  // here — one button, one label, one call — for BOTH screens. It used to
  // live in `VillagerPanel` (town only) while the sea did the same thing
  // from a plain villager click, silently.
  describe("raising the user's own terminal window", () => {
    function raiseStubs(focusResult: () => Promise<unknown>) {
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "read_agent") return Promise.resolve({ text: "output", truncated: false });
        if (cmd === "focus_pane") return focusResult();
        return Promise.resolve(undefined);
      });
    }

    it("never calls focus_pane until its own button is clicked", async () => {
      raiseStubs(() => Promise.resolve(undefined));
      render(<AgentActions agent={agent} root={ROOT} onOpenTerminal={vi.fn()} />);
      await screen.findByText("output");
      expect(invokeMock.mock.calls.some(([cmd]) => cmd === "focus_pane")).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: RAISE_EXTERNAL_TERMINAL_LABEL }));
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("focus_pane", { paneId: "w1:p1" }));
    });

    it("says it leaves the app, in the button's own tooltip", async () => {
      raiseStubs(() => Promise.resolve(undefined));
      render(<AgentActions agent={agent} root={ROOT} onOpenTerminal={vi.fn()} />);
      const button = await screen.findByRole("button", { name: RAISE_EXTERNAL_TERMINAL_LABEL });
      expect(button.getAttribute("title")).toBe(RAISE_EXTERNAL_TERMINAL_TITLE);
      expect(button.getAttribute("title")).toMatch(/leaves the app/);
    });

    it("reports what happened, naming the agent — and does not open the embedded terminal", async () => {
      const onOpenTerminal = vi.fn();
      raiseStubs(() => Promise.resolve(undefined));
      render(<AgentActions agent={agent} root={ROOT} onOpenTerminal={onOpenTerminal} />);
      await screen.findByText("output");
      fireEvent.click(screen.getByRole("button", { name: RAISE_EXTERNAL_TERMINAL_LABEL }));
      expect(await screen.findByText(raisedExternalNote(agent))).toBeTruthy();
      // Two different gestures: this one must never do the other one's job.
      expect(onOpenTerminal).not.toHaveBeenCalled();
    });

    it("quotes herdr's own reason when it fails, instead of claiming success", async () => {
      raiseStubs(() => Promise.reject(new Error("w1:p1 is not a pane in the current world")));
      render(<AgentActions agent={agent} root={ROOT} onOpenTerminal={vi.fn()} />);
      await screen.findByText("output");
      fireEvent.click(screen.getByRole("button", { name: RAISE_EXTERNAL_TERMINAL_LABEL }));
      expect(await screen.findByText(/focus failed:.*not a pane in the current world/)).toBeTruthy();
      expect(screen.queryByText(raisedExternalNote(agent))).toBeNull();
    });
  });

  it("the prompt textarea is an interactive target, so the global Space hotkey already bails on it", () => {
    // Proves the exact property the coordinator asked to verify, against
    // the real `isInteractiveTarget` the Space hotkey uses — not just an
    // assumption that TEXTAREA is covered.
    expect(isInteractiveTarget({ tagName: "TEXTAREA" } as unknown as EventTarget)).toBe(true);
  });
});
