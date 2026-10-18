import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EMPTY_WORLD, foldWorldUpdate, INITIAL_FOLD_STATE, type World } from "./world";

export function useWorld(): World {
  const [world, setWorld] = useState<World>(EMPTY_WORLD);
  // Guards against a response that belongs to a DEAD mount (React
  // StrictMode's dev mount -> cleanup -> remount) reaching `setWorld` after
  // the live mount has already installed newer state — the same pattern
  // `useArchipelago`'s `epochRef` and `UnsettledList`'s `epochRef` use.
  // Bumped once when an effect instance starts and again in its cleanup, so
  // a stale instance's late `get_world` resolution or late `world-updated`
  // event can never match the current epoch again.
  const epochRef = useRef(0);

  useEffect(() => {
    const epoch = ++epochRef.current;
    // Scoped to this effect run (fresh on every mount, including React
    // StrictMode's dev double-mount) so one instance's fold state can never
    // leak into another's: `get_world` and `world-updated` race, and if an
    // event lands before the initial fetch settles, that fetch is stale
    // relative to THIS mount's own fold and must not clobber the newer,
    // event-driven state (see `foldWorldUpdate`). The `epoch` check in each
    // callback below is the separate guard that stops a response belonging
    // to a dead mount from ever reaching `setWorld` in the first place.
    let state = INITIAL_FOLD_STATE;

    invoke<World>("get_world")
      .then((w) => {
        if (epoch !== epochRef.current) return;
        state = foldWorldUpdate(state, { kind: "initial", world: w });
        setWorld(state.world);
      })
      .catch(() => {
        if (epoch !== epochRef.current) return;
        state = foldWorldUpdate(state, { kind: "initial", world: EMPTY_WORLD });
        setWorld(state.world);
      });

    const unlisten = listen<World>("world-updated", (event) => {
      if (epoch !== epochRef.current) return;
      state = foldWorldUpdate(state, { kind: "event", world: event.payload });
      setWorld(state.world);
    });

    return () => {
      epochRef.current += 1;
      unlisten.then((f) => f());
    };
  }, []);

  return world;
}
