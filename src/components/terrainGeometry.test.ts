import { describe, expect, it } from "vitest";
import { buildSafeGroundGeometry } from "./terrainGeometry";

const options = {
  width: 20, depth: 14, moundHeight: 0.32,
  landColor: "#7fb069", shadeColor: "#5f8f4e", lightColor: "#a3c97a", sandColor: "#e3c99a", wetSandColor: "#c9a978",
  beachAtEdge: false,
};

describe("buildSafeGroundGeometry", () => {
  it("keeps a town's ground flat at y=0 while still shading it like the dome", () => {
    const flat = buildSafeGroundGeometry({ ...options, flat: true });
    const domed = buildSafeGroundGeometry(options);
    const ys = Array.from({ length: flat.attributes.position.count }, (_, i) => flat.attributes.position.getY(i));
    expect(Math.max(...ys.map(Math.abs))).toBe(0);
    // Same shading either way: only the surface height changes.
    expect(Array.from(flat.attributes.color.array)).toEqual(Array.from(domed.attributes.color.array));
    const domedYs = Array.from({ length: domed.attributes.position.count }, (_, i) => domed.attributes.position.getY(i));
    expect(Math.max(...domedYs)).toBeCloseTo(0.32, 2);
  });
});
