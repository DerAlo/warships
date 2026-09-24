// game/render-campaign.js — drawing for the campaign layer: per-class ship bodies (torpedo boat,
// submarine, transport, carrier, coastal battery, minelayer, boss), aircraft with shadows, mines,
// star shells, telegraphed barrages, bombs, depth charges, sonar pings, mission zones, and the
// night / storm screen overlays. Called from render.js; everything is in CSS pixels.
import { clamp01, TAU } from './utils.js';

// ---------- colour helpers (local copies; render.js keeps its own) ----------
function shade(hex, amt) {
   const n = parseInt(hex.slice(1), 16);
   const r = Math.max(0, Math.min(255, (n >> 16) + amt));
   const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
   const b = Math.max(0, Math.min(255, (n & 255) + amt));
   return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}
const lighten = (h, a) => shade(h, a), darken = (h, a) => shade(h, -a);

// hull tints per class: enemies read warm/brown, allies green-grey, the player keeps its own colour
export const ENEMY_COL = { tb: '#5c4c46', sub: '#3c3836', tr: '#6a5a48', cv: '#57504c', ml: '#5e5048', boss: '#4a2c2a', cb: '#6d6a60' };
export const ALLY_COL = '#4f6e58', ALLY_DECK = '#7f917a';

// One gun house with t.guns barrels, trained to t.bearing (ship-local frame, +x = bow).
export function drawTurret(ctx, t, z, B, col, size = 1) {
   const tr = Math.max(2.4, B * 0.16) * size;
   ctx.save();
   ctx.translate(t.off.x * z, t.off.y * z);
   ctx.rotate(t.bearing);
   const n = Math.max(1, t.guns | 0);
   ctx.strokeStyle = darken(col, 32);
   ctx.lineWidth = Math.max(1.1, tr * (n >= 3 ? 0.22 : 0.28));
   const gap = tr * (n >= 3 ? 0.5 : 0.7), bl = tr * 2.6;
   for (let i = 0; i < n; i++) {
      const bo = (i - (n - 1) / 2) * gap;
      ctx.beginPath(); ctx.moveTo(tr * 0.3, bo); ctx.lineTo(bl, bo); ctx.stroke();
   }
   ctx.fillStyle = darken(col, 12);
   ctx.beginPath(); ctx.arc(0, 0, tr, 0, TAU); ctx.fill();
   ctx.fillStyle = lighten(col, 8);
   ctx.beginPath(); ctx.arc(0, 0, tr * 0.62, 0, TAU); ctx.fill();
   ctx.restore();
}

// Deck furniture for the hull-shaped new classes (hull + deck are already drawn by render.js).
export function drawDetail(ctx, s, kind, L, B, z, hullCol, deckCol, time) {
   switch (kind) {
      case 'tb': {
         ctx.fillStyle = lighten(deckCol, 8);
         ctx.fillRect(L * 0.05, -B * 0.22, L * 0.14, B * 0.44);          // bridge
         ctx.fillStyle = '#20262b';
         ctx.beginPath(); ctx.arc(-L * 0.04, 0, Math.max(1.4, B * 0.14), 0, TAU); ctx.fill();
         // twin torpedo tubes, trained abeam
         ctx.strokeStyle = darken(hullCol, 30); ctx.lineWidth = Math.max(1, B * 0.12);
         for (const x of [-L * 0.18, -L * 0.3]) { ctx.beginPath(); ctx.moveTo(x, -B * 0.3); ctx.lineTo(x, B * 0.3); ctx.stroke(); }
         for (const t of s.turrets) drawTurret(ctx, t, z, B, hullCol, 0.85);
         break;
      }
      case 'tr': {
         // cargo hatches forward and aft of the bridge, derricks between them
         ctx.fillStyle = darken(deckCol, 26);
         for (const x of [0.3, 0.13, -0.12]) ctx.fillRect(L * x - L * 0.06, -B * 0.24, L * 0.12, B * 0.48);
         ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1;
         for (const x of [0.3, 0.13, -0.12]) { ctx.beginPath(); ctx.moveTo(L * x, -B * 0.24); ctx.lineTo(L * x, B * 0.24); ctx.stroke(); }
         ctx.fillStyle = lighten(deckCol, 12);
         ctx.fillRect(-L * 0.36, -B * 0.28, L * 0.14, B * 0.56);          // aft superstructure
         ctx.fillStyle = '#2a2622';
         ctx.beginPath(); ctx.arc(-L * 0.3, 0, Math.max(1.8, B * 0.13), 0, TAU); ctx.fill();
         ctx.strokeStyle = darken(deckCol, 40); ctx.lineWidth = Math.max(1, B * 0.06);
         for (const x of [0.22, 0.02]) { ctx.beginPath(); ctx.moveTo(L * x, -B * 0.36); ctx.lineTo(L * x, B * 0.36); ctx.stroke(); }
         for (const t of s.turrets) drawTurret(ctx, t, z, B, hullCol, 0.7);
         break;
      }
      case 'cv': {
         // full-length flight deck with markings, starboard island, parked planes aft
         const x0 = -L * 0.49, w = L * 0.95, h = B * 0.9;
         ctx.fillStyle = '#3d4247';
         ctx.fillRect(x0, -h / 2, w, h);
         ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
         ctx.setLineDash([L * 0.04, L * 0.03]);
         ctx.beginPath(); ctx.moveTo(x0 + L * 0.04, 0); ctx.lineTo(x0 + w - L * 0.02, 0); ctx.stroke();
         ctx.setLineDash([]);
         ctx.strokeStyle = 'rgba(255,220,120,0.5)';
         ctx.strokeRect(x0 + w * 0.8, -h * 0.3, w * 0.12, h * 0.6);       // bow landing box
         ctx.fillStyle = lighten(hullCol, 14);
         ctx.fillRect(-L * 0.02, h * 0.28, L * 0.16, B * 0.22);           // island
         ctx.fillStyle = '#23272b';
         ctx.fillRect(L * 0.04, h * 0.32, L * 0.05, B * 0.14);
         const parked = Math.min(8, s.hangar | 0);
         ctx.fillStyle = 'rgba(190,200,190,0.8)';
         for (let i = 0; i < parked; i++) {
            const px = x0 + L * 0.08 + (i >> 1) * L * 0.07, py = (i & 1 ? 1 : -1) * h * 0.22;
            planeShape(ctx, px, py, 0, Math.max(3.5, L * 0.045));
         }
         for (const t of s.turrets) drawTurret(ctx, t, z, B, hullCol, 0.6);
         break;
      }
      case 'ml': {
         ctx.fillStyle = lighten(deckCol, 8);
         ctx.fillRect(L * 0.08, -B * 0.26, L * 0.16, B * 0.52);
         ctx.fillStyle = '#23282c';
         ctx.beginPath(); ctx.arc(0, 0, Math.max(1.6, B * 0.13), 0, TAU); ctx.fill();
         // mine rails running to the stern, loaded with mines
         ctx.strokeStyle = 'rgba(40,40,40,0.8)'; ctx.lineWidth = 1;
         for (const y of [-B * 0.24, B * 0.24]) {
            ctx.beginPath(); ctx.moveTo(-L * 0.08, y); ctx.lineTo(-L * 0.49, y); ctx.stroke();
            ctx.fillStyle = '#2a2a2a';
            for (let x = -L * 0.12; x > -L * 0.46; x -= Math.max(3, L * 0.07)) { ctx.beginPath(); ctx.arc(x, y, Math.max(1.2, B * 0.12), 0, TAU); ctx.fill(); }
         }
         for (const t of s.turrets) drawTurret(ctx, t, z, B, hullCol, 0.85);
         break;
      }
      case 'boss': {
         // later phases: the hull glows like a forge (phase 3 brighter)
         const ph = s.bossPhase || 0;
         if (ph >= 1 || s.hp < s.maxHP * 0.5) {
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = (ph >= 2 ? 0.26 : 0.16) + 0.1 * Math.sin(time * 5);
            ctx.fillStyle = '#ff3a20';
            ctx.beginPath(); ctx.ellipse(0, 0, L * 0.55, B * 0.75, 0, 0, TAU); ctx.fill();
            ctx.restore();
         }
         // rapid-salvo telegraph / active: yellow pulse around the hull
         if (s.rapidWarn > 0 || s.rapidT > 0) {
            ctx.save();
            ctx.strokeStyle = s.rapidWarn > 0 ? `rgba(255,220,80,${0.5 + 0.5 * Math.sin(time * 18)})` : 'rgba(255,200,60,0.55)';
            ctx.lineWidth = 3;
            ctx.beginPath(); ctx.ellipse(0, 0, L * 0.62, B * 1.1, 0, 0, TAU); ctx.stroke();
            ctx.restore();
         }
         const style = s.cfg.bossStyle;
         ctx.strokeStyle = 'rgba(255,90,60,0.35)'; ctx.lineWidth = 1;
         if (style === 'rodney') {
            // all three turrets forward, the tower block and funnel far aft
            ctx.strokeRect(0, -B * 0.3, L * 0.44, B * 0.6);
            ctx.fillStyle = darken(deckCol, 18);
            ctx.fillRect(-L * 0.3, -B * 0.28, L * 0.3, B * 0.56);
            ctx.fillStyle = lighten(deckCol, 6);
            ctx.fillRect(-L * 0.06, -B * 0.18, L * 0.08, B * 0.36);        // tall bridge tower
            ctx.fillStyle = '#1a1d20';
            ctx.beginPath(); ctx.arc(-L * 0.2, 0, Math.max(2, B * 0.14), 0, TAU); ctx.fill();
         } else if (style === 'hood') {
            // long, lean battlecruiser: bridge forward of two funnels, turrets fore and aft
            ctx.strokeRect(-L * 0.3, -B * 0.28, L * 0.6, B * 0.56);
            ctx.fillStyle = darken(deckCol, 18);
            ctx.fillRect(-L * 0.18, -B * 0.24, L * 0.36, B * 0.48);
            ctx.fillStyle = lighten(deckCol, 6);
            ctx.fillRect(L * 0.1, -B * 0.16, L * 0.08, B * 0.32);
            ctx.fillStyle = '#1a1d20';
            for (const x of [L * 0.03, -L * 0.08]) { ctx.beginPath(); ctx.ellipse(x, 0, Math.max(2.4, B * 0.2), Math.max(1.6, B * 0.12), 0, 0, TAU); ctx.fill(); }
         } else {
            // Leviathan: armoured citadel belt, superstructure and twin funnels amidships
            ctx.strokeRect(-L * 0.28, -B * 0.3, L * 0.56, B * 0.6);
            ctx.fillStyle = darken(deckCol, 18);
            ctx.fillRect(-L * 0.14, -B * 0.26, L * 0.26, B * 0.52);
            ctx.fillStyle = lighten(deckCol, 6);
            ctx.fillRect(L * 0.04, -B * 0.16, L * 0.1, B * 0.32);
            ctx.fillStyle = '#1a1d20';
            for (const x of [-L * 0.05, -L * 0.11]) { ctx.beginPath(); ctx.arc(x, 0, Math.max(2, B * 0.12), 0, TAU); ctx.fill(); }
         }
         for (const t of s.turrets) drawTurret(ctx, t, z, B, hullCol, 1.15);
         break;
      }
      default:
         for (const t of s.turrets) drawTurret(ctx, t, z, B, hullCol);
   }
}

// Submarine: a cigar hull that fades into the water as it dives (only drawn while spotted).
export function drawSub(ctx, s, L, B, z, col, time) {
   const depth = s.depth || 0;
   const a = depth < 0.5 ? 1 - depth * 0.8 : 0.45;
   ctx.save();
   ctx.globalAlpha = a;
   if (depth < 0.3) {
      ctx.save(); ctx.globalAlpha = a * 0.3; ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.ellipse(2, 3, L / 2, B / 2, 0, 0, TAU); ctx.fill(); ctx.restore();
   }
   const g = ctx.createLinearGradient(0, -B / 2, 0, B / 2);
   g.addColorStop(0, lighten(col, 20)); g.addColorStop(1, darken(col, 20));
   ctx.fillStyle = g;
   ctx.beginPath(); ctx.ellipse(0, 0, L / 2, Math.max(2, B / 2), 0, 0, TAU); ctx.fill();
   ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1; ctx.stroke();
   ctx.fillStyle = lighten(col, 14);                                     // conning tower
   ctx.beginPath(); ctx.ellipse(L * 0.06, 0, L * 0.1, Math.max(1.5, B * 0.3), 0, 0, TAU); ctx.fill();
   for (const t of s.turrets) drawTurret(ctx, t, z, B, col, 0.7);
   ctx.restore();
   if (depth >= 0.3) {
      // water over the hull plus a periscope feather
      ctx.fillStyle = `rgba(30,80,110,${0.5 * clamp01(depth)})`;
      ctx.beginPath(); ctx.ellipse(0, 0, L / 2 + 1, B / 2 + 1, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(230,245,255,0.75)'; ctx.lineWidth = 1.2;
      const f = 6 + 2 * Math.sin(time * 7);
      ctx.beginPath(); ctx.moveTo(L * 0.1, 0); ctx.lineTo(L * 0.1 - f, -2.5); ctx.moveTo(L * 0.1, 0); ctx.lineTo(L * 0.1 - f, 2.5); ctx.stroke();
   }
}

// Coastal battery: concrete emplacement ringed with sandbags; the gun trains over the parapet.
export function drawBattery(ctx, s, L, B, z, col, time) {
   const R = Math.max(L, B) * 0.62;
   ctx.save();
   ctx.rotate(-s.heading);        // the fort itself does not turn with its facing
   ctx.fillStyle = 'rgba(0,0,0,0.3)';
   ctx.beginPath(); ctx.arc(3, 4, R * 1.1, 0, TAU); ctx.fill();
   ctx.fillStyle = '#7d6e52';
   for (let i = 0; i < 18; i++) {
      const a = (i / 18) * TAU;
      ctx.beginPath(); ctx.arc(Math.cos(a) * R, Math.sin(a) * R, Math.max(1.8, R * 0.16), 0, TAU); ctx.fill();
   }
   const g = ctx.createRadialGradient(-R * 0.3, -R * 0.3, 0, 0, 0, R);
   g.addColorStop(0, lighten(col, 22)); g.addColorStop(1, darken(col, 16));
   ctx.fillStyle = g;
   ctx.beginPath();
   for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU + TAU / 16; ctx.lineTo(Math.cos(a) * R * 0.86, Math.sin(a) * R * 0.86); }
   ctx.closePath(); ctx.fill();
   ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 1; ctx.stroke();
   ctx.restore();
   if (s.hitFlash > 0) { ctx.fillStyle = `rgba(255,255,255,${s.hitFlash * 0.5})`; ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill(); }
   for (const t of s.turrets) drawTurret(ctx, t, z, B * 0.7, col, 1.1);
}

// top-down plane silhouette centred on (x, y), nose along `a`
function planeShape(ctx, x, y, a, sz) {
   ctx.save();
   ctx.translate(x, y); ctx.rotate(a);
   ctx.beginPath();
   ctx.moveTo(sz, 0); ctx.lineTo(sz * 0.2, sz * 0.12); ctx.lineTo(sz * 0.1, sz * 0.95); ctx.lineTo(-sz * 0.12, sz * 0.95);
   ctx.lineTo(-sz * 0.1, sz * 0.14); ctx.lineTo(-sz * 0.7, sz * 0.1); ctx.lineTo(-sz * 0.8, sz * 0.42); ctx.lineTo(-sz * 0.95, sz * 0.42);
   ctx.lineTo(-sz * 0.9, 0);
   ctx.lineTo(-sz * 0.95, -sz * 0.42); ctx.lineTo(-sz * 0.8, -sz * 0.42); ctx.lineTo(-sz * 0.7, -sz * 0.1); ctx.lineTo(-sz * 0.1, -sz * 0.14);
   ctx.lineTo(-sz * 0.12, -sz * 0.95); ctx.lineTo(sz * 0.1, -sz * 0.95); ctx.lineTo(sz * 0.2, -sz * 0.12);
   ctx.closePath(); ctx.fill();
   ctx.restore();
}

// ================= world-space hazard layers =================
export function drawZones(ctx, cam, world) {
   for (const zn of world.zones) {
      if (!cam.visible(zn.c, zn.r + 50)) continue;
      const c = cam.w2s(zn.c), r = zn.r * cam.zoom;
      const goal = zn.kind === 'goal';
      ctx.fillStyle = goal ? 'rgba(124,255,154,0.07)' : 'rgba(255,140,100,0.07)';
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, TAU); ctx.fill();
      ctx.setLineDash([10, 8]);
      ctx.lineDashOffset = -world.time * 12;
      ctx.strokeStyle = goal ? 'rgba(124,255,154,0.7)' : 'rgba(255,140,100,0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, TAU); ctx.stroke();
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
      if (zn.label) {
         ctx.font = 'bold 12px "SF Mono", monospace';
         ctx.textAlign = 'center';
         ctx.fillStyle = goal ? 'rgba(170,255,190,0.9)' : 'rgba(255,190,170,0.9)';
         ctx.fillText(zn.label, c.x, c.y - r - 6);
      }
   }
}

export function drawMines(ctx, cam, world) {
   const z = cam.zoom;
   for (const m of world.mines) {
      if (!m.alive || !(m.seen || m.side === 'player') || !cam.visible(m.pos, 40)) continue;
      const c = cam.w2s(m.pos);
      const r = Math.max(3, 11 * z);
      const pulse = 0.5 + 0.5 * Math.sin(world.time * 4 + m.id);
      ctx.strokeStyle = `rgba(255,70,50,${0.35 + 0.45 * pulse})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(c.x, c.y, r * (2.2 + pulse * 0.6), 0, TAU); ctx.stroke();
      ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 1.2;
      for (let i = 0; i < 6; i++) {
         const a = i * TAU / 6;
         ctx.beginPath(); ctx.moveTo(c.x + Math.cos(a) * r * 0.6, c.y + Math.sin(a) * r * 0.6); ctx.lineTo(c.x + Math.cos(a) * r * 1.4, c.y + Math.sin(a) * r * 1.4); ctx.stroke();
      }
      ctx.fillStyle = m.armT > 0 ? '#555' : '#2b2b2b';
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath(); ctx.arc(c.x - r * 0.3, c.y - r * 0.3, r * 0.35, 0, TAU); ctx.fill();
   }
}

export function drawDepthCharges(ctx, cam, world) {
   for (const d of world.depthCharges) {
      if (!cam.visible(d.pos, 60)) continue;
      const c = cam.w2s(d.pos);
      const k = (world.time * 3) % 1;
      ctx.strokeStyle = `rgba(200,230,255,${0.5 * (1 - k)})`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(c.x, c.y, 3 + k * 12, 0, TAU); ctx.stroke();
      ctx.fillStyle = '#1e2226';
      ctx.fillRect(c.x - 2, c.y - 2, 4, 4);
   }
}

export function drawBombs(ctx, cam, world) {
   for (const b of world.bombs) {
      if (!cam.visible(b.pos, 60)) continue;
      const c = cam.w2s(b.pos);
      const f = clamp01(b.t / b.T);
      const r = (14 + 30 * f) * cam.zoom + 4;
      ctx.strokeStyle = `rgba(255,90,60,${0.8 - 0.4 * f})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(c.x - r * 0.5, c.y); ctx.lineTo(c.x + r * 0.5, c.y); ctx.moveTo(c.x, c.y - r * 0.5); ctx.lineTo(c.x, c.y + r * 0.5); ctx.stroke();
   }
}

// Boss torpedo-fan telegraph: red lanes from the boss out to torpedo range, pulsing faster
// until launch, with the countdown at the fan's apex.
export function drawBossFans(ctx, cam, world) {
   for (const b of world.bots) {
      const w = b.fanWarn;
      if (!w || !b.alive) continue;
      const f = 1 - clamp01(w.t / w.T);
      const blink = w.t < 1 ? 0.5 + 0.5 * Math.sin(world.time * 30) : 1;
      const o = cam.w2s(w.from);
      ctx.lineWidth = 5 * Math.max(0.6, cam.zoom * 2);
      ctx.strokeStyle = `rgba(255,50,30,${(0.18 + 0.4 * f) * blink})`;
      ctx.setLineDash([14, 10]);
      for (const a of w.angles) {
         const e = cam.w2s({ x: w.from.x + Math.cos(a) * w.range, y: w.from.y + Math.sin(a) * w.range });
         ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(e.x, e.y); ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.font = 'bold 14px "SF Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffd0c0';
      ctx.fillText('🐟 ' + w.t.toFixed(1) + ' s', o.x, o.y - 28);
   }
}

// Boss telegraph: a red ring per shell, filling up until impact, with a countdown on the first.
export function drawBarrages(ctx, cam, world) {
   const first = new Set();
   for (const b of world.barrages) {
      if (!cam.visible(b.pos, b.r + 40)) continue;
      const c = cam.w2s(b.pos), r = b.r * cam.zoom;
      const f = 1 - clamp01(b.t / b.T);
      const blink = b.t < 1 ? 0.5 + 0.5 * Math.sin(world.time * 30) : 1;
      ctx.fillStyle = `rgba(255,40,20,${(0.08 + 0.22 * f) * blink})`;
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, TAU); ctx.fill();
      ctx.fillStyle = `rgba(255,80,40,${0.25 * blink})`;
      ctx.beginPath(); ctx.arc(c.x, c.y, r * f, 0, TAU); ctx.fill();
      ctx.strokeStyle = `rgba(255,70,40,${0.85 * blink})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      if (!first.has(b.shooter)) {
         first.add(b.shooter);
         ctx.font = 'bold 14px "SF Mono", monospace';
         ctx.textAlign = 'center';
         ctx.fillStyle = '#ffd0c0';
         ctx.fillText(b.t.toFixed(1) + ' s', c.x, c.y + 5);
      }
   }
}

export function drawSonar(ctx, cam, world) {
   for (const s of world.sonarPings) {
      if (!cam.visible(s.pos, 150)) continue;
      const c = cam.w2s(s.pos);
      const age = world.time - s.t;
      const k = clamp01(age / 2.5);
      ctx.strokeStyle = `rgba(110,220,255,${0.8 * (1 - k)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(c.x, c.y, 6 + k * 50, 0, TAU); ctx.stroke();
      ctx.fillStyle = `rgba(110,220,255,${0.9 - 0.6 * clamp01(age / 5)})`;
      ctx.font = 'bold 11px "SF Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('◇ SONAR', c.x, c.y - 10);
   }
}

export function drawFlares(ctx, cam, world, glow) {
   for (const f of world.flares) {
      if (f.age < f.flight) {
         // shell in flight: a bright dot arcing up and over
         const k = f.age / f.flight;
         const p = { x: f.from.x + (f.pos.x - f.from.x) * k, y: f.from.y + (f.pos.y - f.from.y) * k };
         const c = cam.w2s(p);
         ctx.fillStyle = '#fff6c0';
         ctx.beginPath(); ctx.arc(c.x, c.y - Math.sin(k * Math.PI) * 50, 2.2, 0, TAU); ctx.fill();
         continue;
      }
      const r = world.flareR(f);
      if (!cam.visible(f.pos, r + 40)) continue;
      const c = cam.w2s(f.pos);
      const flick = 0.85 + 0.15 * Math.sin(world.time * 23 + f.pos.x);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.9 * flick;
      const s = 40 + 20 * flick;
      ctx.drawImage(glow, c.x - s / 2, c.y - 16 - s / 2, s, s);
      ctx.restore();
      ctx.fillStyle = '#fffbe0';
      ctx.beginPath(); ctx.arc(c.x, c.y - 16, 2.5, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(255,240,180,0.25)';
      ctx.setLineDash([4, 6]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(c.x, c.y, r * cam.zoom, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
   }
}

// Planes fly high: the shadow sits offset on the water; divers drop toward their shadow.
export function drawAircraft(ctx, cam, world) {
   const sz = 10;   // readable at the fixed campaign zoom
   for (const a of world.aircraft) {
      if (!a.alive || !cam.visible(a.pos, 80)) continue;
      const c = cam.w2s(a.pos);
      const alt = a.diving ? 8 : 22;
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      planeShape(ctx, c.x + alt * 0.7, c.y + alt, a.heading, sz * 0.9);
      ctx.fillStyle = a.side === 'enemy' ? (a.kind === 'dive' ? '#c8876e' : '#b89a78') : '#9fd8a8';
      planeShape(ctx, c.x, c.y, a.heading, sz);
      // prop blur
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
      const hx = Math.cos(a.heading), hy = Math.sin(a.heading);
      ctx.beginPath(); ctx.moveTo(c.x + hx * sz - hy * 3, c.y + hy * sz + hx * 3); ctx.lineTo(c.x + hx * sz + hy * 3, c.y + hy * sz - hx * 3); ctx.stroke();
   }
}

// ================= screen overlays =================
// Night: a half-resolution darkness mask with light holes punched out (own ship, allies, spotted
// enemies, burning star shells, muzzle flashes, explosions, fires).
export function drawNight(ctx, cam, world, state) {
   const k = 0.5;
   const W = Math.ceil(cam.w * k), H = Math.ceil(cam.h * k);
   if (!state.dark || state.dark.width !== W || state.dark.height !== H) {
      state.dark = document.createElement('canvas');
      state.dark.width = W; state.dark.height = H;
   }
   const g = state.dark.getContext('2d');
   g.globalCompositeOperation = 'source-over';
   g.clearRect(0, 0, W, H);
   g.fillStyle = 'rgba(2,7,18,0.8)';
   g.fillRect(0, 0, W, H);
   g.globalCompositeOperation = 'destination-out';
   const z = cam.zoom;
   const light = (wp, r, a = 1) => {
      const c = cam.w2s(wp);
      const x = c.x * k, y = c.y * k, R = r * z * k;
      if (R < 1 || x < -R || y < -R || x > W + R || y > H + R) return;
      const gr = g.createRadialGradient(x, y, 0, x, y, R);
      gr.addColorStop(0, `rgba(0,0,0,${a})`);
      gr.addColorStop(0.55, `rgba(0,0,0,${a * 0.65})`);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(x, y, R, 0, TAU); g.fill();
   };
   const p = world.player;
   if (p && p.alive) light(p.pos, 620, 0.85);
   for (const s of world.ships) {
      if (!s.alive || s === p) continue;
      if (s.side === 'player') light(s.pos, 320, 0.7);
      else if (s.visible) light(s.pos, 200, 0.6);
      for (let i = 0; i < s.fires.length; i++) light(s.pos, 150, 0.8);
   }
   for (const f of world.flares) if (f.age >= f.flight) light(f.pos, world.flareR(f) * 1.15, 0.95);
   for (const e of world.effects) {
      const t = clamp01(e.age / e.life);
      if (e.kind === 'muzzle') light(e.pos, (e.big ? 260 : 140) * (1 - t), 0.8);
      else if (e.kind === 'explosion') light(e.pos, (e.big ? 300 : 150) * (1 - t * 0.7), 0.9);
      else if (e.kind === 'fire') light(e.pos, 120, 0.6);
   }
   ctx.drawImage(state.dark, 0, 0, cam.w, cam.h);
}

// Storm: rain curtains over the squalls, driving rain across the screen and the odd lightning flash.
// Daily modifier "Dichter Nebel": a grey veil that thickens with distance from the player.
export function drawFog(ctx, cam, world) {
   const p = world.player;
   if (!p) return;
   const c = cam.w2s(p.pos), z = cam.zoom;
   const g = ctx.createRadialGradient(c.x, c.y, 500 * z, c.x, c.y, 1500 * z);
   g.addColorStop(0, 'rgba(185,195,200,0)');
   g.addColorStop(1, 'rgba(185,195,200,0.5)');
   ctx.fillStyle = g;
   ctx.fillRect(0, 0, cam.w, cam.h);
}

export function drawStorm(ctx, cam, world) {
   const t = world.time;
   for (const q of world.squalls) {
      if (!cam.visible(q.c, q.r + 100)) continue;
      const c = cam.w2s(q.c), r = q.r * cam.zoom;
      const g = ctx.createRadialGradient(c.x, c.y, r * 0.2, c.x, c.y, r);
      g.addColorStop(0, 'rgba(150,165,180,0.55)');
      g.addColorStop(0.7, 'rgba(140,155,170,0.35)');
      g.addColorStop(1, 'rgba(140,155,170,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, TAU); ctx.fill();
   }
   ctx.fillStyle = 'rgba(30,40,50,0.16)';
   ctx.fillRect(0, 0, cam.w, cam.h);
   ctx.strokeStyle = 'rgba(200,215,230,0.22)';
   ctx.lineWidth = 1;
   ctx.beginPath();
   const n = Math.round(cam.w * cam.h / 9000);
   for (let i = 0; i < n; i++) {
      const x = ((i * 151.7 + t * 260) % (cam.w + 60)) - 30;
      const y = ((i * 97.3 * 1.37 + t * 900 + (i % 7) * 40) % (cam.h + 40)) - 20;
      ctx.moveTo(x, y); ctx.lineTo(x - 5, y + 15);
   }
   ctx.stroke();
   // lightning: a short double flash roughly every 14 s
   const ph = t % 14;
   if (ph < 0.08 || (ph > 0.16 && ph < 0.22)) {
      ctx.fillStyle = 'rgba(220,230,255,0.18)';
      ctx.fillRect(0, 0, cam.w, cam.h);
   }
}

// ================= minimap extras =================
export function drawMinimapExtras(g, world, mx, my, sc) {
   for (const q of world.squalls) {
      g.fillStyle = 'rgba(160,170,185,0.25)';
      g.beginPath(); g.arc(mx(q.c.x), my(q.c.y), Math.max(3, q.r * sc), 0, TAU); g.fill();
   }
   for (const zn of world.zones) {
      g.strokeStyle = zn.kind === 'goal' ? 'rgba(124,255,154,0.85)' : 'rgba(255,140,100,0.85)';
      g.setLineDash([2, 2]); g.lineWidth = 1;
      g.beginPath(); g.arc(mx(zn.c.x), my(zn.c.y), Math.max(4, zn.r * sc), 0, TAU); g.stroke();
      g.setLineDash([]);
   }
   g.fillStyle = '#ff6a50';
   for (const m of world.mines) if (m.alive && m.seen) g.fillRect(mx(m.pos.x) - 1, my(m.pos.y) - 1, 2, 2);
   for (const f of world.flares) {
      if (f.age < f.flight) continue;
      g.strokeStyle = 'rgba(255,240,170,0.6)';
      g.beginPath(); g.arc(mx(f.pos.x), my(f.pos.y), Math.max(2, world.flareR(f) * sc), 0, TAU); g.stroke();
   }
   for (const b of world.barrages) {
      g.fillStyle = 'rgba(255,50,30,0.6)';
      g.beginPath(); g.arc(mx(b.pos.x), my(b.pos.y), Math.max(2, b.r * sc), 0, TAU); g.fill();
   }
   for (const s of world.sonarPings) {
      g.strokeStyle = 'rgba(110,220,255,0.8)';
      g.beginPath(); g.arc(mx(s.pos.x), my(s.pos.y), 3, 0, TAU); g.stroke();
   }
   for (const a of world.aircraft) {
      g.fillStyle = a.side === 'enemy' ? '#ffb09a' : '#9fffb8';
      g.fillRect(mx(a.pos.x) - 1, my(a.pos.y) - 1, 2, 2);
   }
}
