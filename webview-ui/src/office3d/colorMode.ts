import * as THREE from 'three';

/**
 * The design's colour look. The mockup was drawn with an older three.js that
 * did no colour-space conversion: hex colours went to the screen as they are,
 * which reads deeper and more contrasty than today's linear-to-sRGB pipeline
 * (that one washes the toy palette out). Turn conversion off, the same way,
 * for every 3D surface in the office. Import this module before building
 * materials — it switches three.js's global colour management.
 */
THREE.ColorManagement.enabled = false;

export function applyDesignColors(renderer: THREE.WebGLRenderer): void {
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
}
