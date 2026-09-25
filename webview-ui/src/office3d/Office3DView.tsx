/**
 * The office in 3D (Soft Dollhouse). Same OfficeState, same clicks and drops as
 * the pixel canvas; only the drawing differs. Loaded lazily, so viewers who keep
 * the pixel view never download Three.js.
 */

import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

import { Button } from '../components/ui/Button.js';
import {
  DESK_CARD_DRAG_MIME,
  MATRIX_EFFECT_DURATION_SEC,
  MAX_DELTA_TIME_SEC,
  OFFICE3D_CAMERA_SPAN_K,
  OFFICE3D_COLORS as C,
  OFFICE3D_DRAG_SLOP_PX,
  OFFICE3D_FOV,
  OFFICE3D_HEMI_INTENSITY,
  OFFICE3D_NIGHT_FROM_HOUR,
  OFFICE3D_NIGHT_KEY,
  OFFICE3D_NIGHT_TO_HOUR,
  OFFICE3D_PX_PER_M,
  OFFICE3D_RISE_M_PER_PX,
  OFFICE3D_SUN_INTENSITY,
  OFFICE3D_TILT_MAX,
  OFFICE3D_TILT_MIN,
  OFFICE3D_ZOOM_MAX,
  OFFICE3D_ZOOM_MIN,
  PIN_DRAG_MIME,
  WORKFLOW_DRAG_MIME,
} from '../constants.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { setScreen3D } from '../office/projection.js';
import type { OfficeLayout } from '../office/types.js';
import { CharacterState } from '../office/types.js';
import { isE2E } from '../runtime.js';
import { buildOffice, disposeGroup, type OfficeMeshes } from './build.js';
import { buildRig, disposeRig, lookKey, poseRig, type Rig } from './characters3d.js';
import {
  applyNight,
  buildLamps,
  type Leaver,
  type NightRig,
  startLeaving,
  stepLeaver,
  updateBurn,
} from './life.js';
import { MeetingDirector } from './meetings.js';

export interface Office3DViewProps {
  officeState: OfficeState;
  onClick: (agentId: number) => void;
  onPinDrop?: (agentId: number, pinId: string) => void;
  onWorkflowDrop?: (agentId: number, workflowId: string) => void;
  onCardDrop?: (agentId: number, taskId: string) => void;
}

type DragKind = 'pin' | 'workflow' | 'card';

export default function Office3DView({
  officeState,
  onClick,
  onPinDrop,
  onWorkflowDrop,
  onCardDrop,
}: Office3DViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const pickRef = useRef<(clientX: number, clientY: number) => number | null>(() => null);
  const dropRef = useRef({ onPinDrop, onWorkflowDrop, onCardDrop, onClick });
  const overlayRef = useRef<OverlayItem[]>([]);
  const [nightMode, setNightMode] = useState<NightMode>(() => {
    try {
      const v = localStorage.getItem(OFFICE3D_NIGHT_KEY);
      return v === 'day' || v === 'night' ? v : 'auto';
    } catch {
      return 'auto';
    }
  });
  const nightRef = useRef(nightMode);
  nightRef.current = nightMode;
  dropRef.current = { onPinDrop, onWorkflowDrop, onCardDrop, onClick };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.style.display = 'block';
    renderer.domElement.dataset.testid = 'office-3d';
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(C.sky);
    const hemi = new THREE.HemisphereLight(C.hemiSky, C.hemiGround, OFFICE3D_HEMI_INTENSITY);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(C.sun, OFFICE3D_SUN_INTENSITY);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0006;
    sun.shadow.radius = 4;
    scene.add(sun, sun.target);

    const camera = new THREE.PerspectiveCamera(OFFICE3D_FOV, 1, 0.1, 400);
    const cam = {
      az: Math.PI / 4,
      el: 0.95,
      zoom: 1,
      target: new THREE.Vector3(),
      goal: new THREE.Vector3(),
      dist: 30,
    };

    // Selection ring under the selected / hovered character.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.44, 32),
      new THREE.MeshBasicMaterial({ color: C.select, transparent: true, opacity: 0.9 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    scene.add(ring);

    let office: OfficeMeshes | null = null;
    let builtLayout: OfficeLayout | null = null;
    const rebuild = () => {
      const layout = officeState.getLayout();
      if (layout === builtLayout) return;
      builtLayout = layout;
      if (office) {
        scene.remove(office.group);
        disposeGroup(office.group);
      }
      office = buildOffice(layout);
      scene.add(office.group);
      const lit = buildLamps(office, office.group);
      night.lamps = lit.lamps;
      night.bulbs = lit.bulbs;
      director.end();
      const b = office.bounds;
      const cx = (b.x0 + b.x1) / 2,
        cz = (b.z0 + b.z1) / 2,
        span = Math.max(b.x1 - b.x0, b.z1 - b.z0);
      cam.goal.set(cx, 0, cz);
      cam.target.copy(cam.goal);
      cam.dist = span * OFFICE3D_CAMERA_SPAN_K + 6;
      const R = Math.hypot(b.x1 - b.x0, b.z1 - b.z0) / 2 + 4;
      sun.target.position.set(cx, 0, cz);
      sun.position.set(cx + 7, 15, cz + 9);
      const sc = sun.shadow.camera;
      sc.left = -R;
      sc.right = R;
      sc.top = R;
      sc.bottom = -R;
      sc.near = 1;
      sc.far = 40 + R * 2;
      sc.updateProjectionMatrix();
    };

    const night: NightRig = { hemi, sun, lamps: [], bulbs: [] };
    let nightK = -1;
    const director = new MeetingDirector(officeState);
    const leavers: Leaver[] = [];
    /** Characters whose rig became a leaver: never re-created while they despawn. */
    const left = new Set<number>();

    const rigs = new Map<number, Rig>();
    const syncRigs = () => {
      const seen = new Set<number>();
      for (const ch of officeState.getCharacters()) {
        seen.add(ch.id);
        if (left.has(ch.id)) continue;
        let r = rigs.get(ch.id);
        if (r && r.lookKey !== lookKey(ch)) {
          scene.remove(r.g);
          disposeRig(r);
          r = undefined;
        }
        if (!r) {
          r = buildRig(ch);
          r.g.rotation.y = 0;
          rigs.set(ch.id, r);
          scene.add(r.g);
        }
      }
      for (const id of left) {
        if (!seen.has(id)) {
          left.delete(id);
          officeState.leavingIds.delete(id);
        }
      }
      for (const [id, r] of rigs) {
        if (!seen.has(id)) {
          scene.remove(r.g);
          disposeRig(r);
          rigs.delete(id);
        }
      }
    };

    const placeCamera = () => {
      const R = cam.dist / cam.zoom;
      camera.position.set(
        cam.target.x + Math.cos(cam.el) * Math.sin(cam.az) * R,
        cam.target.y + Math.sin(cam.el) * R,
        cam.target.z + Math.cos(cam.el) * Math.cos(cam.az) * R,
      );
      camera.lookAt(cam.target);
    };

    const resize = () => {
      const w = host.clientWidth,
        h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    // Overlays (tool labels, chat peeks, badges) ask here where a character is.
    const v = new THREE.Vector3();
    setScreen3D((worldX, worldY, rise) => {
      v.set(
        worldX / OFFICE3D_PX_PER_M,
        rise * OFFICE3D_RISE_M_PER_PX,
        worldY / OFFICE3D_PX_PER_M,
      ).project(camera);
      return { x: (v.x * 0.5 + 0.5) * host.clientWidth, y: (-v.y * 0.5 + 0.5) * host.clientHeight };
    });

    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    pickRef.current = (clientX, clientY) => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      ray.setFromCamera(ndc, camera);
      const hits = ray.intersectObjects(
        [...rigs.values()].filter((r) => r.g.userData.agentId !== undefined).map((r) => r.g),
        true,
      );
      for (const h of hits) {
        let o: THREE.Object3D | null = h.object;
        while (o && o.userData.agentId === undefined) o = o.parent;
        const id = o?.userData.agentId as number | undefined;
        if (id !== undefined && officeState.characters.has(id)) return id;
      }
      return null;
    };

    // e2e: find a character on screen without hunting pixels.
    if (isE2E) {
      const hooks = (window.__pixelAgentsTestHooks ??= {});
      hooks.standupNow3D = () => director.standupNow();
      hooks.meeting3D = () => director.meeting?.title ?? null;
      hooks.screenOf3D = (id) => {
        const r = rigs.get(id);
        if (!r) return null;
        const rect = renderer.domElement.getBoundingClientRect();
        v.set(r.g.position.x, r.height * 0.55, r.g.position.z).project(camera);
        return {
          x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
          y: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
        };
      };
    }

    // Pointer: left-drag turns, right/middle-drag pans, wheel zooms, a still click picks.
    let drag: { x: number; y: number; button: number; moved: boolean } | null = null;
    const el = renderer.domElement;
    const onDown = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, button: e.button, moved: false };
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) {
        officeState.hoveredAgentId = pickRef.current(e.clientX, e.clientY);
        el.style.cursor = officeState.hoveredAgentId === null ? 'grab' : 'pointer';
        return;
      }
      const dx = e.clientX - drag.x,
        dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < OFFICE3D_DRAG_SLOP_PX) return;
      drag.moved = true;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.button === 0) {
        cam.az -= dx * 0.008;
        cam.el = Math.min(OFFICE3D_TILT_MAX, Math.max(OFFICE3D_TILT_MIN, cam.el + dy * 0.005));
      } else {
        const k = (cam.dist / cam.zoom) * 0.0016;
        const right = new THREE.Vector3(Math.cos(cam.az), 0, -Math.sin(cam.az));
        const fwd = new THREE.Vector3(-Math.sin(cam.az), 0, -Math.cos(cam.az));
        cam.goal.addScaledVector(right, -dx * k).addScaledVector(fwd, dy * k);
        officeState.cameraFollowId = null;
      }
    };
    const onUp = (e: PointerEvent) => {
      const d = drag;
      drag = null;
      if (!d || d.moved || d.button !== 0) return;
      const hit = pickRef.current(e.clientX, e.clientY);
      if (hit !== null) {
        officeState.dismissBubble(hit);
        if (officeState.selectedAgentId === hit) {
          officeState.selectedAgentId = null;
          officeState.cameraFollowId = null;
        } else {
          officeState.selectedAgentId = hit;
          officeState.cameraFollowId = hit;
        }
        dropRef.current.onClick(hit);
        return;
      }
      officeState.selectedAgentId = null;
      officeState.cameraFollowId = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cam.zoom = Math.min(
        OFFICE3D_ZOOM_MAX,
        Math.max(OFFICE3D_ZOOM_MIN, cam.zoom * Math.exp(-e.deltaY * 0.0012)),
      );
    };
    const onLeave = () => {
      if (!drag) officeState.hoveredAgentId = null;
    };
    const noMenu = (e: Event) => e.preventDefault();
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('contextmenu', noMenu);

    // Frame loop: the office state advances here, as the pixel canvas does.
    let raf = 0;
    let last = 0;
    let time = 0;
    const screenOn = new THREE.MeshBasicMaterial({ color: C.screenOn });
    const screenOff = new THREE.MeshBasicMaterial({ color: C.screen });
    const frame = (now: number) => {
      const dt = last === 0 ? 0 : Math.min((now - last) / 1000, MAX_DELTA_TIME_SEC);
      last = now;
      time += dt;
      officeState.update(dt);
      rebuild();
      // Closed from the office: hand the rig to a leaver that walks it out.
      for (const ch of officeState.getCharacters()) {
        if (ch.matrixEffect !== 'despawn' || !officeState.leavingIds.has(ch.id)) continue;
        const r = rigs.get(ch.id);
        if (!r || left.has(ch.id)) continue;
        rigs.delete(ch.id);
        left.add(ch.id);
        leavers.push(
          startLeaving(
            ch.id,
            r,
            ch,
            office?.door ?? null,
            officeState.tileMap,
            officeState.blockedTiles,
          ),
        );
      }
      syncRigs();
      for (let i = leavers.length - 1; i >= 0; i--) {
        if (!stepLeaver(leavers[i], office?.door ?? null, dt, time, scene)) leavers.splice(i, 1);
      }
      director.update(dt, office, officeState.leavingIds);

      const want = nightWanted(nightRef.current) ? 1 : 0;
      const k =
        nightK < 0
          ? want
          : nightK + Math.sign(want - nightK) * Math.min(Math.abs(want - nightK), dt * 0.8);
      if (k !== nightK) {
        nightK = k;
        applyNight(scene, night, k);
      }

      for (const ch of officeState.getCharacters()) {
        const r = rigs.get(ch.id);
        if (!r) continue;
        const f = Math.min(1, ch.matrixEffectTimer / MATRIX_EFFECT_DURATION_SEC);
        const grow = ch.matrixEffect === 'spawn' ? f : ch.matrixEffect === 'despawn' ? 1 - f : 1;
        poseRig(r, ch, dt, time, grow);
        updateBurn(r, ch.burnLevel ?? 0, dt);
      }

      // What the overlay draws this frame: bubbles, goodbyes, the meeting.
      const items: OverlayItem[] = [];
      const at = (x: number, y: number, z: number) => {
        v.set(x, y, z).project(camera);
        return {
          x: (v.x * 0.5 + 0.5) * host.clientWidth,
          y: (-v.y * 0.5 + 0.5) * host.clientHeight,
        };
      };
      const mt = director.meeting;
      for (const ch of officeState.getCharacters()) {
        const r = rigs.get(ch.id);
        if (!r) continue;
        const kind =
          ch.bubbleType === 'permission'
            ? 'ask'
            : ch.bubbleType === 'waiting'
              ? 'done'
              : mt?.speaker === ch.id
                ? 'talk'
                : null;
        if (kind)
          items.push({
            key: `b${ch.id}`,
            kind,
            ...at(r.g.position.x, r.height + 0.35, r.g.position.z),
          });
      }
      for (const L of leavers) {
        if (L.say)
          items.push({
            key: `l${L.id}`,
            kind: 'say',
            text: L.say,
            ...at(L.rig.g.position.x, L.rig.height + 0.35, L.rig.g.position.z),
          });
      }
      if (mt) {
        items.push({
          key: 'meet',
          kind: 'meet',
          text: mt.title,
          ...at(mt.table.col + mt.table.w / 2, 1.5, mt.table.row + mt.table.h / 2),
        });
      }
      overlayRef.current = items;

      // Screens light up in front of whoever is typing.
      if (office) {
        for (const [key, scr] of office.screens) {
          const [c, rw] = key.split(',').map(Number);
          const on = officeState
            .getCharacters()
            .some(
              (ch) =>
                ch.state === CharacterState.TYPE &&
                Math.hypot(
                  ch.x / OFFICE3D_PX_PER_M - (c + 0.5),
                  ch.y / OFFICE3D_PX_PER_M - (rw + 0.5),
                ) < 1.8,
            );
          scr.material = on ? screenOn : screenOff;
        }
      }

      const focus = officeState.selectedAgentId ?? officeState.hoveredAgentId;
      const fr = focus !== null ? rigs.get(focus) : undefined;
      ring.visible = !!fr;
      if (fr) ring.position.set(fr.g.position.x, 0.02, fr.g.position.z);

      const follow =
        officeState.cameraFollowId !== null ? rigs.get(officeState.cameraFollowId) : undefined;
      if (follow) cam.goal.set(follow.g.position.x, 0, follow.g.position.z);
      cam.target.lerp(cam.goal, Math.min(1, dt * 3));
      placeCamera();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      setScreen3D(null);
      ro.disconnect();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('contextmenu', noMenu);
      for (const r of rigs.values()) disposeRig(r);
      if (office) disposeGroup(office.group);
      renderer.dispose();
      host.removeChild(el);
      pickRef.current = () => null;
    };
  }, [officeState]);

  // Whiteboard pins, workflow cards and desk cards dropped on a character.
  const kindOf = (e: React.DragEvent): DragKind | null => {
    const d = dropRef.current;
    if (d.onPinDrop && e.dataTransfer.types.includes(PIN_DRAG_MIME)) return 'pin';
    if (d.onWorkflowDrop && e.dataTransfer.types.includes(WORKFLOW_DRAG_MIME)) return 'workflow';
    if (d.onCardDrop && e.dataTransfer.types.includes(DESK_CARD_DRAG_MIME)) return 'card';
    return null;
  };
  const targetOf = (e: React.DragEvent): number | null => {
    const hit = pickRef.current(e.clientX, e.clientY);
    if (hit === null) return null;
    // A sub-agent shares its parent's session: the drop goes to the parent.
    return officeState.subagentMeta.get(hit)?.parentAgentId ?? hit;
  };

  const cycleNight = () => {
    const next: NightMode = nightMode === 'auto' ? 'night' : nightMode === 'night' ? 'day' : 'auto';
    setNightMode(next);
    try {
      localStorage.setItem(OFFICE3D_NIGHT_KEY, next);
    } catch {
      /* not remembered, still switched */
    }
  };

  return (
    <>
      <div
        ref={hostRef}
        className="absolute inset-0"
        onDragOver={(e) => {
          const kind = kindOf(e);
          if (!kind) return;
          e.preventDefault();
          const target = targetOf(e);
          officeState.hoveredAgentId = target;
          e.dataTransfer.dropEffect = target === null ? 'none' : kind === 'card' ? 'move' : 'copy';
        }}
        onDragLeave={() => {
          officeState.hoveredAgentId = null;
        }}
        onDrop={(e) => {
          const kind = kindOf(e);
          const target = targetOf(e);
          officeState.hoveredAgentId = null;
          if (!kind || target === null) return;
          const mime =
            kind === 'pin'
              ? PIN_DRAG_MIME
              : kind === 'card'
                ? DESK_CARD_DRAG_MIME
                : WORKFLOW_DRAG_MIME;
          const id = e.dataTransfer.getData(mime);
          if (!id) return;
          e.preventDefault();
          const d = dropRef.current;
          if (kind === 'pin') d.onPinDrop?.(target, id);
          else if (kind === 'card') d.onCardDrop?.(target, id);
          else d.onWorkflowDrop?.(target, id);
        }}
      />
      <Overlay3D itemsRef={overlayRef} />
      <div className="absolute top-8 left-8 z-10">
        <Button
          type="button"
          size="sm"
          onClick={cycleNight}
          title="Day, night, or follow the clock"
          data-testid="office3d-night"
        >
          {nightMode === 'auto'
            ? 'Time: clock'
            : nightMode === 'night'
              ? 'Time: night'
              : 'Time: day'}
        </Button>
      </div>
    </>
  );
}

type NightMode = 'auto' | 'day' | 'night';

function nightWanted(mode: NightMode): boolean {
  if (mode !== 'auto') return mode === 'night';
  const h = new Date().getHours();
  return h >= OFFICE3D_NIGHT_FROM_HOUR || h < OFFICE3D_NIGHT_TO_HOUR;
}

interface OverlayItem {
  key: string;
  kind: 'ask' | 'done' | 'talk' | 'say' | 'meet';
  text?: string;
  x: number;
  y: number;
}

const BUBBLE_CLASS: Record<OverlayItem['kind'], string> = {
  ask: 'bg-status-permission text-bg-dark px-6 font-bold',
  done: 'bg-status-success text-bg-dark px-6 font-bold',
  talk: 'bg-board text-board-ink px-6',
  say: 'bg-board text-board-ink px-8',
  meet: 'bg-bg-dark text-text px-8 border-accent',
};

/** Bubbles and labels over the 3D office, redrawn every frame from the scene. */
function Overlay3D({ itemsRef }: { itemsRef: React.RefObject<OverlayItem[]> }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setTick((n) => (n + 1) % 1_000_000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {itemsRef.current.map((it) => (
        <div
          key={it.key}
          className={`absolute -translate-x-1/2 -translate-y-full py-1 text-sm whitespace-nowrap border-2 border-border shadow-pixel ${BUBBLE_CLASS[it.kind]}`}
          style={{ left: it.x, top: it.y }}
          data-testid={`office3d-${it.kind}`}
        >
          {it.kind === 'ask'
            ? '…'
            : it.kind === 'done'
              ? '✓'
              : it.kind === 'talk'
                ? '···'
                : it.text}
        </div>
      ))}
    </div>
  );
}
