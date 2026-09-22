#!/usr/bin/env node
/* eslint-disable pixel-agents/no-inline-colors -- this file is sprite art: its colors are the pixels */
/**
 * Draws the "office life" furniture set (standing desk, bean bag, rug, floor
 * lamp, printer, server rack, water cooler, vending machine, fridge, arcade
 * cabinet, ping-pong table, fish tank, wall TV) as pixel sprites and writes
 * each item's folder + manifest.json under webview-ui/public/assets/furniture/.
 *
 * Sprites are drawn from rectangles so they can be tweaked here and
 * regenerated: `node scripts/generate-office-furniture.mjs`. Existing folders
 * with the same id are overwritten.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'webview-ui', 'public', 'assets', 'furniture');

const OUTLINE = '#1e1e2e';

function hex(color) {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
  if (!m) throw new Error(`bad color ${color}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, m[2] ? parseInt(m[2], 16) : 255];
}

/** A sprite canvas: rect(x, y, w, h, color) and px(x, y, color). */
function sprite(w, h, draw) {
  const png = new PNG({ width: w, height: h });
  png.data.fill(0);
  const rect = (x, y, rw, rh, color) => {
    const [r, g, b, a] = hex(color);
    for (let yy = Math.max(0, y); yy < Math.min(h, y + rh); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(w, x + rw); xx++) {
        const i = (yy * w + xx) * 4;
        png.data[i] = r;
        png.data[i + 1] = g;
        png.data[i + 2] = b;
        png.data[i + 3] = a;
      }
    }
  };
  const px = (x, y, color) => rect(x, y, 1, 1, color);
  /** Filled box with a 1px outline. */
  const box = (x, y, bw, bh, fill, edge = OUTLINE) => {
    rect(x, y, bw, bh, edge);
    rect(x + 1, y + 1, bw - 2, bh - 2, fill);
  };
  draw({ rect, px, box });
  return PNG.sync.write(png);
}

// ── Drawings ────────────────────────────────────────────────────

const standingDesk = ({ rect, box }) => {
  rect(3, 18, 2, 13, '#2e2940');
  rect(27, 18, 2, 13, '#2e2940');
  rect(2, 30, 6, 2, '#2e2940');
  rect(24, 30, 6, 2, '#2e2940');
  box(0, 14, 32, 5, '#c9c2d8');
  rect(1, 15, 30, 1, '#e8e3f0');
  box(10, 2, 13, 10, '#0c1522');
  rect(11, 3, 11, 8, '#3a7bd5');
  rect(12, 4, 6, 1, '#9fd4ff');
  rect(12, 6, 8, 1, '#6aa6ff');
  rect(15, 12, 3, 2, '#2e2940');
};

const beanBag = ({ rect }) => {
  rect(2, 5, 12, 10, '#6a2a2a');
  rect(1, 7, 14, 7, '#6a2a2a');
  rect(3, 6, 10, 8, '#b04a4a');
  rect(2, 8, 12, 5, '#d9604f');
  rect(4, 7, 5, 2, '#f08a70');
  rect(3, 14, 10, 1, '#4a1a1a');
};

const rug = ({ rect }) => {
  rect(0, 2, 48, 28, '#3a2a6a');
  rect(1, 3, 46, 26, '#5a3f8a');
  rect(4, 6, 40, 20, '#7d5fb0');
  rect(7, 9, 34, 14, '#5a3f8a');
  rect(10, 12, 28, 8, '#c9a7ff');
  for (let x = 2; x < 46; x += 4) {
    rect(x, 0, 2, 2, '#c9a7ff');
    rect(x, 30, 2, 2, '#c9a7ff');
  }
};

const floorLamp =
  (on) =>
  ({ rect }) => {
    if (on) rect(0, 0, 16, 10, '#ffd96633');
    rect(4, 1, 8, 7, OUTLINE);
    rect(5, 2, 6, 5, on ? '#ffe9a3' : '#b8b2a0');
    rect(3, 7, 10, 1, on ? '#d4b24a' : '#8a8472');
    rect(7, 8, 2, 20, '#2e2940');
    rect(4, 28, 8, 3, '#2e2940');
    rect(5, 28, 6, 1, '#4a4458');
  };

const printer = ({ rect, box }) => {
  rect(4, 1, 8, 5, '#f4f2ea');
  rect(4, 1, 8, 1, '#d8d4c8');
  box(1, 5, 14, 9, '#c9c9d6');
  rect(2, 6, 12, 3, '#e8e8f0');
  rect(4, 10, 8, 1, OUTLINE);
  rect(11, 7, 2, 1, '#89d185');
  rect(1, 14, 14, 1, '#8a8aa6');
};

const serverRack =
  (lights) =>
  ({ rect, box }) => {
    box(1, 0, 14, 31, '#2e3444');
    for (let i = 0; i < 6; i++) {
      const y = 2 + i * 4;
      rect(3, y, 10, 3, '#3a4256');
      const blink = lights === null ? false : (i + lights) % 2 === 0;
      rect(4, y + 1, 1, 1, lights === null ? '#2a3040' : blink ? '#89d185' : '#3794ff');
      rect(6, y + 1, 1, 1, lights === null ? '#2a3040' : blink ? '#3794ff' : '#89d185');
      rect(9, y + 1, 3, 1, '#262c3a');
    }
    rect(2, 27, 12, 3, '#1e2230');
  };

const waterCooler = ({ rect, box }) => {
  rect(4, 0, 8, 10, OUTLINE);
  rect(5, 1, 6, 9, '#9fd4ff');
  rect(5, 1, 6, 3, '#c8ecff');
  rect(6, 4, 1, 4, '#e8f7ff');
  box(2, 10, 12, 20, '#e8e8f0');
  rect(4, 14, 2, 2, '#3794ff');
  rect(10, 14, 2, 2, '#d14249');
  rect(4, 18, 8, 1, '#b8b8c8');
  rect(3, 29, 10, 2, '#8a8aa6');
};

const vendingMachine = ({ rect, box }) => {
  box(0, 0, 16, 31, '#d14249');
  rect(2, 2, 9, 19, OUTLINE);
  const cans = ['#ffd966', '#89d185', '#3794ff', '#ff8d14'];
  for (let r = 0; r < 4; r++) {
    for (let k = 0; k < 3; k++) rect(3 + k * 3, 3 + r * 4 + 1, 2, 3, cans[(r + k) % 4]);
    rect(3, 3 + r * 4 + 4, 8, 1, '#3a3a4a');
  }
  rect(12, 4, 3, 6, '#2e2940');
  rect(13, 5, 1, 1, '#89d185');
  rect(12, 12, 3, 2, '#ffd966');
  rect(2, 23, 9, 4, '#2e2940');
  rect(1, 30, 14, 1, '#8a2a30');
};

const fridge = ({ rect, box }) => {
  box(1, 0, 14, 31, '#dfe7f2', '#6a7488');
  rect(2, 10, 12, 1, '#6a7488');
  rect(11, 3, 2, 5, '#8a94a8');
  rect(11, 13, 2, 8, '#8a94a8');
  rect(3, 16, 3, 3, '#ffd966');
  rect(4, 22, 3, 2, '#89d185');
  rect(2, 30, 12, 1, '#4a5468');
};

const arcade =
  (screen) =>
  ({ rect, box }) => {
    box(1, 0, 14, 31, '#2c2b6d');
    rect(2, 1, 12, 3, '#ff5fa2');
    rect(3, 5, 10, 9, '#0c1522');
    if (screen === null) {
      rect(4, 6, 8, 7, '#1b2140');
    } else {
      rect(4, 6, 8, 7, '#6030ff');
      rect(5 + screen, 8, 2, 2, '#89d185');
      rect(9 - screen, 11, 2, 1, '#ffd966');
    }
    rect(2, 15, 12, 4, '#1e1e2e');
    rect(4, 16, 2, 2, '#ffd966');
    rect(9, 16, 1, 1, '#d14249');
    rect(11, 17, 1, 1, '#3794ff');
    rect(2, 19, 12, 11, '#3a3890');
    rect(5, 22, 6, 1, '#2c2b6d');
  };

const pingPong = ({ rect }) => {
  rect(3, 20, 2, 11, OUTLINE);
  rect(43, 20, 2, 11, OUTLINE);
  rect(0, 6, 48, 15, OUTLINE);
  rect(1, 7, 46, 13, '#2f7d4a');
  rect(1, 7, 46, 1, '#3f9a5c');
  rect(23, 5, 2, 16, '#f4f2ea');
  rect(1, 13, 46, 1, '#f4f2ea');
  rect(8, 2, 4, 4, '#d14249');
  rect(9, 5, 2, 2, '#8a5a3a');
  rect(36, 10, 2, 2, '#ffffff');
};

const fishTank =
  (frame) =>
  ({ rect }) => {
    rect(0, 4, 32, 20, OUTLINE);
    rect(1, 5, 30, 18, '#3a7bd5');
    rect(1, 5, 30, 4, '#6aa6ff');
    const fx = frame === 0 ? 6 : 9;
    rect(fx, 11, 4, 3, '#ff8d14');
    rect(fx + 4, 12, 1, 1, '#ff8d14');
    const gx = frame === 0 ? 20 : 17;
    rect(gx, 16, 3, 2, '#ffd966');
    rect(gx - 1, 16, 1, 1, '#ffd966');
    rect(26, 10, 1, 11, '#3c8a4a');
    rect(24, 13, 1, 8, '#4ea35c');
    rect(1, 20, 30, 3, '#c9a15a');
    rect(frame === 0 ? 12 : 13, frame === 0 ? 8 : 7, 1, 1, '#e8f7ff');
    rect(0, 24, 32, 8, '#4a2f1c');
    rect(1, 25, 30, 6, '#6b4428');
  };

const wallTv =
  (on) =>
  ({ rect }) => {
    rect(0, 4, 32, 20, '#0c1522');
    rect(1, 5, 30, 18, '#1b3350');
    if (on) {
      rect(3, 7, 26, 14, '#3a7bd5');
      rect(5, 9, 10, 2, '#9fd4ff');
      rect(5, 13, 18, 2, '#6aa6ff');
      rect(19, 9, 8, 2, '#89d185');
      rect(5, 17, 6, 2, '#ffd966');
    } else {
      rect(3, 7, 26, 14, '#162336');
      rect(5, 8, 6, 1, '#223550');
    }
    rect(14, 24, 4, 2, '#2e2940');
  };

// ── Manifests ───────────────────────────────────────────────────

const items = [];

function asset(id, w, h, fw, fh, draw, extra = {}) {
  return { id, file: `${id}.png`, w, h, fw, fh, draw, extra };
}

function single(id, name, category, a, opts = {}) {
  items.push({
    id,
    manifest: {
      id,
      name,
      category,
      type: 'asset',
      canPlaceOnWalls: opts.walls === true,
      canPlaceOnSurfaces: opts.surfaces === true,
      backgroundTiles: opts.bg ?? 0,
      width: a.w,
      height: a.h,
      footprintW: a.fw,
      footprintH: a.fh,
      ...(opts.orientation ? { orientation: opts.orientation } : {}),
    },
    files: [a],
  });
}

function assetEntry(a, extra) {
  return {
    type: 'asset',
    id: a.id,
    file: a.file,
    width: a.w,
    height: a.h,
    footprintW: a.fw,
    footprintH: a.fh,
    ...extra,
  };
}

/** on/off pair; `on` may be several animation frames. */
function stateGroup(id, name, category, onFrames, off, opts = {}) {
  const onMember =
    onFrames.length === 1
      ? assetEntry(onFrames[0], { state: 'on' })
      : {
          type: 'group',
          groupType: 'animation',
          state: 'on',
          members: onFrames.map((a, frame) => assetEntry(a, { frame })),
        };
  items.push({
    id,
    manifest: {
      id,
      name,
      category,
      type: 'group',
      groupType: 'state',
      canPlaceOnWalls: opts.walls === true,
      canPlaceOnSurfaces: opts.surfaces === true,
      backgroundTiles: opts.bg ?? 0,
      members: [onMember, assetEntry(off, { state: 'off' })],
    },
    files: [...onFrames, off],
  });
}

function animated(id, name, category, frames, opts = {}) {
  items.push({
    id,
    manifest: {
      id,
      name,
      category,
      type: 'group',
      groupType: 'animation',
      canPlaceOnWalls: false,
      canPlaceOnSurfaces: false,
      backgroundTiles: opts.bg ?? 0,
      members: frames.map((a, frame) => assetEntry(a, { frame })),
    },
    files: frames,
  });
}

single(
  'STANDING_DESK',
  'Standing Desk',
  'desks',
  asset('STANDING_DESK', 32, 32, 2, 2, standingDesk),
  { bg: 1 },
);
single('BEAN_BAG', 'Bean Bag', 'chairs', asset('BEAN_BAG', 16, 16, 1, 1, beanBag));
single('RUG', 'Rug', 'decor', asset('RUG', 48, 32, 3, 2, rug), { bg: 2 });
stateGroup(
  'FLOOR_LAMP',
  'Floor Lamp',
  'decor',
  [asset('FLOOR_LAMP_ON', 16, 32, 1, 2, floorLamp(true))],
  asset('FLOOR_LAMP_OFF', 16, 32, 1, 2, floorLamp(false)),
  { bg: 1 },
);
single('PRINTER', 'Printer', 'electronics', asset('PRINTER', 16, 16, 1, 1, printer), {
  surfaces: true,
});
stateGroup(
  'SERVER_RACK',
  'Server Rack',
  'electronics',
  [
    asset('SERVER_RACK_ON_1', 16, 32, 1, 2, serverRack(0)),
    asset('SERVER_RACK_ON_2', 16, 32, 1, 2, serverRack(1)),
  ],
  asset('SERVER_RACK_OFF', 16, 32, 1, 2, serverRack(null)),
  { bg: 1 },
);
single('WATER_COOLER', 'Water Cooler', 'misc', asset('WATER_COOLER', 16, 32, 1, 2, waterCooler), {
  bg: 1,
});
single(
  'VENDING_MACHINE',
  'Vending Machine',
  'misc',
  asset('VENDING_MACHINE', 16, 32, 1, 2, vendingMachine),
  { bg: 1 },
);
single('FRIDGE', 'Fridge', 'misc', asset('FRIDGE', 16, 32, 1, 2, fridge), { bg: 1 });
stateGroup(
  'ARCADE_CABINET',
  'Arcade Cabinet',
  'electronics',
  [
    asset('ARCADE_CABINET_ON_1', 16, 32, 1, 2, arcade(0)),
    asset('ARCADE_CABINET_ON_2', 16, 32, 1, 2, arcade(1)),
  ],
  asset('ARCADE_CABINET_OFF', 16, 32, 1, 2, arcade(null)),
  { bg: 1 },
);
single(
  'PING_PONG_TABLE',
  'Ping-Pong Table',
  'misc',
  asset('PING_PONG_TABLE', 48, 32, 3, 2, pingPong),
  { bg: 1 },
);
animated(
  'FISH_TANK',
  'Fish Tank',
  'decor',
  [
    asset('FISH_TANK_1', 32, 32, 2, 2, fishTank(0)),
    asset('FISH_TANK_2', 32, 32, 2, 2, fishTank(1)),
  ],
  { bg: 1 },
);
stateGroup(
  'WALL_TV',
  'Wall TV',
  'wall',
  [asset('WALL_TV_ON', 32, 32, 2, 2, wallTv(true))],
  asset('WALL_TV_OFF', 32, 32, 2, 2, wallTv(false)),
  { walls: true },
);

for (const item of items) {
  const dir = path.join(OUT, item.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of item.files) fs.writeFileSync(path.join(dir, f.file), sprite(f.w, f.h, f.draw));
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(item.manifest, null, 2)}\n`);
  console.log(
    `wrote ${item.id} (${item.files.length} sprite${item.files.length === 1 ? '' : 's'})`,
  );
}
