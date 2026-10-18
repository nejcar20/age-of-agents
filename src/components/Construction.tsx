import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { ROOF_OVERHANG } from "../city";

/**
 * Construction: what a town looks like while an agent is working in it.
 *
 * Every piece is tied to a real fact and appears only while it is true —
 * the same honesty rule as the rest of the town:
 * - scaffolding stands around buildings whose files have uncommitted
 *   changes (Git's own list, the same one the change markers draw), and
 *   only while an agent here is working;
 * - one crane stands over the middle of those changes;
 * - chimneys smoke while the town is working.
 * When the agent stops, all of it comes down.
 */

/** Just what construction needs to know about one building. */
export type Site = { x: number; z: number; height: number; footprint: number; roofPitch: number };

const WOOD = "#b58a57";
const WOOD_DARK = "#8c6a45";
const CRANE_YELLOW = "#f2b632";
const SMOKE = "#e9e6e1";

/** The pieces of one building's scaffold, as boxes in world units. */
function scaffoldPieces(site: Site, pitch: number): { x: number; y: number; z: number; sx: number; sy: number; sz: number; dark: boolean }[] {
  const half = (site.footprint * ROOF_OVERHANG) / 2 + pitch * 0.05;
  const top = site.height + site.footprint * site.roofPitch * 0.35;
  const pole = Math.max(0.025, pitch * 0.028);
  const plank = Math.max(0.02, pitch * 0.022);
  const pieces: ReturnType<typeof scaffoldPieces> = [];
  for (const dx of [-half, half]) {
    for (const dz of [-half, half]) {
      pieces.push({ x: site.x + dx, y: top / 2, z: site.z + dz, sx: pole, sy: top, sz: pole, dark: true });
    }
  }
  // A level of planks every storey-ish, walking boards on all four sides.
  const levels = Math.max(2, Math.round(top / (pitch * 0.45)));
  for (let l = 1; l <= levels; l++) {
    const y = (top * l) / levels;
    pieces.push({ x: site.x, y, z: site.z - half, sx: half * 2, sy: plank, sz: pole * 2.2, dark: false });
    pieces.push({ x: site.x, y, z: site.z + half, sx: half * 2, sy: plank, sz: pole * 2.2, dark: false });
    pieces.push({ x: site.x - half, y, z: site.z, sx: pole * 2.2, sy: plank, sz: half * 2, dark: false });
    pieces.push({ x: site.x + half, y, z: site.z, sx: pole * 2.2, sy: plank, sz: half * 2, dark: false });
  }
  return pieces;
}

export function Scaffolding({ sites, pitch }: { sites: Site[]; pitch: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const pieces = useMemo(() => sites.flatMap((site) => scaffoldPieces(site, pitch)), [sites, pitch]);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    const light = new THREE.Color(WOOD);
    const dark = new THREE.Color(WOOD_DARK);
    pieces.forEach((p, i) => {
      dummy.position.set(p.x, p.y, p.z);
      dummy.scale.set(p.sx, p.sy, p.sz);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, p.dark ? dark : light);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [pieces]);
  if (pieces.length === 0) return null;
  return (
    <instancedMesh key={pieces.length} ref={ref} args={[undefined, undefined, pieces.length]} castShadow raycast={() => {}}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial roughness={0.9} />
    </instancedMesh>
  );
}

/**
 * A tower crane over the middle of the changes, its jib turning slowly the
 * way a working crane swings between loads.
 */
export function Crane({ sites, pitch }: { sites: Site[]; pitch: number }) {
  const jibRef = useRef<THREE.Group>(null);
  const placement = useMemo(() => {
    if (sites.length === 0) return null;
    const x = sites.reduce((sum, s) => sum + s.x, 0) / sites.length;
    const z = sites.reduce((sum, s) => sum + s.z, 0) / sites.length;
    const tallest = Math.max(...sites.map((s) => s.height + s.footprint * s.roofPitch));
    return { x: x + pitch * 0.9, z: z - pitch * 0.9, height: tallest * 1.35 + pitch * 2.2 };
  }, [sites, pitch]);
  useFrame(({ clock }) => {
    if (jibRef.current) jibRef.current.rotation.y = Math.sin(clock.elapsedTime * 0.18) * 1.1 + 0.6;
  });
  if (!placement) return null;
  const mast = pitch * 0.12;
  const jib = pitch * 3.2;
  return (
    <group position={[placement.x, 0, placement.z]}>
      <mesh position={[0, 0.06, 0]} castShadow>
        <boxGeometry args={[mast * 3, 0.12, mast * 3]} />
        <meshStandardMaterial color="#7a7068" roughness={0.9} />
      </mesh>
      <mesh position={[0, placement.height / 2, 0]} castShadow>
        <boxGeometry args={[mast, placement.height, mast]} />
        <meshStandardMaterial color={CRANE_YELLOW} roughness={0.6} />
      </mesh>
      <group ref={jibRef} position={[0, placement.height, 0]}>
        <mesh position={[jib / 2 - mast, 0, 0]} castShadow>
          <boxGeometry args={[jib, mast * 0.8, mast * 0.8]} />
          <meshStandardMaterial color={CRANE_YELLOW} roughness={0.6} />
        </mesh>
        <mesh position={[-jib * 0.22, 0, 0]} castShadow>
          <boxGeometry args={[jib * 0.35, mast * 0.8, mast * 0.8]} />
          <meshStandardMaterial color={CRANE_YELLOW} roughness={0.6} />
        </mesh>
        {/* Counterweight and operator's cab. */}
        <mesh position={[-jib * 0.34, -mast * 0.9, 0]} castShadow>
          <boxGeometry args={[mast * 2.2, mast * 1.6, mast * 1.6]} />
          <meshStandardMaterial color="#6e6a66" roughness={0.9} />
        </mesh>
        <mesh position={[mast * 0.2, -mast * 1.1, mast * 0.9]} castShadow>
          <boxGeometry args={[mast * 1.4, mast * 1.3, mast * 1.2]} />
          <meshStandardMaterial color="#d8d2c4" roughness={0.7} />
        </mesh>
        {/* The hoist cable and its load. */}
        <mesh position={[jib * 0.7, -placement.height * 0.28, 0]}>
          <boxGeometry args={[0.012, placement.height * 0.56, 0.012]} />
          <meshBasicMaterial color="#3a3530" />
        </mesh>
        <mesh position={[jib * 0.7, -placement.height * 0.56 - mast * 0.6, 0]} castShadow>
          <boxGeometry args={[mast * 2.4, mast * 1.2, mast * 1.6]} />
          <meshStandardMaterial color={WOOD} roughness={0.9} />
        </mesh>
      </group>
    </group>
  );
}

/** Where a building's chimney tops out — shared with `BuildingInstances`,
 * whose chimney placement this must match. */
export function chimneyTop(site: Site): THREE.Vector3 {
  const roofHeight = site.footprint * site.roofPitch;
  return new THREE.Vector3(site.x + site.footprint * 0.24, site.height + roofHeight + site.footprint * 0.1, site.z + site.footprint * 0.24);
}

const PUFFS_PER_CHIMNEY = 4;
const SMOKE_PERIOD = 4.2;

/** Soft puffs rising and swelling from each chimney, then gone. */
export function ChimneySmoke({ sources, pitch }: { sources: THREE.Vector3[]; pitch: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const count = sources.length * PUFFS_PER_CHIMNEY;
  const dummy = useMemo(() => new THREE.Object3D(), []);
  useFrame(({ clock }) => {
    const mesh = ref.current;
    if (!mesh) return;
    sources.forEach((source, s) => {
      for (let p = 0; p < PUFFS_PER_CHIMNEY; p++) {
        // Each chimney gets its own phase so the town does not puff in unison.
        const t = ((clock.elapsedTime / SMOKE_PERIOD + p / PUFFS_PER_CHIMNEY + (s * 0.618) % 1) % 1);
        const rise = t * pitch * 1.4;
        const drift = t * pitch * 0.35;
        const size = pitch * (0.07 + t * 0.2) * Math.sin(Math.PI * Math.min(1, t * 1.15));
        dummy.position.set(source.x + drift, source.y + rise, source.z - drift * 0.4);
        dummy.scale.setScalar(Math.max(0.0001, size));
        dummy.updateMatrix();
        mesh.setMatrixAt(s * PUFFS_PER_CHIMNEY + p, dummy.matrix);
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
  });
  if (count === 0) return null;
  return (
    <instancedMesh key={count} ref={ref} args={[undefined, undefined, count]} frustumCulled={false} raycast={() => {}}>
      <icosahedronGeometry args={[1, 1]} />
      <meshStandardMaterial color={SMOKE} roughness={1} transparent opacity={0.62} depthWrite={false} flatShading />
    </instancedMesh>
  );
}
