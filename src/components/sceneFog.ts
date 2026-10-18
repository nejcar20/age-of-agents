import * as THREE from "three";

/** Haze belongs beyond the islands. Use the actual view, including camera flights. */
export function sceneFogRange(camera: THREE.Camera, bounds: THREE.Box3) {
  const center = bounds.getCenter(new THREE.Vector3()).applyMatrix4(camera.matrixWorldInverse);
  const radius = bounds.getSize(new THREE.Vector3()).length() / 2;
  const near = Math.max(0, -center.z + radius + Math.max(10, radius * 0.4));
  return { near, far: near + Math.max(100, radius * 6) };
}
