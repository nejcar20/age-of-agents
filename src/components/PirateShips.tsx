import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Html, useCursor } from "@react-three/drei";
import * as THREE from "three";
import { hashString } from "../city";
import {
  hasSmoke,
  raidColor,
  shipsFor,
  showsCleanFlag,
  sunkFindings,
  type Finding,
  type RaidReport,
  type Severity,
} from "../raids";
import { boatPose, type BoatRoute } from "./Boats";
import { useDisposableMemo } from "./useDisposableMemo";

/**
 * Raids at sea: one pirate ship per known vulnerability, circling the
 * island it threatens. Unlike `Boats.tsx`'s scenery, every ship here MEANS
 * something — its sail is the finding's severity, its count the number of
 * findings (capped at `MAX_SHIPS`, the rest an "+N" badge) — so ships are
 * built to read as different from scenery at a glance: dark hulls, coloured
 * sails, and a wider lane than any scenery boat ever uses.
 *
 * Deliberately quieter than the attention cues (the stopped beacon/halo):
 * no glow, no emissive, smoke kept thin and grey. "An agent needs you" is
 * still the loudest thing on the sea.
 *
 * Like every other sea effect, `useFrame` here never calls `invalidate()` —
 * ships move only while the render loop is already awake (see
 * `Archipelago.test.tsx` for why forcing it is a bug).
 */

const HULL = "#2b2420";
const MAST = "#3a2e26";
const SINK_MS = 2500;
/** Scenery boats loop at `land * 0.8` (`Archipelago`'s `seaBoatRoutes`);
 * 1.15x that keeps a pirate in its own lane, never sharing one. */
const SHIP_RADIUS = 0.8 * 1.15;
const BASE_SPEED = 0.07;

type ShipClass = { scale: number; speed: number; masts: 1 | 2; lane: number };

/** low: rowboat, moderate/unknown: sloop, high: brigantine, critical: a
 * larger, slower warship. Criticals ride a hair further out so the faster
 * classes overtake them instead of sailing through them. */
const SHIP_CLASS: Record<Severity, ShipClass> = {
  low: { scale: 0.72, speed: 1, masts: 1, lane: 1 },
  unknown: { scale: 1, speed: 1, masts: 1, lane: 1 },
  moderate: { scale: 1, speed: 1, masts: 1, lane: 1 },
  high: { scale: 1.1, speed: 1, masts: 2, lane: 1 },
  critical: { scale: 1.3, speed: 0.6, masts: 2, lane: 1.07 },
};

/** One ship's loop: evenly spaced around the island by its rank, with a
 * per-island phase and direction so neighbouring islands don't move in
 * lockstep. A pure function of (island, rank, count), so a ship that sinks
 * after a re-scout goes down exactly where it was sailing. */
function shipRoute(
  root: string,
  cx: number,
  cz: number,
  landW: number,
  landD: number,
  severity: Severity,
  index: number,
  count: number,
): { route: BoatRoute; cls: ShipClass } {
  const h = hashString(`${root}#raid`);
  const cls = SHIP_CLASS[severity];
  const direction = (h >>> 3) & 1 ? 1 : -1;
  return {
    cls,
    route: {
      cx,
      cz,
      rx: landW * SHIP_RADIUS * cls.lane,
      rz: landD * SHIP_RADIUS * cls.lane,
      speed: direction * BASE_SPEED * cls.speed,
      phase: ((h >>> 7) % 628) / 100 + (index / Math.max(count, 1)) * Math.PI * 2,
      size: Math.max(2.6, Math.min(landW, landD) * 0.14) * cls.scale,
    },
  };
}

/** Hull, mast and sail in a unit (length 1) frame pointing along +z — the
 * same proportions as a scenery boat, with a squarer sail so a pirate's
 * silhouette differs even before its colour does. */
function buildShipParts(): { hull: THREE.BufferGeometry; mast: THREE.BufferGeometry; sail: THREE.BufferGeometry; dispose(): void } {
  const hull = new THREE.BoxGeometry(0.38, 0.16, 1);
  const pos = hull.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getZ(i) > 0.4) pos.setX(i, pos.getX(i) * 0.3);
  }
  hull.computeVertexNormals();
  const mast = new THREE.BoxGeometry(0.04, 0.95, 0.04);
  // A square-rigged sail: a quad slightly narrower at the top.
  const sail = new THREE.BufferGeometry();
  sail.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [-0.2, 0.25, 0, 0.2, 0.25, 0, 0.16, 0.85, 0, -0.2, 0.25, 0, 0.16, 0.85, 0, -0.16, 0.85, 0],
      3,
    ),
  );
  sail.computeVertexNormals();
  return {
    hull,
    mast,
    sail,
    dispose() {
      hull.dispose();
      mast.dispose();
      sail.dispose();
    },
  };
}

type Parts = ReturnType<typeof buildShipParts>;

function ShipModel({ parts, cls, sail, opacity }: { parts: Parts; cls: ShipClass; sail: string; opacity: number }) {
  const fade = { transparent: opacity < 1, opacity };
  const masts = cls.masts === 2 ? [-0.2, 0.18] : [0];
  return (
    <>
      <mesh geometry={parts.hull} position={[0, 0.05, 0]} castShadow>
        <meshStandardMaterial color={HULL} roughness={0.85} flatShading {...fade} />
      </mesh>
      {masts.map((z) => (
        <group key={z} position={[0, 0, z]}>
          <mesh geometry={parts.mast} position={[0, 0.55, 0]}>
            <meshStandardMaterial color={MAST} roughness={0.9} {...fade} />
          </mesh>
          <mesh geometry={parts.sail} position={[0, 0.05, 0.03]} castShadow>
            <meshStandardMaterial color={sail} roughness={0.9} side={THREE.DoubleSide} {...fade} />
          </mesh>
        </group>
      ))}
    </>
  );
}

type Sinking = { key: string; finding: Finding; route: BoatRoute; cls: ShipClass; start: number };

const findingKey = (f: Finding) => `${f.id}\u0000${f.package}\u0000${f.lockfile}`;

export function PirateShips({
  cx,
  cz,
  landW,
  landD,
  root,
  report,
  previous,
  waterY,
  onClick,
  opacity = 1,
}: {
  /** The island's centre and land size, in world units (`islandCenter`/
   * `landRect`). Ships are drawn in world space, outside the island's own
   * group, so they never touch its transform. */
  cx: number;
  cz: number;
  landW: number;
  landD: number;
  root: string;
  report: RaidReport | undefined;
  /** The report `report` replaced (from `useRaids().previous`) — the ships
   * it had that this one doesn't sink instead of vanishing. */
  previous: RaidReport | undefined;
  waterY: number;
  onClick: (root: string) => void;
  /** The island's own filter-dim opacity (`Archipelago`'s `DIM_OPACITY`
   * when an active filter is hiding it, else 1): its raid recedes with it. */
  opacity?: number;
}) {
  const parts = useDisposableMemo(buildShipParts, []);
  const puff = useDisposableMemo(() => new THREE.IcosahedronGeometry(1, 0), []);
  const stale = report?.stale ?? false;
  const { ships, overflow } = useMemo(() => shipsFor(report), [report]);
  const routes = useMemo(
    () => ships.map((f, i) => ({ finding: f, ...shipRoute(root, cx, cz, landW, landD, f.severity, i, ships.length) })),
    [ships, root, cx, cz, landW, landD],
  );
  // Starting poses, memoised so a re-render never snaps a moving ship back
  // to t=0 (r3f only re-applies a prop whose value actually changed).
  const initial = useMemo(
    () => routes.map(({ route }) => { const p = boatPose(route, 0); return { position: [p.x, waterY, p.z] as [number, number, number], rotation: [0, p.heading, 0] as [number, number, number] }; }),
    [routes, waterY],
  );

  // Sinking: only a report this component has already been showing can be
  // replaced — the first report it ever sees (a mount, or an island's first
  // scout) has nothing on screen to sink.
  const [sinking, setSinking] = useState<Sinking[]>([]);
  const shownRef = useRef<RaidReport | undefined>(report);
  const sinkTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = sinkTimersRef.current;
    return () => timers.forEach(clearTimeout);
  }, []);
  useEffect(() => {
    const shown = shownRef.current;
    shownRef.current = report;
    if (!report || !shown || shown === report) return;
    const before = previous ?? shown;
    const drawn = shipsFor(before).ships;
    const gone = new Set(sunkFindings(before, report).map(findingKey));
    const now = performance.now();
    const fresh: Sinking[] = [];
    drawn.forEach((f, i) => {
      // Only ships that were actually on the water go down; an overflow
      // finding never had a hull.
      if (!gone.has(findingKey(f))) return;
      fresh.push({ key: `${findingKey(f)}@${now}`, finding: f, start: now, ...shipRoute(root, cx, cz, landW, landD, f.severity, i, drawn.length) });
    });
    if (fresh.length === 0) return;
    setSinking((s) => [...s, ...fresh]);
    // Not cancelled when `report` changes again: each timer only ever
    // removes its own ships, so a second re-scout mid-sink can't strand
    // the first batch. Unmount clears them all (above).
    const timer = setTimeout(() => {
      sinkTimersRef.current.delete(timer);
      const done = new Set(fresh.map((f) => f.key));
      setSinking((s) => s.filter((x) => !done.has(x.key)));
    }, SINK_MS);
    sinkTimersRef.current.add(timer);
  }, [report, previous, root, cx, cz, landW, landD]);

  const shipRefs = useRef<(THREE.Group | null)[]>([]);
  const sinkRefs = useRef<(THREE.Group | null)[]>([]);
  const smokeRefs = useRef<(THREE.Mesh | null)[]>([]);
  const smoke = hasSmoke(report);
  const flag = showsCleanFlag(report);
  const smokeHeight = Math.max(6, Math.min(landW, landD) * 0.45);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    routes.forEach(({ route }, i) => {
      const g = shipRefs.current[i];
      if (!g) return;
      const pose = boatPose(route, t);
      g.position.set(pose.x, waterY + Math.sin(t * 1.5 + i * 1.7) * route.size * 0.03, pose.z);
      g.rotation.set(0, pose.heading, Math.sin(t * 1.1 + i) * 0.07);
    });
    const now = performance.now();
    sinking.forEach((s, i) => {
      const g = sinkRefs.current[i];
      if (!g) return;
      const k = Math.min(1, (now - s.start) / SINK_MS);
      const pose = boatPose(s.route, t);
      // Bow up, stern down, then under.
      g.position.set(pose.x, waterY - k * k * s.route.size * 1.4, pose.z);
      g.rotation.set(-k * 0.9, pose.heading, k * 0.5);
    });
    smokeRefs.current.forEach((m, i, all) => {
      if (!m) return;
      const phase = (t * 0.12 + i / all.length) % 1;
      m.position.set(Math.sin(t * 0.4 + i) * 0.4 + phase * 1.2, 0.6 + phase * smokeHeight, Math.cos(t * 0.3 + i) * 0.3);
      // Grows as it rises, then thins to nothing at the top.
      m.scale.setScalar((0.35 + phase * 0.9) * Math.sin(Math.PI * Math.min(1, phase * 1.1)));
    });
  });

  // Ships are clickable, so they say so — the same pointer the DOM's
  // buttons show. One flag for the whole fleet: only one can be under the
  // cursor at a time.
  const [hovered, setHovered] = useState(false);
  useCursor(hovered);
  const handleOver = useCallback((event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    setHovered(true);
  }, []);
  const handleOut = useCallback(() => setHovered(false), []);

  const handleClick = useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation();
      onClick(root);
    },
    [onClick, root],
  );

  if (!parts || (routes.length === 0 && sinking.length === 0 && !smoke && !flag)) return null;

  // Tall enough to clear the island's roofs: a flag hidden behind a house
  // says nothing. Small cloth, though — it is a quiet all-clear, not a cue.
  const flagPole = Math.max(4, Math.min(landW, landD) * 0.3);
  return (
    <group>
      {routes.map(({ finding, route, cls }, i) => (
        <group
          key={findingKey(finding)}
          name="pirate-ship"
          ref={(el) => {
            shipRefs.current[i] = el;
          }}
          position={initial[i].position}
          rotation={initial[i].rotation}
          scale={route.size}
          onClick={handleClick}
          onPointerOver={handleOver}
          onPointerOut={handleOut}
        >
          <ShipModel parts={parts} cls={cls} sail={raidColor(finding.severity, stale)} opacity={opacity} />
        </group>
      ))}
      {sinking.map((s, i) => (
        <group
          key={s.key}
          name="sinking-ship"
          ref={(el) => {
            sinkRefs.current[i] = el;
          }}
          scale={s.route.size}
          raycast={() => {}}
        >
          <ShipModel parts={parts} cls={s.cls} sail={raidColor(s.finding.severity, false)} opacity={opacity} />
        </group>
      ))}
      {smoke && puff && (
        <group name="raid-smoke" position={[cx + landW * 0.22, 0, cz - landD * 0.18]}>
          {Array.from({ length: 7 }, (_, i) => (
            <mesh
              key={i}
              geometry={puff}
              ref={(el) => {
                smokeRefs.current[i] = el;
              }}
              raycast={() => {}}
            >
              <meshStandardMaterial color="#5e5853" transparent opacity={0.32 * opacity} depthWrite={false} roughness={1} flatShading />
            </mesh>
          ))}
        </group>
      )}
      {flag && (
        // Toward the camera's side of the island (+x/+z), so the houses
        // stand behind it rather than in front of it.
        <group name="raid-flag" position={[cx + landW * 0.12, 0.1, cz + landD * 0.26]}>
          <mesh position={[0, flagPole / 2, 0]} castShadow raycast={() => {}}>
            <cylinderGeometry args={[0.08, 0.08, flagPole, 6]} />
            <meshStandardMaterial color="#5a4030" roughness={0.9} transparent={opacity < 1} opacity={opacity} />
          </mesh>
          <mesh position={[0.8, flagPole - 0.55, 0]} castShadow raycast={() => {}}>
            <planeGeometry args={[1.5, 1]} />
            <meshStandardMaterial color="#fbf8f0" roughness={0.9} side={THREE.DoubleSide} transparent={opacity < 1} opacity={opacity} />
          </mesh>
        </group>
      )}
      {overflow > 0 && (
        <Html position={[cx + landW * 0.55, 2.4, cz - landD * 0.5]} center style={{ pointerEvents: "none", opacity }} zIndexRange={[10, 0]}>
          <div className="raid-badge" title={`${overflow} more ${overflow === 1 ? "finding" : "findings"}`}>
            +{overflow}
          </div>
        </Html>
      )}
    </group>
  );
}
