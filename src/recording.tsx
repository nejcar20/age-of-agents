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

  useEffect(() => {
    const root = document.documentElement;
    if (!recording) {
      delete root.dataset.recording;
      setShowBadge(false);
      return;
    }
    root.dataset.recording = "1";
    setShowBadge(true);
    const timer = setTimeout(() => setShowBadge(false), REC_BADGE_MS);
    return () => {
      clearTimeout(timer);
      delete root.dataset.recording;
    };
  }, [recording]);

  return (
    <RecordingContext.Provider value={recording}>
      <RecordingToggleContext.Provider value={toggle}>
      {children}
      {showBadge && (
        <div className="recording-badge" role="status">
          ● REC <small>⇧R to stop</small>
        </div>
      )}
      </RecordingToggleContext.Provider>
    </RecordingContext.Provider>
  );
}
