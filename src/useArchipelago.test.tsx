// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useArchipelago } from "./useArchipelago";
import type { Archipelago, IslandView } from "./archipelago";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

/** A promise plus its own `resolve`, for tests that need to hold an `invoke`
 * call open (unresolved) across several assertions before releasing it — the
 * Promise executor runs SYNCHRONOUSLY, so `resolve` is already assigned by
 * the time this returns (no closure-narrowing games for TS to lose track
 * of). */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function island(root: string): IslandView {
  return {
    root,
    name: root.split("/").pop() ?? root,
    plot: { x: 0, z: 0, w: 10, d: 10 },
    city: { status: "known", district_count: 1, building_count: 1, width: 5, depth: 5, source: "Git", measured_at: null },
    last_changed_at: null,
  };
}

/** Renders `useArchipelago`'s state as text, the same "Probe" pattern
 * `useWindowFocused.test.tsx` already uses for hook-level assertions without
 * needing a real `<Archipelago>`/`<Canvas>` tree. */
function Probe() {
  const state = useArchipelago();
  if (state.kind === "loading") return <div data-testid="probe">loading</div>;
  if (state.kind === "error") return <div data-testid="probe">error:{state.message}</div>;
  const stale = state.staleError !== undefined ? `:stale:${state.staleError}` : "";
  return (
    <div data-testid="probe">
      ready:{state.islands.map((i) => i.root).join(",")}
      {stale}
    </div>
  );
}

/**
 * CRITICAL 4 (Opus frontend review): before this fix, a refresh failure
 * after a successful fetch set `{kind: "ready", islands: lastGoodRef.current}`
 * and dropped the error entirely — `ArchipelagoFetchState` had no field to
 * carry it, so the sea confidently kept showing the old island list with no
 * indication anything had gone wrong (e.g. an alt-tab back after deleting a
 * repo, or after `create_project`'s own `refetch()`).
 */
describe("useArchipelago", () => {
  /**
   * Regression test for the launch-blocking bug traced against commit
   * `51fe06c`: `inFlightRef` is a ref, so it survives React StrictMode's
   * dev mount -> cleanup -> remount. Mount 1 sets it `true` and issues
   * invoke #1; StrictMode's cleanup never resets it; mount 2's `fetchIt`
   * then sees it still `true`, sets `pendingRefetchRef` instead of
   * invoking, and returns without ever calling `invoke`. When invoke #1
   * finally resolves, its epoch no longer matches (mount 2 bumped it), so
   * both the `setState` AND the trailing-refetch check are skipped — no
   * fetch is ever associated with the live mount, and the hook sits in
   * `loading` forever. This is why the sea never loaded on launch in dev.
   */
  it("reaches ready after a StrictMode mount -> cleanup -> remount, even when mount 1's invoke resolves after the remount", async () => {
    const first = deferred<Archipelago>();
    const second = deferred<Archipelago>();
    invokeMock.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    expect(screen.getByTestId("probe").textContent).toBe("loading");

    // Mount 1's now-stale invoke resolves AFTER StrictMode's remount has
    // already happened — it must be ignored, not mistaken for the live
    // mount's answer.
    await act(async () => {
      first.resolve({ islands: [] } satisfies Archipelago);
      await Promise.resolve();
    });

    // The live mount's own invoke resolves.
    await act(async () => {
      second.resolve({ islands: [island("/p/api")] } satisfies Archipelago);
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready:/p/api"));
  });

  it("carries a refresh failure alongside the still-displayed (now stale) island list, rather than dropping it", async () => {
    invokeMock.mockResolvedValueOnce({ islands: [island("/p/api")] } satisfies Archipelago);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready:/p/api"));

    invokeMock.mockRejectedValueOnce(new Error("scan failed"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    await waitFor(() => {
      const text = screen.getByTestId("probe").textContent ?? "";
      // The stale list is still on screen (never blanked)...
      expect(text).toContain("ready:/p/api");
      // ...AND the failure is now visible alongside it, not silently dropped.
      expect(text).toContain("stale:Error: scan failed");
    });
  });

  it("still surfaces a plain error (not 'ready') when the FIRST fetch fails — no prior good data to fall back on", async () => {
    invokeMock.mockRejectedValueOnce(new Error("herdr not running"));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("error:Error: herdr not running"));
  });

  // Opus review (ITEM 2): mount fires a fetch, and window focus (or
  // `refetch()`) fires another with no in-flight guard — Tauri runs commands
  // concurrently, so alt-tabbing repeatedly while a 152-repository scan was
  // already running used to queue up overlapping scans. These two pin the
  // fix: a focus that arrives WHILE a scan is in flight must not issue a
  // second `invoke` immediately, but must not be silently lost either — it
  // fires exactly once more after the in-flight scan settles.
  it("does not issue a second invoke for a focus event that arrives while a scan is already in flight", async () => {
    const first = deferred<Archipelago>();
    invokeMock.mockImplementationOnce(() => first.promise);
    render(<Probe />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("probe").textContent).toBe("loading");

    // A focus event arrives while the mount fetch is still unresolved — this
    // must NOT call invoke a second time right away.
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    // Let the in-flight scan settle. The pending focus becomes exactly one
    // trailing refetch — a second (not third, not zero) invoke call.
    invokeMock.mockResolvedValueOnce({ islands: [island("/p/api")] } satisfies Archipelago);
    first.resolve({ islands: [] } satisfies Archipelago);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready:/p/api"));
  });

  it("collapses multiple focus events during one in-flight scan into a single trailing refetch", async () => {
    const first = deferred<Archipelago>();
    invokeMock.mockImplementationOnce(() => first.promise);
    render(<Probe />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    invokeMock.mockResolvedValueOnce({ islands: [island("/p/api")] } satisfies Archipelago);
    first.resolve({ islands: [] } satisfies Archipelago);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready:/p/api"));
    // Exactly one trailing call, not one per queued focus event.
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("clears the stale error once a later refresh succeeds", async () => {
    invokeMock.mockResolvedValueOnce({ islands: [island("/p/api")] } satisfies Archipelago);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready:/p/api"));

    invokeMock.mockRejectedValueOnce(new Error("scan failed"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toContain("stale:"));

    invokeMock.mockResolvedValueOnce({ islands: [island("/p/api"), island("/p/new")] } satisfies Archipelago);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe("ready:/p/api,/p/new"),
    );
  });
});
