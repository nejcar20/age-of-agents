import { useCallback, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { hashString } from "../city";
import { raidColor, type RaiderGroup } from "../raids";
import { useDisposableMemo } from "./useDisposableMemo";

/**
 * Raids in town: for each manifest a scan found vulnerable dependencies in,
 * a small band of hostile figures with torches standing at that manifest's
 * building (`package.json`, `Cargo.toml`, ...). The sea's pirate ships say
 * "this island is under attack"; these say WHERE in the town the attack is
 * aimed. A manifest that isn't a building here (filtered out, or a lockfile
 * whose manifest lives elsewhere) still gets its band — on the coast, so
 * nothing found is hidden just because it has no house to stand at.
 *
 * Each figure is tinted by its group's WORST severity (`raidColor` — the
 * same colour that severity's sail has at sea), one figure per finding up to
 * `MAX_RAIDERS`. Figures are sized off the grid pitch the way villagers are,
 * and smaller than them, so a band never reads as architecture or as an
 * agent.
 *
 * The torch flicker is a plain `useFrame` that never calls `invalidate()`:
 * like the villagers' bob, it only animates while the town's render loop is
 * already awake (`frameloop="always"` while the window is focused), and
 * freezes on its last frame under `"demand"`. A flicker is never a reason
 * to spend a frame.
 */

/** Ceiling on figures per group: a band, not a crowd. */
export const MAX_RAIDERS = 5;

/** Where a band stands: on the ground at `x`/`z` (height `y`, default 0),
 * turned so the band faces `facing` (radians about +y; 0 faces +z). */
export type RaiderStand = { x: number; z: number; y?: number; facing?: number };

/** A figure's parts are modelled at 0.3 of a pitch tall; drawn this much
 * larger (~0.42, torch tip ~0.6) — under a villager's ~0.56, so a raider
 * never reads as an agent, but big enough to find beside a house. */
const RAIDER_SCALE = 1.4;
/** Gap between neighbouring figures, and how far the band's ends bow in
 * toward what it faces, in model units (times `RAIDER_SCALE` pitches).
 * Five figures span 0.62 of a pitch, body edges ±0.41: a band stays inside
 * the one street cell it stands on, so it never clips into a building. */
const SPACING = 0.11;
const BOW = 0.03;
/** Separate coast bands stand this many pitches apart. */
const COAST_STEP = 1;

const TORCH_STICK = "#5a4030";
const TORCH_FLAME = "#ffb347";
const TORCH_GLOW = "#ff7a1a";

/** One figure's parts, in grid-pitch units: a capsule body, a torch stick,
 * and the flame at its tip. */
function buildRaiderParts() {
  const body = new THREE.CapsuleGeometry(0.07, 0.15, 3, 8);
  const stick = new THREE.CylinderGeometry(0.012, 0.012, 0.2, 5);
  const flame = new THREE.IcosahedronGeometry(0.035, 0);
  return {
    body,
    stick,
    flame,
    dispose() {
      body.dispose();
      stick.dispose();
      flame.dispose();
    },
  };
}

type Parts = ReturnType<typeof buildRaiderParts>;

/** Local offset of figure `i` of `n`: a short line across the band's
 * facing direction, its ends bowed toward what it faces. */
function figureOffset(i: number, n: number): [number, number, number] {
  const t = i - (n - 1) / 2;
  return [t * SPACING, 0, t * t * BOW];
}

function Raider({ parts, color, flame, position }: { parts: Parts; color: string; flame: (m: THREE.MeshStandardMaterial | null) => void; position: [number, number, number] }) {
  return (
    <group name="raider" position={position}>
      {/* Capsule: 0.15 + 2 * 0.07 tall, centred, so lift it by half. */}
      <mesh geometry={parts.body} position={[0, 0.145, 0]} castShadow>
        <meshStandardMaterial color={color} roughness={0.8} flatShading />
      </mesh>
      {/* The torch, held out at the figure's right and leaning forward. */}
      <group position={[0.085, 0.16, 0.02]} rotation={[0.35, 0, -0.2]}>
        <mesh geometry={parts.stick} position={[0, 0.1, 0]}>
          <meshStandardMaterial color={TORCH_STICK} roughness={0.9} />
        </mesh>
        <mesh geometry={parts.flame} position={[0, 0.215, 0]}>
          <meshStandardMaterial ref={flame} color={TORCH_FLAME} emissive={TORCH_GLOW} emissiveIntensity={1.4} roughness={0.6} />
        </mesh>
      </group>
    </group>
  );
}

export function Raiders({
  groups,
  positions,
  coast,
  stale,
  onClick,
  onHoverChange,
  gridPitch = 1,
}: {
  groups: RaiderGroup[];
  /** Each anchored group's stand, keyed by `RaiderGroup.anchorPath`. */
  positions: Map<string, RaiderStand>;
  /** Where every unanchored group (no building for its manifest) stands. */
  coast: RaiderStand;
  stale: boolean;
  onClick: () => void;
  /** The town draws its own cursor (`TownView`'s stage), so hover is
   * reported up rather than set here. */
  onHoverChange?: (hovered: boolean) => void;
  gridPitch?: number;
}) {
  const parts = useDisposableMemo(buildRaiderParts, []);
  // Every torch's flame material, so the flicker can reach them without a
  // re-render.
  const flames = useRef(new Map<string, THREE.MeshStandardMaterial>());

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    flames.current.forEach((material, key) => {
      const phase = (hashString(key) % 628) / 100;
      material.emissiveIntensity = 1.4 + 0.45 * Math.sin(t * 11 + phase) * Math.sin(t * 6.3 + phase * 2);
    });
  });

  const handleClick = useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation();
      onClick();
    },
    [onClick],
  );
  const handleOver = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      event.stopPropagation();
      onHoverChange?.(true);
    },
    [onHoverChange],
  );
  const handleOut = useCallback(() => onHoverChange?.(false), [onHoverChange]);

  if (!parts || groups.length === 0) return null;

  let coastIndex = 0;
  return (
    <group>
      {groups.map((group) => {
        let stand = group.anchorPath === null ? undefined : positions.get(group.anchorPath);
        if (!stand) {
          // Coast bands line up side by side across the way they face,
          // instead of all standing in one spot.
          const k = coastIndex++;
          const facing = coast.facing ?? 0;
          stand = { ...coast, x: coast.x + Math.cos(facing) * k * COAST_STEP * gridPitch, z: coast.z - Math.sin(facing) * k * COAST_STEP * gridPitch };
        }
        const n = Math.min(group.findings.length, MAX_RAIDERS);
        const color = raidColor(group.worst, stale);
        const key = group.manifest;
        // Every torch flickers on its own phase, keyed by band and place
        // in it, so the same torch always flickers the same way.
        const flame = (i: number) => (m: THREE.MeshStandardMaterial | null) => {
          if (m) flames.current.set(`${key}#${i}`, m);
          else flames.current.delete(`${key}#${i}`);
        };
        return (
          <group
            key={key}
            name={`raiders:${group.manifest}`}
            position={[stand.x, stand.y ?? 0, stand.z]}
            onClick={handleClick}
            onPointerOver={handleOver}
            onPointerOut={handleOut}
          >
            <group rotation={[0, stand.facing ?? 0, 0]} scale={gridPitch * RAIDER_SCALE}>
              {Array.from({ length: n }, (_, i) => (
                <Raider key={i} parts={parts} color={color} flame={flame(i)} position={figureOffset(i, n)} />
              ))}
            </group>
          </group>
        );
      })}
    </group>
  );
}
