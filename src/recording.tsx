import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { isInteractiveTarget, isModalOpen } from "./useHotkey";

/**
 * Recording mode (⇧R): the world with nothing but the world in it, for a
 * screen recording. The scene stage covers the window, every text label that
 * could carry a private name (island names, task titles, file paths) is
 * dropped, and the camera slowly orbits on its own. Numbers stay — a "+42"
 * says nothing about whose code it is.
 *
 * A plain context rather than props: the stage, the camera rig, the island
 * labels and the villager badges all need it, several of them inside the
 * r3f `Canvas`, which bridges React context into the scene.
 */
const RecordingContext = createContext(false);

export function useRecording(): boolean {
  return useContext(RecordingContext);
}

/** Switches recording mode on or off — the same thing ⇧R does, for a button. */
const RecordingToggleContext = createContext<() => void>(() => {});

export function useRecordingToggle(): () => void {
  return useContext(RecordingToggleContext);
}

/** How long the "● REC" confirmation stays up after switching on. */
const REC_BADGE_MS = 2000;

/**
 * Whether a key press should toggle recording: ⇧R and nothing else, never
 * while typing (a form field, or a focused terminal — whose keys belong to
 * the agent) and never under a modal.
 */
export function isRecordingToggle(event: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey" | "repeat" | "target">): boolean {
  if (event.key !== "R" || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return false;
  if (isInteractiveTarget(event.target)) return false;
  const el = event.target as { closest?: (selector: string) => unknown } | null;
  if (el && typeof el.closest === "function" && el.closest('[role="application"], .terminal')) return false;
  return true;
}

export function RecordingProvider({ children, initial = false }: { children: ReactNode; initial?: boolean }) {
  const [recording, setRecording] = useState(initial);
  const [showBadge, setShowBadge] = useState(false);
  const toggle = useCallback(() => setRecording((value) => !value), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isRecordingToggle(event) || isModalOpen()) return;
      event.preventDefault();
      setRecording((value) => !value);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Esc leaves too: every panel is hidden in this mode, and Esc is the key
  // people reach for when they are stuck in something full-screen. Captured
  // first, so the same press does not also close or leave whatever is
  // underneath.
  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isModalOpen() || isInteractiveTarget(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setRecording(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording]);

  // The way out shows on entering and whenever the pointer moves, then
  // fades: a still shot stays clean, and nobody is left without an exit.
  useEffect(() => {
    const root = document.documentElement;
    if (!recording) {
      delete root.dataset.recording;
      setShowBadge(false);
      return;
    }
    root.dataset.recording = "1";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = () => {
      setShowBadge(true);
      clearTimeout(timer);
      timer = setTimeout(() => setShowBadge(false), REC_BADGE_MS);
    };
    show();
    window.addEventListener("pointermove", show);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", show);
      delete root.dataset.recording;
    };
  }, [recording]);

  return (
    <RecordingContext.Provider value={recording}>
      <RecordingToggleContext.Provider value={toggle}>
      {children}
      {recording && (
        <button
          type="button"
          className={`recording-badge${showBadge ? " recording-badge--shown" : ""}`}
          onClick={() => setRecording(false)}
          aria-label="Exit cinematic mode"
        >
          ● Cinematic <small>Exit · Esc</small>
        </button>
      )}
      </RecordingToggleContext.Provider>
    </RecordingContext.Provider>
  );
}
