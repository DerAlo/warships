// game3d/hud3d.js — everything the HUD draws on the #fx canvas: the gun sight (hanging mil
// ticks, reload arcs either side, range + flight time, turret schematic, out-of-range feedback), floating
// ship markers, the lead ghost, the torpedo fan, torpedo warnings, binocular optics and the
// full-screen tactical map. Pure drawing from the `ui` snapshot main3d.js builds each frame.
import { paintMap, drawClassIcon, COL, gridStep, arenaOf } from './minimap3d.js';
import { drawSubUnder, drawPeriscope } from './subui.js';
import { T, rgba, FONT, MONO } from './theme.js';
import { drawAir } from './airui.js';
import { drawQuality, drawMissileHud, tacticalMapRect, mapTargetHint } from './missileui.js';
import { drawOpsHud, opsMapHint } from './opsui.js';

const TAU = Math.PI * 2;
const clamp01 = (x) => x < 0 ? 0 : x > 1 ? 1 : x;
const isTouch = () => typeof document !== 'undefined' && !!document.body?.classList.contains('touch');   // touch3d.js overlay on
const km = (m) => (m / 1000).toFixed(m < 9950 ? 2 : 1).replace('.', ',') + ' km';
const TURRET_COL = { ready: T.ok, traverse: T.warn, reload: T.bad, blocked: T.bad, dead: T.dead };
// sight palette + fonts, resolved once from the design tokens (drawn every frame)
const SIGHT = {
   main: T.reticle, dim: rgba(T.reticle, 0.62), faint: rgba(T.reticle, 0.3), out: T.bad, outDim: rgba(T.bad, 0.6),
   ready: rgba(T.ok, 0.9), partial: rgba(T.warn, 0.9), idle: rgba(T.reticle, 0.7), torpReady: rgba(T.torp, 0.9), snap: rgba(T.enemy, 0.9),
   track: 'rgba(0,0,0,0.4)', shadow: 'rgba(0,0,0,0.85)',
};
const F_SMALL = MONO(10), F_READ = MONO(12), F_READ_B = MONO(15, 'bold'), F_LBL = FONT(13, 'bold'), F_WARN = FONT(12, 'bold'),
   F_CUE = MONO(13, 'bold'), F_NAME = FONT(11), F_NAME_B = FONT(11, 'bold'), F_DIST = MONO(10);
const F_TORP = MONO(11, 'bold'), F_MAG = MONO(18, 'bold');
// binocular optics: warm cream instead of a cold blue so it matches the sight
const SCOPE = { hair: rgba(T.reticle, 0.35), dot: rgba(T.reticle, 0.55), text: rgba(T.reticle, 0.9), hint: rgba(T.reticle, 0.5) };
const NAME_ALLY = T['ally-soft'], NAME_ENEMY = T['enemy-soft'], DIST_COL = rgba(T['enemy-soft'], 0.85);
const NICE_MRAD = [0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50];
// lead marker palette (constants: the marker is drawn every frame)
const LEAD_RED = T.lead, LEAD_TORP = T['lead-torp'], LEAD_LOST = '#d8a49c', LEAD_DARK = 'rgba(8,10,14,0.92)',
   LEAD_HI = '#ffffff', LEAD_FILL = 'rgba(255,40,24,0.14)';
const LEAD_DASH = [5, 4], NO_DASH = [];
const LEAD_FONT = FONT(12, 600), LEAD_FONT_L = FONT(15, 600);

export class Overlay3D {
   constructor(canvas) {
      this.c = canvas;
      this.g = canvas.getContext('2d');
      this.W = 1; this.H = 1; this.dpr = 1;
      this.t = 0;
   }

   resize(W, H, dpr = 1) {
      this.W = W; this.H = H; this.dpr = dpr;
      this.c.width = Math.round(W * dpr); this.c.height = Math.round(H * dpr);
   }

   clear() {
      this.g.setTransform(1, 0, 0, 1, 0, 0);
      this.g.clearRect(0, 0, this.c.width, this.c.height);
   }

   draw(ui) {
      const g = this.g;
      this.clear();
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.t += 1 / 60;
      if (!ui.p) return;
      if (ui.mapOpen) { this._tacticalMap(ui); return; }
      if (ui.sub) drawSubUnder(g, ui, this.W, this.H, this.t);
      this._markers(ui);
      if (ui.air) drawAir(g, ui, this.W, this.H, this.t);   // squadron markers, attack-run aim (airui.js)
      drawMissileHud(g, ui, this.W, this.H, this.t);        // vampires, ESM bearings, land positions (missileui.js)
      if (ui.ops) drawOpsHud(g, ui, this.W, this.H, this.t); // own helicopter, task points, swimmer team (opsui.js)
      if (ui.air?.flying) return;                            // squadron view: no ship reticle
      if (ui.torpFan && ui.alive) this._torpFan(ui);
      if (ui.scopeT > 0.01) { if (ui.sub?.peri) drawPeriscope(g, ui, this.W, this.H); else this._binoculars(ui); }
      if (ui.alive) {
         if (ui.frozenPt) this._frozen(ui.frozenPt);
         this._reticle(ui);
         this._torpWarn(ui);
         if (ui.zoomCueA > 0.01) this._zoomCue(ui);
         // last: the lead marker is never covered by the scene, the scope mask or the reticle
         if (ui.leadMark?.shown) this._lead(ui.leadMark, ui.H);
      }
   }

   // ------------------------------------------------------------ zoom ladder cue
   // Brief after a wheel/Shift change: a slim ladder left of the reticle (bottom = widest
   // third-person view, top = 16x) with the current rung and its name.
   _zoomCue(ui) {
      const g = this.g, n = ui.zoomLadder || 10, tp = ui.zoomTP ?? 5, lv = ui.zoomLevel || 0;
      // just outside the mil scale (at most W*0.2 each side), centred on the horizon line
      const x = Math.round(Math.max(110, this.W * 0.3 - 30)) + 0.5, yB = this.H / 2 + 44;
      const yOf = (i) => yB - i * 9 - (i > tp ? 7 : 0);   // a gap between camera and scope rungs
      g.save();
      g.globalAlpha = clamp01(ui.zoomCueA) * 0.9;
      g.shadowColor = 'rgba(0,0,0,0.8)'; g.shadowBlur = 3;
      g.lineWidth = 2;
      for (let i = 0; i < n; i++) {
         const on = Math.abs(i - lv) < 0.5, w = i > tp ? 10 : 6;
         g.strokeStyle = on ? SIGHT.main : i > tp ? SIGHT.dim : SIGHT.faint;
         g.beginPath(); g.moveTo(x - w, yOf(i)); g.lineTo(x + w, yOf(i)); g.stroke();
      }
      // exact (fractional) position for touchpad glides: a small pointer
      const yl = lv > tp ? yOf(Math.round(lv)) : yB - lv * 9;
      g.fillStyle = SIGHT.main;
      g.beginPath(); g.moveTo(x + 14, yl); g.lineTo(x + 20, yl - 4); g.lineTo(x + 20, yl + 4); g.closePath(); g.fill();
      g.font = F_CUE; g.textAlign = 'right'; g.textBaseline = 'middle';
      g.fillText(lv > tp ? (ui.sub?.peri ? 'Sehrohr ' : 'Fernglas ') + ui.zoom + '×' : 'Kamera', x - 16, yl);
      g.restore();
   }

   // ------------------------------------------------------------ gun sight
   // A horizontal mil scale with ticks hanging below it, a small chevron under the centre, and
   // two reload arcs left and right of the centre that fill from below. Readouts sit below-right
   // (range, flight time, tick value) and below-left (ammunition, loaded guns).
   _reticle(ui) {
      const g = this.g, cx = this.W / 2, cy = this.H / 2;
      const out = ui.out && ui.mode === 'guns';
      const main = out ? SIGHT.out : SIGHT.main;
      const dim = out ? SIGHT.outDim : SIGHT.dim;
      g.save();
      g.lineCap = 'butt';
      g.shadowColor = SIGHT.shadow; g.shadowBlur = 3;

      // Mil scale: tick spacing is a "nice" angle chosen so ticks sit 16..40 px apart at the
      // current FOV. The label says how many knots of crossing speed one tick leads at this
      // range, so the scale doubles as a lead ruler.
      const pxPerMrad = ui.pxPerRad / 1000;
      let mrad = NICE_MRAD[NICE_MRAD.length - 1];
      for (const m of NICE_MRAD) if (m * pxPerMrad >= 16) { mrad = m; break; }
      const sp = mrad * pxPerMrad;
      const halfW = Math.min(this.W * 0.2, sp * 12);
      g.strokeStyle = main; g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(cx - halfW, cy); g.lineTo(cx - 12, cy);
      g.moveTo(cx + 12, cy); g.lineTo(cx + halfW, cy);
      // chevron under the centre
      g.moveTo(cx - 5, cy + 13); g.lineTo(cx, cy + 8); g.lineTo(cx + 5, cy + 13);
      g.stroke();
      g.lineWidth = 1.2; g.strokeStyle = dim;
      g.beginPath();
      for (let i = 1; sp * i <= halfW + 0.5; i++) {
         const len = i % 4 === 0 ? 9 : i % 2 === 0 ? 6 : 3;
         for (const s of [-1, 1]) {
            const x = Math.round(cx + s * sp * i) + 0.5;
            g.moveTo(x, cy); g.lineTo(x, cy + len);
         }
      }
      g.stroke();
      if (ui.pxPerKn > 0) {
         g.fillStyle = dim; g.font = F_SMALL; g.textAlign = 'center'; g.textBaseline = 'bottom';
         for (let i = 4; sp * i <= halfW + 0.5; i += 4) {
            g.fillText(String(i), cx + sp * i, cy - 4);
            g.fillText(String(i), cx - sp * i, cy - 4);
         }
      }
      // centre point
      g.fillStyle = main;
      g.fillRect(cx - 1, cy - 1, 2, 2);

      // reload arcs: left and right of the centre, filling from the bottom up
      const r = ui.reload || {};
      const R = 30, span = 1.1;                       // half-angle of each arc (rad)
      const arcs = (frac) => {
         for (const side of [0, Math.PI]) {
            // right arc spans side-span..side+span; filled from the bottom end (larger y)
            const lo = side === 0 ? span : Math.PI - span, dir = side === 0 ? -1 : 1;
            g.beginPath(); g.arc(cx, cy, R, lo, lo + dir * 2 * span * clamp01(frac), dir < 0); g.stroke();
         }
      };
      g.shadowBlur = 0;
      g.lineWidth = 2.5;
      g.strokeStyle = SIGHT.track;
      arcs(1);
      if (ui.mode === 'guns') {
         g.strokeStyle = r.anyReady ? SIGHT.ready : r.loaded > 0 ? SIGHT.partial : SIGHT.idle;
         arcs(r.anyReady ? 1 : r.frac ?? 1);
      } else if (ui.torpInfo) {
         const ti = ui.torpInfo;
         g.strokeStyle = ti.readyCount > 0 ? SIGHT.torpReady : SIGHT.idle;
         arcs(ti.readyCount > 0 ? 1 : 1 - clamp01(ti.reload / (ti.reloadMax || 1)));
      }

      // snapped to a ship: corner brackets
      if (ui.snapped && ui.mode === 'guns') {
         g.strokeStyle = SIGHT.snap; g.lineWidth = 1.5;
         const b = 15, l = 5;
         g.beginPath();
         for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            g.moveTo(cx + sx * b, cy + sy * (b - l)); g.lineTo(cx + sx * b, cy + sy * b); g.lineTo(cx + sx * (b - l), cy + sy * b);
         }
         g.stroke();
      }

      // readouts (below the scale, clear of the reload arcs)
      g.shadowColor = SIGHT.shadow; g.shadowBlur = 4;
      g.textBaseline = 'alphabetic';
      const tx = cx + 40, ty = cy + 30;
      g.textAlign = 'left';
      g.fillStyle = main; g.font = F_READ_B;
      g.fillText(km(ui.range), tx, ty);
      g.font = F_READ; g.fillStyle = dim;
      if (ui.mode === 'guns') {
         g.fillText((out ? ui.gunRange : ui.range) > 0 ? ui.flight.toFixed(1).replace('.', ',') + ' s' : '', tx, ty + 15);
         if (ui.pxPerKn > 0) g.fillText('Strich ≈ ' + Math.max(0.1, sp / ui.pxPerKn).toFixed(sp / ui.pxPerKn < 3 ? 1 : 0).replace('.', ',') + ' kn', tx, ty + 29);
      } else if (ui.mode === 'torp' && ui.torpInfo) {
         g.fillText('Torp. ' + km(ui.torpInfo.range), tx, ty + 15);
      }
      // left side: ammo + loaded guns
      g.textAlign = 'right';
      if (ui.mode === 'guns') {
         g.font = F_LBL;
         g.fillStyle = ui.ammo === 'HE' ? T.he : T.ap;
         g.fillText(ui.ammo === 'HE' ? 'GESCHÜTZ' : 'PANZER', cx - 40, ty);
         g.font = F_READ; g.fillStyle = dim;
         g.fillText(r.anyReady ? `${r.ready ?? r.loaded}/${r.total}` : r.left > 0 ? r.left.toFixed(1).replace('.', ',') + ' s' : r.trav > 0 ? 'schwenkt' : r.total ? 'kein Winkel' : '—', cx - 40, ty + 15);
      } else if (ui.mode !== 'torp') {
         // guided weapon (missileui.js): name and state of the selected slot
         const w = (ui.weapons || []).find(x => x.sel);
         if (w) {
            g.font = F_LBL; g.fillStyle = w.ready ? T.gold : T.bad;
            g.fillText(w.name.toUpperCase(), cx - 40, ty);
            g.font = F_READ; g.fillStyle = dim;
            g.fillText(w.count + ' · ' + w.stat, cx - 40, ty + 15);
         }
      } else {
         g.font = F_LBL; g.fillStyle = T.torp;
         g.fillText('TORPEDO', cx - 40, ty);
         if (ui.torpInfo) {
            g.font = F_READ; g.fillStyle = dim;
            g.fillText(ui.torpInfo.readyCount > 0 ? 'bereit' : ui.torpInfo.reload.toFixed(0) + ' s', cx - 40, ty + 15);
         }
      }
      if (out) {
         g.textAlign = 'center'; g.font = F_WARN; g.fillStyle = SIGHT.out;
         g.fillText('AUSSER REICHWEITE · max ' + km(ui.gunRange), cx, cy - 40);
      }
      g.restore();

      // turret schematic lives bottom-centre, left of the ammunition selector and right of the
      // chart table, so it never sits on the own hull (which fills the lower middle of the view)
      // (on touch screens touch3d.js keeps a slot for it in the bottom stack, read twice a second)
      if (ui.mode === 'guns') {
         const slot = this._tschSlot();
         if (slot) this._turretSchematic(ui, slot.x, slot.y);
         else if (!isTouch()) this._turretSchematic(ui, Math.max(cx - 64 * (ui.weapons?.length || 3) - 108, 400), this.H - 50);
      }
   }

   _tschSlot() {
      const now = performance.now();
      if (!this._tsch || now - this._tsch.t > 500) {
         const e = isTouch() ? document.getElementById('tu-tsch') : null;
         const r = e?.getBoundingClientRect();
         this._tsch = { t: now, slot: r && r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null };
      }
      return this._tsch.slot;
   }

   // Small top-down hull under the reticle, rotated relative to the camera (up = where you
   // look), each turret coloured by its state with a barrel line showing where it points.
   _turretSchematic(ui, cx, cy) {
      const T = ui.turrets || [];
      if (!T.length) return;
      const g = this.g;
      const rot = ui.p.heading - ui.camYaw;         // hull direction on screen, clockwise from up
      const L = 58, B = 12;
      g.save();
      g.translate(cx, cy);
      g.fillStyle = 'rgba(17,20,21,0.6)'; g.strokeStyle = rgba(T.gold, 0.35); g.lineWidth = 1;
      g.beginPath(); g.arc(0, 0, 38, 0, TAU); g.fill(); g.stroke();
      // tick at the top = camera direction
      g.beginPath(); g.moveTo(0, -38); g.lineTo(0, -32); g.stroke();
      // local frame: bow along +x; screen up is canvas angle -90deg
      g.rotate(rot - Math.PI / 2);
      g.shadowColor = 'rgba(0,0,0,0.7)'; g.shadowBlur = 3;
      g.strokeStyle = rgba(T.hud, 0.6); g.lineWidth = 1.3;
      g.beginPath();
      g.moveTo(L / 2, 0); g.quadraticCurveTo(L * 0.3, -B / 2, 0, -B / 2); g.lineTo(-L / 2 + 4, -B / 2 + 1);
      g.lineTo(-L / 2, 0); g.lineTo(-L / 2 + 4, B / 2 - 1); g.lineTo(0, B / 2); g.quadraticCurveTo(L * 0.3, B / 2, L / 2, 0);
      g.stroke();
      const maxOff = Math.max(1, ...T.map(t => Math.abs(t.offX)));
      for (const t of T) {
         const x = (t.offX / maxOff) * (L / 2 - 9);
         g.fillStyle = TURRET_COL[t.state] || T.neutral;
         g.strokeStyle = g.fillStyle; g.lineWidth = 1.6;
         g.beginPath(); g.arc(x, 0, 3.2, 0, TAU); g.fill();
         // barrel: t.rel is relative to the bow, positive = starboard (clockwise on screen)
         g.beginPath(); g.moveTo(x, 0); g.lineTo(x + Math.cos(t.rel) * 9, Math.sin(t.rel) * 9); g.stroke();
      }
      g.restore();
   }

   // ------------------------------------------------------------ floating markers
   _markers(ui) {
      const g = this.g;
      g.save();
      g.textAlign = 'center';
      const cxs = this.W / 2, cys = this.H / 2;
      // Layout pass in priority order (locked / secondary target, then nearest first): names that would
      // overlap an already placed label or icon step up a line, or are dropped after two tries;
      // range read-outs that collide are dropped. Drawn afterwards far-to-near (near on top).
      const list = (ui.markers || []).filter(m => m.onScreen)
         .sort((a, b) => ((b.locked ? 2 : b.sec ? 1 : 0) - (a.locked ? 2 : a.sec ? 1 : 0)) || ((a.dist || 0) - (b.dist || 0)));
      const boxes = [];
      const hit = (b) => boxes.some(o => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y);
      const lay = [];
      for (const m of list) {
         const x = m.x;
         let y = m.y, lifted = false;
         // a marker over the reticle is lifted above it (thin leader to the ship) so the
         // crosshair, range and "out of range" readouts stay readable
         if (Math.abs(x - cxs) < 90 && y > cys - 74 && y < cys + 64) { lifted = true; y = cys - 74; }
         const L = { m, x, y, lifted, nameY: null, showDist: false };
         boxes.push({ x: x - 9, y: y - 9, w: 18, h: 18 });
         g.font = m.locked ? F_NAME_B : F_NAME;
         const nw = g.measureText(m.name || '').width + 6;
         for (let k = 0, ny = y - 10; k < 3; k++, ny -= 12) {
            const b = { x: x - nw / 2, y: ny - 12, w: nw, h: 12 };
            if (m.locked || !hit(b)) { L.nameY = ny; boxes.push(b); break; }
         }
         if (!m.ally) {
            g.font = F_DIST;
            const b = { x: x - 22, y: y + 15, w: 44, h: 11 };
            if (m.locked || !hit(b)) { L.showDist = true; boxes.push(b); }
         }
         lay.push(L);
      }
      for (let i = lay.length - 1; i >= 0; i--) {
         const { m, x, y, lifted, nameY, showDist } = lay[i];
         const col = m.ally ? COL.ally : COL.enemy;
         if (lifted) {
            g.shadowBlur = 0;
            g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 1;
            g.beginPath(); g.moveTo(x, y + 22); g.lineTo(x, Math.max(y + 22, m.y - 4)); g.stroke();
         }
         g.globalAlpha = 1;
         g.shadowColor = 'rgba(0,0,0,0.85)'; g.shadowBlur = 3;
         drawClassIcon(g, m.type, x, y, 13, col, { lineWidth: 1.4 });
         if (!m.ally && m.level) drawQuality(g, x - 15, y, m.level);   // contact quality (missileui.js)
         if (nameY != null) {
            g.font = m.locked ? F_NAME_B : F_NAME;
            g.fillStyle = m.ally ? NAME_ALLY : NAME_ENEMY;
            g.textBaseline = 'bottom';
            g.fillText(m.name, x, nameY);
         }
         // HP bar
         g.shadowBlur = 0;
         const bw = 40, bh = 3;
         g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(x - bw / 2 - 1, y + 9, bw + 2, bh + 2);
         g.fillStyle = col; g.fillRect(x - bw / 2, y + 10, bw * m.hpFrac, bh);
         if (showDist) {
            g.shadowBlur = 3;
            g.font = F_DIST; g.textBaseline = 'top'; g.fillStyle = DIST_COL;
            g.fillText(km(m.dist), x, y + 15);
         }
         if (m.fires > 0) {
            g.fillStyle = T.fire; g.beginPath(); g.arc(x + 12, y - 2, 2.5, 0, TAU); g.fill();
         }
         if (m.locked) {
            g.strokeStyle = T.self; g.lineWidth = 1.5; g.shadowBlur = 3;
            const b = 13, l = 5;
            g.beginPath();
            for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
               g.moveTo(x + sx * b, y + sy * (b - l)); g.lineTo(x + sx * b, y + sy * b); g.lineTo(x + sx * (b - l), y + sy * b);
            }
            g.stroke();
         }
         if (m.sec) this._secMark(x, y);
      }
      g.restore();
   }

   // Secondary priority target (Ctrl+click): orange square brackets around icon, HP bar and
   // range, outside the white lock corners so both can sit on one ship.
   _secMark(x, y) {
      const g = this.g;
      const bx = 27, top = y - 11, bot = y + 28, l = 6, pulse = 0.8 + 0.2 * Math.sin(this.t * 4);
      g.save();
      g.strokeStyle = `rgba(255,150,40,${pulse})`; g.lineWidth = 2.5; g.shadowColor = 'rgba(0,0,0,0.85)'; g.shadowBlur = 3;
      g.beginPath();
      for (const sx of [-1, 1]) {
         g.moveTo(x + sx * (bx - l), top); g.lineTo(x + sx * bx, top); g.lineTo(x + sx * bx, bot); g.lineTo(x + sx * (bx - l), bot);
      }
      g.stroke();
      g.restore();
   }

   // Lead marker: where the target will be when a salvo (or torpedo) fired now arrives. Drawn last,
   // above markers, binocular mask and reticle. Every stroke is doubled (dark under bright) so it
   // reads against bright sky, dark sea and at night. States: 'ok' solid, 'range' dashed + "zu weit",
   // 'lost' dashed grey-red + "außer Sicht". Off-screen (m.off): parked on the frame edge with an
   // arrow towards the lead point. Constant colours / dash arrays only: no per-frame allocation.
   _lead(m, H) {
      const g = this.g;
      const k = Math.max(1, Math.min(2, H / 900));
      const col = m.state === 'lost' ? LEAD_LOST : m.torp ? LEAD_TORP : LEAD_RED;
      const dash = m.state === 'ok' ? NO_DASH : LEAD_DASH;
      const pulse = 0.5 + 0.5 * Math.sin(this.t * 5);
      const r = (9 + 1.5 * pulse) * k;
      g.save();
      g.lineJoin = 'round'; g.lineCap = 'round';
      // hull ghost at the lead point (only when it is large enough to read)
      if (m.hull) {
         const dx = m.bx - m.sx, dy = m.by - m.sy, len = Math.hypot(dx, dy);
         if (len >= 26) {
            const w = Math.max(4, Math.min(16, len * 0.14)), hl = len / 2;
            g.save();
            g.translate((m.bx + m.sx) / 2, (m.by + m.sy) / 2);
            g.rotate(Math.atan2(dy, dx));
            g.beginPath();
            g.moveTo(hl, 0); g.lineTo(hl * 0.55, -w / 2); g.lineTo(-hl, -w / 2); g.lineTo(-hl, w / 2); g.lineTo(hl * 0.55, w / 2); g.closePath();
            g.globalAlpha = 0.16; g.fillStyle = col; g.fill();
            g.globalAlpha = 0.9;
            g.setLineDash(dash);
            g.strokeStyle = LEAD_DARK; g.lineWidth = 4 * k; g.stroke();
            g.strokeStyle = col; g.lineWidth = 1.8 * k; g.stroke();
            g.restore();
         }
      }
      g.translate(m.x, m.y);
      if (m.off) {
         // arrow pointing at the lead point, the diamond sits just inside it
         g.save();
         g.rotate(m.ang);
         const a = 15 * k;
         g.beginPath(); g.moveTo(0, 0); g.lineTo(-a, -a * 0.72); g.lineTo(-a * 0.62, 0); g.lineTo(-a, a * 0.72); g.closePath();
         g.strokeStyle = LEAD_DARK; g.lineWidth = 4.5 * k; g.stroke();
         g.fillStyle = col; g.fill();
         g.strokeStyle = LEAD_HI; g.lineWidth = 1.2 * k; g.stroke();
         g.restore();
         g.translate(-Math.cos(m.ang) * (a + r + 5 * k), -Math.sin(m.ang) * (a + r + 5 * k));
      }
      g.setLineDash(dash);
      g.beginPath(); g.moveTo(0, -r); g.lineTo(r, 0); g.lineTo(0, r); g.lineTo(-r, 0); g.closePath();
      g.fillStyle = LEAD_FILL; g.fill();
      g.strokeStyle = LEAD_DARK; g.lineWidth = 5.5 * k; g.stroke();
      g.strokeStyle = col; g.lineWidth = 2.6 * k; g.stroke();
      g.setLineDash(NO_DASH);
      // centre dot
      g.beginPath(); g.arc(0, 0, 2.6 * k, 0, 6.2832);
      g.fillStyle = LEAD_DARK; g.fill();
      g.beginPath(); g.arc(0, 0, 1.6 * k, 0, 6.2832);
      g.fillStyle = LEAD_HI; g.fill();
      // state label
      const label = m.state === 'lost' ? 'außer Sicht' : m.state === 'range' ? 'zu weit' : m.torp ? 'Vorhalt' : null;
      if (label) {
         g.font = k > 1.4 ? LEAD_FONT_L : LEAD_FONT;
         g.textAlign = 'center'; g.textBaseline = 'alphabetic';
         const ly = m.y > 150 ? -r - 7 * k : r + 15 * k;
         g.strokeStyle = LEAD_DARK; g.lineWidth = 3.5; g.strokeText(label, 0, ly);
         g.fillStyle = m.state === 'ok' ? col : LEAD_HI; g.fillText(label, 0, ly);
      }
      g.restore();
   }

   // ------------------------------------------------------------ torpedoes
   _torpFan(ui) {
      const g = this.g, f = ui.torpFan;
      g.save();
      g.strokeStyle = f.ready ? 'rgba(170,255,200,0.85)' : 'rgba(200,210,220,0.45)';
      g.lineWidth = 1.5; g.setLineDash([8, 6]);
      g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 2;
      for (const line of f.lines) {
         g.beginPath();
         let pen = false;
         for (const q of line) {
            if (!q) { pen = false; continue; }
            if (pen) g.lineTo(q[0], q[1]); else { g.moveTo(q[0], q[1]); pen = true; }
         }
         g.stroke();
      }
      g.setLineDash([]);
      g.restore();
   }

   _torpWarn(ui) {
      const W = ui.torpWarn || [];
      if (!W.length) return;
      const g = this.g, cx = this.W / 2, cy = this.H / 2;
      const blink = 0.6 + 0.4 * Math.sin(this.t * 12);
      g.save();
      g.fillStyle = `rgba(255,70,50,${blink})`;
      g.shadowColor = 'rgba(0,0,0,0.8)'; g.shadowBlur = 4;
      g.font = F_TORP; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (const w of W) {
         const r = 64, x = cx + Math.sin(w.ang) * r, y = cy - Math.cos(w.ang) * r;
         g.save(); g.translate(x, y); g.rotate(w.ang);
         g.beginPath(); g.moveTo(0, -9); g.lineTo(7, 4); g.lineTo(-7, 4); g.closePath(); g.fill();
         g.restore();
         g.fillText(Math.ceil(w.t) + 's', cx + Math.sin(w.ang) * (r + 17), cy - Math.cos(w.ang) * (r + 17));
      }
      g.restore();
   }

   _frozen(pt) {
      const g = this.g;
      g.save();
      g.strokeStyle = rgba(T.gold, 0.9); g.lineWidth = 1.5;
      g.beginPath(); g.arc(pt.x, pt.y, 7, 0, TAU);
      g.moveTo(pt.x - 12, pt.y); g.lineTo(pt.x - 4, pt.y); g.moveTo(pt.x + 4, pt.y); g.lineTo(pt.x + 12, pt.y);
      g.stroke();
      g.restore();
   }

   // ------------------------------------------------------------ binoculars
   _binoculars(ui) {
      const g = this.g, W = this.W, H = this.H, cx = W / 2, cy = H / 2;
      const a = clamp01(ui.scopeT);
      const R0 = Math.min(W, H) * 0.47;
      g.save();
      g.globalAlpha = a;
      // soft optical vignette instead of a hard black tube: the scope view keeps the
      // whole screen usable (targets at the edge stay visible for leading and spotting)
      const grd = g.createRadialGradient(cx, cy, R0 * 0.95, cx, cy, Math.hypot(W, H) * 0.56);
      grd.addColorStop(0, 'rgba(0,0,0,0)');
      grd.addColorStop(1, 'rgba(0,4,8,0.55)');
      g.fillStyle = grd;
      g.fillRect(0, 0, W, H);
      // fine cross hairs out to the reticle radius
      g.lineWidth = 1;
      g.strokeStyle = SCOPE.hair;
      g.beginPath();
      g.moveTo(cx - R0 * 0.9, cy); g.lineTo(cx - Math.min(W * 0.2, R0 * 0.5), cy);
      g.moveTo(cx + Math.min(W * 0.2, R0 * 0.5), cy); g.lineTo(cx + R0 * 0.9, cy);
      g.moveTo(cx, cy - R0 * 0.9); g.lineTo(cx, cy - 40);
      g.moveTo(cx, cy + 130); g.lineTo(cx, cy + R0 * 0.9);
      g.stroke();
      // mil dots on the vertical line (angle, same spacing rule as the horizontal scale)
      const pxPerMrad = ui.pxPerRad / 1000;
      let mrad = NICE_MRAD[NICE_MRAD.length - 1];
      for (const m of NICE_MRAD) if (m * pxPerMrad >= 22) { mrad = m; break; }
      const sp = mrad * pxPerMrad;
      g.fillStyle = SCOPE.dot;
      for (let k = Math.ceil(40 / sp); k * sp < R0 * 0.9; k++) { g.beginPath(); g.arc(cx, cy - k * sp, 1.6, 0, TAU); g.fill(); }
      // magnification
      // magnification + hint on the right arm of the cross (bottom is covered by the HUD panels)
      const rx = cx + Math.min(R0 * 0.88, W / 2 - 20);
      g.font = F_MAG; g.textAlign = 'right'; g.textBaseline = 'alphabetic';
      g.fillStyle = SCOPE.text;
      g.fillText(ui.zoom + '×', rx, cy - 10);
      g.font = F_SMALL; g.fillStyle = SCOPE.hint;
      g.fillText(isTouch() ? 'Zwei Finger: Zoom · Glas: zurück' : 'Mausrad: Zoom · Shift: zurück', rx, cy - 34);
      g.restore();
   }

   // ------------------------------------------------------------ tactical map
   _tacticalMap(ui) {
      const g = this.g, W = this.W, H = this.H;
      g.save();
      g.fillStyle = rgba(T['map-ink'], 0.9);
      g.fillRect(0, 0, W, H);
      // keep clear of the top bar (score) and the bottom panels
      const { x0, y0, size } = tacticalMapRect(W, H);   // shared with the map cursor (missileui.js)
      paintMap(g, ui.world, x0, y0, size, { ...ui.mapOpts, big: true });
      // title + legend under the map: the HTML score box covers the strip above it
      g.textBaseline = 'top';
      g.fillStyle = T.hud; g.font = FONT(15, 'bold'); g.textAlign = 'left';
      const hint = opsMapHint(ui) || mapTargetHint(ui);
      if (hint) g.font = FONT(size < 420 ? 11 : 13, 'bold');
      g.fillText(hint || 'LAGEKARTE', x0, y0 + size + 7);
      g.font = FONT(12); g.fillStyle = T['hud-dim']; g.textAlign = 'right';
      if (!hint) g.fillText((isTouch() ? 'Karte – schließen' : 'M – schließen') + '  ·  gestrichelt: Sichtweite  ·  Kreis: Geschütz  ·  Raster ' + gridStep(arenaOf(ui.world)) / 1000 + ' km', x0 + size, y0 + size + 9);
      g.restore();
   }
}
