import { useMemo } from "react";
import { Bloom, EffectComposer, N8AO, ToneMapping, Vignette } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { useMood } from "../mood";
import { MiniatureEffect } from "./miniatureEffect";

/**
 * The finishing pass that makes the world read as a miniature someone
 * photographed: a soft bloom on what is meant to glow (beacons, halos, lit
 * windows), a gentle vignette, and — for recordings — a tilt-shift band of
 * focus (`MiniatureEffect`).
 *
 * WHY THIS WORKS WHERE THE CRAFT PASS'S ATTEMPT DID NOT (see the note above
 * `computeBounds` in `TownView.tsx`): `EffectComposer` switches the
 * renderer's own tone mapping OFF while it is active, so a stack with no
 * `ToneMapping` effect renders un-tone-mapped — flat and washed out, the
 * "muddied and desaturated" result recorded there. Tone mapping is applied
 * here instead, LAST, with the same ACES curve the Canvas used. Measured on
 * the town fixture against the unprocessed frame: in-focus saturation 0.480
 * vs 0.480, contrast 27.9 vs 28.1.
 */
export function CinematicEffects({ tiltShift = false, scale = "town" }: {
  tiltShift?: boolean;
  /** "sea" keeps the ambient occlusion tight and light: at the sea's zoom a
   * whole island is a few dozen pixels, and the town's radius darkens all
   * of it instead of the places where things meet. */
  scale?: "town" | "sea";
}) {
  const { look } = useMood();
  const miniature = useMemo(() => new MiniatureEffect(), []);
  // Tilt-shift off is a zero-height blur band, not an unmounted effect:
  // adding and removing effects rebuilds the composer's passes.
  miniature.uniforms.get("maxRadius")!.value = tiltShift ? MINIATURE_RADIUS : 0;
  return (
    <EffectComposer multisampling={4}>
      {/* Contact shadows where things meet — eaves on walls, houses on the
          ground, alleys between rows. Radius in SCREEN pixels, so the same
          softness reads at the sea's wide zoom and a town's close one. */}
      <N8AO screenSpaceRadius aoRadius={AO[scale].radius} distanceFalloff={0.6} intensity={AO[scale].intensity} quality="medium" halfRes depthAwareUpsampling color="#1b2430" />
      <Bloom mipmapBlur luminanceThreshold={0.85} luminanceSmoothing={0.2} intensity={look.bloom} />
      <primitive object={miniature} />
      <Vignette offset={0.32} darkness={0.42} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
    </EffectComposer>
  );
}

/** Ambient occlusion: how far it reaches, in pixels, and how dark it gets. */
const AO = {
  town: { radius: 30, intensity: 3.2 },
  sea: { radius: 8, intensity: 1.6 },
} as const;

/** The blur radius at full strength, as a fraction of the frame height. */
const MINIATURE_RADIUS = 0.009;
