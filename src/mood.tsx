import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { isInteractiveTarget, isModalOpen } from "./useHotkey";
import type { WaterColors } from "./components/Water";

/**
 * The world's time of day — a look, never information. Day is the scene as
 * it has always been; golden hour and night re-light the same world for a
 * warmer, more cinematic frame. Every value here is a light, a sky or a
 * water tone; nothing about a repository or an agent changes with the mood,
 * with one deliberate exception spelled out on `windows`.
 *
 * `null` means "the scene's own default" (the constants in `TownView.tsx`),
 * so `day` restates nothing and cannot drift from them.
 */
export type Mood = "day" | "golden" | "night";

export const MOODS: Mood[] = ["day", "golden", "night"];

export const MOOD_LABEL: Record<Mood, string> = {
  day: "Day",
  golden: "Golden hour",
  night: "Night",
};

export type MoodLook = {
  /** The key light. `height` scales how high the sun sits (lower = longer
   * shadows, warmer raking light). */
  sun: { color: string; intensity: number; height: number };
  /** The hemisphere fill: sky above, bounced ground below. */
  fill: { sky: string; ground: string; intensity: number };
  sky: { zenith: string; horizon: string } | null;
  water: WaterColors | null;
  /**
   * Lit windows. The one place a mood touches meaning, and only in the
   * direction the rest of the app already speaks: at night a town is lit
   * where agents are live, dark where nobody is — "someone is home" is the
   * same fact the villagers already show.
   */
  windows: { color: string; intensity: number } | null;
  /** How strongly the brightest things (beacons, halos, lit windows) bloom. */
  bloom: number;
};

export const MOOD_LOOK: Record<Mood, MoodLook> = {
  day: {
    sun: { color: "#ffd7a1", intensity: 2.05, height: 1 },
    fill: { sky: "#bcd9f2", ground: "#7d6f4f", intensity: 0.78 },
    sky: null,
    water: null,
    windows: null,
    bloom: 0.45,
  },
  golden: {
    sun: { color: "#ffb068", intensity: 2.4, height: 0.58 },
    fill: { sky: "#b9aacb", ground: "#7a5236", intensity: 0.88 },
    sky: { zenith: "#6479ad", horizon: "#ffc792" },
    water: { deep: "#28506a", mid: "#44838f", shallow: "#86c6b6", sandy: "#ecc996", foam: "#fff1dc", glint: "#ffd89e" },
    windows: { color: "#ffb25c", intensity: 0.35 },
    bloom: 0.6,
  },
  night: {
    sun: { color: "#b9c9ff", intensity: 0.8, height: 1.2 },
    fill: { sky: "#39465e", ground: "#1d1b24", intensity: 0.55 },
    sky: { zenith: "#07112a", horizon: "#27395f" },
    water: { deep: "#061c2b", mid: "#0c3446", shallow: "#1a6470", sandy: "#3d5b5c", foam: "#a7c2cf", glint: "#cfe0ff" },
    windows: { color: "#ffc062", intensity: 2.2 },
    bloom: 0.95,
  },
};

const STORAGE_KEY = "aoa.mood";

function loadMood(): Mood {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return MOODS.includes(saved as Mood) ? (saved as Mood) : "day";
  } catch {
    return "day";
  }
}

type MoodState = { mood: Mood; look: MoodLook; setMood: (mood: Mood) => void };

const MoodContext = createContext<MoodState>({ mood: "day", look: MOOD_LOOK.day, setMood: () => {} });

export function useMood(): MoodState {
  return useContext(MoodContext);
}

export function nextMood(mood: Mood): Mood {
  return MOODS[(MOODS.indexOf(mood) + 1) % MOODS.length];
}

/** ⇧M, and nothing else — never while typing or inside a terminal. */
export function isMoodToggle(event: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey" | "repeat" | "target">): boolean {
  if (event.key !== "M" || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return false;
  if (isInteractiveTarget(event.target)) return false;
  const el = event.target as { closest?: (selector: string) => unknown } | null;
  return !(el && typeof el.closest === "function" && el.closest('[role="application"], .terminal'));
}

export function MoodProvider({ children, initial }: { children: ReactNode; initial?: Mood }) {
  const [mood, setMoodState] = useState<Mood>(() => initial ?? loadMood());
  const setMood = (next: Mood) => {
    setMoodState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Session-only preference. */ }
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isMoodToggle(event) || isModalOpen()) return;
      event.preventDefault();
      setMoodState((current) => {
        const next = nextMood(current);
        try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Session-only preference. */ }
        return next;
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return <MoodContext.Provider value={{ mood, look: MOOD_LOOK[mood], setMood }}>{children}</MoodContext.Provider>;
}
