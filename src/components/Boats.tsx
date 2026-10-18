import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

/**
 * Sailboats on loops around an island — life in the scene nobody asked for,
 * which is most of what makes a world feel inhabited. Scenery only: a boat
 * means nothing, its route is a fixed function of where the island is, and
 * no count or speed depends on anything about the repository.
 *
 * Every boat follows a rounded-square ("squircle") loop rather than an
 * ellipse, so it hugs a rectangular town's lagoon evenly instead of cutting
 * across the corners onto the beach.
 */
export type BoatRoute = {
  cx: number;
  cz: number;
  /** Half-extents of the loop. */
  rx: number;
  rz: number;
  /** Radians per second around the loop; the sign is the direction. */
  speed: number;
  phase: number;
  /** Boat length in world units. */
  size: number;
};

const SQUIRCLE_POWER = 4;

/** A point on the squircle loop, and the direction of travel there. */
export function boatPose(route: BoatRoute, t: number): { x: number; z: number; heading: number } {
  const at = (a: number) => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return {
      x: route.cx + route.rx * Math.sign(c) * Math.abs(c) ** (2 / SQUIRCLE_POWER),
      z: route.cz + route.rz * Math.sign(s) * Math.abs(s) ** (2 / SQUIRCLE_POWER),
    };
  };
  const a = route.phase + t * route.speed;
  const here = at(a);
  const ahead = at(a + 0.02 * Math.sign(route.speed || 1));
  return { ...here, heading: Math.atan2(ahead.x - here.x, ahead.z - here.z) };
}

const HULL = "#8a5a3c";
const SAIL = "#f5f1e6";

/** One boat, built from boxes and a triangle in a unit (length 1) frame
 * pointing along +z. */
function useBoatParts() {
  return useMemo(() => {
    const hull = new THREE.BoxGeometry(0.34, 0.14, 1);
    // Taper the bow: pull the two front-top vertices in.
    const pos = hull.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getZ(i) > 0.4) pos.setX(i, pos.getX(i) * 0.25);
    }
    hull.computeVertexNormals();
    const mast = new THREE.BoxGeometry(0.035, 0.9, 0.035);
    const sail = new THREE.BufferGeometry();
    sail.setAttribute("position", new THREE.Float32BufferAttribute([0, 0.08, -0.32, 0, 0.9, -0.02, 0, 0.08, 0.28], 3));
    sail.computeVertexNormals();
    return { hull, mast, sail };
  }, []);
}

export function SailingBoats({ routes, waterY }: { routes: BoatRoute[]; waterY: number }) {
  const { hull, mast, sail } = useBoatParts();
  const hullRef = useRef<THREE.InstancedMesh>(null);
  const mastRef = useRef<THREE.InstancedMesh>(null);
  const sailRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  useLayoutEffect(() => () => { hull.dispose(); mast.dispose(); sail.dispose(); }, [hull, mast, sail]);
  // No `invalidate()`: moves only while the render loop is already awake.
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    routes.forEach((route, i) => {
      const pose = boatPose(route, t);
      const bob = Math.sin(t * 1.7 + i * 1.3) * route.size * 0.03;
      const roll = Math.sin(t * 1.3 + i) * 0.06;
      const put = (mesh: THREE.InstancedMesh | null, y: number) => {
        if (!mesh) return;
        dummy.position.set(pose.x, waterY + bob + y * route.size, pose.z);
        dummy.rotation.set(0, pose.heading, roll);
        dummy.scale.setScalar(route.size);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        mesh.instanceMatrix.needsUpdate = true;
      };
      put(hullRef.current, 0.05);
      put(mastRef.current, 0.55);
      put(sailRef.current, 0.08);
    });
  });
  if (routes.length === 0) return null;
  return (
    <group>
      <instancedMesh ref={hullRef} args={[hull, undefined, routes.length]} castShadow frustumCulled={false} raycast={() => {}}>
        <meshStandardMaterial color={HULL} roughness={0.8} flatShading />
      </instancedMesh>
      <instancedMesh ref={mastRef} args={[mast, undefined, routes.length]} frustumCulled={false} raycast={() => {}}>
        <meshStandardMaterial color="#5a4030" roughness={0.9} />
      </instancedMesh>
      <instancedMesh ref={sailRef} args={[sail, undefined, routes.length]} castShadow frustumCulled={false} raycast={() => {}}>
        <meshStandardMaterial color={SAIL} roughness={0.9} side={THREE.DoubleSide} />
      </instancedMesh>
    </group>
  );
}
