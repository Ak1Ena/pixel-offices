/**
 * Character studio: a turning 3D preview and the pickers for hair, top,
 * colours, height and extras. Controlled — the parent owns the look. Loaded
 * lazily (it draws with Three.js).
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

import type { AgentLook } from '../../../core/src/agentLook.js';
import { Button } from '../components/ui/Button.js';
import {
  OFFICE3D_COLORS as C,
  OFFICE3D_HEMI_INTENSITY,
  OFFICE3D_STUDIO_BG,
  OFFICE3D_SUN_INTENSITY,
  OFFICE3D_SWATCHES,
} from '../constants.js';
import {
  EXTRA_OPTIONS,
  HAIR_OPTIONS,
  HEIGHT_OPTIONS,
  randomLook,
  toggleExtra,
  TOP_OPTIONS,
} from '../lookOptions.js';
import { buildLookRig, disposeRig, type Rig } from './characters3d.js';

export interface LookStudioProps {
  look: AgentLook;
  onChange: (look: AgentLook) => void;
}

export default function LookStudio({ look, onChange }: LookStudioProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const setLookRef = useRef<(l: AgentLook) => void>(() => {});

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.domElement.style.display = 'block';
    renderer.domElement.dataset.testid = 'look-preview';
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(OFFICE3D_STUDIO_BG);
    scene.add(new THREE.HemisphereLight(C.hemiSky, C.hemiGround, OFFICE3D_HEMI_INTENSITY));
    const sun = new THREE.DirectionalLight(C.sun, OFFICE3D_SUN_INTENSITY);
    sun.position.set(2, 4, 3);
    scene.add(sun);
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.62, 0.66, 0.08, 40),
      new THREE.MeshStandardMaterial({ color: C.floorA, roughness: 0.9 }),
    );
    disc.position.y = -0.04;
    scene.add(disc);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);

    let rig: Rig | null = null;
    let spin = 0.5;
    let drag: { x: number; s: number } | null = null;
    setLookRef.current = (l) => {
      if (rig) {
        scene.remove(rig.g);
        disposeRig(rig);
      }
      rig = buildLookRig(l);
      scene.add(rig.g);
      const h = rig.height;
      camera.position.set(0, h * 0.62, 2.1 + h * 0.9);
      camera.lookAt(0, h * 0.5, 0);
    };

    const el = renderer.domElement;
    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, s: spin };
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (drag) spin = drag.s + (e.clientX - drag.x) * 0.012;
    };
    const up = () => {
      drag = null;
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);

    let raf = 0;
    let t = 0;
    let last = 0;
    const frame = (now: number) => {
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      t += dt;
      const w = host.clientWidth,
        h = host.clientHeight;
      if (
        w &&
        h &&
        (el.width !== Math.round(w * renderer.getPixelRatio()) ||
          el.height !== Math.round(h * renderer.getPixelRatio()))
      ) {
        renderer.setSize(w, h, false);
        el.style.width = '100%';
        el.style.height = '100%';
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
      if (rig) {
        if (!drag) spin += dt * 0.4;
        rig.g.rotation.y = spin;
        rig.arms[0].rotation.x = Math.sin(t * 1.3) * 0.08;
        rig.arms[1].rotation.x = -Math.sin(t * 1.3) * 0.08;
        rig.root.position.y = Math.sin(t * 2) * 0.01;
        rig.head.rotation.y = Math.sin(t * 0.7) * 0.25;
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      if (rig) disposeRig(rig);
      renderer.dispose();
      host.removeChild(el);
      setLookRef.current = () => {};
    };
  }, []);

  useEffect(() => {
    setLookRef.current(look);
  }, [look]);

  const chips = <T extends string>(
    options: Array<[T, string]>,
    isOn: (k: T) => boolean,
    pick: (k: T) => void,
    testid: string,
  ) => (
    <div className="flex flex-wrap gap-4" data-testid={testid}>
      {options.map(([k, label]) => (
        <Button
          key={k}
          type="button"
          size="sm"
          variant={isOn(k) ? 'active' : 'default'}
          aria-pressed={isOn(k)}
          onClick={() => pick(k)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
  const swatches = (field: 'skin' | 'hairColor' | 'shirt' | 'pants', label: string) => (
    <div
      className="flex flex-wrap gap-4"
      role="group"
      aria-label={label}
      data-testid={`look-${field}`}
    >
      {OFFICE3D_SWATCHES[field].map((c, i) => (
        <button
          key={c}
          type="button"
          aria-label={`${label} ${i + 1}`}
          aria-pressed={look[field] === c}
          onClick={() => onChange({ ...look, [field]: c })}
          className={`w-20 h-20 p-0 rounded-none cursor-pointer border-2 ${
            look[field] === c ? 'border-accent' : 'border-border'
          }`}
          style={{ background: c }}
        />
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-8 text-sm" data-testid="look-studio">
      <div className="relative h-180 border-2 border-border cursor-grab" ref={hostRef}>
        <span className="absolute right-4 bottom-2 text-2xs text-text-muted pointer-events-none">
          Drag to turn
        </span>
      </div>
      <div className="flex flex-col gap-2">
        Skin
        {swatches('skin', 'Skin')}
      </div>
      <div className="flex flex-col gap-2">
        Hair
        {chips(
          HAIR_OPTIONS,
          (k) => look.hair === k,
          (k) => onChange({ ...look, hair: k }),
          'look-hair',
        )}
        {swatches('hairColor', 'Hair colour')}
      </div>
      <div className="flex flex-col gap-2">
        Top
        {chips(
          TOP_OPTIONS,
          (k) => look.top === k,
          (k) => onChange({ ...look, top: k }),
          'look-top',
        )}
        {swatches('shirt', 'Top colour')}
      </div>
      <div className="flex flex-col gap-2">
        Trousers
        {swatches('pants', 'Trousers colour')}
      </div>
      <div className="flex flex-col gap-2">
        Height
        {chips(
          HEIGHT_OPTIONS,
          (k) => look.height === k,
          (k) => onChange({ ...look, height: k }),
          'look-height',
        )}
      </div>
      <div className="flex flex-col gap-2">
        Extras
        {chips(
          EXTRA_OPTIONS,
          (k) => look.extras.includes(k),
          (k) => onChange(toggleExtra(look, k)),
          'look-extras',
        )}
      </div>
      <div>
        <Button
          type="button"
          size="sm"
          onClick={() => onChange(randomLook())}
          data-testid="look-random"
        >
          Surprise me
        </Button>
      </div>
    </div>
  );
}
