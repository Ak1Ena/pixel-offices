/**
 * Build panel for the 3D office (the design's "Build"): tools, a furniture
 * palette drawn as to-scale footprints, team rooms, land and ready-made
 * offices. It drives the same editor state and actions as the pixel toolbar.
 */

import { useState } from 'react';

import { AREA_DEFAULT_COLORS, OFFICE3D_ROOM_COLORS } from '../constants.js';
import type { EditorActions } from '../hooks/useEditorActions.js';
import { canPlaceFurniture, type ExpandDirection } from '../office/editor/editorActions.js';
import type { EditorState } from '../office/editor/editorState.js';
import type { OfficeState } from '../office/engine/officeState.js';
import {
  FURNITURE_CATEGORIES,
  getCatalogByCategory,
  getCatalogEntry,
} from '../office/layout/furnitureCatalog.js';
import {
  canPlaceRect,
  nextRoomLabel,
  placeTemplate,
  ROOM_TEMPLATES,
  type RoomTemplate,
} from '../office/layout/rooms.js';
import { getPetCount, getPetName } from '../office/sprites/petSpriteData.js';
import type { ColorValue, OfficeLayout } from '../office/types.js';
import { EditTool, TileType } from '../office/types.js';
import { Button } from './ui/Button.js';
import { Checkbox } from './ui/Checkbox.js';

interface BuildPanelProps {
  officeState: OfficeState;
  editorState: EditorState;
  editor: EditorActions;
  /** Ready-made offices (Settings has the same choices). */
  presets: Array<{ id: string; name: string; hint: string; layout: () => OfficeLayout }>;
  onDone: () => void;
  /** Workspace folders that can be tied to a folder area. */
  areaFolders: Array<{ name: string; path: string }>;
  /** Folder name → the areas its agents sit in. */
  areaMappings: Record<string, string[]>;
  onAreaMappingChange: (folderName: string, areaLabel: string, action: 'add' | 'remove') => void;
}

/** Rug colours for the Rugs tool (Colorize values). */
const RUG_COLORS: Array<{ name: string; color: ColorValue }> = [
  { name: 'Coral', color: { h: 10, s: 55, b: 0, c: 0, colorize: true } },
  { name: 'Sand', color: { h: 38, s: 45, b: 5, c: 0, colorize: true } },
  { name: 'Sea', color: { h: 190, s: 45, b: -5, c: 0, colorize: true } },
  { name: 'Lilac', color: { h: 270, s: 35, b: 5, c: 0, colorize: true } },
  { name: 'Moss', color: { h: 110, s: 35, b: -5, c: 0, colorize: true } },
  { name: 'Slate', color: { h: 220, s: 12, b: -15, c: 0, colorize: true } },
];

/** Rug swatch as the 3D view draws it (Colorize: fixed hue and saturation, lightness 0.5 + b/200). */
function rugCss(c: ColorValue): string {
  return hslHex(c.h / 360, c.s / 100, 0.5 + c.b / 200);
}

/** Floor finishes offered by "Add floor" (Colorize values: hue, saturation, brightness). */
const FLOOR_FINISHES: Array<{ name: string; color: ColorValue }> = [
  { name: 'Warm tile', color: { h: 32, s: 45, b: 22, c: 0, colorize: true } },
  { name: 'Oak', color: { h: 30, s: 50, b: 5, c: 0, colorize: true } },
  { name: 'Sky', color: { h: 205, s: 38, b: 28, c: 0, colorize: true } },
  { name: 'Blush', color: { h: 350, s: 28, b: 24, c: 0, colorize: true } },
  { name: 'Sage', color: { h: 120, s: 22, b: 20, c: 0, colorize: true } },
  { name: 'Stone', color: { h: 220, s: 6, b: 18, c: 0, colorize: true } },
];

function hslHex(h: number, sat: number, l: number): string {
  const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat,
    p = 2 * l - q;
  const ch = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    const v =
      u < 1 / 6
        ? p + (q - p) * 6 * u
        : u < 1 / 2
          ? q
          : u < 2 / 3
            ? p + (q - p) * (2 / 3 - u) * 6
            : p;
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return '#' + ch(h + 1 / 3) + ch(h) + ch(h - 1 / 3);
}

/** The swatch colour a floor finish shows (the same mapping the 3D floor uses). */
function finishCss(c: ColorValue): string {
  return hslHex(
    c.h / 360,
    Math.min(0.55, 0.15 + c.s / 100),
    Math.min(0.86, Math.max(0.6, 0.76 + c.b / 500)),
  );
}

const TOOLS: Array<{ tool: (typeof EditTool)[keyof typeof EditTool]; label: string }> = [
  { tool: EditTool.SELECT, label: 'Select' },
  { tool: EditTool.TILE_PAINT, label: 'Add floor' },
  { tool: EditTool.WALL_PAINT, label: 'Walls' },
  { tool: EditTool.ERASE, label: 'Remove' },
];

const HINT: Partial<Record<string, string>> = {
  [EditTool.SELECT]:
    'Click something to turn, move or remove it. Drag it to move. Shift-drag turns the view.',
  [EditTool.TILE_PAINT]: 'Click or drag to lay floor. Painting just past the edge grows the map.',
  [EditTool.WALL_PAINT]: 'Click or drag to add walls; click a wall to take it away.',
  [EditTool.ERASE]:
    'Click or drag to remove floor and walls. Right-drag erases with any paint tool.',
  [EditTool.FURNITURE_PLACE]:
    'Click the floor to place it. R turns it. Green fits, red does not. Esc stops.',
  [EditTool.ROOM]: 'Drag a rectangle on the floor to make a team room (at least 2×2).',
};

function Footprint({ w, h, seat }: { w: number; h: number; seat: boolean }) {
  const s = Math.min(34 / w, 26 / h, 12);
  const W = w * s,
    H = h * s;
  const x = (40 - W) / 2,
    y = (32 - H) / 2;
  return (
    <svg viewBox="0 0 40 32" className="w-40 h-32 shrink-0" aria-hidden="true">
      <rect
        x={x}
        y={y}
        width={W}
        height={H}
        rx="2"
        className="fill-accent/25 stroke-accent"
        strokeWidth="1.5"
      />
      {seat && <circle cx="20" cy={16} r="3" className="fill-current" />}
    </svg>
  );
}

function findSpot(layout: OfficeLayout, t: RoomTemplate): { col: number; row: number } | null {
  for (let r = 0; r + t.h <= layout.rows; r++) {
    for (let c = 0; c + t.w <= layout.cols; c++) {
      if (canPlaceRect(layout, { col: c, row: r, w: t.w, h: t.h })) return { col: c, row: r };
    }
  }
  return null;
}

export function BuildPanel({
  officeState,
  editorState,
  editor,
  presets,
  onDone,
  areaFolders,
  areaMappings,
  onAreaMappingChange,
}: BuildPanelProps) {
  const [areaDraft, setAreaDraft] = useState('');
  const [cat, setCat] = useState<(typeof FURNITURE_CATEGORIES)[number]['id']>('desks');
  const [note, setNote] = useState<string | null>(null);
  const tool = editorState.activeTool;
  const layout = officeState.getLayout();
  const seats = [...officeState.seats.values()];
  const free = seats.filter((s) => !s.assigned).length;
  const floorTiles = layout.tiles.filter((t) => t !== TileType.VOID && t !== TileType.WALL).length;
  const sel = editorState.selectedFurnitureUid
    ? layout.furniture.find((f) => f.uid === editorState.selectedFurnitureUid)
    : undefined;
  const selEntry = sel ? getCatalogEntry(sel.type) : undefined;
  const items = getCatalogByCategory(cat);
  const cats = FURNITURE_CATEGORIES.filter((c) => getCatalogByCategory(c.id).length > 0);

  const setTool = (t: (typeof EditTool)[keyof typeof EditTool]) => {
    if (editorState.activeTool !== t) editor.handleToolChange(t);
    else if (t !== EditTool.SELECT) editor.handleToolChange(t); // toggles back to Select
    setNote(null);
  };
  const pickItem = (type: string) => {
    if (editorState.activeTool !== EditTool.FURNITURE_PLACE)
      editor.handleToolChange(EditTool.FURNITURE_PLACE);
    editor.handleFurnitureTypeChange(type);
  };
  const grow = (dir: ExpandDirection) => {
    if (!editor.handleGrowLayout(dir, 4)) setNote('The map is as big as it gets on that side.');
  };
  const placeRoom = (t: RoomTemplate) => {
    const L = officeState.getLayout();
    const at = findSpot(L, t);
    const color = OFFICE3D_ROOM_COLORS[(L.areas?.length ?? 0) % OFFICE3D_ROOM_COLORS.length];
    const next = at ? placeTemplate(L, t, at, nextRoomLabel(L), color, canPlaceFurniture) : null;
    if (!next) {
      setNote(
        `No free ${t.w}×${t.h} spot for a ${t.name.toLowerCase()}. Grow the land or clear some floor.`,
      );
      return;
    }
    editor.applyEdit(next);
    setNote(`${t.name} added.`);
  };

  const seg = 'grid grid-cols-4 gap-4 p-4 border border-border rounded-ui';
  const segBtn = (on: boolean) =>
    `h-32 rounded-ui border-0 text-sm font-semibold cursor-pointer ${
      on
        ? 'bg-active-bg text-text shadow-[inset_0_0_0_1px_var(--color-border)]'
        : 'bg-transparent text-text-muted hover:text-text'
    }`;
  const h3 = 'text-2xs uppercase tracking-wider text-text-muted';

  return (
    <section
      className="absolute right-12 top-12 bottom-96 z-30 w-360 max-w-[calc(100%-24px)] flex flex-col pixel-panel overflow-hidden"
      aria-label="Build"
      data-testid="build-panel"
    >
      <div className="flex items-center gap-10 px-14 pt-12 pb-10 border-b border-border">
        <div className="flex-1 min-w-0 flex flex-col">
          <span className="font-display text-lg font-medium">Build</span>
          <span className="text-2xs text-text-muted font-mono">
            {seats.length} seats · {free} free · {floorTiles} floor tiles
          </span>
        </div>
        <Button variant="accent" size="md" onClick={onDone} data-testid="build-done">
          Done
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-12 px-14 py-12 text-sm">
        <div className={seg} role="group" aria-label="Tool">
          {TOOLS.map((t) => (
            <button
              key={t.tool}
              type="button"
              aria-pressed={tool === t.tool}
              className={segBtn(tool === t.tool)}
              onClick={() => setTool(t.tool)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tool === EditTool.TILE_PAINT && (
          <div className="flex flex-wrap gap-6" role="group" aria-label="Floor finish">
            {FLOOR_FINISHES.map((f) => {
              const on =
                editorState.floorColor.h === f.color.h && editorState.floorColor.s === f.color.s;
              return (
                <button
                  key={f.name}
                  type="button"
                  title={f.name}
                  aria-label={f.name}
                  aria-pressed={on}
                  onClick={() => {
                    editor.handleTileTypeChange(TileType.FLOOR_1);
                    editor.handleFloorColorChange(f.color);
                  }}
                  className={`w-28 h-28 rounded-full cursor-pointer border-2 ${on ? 'border-accent' : 'border-border'}`}
                  style={{ background: finishCss(f.color) }}
                />
              );
            })}
          </div>
        )}

        {sel && selEntry && (
          <div className="flex items-center gap-6 pl-12 pr-6 py-6 border border-accent rounded-ui bg-active-bg">
            <b className="flex-1 min-w-0 truncate">{selEntry.label}</b>
            <Button size="sm" onClick={editor.handleRotateSelected}>
              Turn
            </Button>
            <Button size="sm" onClick={editor.handleDeleteSelected}>
              Remove
            </Button>
          </div>
        )}

        <div className="flex flex-col gap-8">
          <span className={h3}>Furniture</span>
          <div className="flex flex-wrap gap-4">
            {cats.map((c) => (
              <Button
                key={c.id}
                type="button"
                size="sm"
                variant={c.id === cat ? 'active' : 'default'}
                onClick={() => setCat(c.id)}
              >
                {c.label}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-6" data-testid="build-palette">
            {items.map((e) => {
              const on =
                tool === EditTool.FURNITURE_PLACE && editorState.selectedFurnitureType === e.type;
              return (
                <button
                  key={e.type}
                  type="button"
                  aria-pressed={on}
                  onClick={() => pickItem(e.type)}
                  title={e.label}
                  className={`grid grid-cols-[40px_minmax(0,1fr)] items-center gap-8 p-8 rounded-ui border cursor-pointer text-left ${
                    on
                      ? 'border-accent bg-active-bg'
                      : 'border-border bg-transparent hover:bg-btn-bg'
                  }`}
                >
                  <Footprint w={e.footprintW} h={e.footprintH} seat={e.category === 'chairs'} />
                  <span className="min-w-0 flex flex-col">
                    <b className="text-xs font-semibold truncate">{e.label}</b>
                    <small className="text-2xs text-text-muted">
                      {e.footprintW} × {e.footprintH} m{e.category === 'chairs' ? ' · 1 seat' : ''}
                    </small>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <p className="m-0 text-2xs text-text-muted leading-relaxed">
          {note ?? HINT[tool] ?? 'Pick a tool or a piece of furniture.'}
        </p>

        <div className="flex flex-col gap-8">
          <span className={h3}>Team rooms</span>
          <div className="flex items-center gap-10 p-10 border border-border rounded-ui">
            <div className="flex-1 min-w-0">
              <b className="block">Draw a room</b>
              <span className="text-2xs text-text-muted">
                Glass walls and a door; a team moves in together.
              </span>
            </div>
            <Button
              size="sm"
              variant={tool === EditTool.ROOM ? 'active' : 'default'}
              onClick={() => setTool(EditTool.ROOM)}
              data-testid="build-draw-room"
            >
              {tool === EditTool.ROOM ? 'Drawing…' : 'Draw'}
            </Button>
          </div>
          {(layout.areas ?? [])
            .filter((a) => a.teamRoom)
            .map((a) => (
              <div
                key={a.label}
                className="flex items-center gap-10 p-10 border border-border rounded-ui"
                data-testid="build-room"
              >
                <div className="flex-1 min-w-0">
                  <b className="block truncate">{a.label}</b>
                  <span className="text-2xs text-text-muted">
                    In this office · removing keeps its furniture (Undo brings it back)
                  </span>
                </div>
                <Button
                  size="sm"
                  onClick={() => editor.handleRemoveArea(a.label)}
                  aria-label={`Remove room ${a.label}`}
                  data-testid="build-room-remove"
                >
                  Remove
                </Button>
              </div>
            ))}
          {ROOM_TEMPLATES.map((t) => (
            <div
              key={t.id}
              className="flex items-center gap-10 p-10 border border-border rounded-ui"
            >
              <div className="flex-1 min-w-0">
                <b className="block">{t.name}</b>
                <span className="text-2xs text-text-muted">
                  {t.w} × {t.h} m · {t.seats} seats
                </span>
              </div>
              <Button size="sm" variant="accent" onClick={() => placeRoom(t)}>
                Add
              </Button>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-12 p-10 border border-border rounded-ui">
          <div className="flex-1 min-w-0">
            <b className="block">
              Land {layout.cols} × {layout.rows} m
            </b>
            <span className="text-2xs text-text-muted">
              Grow the map 4 m at a time, here or with the + buttons on its edges. New land is
              empty: lay floor on it.
            </span>
          </div>
          <div className="grid grid-cols-3 grid-rows-3 gap-3" aria-label="Grow the land">
            {(
              [
                ['up', 2, '↑'],
                ['left', 4, '←'],
                ['right', 6, '→'],
                ['down', 8, '↓'],
              ] as Array<[ExpandDirection, number, string]>
            ).map(([dir, cell, arrow]) => (
              <button
                key={dir}
                type="button"
                onClick={() => grow(dir)}
                aria-label={`Grow ${dir}`}
                data-testid={`build-grow-${dir}`}
                className="w-30 h-30 rounded-ui border border-border bg-btn-bg hover:border-accent cursor-pointer"
                style={{ gridRow: Math.ceil(cell / 3), gridColumn: ((cell - 1) % 3) + 1 }}
              >
                {arrow}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-8">
          <span className={h3}>Ready-made offices</span>
          {presets.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-10 p-10 border border-border rounded-ui"
            >
              <div className="flex-1 min-w-0">
                <b className="block">{p.name}</b>
                <span className="text-2xs text-text-muted">{p.hint}</span>
              </div>
              <Button size="sm" onClick={() => editor.applyPresetLayout(p.layout())}>
                Use
              </Button>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-8">
          <span className={h3}>Rugs</span>
          <div className="flex items-center gap-6 flex-wrap" role="group" aria-label="Rug colour">
            {RUG_COLORS.map((r) => {
              const on =
                tool === EditTool.CARPET_PAINT &&
                editor.carpetColor.h === r.color.h &&
                editor.carpetColor.s === r.color.s;
              return (
                <button
                  key={r.name}
                  type="button"
                  title={`${r.name} rug`}
                  aria-label={`${r.name} rug`}
                  aria-pressed={on}
                  onClick={() => {
                    if (editorState.activeTool !== EditTool.CARPET_PAINT) {
                      editor.handleToolChange(EditTool.CARPET_PAINT);
                    }
                    editor.handleCarpetVariantChange(0);
                    editor.handleCarpetColorChange(r.color);
                  }}
                  className={`w-28 h-28 rounded-ui cursor-pointer border-2 ${on ? 'border-accent' : 'border-border'}`}
                  style={{ background: rugCss(r.color) }}
                />
              );
            })}
            <span className="text-2xs text-text-muted">
              Paint rugs on the floor; right-drag lifts them.
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-8">
          <span className={h3}>Folder areas</span>
          <span className="text-2xs text-text-muted">
            Paint an area, then tie folders to it: agents from those folders sit there.
          </span>
          {(layout.areas ?? [])
            .filter((a) => !a.teamRoom)
            .map((a) => {
              const on = tool === EditTool.AREA_PAINT && editor.selectedAreaLabel === a.label;
              const folders = Object.keys(areaMappings).filter((f) =>
                areaMappings[f].includes(a.label),
              );
              return (
                <div
                  key={a.label}
                  className={`flex flex-col gap-6 p-10 border rounded-ui ${on ? 'border-accent bg-active-bg' : 'border-border'}`}
                >
                  <div className="flex items-center gap-8">
                    <span
                      className="w-12 h-12 rounded-full shrink-0"
                      style={{ background: a.color }}
                    />
                    <b className="flex-1 min-w-0 truncate">{a.label}</b>
                    <Button
                      size="sm"
                      variant={on ? 'active' : 'default'}
                      onClick={() => {
                        if (editorState.activeTool !== EditTool.AREA_PAINT) {
                          editor.handleToolChange(EditTool.AREA_PAINT);
                        }
                        editor.handleSelectArea(a.label);
                      }}
                    >
                      {on ? 'Painting…' : 'Paint'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => editor.handleRemoveArea(a.label)}
                      aria-label={`Remove ${a.label}`}
                    >
                      ×
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-4">
                    {folders.map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => onAreaMappingChange(f, a.label, 'remove')}
                        title="Untie this folder"
                        className="text-2xs px-8 py-2 rounded-full bg-bg-thumb border-0 text-text cursor-pointer"
                      >
                        {f} ×
                      </button>
                    ))}
                    {areaFolders.some((f) => !folders.includes(f.name)) && (
                      <select
                        value=""
                        onChange={(e) =>
                          e.target.value && onAreaMappingChange(e.target.value, a.label, 'add')
                        }
                        className="text-2xs py-2 px-6 bg-bg-dark border border-border rounded-ui text-text"
                        aria-label={`Tie a folder to ${a.label}`}
                      >
                        <option value="">+ folder…</option>
                        {areaFolders
                          .filter((f) => !folders.includes(f.name))
                          .map((f) => (
                            <option key={f.path} value={f.name}>
                              {f.name}
                            </option>
                          ))}
                      </select>
                    )}
                  </div>
                </div>
              );
            })}
          <form
            className="flex gap-6"
            onSubmit={(e) => {
              e.preventDefault();
              const name = areaDraft.trim();
              const areas = layout.areas ?? [];
              if (!name || areas.some((a) => a.label === name)) return;
              editor.handleAddArea(
                name,
                AREA_DEFAULT_COLORS[areas.length % AREA_DEFAULT_COLORS.length],
              );
              setAreaDraft('');
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <input
              value={areaDraft}
              onChange={(e) => setAreaDraft(e.target.value)}
              placeholder="New area name…"
              aria-label="New area name"
              className="flex-1 min-w-0 h-32 px-10 bg-bg-dark border border-border rounded-ui text-text text-sm"
            />
            <Button type="submit" size="sm">
              Add area
            </Button>
          </form>
        </div>

        <div className="flex flex-col gap-8 pb-4">
          <span className={h3}>Pets</span>
          <div className="flex flex-col gap-4">
            {getPetCount() === 0 && (
              <span className="text-2xs text-text-muted">No pets are installed.</span>
            )}
            {Array.from({ length: getPetCount() }, (_, i) => {
              const on = officeState.getActivePetTypes().includes(i);
              return (
                <Checkbox
                  key={i}
                  label={getPetName(i)}
                  checked={on}
                  onChange={() => editor.handlePetToggle(i, !on)}
                />
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
