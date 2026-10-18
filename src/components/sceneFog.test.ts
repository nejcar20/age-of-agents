import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { sceneFogRange } from "./sceneFog";

describe("sceneFogRange", () => {
  it("keeps the entire world clear after fitting, flying, or orbiting the camera", () => {
    const bounds = new THREE.Box3(new THREE.Vector3(-30, 0, -20), new THREE.Vector3(140, 15, 90));
    const camera = new THREE.OrthographicCamera();
    for (const position of [[200, 100, 200], [500, 40, -200], [20, 800, 50]]) {
      camera.position.set(...position as [number, number, number]);
      camera.lookAt(40, 0, 20);
      camera.updateMatrixWorld(true);
      const range = sceneFogRange(camera, bounds);
      for (const x of [bounds.min.x, bounds.max.x]) {
        for (const y of [bounds.min.y, bounds.max.y]) {
          for (const z of [bounds.min.z, bounds.max.z]) {
            const depth = -new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse).z;
            expect(range.near).toBeGreaterThan(depth);
          }
        }
      }
      expect(range.far).toBeGreaterThan(range.near);
    }
  });
});
