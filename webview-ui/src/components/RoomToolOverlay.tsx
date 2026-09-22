import { useEffect, useRef, useState } from 'react';

import { TEAM_ROOM_AREA_COLOR } from '../constants.js';
import { canPlaceFurniture } from '../office/editor/editorActions.js';
import type { OfficeState } from '../office/engine/officeState.js';
import type { FillPreset, RoomTemplate } from '../office/layout/rooms.js';
import {
  addPortal,
  canPlaceRect,
  createRectRoom,
  desksThatFit,
  FILL_PRESETS,
  fillRoom,
  moveRoom,
  nearestDoorEdge,
  nextRoomLabel,
  normalizeRect,
  placeTemplate,
  resizeRoom,
  ROOM_TEMPLATES,
  roomBounds,
  setRoomDoor,
  teamRooms,
} from '../office/layout/rooms.js';
import { mapOffset } from '../office/projection.js';
import type { OfficeLayout, RoomRect } from '../office/types.js';
import { TILE_SIZE } from '../office/types.js';
import { Button } from './ui/Button.js';

interface RoomToolOverlayProps {
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  applyEdit: (layout: OfficeLayout) => void;
  renameRoom: (oldLabel: string, newLabel: string) => void;
  removeRoom: (label: string) => void;
  /** The old way: name a room and paint its tiles with the Areas tool. */
  onPaintCustom: () => void;
}

type Tile = { col: number; row: number };
type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

type Drag =
  | { kind: 'draw'; start: Tile; rect: RoomRect }
  | { kind: 'move'; label: string; start: Tile; delta: Tile }
  | { kind: 'resize'; label: string; handle: Handle; rect: RoomRect }
  | { kind: 'door'; label: string; before: OfficeLayout };

interface Preview {
  title: string;
  before: OfficeLayout;
  after: OfficeLayout;
  showing: 'before' | 'after';
  select?: string;
}

const canPlace = (layout: OfficeLayout, type: string, col: number, row: number) =>
  canPlaceFurniture(layout, type, col, row);

/**
 * The room tool: drag a rectangle to make a team room, drag its edges to grow
 * it, drag its middle to move it (furniture comes along), drag its door along
 * a wall, drop in a ready-made room, fill a room with a preset, or join an
 * out-of-reach room with a portal pair. Anything that adds furniture is shown
 * as a preview first and only kept on Apply.
 */
export function RoomToolOverlay({
  officeState,
  containerRef,
  zoom,
  panRef,
  applyEdit,
  renameRoom,
  removeRoom,
  onPaintCustom,
}: RoomToolOverlayProps) {
  const [, setTick] = useState(0);
  const [mode, setMode] = useState<'draw' | 'template' | 'portal'>('draw');
  const [template, setTemplate] = useState<RoomTemplate>(ROOM_TEMPLATES[1]);
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<Tile | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; label: string } | null>(null);
  const [fillOpen, setFillOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [portalA, setPortalA] = useState<Tile | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const shiftRef = useRef(false);

  // Follow pan/zoom and the game loop's layout changes.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setTick((n) => (n + 1) % 1_000_000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Leaving the tool mid-preview puts the layout back.
  const previewRef = useRef<Preview | null>(null);
  previewRef.current = preview;
  useEffect(
    () => () => {
      if (previewRef.current) officeState.rebuildFromLayout(previewRef.current.before);
    },
    [officeState],
  );

  const el = containerRef.current;
  const layout = officeState.getLayout();
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const { offsetX, offsetY } = mapOffset(
    Math.round(rect.width * dpr),
    Math.round(rect.height * dpr),
    layout.cols,
    layout.rows,
    zoom,
    panRef.current.x,
    panRef.current.y,
  );
  const tilePx = (TILE_SIZE * zoom) / dpr;
  const left = (col: number) => (offsetX + col * TILE_SIZE * zoom) / dpr;
  const top = (row: number) => (offsetY + row * TILE_SIZE * zoom) / dpr;
  const tileAt = (e: { clientX: number; clientY: number }): Tile => ({
    col: Math.floor(((e.clientX - rect.left) * dpr - offsetX) / (TILE_SIZE * zoom)),
    row: Math.floor(((e.clientY - rect.top) * dpr - offsetY) / (TILE_SIZE * zoom)),
  });
  const labelAt = (t: Tile): string | null => {
    if (t.col < 0 || t.row < 0 || t.col >= layout.cols || t.row >= layout.rows) return null;
    const label = layout.areaTiles?.[t.row * layout.cols + t.col] ?? null;
    return label && teamRooms(layout).some((a) => a.label === label) ? label : null;
  };

  const startPreview = (
    title: string,
    after: OfficeLayout | null,
    select?: string,
    failMessage?: string,
  ) => {
    if (!after) {
      setNotice(failMessage ?? "That doesn't fit here.");
      return;
    }
    setNotice(null);
    const before = layout;
    officeState.rebuildFromLayout(after);
    setPreview({ title, before, after, showing: 'after', select });
  };
  const applyPreview = () => {
    if (!preview) return;
    officeState.rebuildFromLayout(preview.before);
    applyEdit(preview.after);
    if (preview.select) setSelected(preview.select);
    setPreview(null);
  };
  const cancelPreview = () => {
    if (!preview) return;
    officeState.rebuildFromLayout(preview.before);
    setPreview(null);
  };
  const showSide = (side: 'before' | 'after') => {
    if (!preview) return;
    officeState.rebuildFromLayout(side === 'after' ? preview.after : preview.before);
    setPreview({ ...preview, showing: side });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (preview || e.button !== 0) return;
    setMenu(null);
    setFillOpen(false);
    const t = tileAt(e);
    if (mode === 'template') {
      const label = nextRoomLabel(layout);
      startPreview(
        `${template.name} · ${template.seats} seats`,
        placeTemplate(layout, template, t, label, TEAM_ROOM_AREA_COLOR, canPlace),
        label,
        `The ${template.name} (${template.w}×${template.h}) doesn't fit there: it needs open floor with nothing in the way.`,
      );
      return;
    }
    if (mode === 'portal') {
      if (!portalA) {
        setPortalA(t);
        return;
      }
      startPreview(
        'Portal pair',
        addPortal(layout, portalA, t),
        undefined,
        'Both ends need an open floor tile no other portal uses.',
      );
      setPortalA(null);
      setMode('draw');
      return;
    }
    const label = labelAt(t);
    if (label) {
      setSelected(label);
      setDrag({ kind: 'move', label, start: t, delta: { col: 0, row: 0 } });
    } else {
      setSelected(null);
      setDrag({ kind: 'draw', start: t, rect: normalizeRect(t, t) });
    }
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    shiftRef.current = e.shiftKey;
    const t = tileAt(e);
    setHover(t);
    if (!drag) return;
    if (drag.kind === 'draw') setDrag({ ...drag, rect: normalizeRect(drag.start, t, e.shiftKey) });
    else if (drag.kind === 'move')
      setDrag({ ...drag, delta: { col: t.col - drag.start.col, row: t.row - drag.start.row } });
    else if (drag.kind === 'resize') {
      const b = roomBounds(layout, drag.label);
      if (!b) return;
      let { col, row } = b;
      let right = b.col + b.w - 1;
      let bottom = b.row + b.h - 1;
      if (drag.handle.includes('w')) col = Math.min(t.col, right - 1);
      if (drag.handle.includes('e')) right = Math.max(t.col, col + 1);
      if (drag.handle.includes('n')) row = Math.min(t.row, bottom - 1);
      if (drag.handle.includes('s')) bottom = Math.max(t.row, row + 1);
      let next = { col, row, w: right - col + 1, h: bottom - row + 1 };
      if (e.shiftKey) {
        const side = Math.max(next.w, next.h);
        next = { ...next, w: side, h: side };
      }
      setDrag({ ...drag, rect: next });
    }
  };

  const onPointerUp = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.kind === 'draw') {
      if (d.rect.w < 2 || d.rect.h < 2) return;
      if (!canPlaceRect(layout, d.rect)) {
        setNotice('A room needs open floor, at least 2×2, and must not overlap another room.');
        return;
      }
      const label = nextRoomLabel(layout);
      applyEdit(createRectRoom(layout, d.rect, label, TEAM_ROOM_AREA_COLOR));
      setSelected(label);
      setNotice(null);
    } else if (d.kind === 'move') {
      if (d.delta.col === 0 && d.delta.row === 0) return;
      const next = moveRoom(layout, d.label, d.delta.col, d.delta.row);
      if (next === layout)
        setNotice("The room can't go there: it would overlap another room or leave the floor.");
      else applyEdit(next);
    } else if (d.kind === 'resize') {
      const next = resizeRoom(layout, d.label, d.rect);
      if (next === layout) setNotice("The room can't be that size there.");
      else applyEdit(next);
    }
  };

  const onDoorDrag = (label: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    setDrag({ kind: 'door', label, before: layout });
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onDoorMove = (label: string) => (e: React.PointerEvent) => {
    if (drag?.kind !== 'door') return;
    e.stopPropagation();
    const px = ((e.clientX - rect.left) * dpr - offsetX) / (TILE_SIZE * zoom) - 0.5;
    const py = ((e.clientY - rect.top) * dpr - offsetY) / (TILE_SIZE * zoom) - 0.5;
    const edge = nearestDoorEdge(layout, label, px, py);
    if (!edge) return;
    const area = layout.areas?.find((a) => a.label === label);
    const door = area?.door;
    if (!door || door.col !== edge.col || door.row !== edge.row || door.side !== edge.side) {
      officeState.rebuildFromLayout(setRoomDoor(layout, label, edge));
    }
  };
  const onDoorUp = (label: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    if (drag?.kind !== 'door') return;
    const before = drag.before;
    setDrag(null);
    const after = officeState.getLayout();
    if (after !== before) {
      officeState.rebuildFromLayout(before);
      applyEdit(setRoomDoor(before, label, after.areas!.find((a) => a.label === label)!.door!));
    }
  };

  // What to draw: the live drag, else the selected room.
  const selectedBounds = selected ? roomBounds(layout, selected) : null;
  let box: { rect: RoomRect; valid: boolean; label: string } | null = null;
  if (drag?.kind === 'draw' && (drag.rect.w > 1 || drag.rect.h > 1)) {
    box = { rect: drag.rect, valid: canPlaceRect(layout, drag.rect), label: 'New room' };
  } else if (drag?.kind === 'resize') {
    box = {
      rect: drag.rect,
      valid: canPlaceRect(layout, drag.rect, drag.label),
      label: drag.label,
    };
  } else if (drag?.kind === 'move' && selectedBounds) {
    const r = {
      ...selectedBounds,
      col: selectedBounds.col + drag.delta.col,
      row: selectedBounds.row + drag.delta.row,
    };
    box = { rect: r, valid: canPlaceRect(layout, r, drag.label), label: drag.label };
  } else if (mode === 'template' && hover && !preview) {
    const r = { col: hover.col, row: hover.row, w: template.w, h: template.h };
    box = { rect: r, valid: canPlaceRect(layout, r), label: template.name };
  }

  const unreachable = officeState.unreachableRooms();
  const selectedArea = selected ? layout.areas?.find((a) => a.label === selected) : undefined;

  const handleStyle = (h: Handle, r: RoomRect): React.CSSProperties => {
    const x = h.includes('w')
      ? left(r.col)
      : h.includes('e')
        ? left(r.col + r.w)
        : left(r.col + r.w / 2);
    const y = h.includes('n')
      ? top(r.row)
      : h.includes('s')
        ? top(r.row + r.h)
        : top(r.row + r.h / 2);
    return { left: x - 6, top: y - 6 };
  };

  return (
    <>
      {/* Pointer surface over the canvas */}
      <div
        className={`absolute inset-0 z-5 ${mode === 'draw' ? 'cursor-crosshair' : 'cursor-copy'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={(e) => {
          e.preventDefault();
          const label = labelAt(tileAt(e));
          if (!label) return;
          setSelected(label);
          setMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top, label });
        }}
        data-testid="room-surface"
      />

      {box && (
        <div
          className={`absolute z-6 pointer-events-none border-3 border-dashed ${box.valid ? 'border-white bg-accent/20' : 'border-danger bg-danger/20'}`}
          style={{
            left: left(box.rect.col),
            top: top(box.rect.row),
            width: box.rect.w * tilePx,
            height: box.rect.h * tilePx,
          }}
        >
          <span
            className={`absolute -top-20 left-4 px-4 text-2xs whitespace-nowrap ${box.valid ? 'bg-white text-board-ink' : 'bg-danger text-white'}`}
          >
            {box.label}
          </span>
          <span className="absolute -bottom-24 left-1/2 -translate-x-1/2 px-6 text-2xs bg-bg border-2 border-border whitespace-nowrap">
            {box.rect.w} × {box.rect.h} tiles
            {box.valid
              ? ` · fits ${desksThatFit(box.rect)} desk${desksThatFit(box.rect) === 1 ? '' : 's'}`
              : ' · doesn’t fit'}
          </span>
        </div>
      )}

      {selectedBounds && !drag && !preview && selectedArea && (
        <div
          className="absolute z-6 border-3 border-status-active pointer-events-none"
          style={{
            left: left(selectedBounds.col),
            top: top(selectedBounds.row),
            width: selectedBounds.w * tilePx,
            height: selectedBounds.h * tilePx,
          }}
        >
          <span className="absolute -bottom-24 left-0 px-6 text-2xs bg-bg border-2 border-border whitespace-nowrap">
            {selectedBounds.w} × {selectedBounds.h} · drag edges to grow · drag inside to move ·
            right-click for more
          </span>
        </div>
      )}
      {selectedBounds &&
        !drag &&
        !preview &&
        (['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as Handle[]).map((h) => (
          <span
            key={h}
            className="absolute z-7 w-12 h-12 bg-white border-2 border-bg-dark"
            style={{ ...handleStyle(h, selectedBounds), cursor: `${h}-resize` }}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (!selected) return;
              setDrag({ kind: 'resize', label: selected, handle: h, rect: selectedBounds });
              (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        ))}
      {selectedArea?.door && !preview && (drag === null || drag.kind === 'door') && (
        <span
          className="absolute z-7 px-4 text-2xs bg-status-permission text-board-ink border-2 border-bg-dark cursor-grab whitespace-nowrap"
          style={{
            left:
              left(
                selectedArea.door.col +
                  (selectedArea.door.side === 'E' ? 1 : selectedArea.door.side === 'W' ? 0 : 0.5),
              ) - 18,
            top:
              top(
                selectedArea.door.row +
                  (selectedArea.door.side === 'S' ? 1 : selectedArea.door.side === 'N' ? 0 : 0.5),
              ) - 9,
          }}
          title="Drag the door along the walls"
          onPointerDown={onDoorDrag(selectedArea.label)}
          onPointerMove={onDoorMove(selectedArea.label)}
          onPointerUp={onDoorUp(selectedArea.label)}
          data-testid="room-door"
        >
          ◀ door ▶
        </span>
      )}
      {mode === 'portal' && portalA && (
        <span
          className="absolute z-6 pointer-events-none border-3 border-dashed border-status-active"
          style={{ left: left(portalA.col), top: top(portalA.row), width: tilePx, height: tilePx }}
        />
      )}

      {/* Tool panel */}
      <div
        className="absolute left-8 top-8 z-30 w-260 pixel-panel p-8 flex flex-col gap-6 text-sm"
        onPointerDown={(e) => e.stopPropagation()}
        data-testid="room-panel"
      >
        <span className="text-2xs text-text-muted uppercase">New room</span>
        {(
          [
            ['draw', 'Draw a rectangle', 'Drag across the floor · Shift = square'],
            ['template', 'Ready-made room', 'Pick a size, click to drop it in'],
          ] as const
        ).map(([m, name, hint]) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              setPortalA(null);
            }}
            className={`text-left px-6 py-4 border-2 rounded-none cursor-pointer text-text ${mode === m ? 'bg-active-bg border-accent' : 'bg-transparent border-transparent hover:bg-bg-thumb'}`}
          >
            <span className="block">{name}</span>
            <span className="block text-2xs text-text-muted">{hint}</span>
          </button>
        ))}
        <button
          onClick={onPaintCustom}
          className="text-left px-6 py-4 border-2 border-transparent rounded-none cursor-pointer bg-transparent text-text hover:bg-bg-thumb"
        >
          <span className="block">Paint a custom shape</span>
          <span className="block text-2xs text-text-muted">Tile by tile, with the Areas tool</span>
        </button>
        {mode === 'template' && (
          <div className="grid grid-cols-2 gap-4">
            {ROOM_TEMPLATES.map((t) => (
              <button
                key={t.id}
                onClick={() => setTemplate(t)}
                className={`text-left px-6 py-4 border-2 rounded-none cursor-pointer text-xs text-text ${template.id === t.id ? 'bg-active-bg border-accent' : 'bg-bg-dark border-border'}`}
              >
                {t.name}
                <span className="block text-2xs text-text-muted">
                  {t.w}×{t.h} · {t.seats} seats
                </span>
              </button>
            ))}
          </div>
        )}
        {mode === 'portal' && (
          <span className="text-2xs text-status-active">
            {portalA ? 'Now click the tile it leads to.' : 'Click the first end of the portal.'}
          </span>
        )}
        {notice && <span className="text-2xs text-danger">{notice}</span>}
      </div>

      {unreachable.length > 0 && !preview && (
        <div
          className="absolute right-8 top-8 z-30 w-280 pixel-panel p-8 flex flex-col gap-6 border-status-active"
          onPointerDown={(e) => e.stopPropagation()}
          data-testid="room-unreachable"
        >
          <span className="text-sm text-status-active">
            {unreachable.join(', ')} can't be reached on foot
          </span>
          <span className="text-2xs text-text-muted font-reading">
            Give it a door onto open floor, or join it with a portal pair: one end outside, one
            inside. Characters step in and come out on the other side.
          </span>
          <Button
            size="sm"
            variant="accent"
            onClick={() => {
              setMode('portal');
              setPortalA(null);
            }}
          >
            Place a portal pair
          </Button>
        </div>
      )}

      {menu && (
        <div
          className="absolute z-40 w-200 pixel-panel flex flex-col text-sm"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
          data-testid="room-menu"
        >
          {renaming === menu.label ? (
            <form
              className="p-6"
              onSubmit={(e) => {
                e.preventDefault();
                const input = (
                  e.currentTarget.elements.namedItem('name') as HTMLInputElement
                ).value.trim();
                if (input && input !== menu.label) {
                  renameRoom(menu.label, input);
                  setSelected(input);
                }
                setRenaming(null);
                setMenu(null);
              }}
            >
              <input
                name="name"
                autoFocus
                defaultValue={menu.label}
                onKeyDown={(e) => e.stopPropagation()}
                className="w-full bg-bg-dark border-2 border-accent px-6 py-2 text-sm text-text"
              />
            </form>
          ) : (
            <>
              <button
                className="text-left px-10 py-4 bg-transparent border-0 text-text cursor-pointer hover:bg-active-bg"
                onClick={() => setRenaming(menu.label)}
              >
                Rename
              </button>
              <button
                className="text-left px-10 py-4 bg-transparent border-0 text-text cursor-pointer hover:bg-active-bg"
                onClick={() => {
                  setFillOpen(true);
                  setMenu(null);
                }}
              >
                Add a preset…
              </button>
              <button
                className="text-left px-10 py-4 bg-transparent border-0 text-text cursor-pointer hover:bg-active-bg"
                onClick={() => {
                  const b = roomBounds(layout, menu.label);
                  if (b) {
                    const side = Math.max(b.w, b.h);
                    const next = resizeRoom(layout, menu.label, { ...b, w: side, h: side });
                    if (next === layout) setNotice("There isn't room to make it square here.");
                    else applyEdit(next);
                  }
                  setMenu(null);
                }}
              >
                Make it square
              </button>
              <button
                className="text-left px-10 py-4 bg-transparent border-0 text-text cursor-pointer hover:bg-active-bg"
                onClick={() => {
                  setMode('portal');
                  setPortalA(null);
                  setMenu(null);
                }}
              >
                Add a portal pair
              </button>
              <div className="h-2 bg-border" />
              <button
                className="text-left px-10 py-4 bg-transparent border-0 text-danger cursor-pointer hover:bg-active-bg"
                onClick={() => {
                  removeRoom(menu.label);
                  setSelected(null);
                  setMenu(null);
                }}
              >
                Remove room
              </button>
            </>
          )}
        </div>
      )}

      {fillOpen && selected && (
        <div
          className="absolute right-8 top-8 bottom-8 z-40 w-240 pixel-panel p-8 flex flex-col gap-6"
          onPointerDown={(e) => e.stopPropagation()}
          data-testid="room-presets"
        >
          <div className="flex items-center">
            <span className="text-2xs text-text-muted uppercase flex-1">Fill {selected}</span>
            <Button size="sm" variant="ghost" onClick={() => setFillOpen(false)} aria-label="Close">
              ×
            </Button>
          </div>
          {FILL_PRESETS.map((p: FillPreset) => (
            <button
              key={p.id}
              className="text-left px-8 py-6 bg-bg-dark border-2 border-border text-text cursor-pointer hover:border-accent"
              onClick={() => {
                if (preview) officeState.rebuildFromLayout(preview.before);
                const base = preview ? preview.before : layout;
                const after = fillRoom(base, selected, p, canPlace);
                if (!after) {
                  setPreview(null);
                  setNotice(
                    `${p.name} doesn't fit in ${selected}. Make the room bigger and try again.`,
                  );
                  return;
                }
                officeState.rebuildFromLayout(after);
                setNotice(null);
                setPreview({
                  title: p.name,
                  before: base,
                  after,
                  showing: 'after',
                  select: selected,
                });
              }}
            >
              <span className="block text-sm">{p.name}</span>
              <span className="block text-2xs text-text-muted">{p.hint}</span>
            </button>
          ))}
          <span className="mt-auto text-2xs text-text-muted">
            Pick one to see it in place. Apply keeps it; Cancel leaves the room as it was.
          </span>
        </div>
      )}

      {preview && (
        <div
          className="absolute left-1/2 -translate-x-1/2 top-8 z-45 flex items-center gap-8 px-10 py-6 pixel-panel border-status-permission whitespace-nowrap"
          onPointerDown={(e) => e.stopPropagation()}
          data-testid="room-preview"
        >
          <span className="text-sm text-status-permission">Preview</span>
          <span className="text-sm">{preview.title}</span>
          <span className="flex">
            <Button
              size="sm"
              variant={preview.showing === 'before' ? 'active' : 'default'}
              onClick={() => showSide('before')}
            >
              Before
            </Button>
            <Button
              size="sm"
              variant={preview.showing === 'after' ? 'active' : 'default'}
              onClick={() => showSide('after')}
            >
              After
            </Button>
          </span>
          <Button size="sm" onClick={cancelPreview} data-testid="room-preview-cancel">
            Cancel
          </Button>
          <Button
            size="sm"
            variant="accent"
            onClick={applyPreview}
            data-testid="room-preview-apply"
          >
            Apply
          </Button>
        </div>
      )}
    </>
  );
}
