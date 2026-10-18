import { useEffect, useMemo, type DependencyList } from "react";

/** Anything with a three.js-style `dispose()` — a `BufferGeometry`, a
 * `Material`, a `Texture`. */
export interface Disposable {
  dispose(): void;
}

/**
 * Resource-hygiene round: `useMemo`, plus automatic `dispose()` of whatever
 * it PREVIOUSLY produced — every time `factory` produces a new value, and
 * once more on unmount.
 *
 * three.js GPU resources are not garbage-collected the way a plain JS object
 * is: dropping the last JS reference to a `BufferGeometry`/`Material`/
 * `Texture` leaks its GPU buffers forever unless `.dispose()` is called
 * explicitly. Every `build*Geometry` helper in this codebase
 * (`terrainGeometry.ts`, `Water.tsx`'s own quads and shader materials,
 * `TownView.tsx`'s `Atmosphere` sky sphere) constructs one of these directly
 * (`new THREE.BufferGeometry`/`PlaneGeometry`/`SphereGeometry`) inside a
 * `useMemo` — WE own the object it returns, the same way any other `useMemo`
 * result we construct ourselves (not react-three-fiber, from JSX) is ours to
 * clean up. Something written directly in JSX instead — e.g.
 * `<boxGeometry args={[1, 1, 1]} />` on an `instancedMesh` — is a DIFFERENT
 * case: react-three-fiber itself constructs that geometry from the JSX
 * element and disposes it automatically when the element unmounts or its
 * `args` change, so it must NOT be run through this hook (double-disposing
 * an object still attached to a live mesh is the "black or missing object"
 * failure mode, worse than the leak this exists to fix). See the resource-
 * hygiene report for the full audit of which call site is which.
 *
 * `factory` returning `null` (e.g. an island with no known city yet) is a
 * valid, disposal-free case.
 */
export function useDisposableMemo<T extends Disposable | null>(factory: () => T, deps: DependencyList): T {
  // The factory itself is the thing being memoised — its own closure already
  // captures everything it reads, so `deps` (supplied by each call site,
  // exactly like a normal `useMemo`) is the single source of truth for when
  // to rebuild. Deliberately no exhaustive-deps lint here for the same
  // reason `useMemo` callers already suppress it throughout this codebase.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const value = useMemo(factory, deps);
  useEffect(() => {
    // Disposes exactly the value THIS effect instance closed over. When
    // `value` changes identity, React tears down the previous effect
    // (running this cleanup against the OLD value) before setting up the
    // new one — and runs it one final time on unmount. Never touches
    // anything but `value` itself, so it can never dispose a DIFFERENT
    // (still-live) object than the one this exact render produced.
    return () => {
      value?.dispose();
    };
  }, [value]);
  return value;
}
