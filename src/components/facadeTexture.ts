import * as THREE from "three";

type Rect = { x: number; y: number; w: number; h: number };

/** The window panes each facade paints — shared with the night-time
 * `*WindowMask` textures below, so a lit window lands exactly on a painted
 * one. */
const COTTAGE_WINDOWS: Rect[] = [17, 88].map((x) => ({ x, y: 28, w: 22, h: 26 }));
/** The building facade's canvas, and its window panes — laid out once so
 * the painted facade and the night-time mask can never disagree. */
const FACADE_W = 128;
const FACADE_H = 192;
const BUILDING_WINDOWS: Rect[] = (() => {
  const cols = 2, rows = 2, marginX = 22, top = 34, gapX = 28, gapY = 34, h = 34;
  const w = (FACADE_W - marginX * 2 - gapX * (cols - 1)) / cols;
  const rects: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) rects.push({ x: marginX + c * (w + gapX), y: top + r * (h + gapY), w, h });
  }
  return rects;
})();

/** Black everywhere but the panes: an `emissiveMap`, so only glass glows. */
function windowMask(width: number, height: number, panes: Rect[]): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#ffffff";
    for (const { x, y, w, h } of panes) ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

let cachedCottageMask: THREE.CanvasTexture | null = null;
export function cottageWindowMask(): THREE.CanvasTexture {
  return (cachedCottageMask ??= windowMask(128, 96, COTTAGE_WINDOWS));
}

let cachedBuildingMask: THREE.CanvasTexture | null = null;
export function buildingWindowMask(): THREE.CanvasTexture {
  return (cachedBuildingMask ??= windowMask(FACADE_W, FACADE_H, BUILDING_WINDOWS));
}

let cachedCottageTexture: THREE.CanvasTexture | null = null;

/** One-storey facade for the sea's miniature villages; no apartment-window grid. */
export function cottageFacadeTexture(): THREE.CanvasTexture {
  if (cachedCottageTexture) return cachedCottageTexture;
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 128, 96);
    // A stone plinth, timber door, blue glass, and pale window mullions.
    ctx.fillStyle = "#b8b2a0";
    ctx.fillRect(0, 87, 128, 9);
    ctx.fillStyle = "#817362";
    ctx.fillRect(53, 40, 22, 51);
    ctx.fillStyle = "#435d61";
    for (const { x } of COTTAGE_WINDOWS) {
      ctx.fillRect(x, 28, 22, 26);
      ctx.fillStyle = "#e3dcca";
      ctx.fillRect(x + 10, 28, 2, 26);
      ctx.fillRect(x, 40, 22, 2);
      ctx.fillRect(x - 2, 54, 26, 3);
      ctx.fillStyle = "#435d61";
    }
    ctx.fillStyle = "#d8c596";
    ctx.fillRect(69, 65, 3, 3);
  }
  cachedCottageTexture = new THREE.CanvasTexture(canvas);
  cachedCottageTexture.colorSpace = THREE.SRGBColorSpace;
  return cachedCottageTexture;
}

/**
 * Art-direction round, item 6: "at close zoom, buildings are plain boxes
 * with pyramid roofs... add windows/doors as small dark marks... keep it
 * cheap since instanced."
 *
 * The cheapest possible version of "buildings have windows and a door": one
 * small canvas-drawn texture, generated ONCE for the whole app's lifetime
 * (module-level cache, not a `useMemo` per component instance — every
 * `BuildingInstances`/`MiniTown` wall material, across every district and
 * every island, shares this exact same `THREE.CanvasTexture` object), applied
 * as the wall material's `map`. Zero extra draw calls, zero extra geometry,
 * zero per-instance work: the existing `instanceColor` tint (see
 * `BuildingInstances`) still multiplies against it per-building, so the
 * marks show up cream-on-tinted-cream rather than flat white.
 *
 * Deliberately the SAME texture on every wall face of every building of
 * every kind — a plain grid of windows plus one door band at the bottom —
 * because varying it by anything would mean varying it by some property of
 * the repository, which item 5's ruling (this round) explicitly forbids for
 * decoration: "must not encode anything." A window is dressing, not a
 * signal.
 */
let cachedFacadeTexture: THREE.CanvasTexture | null = null;

export function buildingFacadeTexture(): THREE.CanvasTexture {
  if (cachedFacadeTexture) return cachedFacadeTexture;

  const canvas = document.createElement("canvas");
  canvas.width = FACADE_W;
  canvas.height = FACADE_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    const blank = new THREE.CanvasTexture(canvas);
    cachedFacadeTexture = blank;
    return blank;
  }

  // White wall, so each building's own instance colour (its tint) shows
  // through unchanged; everything painted on it is relative to that.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, FACADE_W, FACADE_H);

  // Cornice: a pale band right under the roof with a soft shadow line below
  // it — the roof reads as sitting ON the wall instead of hovering.
  ctx.fillStyle = "#e9e2d3";
  ctx.fillRect(0, 0, FACADE_W, 12);
  ctx.fillStyle = "rgba(60, 48, 34, 0.22)";
  ctx.fillRect(0, 12, FACADE_W, 4);

  // Stone plinth: the darker base every real house stands on, with a few
  // courses scored into it.
  const plinthTop = FACADE_H - 22;
  ctx.fillStyle = "#b9ad99";
  ctx.fillRect(0, plinthTop, FACADE_W, FACADE_H - plinthTop);
  ctx.fillStyle = "rgba(60, 48, 34, 0.25)";
  ctx.fillRect(0, plinthTop, FACADE_W, 2);
  ctx.fillStyle = "rgba(60, 48, 34, 0.14)";
  for (let x = 6; x < FACADE_W; x += 18) ctx.fillRect(x, plinthTop + 9, 1, 12);
  ctx.fillRect(0, plinthTop + 9, FACADE_W, 1);

  for (const { x, y, w, h } of BUILDING_WINDOWS) {
    // Shutters either side, muted sage — the one note of colour on a wall.
    ctx.fillStyle = "#7f9a88";
    ctx.fillRect(x - 9, y, 7, h);
    ctx.fillRect(x + w + 2, y, 7, h);
    ctx.fillStyle = "rgba(40, 52, 44, 0.35)";
    for (let sy = y + 4; sy < y + h; sy += 5) {
      ctx.fillRect(x - 9, sy, 7, 1);
      ctx.fillRect(x + w + 2, sy, 7, 1);
    }
    // Frame, then glass with a darker top (the reveal's shadow) and a
    // light glint in one corner.
    ctx.fillStyle = "#f6f1e6";
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    const glass = ctx.createLinearGradient(0, y, 0, y + h);
    glass.addColorStop(0, "#27454a");
    glass.addColorStop(1, "#3f6a6c");
    ctx.fillStyle = glass;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "rgba(255, 255, 255, 0.18)";
    ctx.fillRect(x + 2, y + 2, w * 0.35, h * 0.3);
    // Glazing bars.
    ctx.fillStyle = "#f6f1e6";
    ctx.fillRect(x + w / 2 - 1, y, 2, h);
    ctx.fillRect(x, y + h / 2 - 1, w, 2);
    // Sill, with its shadow on the wall.
    ctx.fillStyle = "#ddd5c4";
    ctx.fillRect(x - 4, y + h + 2, w + 8, 4);
    ctx.fillStyle = "rgba(60, 48, 34, 0.18)";
    ctx.fillRect(x - 3, y + h + 6, w + 6, 3);
  }

  // Door: a framed, recessed door on a step, centred on the plinth.
  const doorW = 30;
  const doorH = 44;
  const doorX = (FACADE_W - doorW) / 2;
  const doorY = FACADE_H - 8 - doorH;
  ctx.fillStyle = "#efe8da";
  ctx.fillRect(doorX - 4, doorY - 4, doorW + 8, doorH + 4);
  ctx.fillStyle = "#5b4633";
  ctx.fillRect(doorX, doorY, doorW, doorH);
  ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
  ctx.fillRect(doorX + 4, doorY + 5, doorW / 2 - 6, doorH - 10);
  ctx.fillRect(doorX + doorW / 2 + 2, doorY + 5, doorW / 2 - 6, doorH - 10);
  ctx.fillStyle = "#e6c77a";
  ctx.fillRect(doorX + doorW - 7, doorY + doorH / 2, 3, 3);
  ctx.fillStyle = "#cfc5b2";
  ctx.fillRect(doorX - 7, FACADE_H - 8, doorW + 14, 8);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Walls are always seen at a slant from the isometric camera; without
  // anisotropic filtering the frames and shutters smear into the wall.
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  cachedFacadeTexture = texture;
  return texture;
}
