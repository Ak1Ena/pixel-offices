/**
 * The office in 3D (Soft Dollhouse). Same OfficeState, same clicks and drops as
 * the pixel canvas; only the drawing differs. Loaded lazily, so viewers who keep
 * the pixel view never download Three.js.
 */

import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

import { agentColor } from '../agentStatus.js';
import { LookModal } from '../components/LookModal.js';
import { Button } from '../components/ui/Button.js';
import {
  DESK_CARD_DRAG_MIME,
  MATRIX_EFFECT_DURATION_SEC,
  MAX_DELTA_TIME_SEC,
  OFFICE3D_CAMERA_SPAN_K,
  OFFICE3D_COLORS as C,
  OFFICE3D_DRAG_SLOP_PX,
  OFFICE3D_FOV,
  OFFICE3D_GROW_STEP,
  OFFICE3D_HEMI_INTENSITY,
  OFFICE3D_KEY_PAN_K,
  OFFICE3D_KEY_TURN_RAD,
  OFFICE3D_KEY_ZOOM_K,
  OFFICE3D_NIGHT_FROM_HOUR,
  OFFICE3D_NIGHT_KEY,
  OFFICE3D_NIGHT_TO_HOUR,
  OFFICE3D_PX_PER_M,
  OFFICE3D_RISE_M_PER_PX,
  OFFICE3D_SCROLL_PAN_K,
  OFFICE3D_SUN_INTENSITY,
  OFFICE3D_TILT_MAX,
  OFFICE3D_TILT_MIN,
  OFFICE3D_TILT_START,
  OFFICE3D_ZOOM_MAX,
  OFFICE3D_ZOOM_MIN,
  PIN_DRAG_MIME,
  WORKFLOW_DRAG_MIME,
} from '../constants.js';
import type { ExpandDirection } from '../office/editor/editorActions.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { isWalkable } from '../office/layout/tileMap.js';
import { setScreen3D } from '../office/projection.js';
import type { OfficeLayout } from '../office/types.js';
import { CharacterState } from '../office/types.js';
import { isE2E } from '../runtime.js';
import { Avatar, DEFAULT_AVATAR_LOOK, loadAvatarLook, saveAvatarLook } from './avatar.js';
import { buildOffice, disposeGroup, type OfficeMeshes } from './build.js';
import { buildRig, disposeRig, lookKey, poseRig, type Rig } from './characters3d.js';
import { applyDesignColors } from './colorMode.js';
import { type Edit3DProps, Editor3D, isPaintTool } from './editor3d.js';
import {
  applyNight,
  buildLamps,
  buildPet,
  type Leaver,
  type NightRig,
  type PetRig,
  posePet,
  startLeaving,
  stepLeaver,
  updateBurn,
} from './life.js';
import { MEETING_LENGTH_SEC, MeetingDirector } from './meetings.js';

export interface Office3DViewProps {
  officeState: OfficeState;
  onClick: (agentId: number) => void;
  onPinDrop?: (agentId: number, pinId: string) => void;
  onWorkflowDrop?: (agentId: number, workflowId: string) => void;
  onCardDrop?: (agentId: number, taskId: string) => void;
  /** Name tag for an agent (name, what it is doing, status); null = no tag. */
  tagOf?: (id: number) => { name: string; activity: string; status: TagStatus } | null;
  /** The layout editor, driven from the 3D view while edit mode is on. */
  edit?: Edit3DProps & {
    onRotateSelected: () => void;
    onDeleteSelected: () => void;
    /** Grow the map by a few tiles on one side (new tiles are empty land). */
    onGrow: (dir: ExpandDirection) => void;
  };
}

type DragKind = 'pin' | 'workflow' | 'card';

export default function Office3DView({
  officeState,
  onClick,
  onPinDrop,
  onWorkflowDrop,
  onCardDrop,
  edit,
  tagOf,
}: Office3DViewProps) {
  const editRef = useRef(edit);
  editRef.current = edit;
  const tagOfRef = useRef(tagOf);
  tagOfRef.current = tagOf;
  const directorRef = useRef<MeetingDirector | null>(null);
  const [meetOpen, setMeetOpen] = useState(false);
  const editUiRef = useRef<EditUi>({ sel: null, grow: [] });
  const hostRef = useRef<HTMLDivElement>(null);
  const pickRef = useRef<(clientX: number, clientY: number) => number | null>(() => null);
  const dropRef = useRef({ onPinDrop, onWorkflowDrop, onCardDrop, onClick });
  const overlayRef = useRef<OverlayItem[]>([]);
  /** Seconds to the next stand-up, or the meeting on now (for the clock). */
  const nextMeetRef = useRef<{ now: string | null; inSec: number | null }>({
    now: null,
    inSec: null,
  });
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
  /** Walk mode: the keys and floor clicks move your character, the camera follows. */
  const [walk, setWalk] = useState(false);
  const walkRef = useRef(walk);
  walkRef.current = walk;
  const [avatarLook, setAvatarLook] = useState(loadAvatarLook);
  const [lookOpen, setLookOpen] = useState(false);
  const avatarRef = useRef<Avatar | null>(null);
  /** Keys held down, and camera-pad buttons held (same names: KeyW, ArrowUp, …). */
  const keysRef = useRef(new Set<string>());
  const homeRef = useRef<() => void>(() => {});

  useEffect(() => {
    avatarRef.current?.setLook(avatarLook);
  }, [avatarLook]);

  // Camera keys: WASD / arrows move (or walk), Q/E turn, +/- zoom, F frames the office.
  useEffect(() => {
    const keys = keysRef.current;
    const typing = (e: KeyboardEvent) =>
      e.metaKey ||
      e.ctrlKey ||
      e.altKey ||
      !!(e.target as HTMLElement | null)?.closest?.(
        'input, textarea, select, [contenteditable="true"]',
      );
    const onDown = (e: KeyboardEvent) => {
      if (typing(e) || !CAMERA_KEYS.has(e.code)) return;
      if (e.code === 'KeyF') {
        homeRef.current();
        return;
      }
      keys.add(e.code);
      if (e.code.startsWith('Arrow')) e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => keys.delete(e.code);
    const clear = () => keys.clear();
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', clear);
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    applyDesignColors(renderer);
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
      el: OFFICE3D_TILT_START,
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
    let fitted: { span: number; cx: number; cz: number } | null = null;
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
      night.bulbs = [...lit.bulbs, ...office.outdoorBulbs];
      director.end();
      const b = office.bounds;
      const cx = (b.x0 + b.x1) / 2,
        cz = (b.z0 + b.z1) / 2,
        span = Math.max(b.x1 - b.x0, b.z1 - b.z0);
      // Frame the office when it first shows and whenever it changes shape a lot
      // (a new layout); a painted tile or a moved chair keeps the camera put.
      const moved =
        !fitted ||
        Math.abs(span - fitted.span) > 3 ||
        Math.hypot(cx - fitted.cx, cz - fitted.cz) > 3;
      if (moved) {
        fitted = { span, cx, cz };
        cam.goal.set(cx, 0, cz);
        cam.target.copy(cam.goal);
        cam.dist = span * OFFICE3D_CAMERA_SPAN_K + 6;
        cam.zoom = 1;
      }
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
    directorRef.current = director;
    const editor = new Editor3D(scene, officeState);
    const leavers: Leaver[] = [];
    const avatar = new Avatar(scene, avatarRef.current?.look ?? loadAvatarLook());
    avatarRef.current = avatar;
    const nav = () => ({ tileMap: officeState.tileMap, blockedTiles: officeState.blockedTiles });
    /** Put the avatar at the door the first time, and again whenever the
     *  floor under it stops being floor (a layout change). */
    const standAvatar = () => {
      const t = avatar.tile;
      const n = nav();
      if (avatar.isPlaced && isWalkable(t.col, t.row, n.tileMap, n.blockedTiles)) return;
      const d = office?.door?.inside;
      if (d && isWalkable(d.col, d.row, n.tileMap, n.blockedTiles)) avatar.placeAt(d.col, d.row);
      else {
        const any = officeState.walkableTiles[0];
        if (any) avatar.placeAt(any.col, any.row);
      }
    };
    /** Characters whose rig became a leaver: never re-created while they despawn. */
    const left = new Set<number>();

    const rigs = new Map<number, Rig>();
    const petRigs = new Map<string, PetRig>();
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

    homeRef.current = () => {
      if (!fitted) return;
      cam.goal.set(fitted.cx, 0, fitted.cz);
      cam.zoom = 1;
      cam.az = Math.PI / 4;
      cam.el = OFFICE3D_TILT_START;
      officeState.cameraFollowId = null;
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
      hooks.screenOfTile3D = (col, row, y = 0) => {
        const rect = renderer.domElement.getBoundingClientRect();
        v.set(col + 0.5, y, row + 0.5).project(camera);
        return {
          x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
          y: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
        };
      };
      hooks.meeting3D = () => director.meeting?.title ?? null;
      hooks.avatar3D = () => ({ x: avatar.x, z: avatar.z });
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
    // Which tile is under the pointer: the first office surface the ray hits
    // (a wall top counts as the wall's tile), else the ground plane — so
    // pointing past the edge of the map names a tile outside it.
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hitV = new THREE.Vector3();
    const tileAt = (clientX: number, clientY: number): { col: number; row: number } | null => {
      const rect = el.getBoundingClientRect();
      ndc.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      ray.setFromCamera(ndc, camera);
      const hits = office ? ray.intersectObject(office.group, true) : [];
      const h = hits.find((x) => x.object.type !== 'Sprite');
      if (h && h.point.y > -0.05 && h.face) {
        const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
        const p = h.point.clone().addScaledVector(n, -0.01);
        return { col: Math.floor(p.x), row: Math.floor(p.z) };
      }
      if (!ray.ray.intersectPlane(ground, hitV)) return null;
      return { col: Math.floor(hitV.x), row: Math.floor(hitV.z) };
    };

    // Pointer: left-drag turns, right/middle-drag pans, wheel zooms, a still click picks.
    // While editing: left = the tool, shift-left or middle turns, right erases (paint tools) or pans.
    let drag: {
      x: number;
      y: number;
      button: number;
      moved: boolean;
      mode: 'orbit' | 'pan' | 'edit' | 'pick';
    } | null = null;
    const el = renderer.domElement;
    const onDown = (e: PointerEvent) => {
      const ed = editRef.current;
      let mode: 'orbit' | 'pan' | 'edit' | 'pick' = e.button === 0 ? 'pick' : 'pan';
      if (ed?.isEditMode) {
        if (e.button === 1 || (e.button === 0 && e.shiftKey)) mode = 'orbit';
        else if (e.button === 2 && !isPaintTool(ed.editorState.activeTool)) mode = 'pan';
        else {
          mode = 'edit';
          editor.down(ed, tileAt(e.clientX, e.clientY), e.button);
        }
      }
      drag = { x: e.clientX, y: e.clientY, button: e.button, moved: false, mode };
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      const ed = editRef.current;
      if (ed?.isEditMode && (!drag || drag.mode === 'edit')) {
        editor.move(ed, tileAt(e.clientX, e.clientY));
        el.style.cursor = ed.editorState.isDragMoving ? 'grabbing' : 'crosshair';
        if (!drag) return;
      }
      if (!drag) {
        officeState.hoveredAgentId = pickRef.current(e.clientX, e.clientY);
        el.style.cursor = officeState.hoveredAgentId === null ? 'grab' : 'pointer';
        return;
      }
      if (drag.mode === 'edit') return;
      const dx = e.clientX - drag.x,
        dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < OFFICE3D_DRAG_SLOP_PX) return;
      drag.moved = true;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.mode === 'orbit' || drag.mode === 'pick') {
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
      const ed = editRef.current;
      if (d?.mode === 'edit' && ed) {
        editor.up(ed, d.button);
        return;
      }
      if (!d || d.moved || d.mode !== 'pick') return;
      const hit = pickRef.current(e.clientX, e.clientY);
      if (walkRef.current) {
        // Walking: go to the clicked spot, or up to the clicked agent.
        const ch = hit !== null ? officeState.characters.get(hit) : undefined;
        if (ch) avatar.goNear(ch.tileCol, ch.tileRow, nav());
        else {
          const t = tileAt(e.clientX, e.clientY);
          // Furniture or a wall: walk up next to it instead.
          if (t && !avatar.goTo(t.col, t.row, nav())) avatar.goNear(t.col, t.row, nav());
        }
      }
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
    const zoomBy = (f: number) => {
      cam.zoom = Math.min(OFFICE3D_ZOOM_MAX, Math.max(OFFICE3D_ZOOM_MIN, cam.zoom * f));
    };
    const panBy = (sideM: number, fwdM: number) => {
      cam.goal.x += Math.cos(cam.az) * sideM - Math.sin(cam.az) * fwdM;
      cam.goal.z += -Math.sin(cam.az) * sideM - Math.cos(cam.az) * fwdM;
      officeState.cameraFollowId = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Pinch (ctrl + wheel) and a mouse wheel zoom; a trackpad's two-finger
      // scroll (pixel deltas, sideways or fractional) moves the camera.
      const trackpad =
        !e.ctrlKey &&
        e.deltaMode === 0 &&
        (e.deltaX !== 0 || !Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 40);
      if (trackpad && !walkRef.current) {
        const k = (cam.dist / cam.zoom) * OFFICE3D_SCROLL_PAN_K;
        panBy(e.deltaX * k, -e.deltaY * k);
        return;
      }
      zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0012)));
    };
    const onLeave = () => {
      if (!drag) officeState.hoveredAgentId = null;
      const ed = editRef.current;
      if (ed?.isEditMode && !drag) editor.leave(ed);
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
    const scrPos = new THREE.Vector3();
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
      nextMeetRef.current = { now: director.meeting?.title ?? null, inSec: director.nextIn() };

      const want = nightWanted(nightRef.current) ? 1 : 0;
      const k =
        nightK < 0
          ? want
          : nightK + Math.sign(want - nightK) * Math.min(Math.abs(want - nightK), dt * 0.8);
      if (k !== nightK) {
        nightK = k;
        applyNight(scene, night, k);
      }

      // Pets wander the office too.
      const petSeen = new Set<string>();
      for (const pet of officeState.getPets()) {
        petSeen.add(pet.id);
        let pr = petRigs.get(pet.id);
        if (!pr) {
          pr = buildPet(pet.petType);
          petRigs.set(pet.id, pr);
          scene.add(pr.g);
        }
        posePet(pr, pet, dt, time);
      }
      for (const [id, pr] of petRigs) {
        if (petSeen.has(id)) continue;
        scene.remove(pr.g);
        disposeGroup(pr.g);
        petRigs.delete(id);
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
        const above = at(r.g.position.x, r.height + 0.3, r.g.position.z);
        // Name tags for everyone, except whoever the tool panel is showing.
        const tag =
          ch.id !== officeState.selectedAgentId &&
          ch.id !== officeState.hoveredAgentId &&
          !ch.matrixEffect
            ? tagOfRef.current?.(ch.id)
            : null;
        if (tag) {
          items.push({
            key: `t${ch.id}`,
            kind: 'tag',
            text: tag.name,
            sub: tag.activity,
            status: tag.status,
            ...above,
          });
        }
        if (kind) items.push({ key: `b${ch.id}`, kind, ...above, y: above.y - (tag ? 30 : 0) });
      }
      const youAt = at(avatar.x, avatar.rig.height + 0.3, avatar.z);
      if (avatar.isPlaced && Number.isFinite(youAt.x) && Number.isFinite(youAt.y))
        items.push({ key: 'you', kind: 'you', text: 'You', ...youAt });
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

      // Editor previews and the buttons that float over the map.
      const ed = editRef.current;
      editor.update(ed ?? null);
      const anchor = editor.selectedAnchor(ed ?? null);
      const L = officeState.getLayout();
      editUiRef.current = {
        sel: anchor ? at(anchor.x, anchor.y, anchor.z) : null,
        grow: ed?.isEditMode
          ? (
              [
                ['left', -0.6, L.rows / 2],
                ['right', L.cols + 0.6, L.rows / 2],
                ['up', L.cols / 2, -0.6],
                ['down', L.cols / 2, L.rows + 0.6],
              ] as Array<[ExpandDirection, number, number]>
            ).map(([dir, x, z]) => ({ dir, ...at(x, 0, z) }))
          : [],
      };

      // Screens light up in front of whoever is typing.
      if (office) {
        const typing = officeState
          .getCharacters()
          .filter((ch) => ch.state === CharacterState.TYPE)
          .map((ch) => [ch.x / OFFICE3D_PX_PER_M, ch.y / OFFICE3D_PX_PER_M]);
        for (const scr of office.screens.values()) {
          scr.getWorldPosition(scrPos);
          const on = typing.some(([x, z]) => Math.hypot(x - scrPos.x, z - scrPos.z) < 1.4);
          scr.material = on ? screenOn : screenOff;
        }
      }

      const focus = officeState.selectedAgentId ?? officeState.hoveredAgentId;
      const fr = focus !== null ? rigs.get(focus) : undefined;
      ring.visible = !!fr;
      if (fr) ring.position.set(fr.g.position.x, 0.02, fr.g.position.z);

      // Keys and the camera pad: move (or walk), turn, zoom.
      const keys = keysRef.current;
      const held = (...codes: string[]) => (codes.some((c) => keys.has(c)) ? 1 : 0);
      const fwd = held('KeyW', 'ArrowUp') - held('KeyS', 'ArrowDown');
      const side = held('KeyD', 'ArrowRight') - held('KeyA', 'ArrowLeft');
      const turn = held('KeyE') - held('KeyQ');
      const zoomDir = held('Equal', 'NumpadAdd') - held('Minus', 'NumpadSubtract');
      if (turn) cam.az -= turn * OFFICE3D_KEY_TURN_RAD * dt;
      if (zoomDir) zoomBy(Math.exp(zoomDir * Math.log(OFFICE3D_KEY_ZOOM_K) * dt));
      standAvatar();
      const walking = walkRef.current;
      let steer = { x: 0, z: 0 };
      if (fwd || side) {
        const n = Math.hypot(fwd, side);
        const sx = Math.cos(cam.az) * side - Math.sin(cam.az) * fwd;
        const sz = -Math.sin(cam.az) * side - Math.cos(cam.az) * fwd;
        if (walking) steer = { x: sx / n, z: sz / n };
        else {
          const k = (cam.dist / cam.zoom) * OFFICE3D_KEY_PAN_K * dt;
          panBy((side / n) * k, (fwd / n) * k);
        }
      }
      avatar.update(steer, dt, time, nav());
      if (walking) {
        officeState.cameraFollowId = null;
        cam.goal.set(avatar.x, 0, avatar.z);
      }

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
      editor.dispose();
      ro.disconnect();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('contextmenu', noMenu);
      for (const r of rigs.values()) disposeRig(r);
      avatar.dispose();
      avatarRef.current = null;
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
      {edit?.isEditMode && <EditButtons3D uiRef={editUiRef} edit={edit} />}
      {!edit?.isEditMode && (
        <MeetingButton
          directorRef={directorRef}
          open={meetOpen}
          onToggle={() => setMeetOpen((v) => !v)}
        />
      )}
      {meetOpen && !edit?.isEditMode && (
        <MeetingPanel
          directorRef={directorRef}
          officeState={officeState}
          tagOf={tagOf}
          onClose={() => setMeetOpen(false)}
        />
      )}
      {!edit?.isEditMode && (
        <ClockPanel nightMode={nightMode} onCycle={cycleNight} nextMeetRef={nextMeetRef} />
      )}
      <CameraPad
        keysRef={keysRef}
        walk={walk}
        onWalk={() => setWalk((w) => !w)}
        onHome={() => homeRef.current()}
        onLook={() => setLookOpen(true)}
        lookColor={avatarLook.shirt}
      />
      <LookModal
        agentName={lookOpen ? 'You' : null}
        title="Your look"
        current={avatarLook}
        onSave={(look) => {
          const next = look ?? DEFAULT_AVATAR_LOOK;
          setAvatarLook(next);
          saveAvatarLook(next);
          setLookOpen(false);
        }}
        onClose={() => setLookOpen(false)}
      />
    </>
  );
}

type NightMode = 'auto' | 'day' | 'night';

const CAMERA_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'KeyQ',
  'KeyE',
  'Equal',
  'Minus',
  'NumpadAdd',
  'NumpadSubtract',
  'KeyF',
]);

/** A camera-pad button: held down, it acts like holding its key. */
function HoldButton({
  code,
  keysRef,
  label,
  children,
}: {
  code: string;
  keysRef: React.RefObject<Set<string>>;
  label: string;
  children: React.ReactNode;
}) {
  const release = () => keysRef.current.delete(code);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="w-28 h-28 grid place-items-center rounded-ui text-text-muted hover:text-text hover:bg-btn-hover cursor-pointer select-none"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        keysRef.current.add(code);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      {children}
    </button>
  );
}

/** Bottom-right: your character (Walk, look) and the camera (move, turn, zoom, frame). */
function CameraPad({
  keysRef,
  walk,
  onWalk,
  onHome,
  onLook,
  lookColor,
}: {
  keysRef: React.RefObject<Set<string>>;
  walk: boolean;
  onWalk: () => void;
  onHome: () => void;
  onLook: () => void;
  lookColor: string;
}) {
  const hint = walk
    ? 'Walking: WASD / arrows or click the floor · Q/E turn'
    : 'Drag to turn · Right-drag or two fingers to move · WASD / arrows · Q/E · +/-';
  return (
    <div
      className="absolute bottom-12 right-12 z-20 flex flex-col items-end gap-6"
      data-testid="office3d-camera-pad"
    >
      <span className="hidden xl:block px-10 py-4 rounded-full bg-bg/80 text-2xs text-text-muted">
        {hint}
      </span>
      <div className="flex items-center gap-4 p-6 pixel-panel">
        <button
          type="button"
          onClick={onLook}
          title="Change your look"
          aria-label="Change your look"
          className="w-28 h-28 rounded-full grid place-items-center text-2xs font-bold text-white cursor-pointer border-2 border-border hover:border-accent"
          style={{ background: lookColor }}
          data-testid="office3d-you-look"
        >
          You
        </button>
        <button
          type="button"
          onClick={onWalk}
          aria-pressed={walk}
          title={walk ? 'Stop walking (the camera moves freely)' : 'Walk around as you'}
          className={`h-28 px-10 rounded-ui text-xs font-semibold cursor-pointer border ${
            walk
              ? 'bg-accent text-accent-ink border-accent'
              : 'bg-btn-bg text-text border-border hover:bg-btn-hover'
          }`}
          data-testid="office3d-walk"
        >
          {walk ? 'Walking' : 'Walk'}
        </button>
        <div className="hidden xl:flex items-center gap-4">
          <span className="w-1 h-20 bg-border mx-2" />
          <HoldButton code="KeyQ" keysRef={keysRef} label="Turn left (Q)">
            ⟲
          </HoldButton>
          <HoldButton code="ArrowLeft" keysRef={keysRef} label="Left (A / ←)">
            ←
          </HoldButton>
          <div className="flex flex-col">
            <HoldButton code="ArrowUp" keysRef={keysRef} label="Forward (W / ↑)">
              ↑
            </HoldButton>
            <HoldButton code="ArrowDown" keysRef={keysRef} label="Back (S / ↓)">
              ↓
            </HoldButton>
          </div>
          <HoldButton code="ArrowRight" keysRef={keysRef} label="Right (D / →)">
            →
          </HoldButton>
          <HoldButton code="KeyE" keysRef={keysRef} label="Turn right (E)">
            ⟳
          </HoldButton>
          <span className="w-1 h-20 bg-border mx-2" />
          <HoldButton code="Minus" keysRef={keysRef} label="Zoom out (-)">
            −
          </HoldButton>
          <HoldButton code="Equal" keysRef={keysRef} label="Zoom in (+)">
            +
          </HoldButton>
        </div>
        <button
          type="button"
          onClick={onHome}
          title="Show the whole office (F)"
          aria-label="Show the whole office"
          className="w-28 h-28 grid place-items-center rounded-ui text-text-muted hover:text-text hover:bg-btn-hover cursor-pointer"
          data-testid="office3d-home"
        >
          ⌂
        </button>
      </div>
    </div>
  );
}

/** Re-render every half second (panels that read the meeting as it goes). */
function useTick(ms = 500): void {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => (n + 1) % 1_000_000), ms);
    return () => clearInterval(t);
  }, [ms]);
}

function MeetingButton({
  directorRef,
  open,
  onToggle,
}: {
  directorRef: React.RefObject<MeetingDirector | null>;
  open: boolean;
  onToggle: () => void;
}) {
  useTick();
  const live = !!directorRef.current?.meeting;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={open}
      data-testid="office3d-meeting-button"
      className={`absolute top-12 right-12 z-20 flex items-center gap-8 h-36 px-14 pixel-panel cursor-pointer text-sm font-semibold ${
        open ? 'text-accent' : 'text-text'
      }`}
    >
      {live && <span className="w-8 h-8 rounded-full bg-accent animate-pulse" />}
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M3 11h18v3H3zM6 14v6M18 14v6" />
        <circle cx="8" cy="6" r="2" />
        <circle cx="16" cy="6" r="2" />
      </svg>
      {live ? 'Meeting on' : 'Meeting'}
    </button>
  );
}

const MEETING_KINDS = ['Stand-up', 'Planning', 'Review'] as const;

/** Right panel: the meeting on now (who, who is talking, time left), or start one. */
function MeetingPanel({
  directorRef,
  officeState,
  tagOf,
  onClose,
}: {
  directorRef: React.RefObject<MeetingDirector | null>;
  officeState: OfficeState;
  tagOf: Office3DViewProps['tagOf'];
  onClose: () => void;
}) {
  useTick();
  const [kind, setKind] = useState<(typeof MEETING_KINDS)[number]>('Stand-up');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const d = directorRef.current;
  const m = d?.meeting ?? null;
  const people = [...officeState.characters.values()]
    .filter((c) => !c.isSubagent && !c.isGreeter)
    .map((c) => ({
      id: c.id,
      tag: tagOf?.(c.id) ?? null,
      busy: c.isActive || c.bubbleType === 'permission',
    }));
  const name = (id: number) => people.find((p) => p.id === id)?.tag?.name ?? `Agent ${id}`;

  return (
    <section
      className="absolute right-12 top-56 z-20 w-340 max-h-[calc(100%-170px)] flex flex-col pixel-panel overflow-hidden"
      aria-label="Meeting"
      data-testid="office3d-meeting-panel"
    >
      <div className="flex items-center justify-between gap-8 px-14 pt-12 pb-8 border-b border-border">
        <span className="font-display text-lg font-medium">{m ? m.title : 'Start a meeting'}</span>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
          ×
        </Button>
      </div>
      <div className="flex flex-col gap-10 px-14 py-12 overflow-y-auto text-sm">
        {m ? (
          <>
            <div className="flex flex-col gap-4">
              <div className="flex justify-between text-2xs text-text-muted">
                <span>{m.kind === 'team' ? 'Team catch-up' : 'Meeting'} · at the table</span>
                <span>{Math.max(0, Math.ceil(MEETING_LENGTH_SEC - m.t))} s left</span>
              </div>
              <div className="h-6 rounded-full bg-bg-thumb overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full"
                  style={{ width: `${Math.min(100, (m.t / MEETING_LENGTH_SEC) * 100)}%` }}
                />
              </div>
            </div>
            <div className="text-2xs uppercase tracking-wider text-text-muted">At the table</div>
            <div className="flex flex-col gap-2">
              {m.ids.map((id) => (
                <div key={id} className="flex items-center gap-10 py-4">
                  <span
                    className="w-26 h-26 rounded-ui grid place-items-center text-xs font-semibold text-white"
                    style={{ background: agentColor(officeState, id) }}
                  >
                    {name(id).slice(0, 1).toUpperCase()}
                  </span>
                  <span className="flex-1 font-semibold">{name(id)}</span>
                  {m.speaker === id && (
                    <span className="text-2xs px-8 py-2 rounded-full bg-accent text-accent-ink font-semibold">
                      Speaking
                    </span>
                  )}
                </div>
              ))}
            </div>
            <p className="m-0 text-2xs text-text-muted">
              Anyone who gets work goes straight back to their desk. Nothing is sent to the agents.
            </p>
            <Button
              type="button"
              size="md"
              onClick={() => d?.end()}
              data-testid="office3d-meeting-end"
            >
              End meeting
            </Button>
          </>
        ) : (
          <>
            <div className="flex gap-4">
              {MEETING_KINDS.map((k) => (
                <Button
                  key={k}
                  type="button"
                  size="sm"
                  variant={k === kind ? 'active' : 'default'}
                  onClick={() => setKind(k)}
                >
                  {k}
                </Button>
              ))}
            </div>
            <div className="text-2xs uppercase tracking-wider text-text-muted">Who comes</div>
            <div className="flex flex-col gap-4">
              {people.length === 0 && (
                <span className="text-2xs text-text-muted">Nobody here yet.</span>
              )}
              {people.map((p) => (
                <label
                  key={p.id}
                  className={`flex items-center gap-10 px-8 py-6 rounded-ui border border-border ${
                    p.busy ? 'opacity-50' : 'cursor-pointer hover:bg-btn-bg'
                  }`}
                >
                  <input
                    type="checkbox"
                    disabled={p.busy}
                    checked={picked.has(p.id) && !p.busy}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(p.id);
                      else next.delete(p.id);
                      setPicked(next);
                    }}
                  />
                  <span
                    className="w-24 h-24 rounded-ui grid place-items-center text-2xs font-semibold text-white"
                    style={{ background: agentColor(officeState, p.id) }}
                  >
                    {(p.tag?.name ?? '?').slice(0, 1).toUpperCase()}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block font-semibold truncate">
                      {p.tag?.name ?? `Agent ${p.id}`}
                    </span>
                    <span className="block text-2xs text-text-muted">
                      {p.busy ? 'Working — joins when free' : 'Free'}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {error && <p className="m-0 text-2xs text-danger">{error}</p>}
            <Button
              type="button"
              size="md"
              variant="accent"
              data-testid="office3d-meeting-start"
              onClick={() => {
                const why = d?.startWith(kind, [...picked]) ?? 'The office is still loading.';
                setError(why);
                if (!why) setPicked(new Set());
              }}
            >
              Start {kind.toLowerCase()}
            </Button>
            <p className="m-0 text-2xs text-text-muted">
              Free agents walk to a table and take turns talking. It is a picture of the team
              pausing: nothing is sent to the agents.
            </p>
          </>
        )}
        <label className="flex items-center gap-8 pt-8 border-t border-border text-2xs text-text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={d?.auto ?? false}
            onChange={(e) => d?.setAuto(e.target.checked)}
            data-testid="office3d-meeting-auto"
          />
          Hold stand-ups and team catch-ups by themselves
        </label>
      </div>
    </section>
  );
}

/** Bottom-left clock: time, day or night (click to switch), the next stand-up. */
function ClockPanel({
  nightMode,
  onCycle,
  nextMeetRef,
}: {
  nightMode: NightMode;
  onCycle: () => void;
  nextMeetRef: React.RefObject<{ now: string | null; inSec: number | null }>;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const night = nightWanted(nightMode);
  const meet = nextMeetRef.current;
  const mins = Math.floor((meet.inSec ?? 0) / 60),
    secs = Math.floor((meet.inSec ?? 0) % 60);
  return (
    <button
      type="button"
      onClick={onCycle}
      title="Switch day / night / follow the clock"
      data-testid="office3d-night"
      className="absolute bottom-12 left-12 z-20 flex flex-col items-start gap-2 px-14 py-10 pixel-panel cursor-pointer text-left"
    >
      <span className="font-display text-xl font-medium text-text">
        {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>
      <span className="text-2xs text-text-muted">
        {night ? 'Night' : 'Day'}
        {nightMode === 'auto' ? ' · follows the clock' : ' · set by you'} ·{' '}
        {now.toLocaleDateString([], { weekday: 'long' })}
      </span>
      {(meet.now || meet.inSec !== null) && (
        <span className="text-2xs text-accent">
          {meet.now
            ? `Now: ${meet.now}`
            : `Next stand-up in ${mins}:${String(secs).padStart(2, '0')}`}
        </span>
      )}
    </button>
  );
}

interface EditUi {
  sel: { x: number; y: number } | null;
  grow: Array<{ dir: ExpandDirection; x: number; y: number }>;
}

const GROW_STEP_LABEL = `+${OFFICE3D_GROW_STEP}`;

/** Turn / remove over the selected item, and "+" buttons on each map edge. */
function EditButtons3D({
  uiRef,
  edit,
}: {
  uiRef: React.RefObject<EditUi>;
  edit: NonNullable<Office3DViewProps['edit']>;
}) {
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
  const ui = uiRef.current;
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {ui.sel && (
        <div
          className="absolute -translate-x-1/2 -translate-y-full flex gap-4 pointer-events-auto"
          style={{ left: ui.sel.x, top: ui.sel.y }}
        >
          <Button
            type="button"
            size="sm"
            onClick={edit.onRotateSelected}
            data-testid="edit3d-rotate"
          >
            Turn (R)
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={edit.onDeleteSelected}
            data-testid="edit3d-delete"
          >
            Remove
          </Button>
        </div>
      )}
      {ui.grow.map((g) => (
        <div
          key={g.dir}
          className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-auto"
          style={{ left: g.x, top: g.y }}
        >
          <Button
            type="button"
            size="sm"
            variant="accent"
            onClick={() => edit.onGrow(g.dir)}
            title={`Grow the map ${OFFICE3D_GROW_STEP} tiles (${g.dir})`}
            data-testid={`edit3d-grow-${g.dir}`}
          >
            {GROW_STEP_LABEL}
          </Button>
        </div>
      ))}
      <div className="absolute top-64 left-1/2 -translate-x-1/2 px-8 py-2 text-2xs bg-bg-dark text-text-muted border border-border">
        Shift-drag or middle-drag turns the view · right-drag erases (paint tools) or pans
      </div>
    </div>
  );
}

function nightWanted(mode: NightMode): boolean {
  if (mode !== 'auto') return mode === 'night';
  const h = new Date().getHours();
  return h >= OFFICE3D_NIGHT_FROM_HOUR || h < OFFICE3D_NIGHT_TO_HOUR;
}

type TagStatus = 'work' | 'perm' | 'done' | 'idle';

interface OverlayItem {
  key: string;
  kind: 'ask' | 'done' | 'talk' | 'say' | 'meet' | 'tag' | 'you';
  text?: string;
  sub?: string;
  status?: TagStatus;
  x: number;
  y: number;
}

const BUBBLE_CLASS: Record<Exclude<OverlayItem['kind'], 'tag'>, string> = {
  ask: 'bg-status-permission text-accent-ink px-8 font-bold rounded-full',
  done: 'bg-status-success text-accent-ink px-8 font-bold rounded-full',
  talk: 'bg-board text-board-ink px-10 rounded-panel border-accent',
  say: 'bg-board text-board-ink px-12 rounded-panel border-accent',
  meet: 'bg-bg text-text px-12 rounded-full border-accent',
  you: 'bg-accent text-accent-ink px-10 rounded-full border-accent font-semibold text-2xs',
};

const TAG_DOT: Record<TagStatus, string> = {
  work: 'bg-status-active',
  perm: 'bg-status-permission animate-pulse',
  done: 'bg-status-success',
  idle: 'bg-text-muted',
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
      {itemsRef.current.map((it) =>
        it.kind === 'tag' ? (
          <div
            key={it.key}
            className={`absolute -translate-x-1/2 -translate-y-full flex items-center gap-6 pl-6 pr-10 py-3 rounded-full text-board-ink text-2xs font-semibold whitespace-nowrap shadow-pixel ${
              it.status === 'perm' ? 'bg-status-permission' : 'bg-board'
            }`}
            style={{ left: it.x, top: it.y }}
            data-testid="office3d-tag"
          >
            <span className={`w-8 h-8 rounded-full ${TAG_DOT[it.status ?? 'idle']}`} />
            {it.text}
            {it.sub && it.status !== 'idle' && (
              <span className="font-mono font-normal text-board-ink-muted max-w-160 truncate">
                {it.status === 'perm' ? 'Needs you' : it.sub}
              </span>
            )}
          </div>
        ) : (
          <div
            key={it.key}
            className={`absolute -translate-x-1/2 -translate-y-full py-3 text-sm whitespace-nowrap border shadow-pixel ${BUBBLE_CLASS[it.kind]}`}
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
        ),
      )}
    </div>
  );
}
