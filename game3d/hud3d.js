// game3d/hud3d.js — everything the HUD draws on the #fx canvas: the WoWs-style reticle (mil
// ticks, reload ring, range + flight time, turret schematic, out-of-range feedback), floating
// ship markers, the lead ghost, the torpedo fan, torpedo warnings, binocular optics and the
// full-screen tactical map. Pure drawing from the `ui` snapshot main3d.js builds each frame.
import { paintMap, drawClassIcon, COL } from './minimap3d.js';

const TAU = Math.PI * 2;
const clamp01 = (x) => x < 0 ? 0 : x > 1 ? 1 : x;
const km = (m) => (m / 1000).toFixed(m < 9950 ? 2 : 1).replace('.', ',') + ' km';
const TURRET_COL = { ready: '#6dff8e', traverse: '#ffd24a', reload: '#ff6a5a', blocked: '#ff6a5a', dead: '#5a5a5a' };
const NICE_MRAD = [0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50];

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
      this._markers(ui);
      if (ui.leadPt && ui.alive) this._ghost(ui.leadPt);
      if (ui.torpFan && ui.alive) this._torpFan(ui);
      if (ui.scopeT > 0.01) this._binoculars(ui);
      if (ui.alive) {
         if (ui.frozenPt) this._frozen(ui.frozenPt);
         this._reticle(ui);
         this._torpWarn(ui);
      }
   }

   // ------------------------------------------------------------ reticle
   _reticle(ui) {
      const g = this.g, cx = this.W / 2, cy = this.H / 2;
      const out = ui.out && ui.mode === 'guns';
      const main = out ? '#ff6a5a' : '#eef6ff';
      const dim = out ? 'rgba(255,106,90,0.6)' : 'rgba(238,246,255,0.62)';
      g.save();
      g.lineCap = 'butt';
      g.shadowColor = 'rgba(0,0,0,0.85)'; g.shadowBlur = 3;

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
      g.moveTo(cx - halfW, cy); g.lineTo(cx - 9, cy);
      g.moveTo(cx + 9, cy); g.lineTo(cx + halfW, cy);
      // vertical drop line below the centre (range/elevation cue, WoWs look)
      g.moveTo(cx, cy + 9); g.lineTo(cx, cy + 26);
      g.stroke();
      g.lineWidth = 1.2; g.strokeStyle = dim;
      g.beginPath();
      for (let i = 1; sp * i <= halfW + 0.5; i++) {
         const len = i % 2 === 0 ? 7 : 4;
         for (const s of [-1, 1]) {
            const x = Math.round(cx + s * sp * i) + 0.5;
            g.moveTo(x, cy - len); g.lineTo(x, cy + (i % 2 === 0 ? 3 : 0));
         }
      }
      g.stroke();
      if (ui.pxPerKn > 0) {
         g.fillStyle = dim; g.font = '10px Consolas, monospace'; g.textAlign = 'left'; g.textBaseline = 'middle';
         for (let i = 4; sp * i <= halfW + 0.5; i += 4) {
            g.fillText(String(i), cx + sp * i - 3, cy - 14);
            g.textAlign = 'right'; g.fillText(String(i), cx - sp * i + 3, cy - 14); g.textAlign = 'left';
         }
      }
      // centre dot
      g.fillStyle = main;
      g.fillRect(cx - 1, cy - 1, 2, 2);

      // reload ring
      const r = ui.reload || {};
      const R = 30;
      g.shadowBlur = 0;
      g.lineWidth = 2;
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.stroke();
      if (ui.mode === 'guns') {
         const frac = r.anyReady ? 1 : r.frac ?? 1;
         g.strokeStyle = r.anyReady ? 'rgba(109,255,142,0.85)' : r.loaded > 0 ? 'rgba(255,210,74,0.85)' : 'rgba(255,255,255,0.7)';
         g.beginPath(); g.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + TAU * clamp01(frac)); g.stroke();
      } else if (ui.torpInfo) {
         const ti = ui.torpInfo;
         g.strokeStyle = ti.readyCount > 0 ? 'rgba(160,255,190,0.85)' : 'rgba(255,255,255,0.6)';
         const f = ti.readyCount > 0 ? 1 : 1 - clamp01(ti.reload / (ti.reloadMax || 1));
         g.beginPath(); g.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + TAU * f); g.stroke();
      }

      // snapped to a ship: corner brackets
      if (ui.snapped && ui.mode === 'guns') {
         g.strokeStyle = 'rgba(255,120,100,0.9)'; g.lineWidth = 1.5;
         const b = 14, l = 5;
         g.beginPath();
         for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            g.moveTo(cx + sx * b, cy + sy * (b - l)); g.lineTo(cx + sx * b, cy + sy * b); g.lineTo(cx + sx * (b - l), cy + sy * b);
         }
         g.stroke();
      }

      // readouts (right of the drop line, clear of the centre)
      g.shadowColor = 'rgba(0,0,0,0.9)'; g.shadowBlur = 4;
      g.textBaseline = 'alphabetic';
      const tx = cx + 40, ty = cy + 26;
      g.textAlign = 'left';
      g.fillStyle = main; g.font = 'bold 15px Consolas, monospace';
      g.fillText(km(ui.range), tx, ty);
      g.font = '12px Consolas, monospace'; g.fillStyle = dim;
      if (ui.mode === 'guns') {
         g.fillText((out ? ui.gunRange : ui.range) > 0 ? ui.flight.toFixed(1).replace('.', ',') + ' s' : '', tx, ty + 15);
         if (ui.pxPerKn > 0) g.fillText('Strich ≈ ' + Math.max(0.1, sp / ui.pxPerKn).toFixed(sp / ui.pxPerKn < 3 ? 1 : 0).replace('.', ',') + ' kn', tx, ty + 29);
      } else if (ui.torpInfo) {
         g.fillText('Torp. ' + km(ui.torpInfo.range), tx, ty + 15);
      }
      // left side: ammo + loaded guns
      g.textAlign = 'right';
      if (ui.mode === 'guns') {
         g.font = 'bold 13px Segoe UI, sans-serif';
         g.fillStyle = ui.ammo === 'HE' ? '#ffa45a' : '#9fd4ff';
         g.fillText(ui.ammo === 'HE' ? 'HE' : 'AP', cx - 40, ty);
         g.font = '12px Consolas, monospace'; g.fillStyle = dim;
         g.fillText(r.anyReady ? `${r.loaded}/${r.total}` : (r.left || 0).toFixed(1).replace('.', ',') + ' s', cx - 40, ty + 15);
      } else {
         g.font = 'bold 13px Segoe UI, sans-serif'; g.fillStyle = '#b6f0c0';
         g.fillText('TORPEDO', cx - 40, ty);
         if (ui.torpInfo) {
            g.font = '12px Consolas, monospace'; g.fillStyle = dim;
            g.fillText(ui.torpInfo.readyCount > 0 ? 'bereit' : ui.torpInfo.reload.toFixed(0) + ' s', cx - 40, ty + 15);
         }
      }
      if (out) {
         g.textAlign = 'center'; g.font = 'bold 12px Segoe UI, sans-serif'; g.fillStyle = '#ff6a5a';
         g.fillText('AUSSER REICHWEITE · max ' + km(ui.gunRange), cx, cy - 40);
      }
      g.restore();

      // turret schematic lives bottom-centre, left of the weapon panel, so it never sits on
      // the own hull (which fills the lower middle of the chase view)
      if (ui.mode === 'guns') this._turretSchematic(ui, Math.max(cx - 300, 372), this.H - 50);
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
      // local frame: bow along +x; screen up is canvas angle -90deg
      g.rotate(rot - Math.PI / 2);
      g.shadowColor = 'rgba(0,0,0,0.7)'; g.shadowBlur = 3;
      g.strokeStyle = 'rgba(230,240,250,0.55)'; g.lineWidth = 1.3;
      g.beginPath();
      g.moveTo(L / 2, 0); g.quadraticCurveTo(L * 0.3, -B / 2, 0, -B / 2); g.lineTo(-L / 2 + 4, -B / 2 + 1);
      g.lineTo(-L / 2, 0); g.lineTo(-L / 2 + 4, B / 2 - 1); g.lineTo(0, B / 2); g.quadraticCurveTo(L * 0.3, B / 2, L / 2, 0);
      g.stroke();
      const maxOff = Math.max(1, ...T.map(t => Math.abs(t.offX)));
      for (const t of T) {
         const x = (t.offX / maxOff) * (L / 2 - 9);
         g.fillStyle = TURRET_COL[t.state] || '#ccc';
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
      for (const m of ui.markers || []) {
         if (!m.onScreen) continue;
         const col = m.ally ? COL.ally : COL.enemy;
         const x = m.x, cxs = this.W / 2, cys = this.H / 2;
         let y = m.y;
         // a marker over the reticle is lifted above it (thin leader to the ship) so the
         // crosshair, range and "out of range" readouts stay readable
         if (Math.abs(x - cxs) < 90 && y > cys - 74 && y < cys + 64) {
            g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 1;
            g.beginPath(); g.moveTo(x, cys - 74 + 22); g.lineTo(x, Math.max(cys - 74 + 22, y - 4)); g.stroke();
            y = cys - 74;
         }
         g.globalAlpha = 1;
         g.shadowColor = 'rgba(0,0,0,0.85)'; g.shadowBlur = 3;
         drawClassIcon(g, m.type, x, y, 13, col, { lineWidth: 1.4 });
         g.font = (m.locked ? 'bold ' : '') + '11px Segoe UI, sans-serif';
         g.fillStyle = m.ally ? '#c9ffd8' : '#ffd0ca';
         g.textBaseline = 'bottom';
         g.fillText(m.name, x, y - 10);
         // HP bar
         g.shadowBlur = 0;
         const bw = 40, bh = 3;
         g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(x - bw / 2 - 1, y + 9, bw + 2, bh + 2);
         g.fillStyle = col; g.fillRect(x - bw / 2, y + 10, bw * m.hpFrac, bh);
         if (!m.ally) {
            g.shadowBlur = 3;
            g.font = '10px Consolas, monospace'; g.textBaseline = 'top'; g.fillStyle = 'rgba(255,220,215,0.85)';
            g.fillText(km(m.dist), x, y + 15);
         }
         if (m.fires > 0) {
            g.fillStyle = '#ff7a2a'; g.beginPath(); g.arc(x + 12, y - 2, 2.5, 0, TAU); g.fill();
         }
         if (m.locked) {
            g.strokeStyle = '#ffffff'; g.lineWidth = 1.5; g.shadowBlur = 3;
            const b = 13, l = 5;
            g.beginPath();
            for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
               g.moveTo(x + sx * b, y + sy * (b - l)); g.lineTo(x + sx * b, y + sy * b); g.lineTo(x + sx * (b - l), y + sy * b);
            }
            g.stroke();
         }
      }
      g.restore();
   }

   // Lead ghost: where the target will be when a salvo fired now lands.
   _ghost(lp) {
      const g = this.g;
      g.save();
      const pulse = 0.55 + 0.2 * Math.sin(this.t * 5);
      if (lp.bow && lp.stern) {
         const dx = lp.bow.x - lp.stern.x, dy = lp.bow.y - lp.stern.y;
         const len = Math.hypot(dx, dy);
         const w = Math.max(3, Math.min(14, len * 0.14));
         g.translate((lp.bow.x + lp.stern.x) / 2, (lp.bow.y + lp.stern.y) / 2);
         g.rotate(Math.atan2(dy, dx));
         g.fillStyle = `rgba(255,110,90,${0.22 * pulse})`;
         g.strokeStyle = `rgba(255,150,130,${pulse})`; g.lineWidth = 1.4;
         g.setLineDash([4, 3]);
         g.beginPath();
         const hl = Math.max(6, len / 2);
         g.moveTo(hl, 0); g.lineTo(hl * 0.55, -w / 2); g.lineTo(-hl, -w / 2); g.lineTo(-hl, w / 2); g.lineTo(hl * 0.55, w / 2); g.closePath();
         g.fill(); g.stroke();
         g.setLineDash([]);
      } else {
         g.translate(lp.x, lp.y);
         g.strokeStyle = `rgba(255,150,130,${pulse})`; g.lineWidth = 1.4;
         g.beginPath(); g.moveTo(0, -6); g.lineTo(6, 0); g.lineTo(0, 6); g.lineTo(-6, 0); g.closePath(); g.stroke();
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
      if (ui.torpLead) {
         const { x, y, inRange } = ui.torpLead;
         g.strokeStyle = inRange ? '#aaffc8' : 'rgba(255,255,255,0.5)'; g.lineWidth = 2;
         g.beginPath(); g.moveTo(x, y - 8); g.lineTo(x + 8, y); g.lineTo(x, y + 8); g.lineTo(x - 8, y); g.closePath(); g.stroke();
         g.font = '10px Segoe UI, sans-serif'; g.textAlign = 'center'; g.fillStyle = g.strokeStyle;
         g.fillText(inRange ? 'Vorhalt' : 'zu weit', x, y - 12);
      }
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
      g.font = 'bold 11px Consolas, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
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
      g.strokeStyle = 'rgba(255,212,121,0.9)'; g.lineWidth = 1.5;
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
      const grd = g.createRadialGradient(cx, cy, R0 * 0.82, cx, cy, R0 * 1.12);
      grd.addColorStop(0, 'rgba(0,0,0,0)');
      grd.addColorStop(0.55, 'rgba(0,4,8,0.75)');
      grd.addColorStop(1, 'rgba(0,4,8,0.94)');
      g.fillStyle = grd;
      g.fillRect(0, 0, W, H);
      // lens ring + fine cross hairs to the lens edge
      g.strokeStyle = 'rgba(190,220,255,0.35)'; g.lineWidth = 1;
      g.beginPath(); g.arc(cx, cy, R0 * 0.9, 0, TAU); g.stroke();
      g.strokeStyle = 'rgba(210,235,255,0.35)';
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
      g.fillStyle = 'rgba(210,235,255,0.55)';
      for (let k = Math.ceil(40 / sp); k * sp < R0 * 0.9; k++) { g.beginPath(); g.arc(cx, cy - k * sp, 1.6, 0, TAU); g.fill(); }
      // magnification
      // magnification + hint on the right arm of the cross (bottom is covered by the HUD panels)
      const rx = cx + Math.min(R0 * 0.88, W / 2 - 20);
      g.font = 'bold 18px Consolas, monospace'; g.textAlign = 'right'; g.textBaseline = 'alphabetic';
      g.fillStyle = 'rgba(210,235,255,0.9)';
      g.fillText(ui.zoom + '×', rx, cy - 10);
      g.font = '11px Consolas, monospace'; g.fillStyle = 'rgba(210,235,255,0.5)';
      g.fillText('Mausrad: Zoom · Shift: zurück', rx, cy - 34);
      g.restore();
   }

   // ------------------------------------------------------------ tactical map
   _tacticalMap(ui) {
      const g = this.g, W = this.W, H = this.H;
      g.save();
      g.fillStyle = 'rgba(3,9,16,0.9)';
      g.fillRect(0, 0, W, H);
      // keep clear of the top bar (score) and the bottom panels
      const size = Math.max(200, Math.min(W - 80, H - 92 - 128));
      const x0 = Math.round((W - size) / 2), y0 = 92;
      paintMap(g, ui.world, x0, y0, size, { ...ui.mapOpts, big: true });
      g.fillStyle = '#e8f2ff'; g.font = 'bold 18px Segoe UI, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'bottom';
      g.fillText('TAKTISCHE KARTE', x0, y0 - 10);
      g.font = '12px Segoe UI, sans-serif'; g.fillStyle = 'rgba(200,220,240,0.7)'; g.textAlign = 'center'; g.textBaseline = 'top';
      g.fillText('M – schließen   ·   gestrichelt: Entdeckungsradius   ·   Kreis: Hauptbatterie', x0 + size / 2, y0 + size + 7);
      g.restore();
   }
}
