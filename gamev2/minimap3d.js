// game3d/minimap3d.js — map painting for the 3D HUD (minimap + full-screen tactical map) plus
// shared read-only helpers over sim ships (class, visibility, naming). The map is drawn as a
// sea chart: token colours (theme.js), a kilometre grid and a graduated neatline border.
//
// Renderer3D imports HudCanvases3D and calls draw(world) inside render(). main3d.js does NOT
// hand the renderer any canvas: it owns its own HudCanvases3D and draws after render with the
// camera/intel extras, so the renderer's instance stays a harmless no-op either way.
import { WORLD } from './config.js';
import { drawSubMap } from './subui.js';
import { T, rgba, FONT, MONO } from './theme.js';
import { drawAirMap } from './airui.js';
import { drawMissileMap } from './missileui.js';

const TAU = Math.PI * 2;
const ZONE_DASH = [6, 4], NO_DASH = [];   // shared, no per-frame arrays
export const COL = {
   ally: T.ally, enemy: T.enemy, self: T.self, neutral: T.neutral,
   allyDim: rgba(T.ally, 0.45), enemyDim: rgba(T.enemy, 0.4),
};
// chart palette (resolved once; the minimap repaints every frame)
const MAP = {
   sea: T['map-sea'], sea2: T['map-sea-2'], land: T['map-land'], coast: T['map-coast'],
   grid: rgba(T['map-grid'], 0.12), label: rgba(T['map-grid'], 0.6), ink: T['map-ink'], frame: rgba(T['map-grid'], 0.7),
   shoal: rgba(T['map-coast'], 0.18), smoke: 'rgba(214,210,198,0.38)',
   capN: rgba(T.neutral, 0.1), capA: rgba(T.ally, 0.14), capE: rgba(T.enemy, 0.15),
   zoneA: rgba(T.ally, 0.1), zoneE: rgba(T.enemy, 0.11),
   cone: rgba(T.self, 0.2), cone0: rgba(T.self, 0), detect: rgba(T['ally-soft'], 0.55), guns: rgba(T.self, 0.55),
   fan: rgba(T.gold, 0.6), torpOwn: rgba(T.torp, 0.9), torpFoe: T.enemy, aim: rgba(T.gold, 0.95), hullEdge: 'rgba(0,0,0,0.7)',
   knife: 'rgba(0,0,0,0.62)',
};
const MAP_FONT = T.font;
// Grid spacing (world metres) for a map of half-size A: the first of 1/2/5/10 km that gives at
// most 8 squares across. The tactical-map legend prints it.
export function gridStep(A) {
   for (const st of [1000, 2000, 5000, 10000]) if ((2 * A) / st <= 8) return st;
   return 20000;
}

// ---------- shared ship helpers (contract fields first, old-sim fallbacks second) ----------
const OLD_TYPE = { DD: 'DD', LC: 'CL', HC: 'CA', EB: 'BB', Bismarck: 'BB' };
export function shipType(s) { return s?.cfg?.hull?.type || OLD_TYPE[s?.cls] || s?.cfg?.type || 'CA'; }
// Speed for display. The contract sim gives speedKn; the old arcade sim moves ~90 m/s, so its
// speed is shown as a fraction of a plausible top speed for the class instead.
const REAL_KN = { DD: 38, CL: 34, CA: 32, BB: 30, SS: 18 };
export function displayKn(s) {
   if (s?.speedKn != null) return s.speedKn;
   if (s?.maxSpeed > 0) return Math.abs(s.speed || 0) / s.maxSpeed * (REAL_KN[shipType(s)] || 30);
   return Math.abs(s?.speed || 0) * 1.94384;
}
export const TYPE_NAME = { DD: 'Zerstörer', CL: 'Leichter Kreuzer', CA: 'Schwerer Kreuzer', BB: 'Schlachtschiff', CV: 'Flugzeugträger', TR: 'Transporter', SS: 'U-Boot' };
export const TYPE_SHORT = { DD: 'Z', CL: 'LK', CA: 'SK', BB: 'SS', CV: 'FT', TR: 'TR', SS: 'UB' };
export function shipLen(s) {
   return s?.cfg?.hull?.L || ({ DD: 120, LC: 170, HC: 205, EB: 251, Bismarck: 251 }[s?.cls]) || 180;
}
export function isAlly(world, s) { const p = world.player; return !!p && s.side === p.side; }
// Enemy visible to the player's team: contract `ship.spotted`, else world.isSpotted(ship).
export function isVisible(world, s) {
   if (isAlly(world, s)) return true;
   if (typeof s.spotted === 'boolean') return s.spotted;
   if (typeof world.isSpotted === 'function') { try { return !!world.isSpotted(s); } catch (e) { return true; } }
   return true;
}
export const isGone = (s) => !s.alive;
export function torpSide(t) { return t.side ?? t.owner; }
export function torpHeading(t) { return t.heading ?? t.dir ?? (t.vel ? Math.atan2(t.vel.y, t.vel.x) : 0); }
export function arenaOf(world) { return world?.arena || WORLD.ARENA || 3800; }

// Class glyph, the same shapes as hud.js classSvg: capital ships are discs with one cut-out bar
// per weight class (CL 1, CA 2, BB 3), DD an upward triangle, SS a dome with a mast, CV a flat
// deck, TR a hollow square.
export function drawClassIcon(g, type, x, y, size, color, opts = {}) {
   const s = size;
   g.save();
   g.translate(x, y);
   if (opts.rot != null) g.rotate(opts.rot);
   g.lineWidth = opts.lineWidth || Math.max(1, s * 0.16);
   g.strokeStyle = color; g.fillStyle = color;
   g.beginPath();
   let bars = 0, hollow = !!opts.hollow;
   if (type === 'DD') {
      g.moveTo(0, -s * 0.5); g.lineTo(s * 0.46, s * 0.4); g.lineTo(-s * 0.46, s * 0.4); g.closePath();
   } else if (type === 'SS') {                       // U-Boot: dome + mast
      g.moveTo(-s * 0.46, s * 0.3); g.arc(0, s * 0.3, s * 0.46, Math.PI, TAU); g.closePath();
      g.rect(-s * 0.06, -s * 0.48, s * 0.12, s * 0.3);
   } else if (type === 'CV') {
      g.rect(-s * 0.5, -s * 0.22, s, s * 0.44);
   } else if (type === 'TR') {
      g.rect(-s * 0.34, -s * 0.34, s * 0.68, s * 0.68);
      hollow = true; g.lineWidth = Math.max(1.2, s * 0.15);
   } else {
      g.arc(0, 0, s * 0.46, 0, TAU);
      bars = type === 'BB' ? 3 : type === 'CA' ? 2 : 1;
   }
   if (hollow) g.stroke(); else g.fill();
   if (!hollow && (bars || type === 'CV')) {
      g.strokeStyle = MAP.knife; g.lineWidth = Math.max(1, s * 0.1);
      g.beginPath();
      if (type === 'CV') { g.moveTo(-s * 0.38, 0); g.lineTo(s * 0.38, 0); }
      else for (let i = 0; i < bars; i++) {
         const yy = (i - (bars - 1) / 2) * s * 0.18;
         g.moveTo(-s * 0.28, yy); g.lineTo(s * 0.28, yy);
      }
      g.stroke();
   }
   if (opts.cross) {
      g.strokeStyle = opts.crossColor || '#111'; g.lineWidth = Math.max(1.4, s * 0.2);
      g.beginPath(); g.moveTo(-s * 0.6, -s * 0.6); g.lineTo(s * 0.6, s * 0.6); g.moveTo(s * 0.6, -s * 0.6); g.lineTo(-s * 0.6, s * 0.6); g.stroke();
   }
   g.restore();
}

function islandPath(g, o, mx, my, sc) {
   if (Array.isArray(o.lobes) && o.lobes.length > 2 && typeof o.lobes[0] === 'object' && 'a' in o.lobes[0]) {
      o.lobes.forEach((l, i) => {
         const x = mx(o.c.x + Math.cos(l.a) * l.r), y = my(o.c.y + Math.sin(l.a) * l.r);
         i ? g.lineTo(x, y) : g.moveTo(x, y);
      });
      g.closePath();
   } else if (Array.isArray(o.poly) && o.poly.length > 2) {
      o.poly.forEach((q, i) => { i ? g.lineTo(mx(q.x), my(q.y)) : g.moveTo(mx(q.x), my(q.y)); });
      g.closePath();
   } else {
      g.arc(mx(o.c.x), my(o.c.y), Math.max(2, o.r * sc), 0, TAU);
   }
}

// Paint the battlefield into the square (x0, y0, size). opts: { intel, camYaw, camHfov,
// gunRange, detectRange, aimPoint, big (tactical map: labels + names), torpFan }.
// Everything (range rings, detection circles, labels) is clipped to the map square: the gun
// range circle of a long-range ship easily reaches past the edge of the tactical map.
export function paintMap(g, world, x0, y0, size, opts = {}) {
   g.save();
   g.beginPath(); g.rect(x0, y0, size, size); g.clip();
   try { paintMapInner(g, world, x0, y0, size, opts); } finally { g.restore(); }
}
function paintMapInner(g, world, x0, y0, size, opts) {
   const A = arenaOf(world);
   const sc = size / (A * 2);
   const mx = (x) => x0 + (x + A) * sc, my = (y) => y0 + (y + A) * sc;
   const p = world.player;
   const big = !!opts.big;

   // sea: chart blue, a touch lighter towards the top
   const grd = g.createLinearGradient(x0, y0, x0, y0 + size);
   grd.addColorStop(0, MAP.sea); grd.addColorStop(1, MAP.sea2);
   g.fillStyle = grd; g.fillRect(x0, y0, size, size);

   // kilometre grid from the centre of the arena (no lettered squares)
   const step = gridStep(A), n = Math.floor(A / step);
   g.strokeStyle = MAP.grid; g.lineWidth = 1;
   g.beginPath();
   for (let i = -n; i <= n; i++) {
      const q = Math.round(mx(i * step)) + 0.5, r = Math.round(my(i * step)) + 0.5;
      g.moveTo(q, y0); g.lineTo(q, y0 + size);
      g.moveTo(x0, r); g.lineTo(x0 + size, r);
   }
   g.stroke();

   // terrain: land with a light coastline and a faint shoal halo
   for (const o of world.obstacles || []) {
      g.beginPath(); islandPath(g, o, mx, my, sc);
      if (o.kind === 'island') {
         g.strokeStyle = MAP.shoal; g.lineWidth = big ? 5 : 3; g.stroke();
         g.fillStyle = MAP.land; g.fill(); g.strokeStyle = MAP.coast; g.lineWidth = 1; g.stroke();
      }
      else { g.fillStyle = 'rgba(90,200,180,0.22)'; g.fill(); }
   }

   // capture zones
   for (const c of world.caps || []) {
      const col = c.owner == null ? COL.neutral : (c.owner === p?.side ? COL.ally : COL.enemy);
      const x = mx(c.pos.x), y = my(c.pos.y), r = Math.max(6, c.r * sc);
      g.fillStyle = col === COL.neutral ? MAP.capN : (col === COL.ally ? MAP.capA : MAP.capE);
      g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      g.strokeStyle = col; g.lineWidth = c.contested ? 2 : 1.2;
      g.setLineDash(c.contested ? [4, 3] : []); g.stroke(); g.setLineDash([]);
      if (c.progress > 0 && c.capper) {
         g.strokeStyle = c.capper === p?.side ? COL.ally : COL.enemy; g.lineWidth = 3;
         g.beginPath(); g.arc(x, y, r + 2, -Math.PI / 2, -Math.PI / 2 + TAU * c.progress); g.stroke();
      }
      g.fillStyle = col; g.font = `bold ${big ? 16 : Math.max(9, Math.round(size / 26))}px ${MAP_FONT}`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(c.id || '?', x, y + 1);
   }

   // scripted mission zones (breakthrough goal / area the enemy must not reach)
   const zones = world.mission && world.mission.zones;
   if (zones) for (let i = 0; i < zones.length; i++) {
      const z = zones[i], x = mx(z.x), y = my(z.y), r = Math.max(6, z.r * sc);
      const col = z.kind === 'goal' ? COL.ally : COL.enemy;
      g.fillStyle = z.kind === 'goal' ? MAP.zoneA : MAP.zoneE;
      g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      g.strokeStyle = col; g.lineWidth = 1.4;
      g.setLineDash(ZONE_DASH); g.stroke(); g.setLineDash(NO_DASH);
      g.fillStyle = col; g.font = `bold ${big ? 13 : Math.max(8, Math.round(size / 32))}px ${MAP_FONT}`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(z.label, x, y);
   }

   // smoke
   for (const cl of world.smokeClouds || []) {
      g.fillStyle = MAP.smoke;
      g.beginPath(); g.arc(mx(cl.c.x), my(cl.c.y), Math.max(2, cl.r * sc), 0, TAU); g.fill();
   }

   if (p) {
      const px = mx(p.pos.x), py = my(p.pos.y);
      // camera view cone
      if (opts.camYaw != null && p.alive) {
         const hf = Math.min(1.6, opts.camHfov || 1.2) / 2, len = size * (big ? 0.12 : 0.2);
         const cg = g.createRadialGradient(px, py, 0, px, py, len);
         cg.addColorStop(0, MAP.cone); cg.addColorStop(1, MAP.cone0);
         g.fillStyle = cg;
         g.beginPath(); g.moveTo(px, py); g.arc(px, py, len, opts.camYaw - hf, opts.camYaw + hf); g.closePath(); g.fill();
      }
      // own circles: detectability (dashed) and main battery range (solid)
      if (p.alive) {
         g.lineWidth = 1;
         if (opts.detectRange) {
            g.strokeStyle = MAP.detect; g.setLineDash([3, 3]);
            g.beginPath(); g.arc(px, py, opts.detectRange * sc, 0, TAU); g.stroke(); g.setLineDash([]);
         }
         if (opts.gunRange) {
            g.strokeStyle = MAP.guns;
            g.beginPath(); g.arc(px, py, opts.gunRange * sc, 0, TAU); g.stroke();
         }
      }
      // torpedo fan preview (tactical map / minimap in torpedo mode)
      if (opts.torpFan && p.alive) {
         const f = opts.torpFan;
         g.strokeStyle = MAP.fan; g.lineWidth = 1;
         g.beginPath();
         for (const b of f.bearings) { g.moveTo(px, py); g.lineTo(mx(p.pos.x + Math.cos(b) * f.range), my(p.pos.y + Math.sin(b) * f.range)); }
         g.stroke();
      }
   }

   // torpedoes (own/allied always, enemy only when spotted)
   for (const t of world.torpedoes || []) {
      const mine = p && torpSide(t) === p.side;
      if (!mine && t.spotted === false) continue;
      const h = torpHeading(t), x = mx(t.pos.x), y = my(t.pos.y);
      g.strokeStyle = mine ? MAP.torpOwn : MAP.torpFoe; g.lineWidth = big ? 2 : 1.4;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x - Math.cos(h) * (big ? 9 : 5), y - Math.sin(h) * (big ? 9 : 5)); g.stroke();
   }

   // last-known positions of enemies that dropped out of spotting
   const intel = opts.intel;
   if (intel) {
      for (const [, k] of intel.lastKnown) {
         if (k.visible || !k.alive) continue;
         const age = world.time - k.t;
         const a = Math.max(0.25, 0.8 - age / 90);
         const x = mx(k.x), y = my(k.y);
         drawClassIcon(g, k.type, x, y, big ? 14 : Math.max(8, size / 26), rgba(T.enemy, a.toFixed(2)), { hollow: true, lineWidth: 1.2 });
         if (big) {
            g.fillStyle = rgba(T['enemy-soft'], a.toFixed(2)); g.font = FONT(11);
            g.textAlign = 'center'; g.textBaseline = 'top';
            g.fillText(k.name + ' (' + Math.round(age) + 's)', x, y + 9);
         }
      }
   }

   if (opts.sub) drawSubMap(g, opts.sub, p, mx, my, size, world.time || 0);

   // ships
   const base = big ? 13 : Math.max(8, size / 24);
   for (const s of world.ships || []) {
      if (!s.alive) continue;
      const self = s === p;
      const ally = !self && p && s.side === p.side;
      if (!self && !ally && !isVisible(world, s)) continue;
      const x = mx(s.pos.x), y = my(s.pos.y);
      const type = shipType(s);
      const sz = base * (type === 'BB' ? 1.15 : type === 'DD' ? 0.85 : 1) * (self ? 1.25 : 1);
      const col = self ? COL.self : ally ? COL.ally : COL.enemy;
      g.save(); g.translate(x, y); g.rotate(s.heading + Math.PI / 2);
      // hull outline: pointed bow, square stern
      g.fillStyle = col; g.strokeStyle = MAP.hullEdge; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, -sz * 0.62); g.lineTo(sz * 0.27, -sz * 0.12); g.lineTo(sz * 0.27, sz * 0.48); g.lineTo(-sz * 0.27, sz * 0.48); g.lineTo(-sz * 0.27, -sz * 0.12); g.closePath();
      g.fill(); g.stroke();
      g.restore();
      if (big && !self) {
         g.fillStyle = col; g.font = FONT(12); g.textAlign = 'center'; g.textBaseline = 'top';
         g.fillText(s.name || s.cls || '', x, y + sz * 0.7);
      }
   }

   // squadrons the team can see (airui.js)
   if (world.squadrons?.length) drawAirMap(g, world, p, mx, my, big, opts.airCtl ?? null);
   // missiles, decoy clouds, land positions, ESM bearings, map targeting (missileui.js)
   drawMissileMap(g, world, p, mx, my, sc, big, opts);

   // aim point
   if (opts.aimPoint && p?.alive) {
      const x = mx(opts.aimPoint.x), y = my(opts.aimPoint.y);
      g.strokeStyle = MAP.aim; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(x - 4, y); g.lineTo(x + 4, y); g.moveTo(x, y - 4); g.lineTo(x, y + 4); g.stroke();
   }

   // graduated neatline: a band of alternating ink / chart-paper segments (half a grid square
   // each) inside a thin frame, like the border of a printed sea chart; km figures on the big map
   const bw = big ? 6 : 4, half = step / 2, m = Math.ceil(A / half);
   g.fillStyle = MAP.ink;
   g.fillRect(x0, y0, size, bw); g.fillRect(x0, y0 + size - bw, size, bw);
   g.fillRect(x0, y0, bw, size); g.fillRect(x0 + size - bw, y0, bw, size);
   g.fillStyle = MAP.coast;
   for (let i = -m; i < m; i += 2) {
      const a0 = Math.max(x0, mx(i * half)), a1 = Math.min(x0 + size, mx((i + 1) * half));
      if (a1 <= a0) continue;
      g.fillRect(a0, y0 + 1, a1 - a0, bw - 2); g.fillRect(a0, y0 + size - bw + 1, a1 - a0, bw - 2);
      const b0 = Math.max(y0, my(i * half)), b1 = Math.min(y0 + size, my((i + 1) * half));
      g.fillRect(x0 + 1, b0, bw - 2, b1 - b0); g.fillRect(x0 + size - bw + 1, b0, bw - 2, b1 - b0);
   }
   g.strokeStyle = MAP.frame; g.lineWidth = 1;
   g.strokeRect(x0 + bw + 0.5, y0 + bw + 0.5, size - 2 * bw - 1, size - 2 * bw - 1);
   if (big) {
      g.fillStyle = MAP.label; g.font = MONO(11); g.textBaseline = 'top'; g.textAlign = 'center';
      for (let i = -n; i <= n; i++) {
         if (!i) continue;
         g.fillText(String(Math.abs(i * step / 1000)), mx(i * step), y0 + bw + 3);
      }
      g.textAlign = 'left'; g.textBaseline = 'middle';
      for (let i = -n; i <= n; i++) {
         if (!i) continue;
         g.fillText(String(Math.abs(i * step / 1000)), x0 + bw + 4, my(i * step));
      }
   }
}

// Keeps the renderer's call site (hudCanvases.draw(world)) working; main3d owns its own instance.
export class HudCanvases3D {
   constructor() { this.minimap = null; this.compass = null; this.opts = {}; }
   setCanvases(minimap, compass) { this.minimap = minimap || null; this.compass = compass || null; }
   draw(world, opts) {
      if (!this.minimap || !world) return;
      const c = this.minimap, g = c.getContext('2d');
      const size = c.clientWidth || 240;
      const dpr = c.width / size || 1;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, size, size);
      paintMap(g, world, 0, 0, size, opts || this.opts);
   }
}
