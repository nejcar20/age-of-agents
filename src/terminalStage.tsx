import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { SwitchTarget } from "./agentSwitcher";

/**
 * What a full-screen terminal needs from the sea it is covering, and what
 * the sea needs to know about it — the two halves of the lag-and-switcher
 * round, in one small context because they are the same relationship seen
 * from each end.
 *
 * WHY A CONTEXT AND NOT PROPS. `Terminal` is mounted four levels below the
 * `<Canvas>` it occludes (`Archipelago` -> `IslandPanel` -> `AgentActions`
 * -> `Terminal`), because it is opened from one agent's accordion row. Both
 * facts it needs — "the scene should stop rendering while I am up" and
 * "here is every other agent you could switch to" — belong to the sea, not to
 * that row, and threading two more prop pairs through three components that
 * have no use for them would make every one of them a little less about its
 * own job. The default value below is inert (claiming does nothing, there is
 * nowhere to switch to, switching does nothing), so `Terminal` and `IslandPanel` still
 * render standalone in their own tests exactly as before.
 */
export type TerminalStage = {
  /**
   * Called by a mounted full-screen terminal; the returned function releases
   * the claim. Shaped as an effect body (`useEffect(() => claimScene(), ...)`)
   * so mounting and unmounting are the only two events that can ever change
   * it — there is no way to leave a stale claim behind after a crash or a
   * fast remount, which would silently freeze the sea forever.
   */
  claimScene: () => () => void;
  /** EVERY agent currently running, in switcher order — see
   * `switchTargets`. Includes the pane the asking terminal is attached to;
   * `Terminal` is the only place that knows which one that is, and marks
   * it rather than dropping it. */
  targets: SwitchTarget[];
  /** Re-attach the terminal to this agent's pane. The implementation is the
   * sea's, because "which agent's terminal is open" is the sea's state. */
  switchTo: (target: SwitchTarget) => void;
};

const INERT: TerminalStage = {
  claimScene: () => () => {},
  targets: [],
  switchTo: () => {},
};

const TerminalStageContext = createContext<TerminalStage>(INERT);

export function useTerminalStage(): TerminalStage {
  return useContext(TerminalStageContext);
}

/**
 * The sea's half. Builds the value its terminals read, and reports back
 * whether one is currently covering the scene.
 *
 * A COUNT rather than a boolean, deliberately: React 18 StrictMode mounts,
 * unmounts and remounts every effect in development, and a boolean flag
 * would be left stuck `false` by the first mount's cleanup running after the
 * second mount's claim — freezing the sea forever, in exactly the
 * environment where nobody would think to look for it.
 *
 * Split from the provider below (rather than one component with a render
 * prop) so the caller stays an ordinary component that can still run its own
 * hooks against `sceneClaimed`.
 */
export function useTerminalStageHost(
  targets: SwitchTarget[],
  switchTo: (target: SwitchTarget) => void,
): { stage: TerminalStage; sceneClaimed: boolean } {
  const [claims, setClaims] = useState(0);

  const claimScene = useCallback(() => {
    setClaims((n) => n + 1);
    return () => setClaims((n) => Math.max(0, n - 1));
  }, []);

  const stage = useMemo<TerminalStage>(
    () => ({ claimScene, targets, switchTo }),
    [claimScene, targets, switchTo],
  );

  return { stage, sceneClaimed: claims > 0 };
}

export function TerminalStageProvider({ stage, children }: { stage: TerminalStage; children: ReactNode }) {
  return <TerminalStageContext.Provider value={stage}>{children}</TerminalStageContext.Provider>;
}

/**
 * The lag fix, as one pure decision (lag-and-switcher round, the author: "it
 * feels laggy").
 *
 * MEASURED, not assumed. With the terminal open over the sea, the scene
 * behind it was still drawing **936 draw calls and ~359k triangles every
 * frame** — 112,507 draw calls and 43.1M triangles per second — for 152
 * islands nobody can see, because the terminal is a modal dialog that covers
 * the viewport. That is a direct violation of "it is never slower than
 * switching terminal tabs": a terminal tab does not render a city behind
 * itself.
 *
 * `requested` is the focus-gated answer the app already computed
 * (`App.tsx`'s `windowFocused ? "always" : "demand"`). This can only ever
 * narrow it, never widen it — a blurred window stays `"demand"` whatever the
 * terminal is doing, so the existing blurred-window guarantee (zero
 * animation frames while blurred) is preserved by construction rather than
 * by a second, parallel rule that could drift from it.
 *
 * WHY THE WHOLE TERMINAL AND NOT A COVERAGE TEST. The terminal panel is
 * user-resizable, so "does it cover the canvas" is a real question and the
 * geometric answer is genuinely unstable: at its default size it is
 * `min(1200px, 94vw)` wide, which is 94% of a laptop screen and only 62% of
 * a wide monitor. Any threshold picked over that would pause on one display
 * and not the other for no reason the user could see. The honest rule is not
 * geometric at all, and the app already uses it one level up: pause when the
 * user's attention is elsewhere. `useWindowFocused` pauses a sea that is
 * fully visible, merely because the window is not focused; a modal terminal
 * that has taken the keyboard is the same judgment, one level in.
 *
 * WHAT THIS DOES NOT DO, which is what makes it honest: `"demand"` is not
 * "off". Every real change still paints — r3f invalidates on each React
 * commit, so a `world-updated` push that lights a new beacon draws a frame
 * exactly as it does today while the window is blurred. What stops is
 * continuous animation: the water, the trees, the beacon pulse. Water and
 * vegetation are declared scenery ("nothing decorative is ever allowed to
 * encode information"). The stopped beacon is not — but it stays drawn, at
 * whatever phase it froze on, and the information it carries is not lost
 * while the terminal is up: it moves into the terminal's own header, where
 * it is a legible name you can click instead of a pulsing pole behind a dark
 * scrim. That trade is the whole point of doing both halves of this round at
 * once.
 */
export function sceneFrameloop(
  requested: "always" | "demand",
  sceneClaimed: boolean,
): "always" | "demand" {
  return sceneClaimed ? "demand" : requested;
}
