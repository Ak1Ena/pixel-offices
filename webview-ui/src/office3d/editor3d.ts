/**
 * The layout editor in 3D. It drives the SAME editor state and actions the
 * pixel canvas does (useEditorActions: tile actions, erase, drag-move, rotate,
 * delete, undo) — only the pointer → tile mapping and the previews are 3D.
 */

import * as THREE from 'three';

import { OFFICE3D_COLORS as C, OFFICE3D_ROOM_COLORS } from '../constants.js';
import { canPlaceFurniture, getWallPlacementRow } from '../office/editor/editorActions.js';
import type { EditorState } from '../office/editor/editorState.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { getCatalogEntry } from '../office/layout/furnitureCatalog.js';
import {
  canPlaceRect,
  createRectRoom,
  nextRoomLabel,
  normalizeRect,
} from '../office/layout/rooms.js';
import type { RoomRect } from '../office/types.js';
import type { OfficeLayout, PlacedFurniture } from '../office/types.js';
import { EditTool } from '../office/types.js';
import { buildFurnitureItem, deskTilesOf } from './build.js';

export interface Edit3DProps {
  isEditMode: boolean;
  editorState: EditorState;
  onEditorTileAction: (col: number, row: number) => void;
  onEditorEraseAction: (col: number, row: number) => void;
  onEditorSelectionChange: () => void;
  onDragMove: (uid: string, newCol: number, newRow: number) => void;
  /** Commit a whole new layout as one undoable edit (drawing a team room). */
  onApplyLayout: (layout: OfficeLayout) => void;
}

const PAINT_TOOLS: ReadonlySet<string> = new Set([
  EditTool.TILE_PAINT,
  EditTool.WALL_PAINT,
  EditTool.ERASE,
  EditTool.CARPET_PAINT,
  EditTool.AREA_PAINT,
]);
/** Tools that can grow the map by painting just outside it. */
const GROW_TOOLS: ReadonlySet<string> = new Set([EditTool.TILE_PAINT, EditTool.WALL_PAINT]);

export function isPaintTool(tool: string): boolean {
  return PAINT_TOOLS.has(tool);
}

/** The furniture item on a tile, surface items (on desks) first — as the canvas picks. */
export function furnitureAt(
  layout: OfficeLayout,
  col: number,
  row: number,
): PlacedFurniture | null {
  let hit: PlacedFurniture | null = null;
  for (const f of layout.furniture) {
    const e = getCatalogEntry(f.type);
    if (!e) continue;
    if (col >= f.col && col < f.col + e.footprintW && row >= f.row && row < f.row + e.footprintH) {
      if (!hit || e.canPlaceOnSurfaces) hit = f;
    }
  }
  return hit;
}

function ghostify(g: THREE.Object3D, ok: boolean): void {
  const tintC = new THREE.Color(ok ? C.ghostOk : C.ghostBad);
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const src = m.material as THREE.MeshStandardMaterial;
    const mt = src.clone();
    mt.transparent = true;
    mt.opacity = 0.55;
    mt.depthWrite = false;
    if ('emissive' in mt) {
      mt.emissive = tintC;
      mt.emissiveIntensity = 0.7;
    }
    m.material = mt;
    m.castShadow = false;
  });
}

function disposeGhost(g: THREE.Object3D): void {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
  });
}

export class Editor3D {
  private readonly scene: THREE.Scene;
  private readonly os: OfficeState;
  private readonly root = new THREE.Group();
  private grid: THREE.LineSegments | null = null;
  private gridKey = '';
  private readonly hover: THREE.Mesh;
  private readonly selBox: THREE.LineSegments;
  private ghost: THREE.Group | null = null;
  private ghostKey = '';
  private eraseDrag = false;
  /** Team room being drawn: where the drag started and the rectangle so far. */
  private roomStart: { col: number; row: number } | null = null;
  private roomRect: RoomRect | null = null;
  private readonly roomBox: THREE.Mesh;
  /** Folder areas drawn on the floor while building (rebuilt when the layout changes). */
  private areaMesh: THREE.InstancedMesh | null = null;
  private areaLayout: OfficeLayout | null = null;

  constructor(scene: THREE.Scene, os: OfficeState) {
    this.scene = scene;
    this.os = os;
    scene.add(this.root);
    this.hover = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: C.edgeLine,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
      }),
    );
    this.hover.rotation.x = -Math.PI / 2;
    this.root.add(this.hover);
    this.selBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: C.edgeLine }),
    );
    this.root.add(this.selBox);
    this.roomBox = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1.1, 1),
      new THREE.MeshBasicMaterial({
        color: C.ghostOk,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
      }),
    );
    this.roomBox.visible = false;
    this.root.add(this.roomBox);
    this.root.visible = false;
  }

  // ── Pointer (tiles may be outside the map: a paint there grows it) ──

  down(p: Edit3DProps, tile: { col: number; row: number } | null, button: number): void {
    const es = p.editorState;
    if (!tile) return;
    if (button === 2) {
      if (!isPaintTool(es.activeTool)) return;
      const L = this.os.getLayout();
      if (tile.col >= 0 && tile.col < L.cols && tile.row >= 0 && tile.row < L.rows) {
        this.eraseDrag = true;
        p.onEditorEraseAction(tile.col, tile.row);
      }
      return;
    }
    if (es.activeTool === EditTool.ROOM) {
      this.roomStart = tile;
      this.roomRect = normalizeRect(tile, tile);
      return;
    }
    const actAsSelect =
      es.activeTool === EditTool.SELECT ||
      (es.activeTool === EditTool.FURNITURE_PLACE && es.selectedFurnitureType === '');
    if (actAsSelect) {
      const hit = furnitureAt(this.os.getLayout(), tile.col, tile.row);
      if (hit) {
        es.startDrag(hit.uid, tile.col, tile.row, tile.col - hit.col, tile.row - hit.row);
        return;
      }
      es.clearSelection();
      p.onEditorSelectionChange();
    }
    es.isDragging = true;
    p.onEditorTileAction(tile.col, tile.row);
  }

  move(p: Edit3DProps, tile: { col: number; row: number } | null): void {
    const es = p.editorState;
    if (!tile) {
      es.ghostCol = -1;
      es.ghostRow = -1;
      return;
    }
    const moved = tile.col !== es.ghostCol || tile.row !== es.ghostRow;
    es.ghostCol = tile.col;
    es.ghostRow = tile.row;
    if (
      es.dragUid &&
      !es.isDragMoving &&
      (tile.col !== es.dragStartCol || tile.row !== es.dragStartRow)
    ) {
      es.isDragMoving = true;
    }
    if (!moved) return;
    if (this.roomStart) this.roomRect = normalizeRect(this.roomStart, tile);
    if (es.isDragging && isPaintTool(es.activeTool) && !es.dragUid)
      p.onEditorTileAction(tile.col, tile.row);
    if (this.eraseDrag && isPaintTool(es.activeTool)) {
      const L = this.os.getLayout();
      if (tile.col >= 0 && tile.col < L.cols && tile.row >= 0 && tile.row < L.rows) {
        p.onEditorEraseAction(tile.col, tile.row);
      }
    }
  }

  up(p: Edit3DProps, button: number): void {
    const es = p.editorState;
    if (button === 2) {
      this.eraseDrag = false;
      es.carpetStrokeInitialLayout = null;
      es.carpetDragErasing = null;
      es.areaDragErasing = null;
      return;
    }
    if (this.roomStart) {
      const rect = this.roomRect;
      this.roomStart = null;
      this.roomRect = null;
      const L = this.os.getLayout();
      if (rect && canPlaceRect(L, rect)) {
        const color = OFFICE3D_ROOM_COLORS[(L.areas?.length ?? 0) % OFFICE3D_ROOM_COLORS.length];
        p.onApplyLayout(createRectRoom(L, rect, nextRoomLabel(L), color));
      }
      return;
    }
    if (es.dragUid) {
      if (es.isDragMoving) {
        const col = es.ghostCol - es.dragOffsetCol;
        const row = es.ghostRow - es.dragOffsetRow;
        const item = this.os.getLayout().furniture.find((f) => f.uid === es.dragUid);
        if (item && canPlaceFurniture(this.os.getLayout(), item.type, col, row, es.dragUid)) {
          p.onDragMove(es.dragUid, col, row);
        }
        es.clearSelection();
      } else if (es.selectedFurnitureUid === es.dragUid) {
        es.clearSelection();
      } else {
        es.selectedFurnitureUid = es.dragUid;
      }
      es.clearDrag();
      p.onEditorSelectionChange();
      return;
    }
    es.isDragging = false;
    es.wallDragAdding = null;
    es.carpetStrokeInitialLayout = null;
    es.carpetDragErasing = null;
    es.areaDragErasing = null;
  }

  leave(p: Edit3DProps): void {
    this.eraseDrag = false;
    const es = p.editorState;
    es.isDragging = false;
    es.ghostCol = -1;
    es.ghostRow = -1;
  }

  // ── Every frame ──

  update(p: Edit3DProps | null): void {
    const on = !!p?.isEditMode;
    this.root.visible = on;
    if (!on || !p) {
      this.setGhost('', null);
      return;
    }
    const es = p.editorState;
    const L = this.os.getLayout();
    this.syncGrid(L, GROW_TOOLS.has(es.activeTool));
    this.syncAreas(L);

    // Hovered tile (painting tools) — out-of-map tiles show where the map would grow.
    const showHover =
      es.ghostCol !== -1 && (isPaintTool(es.activeTool) || es.activeTool === EditTool.EYEDROPPER);
    this.hover.visible = showHover;
    if (showHover) this.hover.position.set(es.ghostCol + 0.5, 0.03, es.ghostRow + 0.5);

    // Furniture preview: placing a new item, or dragging one.
    let key = '';
    let item: PlacedFurniture | null = null;
    let ok = false;
    if (
      es.activeTool === EditTool.FURNITURE_PLACE &&
      es.selectedFurnitureType &&
      es.ghostCol >= 0
    ) {
      const row = getWallPlacementRow(es.selectedFurnitureType, es.ghostRow);
      ok = canPlaceFurniture(L, es.selectedFurnitureType, es.ghostCol, row);
      item = {
        uid: 'ghost',
        type: es.selectedFurnitureType,
        col: es.ghostCol,
        row,
        color: es.pickedFurnitureColor ?? undefined,
      };
    } else if (es.isDragMoving && es.dragUid && es.ghostCol >= 0) {
      const dragged = L.furniture.find((f) => f.uid === es.dragUid);
      if (dragged) {
        const col = es.ghostCol - es.dragOffsetCol;
        const row = es.ghostRow - es.dragOffsetRow;
        ok = canPlaceFurniture(L, dragged.type, col, row, es.dragUid);
        item = { ...dragged, uid: 'ghost', col, row };
      }
    }
    if (item)
      key = `${item.type}:${item.col}:${item.row}:${ok}:${JSON.stringify(item.color ?? null)}`;
    this.setGhost(key, item ? { item, ok, layout: L } : null);

    // The team room being drawn: green where it fits, red where it doesn't.
    const rr = this.roomRect;
    this.roomBox.visible = !!rr;
    if (rr) {
      this.roomBox.scale.set(rr.w, 1, rr.h);
      this.roomBox.position.set(rr.col + rr.w / 2, 0.55, rr.row + rr.h / 2);
      (this.roomBox.material as THREE.MeshBasicMaterial).color.set(
        canPlaceRect(L, rr) ? C.ghostOk : C.ghostBad,
      );
    }

    // Selection box around the selected item's footprint.
    const sel =
      es.selectedFurnitureUid && !es.isDragMoving
        ? L.furniture.find((f) => f.uid === es.selectedFurnitureUid)
        : undefined;
    const e = sel ? getCatalogEntry(sel.type) : undefined;
    this.selBox.visible = !!(sel && e);
    if (sel && e) {
      this.selBox.scale.set(e.footprintW + 0.08, 1.2, e.footprintH + 0.08);
      this.selBox.position.set(sel.col + e.footprintW / 2, 0.6, sel.row + e.footprintH / 2);
    }
  }

  /** Screen anchor (metres) for the selected item's rotate/delete buttons. */
  selectedAnchor(p: Edit3DProps | null): THREE.Vector3 | null {
    if (!p?.isEditMode) return null;
    const es = p.editorState;
    if (!es.selectedFurnitureUid || es.isDragMoving) return null;
    const sel = this.os.getLayout().furniture.find((f) => f.uid === es.selectedFurnitureUid);
    const e = sel ? getCatalogEntry(sel.type) : undefined;
    if (!sel || !e) return null;
    return new THREE.Vector3(sel.col + e.footprintW / 2, 1.5, sel.row + e.footprintH / 2);
  }

  private setGhost(
    key: string,
    g: { item: PlacedFurniture; ok: boolean; layout: OfficeLayout } | null,
  ): void {
    if (key === this.ghostKey) return;
    this.ghostKey = key;
    if (this.ghost) {
      this.root.remove(this.ghost);
      disposeGhost(this.ghost);
      this.ghost = null;
    }
    if (!g) return;
    this.ghost = buildFurnitureItem(g.item, deskTilesOf(g.layout));
    ghostify(this.ghost, g.ok);
    this.root.add(this.ghost);
  }

  /** Folder-area tiles (not team rooms, which have glass walls) as tinted floor. */
  private syncAreas(L: OfficeLayout): void {
    if (L === this.areaLayout) return;
    this.areaLayout = L;
    if (this.areaMesh) {
      this.root.remove(this.areaMesh);
      this.areaMesh.geometry.dispose();
      (this.areaMesh.material as THREE.Material).dispose();
      this.areaMesh = null;
    }
    const colors = new Map<string, THREE.Color>();
    for (const a of L.areas ?? []) if (!a.teamRoom) colors.set(a.label, new THREE.Color(a.color));
    const cells: Array<[number, number, THREE.Color]> = [];
    (L.areaTiles ?? []).forEach((label, i) => {
      const c = label ? colors.get(label) : undefined;
      if (c) cells.push([i % L.cols, Math.floor(i / L.cols), c]);
    });
    if (!cells.length) return;
    const m = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.96, 0.96),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false }),
      cells.length,
    );
    const mtx = new THREE.Matrix4();
    const rot = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    cells.forEach(([c, r, col], k) => {
      mtx.makeTranslation(c + 0.5, 0.025, r + 0.5).multiply(rot);
      m.setMatrixAt(k, mtx);
      m.setColorAt(k, col);
    });
    this.areaMesh = m;
    this.root.add(m);
  }

  /** Tile lines over the whole map, plus a dashed ring one tile out where painting grows it. */
  private syncGrid(L: OfficeLayout, grow: boolean): void {
    const key = `${L.cols}x${L.rows}:${grow}`;
    if (key === this.gridKey) return;
    this.gridKey = key;
    if (this.grid) {
      this.root.remove(this.grid);
      this.grid.geometry.dispose();
    }
    const pts: number[] = [];
    const y = 0.02;
    const c0 = grow ? -1 : 0,
      c1 = grow ? L.cols + 1 : L.cols,
      r0 = grow ? -1 : 0,
      r1 = grow ? L.rows + 1 : L.rows;
    for (let c = c0; c <= c1; c++) pts.push(c, y, r0, c, y, r1);
    for (let r = r0; r <= r1; r++) pts.push(c0, y, r, c1, y, r);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.grid = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({
        color: C.gridLine,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
      }),
    );
    this.root.add(this.grid);
  }

  dispose(): void {
    this.setGhost('', null);
    this.scene.remove(this.root);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
  }
}
