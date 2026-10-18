import { describe, expect, it } from "vitest";
import { buildTownCoastGeometry, coastHeight, coastWaterlineT, coastWobble, coastWobbleGlsl, rectDistance, COAST_TERMS } from "./townCoast";

describe("town coast", () => {
  it("starts level with the town's own ground edge, so there is no step", () => {
    expect(coastHeight(0, 0.5, 1)).toBeCloseTo(0, 6);
  });

  it("ends under the water, below the ground's base", () => {
    expect(coastHeight(1.2, 0.5, 1)).toBeLessThan(-0.5);
  });

  it("finds the waterline where the coast actually meets the water", () => {
    const waterY = -0.5 - 0.05;
    const t = coastWaterlineT(0.5, waterY);
    expect(coastHeight(t, 0.5, 0)).toBeCloseTo(waterY, 3);
    expect(t).toBeGreaterThan(0.6);
    expect(t).toBeLessThan(1);
  });

  it("never lets the wobble pull the coast back onto the town", () => {
    const worst = 1 - COAST_TERMS.reduce((sum, [, a]) => sum + a, 0);
    expect(worst).toBeGreaterThan(0.3);
    for (let a = 0; a < Math.PI * 2; a += 0.01) expect(coastWobble(a)).toBeGreaterThan(0.3);
  });

  it("gives the shader the same coastline as the mesh", () => {
    const glsl = coastWobbleGlsl();
    for (const [f, a, p] of COAST_TERMS) expect(glsl).toContain(`${a.toFixed(4)} * sin(${f.toFixed(1)} * ang + ${p.toFixed(4)})`);
  });

  it("measures distance to the town's rectangle, zero inside it", () => {
    expect(rectDistance(5, 5, 10, 10)).toBe(0);
    expect(rectDistance(13, 5, 10, 10)).toBe(3);
    expect(rectDistance(13, 14, 10, 10)).toBe(5);
  });

  it("keeps everything inside the town's rectangle under its ground", () => {
    const geo = buildTownCoastGeometry({ width: 20, depth: 14, groundThickness: 0.5, colors: { grass: "#0f0", grassShade: "#080", sand: "#ff0", wetSand: "#aa0", seabed: "#055" } });
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      if (rectDistance(pos.getX(i), pos.getZ(i), 20, 14) === 0) expect(pos.getY(i)).toBeLessThan(0);
    }
  });
});
