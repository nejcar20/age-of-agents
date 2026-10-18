// @vitest-environment jsdom
import { StrictMode, useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  sceneFrameloop,
  TerminalStageProvider,
  useTerminalStage,
  useTerminalStageHost,
} from "./terminalStage";

afterEach(cleanup);

describe("sceneFrameloop", () => {
  it("pauses a focused sea while a full-screen terminal covers it — the lag fix", () => {
    expect(sceneFrameloop("always", true)).toBe("demand");
  });

  it("leaves a focused sea with nothing over it exactly as it was", () => {
    expect(sceneFrameloop("always", false)).toBe("always");
  });

  it("can only ever narrow, never widen — a blurred window stays paused either way", () => {
    // The load-bearing half: the blurred-window guarantee (zero animation
    // frames while blurred) must survive this change by construction, not
    // by a second rule that could drift from `useWindowFocused`'s.
    expect(sceneFrameloop("demand", false)).toBe("demand");
    expect(sceneFrameloop("demand", true)).toBe("demand");
  });
});

/** A stand-in for `Terminal`: claims the scene for as long as it is mounted. */
function Claimant() {
  const { claimScene } = useTerminalStage();
  useEffect(() => claimScene(), [claimScene]);
  return null;
}

function Host({ open, onState }: { open: boolean; onState: (claimed: boolean) => void }) {
  const { stage, sceneClaimed } = useTerminalStageHost([], () => {});
  onState(sceneClaimed);
  return <TerminalStageProvider stage={stage}>{open && <Claimant />}</TerminalStageProvider>;
}

describe("useTerminalStageHost", () => {
  it("reports no claim until something actually mounts", () => {
    const states: boolean[] = [];
    render(<Host open={false} onState={(c) => states.push(c)} />);
    expect(states[states.length - 1]).toBe(false);
  });

  it("reports a claim while a terminal is mounted, and releases it when it unmounts", () => {
    const states: boolean[] = [];
    const view = render(<Host open onState={(c) => states.push(c)} />);
    expect(states[states.length - 1]).toBe(true);
    act(() => {
      view.rerender(<Host open={false} onState={(c) => states.push(c)} />);
    });
    expect(states[states.length - 1]).toBe(false);
  });

  it("survives StrictMode's mount/unmount/remount — the sea does not stay frozen", () => {
    // This is exactly why the claim is a COUNT and not a boolean: in
    // development React mounts every effect, tears it down, and mounts it
    // again. A flag would end up cleared by the first mount's cleanup after
    // the second mount had already set it, leaving the sea paused forever
    // in the one environment nobody would think to check.
    const states: boolean[] = [];
    render(
      <StrictMode>
        <Host open onState={(c) => states.push(c)} />
      </StrictMode>,
    );
    expect(states[states.length - 1]).toBe(true);
  });
});

describe("the inert default", () => {
  it("lets a Terminal render with no provider at all — claiming does nothing, there is nowhere to switch", () => {
    // `Terminal` and `IslandPanel` are both rendered standalone in their own
    // tests, and in `townshot.tsx`'s component-only harness modes. None of
    // them should have to know this context exists.
    const seen = { targets: -1 };
    function Bare() {
      const stage = useTerminalStage();
      useEffect(() => stage.claimScene(), [stage]);
      seen.targets = stage.targets.length;
      return null;
    }
    expect(() => render(<Bare />)).not.toThrow();
    expect(seen.targets).toBe(0);
  });
});
