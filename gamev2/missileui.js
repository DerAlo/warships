// gamev2/missileui.js — client side of the guided-weapon systems (sim: missile.js, sensors.js,
// sites.js): weapon keys and launches (anti-ship missile at a track or along a bearing, cruise
// missiles and rockets by a click on the tactical map), radar / EMCON, air-defence doctrine and
// priority target, the "Vampire" threat display, the air-defence status plate, contact quality and
// the missile / decoy / land-site layers of the charts. Every action goes through `act` (net/command.js)
// so a co-op client sends the same commands.
// main3d.js owns one MissileUi: reset / input / fire / event / frame / fill. hud3d.js and minimap3d.js
// call the draw functions with the `ui.mx` snapshot.
import { MISSILES, WORLD } from './config.js';
import { ssmBlock, ssmType, cruiseBlock, rocketState, DOCTRINES, DOCTRINE_NAMES, inbound, samStatus } from './missile.js';
import { contactLevel } from './sensors.js';
import { T, FONT, MONO, rgba } from './theme.js';
import { slotTip, hints } from './guide.js';

const TAU = Math.PI * 2, DEG = Math.PI / 180;
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const clamp01 = (x) => x < 0 ? 0 : x > 1 ? 1 : x;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const isTouch = () => typeof document !== 'undefined' && !!document.body?.classList.contains('touch');
const setText = (e, s) => { if (e && e._txt !== s) { e._txt = s; e.textContent = s; } };
const setCls = (e, c, on) => { const k = '_c' + c; if (e && e[k] !== on) { e[k] = on; e.classList.toggle(c, on); } };
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const km = (m) => (m / 1000).toFixed(1).replace('.', ',') + ' km';
// sim heading (0 = east, y grows south) -> compass degrees, three digits
export const compass = (h) => String(Math.round(((h / DEG + 90) % 360 + 360) % 360) % 360).padStart(3, '0') + '°';

export const BLOCK_TEXT = { none: 'Nicht an Bord', empty: 'Leer', reload: 'Lädt nach', notrack: 'Kein Ziel', range: 'Außer Reichweite' };
export const LEVEL_TEXT = ['', 'ESM-Peilung', 'Kontakt', 'Feuerleitlösung'];
export const SITE_SHORT = { battery: 'Küstenbatterie', sam: 'Flugabwehr', radar: 'Radar', airfield: 'Flugplatz', bunker: 'Bunker', launcher: 'Startrampe' };
// consumable key -> keyboard slot (R / T belong to radar and priority target in this game)
export const CONS_KEYS = { damageControl: 'Y', repair: 'U', decoy: 'F', jammer: 'J', hydro: 'N' };
export const KIND_COL = { ssm: '#ff6a4a', cruise: '#ffb347', sam: '#9fe8ff', aam: '#9fe8ff', rocket: '#ffd27a' };

// The tactical map rectangle on the overlay (hud3d.js draws it there; the map cursor reads it back).
export function tacticalMapRect(W, H) {
   const size = Math.max(200, Math.min(W - 80, H - 92 - 150));
   return { x0: Math.round((W - size) / 2), y0: 92, size };
}
const arenaOf = (world) => world?.arena || WORLD.ARENA || 3800;

const CSS = `
#mx-sys { display: flex; align-items: stretch; gap: 0; border: 1px solid var(--panel-edge); background: var(--panel); font: 11px var(--mono); color: var(--hud); pointer-events: auto; }
#mx-sys > div { padding: 4px 9px 4px; border-right: 1px solid rgba(255,255,255,.07); white-space: nowrap; display: flex; align-items: center; gap: 6px; min-height: 26px; }
#mx-sys > div:last-child { border-right: 0; }
#mx-sys .mx-k { width: 15px; height: 15px; border-radius: 50%; font: 700 10px/15px var(--mono); text-align: center; color: var(--ink); background: var(--gold); flex: none; }
#mx-sys .mx-l { font: 600 9.5px var(--font); letter-spacing: 1.5px; text-transform: uppercase; color: var(--hud-dim); }
#mx-sys b { font-weight: 700; color: #fff; }
#mx-radar.on b { color: var(--ok); }
#mx-radar.emcon { background: color-mix(in srgb, var(--warn) 22%, transparent); box-shadow: inset 0 -3px 0 var(--warn); }
#mx-radar.emcon b { color: var(--warn); }
#mx-radar.jam b::after { content: ' · STÖRT'; color: var(--gold); }
#mx-doc.free b { color: var(--ok); } #mx-doc.self b { color: var(--warn); } #mx-doc.hold b { color: var(--bad); }
#mx-prio.on b { color: var(--gold); }
#mx-layers { gap: 10px !important; }
#mx-layers .ly { display: inline-flex; align-items: center; gap: 4px; color: var(--hud-dim); }
#mx-layers .ly.empty b { color: var(--bad); }
#mx-layers .ly.busy { color: #fff; }
#mx-layers .ch { display: inline-flex; gap: 2px; }
#mx-layers .ch i { width: 5px; height: 9px; background: rgba(255,255,255,.18); }
#mx-layers .ch i.on { background: var(--gold); }
#mx-layers .ly.fire .ch i.on { background: var(--bad); }
#mx-threat { position: absolute; left: 16px; top: 96px; min-width: 214px; padding: 6px 9px 7px; font: 12px var(--mono); color: var(--hud);
   border-color: color-mix(in srgb, var(--bad) 70%, transparent); border-top: 3px solid var(--bad); }
#mx-threat .vt { font: 700 12px var(--font); letter-spacing: 3px; color: #ffd9d0; display: flex; justify-content: space-between; gap: 12px; margin-bottom: 3px; }
#mx-threat.hot .vt { animation: mxblink .5s steps(2) infinite; }
@keyframes mxblink { 50% { color: var(--bad); } }
#mx-threat .vr { display: grid; grid-template-columns: 1fr 38px 34px 64px; gap: 6px; padding: 1px 0; color: var(--hud-dim); }
#mx-threat .vr.me { color: #fff; }
#mx-threat .vr span:nth-child(2), #mx-threat .vr span:nth-child(3) { text-align: right; }
#mx-threat .vr .st { text-align: right; color: var(--bad); }
#mx-threat .vr .st.eng { color: var(--ok); } #mx-threat .vr .st.sed { color: var(--hud-dim); }
#mx-threat .vm { color: var(--hud-dim); font-size: 11px; margin-top: 2px; }
body.touch #mx-sys { font-size: 10.5px; }
body.touch #mx-sys > div { padding: 3px 7px; min-height: 40px; }
body.touch #mx-sys .mx-k { display: none; }
body.touch #mx-threat { top: 66px; left: 50%; transform: translateX(-50%); min-width: 0; padding: 4px 8px 5px; font-size: 11px; }
body.touch #mx-threat .vr:nth-child(n+4), body.touch #mx-threat .vm { display: none; }
@media (max-height: 480px) { body.touch #mx-threat { top: 8px; } }   /* phone: the system buttons sit to the right there */
`;

function el(tag, id, cls, html) {
   const e = document.createElement(tag);
   if (id) e.id = id;
   if (cls) e.className = cls;
   if (html) e.innerHTML = html;
   return e;
}

const MAX_THREATS = 12, MAX_ROWS = 4;
const MARK_SECS = 60;            // s the last map target stays marked on the chart

export class MissileUi {
   constructor({ hud, audio }) {
      this.hud = hud; this.audio = audio;
      this.dom = null;
      this.cur = { x: 0, y: 0, moved: false };     // tactical-map cursor, CSS px
      this.click = false;
      this.scanT = 0; this.toneT = 0; this.ciwsT = 0; this.msgT = -99;
      this.known = new Set();                       // inbound missile ids already announced
      this.lastTgt = null;                          // last cruise / rocket target on the map { x, y, t }
      this.threats = []; this.status = null;
      // ui.mx snapshot (one object, reused)
      this.ui = {
         on: false, mode: 'guns', threats: this.threats, nMine: 0, minTti: Infinity, status: null, radarOn: true, emcon: false,
         aimInfo: '', aimBad: false, ghosts: [], sites: [], map: { mode: null, cur: null, range: 0, block: null, lastTgt: null, siteId: null },
      };
      if (typeof window !== 'undefined') {
         window.addEventListener('pointermove', (e) => {
            const c = this.cur;
            if (document.pointerLockElement) { c.x += e.movementX || 0; c.y += e.movementY || 0; }
            else { c.x = e.clientX; c.y = e.clientY; }
            c.x = clamp(c.x, 0, window.innerWidth); c.y = clamp(c.y, 0, window.innerHeight);
            c.moved = true;
         });
         window.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            if (!document.pointerLockElement) {
               this.cur.x = e.clientX; this.cur.y = e.clientY; this.cur.moved = true;
               if (e.target?.tagName !== 'CANVAS') return;         // a HUD button, not the chart
            }
            this.click = true;
         });
      }
   }

   _build() {
      if (this.dom || typeof document === 'undefined') return;
      const st = el('style'); st.textContent = CSS; document.head.appendChild(st);
      const sys = el('div', 'mx-sys', 'hidden',
         '<div id="mx-radar" data-key="R" title="Radar an / aus (R). Aus = EMCON: du strahlst nicht, siehst aber nur mit Optik und ESM."><i class="mx-k">R</i><span class="mx-l">Radar</span><b>AN</b></div>'
         + '<div id="mx-doc" data-key="V" title="Luftabwehr-Doktrin (V): Feuer frei – alles im Bereich · Selbstschutz – nur was auf dich zufliegt · Feuer halten"><i class="mx-k">V</i><span class="mx-l">Luftabwehr</span><b>Feuer frei</b></div>'
         + '<div id="mx-layers" title="Luftabwehr: Flugkörper im Magazin und belegte Feuerleitkanäle"></div>'
         + '<div id="mx-prio" data-key="T" title="Vorrangziel der Luftabwehr (T): der anfliegende Flugkörper in Blickrichtung"><i class="mx-k">T</i><span class="mx-l">Vorrang</span><b>—</b></div>');
      const thr = el('div', 'mx-threat', 'panel hidden', '<div class="vt"><span>VAMPIRE</span><span class="vn"></span></div><div class="vl"></div><div class="vm"></div>');
      const bc = document.getElementById('bottom-center'), weapons = document.getElementById('weapons'), hudRoot = document.getElementById('hud');
      // (touch3d.js regroups the plates: the row follows the weapon bar wherever that sits)
      if (weapons?.parentNode) weapons.parentNode.insertBefore(sys, weapons); else (bc || hudRoot)?.appendChild(sys);
      hudRoot?.appendChild(thr);
      const q = (r, s) => r.querySelector(s);
      this.dom = {
         sys, thr, radar: q(sys, '#mx-radar'), radarB: q(sys, '#mx-radar b'), doc: q(sys, '#mx-doc'), docB: q(sys, '#mx-doc b'),
         layers: q(sys, '#mx-layers'), prio: q(sys, '#mx-prio'), prioB: q(sys, '#mx-prio b'),
         vn: q(thr, '.vn'), vl: q(thr, '.vl'), vm: q(thr, '.vm'), laySig: '', rowSig: '',
      };
   }

   reset(world) {
      this._build();
      this.known.clear(); this.threats.length = 0; this.status = null;
      this.scanT = 0; this.toneT = 0; this.ciwsT = 0; this.msgT = -99; this.lastTgt = null; this.click = false;
      this.cur.x = (typeof window !== 'undefined' ? window.innerWidth : 0) / 2; this.cur.y = (typeof window !== 'undefined' ? window.innerHeight : 0) / 2;
      const d = this.dom;
      if (d) { d.laySig = ''; d.rowSig = ''; d.layers.innerHTML = ''; d.vl.innerHTML = ''; setCls(d.thr, 'hidden', true); setCls(d.sys, 'hidden', !world?.player); }
   }

   // ---------------------------------------------------------------- what the platform carries
   static has(p) {
      const w = p?.cfg?.weapons || {};
      return {
         gun: !!p?.turrets?.length, ssm: !!w.ssm?.length, cruise: !!w.cruise, rockets: !!rocketState(p), torp: !!(p?.torps || p?.cfg?.torps),
         sam: !!w.sam?.length, ciws: !!w.ciws, radar: !!p?.cfg?.radar,
      };
   }
   // First usable weapon mode of a platform (ships without a gun start on their missiles / torpedoes).
   static defaultMode(p) {
      const h = MissileUi.has(p);
      return h.gun ? 'guns' : h.torp ? 'torp' : h.ssm ? 'ssm' : h.cruise ? 'cruise' : 'guns';
   }

   // ---------------------------------------------------------------- keys + map targeting
   // c: { ctl, aim, lockId, W, H }
   input(inp, p, world, act, c) {
      const click = this.click; this.click = false;
      if (!p || !p.alive) return;
      const ctl = c.ctl, A = this.audio, hud = this.hud, h = MissileUi.has(p);
      if (!p.air) {
         if (inp.tapped('2')) {
            if (!h.ssm) this._deny('Keine Seezielflugkörper an Bord');
            else if (ctl.mode === 'ssm' && p.cfg.weapons.ssm.length > 1) {
               const list = p.cfg.weapons.ssm, i = (list.findIndex(s => s.type === ssmType(p)) + 1) % list.length;
               act(['q', i]); A.ammoSwitch?.();
               hud.msg('Seezielflugkörper: ' + MISSILES[list[i].type].name, 'info');
            } else { ctl.mode = 'ssm'; A.ammoSwitch?.(); }
         }
         if (inp.tapped('3')) {
            if (!h.cruise) this._deny('Keine Marschflugkörper an Bord');
            else {
               const was = ctl.mode === 'cruise';
               ctl.mode = 'cruise'; A.ammoSwitch?.();
               if (!ctl.mapOpen || !was) { ctl.mapOpen = true; this._hint('Marschflugkörper: Ziel auf der Lagekarte ' + (isTouch() ? 'antippen' : 'anklicken')); }
               else ctl.mapOpen = false;
            }
         }
         if (inp.tapped('4')) {
            if (!h.rockets) this._deny('Keine Raketenwerfer an Bord');
            else { ctl.mode = 'rockets'; A.ammoSwitch?.(); }
         }
      }
      if (inp.tapped('R')) {
         if (!h.radar) this._deny('Kein Radar an Bord');
         else if (p.depth > 0) this._deny('Getaucht: kein Radar');
         else {
            const on = !p.radarOn;
            act(['r', on ? 1 : 0]); A.uiClick?.();
            hud.msg(on ? 'Radar an – du strahlst' : 'EMCON – Radar aus, nur Optik und ESM', on ? 'info' : 'warn');
         }
      }
      if (inp.tapped('V')) {
         if (!h.sam && !h.ciws) this._deny('Keine Luftabwehr an Bord');
         else {
            const d = DOCTRINES[(DOCTRINES.indexOf(p.samDoctrine) + 1) % DOCTRINES.length];
            act(['D', d]); A.uiClick?.();
            hud.msg('Luftabwehr: ' + DOCTRINE_NAMES[d], d === 'hold' ? 'warn' : 'info');
         }
      }
      if (inp.tapped('T')) this._priority(p, world, act, c);

      // map targeting: cruise missiles / rockets at the point (or the land position) under the cursor
      if (ctl.mapOpen && (ctl.mode === 'cruise' || ctl.mode === 'rockets') && click) {
         const pt = this._mapPoint(world, p, c.W, c.H);
         if (pt) this._launchAt(p, world, act, ctl.mode, pt);
      }
   }
   _deny(text) { this.audio.denied?.(); if (text) this.hud.msg(text, 'warn'); }
   _hint(text) { this.hud.msg(text, 'info'); }

   _priority(p, world, act, c) {
      const h = MissileUi.has(p);
      if (!h.sam && !h.ciws) { this._deny('Keine Luftabwehr an Bord'); return; }
      const list = inbound(world, p.side);
      let best = null, bd = 0.6;
      for (const t of list) {
         const off = Math.abs(wrap(Math.atan2(t.y - p.pos.y, t.x - p.pos.x) - c.aim.yaw));
         if (off < bd) { bd = off; best = t; }
      }
      if (!best && p.samPriority == null) best = list.find(t => t.targetId === p.id) || list[0] || null;
      if (!best || best.id === p.samPriority) {
         if (p.samPriority != null) { act(['p', null]); this.audio.uiClick?.(); this.hud.msg('Vorrangziel aufgehoben', 'info'); }
         else this._deny('Kein Flugkörper im Anflug');
         return;
      }
      act(['p', best.id]); this.audio.lock?.();
      this.hud.msg('Vorrangziel: ' + best.name + ' · Peilung ' + compass(Math.atan2(best.y - p.pos.y, best.x - p.pos.x)), 'info');
   }

   // world point under the map cursor (+ a known hostile land position it snaps to)
   _mapPoint(world, p, W, H) {
      const r = tacticalMapRect(W, H), A = arenaOf(world), sc = r.size / (A * 2), c = this.cur;
      if (c.x < r.x0 || c.x > r.x0 + r.size || c.y < r.y0 || c.y > r.y0 + r.size) return null;
      const pt = { x: (c.x - r.x0) / sc - A, y: (c.y - r.y0) / sc - A, siteId: null, name: '' };
      let bd = (isTouch() ? 22 : 14) / sc;
      for (const s of world.sites || []) {
         if (!s.alive || s.side === p.side || contactLevel(world, p.side, s) < 2) continue;
         const d = Math.hypot(s.pos.x - pt.x, s.pos.y - pt.y);
         if (d < bd) { bd = d; pt.siteId = s.id; pt.name = s.name; pt.sx = s.pos.x; pt.sy = s.pos.y; }
      }
      return pt;
   }
   _launchAt(p, world, act, mode, pt) {
      if (mode === 'cruise') {
         const aim = pt.siteId != null ? { siteId: pt.siteId } : { x: pt.x, y: pt.y };
         const b = cruiseBlock(world, p, aim);
         if (b) { this._deny('Marschflugkörper: ' + BLOCK_TEXT[b]); return false; }
         const ok = pt.siteId != null ? act(['K', pt.siteId]) : act(['k', pt.x, pt.y]);
         if (!ok) { this._deny('Marschflugkörper: ' + BLOCK_TEXT.reload); return false; }
         this.lastTgt = { x: pt.sx ?? pt.x, y: pt.sy ?? pt.y, t: world.time, mode, siteId: pt.siteId ?? null };
         this.hud.msg(MISSILES[p.cfg.weapons.cruise.type].name + ' gestartet → ' + (pt.name || 'Kartenpunkt'), 'info');
         return true;
      }
      const st = rocketState(p);
      if (!st) { this._deny('Keine Raketenwerfer an Bord'); return false; }
      if (world.time < st.readyT) { this._deny('Raketen: ' + BLOCK_TEXT.reload); return false; }
      const n = act(['o', pt.sx ?? pt.x, pt.sy ?? pt.y]);
      if (!n) { this._deny('Raketen: ' + BLOCK_TEXT.reload); return false; }
      this.lastTgt = { x: pt.sx ?? pt.x, y: pt.sy ?? pt.y, t: world.time, mode, siteId: null };
      return true;
   }
   // The map target of the last minute (the cross on the chart) for this weapon, or null.
   marked(world, mode) {
      const t = this.lastTgt;
      return t && world && t.mode === mode && world.time - t.t < MARK_SECS ? t : null;
   }
   // Touch: the fire button while the chart of a map-aimed weapon is open. One more at the marked
   // target; with nothing marked it says what to do (the chart itself takes the target tap).
   chartFire(p, world, act, mode) {
      const t = this.marked(world, mode);
      if (!t) { this.audio.uiClick?.(); this._hint('Ziel auf der Karte antippen'); return false; }
      const site = t.siteId != null ? (world.sites || []).find(s => s.id === t.siteId && s.alive) : null;
      return this._launchAt(p, world, act, mode, site ? { x: t.x, y: t.y, sx: t.x, sy: t.y, siteId: site.id, name: site.name }
         : { x: t.x, y: t.y, siteId: null, name: '' });
   }

   // The contact the anti-ship missile would go for: the locked ship, else the one under the crosshair.
   _ssmTarget(world, p, c) {
      const id = c.lockId != null ? c.lockId : c.aim.snapped;
      if (id == null) return null;
      const s = world.shipById ? world.shipById(id) : world.ships.find(x => x.id === id);
      return s && s.alive && s.side !== p.side ? s : null;
   }

   // Fire key / click with a guided weapon selected. c: { ctl, aim, lockId }. True = something left the ship.
   fire(p, world, act, c) {
      const mode = c.ctl.mode;
      if (mode === 'ssm') {
         const type = ssmType(p), name = MISSILES[type]?.name || 'Flugkörper';
         const tgt = this._ssmTarget(world, p, c);
         let b = ssmBlock(world, p, tgt ? { targetId: tgt.id } : { bearing: c.aim.yaw });
         if (tgt && b === 'notrack') {
            // seen but no fire-control solution: send it down the bearing, its own seeker has to find the ship
            const brg = Math.atan2(tgt.pos.y - p.pos.y, tgt.pos.x - p.pos.x);
            b = ssmBlock(world, p, { bearing: brg });
            if (!b && act(['b', brg])) { this.hud.msg(name + ' · Peilungsschuss ' + compass(brg) + ' (keine Feuerleitlösung)', 'info'); return true; }
         }
         if (b) { this._deny(name + ': ' + BLOCK_TEXT[b]); return false; }
         if (tgt) {
            if (!act(['m', tgt.id])) { this._deny(name + ': ' + BLOCK_TEXT.notrack); return false; }
            this.hud.msg(name + ' gestartet → ' + (tgt.name || tgt.cls), 'info');
            return true;
         }
         if (!act(['b', c.aim.yaw])) { this._deny(name + ': ' + BLOCK_TEXT.reload); return false; }
         this.hud.msg(name + ' · Peilungsschuss ' + compass(c.aim.yaw), 'info');
         return true;
      }
      if (mode === 'rockets') return this._launchAt(p, world, act, 'rockets', { x: c.aim.point.x, y: c.aim.point.y, siteId: null, name: '' });
      if (mode === 'cruise') {
         c.ctl.mapOpen = true;
         this._hint('Marschflugkörper: Ziel auf der Lagekarte ' + (isTouch() ? 'antippen' : 'anklicken'));
      }
      return false;
   }

   // ---------------------------------------------------------------- sim events -> sound
   event(e, p, world) {
      if (!p || !e.pos) return;
      const A = this.audio, d = Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y), own = e.srcId === p.id;
      switch (e.type) {
         case 'ssmLaunch': A.missileLaunch('ssm', d, e.pos, own); break;
         case 'cruiseLaunch': A.missileLaunch('cruise', d, e.pos, own); break;
         case 'samLaunch': A.missileLaunch('sam', d, e.pos, own); break;
         case 'aamLaunch': A.missileLaunch('aam', d, e.pos, false); break;
         case 'rockets': A.missileLaunch('rocket', d, e.pos, own); break;
         case 'intercept': A.intercept(d, e.pos); break;
         case 'missileHit': A.missileHit(d, e.pos, (e.dmg || 0) > 5000); break;
         case 'siteDestroyed': A.missileHit(d, e.pos, true); break;
         case 'decoy': A.decoys(d, e.pos); break;
         case 'seduced': if (e.dstId === p.id || d < 2500) this.hud.msg('Flugkörper abgelenkt', 'info'); break;
         default: break;
      }
   }

   // ---------------------------------------------------------------- per frame: threat scan + warning sounds
   frame(p, world, dt) {
      if (!p || !world) return;
      this.scanT -= dt;
      if (this.scanT <= 0) {
         this.scanT = 0.1;
         this._scan(p, world);
      }
      const u = this.ui;
      if (!p.alive) return;
      // warning tone: one call per new track, then a repeating urgent tone while one closes on the own ship
      this.toneT -= dt;
      if (u.nMine && u.minTti < 12 && this.toneT <= 0) { this.audio.vampire(u.minTti < 6); this.toneT = u.minTti < 6 ? 0.9 : 1.8; }
      this.ciwsT -= dt;
      if (p.ciwsTgt?.length && this.ciwsT <= 0) { this.audio.ciws(0, p.pos); this.ciwsT = 0.24; }
   }
   _scan(p, world) {
      const u = this.ui, list = world.missiles?.length ? inbound(world, p.side) : [];
      const st = this.status = (p.alive && Array.isArray(p.cfg?.weapons?.sam)) ? samStatus(p) : null;
      const out = this.threats; out.length = 0;
      let nMine = 0, minTti = Infinity, fresh = null;
      for (const t of list) {
         const me = t.targetId === p.id;
         if (me) { nMine++; if (t.tti < minTti) minTti = t.tti; }
         if (!this.known.has(t.id)) { this.known.add(t.id); if (!fresh || me) fresh = t; }
         if (out.length >= MAX_THREATS) continue;
         let eng = t.seduced ? 'sed' : '';
         if (!eng && st) {
            if (st.ciws?.targets.includes(t.id)) eng = 'ciws';
            else if (st.layers.some(l => l.targets.includes(t.id))) eng = 'sam';
         }
         if (!eng && t.eng > 0) eng = 'sam';
         t.me = me; t.engBy = eng; t.brg = Math.atan2(t.y - p.pos.y, t.x - p.pos.x); t.dist = Math.hypot(t.x - p.pos.x, t.y - p.pos.y);
         t.prio = st?.priority === t.id;
         out.push(t);
      }
      u.nMine = nMine; u.minTti = minTti;
      if (this.known.size > 400) this.known.clear();
      if (fresh && p.alive) {
         this.audio.vampire(false);
         if (world.time - this.msgT > 4) {
            this.msgT = world.time;
            this.hud.msg('VAMPIRE – ' + fresh.name + ' im Anflug · Peilung ' + compass(Math.atan2(fresh.y - p.pos.y, fresh.x - p.pos.x)), 'warn');
         }
      }
   }

   // ---------------------------------------------------------------- HUD snapshot + DOM plates
   // c: { ctl, aim, lockId, camYaw, W, H }; project(x, h, y) -> { x, y, visible }
   fill(ui, p, world, project, c) {
      const u = this.ui, d = this.dom, ctl = c.ctl;
      ui.mx = u;
      u.on = !!p; u.mode = ctl.mode; u.camYaw = c.camYaw;
      if (!p) return;
      const h = MissileUi.has(p), w = p.cfg?.weapons || {};
      u.radarOn = !!p.radarOn; u.emcon = h.radar && !p.radarOn;
      u.status = this.status;
      hints.frame(this.hud, p, world, ctl.mode);   // Waffenkunde: one notice per weapon on first use

      // --- weapon bar
      const list = ui.weapons || (ui.weapons = []);
      list.length = 0;
      const r = ui.reload || {};
      if (h.gun && !p.air) {
         list.push({ id: 'gun', key: '1', icon: 'GUN', name: 'Geschütz', count: '', sel: ctl.mode === 'guns', ready: !!r.anyReady, none: false, frac: r.frac ?? 1,
            stat: r.anyReady ? 'bereit' : r.left > 0 ? 'lädt ' + r.left.toFixed(1).replace('.', ',') + ' s' : r.trav > 0 ? 'schwenkt' : r.total ? 'kein Schusswinkel' : '—',
            tip: slotTip('gun', p.cfg) });
      }
      u.aimInfo = ''; u.aimBad = false;
      if (h.ssm) {
         const type = ssmType(p), cfg = MISSILES[type], n = p.mag?.[type] || 0;
         const tgt = this._ssmTarget(world, p, c);
         let b = ssmBlock(world, p, tgt ? { targetId: tgt.id } : { bearing: c.aim.yaw }), bearingShot = !tgt;
         if (tgt && b === 'notrack') { b = ssmBlock(world, p, { bearing: 0 }); bearingShot = true; }
         const gap = clamp01((world.time - (p.lastSsmFire ?? -99)) / 1.1);
         const sel = ctl.mode === 'ssm';
         list.push({ id: 'ssm', key: '2', icon: 'SSM', name: cfg?.name || 'Seeziel-FK', count: String(n), sel, ready: !b, none: n <= 0, frac: n > 0 ? gap : 0,
            stat: b ? BLOCK_TEXT[b].toLowerCase() : bearingShot ? 'Peilungsschuss' : 'Ziel erfasst',
            tip: slotTip('ssm', p.cfg) });
         if (sel) {
            const dist = tgt ? Math.hypot(tgt.pos.x - p.pos.x, tgt.pos.y - p.pos.y) : 0;
            u.aimBad = !!b;
            u.aimInfo = b ? (cfg.name + ': ' + BLOCK_TEXT[b]) : tgt && !bearingShot ? cfg.name + ' → ' + (tgt.name || tgt.cls) + ' · ' + km(dist)
               : tgt ? 'Peilungsschuss → ' + (tgt.name || tgt.cls) + ' (keine Feuerleitlösung)' : 'Peilungsschuss ' + compass(c.aim.yaw) + ' · kein Ziel erfasst';
         }
      }
      const map = u.map;
      map.mode = null; map.cur = null; map.block = null; map.siteId = null; map.range = 0;
      map.lastTgt = this.lastTgt && world.time - this.lastTgt.t < MARK_SECS ? this.lastTgt : null;
      if (h.cruise) {
         const type = w.cruise.type, cfg = MISSILES[type], n = p.mag?.[type] || 0, sel = ctl.mode === 'cruise';
         const b0 = n <= 0 ? 'empty' : world.time - (p.lastSsmFire ?? -99) < 1.1 ? 'reload' : p.depth > 1 ? 'reload' : null;
         list.push({ id: 'cruise', key: '3', icon: 'CRUISE', name: cfg?.name || 'Marsch-FK', count: String(n), sel, ready: !b0, none: n <= 0,
            frac: n > 0 ? clamp01((world.time - (p.lastSsmFire ?? -99)) / 1.1) : 0, stat: b0 ? BLOCK_TEXT[b0].toLowerCase() : sel ? 'Ziel: Karte' : 'bereit',
            tip: slotTip('cruise', p.cfg) });
         if (sel) { map.mode = 'cruise'; map.range = cfg.range; u.aimInfo = u.aimInfo || (ctl.mapOpen ? '' : cfg.name + ': Ziel auf der Lagekarte wählen' + (isTouch() ? '' : ' (3)')); }
      }
      const rk = rocketState(p);
      if (rk) {
         const left = Math.max(0, rk.readyT - world.time), sel = ctl.mode === 'rockets';
         list.push({ id: 'rockets', key: '4', icon: 'ROCKET', name: 'Raketen', count: String(rk.salvo), sel, ready: left <= 0, none: false, frac: 1 - clamp01(left / (rk.reload || 1)),
            stat: left > 0 ? 'lädt ' + Math.ceil(left) + ' s' : 'bereit', tip: slotTip('rockets', p.cfg) });
         if (sel) {
            map.mode = 'rockets'; map.range = rk.range;
            const dd = Math.hypot(c.aim.point.x - p.pos.x, c.aim.point.y - p.pos.y);
            u.aimBad = left > 0;
            u.aimInfo = left > 0 ? 'Raketen: Lädt nach' : 'Raketensalve · ' + km(Math.min(dd, rk.range)) + (dd > rk.range ? ' (Höchstreichweite)' : '');
         }
      }
      const ti = ui.torpInfo;
      if (ti) {
         const ready = ti.readyCount > 0;
         list.push({ id: 'torp', key: '5', icon: 'TORP', name: 'Torpedo', count: ready ? ti.readyCount + '/' + ti.total : '0/' + ti.total, sel: ctl.mode === 'torp', ready, none: false,
            frac: ready ? 1 : 1 - clamp01(ti.reload / (ti.reloadMax || 1)), stat: (ready ? 'bereit' : ti.reload.toFixed(0) + ' s') + ' · ' + (ti.spread === 'wide' ? 'weit' : 'eng'),
            tip: slotTip('torp', p.cfg) });
      }
      if (map.mode && ctl.mapOpen) {
         const pt = this._mapPoint(world, p, c.W, c.H);
         if (pt) {
            map.cur = pt; map.siteId = pt.siteId;
            map.block = map.mode === 'cruise' ? cruiseBlock(world, p, pt.siteId != null ? { siteId: pt.siteId } : { x: pt.x, y: pt.y }) : (rk && world.time < rk.readyT ? 'reload' : null);
         }
         map.cx = this.cur.x; map.cy = this.cur.y;
      }

      // --- contacts that are not ship markers: ESM bearings, land positions
      const gh = u.ghosts, si = u.sites;
      gh.length = 0; si.length = 0;
      for (const s of world.ships) {
         if (!s.alive || s.side === p.side || s.detected || s.spotted || !s.esmSeen) continue;
         const q = project(s.esmSeen.x, 30, s.esmSeen.y);
         gh.push({ x: q.x, y: q.y, on: !!q.visible, wx: s.esmSeen.x, wy: s.esmSeen.y, brg: s.esmSeen.brg, site: false });
      }
      for (const s of world.sites || []) {
         const own = s.side === p.side, lv = own ? 3 : contactLevel(world, p.side, s);
         if (!lv) continue;
         if (lv === 1) {
            const q = project(s.esmSeen.x, 40, s.esmSeen.y);
            gh.push({ x: q.x, y: q.y, on: !!q.visible, wx: s.esmSeen.x, wy: s.esmSeen.y, brg: s.esmSeen.brg, site: true });
            continue;
         }
         const q = project(s.pos.x, (s.h || 0) + 70, s.pos.y);
         si.push({ id: s.id, x: q.x, y: q.y, on: !!q.visible, name: s.name || SITE_SHORT[s.kind] || s.kind, kind: s.kind, ally: own, alive: !!s.alive, level: lv,
            hp: clamp01(s.hp / (s.maxHp || s.maxHP || 1)), dist: Math.hypot(s.pos.x - p.pos.x, s.pos.y - p.pos.y) });
      }

      // --- plates
      if (!d) return;
      const showSys = p.alive && (h.radar || h.sam || h.ciws);
      setCls(d.sys, 'hidden', !showSys);
      if (showSys) {
         setCls(d.radar, 'hidden', !h.radar);
         setCls(d.radar, 'on', u.radarOn); setCls(d.radar, 'emcon', u.emcon); setCls(d.radar, 'jam', !!p.jamming);
         setText(d.radarB, u.radarOn ? 'AN' : 'AUS · EMCON');
         const st = this.status, def = h.sam || h.ciws;
         setCls(d.doc, 'hidden', !def); setCls(d.layers, 'hidden', !def || !st); setCls(d.prio, 'hidden', !def);
         if (def) {
            const doc = p.samDoctrine || 'free';
            for (const k of DOCTRINES) setCls(d.doc, k, k === doc);
            setText(d.docB, DOCTRINE_NAMES[doc] || doc);
            setCls(d.prio, 'on', p.samPriority != null);
            setText(d.prioB, p.samPriority != null ? 'gesetzt' : '—');
         }
         if (def && st) {
            const sig = st.layers.map(l => l.type + l.ch).join(',') + '|' + (st.ciws ? st.ciws.type + st.ciws.n : '');
            if (sig !== d.laySig) {
               d.laySig = sig;
               d.layers.innerHTML = st.layers.map(l => `<span class="ly" title="${esc(l.name)}: Flugkörper im Magazin, ${l.ch} Feuerleitkanäle">${esc(l.name)} <b>0</b><span class="ch">${'<i></i>'.repeat(l.ch)}</span></span>`).join('')
                  + (st.ciws ? `<span class="ly cw" title="Nahbereichsabwehr">${esc(st.ciws.name)} <b>×${st.ciws.n}</b><span class="ch"><i></i></span></span>` : '');
               d.lay = [...d.layers.querySelectorAll('.ly')].map(e => ({ e, b: e.querySelector('b'), ch: [...e.querySelectorAll('.ch i')] }));
            }
            st.layers.forEach((l, i) => {
               const L = d.lay[i];
               if (!L) return;
               setText(L.b, String(l.mag));
               setCls(L.e, 'empty', l.mag <= 0); setCls(L.e, 'busy', l.busy > 0);
               for (let k = 0; k < L.ch.length; k++) setCls(L.ch[k], 'on', k < l.busy);
            });
            if (st.ciws) {
               const L = d.lay[st.layers.length];
               if (L) { const on = st.ciws.targets.length > 0; setCls(L.e, 'busy', on); setCls(L.e, 'fire', on); setCls(L.ch[0], 'on', on); }
            }
         }
      }
      // vampire plate
      const th = this.threats, show = p.alive && th.length > 0;
      setCls(d.thr, 'hidden', !show);
      if (show) {
         setCls(d.thr, 'hot', u.nMine > 0 && u.minTti < 8);
         // desktop: sit right under the mission orders instead of on top of the third and fourth line
         const now = performance.now();
         if (now - (this.objT || 0) > 500 && !document.body.classList.contains('touch')) {
            this.objT = now;
            const ob = document.getElementById('objectives'), bt = ob ? Math.ceil(ob.getBoundingClientRect().bottom) + 8 : 96;
            if (bt !== this.objBt) { this.objBt = bt; d.thr.style.top = Math.max(96, bt) + 'px'; }
         }
         setText(d.vn, th.length + (u.nMine ? ' · ' + u.nMine + ' auf dich' : ''));
         const n = Math.min(MAX_ROWS, th.length);
         if (d.rowN !== n) {
            d.rowN = n;
            d.vl.innerHTML = '<div class="vr"><span></span><span></span><span></span><span class="st"></span></div>'.repeat(n);
            d.rows = [...d.vl.children].map(e => ({ e, s: [...e.children] }));
         }
         for (let i = 0; i < n; i++) {
            const t = th[i], R = d.rows[i];
            setCls(R.e, 'me', t.me);
            setText(R.s[0], (t.prio ? '▶ ' : '') + t.name);
            setText(R.s[1], compass(t.brg));
            setText(R.s[2], t.tti < 99 ? Math.ceil(t.tti) + ' s' : '—');
            setText(R.s[3], t.engBy === 'sed' ? 'abgelenkt' : t.engBy === 'ciws' ? 'CIWS feuert' : t.engBy === 'sam' ? 'bekämpft' : 'offen');
            setCls(R.s[3], 'eng', t.engBy === 'sam' || t.engBy === 'ciws'); setCls(R.s[3], 'sed', t.engBy === 'sed');
         }
         setText(d.vm, th.length > n ? '+ ' + (th.length - n) + ' weitere' : '');
      }
   }
}

// ================================================================ canvas: 3D-view overlay
// Small quality badge beside an enemy ship marker: filled diamond = fire-control solution,
// hollow = detected only (hud3d.js _markers).
export function drawQuality(g, x, y, level) {
   if (!level || level < 2) return;
   const s = 4;
   g.save();
   g.shadowBlur = 0;
   g.beginPath(); g.moveTo(x, y - s); g.lineTo(x + s, y); g.lineTo(x, y + s); g.lineTo(x - s, y); g.closePath();
   g.lineWidth = 1.3; g.strokeStyle = T.gold;
   if (level >= 3) { g.fillStyle = T.gold; g.fill(); }
   g.stroke();
   g.restore();
}

// Threat chevrons around the screen centre, ESM ghosts, land-position labels, launch read-out.
export function drawMissileHud(g, ui, W, H, t) {
   const u = ui.mx;
   if (!u || !u.on) return;
   const cx = W / 2, cy = H / 2;
   g.save();
   g.textAlign = 'center';
   // --- land positions: name + health bar
   for (const s of u.sites) {
      if (!s.on || !s.alive) continue;
      const col = s.ally ? T.ally : T.enemy;
      g.shadowColor = 'rgba(0,0,0,0.85)'; g.shadowBlur = 3;
      g.fillStyle = col; g.strokeStyle = col; g.lineWidth = 1.4;
      // position glyph: a small square with a roof (hud3d.js class icons are ships)
      g.beginPath(); g.rect(s.x - 5, s.y - 4, 10, 8); g.moveTo(s.x - 7, s.y - 4); g.lineTo(s.x, s.y - 10); g.lineTo(s.x + 7, s.y - 4);
      if (s.level >= 3) g.fill(); g.stroke();
      if (s.dist < 16000 || s.level >= 3) {
         g.font = FONT(11.5, '600'); g.textBaseline = 'bottom'; g.fillStyle = s.ally ? rgba(T.ally, 0.95) : '#ffd9d0';
         g.fillText(s.name, s.x, s.y - 13);
      }
      g.shadowBlur = 0;
      g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(s.x - 21, s.y + 7, 42, 5);
      g.fillStyle = col; g.fillRect(s.x - 20, s.y + 8, 40 * s.hp, 3);
   }
   // --- ESM bearings: a dashed diamond with a question mark where the emitter is believed to be
   for (const q of u.ghosts) {
      if (!q.on) continue;
      g.shadowColor = 'rgba(0,0,0,0.85)'; g.shadowBlur = 3;
      g.strokeStyle = rgba(T.enemy, 0.9); g.lineWidth = 1.3; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(q.x, q.y - 9); g.lineTo(q.x + 9, q.y); g.lineTo(q.x, q.y + 9); g.lineTo(q.x - 9, q.y); g.closePath(); g.stroke();
      g.setLineDash([]);
      g.fillStyle = rgba(T.enemy, 0.95); g.font = MONO(10, '700'); g.textBaseline = 'middle';
      g.fillText('?', q.x, q.y + 0.5);
      g.font = FONT(10.5); g.textBaseline = 'top'; g.fillStyle = '#ffd9d0';
      g.fillText('ESM', q.x, q.y + 12);
   }
   g.shadowBlur = 0;
   // --- inbound missiles: chevrons on a ring around the crosshair, pointing at the centre
   const th = u.threats;
   if (th.length) {
      const R = Math.min(W, H) * 0.34;
      for (let i = th.length - 1; i >= 0; i--) {
         const m = th[i];
         const a = wrap(m.brg - (u.camYaw || 0));
         const sx = Math.sin(a), sy = -Math.cos(a);
         const x = cx + sx * R, y = cy + sy * R;
         const hot = m.me && m.tti < 8, blink = hot && ((t * 4) | 0) % 2 === 0;
         const col = m.engBy === 'sed' ? 'rgba(200,200,200,0.75)' : m.me ? (blink ? '#ffffff' : T.bad) : T.warn;
         const s = m.me ? 11 : 8;
         g.save();
         g.translate(x, y); g.rotate(a);
         g.shadowColor = 'rgba(0,0,0,0.9)'; g.shadowBlur = 4;
         g.fillStyle = col; g.strokeStyle = col;
         // chevron: tip towards the centre (down in this frame)
         g.beginPath(); g.moveTo(0, s); g.lineTo(s * 0.9, -s * 0.7); g.lineTo(0, -s * 0.15); g.lineTo(-s * 0.9, -s * 0.7); g.closePath(); g.fill();
         if (m.engBy === 'sam' || m.engBy === 'ciws') {
            g.lineWidth = 1.5; g.strokeStyle = T.ok;
            g.beginPath(); g.arc(0, 0, s + 5, 0, TAU); g.stroke();
         }
         if (m.prio) { g.lineWidth = 1.5; g.strokeStyle = T.gold; g.strokeRect(-s - 7, -s - 7, 2 * s + 14, 2 * s + 14); }
         g.restore();
         if (m.me || i < 3) {
            g.shadowColor = 'rgba(0,0,0,0.9)'; g.shadowBlur = 3;
            g.font = MONO(m.me ? 13 : 11, '700'); g.textBaseline = 'middle'; g.fillStyle = m.me ? '#fff' : T.warn;
            g.fillText(m.tti < 99 ? Math.ceil(m.tti) + ' s' : '', cx + sx * (R + 26), cy + sy * (R + 22));
            g.shadowBlur = 0;
         }
      }
   }
   // --- what the fire key will do with the selected guided weapon
   if (u.aimInfo && !ui.mapOpen && !(isTouch() && H <= 480)) {   // phone: the reticle label and the launch report carry it
      g.font = FONT(13, '600'); g.textBaseline = 'top';
      const tw = g.measureText(u.aimInfo).width + 16, y = cy + 104;
      g.fillStyle = 'rgba(10,12,13,0.62)'; g.fillRect(cx - tw / 2, y - 3, tw, 21);
      g.fillStyle = u.aimBad ? T.bad : T.gold; g.fillRect(cx - tw / 2, y - 3, 3, 21);
      g.fillStyle = u.aimBad ? '#ffd9d0' : '#fff';
      g.fillText(u.aimInfo, cx + 1.5, y + 1);
   }
   g.restore();
}

// ================================================================ canvas: charts (minimap + tactical map)
// Called by minimap3d.js after the ships. mx/my: world -> canvas, sc: px per metre.
export function drawMissileMap(g, world, p, mx, my, sc, big, opts) {
   if (!p) return;
   const side = p.side, time = world.time || 0, u = opts?.mx || null;
   g.save();
   // --- land positions
   for (const s of world.sites || []) {
      const own = s.side === side, lv = own ? 3 : contactLevel(world, side, s);
      if (!lv) continue;
      const col = own ? T.ally : T.enemy;
      if (lv === 1) { ghost(g, mx(s.esmSeen.x), my(s.esmSeen.y), big); continue; }
      const x = mx(s.pos.x), y = my(s.pos.y), h = big ? 6 : 3.5;
      g.lineWidth = big ? 1.5 : 1; g.strokeStyle = s.alive ? col : rgba(col, 0.4); g.fillStyle = s.alive ? col : 'rgba(0,0,0,0)';
      g.beginPath(); g.rect(x - h, y - h, h * 2, h * 2);
      if (lv >= 3 && s.alive) g.fill();
      g.stroke();
      if (!s.alive) { g.beginPath(); g.moveTo(x - h, y - h); g.lineTo(x + h, y + h); g.moveTo(x + h, y - h); g.lineTo(x - h, y + h); g.stroke(); }
      if (big) {
         g.font = FONT(11.5); g.textAlign = 'center'; g.textBaseline = 'top'; g.fillStyle = s.alive ? col : rgba(col, 0.5);
         g.fillText(s.name || SITE_SHORT[s.kind] || '', x, y + h + 3);
         if (s.alive) {
            g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(x - 15, y - h - 7, 30, 4);
            g.fillStyle = col; g.fillRect(x - 14, y - h - 6, 28 * clamp01(s.hp / (s.maxHp || s.maxHP || 1)), 2);
         }
         if (u?.map.siteId === s.id) { g.strokeStyle = T.gold; g.lineWidth = 1.5; g.strokeRect(x - h - 5, y - h - 5, h * 2 + 10, h * 2 + 10); }
      }
   }
   // --- ESM bearings to ships that are not held otherwise
   for (const s of world.ships || []) {
      if (!s.alive || s.side === side || s.detected || s.spotted || !s.esmSeen) continue;
      const x = mx(s.esmSeen.x), y = my(s.esmSeen.y);
      g.strokeStyle = rgba(T.enemy, 0.35); g.lineWidth = 1; g.setLineDash([4, 4]);
      g.beginPath(); g.moveTo(mx(p.pos.x), my(p.pos.y)); g.lineTo(x, y); g.stroke();
      g.setLineDash([]);
      ghost(g, x, y, big);
   }
   // --- decoy clouds
   for (const d of world.decoys || []) {
      const x = mx(d.x), y = my(d.y), r = big ? 5 : 3;
      g.strokeStyle = d.side === side ? rgba(T.ally, 0.9) : rgba(T.enemy, 0.9); g.lineWidth = 1;
      g.setLineDash([2, 2]); g.beginPath(); g.arc(x, y, r, 0, TAU); g.stroke(); g.setLineDash([]);
   }
   // --- missiles: own always, hostile only while tracked
   const L = big ? 9 : 5;
   for (const m of world.missiles || []) {
      if (!m.alive) continue;
      const own = m.side === side;
      if (!own && !m.detected) continue;
      const small = m.kind === 'sam' || m.kind === 'aam' || m.kind === 'rocket';
      if (small && !big) continue;
      const x = mx(m.x), y = my(m.y), c = Math.cos(m.heading), s = Math.sin(m.heading), l = small ? L * 0.55 : L;
      const col = own ? (m.kind === 'cruise' ? T.gold : T.ally) : (((time * 4) | 0) % 2 ? '#fff' : T.enemy);
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = small ? 1 : 1.6;
      g.beginPath(); g.moveTo(x - c * l, y - s * l); g.lineTo(x, y); g.stroke();
      if (!small) { g.beginPath(); g.moveTo(x + c * 2.5, y + s * 2.5); g.lineTo(x - c * 1.5 - s * 2.5, y - s * 1.5 + c * 2.5); g.lineTo(x - c * 1.5 + s * 2.5, y - s * 1.5 - c * 2.5); g.closePath(); g.fill(); }
   }
   // --- map targeting (tactical map only): range ring, last target, cursor
   if (big && u && u.map.mode && p.alive) {
      const M = u.map, px = mx(p.pos.x), py = my(p.pos.y);
      g.strokeStyle = rgba(T.gold, 0.75); g.lineWidth = 1.2; g.setLineDash([8, 5]);
      g.beginPath(); g.arc(px, py, M.range * sc, 0, TAU); g.stroke(); g.setLineDash([]);
      if (M.lastTgt) {
         const x = mx(M.lastTgt.x), y = my(M.lastTgt.y);
         g.strokeStyle = rgba(T.gold, 0.8); g.lineWidth = 1.4;
         g.beginPath(); g.moveTo(x - 6, y - 6); g.lineTo(x + 6, y + 6); g.moveTo(x + 6, y - 6); g.lineTo(x - 6, y + 6); g.stroke();
      }
      if (M.cur) {
         const wx = M.cur.sx ?? M.cur.x, wy = M.cur.sy ?? M.cur.y, x = mx(wx), y = my(wy), bad = !!M.block;
         const col = bad ? T.bad : T.gold;
         g.strokeStyle = rgba(col, 0.55); g.lineWidth = 1; g.setLineDash([3, 4]);
         g.beginPath(); g.moveTo(px, py); g.lineTo(x, y); g.stroke(); g.setLineDash([]);
         g.strokeStyle = col; g.lineWidth = 1.6;
         g.beginPath(); g.arc(x, y, 9, 0, TAU); g.moveTo(x - 15, y); g.lineTo(x - 4, y); g.moveTo(x + 4, y); g.lineTo(x + 15, y); g.moveTo(x, y - 15); g.lineTo(x, y - 4); g.moveTo(x, y + 4); g.lineTo(x, y + 15); g.stroke();
         const txt = (M.cur.name ? M.cur.name + ' · ' : '') + km(Math.hypot(wx - p.pos.x, wy - p.pos.y)) + (bad ? ' · ' + BLOCK_TEXT[M.block] : '');
         g.font = FONT(12, '600'); g.textAlign = 'left'; g.textBaseline = 'middle';
         const tw = g.measureText(txt).width, lx = x + 28 + tw > mx(arenaOf(world)) ? x - 28 - tw : x + 18;   // flip at the right map edge
         g.fillStyle = 'rgba(10,12,13,0.78)'; g.fillRect(lx, y - 10, tw + 10, 20);
         g.fillStyle = bad ? '#ffd9d0' : '#fff'; g.fillText(txt, lx + 5, y + 1);
      }
   }
   g.restore();
}
function ghost(g, x, y, big) {
   const r = big ? 7 : 4;
   g.strokeStyle = rgba(T.enemy, 0.9); g.lineWidth = 1.2; g.setLineDash([2, 2]);
   g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath(); g.stroke();
   g.setLineDash([]);
   if (big) { g.fillStyle = rgba(T.enemy, 0.95); g.font = MONO(9, '700'); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('?', x, y + 0.5); }
}

// Legend line under the tactical map while a map-aimed weapon is selected (hud3d.js).
export function mapTargetHint(ui) {
   const m = ui.mx?.map;
   if (!m || !m.mode) return '';
   const verb = isTouch() ? 'antippen' : 'anklicken';
   // the cruise line says what the weapon is good for; short enough for a phone chart
   return m.mode === 'cruise' ? 'MARSCHFLUGKÖRPER – Landstellung oder Punkt im Ring ' + verb + (isTouch() ? '' : '  ·  fahrende Schiffe trifft er nicht') : 'RAKETEN – Zielpunkt ' + verb;
}
