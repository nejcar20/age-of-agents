import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { vegetationFadeOpacity } from "../archipelago";
import { scatterVegetation, type VegetationExclusion } from "../vegetation";

/**
 * Art-direction round, item 5: "no landscape detail... decorative
 * vegetation is scenery (same category as grass/water) — trees/rocks ARE
 * allowed since a tree is unmistakably not a building. But it must not
 * encode anything — keep density uniform per unit of unbuilt land."
 *
 * Rendering only — the actual placement RULE (which points get anything,
 * and why) lives in `../vegetation.ts`, unit-tested there without any
 * WebGL/DOM dependency. This component just turns that list of points into
 * three cheap `instancedMesh`es (tree trunks, tree foliage, rocks) — three
 * draw calls total for however many islands/districts share one call site,
 * the same one-draw-call-per-part batching every other piece of massing in
 * this codebase already uses (`BuildingInstances`, `MiniTown`).
 *
 * `heightAt`/`landMaskAt` are deliberately callback functions rather than a
 * baked height array: `TownView`'s ground (`safeDomeHeight`, no seed) and
 * `Archipelago`'s sea islands (`terrainHeight`/`islandMask`, seeded, can
 * recede) are genuinely different functions — see `terrain.ts`'s own module
 * doc comment for why that split is deliberate — and this component has no
 * business knowing which one a given caller uses.
 */
const TRUNK_COLOR = "#6b4a34";
const FOLIAGE_COLOR = "#4c7a4a";
const ROCK_COLOR = "#928d81";

export function Vegetation({
  identity,
  width,
  depth,
  heightAt,
  landMaskAt,
  exclusions,
  opacity = 1,
  zoomRatioRef,
}: {
  /** Real identity string (a repo/island root) — see `../vegetation.ts`'s
   * own doc comment: read ONLY for "which one," never for its length or any
   * other stand-in for "how much code is here." */
  identity: string;
  width: number;
  depth: number;
  /** World-Y at normalized `(u, v)` — `terrainHeight`/`safeDomeHeight`
   * wrapped by the caller with whatever seed/constants apply there. */
  heightAt: (u: number, v: number) => number;
  /** Defaults to "everywhere is safe land" (`TownView`'s own ground has no
   * submerging coastline to avoid) — `Archipelago` passes its real
   * `islandMask` so vegetation never grows on the beach or in the water. */
  landMaskAt?: (u: number, v: number) => number;
  /** Real occupied ground (buildings, pads, roads) to keep clear of —
   * circles in the SAME local coordinate space as `width`/`depth`. */
  exclusions?: VegetationExclusion[];
  /** Search-and-filter round's dim convention, passed through rather than
   * re-invented — 1 normally, the caller's own `DIM_OPACITY` when this
   * island/town is filtered out. */
  opacity?: number;
  /** Water-fix round, item 2: `Archipelago`'s shared, per-frame-updated zoom
   * ratio (see `ZoomTracker`) — read here to fade vegetation out at the
   * sea's default wide view, the same "recede at distance so the buildings
   * read as a town" treatment `MiniTown`'s pads get, via
   * `vegetationFadeOpacity`. `undefined` (bare `TownView` calls this with no
   * zoom-fade concept of its own — a single real town's own camera never
   * had the "distant cluster of 150 islands" problem this exists for) means
   * always fully opaque, i.e. today's unchanged behaviour. */
  zoomRatioRef?: RefObject<number>;
}) {
  const instances = useMemo(
    () => scatterVegetation(identity, width, depth, landMaskAt ?? (() => 1), exclusions ?? []),
    // `heightAt`/`landMaskAt` are pure functions of their own already-listed
    // inputs (a seed/constant closure, never per-render state) — recomputing
    // the placement list only needs to key on the geometry itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identity, width, depth, exclusions],
  );
  const trees = useMemo(() => instances.filter((v) => v.kind === "tree"), [instances]);
  const rocks = useMemo(() => instances.filter((v) => v.kind === "rock"), [instances]);

  const trunkRef = useRef<THREE.InstancedMesh>(null);
  const foliageRef = useRef<THREE.InstancedMesh>(null);
  const rockRef = useRef<THREE.InstancedMesh>(null);
  const trunkMaterialRef = useRef<THREE.MeshStandardMaterial>(null);
  const foliageMaterialRef = useRef<THREE.MeshStandardMaterial>(null);
  const rockMaterialRef = useRef<THREE.MeshStandardMaterial>(null);

  // Item 2: fades ALL of vegetation's own opacity (trunk/foliage/rock alike
  // — unlike `MiniTown`'s pad-only fade, there is no "stay saturated" part
  // of a tree) toward `VEG_MIN_OPACITY` at the sea's default wide view,
  // combined multiplicatively with the pre-existing search-filter `dim`.
  useFrame(() => {
    const fade = zoomRatioRef ? vegetationFadeOpacity(zoomRatioRef.current) : 1;
    const finalOpacity = fade * opacity;
    if (trunkMaterialRef.current) trunkMaterialRef.current.opacity = finalOpacity;
    if (foliageMaterialRef.current) foliageMaterialRef.current.opacity = finalOpacity;
    if (rockMaterialRef.current) rockMaterialRef.current.opacity = finalOpacity;
  });

  useLayoutEffect(() => {
    const trunk = trunkRef.current;
    const foliage = foliageRef.current;
    if (!trunk || !foliage) return;
    const dummy = new THREE.Object3D();
    trees.forEach((t, i) => {
      const groundY = heightAt(t.u, t.v);
      const trunkHeight = 0.5 * t.scale;
      dummy.position.set(t.x, groundY + trunkHeight / 2, t.z);
      dummy.rotation.set(0, t.rotationY, 0);
      dummy.scale.set(0.11 * t.scale, trunkHeight, 0.11 * t.scale);
      dummy.updateMatrix();
      trunk.setMatrixAt(i, dummy.matrix);

      const foliageHeight = 0.95 * t.scale;
      dummy.position.set(t.x, groundY + trunkHeight + foliageHeight / 2 - 0.04, t.z);
      dummy.rotation.set(0, t.rotationY, 0);
      dummy.scale.set(0.58 * t.scale, foliageHeight, 0.58 * t.scale);
      dummy.updateMatrix();
      foliage.setMatrixAt(i, dummy.matrix);
    });
    trunk.instanceMatrix.needsUpdate = true;
    foliage.instanceMatrix.needsUpdate = true;
    trunk.computeBoundingSphere();
    foliage.computeBoundingSphere();
    // `heightAt` intentionally excluded — see the `useMemo` above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trees]);

  useLayoutEffect(() => {
    const rock = rockRef.current;
    if (!rock) return;
    const dummy = new THREE.Object3D();
    rocks.forEach((r, i) => {
      const groundY = heightAt(r.u, r.v);
      const rockSize = 0.32 * r.scale;
      dummy.position.set(r.x, groundY + rockSize * 0.3, r.z);
      dummy.rotation.set(0, r.rotationY, 0);
      dummy.scale.set(rockSize, rockSize * 0.62, rockSize);
      dummy.updateMatrix();
      rock.setMatrixAt(i, dummy.matrix);
    });
    rock.instanceMatrix.needsUpdate = true;
    rock.computeBoundingSphere();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rocks]);

  if (trees.length === 0 && rocks.length === 0) return null;

  return (
    <group>
      {trees.length > 0 && (
        <>
          {/* No `opacity` prop on any of these three materials — see
              `MiniTown`'s matching comment: it is driven entirely by the
              `useFrame` above via the `*MaterialRef`s, and a static JSX
              `opacity` would fight it on every unrelated re-render. */}
          <instancedMesh ref={trunkRef} args={[undefined, undefined, trees.length]} castShadow receiveShadow>
            <cylinderGeometry args={[1, 1, 1, 6]} />
            <meshStandardMaterial ref={trunkMaterialRef} color={TRUNK_COLOR} roughness={0.95} transparent />
          </instancedMesh>
          {/* Flat-shaded, same reasoning as every other cone in this
              codebase (`BuildingInstances`/`MiniTown` roofs): a low-segment
              cone's default smooth normals read as a hollow cup, not solid
              foliage. */}
          <instancedMesh ref={foliageRef} args={[undefined, undefined, trees.length]} castShadow receiveShadow>
            <coneGeometry args={[1, 1, 6]} />
            <meshStandardMaterial
              ref={foliageMaterialRef}
              color={FOLIAGE_COLOR}
              roughness={0.85}
              flatShading
              transparent
            />
          </instancedMesh>
        </>
      )}
      {rocks.length > 0 && (
        <instancedMesh ref={rockRef} args={[undefined, undefined, rocks.length]} castShadow receiveShadow>
          <dodecahedronGeometry args={[1, 0]} />
          <meshStandardMaterial ref={rockMaterialRef} color={ROCK_COLOR} roughness={1} flatShading transparent />
        </instancedMesh>
      )}
    </group>
  );
}
