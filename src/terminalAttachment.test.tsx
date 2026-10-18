// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  attachedAgent,
  paneGoneNote,
  useTerminalAttachment,
  type AttachmentHost,
} from "./terminalAttachment";
import type { Agent } from "./world";

afterEach(cleanup);

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    pane_id: "w2:p1",
    workspace_id: "w2",
    status: "working",
    attention: "working",
    title: "claude",
    kind: "claude",
    is_worktree: false,
    cwd: "/p/orchard",
    ...overrides,
  };
}

const ORCHARD: AttachmentHost = { root: "/p/orchard", agents: [agent()] };
const OTHER: AttachmentHost = {
  root: "/p/pocketAlarm",
  // The same pane id, in a different repository — herdr really does
  // recycle `w<N>:p1`-style ids once a workspace closes, which is the whole
  // reason `root` travels with the pane id.
  agents: [agent({ pane_id: "w2:p1", cwd: "/p/pocketAlarm", title: "codex", kind: "codex" })],
};

describe("attachedAgent", () => {
  it("is null with no attachment", () => {
    expect(attachedAgent(null, [ORCHARD])).toBeNull();
  });

  it("resolves the live agent, not a captured copy", () => {
    const stopped = { root: "/p/orchard", agents: [agent({ attention: "stopped", status: "blocked" })] };
    const found = attachedAgent({ paneId: "w2:p1", root: "/p/orchard", seq: 1 }, [stopped]);
    expect(found?.attention).toBe("stopped");
  });

  // The assertion that matters: matching on the pane id ALONE would point a
  // terminal's header at an unrelated agent in an unrelated repository the
  // moment herdr recycles an id.
  it("matches root first, so a recycled pane id cannot resolve to the wrong repository", () => {
    const found = attachedAgent({ paneId: "w2:p1", root: "/p/pocketAlarm", seq: 1 }, [ORCHARD, OTHER]);
    expect(found?.cwd).toBe("/p/pocketAlarm");
    expect(found?.kind).toBe("codex");
  });

  it("is null when the root is in the world but the pane is not", () => {
    expect(attachedAgent({ paneId: "w9:p9", root: "/p/orchard", seq: 1 }, [ORCHARD])).toBeNull();
  });

  it("is null when the root itself is gone from the world", () => {
    expect(attachedAgent({ paneId: "w2:p1", root: "/p/gone", seq: 1 }, [ORCHARD])).toBeNull();
  });
});

describe("paneGoneNote", () => {
  it("names the pane and says only what is known", () => {
    expect(paneGoneNote("w2:p1")).toBe(
      "w2:p1 is no longer running — herdr does not report that pane any more",
    );
  });
});

describe("useTerminalAttachment", () => {
  it("starts detached — nothing in this app opens a terminal unasked", () => {
    const { result } = renderHook(() => useTerminalAttachment([ORCHARD], vi.fn()));
    expect(result.current.attachment).toBeNull();
    expect(result.current.attached).toBeNull();
  });

  it("carries the root it was given, never one inferred at the far end", () => {
    const { result } = renderHook(() => useTerminalAttachment([ORCHARD, OTHER], vi.fn()));
    act(() => result.current.attach("w2:p1", "/p/pocketAlarm"));
    expect(result.current.attachment?.root).toBe("/p/pocketAlarm");
    expect(result.current.attached?.kind).toBe("codex");
  });

  // `seq` is the `Terminal`'s React key on both screens, so this property
  // IS "every switch is a fresh mount, with no keyboard focus carried over
  // to a different agent's session".
  it("gives every attachment a new seq, including re-attaching to the same pane", () => {
    const { result } = renderHook(() => useTerminalAttachment([ORCHARD], vi.fn()));
    act(() => result.current.attach("w2:p1", "/p/orchard"));
    const first = result.current.attachment?.seq;
    act(() => result.current.detach());
    act(() => result.current.attach("w2:p1", "/p/orchard"));
    expect(result.current.attachment?.seq).toBeGreaterThan(first as number);
  });

  it("detaches on request, and says nothing — the user closed it themselves", () => {
    const onPaneGone = vi.fn();
    const { result } = renderHook(() => useTerminalAttachment([ORCHARD], onPaneGone));
    act(() => result.current.attach("w2:p1", "/p/orchard"));
    act(() => result.current.detach());
    expect(result.current.attachment).toBeNull();
    expect(onPaneGone).not.toHaveBeenCalled();
  });

  // An agent that exits while its terminal is open takes the terminal with
  // it AND says so. This used to be true in a town and silently false at
  // sea — the one visible consequence of two implementations of one idea.
  it("drops the attachment, with an honest sentence, when herdr stops reporting the pane", () => {
    const onPaneGone = vi.fn();
    const { result, rerender } = renderHook(
      ({ hosts }: { hosts: AttachmentHost[] }) => useTerminalAttachment(hosts, onPaneGone),
      { initialProps: { hosts: [ORCHARD] } },
    );
    act(() => result.current.attach("w2:p1", "/p/orchard"));
    expect(result.current.attached).not.toBeNull();
    rerender({ hosts: [{ root: "/p/orchard", agents: [] }] });
    expect(result.current.attachment).toBeNull();
    expect(onPaneGone).toHaveBeenCalledWith(paneGoneNote("w2:p1"));
  });

  it("says it once, not once per world update", () => {
    const onPaneGone = vi.fn();
    const { result, rerender } = renderHook(
      ({ hosts }: { hosts: AttachmentHost[] }) => useTerminalAttachment(hosts, onPaneGone),
      { initialProps: { hosts: [ORCHARD] } },
    );
    act(() => result.current.attach("w2:p1", "/p/orchard"));
    rerender({ hosts: [{ root: "/p/orchard", agents: [] }] });
    rerender({ hosts: [{ root: "/p/orchard", agents: [] }] });
    rerender({ hosts: [] });
    expect(onPaneGone).toHaveBeenCalledTimes(1);
  });

  // A fresh closure every render is the common case (each screen's callback
  // closes over its own note state), and it must not re-arm anything.
  it("is not churned by a caller that passes a new callback every render", () => {
    const calls: string[] = [];
    const { result, rerender } = renderHook(
      ({ hosts }: { hosts: AttachmentHost[] }) =>
        useTerminalAttachment(hosts, (message) => calls.push(message)),
      { initialProps: { hosts: [ORCHARD] } },
    );
    act(() => result.current.attach("w2:p1", "/p/orchard"));
    rerender({ hosts: [ORCHARD] });
    rerender({ hosts: [ORCHARD] });
    expect(calls).toEqual([]);
    expect(result.current.attached).not.toBeNull();
  });
});
