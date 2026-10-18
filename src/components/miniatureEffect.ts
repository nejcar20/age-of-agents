import { BlendFunction, Effect, EffectAttribute } from "postprocessing";
import { Uniform } from "three";

/**
 * Tilt-shift, done the way a lens does it: a horizontal band of sharp focus
 * and a round, soft blur that grows smoothly above and below it — the cue
 * that makes a photographed city read as a model of one.
 *
 * Written here rather than using either library tilt-shift, both measured on
 * this scene: `TiltShift2` blurs along ONE direction only (trees smear
 * sideways instead of going out of focus), and `postprocessing`'s own
 * `TiltShiftEffect` runs its blur in a separate pass whose output drops the
 * rest of the chain — tone mapping and vignette vanished, the frame came out
 * 45 luma brighter and a quarter less saturated. This is a single-pass
 * convolution (the same shape as `TiltShift2`, which chains correctly),
 * sampling a golden-angle disc instead of a line.
 */
const fragmentShader = /* glsl */ `
  uniform float focusY;
  uniform float focusHalfHeight;
  uniform float feather;
  uniform float maxRadius;

  const int SAMPLES = 28;
  const float GOLDEN_ANGLE = 2.39996323;

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    float distanceFromFocus = max(0.0, abs(uv.y - focusY) - focusHalfHeight);
    float amount = smoothstep(0.0, feather, distanceFromFocus);
    if (amount <= 0.001 || maxRadius <= 0.0) {
      outputColor = inputColor;
      return;
    }
    // Radius in pixels, normalised to the frame height so the look holds
    // at any window size.
    float radius = amount * maxRadius * resolution.y;
    vec4 sum = inputColor;
    float total = 1.0;
    for (int i = 1; i < SAMPLES; i++) {
      float r = sqrt(float(i) / float(SAMPLES)) * radius;
      float theta = float(i) * GOLDEN_ANGLE;
      vec2 offset = vec2(cos(theta), sin(theta)) * r / resolution;
      sum += texture2D(inputBuffer, uv + offset);
      total += 1.0;
    }
    outputColor = sum / total;
  }
`;

export class MiniatureEffect extends Effect {
  constructor({
    focusY = 0.5,
    focusHalfHeight = 0.12,
    feather = 0.3,
    maxRadius = 0.008,
  }: { focusY?: number; focusHalfHeight?: number; feather?: number; maxRadius?: number } = {}) {
    super("MiniatureEffect", fragmentShader, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, Uniform>([
        ["focusY", new Uniform(focusY)],
        ["focusHalfHeight", new Uniform(focusHalfHeight)],
        ["feather", new Uniform(feather)],
        ["maxRadius", new Uniform(maxRadius)],
      ]),
    });
  }
}
