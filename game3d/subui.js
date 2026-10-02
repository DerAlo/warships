// game3d/subui.js — client side of the submarine class (sim: submarine.js): the F/G depth keys,
// the depth / battery panel, depth-charge and sonar warnings, the periscope camera + optics, the
// deep-water view with hydrophone bearing lines, sonar contact markers and the audio hooks.
// main3d.js owns one SubUi and calls reset / input / event / frame / fill; hud3d.js calls the two
// draw functions with the `ui.sub` snapshot. Nothing here allocates per frame.
import { DEPTH_NAMES, SONAR_KEEP, diveDeeper, diveUp, dropDepthCharges, hydrophoneContacts } from './submarine.js';

const TAU = Math.PI * 2, DEG = Math.PI / 180;
const clamp01 = (x) => x < 0 ? 0 : x > 1 ? 1 : x;
const MAX_LINES = 12, MAX_CONTACTS = 4;
const TYPE_SOUND = { DD: 'schnelle Schrauben', CL: 'Kreuzer', CA: 'Kreuzer', BB: 'schwere Schrauben', CV: 'schwere Schrauben', TR: 'Frachter', SS: 'U-Boot' };
const CSS = `
#sub-panel { width: 150px; padding: 8px 10px; font: 12px var(--mono, Consolas, monospace); color: #cfe2f5; }
#sub-panel .sp-title { font: 700 11px var(--sans, 'Segoe UI', sans-serif); letter-spacing: .08em; color: #8fb0cf; margin-bottom: 5px; }
#sub-panel .sp-row { display: flex; align-items: center; gap: 6px; padding: 2px 4px; border-radius: 3px; color: #7f95aa; }
#sub-panel .sp-row i { width: 8px; height: 8px; border-radius: 50%; border: 1px solid #5f7890; flex: none; }
#sub-panel .sp-row.on { color: #fff; background: rgba(90,170,255,.22); }
#sub-panel .sp-row.on i { background: #7fd0ff; border-color: #7fd0ff; }
#sub-panel .sp-row.tgt i { border-color: #ffd479; }
#sub-panel .sp-bat { margin-top: 6px; height: 8px; background: rgba(255,255,255,.12); border-radius: 4px; overflow: hidden; }
#sub-panel .sp-bat i { display: block; height: 100%; width: 100%; background: #7cf29a; }
#sub-panel .sp-batt { display: flex; justify-content: space-between; margin-top: 3px; color: #a9bfd4; }
#sub-panel .sp-keys { margin-top: 5px; color: #7f95aa; font-size: 11px; }
#sub-panel .sp-ping { margin-top: 4px; color: #ff8a70; font-weight: 700; visibility: hidden; }
#sub-panel .sp-ping.on { visibility: visible; }
#asw-panel { padding: 6px 10px; font: 12px var(--mono, Consolas, monospace); color: #cfe2f5; min-width: 120px; }
#asw-panel b { color: #8fb0cf; font: 700 11px var(--sans, 'Segoe UI', sans-serif); letter-spacing: .08em; display: block; }
#asw-panel .ready { color: #7cf29a; }
#dc-alert { position: absolute; left: 50%; top: 24%; transform: translateX(-50%); padding: 6px 18px; border-radius: 4px;
   background: rgba(120,20,12,.82); color: #ffd9d0; font: 700 18px var(--sans, 'Segoe UI', sans-serif); letter-spacing: .12em; }
`;

function el(tag, id, cls, html) {
   const e = document.createElement(tag);
   if (id) e.id = id;
   if (cls) e.className = cls;
   if (html) e.innerHTML = html;
   return e;
}
const setText = (e, s) => { if (e && e._txt !== s) { e._txt = s; e.textContent = s; } };
const setCls = (e, c, on) => { const k = '_c' + c; if (e && e[k] !== on) { e[k] = on; e.classList.toggle(c, on); } };

export class SubUi {
   constructor({ hud, audio }) {
      this.hud = hud; this.audio = audio;
      this.dom = null;
      this.peri = { x: 0, y: 3 };          // camera3d rig: tower position ahead of the centre, lens height
      this.wasUnder = false;
      this.warnT = 0; this.pingShown = false;
      this.hyd = [];                       // hydrophoneContacts() scratch
      this.hydT = 0; this.hydN = 0;
      const pt = () => ({ x: 0, y: 0, visible: false });
      // ui.sub snapshot (one object, reused)
      this.ui = {
         isSub: false, depth: 0, depthF: 0, target: 0, battery: 1, lock: false, peri: false, deepA: 0, lensY: 3,
         relBrg: 0, origin: pt(), nLines: 0, nContacts: 0,
         lines: Array.from({ length: MAX_LINES }, () => ({ ...pt(), near: 0, label: '' })),
         contacts: Array.from({ length: MAX_CONTACTS }, () => ({ ...pt(), age: 0, dist: 0 })),
         map: { hydro: [], nHydro: 0, sonar: [], nSonar: 0 },
      };
      for (let i = 0; i < MAX_LINES; i++) this.ui.map.hydro.push(0);
      for (let i = 0; i < MAX_CONTACTS; i++) this.ui.map.sonar.push({ x: 0, y: 0, age: 0 });
   }

   _build() {
      if (this.dom || typeof document === 'undefined') return;
      const st = el('style'); st.textContent = CSS; document.head.appendChild(st);
      const sub = el('div', 'sub-panel', 'panel hidden',
         '<div class="sp-title">TAUCHTIEFE</div>'
         + DEPTH_NAMES.map((n, i) => `<div class="sp-row" data-d="${i}"><i></i><span>${n}</span></div>`).join('')
         + '<div class="sp-bat"><i></i></div><div class="sp-batt"><span>Batterie</span><span class="sp-pct">100 %</span></div>'
         + '<div class="sp-keys"><b>F</b> tiefer · <b>G</b> auf</div><div class="sp-ping">SONAR-ORTUNG</div>');
      const asw = el('div', 'asw-panel', 'panel hidden', '<b>WASSERBOMBEN · G</b><span class="asw-stat">bereit</span>');
      const alert = el('div', 'dc-alert', 'hidden'); alert.textContent = 'WASSERBOMBEN!';
      const br = document.getElementById('bottom-right'), hudRoot = document.getElementById('hud');
      if (br) { br.insertBefore(sub, br.firstChild); br.insertBefore(asw, br.firstChild); }
      hudRoot?.appendChild(alert);
      this.dom = { sub, asw, alert, rows: [...sub.querySelectorAll('.sp-row')], bat: sub.querySelector('.sp-bat i'),
         pct: sub.querySelector('.sp-pct'), ping: sub.querySelector('.sp-ping'), aswStat: asw.querySelector('.asw-stat') };
   }

   reset(world) {
      this._build();
      const p = world?.player, d = this.dom;
      this.warnT = 0; this.hydT = 0; this.hydN = 0;
      this.ui.nLines = 0; this.ui.nContacts = 0; this.ui.map.nHydro = 0; this.ui.map.nSonar = 0;
      this.wasUnder = !!(p && p.depth > 0);
      this.audio.setSubmerged?.(this.wasUnder);
      if (d) {
         setCls(d.sub, 'hidden', !p?.sub);
         setCls(d.asw, 'hidden', !(p?.asw && world.hasSubsEver !== false && anySubs(world, p)));
         setCls(d.alert, 'hidden', true);
      }
      if (p?.sub) {
         const h = p.cfg.hull;
         this.peri.x = h.sup ? h.sup.x || 0 : 0;
      }
   }

   // battle over / back to the port
   stop() { if (this.wasUnder) { this.wasUnder = false; this.audio.setSubmerged?.(false); } }

   // F deeper / G up in a boat; G drops a depth-charge pattern from a destroyer or light cruiser
   input(inp, p, world) {
      if (!p || !p.alive) return;
      const f = inp.tapped('F'), g = inp.tapped('G');
      if (p.sub) {
         if (f && !diveDeeper(p, world) && p.depthTarget >= 2) this.audio.denied?.();
         if (g && !diveUp(p, world)) this.audio.denied?.();
      } else if (g) {
         const a = p.asw;
         if (!a) { this.audio.denied?.(); this.hud.msg('Keine Wasserbomben an Bord', 'warn'); }
         else if (dropDepthCharges(p, world)) this.hud.msg('Wasserbomben los!', 'info');
         else { this.audio.denied?.(); this.hud.msg('Wasserbomben laden nach', 'warn'); }
      }
   }

   // sim events main3d does not know (its switch default)
   event(e, p, world, mine, onMe) {
      const A = this.audio, hud = this.hud;
      switch (e.type) {
         case 'depth':
            if (!mine) break;
            if (e.depth > e.from) A.subDive?.(); else A.subSurface?.();
            hud.msg(e.forced ? e.text : (e.depth > e.from ? 'Tauchen: ' : 'Auftauchen: ') + DEPTH_NAMES[e.depth], e.forced ? 'warn' : 'info');
            break;
         case 'subInfo': if (mine && e.text) { hud.msg(e.text, e.level || 'info'); A.denied?.(); } break;
         case 'sonar': {
            const src = byId(world, e.srcId);
            if (onMe) A.sonarPing?.(e.dist || 0);
            else if (src && src.side === p.side) {
               A.sonarPing?.(Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y));
               if (mine) hud.msg('Sonarkontakt: U-Boot', 'warn');
            }
            break;
         }
         case 'dcDrop':
            if (p.sub && !mine && e.pos && sideOf(world, e.srcId) !== p.side && Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y) < 700) this.warnT = 4;
            break;
         case 'depthCharge': {
            const d = e.pos ? Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y) : 9999;
            if (d < 9000) A.depthCharge?.(d);
            if (p.sub && d < 500 && sideOf(world, e.srcId) !== p.side) this.warnT = Math.max(this.warnT, 2.5);
            break;
         }
         case 'dc':
            if (mine) hud.msg('Wasserbombentreffer', 'good');
            if (onMe) { A.hit?.((e.dmg || 0) > p.maxHP * 0.05); hud.msg('Wasserbomben – Druckkörper beschädigt!', 'warn'); }
            break;
         case 'ram':
            if (mine) hud.msg('U-Boot gerammt!', 'good');
            if (onMe) { A.hit?.(true); hud.msg('Gerammt – sofort tiefer gehen!', 'warn'); }
            break;
         default: break;
      }
   }

   // per frame, before the render: camera rig + audio state. `zoom` is the ZoomLadder.
   frame(p, world, cam3, dt) {
      const sub = p && p.alive && p.sub ? p : null;
      const under = !!(sub && sub.depth > 0);
      if (under !== this.wasUnder) { this.wasUnder = under; this.audio.setSubmerged?.(under); }
      this.warnT = Math.max(0, this.warnT - dt);
      if (!sub || sub.depthF <= 0.5) { cam3.peri = null; return; }
      // lens: the head of the attack periscope (ships3d.js builds it 1.9 m above the sea at
      // periscope depth); a little higher so the swell does not wash over the picture all the time
      const h = sub.cfg.hull, top = (h.deckH || 3) + (h.sup ? h.sup.h : 5) + 3.4;
      this.peri.y = Math.max(3, top - sub.depthM + 1.1);
      cam3.peri = this.peri;
      if (sub.depth === 2) cam3.bino = false;      // deep: no optics
   }

   // fills the reused ui.sub snapshot; project(x, h, y, out) is main3d's world -> screen
   fill(ui, p, world, cam3, project, lensY, dt) {
      const u = this.ui, d = this.dom;
      ui.sub = u;
      u.isSub = !!p.sub;
      u.nLines = 0; u.nContacts = 0; u.map.nHydro = 0; u.map.nSonar = 0;
      u.peri = false; u.deepA = 0;
      if (p.sub && p.alive) {
         u.depth = p.depth; u.depthF = p.depthF; u.target = p.depthTarget; u.battery = p.battery; u.lock = p.batteryLock;
         u.peri = !!cam3.peri && p.depth === 1;
         u.deepA = clamp01((p.depthF - 1.1) / 0.6);
         u.lensY = lensY;
         let rel = ((ui.camYaw ?? cam3.yaw) - p.heading) / DEG % 360; if (rel < 0) rel += 360;
         u.relBrg = rel;
         // hydrophone: bearings only, refreshed a few times a second
         if (p.depth > 0) {
            this.hydT -= dt;
            if (this.hydT <= 0) { this.hydT = 0.25; this.hydN = hydrophoneContacts(world, p, this.hyd); }
            if (p.depth === 2) {
               project(p.pos.x, 0, p.pos.y, u.origin);
               const n = Math.min(this.hydN, MAX_LINES);
               for (let i = 0; i < n; i++) {
                  const c = this.hyd[i], L = u.lines[u.nLines];
                  const r = 1400 + 1600 * (1 - c.near);
                  project(p.pos.x + Math.cos(c.brg) * r, 0, p.pos.y + Math.sin(c.brg) * r, L);
                  L.near = c.near; L.label = TYPE_SOUND[c.type] || 'Schrauben';
                  u.map.hydro[u.nLines] = c.brg;
                  u.nLines++;
               }
               u.map.nHydro = u.nLines;
            }
         } else this.hydN = 0;
      }
      // sonar contacts of the own team on enemy boats that are not in sight
      if (world.hasSubs) {
         const now = world.time;
         for (const s of world.ships) {
            if (u.nContacts >= MAX_CONTACTS) break;
            const c = s.sonarSeen;
            if (!c || !s.alive || s.side === p.side || s.spotted === true || now - c.t > SONAR_KEEP) continue;
            const o = u.contacts[u.nContacts], m = u.map.sonar[u.nContacts];
            project(c.x, 0, c.y, o);
            o.age = now - c.t; o.dist = Math.hypot(c.x - p.pos.x, c.y - p.pos.y);
            m.x = c.x; m.y = c.y; m.age = o.age;
            u.nContacts++;
         }
         u.map.nSonar = u.nContacts;
      }
      // ---- DOM
      if (!d) return;
      if (p.sub) {
         for (let i = 0; i < 3; i++) { setCls(d.rows[i], 'on', p.depth === i); setCls(d.rows[i], 'tgt', p.depthTarget === i && p.depth !== i); }
         const pct = Math.round(p.battery * 100);
         if (d.bat._w !== pct) { d.bat._w = pct; d.bat.style.width = pct + '%'; d.bat.style.background = p.batteryLock ? '#ff5a4d' : pct > 35 ? '#7cf29a' : '#ffc94a'; }
         setText(d.pct, p.batteryLock ? 'leer – lädt' : pct + ' %');
         const pinged = world.time - p.pingT < 3;
         setCls(d.ping, 'on', pinged);
         setCls(d.alert, 'hidden', !(this.warnT > 0));
      } else if (p.asw) {
         const a = p.asw, show = world.hasSubs || a.reload > 0;
         setCls(d.asw, 'hidden', !show);
         if (show) {
            const rdy = a.reload <= 0 && a.left <= 0;
            setCls(d.aswStat, 'ready', rdy);
            setText(d.aswStat, rdy ? 'bereit' : a.left > 0 ? 'Wurf läuft' : 'lädt ' + Math.ceil(a.reload) + ' s');
         }
      }
   }
}

function anySubs(world, p) { for (const s of world.ships) if (s.sub && s.side !== p.side) return true; return false; }
function byId(world, id) { for (const s of world.ships) if (s.id === id) return s; return null; }
function sideOf(world, id) { const s = byId(world, id); return s ? s.side : ''; }

// ---------------------------------------------------------------- canvas drawing (hud3d.js)
// Under the markers: the deep-water veil with hydrophone bearings, and sonar contact markers.
export function drawSubUnder(g, ui, W, H, t) {
   const u = ui.sub;
   if (!u) return;
   if (u.deepA > 0.01) {
      g.save();
      g.globalAlpha = u.deepA;
      const grd = g.createLinearGradient(0, 0, 0, H);
      grd.addColorStop(0, 'rgba(6,40,58,0.80)');
      grd.addColorStop(1, 'rgba(2,14,26,0.93)');
      g.fillStyle = grd;
      g.fillRect(0, 0, W, H);
      const o = u.origin;
      const ox = o.visible ? o.x : W / 2, oy = o.visible ? o.y : H * 0.62;
      // own boat + listening rings
      g.strokeStyle = 'rgba(140,220,255,0.35)'; g.lineWidth = 1;
      for (let i = 1; i <= 3; i++) { g.beginPath(); g.ellipse(ox, oy, i * 70, i * 24, 0, 0, TAU); g.stroke(); }
      g.fillStyle = 'rgba(160,230,255,0.9)';
      g.beginPath(); g.arc(ox, oy, 3, 0, TAU); g.fill();
      g.font = '600 12px Segoe UI, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (let i = 0; i < u.nLines; i++) {
         const L = u.lines[i];
         let dx = L.x - ox, dy = L.y - oy;
         const len = Math.hypot(dx, dy) || 1;
         if (!L.visible || len < 30) continue;
         const k = Math.min(1, Math.min(W, H) * 0.42 / len);
         dx *= k; dy *= k;
         const a = 0.35 + 0.6 * L.near;
         g.strokeStyle = `rgba(255,150,110,${a})`; g.lineWidth = 1 + 2 * L.near;
         g.setLineDash([10, 7]);
         g.beginPath(); g.moveTo(ox, oy); g.lineTo(ox + dx, oy + dy); g.stroke();
         g.setLineDash([]);
         g.fillStyle = `rgba(255,190,160,${a})`;
         g.fillText(L.label, ox + dx * 1.08, oy + dy * 1.08 - 8);
      }
      g.fillStyle = 'rgba(170,220,245,0.85)'; g.font = '600 13px Segoe UI, sans-serif';
      g.fillText('GETAUCHT · Horchgerät: nur Peilungen · G = auf Sehrohrtiefe', W / 2, H * 0.16);
      g.restore();
   }
   if (u.nContacts > 0) {
      g.save();
      g.font = '600 11px Segoe UI, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'bottom';
      for (let i = 0; i < u.nContacts; i++) {
         const c = u.contacts[i];
         if (!c.visible) continue;
         const a = clamp01(1 - c.age / SONAR_KEEP), r = 9 + ((t * 14 + i * 5) % 14);
         g.strokeStyle = `rgba(120,255,190,${0.9 * a})`; g.lineWidth = 2;
         g.beginPath(); g.arc(c.x, c.y, 8, 0, TAU); g.stroke();
         g.strokeStyle = `rgba(120,255,190,${0.45 * a * (1 - (r - 9) / 14)})`; g.lineWidth = 1.5;
         g.beginPath(); g.arc(c.x, c.y, r, 0, TAU); g.stroke();
         g.fillStyle = `rgba(160,255,210,${a})`;
         g.fillText('SONAR ' + (c.dist / 1000).toFixed(1).replace('.', ',') + ' km', c.x, c.y - 14);
      }
      g.restore();
   }
}

// Periscope optics: circular mask, graticule, relative-bearing tape and range marks (replaces the
// binocular vignette while the boat is at periscope depth).
export function drawPeriscope(g, ui, W, H) {
   const u = ui.sub, a = clamp01(ui.scopeT), cx = W / 2, cy = H / 2;
   const R = Math.min(W, H) * 0.46;
   g.save();
   g.globalAlpha = a;
   // everything outside the eyepiece is black
   g.fillStyle = 'rgba(2,5,8,0.97)';
   g.beginPath(); g.rect(0, 0, W, H); g.arc(cx, cy, R, 0, TAU, true); g.fill();
   const grd = g.createRadialGradient(cx, cy, R * 0.7, cx, cy, R);
   grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, 'rgba(0,10,8,0.6)');
   g.fillStyle = grd;
   g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.fill();
   g.strokeStyle = 'rgba(160,210,190,0.55)'; g.lineWidth = 2;
   g.beginPath(); g.arc(cx, cy, R - 1, 0, TAU); g.stroke();
   // graticule
   g.strokeStyle = 'rgba(190,240,215,0.5)'; g.lineWidth = 1;
   g.beginPath();
   g.moveTo(cx - R * 0.94, cy); g.lineTo(cx - 46, cy); g.moveTo(cx + 46, cy); g.lineTo(cx + R * 0.94, cy);
   g.moveTo(cx, cy - R * 0.94); g.lineTo(cx, cy - 46); g.moveTo(cx, cy + 130); g.lineTo(cx, cy + R * 0.94);
   g.stroke();
   // relative bearing tape along the upper rim (000 = own bow, clockwise)
   const ppd = ui.pxPerRad * DEG;                      // px per degree
   const step = ppd > 60 ? 1 : ppd > 24 ? 2 : ppd > 12 ? 5 : 10;
   const span = R * 0.62 / ppd, yT = cy - R * 0.74;
   g.font = '11px Consolas, monospace'; g.textAlign = 'center'; g.textBaseline = 'bottom';
   g.fillStyle = 'rgba(200,245,220,0.85)'; g.strokeStyle = 'rgba(200,245,220,0.7)';
   g.beginPath();
   const b0 = Math.ceil((u.relBrg - span) / step) * step;
   for (let b = b0; b <= u.relBrg + span; b += step) {
      const x = cx + (b - u.relBrg) * ppd, big = Math.round(b / step) % 5 === 0 || step >= 5;
      g.moveTo(x, yT); g.lineTo(x, yT + (big ? 12 : 6));
      if (big) g.fillText(String(Math.round((b % 360 + 360) % 360)).padStart(3, '0'), x, yT - 2);
   }
   g.moveTo(cx - 5, yT + 22); g.lineTo(cx, yT + 14); g.lineTo(cx + 5, yT + 22);
   g.stroke();
   // range marks: where the sea surface at 0.5 / 1 / 2 / 4 km sits below the crosshair line
   const Ra = Math.max(200, ui.range || 3000);
   g.textAlign = 'right'; g.textBaseline = 'middle';
   g.beginPath();
   for (const km of [0.5, 1, 2, 4]) {
      const y = cy + ui.pxPerRad * (u.lensY / (km * 1000) - u.lensY / Ra);
      if (y < cy - R * 0.5 || y > cy + R * 0.6 || Math.abs(y - cy) < 5) continue;
      g.moveTo(cx - 34, y); g.lineTo(cx - 14, y);
      g.fillText(String(km).replace('.', ',') + ' km', cx - 38, y);
   }
   g.stroke();
   // read-outs
   g.font = 'bold 16px Consolas, monospace'; g.textAlign = 'right'; g.textBaseline = 'alphabetic';
   g.fillStyle = 'rgba(200,245,220,0.9)';
   g.fillText(ui.zoom + '×', cx + R * 0.86, cy - 10);
   g.textAlign = 'left';
   g.fillText('Peilung ' + String(Math.round(u.relBrg) % 360).padStart(3, '0') + '°', cx - R * 0.86, cy - 10);
   g.font = '11px Consolas, monospace'; g.fillStyle = 'rgba(200,245,220,0.55)';
   g.fillText('SEHROHR · Mausrad: Zoom · Shift: einfahren', cx - R * 0.86, cy - 30);
   g.restore();
}

// Minimap / tactical map layer (minimap3d.js paintMap): hydrophone bearings and sonar contacts.
export function drawSubMap(g, m, p, mx, my, size, time) {
   if (!m || !p) return;
   if (m.nHydro > 0) {
      const px = mx(p.pos.x), py = my(p.pos.y), r = size * 0.5;
      g.strokeStyle = 'rgba(255,150,110,0.75)'; g.lineWidth = 1; g.setLineDash([4, 3]);
      g.beginPath();
      for (let i = 0; i < m.nHydro; i++) { g.moveTo(px, py); g.lineTo(px + Math.cos(m.hydro[i]) * r, py + Math.sin(m.hydro[i]) * r); }
      g.stroke(); g.setLineDash([]);
   }
   for (let i = 0; i < m.nSonar; i++) {
      const c = m.sonar[i], x = mx(c.x), y = my(c.y), a = clamp01(1 - c.age / SONAR_KEEP);
      g.strokeStyle = `rgba(120,255,190,${0.4 + 0.6 * a})`; g.lineWidth = 1.5;
      g.beginPath(); g.arc(x, y, 4 + ((time * 6) % 5), 0, TAU); g.stroke();
   }
}
