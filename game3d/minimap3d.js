// game3d/minimap3d.js — map painting for the 3D HUD (minimap + full-screen tactical map) plus
// shared read-only helpers over sim ships (class, visibility, naming).
//
// Renderer3D imports HudCanvases3D and calls draw(world) inside render(). main3d.js does NOT
// hand the renderer any canvas: it owns its own HudCanvases3D and draws after render with the
// camera/intel extras, so the renderer's instance stays a harmless no-op either way.
import { WORLD } from './config.js';

const TAU = Math.PI * 2;
export const COL = {
   ally: '#5dff8c', enemy: '#ff5a4d', self: '#ffffff', neutral: '#d8e6f2',
   allyDim: 'rgba(93,255,140,0.45)', enemyDim: 'rgba(255,90,77,0.4)',
};

// ---------- shared ship helpers (contract fields first, old-sim fallbacks second) ----------
const OLD_TYPE = { DD: 'DD', LC: 'CL', HC: 'CA', EB: 'BB', Bismarck: 'BB' };
export function shipType(s) { return s?.cfg?.hull?.type || OLD_TYPE[s?.cls] || s?.cfg?.type || 'CA'; }
// Speed for display. The contract sim gives speedKn; the old arcade sim moves ~90 m/s, so its
// speed is shown as a fraction of a plausible top speed for the class instead.
const REAL_KN = { DD: 38, CL: 34, CA: 32, BB: 30 };
export function displayKn(s) {
   if (s?.speedKn != null) return s.speedKn;
   if (s?.maxSpeed > 0) return Math.abs(s.speed || 0) / s.maxSpeed * (REAL_KN[shipType(s)] || 30);
   return Math.abs(s?.speed || 0) * 1.94384;
}
export const TYPE_NAME = { DD: 'Zerstörer', CL: 'Leichter Kreuzer', CA: 'Schwerer Kreuzer', BB: 'Schlachtschiff', CV: 'Flugzeugträger', TR: 'Transporter' };
export const TYPE_SHORT = { DD: 'Z', CL: 'LK', CA: 'SK', BB: 'SS', CV: 'FT', TR: 'TR' };
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

// Class glyph (WoWs-like): DD chevron, CL/CA diamond (+bar), BB diamond with two bars, CV box.
export function drawClassIcon(g, type, x, y, size, color, opts = {}) {
   const s = size;
   g.save();
   g.translate(x, y);
   if (opts.rot != null) g.rotate(opts.rot);
   g.lineWidth = opts.lineWidth || Math.max(1, s * 0.16);
   g.strokeStyle = color; g.fillStyle = color;
   g.beginPath();
   if (type === 'DD') {
      g.moveTo(0, -s * 0.55); g.lineTo(s * 0.5, s * 0.45); g.lineTo(0, s * 0.2); g.lineTo(-s * 0.5, s * 0.45); g.closePath();
   } else if (type === 'CV') {
      g.rect(-s * 0.5, -s * 0.34, s, s * 0.68);
   } else if (type === 'TR') {
      g.arc(0, 0, s * 0.4, 0, TAU);
   } else {
      g.moveTo(0, -s * 0.55); g.lineTo(s * 0.55, 0); g.lineTo(0, s * 0.55); g.lineTo(-s * 0.55, 0); g.closePath();
   }
   if (opts.hollow) g.stroke(); else g.fill();
   if (!opts.hollow && (type === 'CA' || type === 'BB')) {
      g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = Math.max(1, s * 0.12);
      g.beginPath();
      if (type === 'CA') { g.moveTo(-s * 0.28, 0); g.lineTo(s * 0.28, 0); }
      else { g.moveTo(-s * 0.3, -s * 0.12); g.lineTo(s * 0.3, -s * 0.12); g.moveTo(-s * 0.3, s * 0.14); g.lineTo(s * 0.3, s * 0.14); }
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

   // water
   const grd = g.createLinearGradient(x0, y0, x0, y0 + size);
   grd.addColorStop(0, '#11324b'); grd.addColorStop(1, '#0b2436');
   g.fillStyle = grd; g.fillRect(x0, y0, size, size);

   // grid: numbers 1-10 across, letters A-J down (WoWs convention)
   g.strokeStyle = 'rgba(160,200,235,0.13)'; g.lineWidth = 1;
   g.beginPath();
   for (let i = 1; i < 10; i++) {
      const q = Math.round(x0 + (size * i) / 10) + 0.5;
      g.moveTo(q, y0); g.lineTo(q, y0 + size);
      const r = Math.round(y0 + (size * i) / 10) + 0.5;
      g.moveTo(x0, r); g.lineTo(x0 + size, r);
   }
   g.stroke();
   g.fillStyle = 'rgba(190,215,240,0.5)';
   g.font = `${big ? 13 : Math.max(8, Math.round(size / 34))}px Consolas, monospace`;
   g.textAlign = 'center'; g.textBaseline = 'top';
   for (let i = 0; i < 10; i++) {
      g.fillText(String(i + 1), x0 + size * (i + 0.5) / 10, y0 + 2);
      g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillText('ABCDEFGHIJ'[i], x0 + 3, y0 + size * (i + 0.5) / 10);
      g.textAlign = 'center'; g.textBaseline = 'top';
   }

   // terrain
   for (const o of world.obstacles || []) {
      g.beginPath(); islandPath(g, o, mx, my, sc);
      if (o.kind === 'island') { g.fillStyle = '#6f7a55'; g.fill(); g.strokeStyle = '#c8b98a'; g.lineWidth = 1; g.stroke(); }
      else { g.fillStyle = 'rgba(90,200,180,0.22)'; g.fill(); }
   }

   // capture zones
   for (const c of world.caps || []) {
      const col = c.owner == null ? COL.neutral : (c.owner === p?.side ? COL.ally : COL.enemy);
      const x = mx(c.pos.x), y = my(c.pos.y), r = Math.max(6, c.r * sc);
      g.fillStyle = col === COL.neutral ? 'rgba(220,230,240,0.10)' : (col === COL.ally ? 'rgba(93,255,140,0.13)' : 'rgba(255,90,77,0.14)');
      g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      g.strokeStyle = col; g.lineWidth = c.contested ? 2 : 1.2;
      g.setLineDash(c.contested ? [4, 3] : []); g.stroke(); g.setLineDash([]);
      if (c.progress > 0 && c.capper) {
         g.strokeStyle = c.capper === p?.side ? COL.ally : COL.enemy; g.lineWidth = 3;
         g.beginPath(); g.arc(x, y, r + 2, -Math.PI / 2, -Math.PI / 2 + TAU * c.progress); g.stroke();
      }
      g.fillStyle = col; g.font = `bold ${big ? 16 : Math.max(9, Math.round(size / 26))}px Segoe UI, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(c.id || '?', x, y + 1);
   }

   // smoke
   for (const cl of world.smokeClouds || []) {
      g.fillStyle = 'rgba(200,205,210,0.35)';
      g.beginPath(); g.arc(mx(cl.c.x), my(cl.c.y), Math.max(2, cl.r * sc), 0, TAU); g.fill();
   }

   if (p) {
      const px = mx(p.pos.x), py = my(p.pos.y);
      // camera view cone
      if (opts.camYaw != null && p.alive) {
         const hf = Math.min(1.6, opts.camHfov || 1.2) / 2, len = size * (big ? 0.12 : 0.2);
         const cg = g.createRadialGradient(px, py, 0, px, py, len);
         cg.addColorStop(0, 'rgba(255,255,255,0.20)'); cg.addColorStop(1, 'rgba(255,255,255,0)');
         g.fillStyle = cg;
         g.beginPath(); g.moveTo(px, py); g.arc(px, py, len, opts.camYaw - hf, opts.camYaw + hf); g.closePath(); g.fill();
      }
      // own circles: detectability (dashed) and main battery range (solid)
      if (p.alive) {
         g.lineWidth = 1;
         if (opts.detectRange) {
            g.strokeStyle = 'rgba(160,210,255,0.55)'; g.setLineDash([3, 3]);
            g.beginPath(); g.arc(px, py, opts.detectRange * sc, 0, TAU); g.stroke(); g.setLineDash([]);
         }
         if (opts.gunRange) {
            g.strokeStyle = 'rgba(255,255,255,0.55)';
            g.beginPath(); g.arc(px, py, opts.gunRange * sc, 0, TAU); g.stroke();
         }
      }
      // torpedo fan preview (tactical map / minimap in torpedo mode)
      if (opts.torpFan && p.alive) {
         const f = opts.torpFan;
         g.strokeStyle = 'rgba(255,230,140,0.6)'; g.lineWidth = 1;
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
      g.strokeStyle = mine ? 'rgba(140,220,255,0.9)' : '#ff8a70'; g.lineWidth = big ? 2 : 1.4;
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
         drawClassIcon(g, k.type, x, y, big ? 14 : Math.max(8, size / 26), `rgba(255,120,100,${a})`, { hollow: true, lineWidth: 1.2 });
         if (big) {
            g.fillStyle = `rgba(255,160,140,${a})`; g.font = '11px Segoe UI, sans-serif';
            g.textAlign = 'center'; g.textBaseline = 'top';
            g.fillText(k.name + ' (' + Math.round(age) + 's)', x, y + 9);
         }
      }
   }

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
      g.fillStyle = col; g.strokeStyle = 'rgba(0,0,0,0.7)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, -sz * 0.6); g.lineTo(sz * 0.38, sz * 0.45); g.lineTo(0, sz * 0.25); g.lineTo(-sz * 0.38, sz * 0.45); g.closePath();
      g.fill(); g.stroke();
      g.restore();
      if (big && !self) {
         g.fillStyle = col; g.font = '12px Segoe UI, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'top';
         g.fillText(s.name || s.cls || '', x, y + sz * 0.7);
      }
   }

   // aim point
   if (opts.aimPoint && p?.alive) {
      const x = mx(opts.aimPoint.x), y = my(opts.aimPoint.y);
      g.strokeStyle = 'rgba(255,212,121,0.95)'; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(x - 4, y); g.lineTo(x + 4, y); g.moveTo(x, y - 4); g.lineTo(x, y + 4); g.stroke();
   }

   g.strokeStyle = 'rgba(150,190,230,0.45)'; g.lineWidth = 1;
   g.strokeRect(x0 + 0.5, y0 + 0.5, size - 1, size - 1);
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
