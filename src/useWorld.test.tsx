// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useWorld } from "./useWorld";
import type { Island, World } from "./world";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

type EventHandler = (event: { payload: World }) => void;

/** Every `listen()` call this test's `useWorld` instance(s) make, in order —
 * lets a test reach back into a SPECIFIC mount's registered handler (mount 1
 * vs. mount 2 under StrictMode) the way `invokeMock.mockImplementationOnce`
 * lets it target a specific `get_world` call. */
let handlers: { handler: EventHandler; unlistenFn: ReturnType<typeof vi.fn> }[] = [];

function installListenMock() {
  handlers = [];
  listenMock.mockImplementation((_event: string, handler: EventHandler) => {
    const unlistenFn = vi.fn();
    handlers.push({ handler, unlistenFn });
    return Promise.resolve(unlistenFn);
  });
}

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  listenMock.mockReset();
});

/** A promise plus its own `resolve`, for tests that need to hold an `invoke`
 * call open across several assertions before releasing it — same helper
 * `useArchipelago.test.tsx` uses, copied rather than imported since these are
 * independent test files. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const island = (name: string, attention: Island["attention"]): Island => ({
  id: `/p/${name}`, name, root: `/p/${name}`, attention, agents: [], last_changed_at: null,
});

const world = (islands: Island[]): World => ({
  islands, herdr_connected: true, herdr_version: "0.8.0", protocol_mismatch: false,
});

/** Renders `useWorld`'s island names as text — the same "Probe" pattern
 * `useArchipelago.test.tsx` and `useWindowFocused.test.tsx` use for
 * hook-level assertions without a real `<TownView>`/`<Canvas>` tree. */
function Probe() {
  const w = useWorld();
  return <div data-testid="probe">{w.islands.map((i) => i.name).join(",")}</div>;
}

describe("useWorld", () => {
  /**
   * The bug: `useWorld`'s `invoke("get_world").then()`/`.catch()` had no
   * epoch guard at all, unlike `useArchipelago` (fixed for exactly this in
   * commit `3d48254`) and `UnsettledList`. React StrictMode mounts, cleans
   * up, and remounts in dev; a `get_world` response from the dead mount 1
   * can resolve after mount 2 has already installed newer state, and with no
   * guard checking which mount it belongs to, it silently overwrote the
   * newer data with older data — exactly the "shows an agent as working when
   * it has stopped" failure the whole product exists to prevent.
   */
  it("does not let mount 1's late get_world response overwrite mount 2's newer state under StrictMode", async () => {
    installListenMock();
    const first = deferred<World>();
    const second = deferred<World>();
    invokeMock.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(listenMock).toHaveBeenCalledTimes(2));

    // The live mount (mount 2) receives a fresh push event before mount 1's
    // stale `get_world` ever settles.
    const liveHandler = handlers[1].handler;
    await act(async () => {
      liveHandler({ payload: world([island("fresh", "stopped")]) });
    });
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("fresh"));

    // Mount 1's now-stale `get_world` finally resolves. It belongs to a dead
    // mount and must not clobber the newer state installed above.
    await act(async () => {
      first.resolve(world([island("stale", "quiet")]));
      await Promise.resolve();
    });
    expect(screen.getByTestId("probe").textContent).toBe("fresh");

    // Let mount 2's own fetch settle too, so nothing is left dangling.
    await act(async () => {
      second.resolve(world([island("fresh", "stopped")]));
    });
    expect(screen.getByTestId("probe").textContent).toBe("fresh");
  });

  /**
   * Mirror image, on the event side: a `world-updated` event delivered to a
   * dead StrictMode mount's listener (simulating the narrow window where the
   * real Tauri `unlisten()` — itself async — has been requested in cleanup
   * but has not actually taken effect yet) must not reach `setWorld` either.
   */
  it("does not let a late world-updated event from a dead StrictMode mount overwrite the live mount's state", async () => {
    installListenMock();
    invokeMock.mockResolvedValue(world([island("a", "quiet")]));

    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    await waitFor(() => expect(listenMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("a"));

    const liveHandler = handlers[1].handler;
    await act(async () => {
      liveHandler({ payload: world([island("fresh", "stopped")]) });
    });
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("fresh"));

    // The dead mount 1's own listener fires anyway.
    const deadHandler = handlers[0].handler;
    act(() => {
      deadHandler({ payload: world([island("stale", "quiet")]) });
    });
    expect(screen.getByTestId("probe").textContent).toBe("fresh");
  });

  it("unsubscribes the world-updated listener on unmount", async () => {
    installListenMock();
    invokeMock.mockResolvedValueOnce(world([island("a", "quiet")]));

    const { unmount } = render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("a"));
    expect(listenMock).toHaveBeenCalledTimes(1);
    const { handler, unlistenFn } = handlers[0];
    expect(unlistenFn).not.toHaveBeenCalled();

    unmount();
    // `unlisten` resolves asynchronously (real Tauri `listen()` returns a
    // promise of the unlisten function) — flush it.
    await act(async () => {
      await Promise.resolve();
    });
    expect(unlistenFn).toHaveBeenCalledTimes(1);

    // A late event still reaching the dead mount's handler (the same
    // async-unlisten race the test above targets) must be inert, not throw,
    // and not resurrect any state.
    expect(() => handler({ payload: world([island("late", "stopped")]) })).not.toThrow();
  });
});
