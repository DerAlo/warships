// gamev2/opsui.js — client side of the special operations: the ship-borne helicopter (sim: helo.js),
// the swimmer team of a submarine (seal.js) and the scripted large detonation (blast.js).
// HUD plates, keys, radio-style messages, world markers and the map layer. Same shape as
// subui.js / missileui.js: main3d.js calls reset / input / event / fill, hud3d.js draws the
// `ui.ops` snapshot with drawOpsHud(), minimap3d.js the map layer with drawOpsMap().
// Nothing here writes sim state; orders go through act() (net/command.js):
//   ['h', 0] helicopter screens ahead   ['h', x, y] to a point   ['h'] recall   ['S'] team out
// Works from replicated data alone: a replicated helicopter has no `goal` (the last order of the
// own helicopter is remembered from its heloOrder event), every other field is read with a fallback.
import { heloStatus, heloBlock, HELO } from './helo.js';
import { slotTip } from './guide.js';
import { teamStatus, SEAL } from './seal.js';
import { execAction } from './net/command.js';
import { T, FONT, MONO, rgba } from './theme.js';

export const HELO_KEY = 'I', TEAM_KEY = 'K';
const TAU = Math.PI * 2;
const MAX_MARK = 10, MAX_PING = 4, PING_T = 3;
const touch = () => typeof document !== 'undefined' && document.body.classList.contains('touch');

const CSS = `
#ops-panel { position: absolute; right: 16px; bottom: 304px; display: flex; flex-direction: column; gap: 6px; align-items: flex-end; pointer-events: none; }
#ops-panel.over-sub { bottom: 410px; }
#ops-panel .ops-plate { padding: 6px 10px; font: 12px var(--mono); color: var(--hud); min-width: 150px; pointer-events: auto; cursor: pointer; }
#ops-panel .ops-plate b { color: var(--hud-dim); font: 600 9.5px var(--font); letter-spacing: 2px; text-transform: uppercase; display: block; }
#ops-panel .ops-plate b .kb { font-style: normal; }
#ops-panel .ops-stat.ready { color: var(--ok); }
#ops-panel .ops-stat.warn { color: var(--warn); }
#ops-panel .ops-sub { display: block; color: var(--hud-dim); font-size: 11px; margin-top: 1px; }
#ops-panel .ops-bar { display: block; height: 3px; margin-top: 4px; background: rgba(255,255,255,0.14); border-radius: 2px; overflow: hidden; }
#ops-panel .ops-bar i { display: block; height: 100%; width: 0; background: var(--ok); }
#ops-panel .ops-bar.low i { background: var(--warn); }
#ops-panel .ops-plate.armed { outline: 1px solid var(--gold); }
#blast-white { position: absolute; inset: 0; background: #fff; opacity: 0; pointer-events: none; display: none; }
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
const km = (m) => (m / 1000).toFixed(m < 9950 ? 1 : 0) + ' km';

const HELO_STATE = { ready: 'startklar', deck: 'wird klargemacht', transit: 'im Anflug', dip: 'Tauchsonar', return: 'kehrt zurück' };
const TEAM_LOST = { spotted: 'Trupp entdeckt – Einsatz gescheitert', stranded: 'Trupp nicht aufgenommen – verloren', boat: 'Boot verloren – Trupp ohne Rückweg', blast: 'Trupp in der Detonation verloren' };

export class OpsUi {
   constructor({ hud, audio, mui }) {
      this.hud = hud; this.audio = audio; this.mui = mui;
      this.mapMode = false;                    // tactical map: the next click sends the helicopter
      this.goal = { on: false, x: 0, y: 0 };   // last order of the own helicopter (replicas have no h.goal)
      this.pings = Array.from({ length: MAX_PING }, () => ({ x: 0, y: 0, t: -99 }));
      this.pingI = 0; this.launchT = -99; this.dipMsgT = -99;
      // snapshot for the canvas layers (reused every frame)
      this.ui = {
         on: false, t: 0, helo: false, team: false, mapMode: false, cur: { on: false, x: 0, y: 0 },
         goal: this.goal, pings: this.pings, pickup: 0, heloId: null,
         marks: Array.from({ length: MAX_MARK }, () => ({ on: false, x: 0, y: 0, kind: '', label: '', sub: '', state: '', k: 0 })),
         white: 0,
      };
      this._pr = { x: 0, y: 0, visible: false };
      this._build();
   }

   _build() {
      if (typeof document === 'undefined') return;
      if (!document.getElementById('ops-css')) { const st = el('style', 'ops-css'); st.textContent = CSS; document.head.appendChild(st); }
      const panel = el('div', 'ops-panel');
      const mk = (cls, title, key) => {
         const p = el('div', null, 'panel ops-plate hidden ' + cls, `<b>${title}<i class="kb"> · ${key}</i></b><span class="ops-stat">–</span><span class="ops-sub"></span><span class="ops-bar"><i></i></span>`);
         p.dataset.key = key;
         panel.appendChild(p);
         return { root: p, stat: p.querySelector('.ops-stat'), sub: p.querySelector('.ops-sub'), bar: p.querySelector('.ops-bar'), fill: p.querySelector('.ops-bar i') };
      };
      const helo = mk('ops-helo', 'HUBSCHRAUBER', HELO_KEY), team = mk('ops-team', 'KOMMANDOTRUPP', TEAM_KEY);
      helo.root.title = slotTip('helo');
      const white = el('div', 'blast-white');
      const host = document.getElementById('hud');
      if (host) { host.appendChild(panel); host.parentNode.insertBefore(white, host); }
      this.dom = { panel, helo, team, white };
      // mouse users may click the plates too (touch3d.js wires them as buttons by data-key)
      this.clicked = null;
      for (const p of [helo, team]) p.root.addEventListener('click', () => { if (!touch()) this.clicked = p.root.dataset.key; });
   }

   reset(world) {
      this.mapMode = false; this.goal.on = false; this.launchT = -99; this.dipMsgT = -99; this.clicked = null;
      for (const p of this.pings) p.t = -99;
      const d = this.dom;
      if (d) { setCls(d.helo.root, 'hidden', true); setCls(d.team.root, 'hidden', true); this._white(0); }
   }

   static hasHelo(p) { return !!(p && p.cfg && p.cfg.helo); }
   static hasTeam(p) { return !!(p && p.sub && p.cfg && p.cfg.sub && p.cfg.sub.seal); }

   // I: helicopter (map closed: launch to the screen / recall; map open: arm "send to a point"),
   // K: swimmer team out. c: { ctl, W, H } (main3d's missile context).
   // Returns true while it owns the map click, so no cruise missile leaves on the same tap.
   input(inp, p, world, act, c) {
      const key = this.clicked; this.clicked = null;
      const iT = inp.tapped(HELO_KEY) || key === HELO_KEY, kT = inp.tapped(TEAM_KEY) || key === TEAM_KEY;
      if (!p || !p.alive) { this.mapMode = false; return false; }
      const run = act || ((a) => execAction(p, world, a));
      const A = this.audio, hud = this.hud, mapOpen = !!c?.ctl?.mapOpen;
      if (!mapOpen) this.mapMode = false;
      if (iT) {
         if (!OpsUi.hasHelo(p)) { A.denied?.(); hud.msg('Kein Hubschrauber an Bord', 'warn'); }
         else if (mapOpen) {
            const st = heloStatus(world, p), why = st.helo ? null : heloBlock(world, p);
            if (why) { A.denied?.(); hud.msg(why, 'warn'); this.mapMode = false; }
            else { this.mapMode = !this.mapMode; A.uiClick?.(); if (this.mapMode && c.ctl.mode !== 'guns') c.ctl.mode = 'guns'; }
         } else this._heloKey(p, world, run);
      }
      if (kT) this._teamKey(p, world, run);
      if (this.mapMode && this.mui) {
         // the map click belongs to the helicopter while the mode is armed
         const m = this.mui;
         if (m.click) {
            m.click = false;
            const pt = m._mapPoint(world, p, c.W, c.H);
            if (pt) {
               if (run(['h', pt.x, pt.y])) { this.goal.on = true; this.goal.x = pt.x; this.goal.y = pt.y; A.uiClick?.(); hud.msg('Hubschrauber: neuer Punkt', 'info'); this.mapMode = false; }
               else { A.denied?.(); hud.msg(heloBlock(world, p) || 'Hubschrauber: kein Treibstoff für einen weiteren Auftrag', 'warn'); }
            }
         }
         return true;
      }
      return false;
   }

   _heloKey(p, world, run) {
      const A = this.audio, hud = this.hud, st = heloStatus(world, p);
      if (st.state === 'transit' || st.state === 'dip') {
         if (run(['h'])) A.uiClick?.(); else A.denied?.();
      } else if (st.state === 'return') {
         if (run(['h', 0])) A.uiClick?.();
         else { A.denied?.(); hud.msg('Hubschrauber: kein Treibstoff für einen weiteren Auftrag', 'warn'); }
      } else {
         const why = heloBlock(world, p);
         if (why) { A.denied?.(); hud.msg(st.readyIn > 0 ? 'Hubschrauber wird klargemacht (' + Math.ceil(st.readyIn) + ' s)' : why, 'warn'); }
         else if (st.sorties <= 0) { A.denied?.(); hud.msg('Kein Einsatz mehr möglich', 'warn'); }
         else if (run(['h', 0])) A.uiClick?.();
         else { A.denied?.(); hud.msg('Hubschrauber nicht startklar', 'warn'); }
      }
   }

   _teamKey(p, world, run) {
      const A = this.audio, hud = this.hud;
      if (!OpsUi.hasTeam(p)) { A.denied?.(); hud.msg('Kein Kommandotrupp an Bord', 'warn'); return; }
      const st = teamStatus(world, p);
      if (!st.can) { A.denied?.(); hud.msg(st.why || 'Trupp kann nicht von Bord', 'warn'); return; }
      if (run(['S'])) A.uiClick?.(); else A.denied?.();
   }

   // sim events of the helicopter, the team and the detonation (main3d's switch default)
   event(e, p, world) {
      const hud = this.hud, A = this.audio;
      const mine = !!p && e.srcId === p.id;
      switch (e.type) {
         case 'heloLaunch':
            if (!mine) break;
            this.launchT = world.time; this.goal.on = false;
            hud.msg('Hubschrauber gestartet', 'info'); A.radio?.();
            break;
         case 'heloOrder':
            if (!mine) break;
            if (e.pos && e.mode !== 'return') { this.goal.on = true; this.goal.x = e.pos.x; this.goal.y = e.pos.y; } else this.goal.on = false;
            if (e.mode === 'return') hud.msg(e.bingo ? 'Hubschrauber: Treibstoff knapp – kehrt zurück' : 'Hubschrauber kehrt zurück', e.bingo ? 'warn' : 'info');
            else if (world.time - this.launchT > 1 && e.mode === 'screen' && !e.auto) hud.msg('Hubschrauber sichert voraus', 'info');
            break;
         case 'heloDip': {
            if (!e.pos) break;
            const h = this._helo(world, e.heloId);
            if (!mine && !(h && p && h.side === p.side)) break;
            const g = this.pings[this.pingI = (this.pingI + 1) % MAX_PING];
            g.x = e.pos.x; g.y = e.pos.y; g.t = world.time;
            if (mine && world.time - this.dipMsgT > 40) { this.dipMsgT = world.time; hud.msg('Hubschrauber: Tauchsonar im Wasser', 'info'); }
            if (mine) A.sonarPing?.(3000);
            break;
         }
         case 'heloLanded':
            if (mine) { this.goal.on = false; hud.msg('Hubschrauber an Deck', 'good'); }
            break;
         case 'heloLost':
            if (!mine) break;
            this.goal.on = false;
            hud.msg(e.reason === 'fuel' ? 'Hubschrauber verloren: Treibstoff aufgebraucht' : e.reason === 'blast' ? 'Hubschrauber in der Detonation verloren' : 'Hubschrauber abgeschossen!', 'warn', 4);
            A.radio?.();
            break;
         case 'aswTorp':
            if (mine && e.heloId != null) { hud.msg('Hubschrauber: U-Jagd-Torpedo im Wasser!', 'good', 3.5); A.radio?.(); }
            break;
         case 'teamOut': if (mine && !e.quiet) { hud.msg('Trupp ist von Bord – Kurs auf den Einsatzpunkt', 'radio', 4.5); A.radio?.(); } break;
         case 'teamWork': if (mine) { hud.msg('Trupp am Ziel – Arbeit läuft' + (e.workTime ? ' (' + Math.round(e.workTime) + ' s)' : ''), 'radio', 4.5); A.radio?.(); } break;
         case 'teamDone': if (mine) { hud.msg('Auftrag ausgeführt – Trupp kehrt zurück, Aufnahme vorbereiten', 'good', 5); A.radio?.(); } break;
         case 'teamRecovered': if (mine) { hud.msg('Trupp wieder an Bord', 'good', 4); A.radio?.(); } break;
         case 'teamLost': if (mine) { hud.msg(TEAM_LOST[e.reason] || 'Trupp verloren', 'warn', 5); A.radio?.(); } break;
         case 'blast': if (e.text) hud.msg(e.text, 'warn', 6); break;
      }
   }
   _helo(world, id) {
      const hs = world.helos;
      if (hs) for (let i = 0; i < hs.length; i++) if (hs[i].id === id) return hs[i];
      return null;
   }

   // whiteout of the large detonation (renderer.blast.white, 0..1)
   _white(v) {
      const w = this.dom?.white;
      if (!w) return;
      const q = v > 0.004 ? Math.round(v * 100) / 100 : 0;
      if (w._v === q) return;
      w._v = q;
      w.style.display = q > 0 ? 'block' : 'none';
      w.style.opacity = q;
   }

   // Fills the reused ui.ops snapshot and the plates. project(x, h, y, out): world -> screen.
   // c: { ctl, W, H }; white: screen whiteout 0..1.
   fill(ui, p, world, project, c, white = 0) {
      const u = this.ui, d = this.dom;
      ui.ops = u;
      u.on = !!p; u.t = world?.time || 0; u.mapMode = this.mapMode; u.white = white;
      this._white(white);
      let nm = 0;
      const marks = u.marks;
      const mark = (x, h, y, kind, label, sub, state, k) => {
         if (nm >= MAX_MARK || !project) return;
         const pr = project(x, h, y, this._pr);
         if (!pr || !pr.visible) return;
         const m = marks[nm++];
         m.on = true; m.x = pr.x; m.y = pr.y; m.kind = kind; m.label = label; m.sub = sub; m.state = state; m.k = k;
      };
      const hasH = OpsUi.hasHelo(p), hasT = OpsUi.hasTeam(p);
      u.helo = hasH; u.team = hasT; u.pickup = 0; u.heloId = null;
      const alive = !!p && p.alive;

      // ---- helicopter plate
      if (d) setCls(d.helo.root, 'hidden', !hasH || !alive);
      if (hasH && alive) {
         // the tooltip in the words of the device (the touch overlay comes on after this plate is built)
         const tch = touch();
         if (d && d.tipTouch !== tch) { d.tipTouch = tch; d.helo.root.title = slotTip('helo', p.cfg); }
         const st = heloStatus(world, p), h = st.helo;
         u.heloId = h ? h.id : null;
         const air = !!h;
         let txt = HELO_STATE[st.state] || st.state, sub;
         if (st.state === 'deck') txt = 'klar in ' + Math.ceil(st.readyIn) + ' s';
         if (st.state === 'ready' && st.sorties <= 0) txt = 'kein Einsatz mehr';
         if (air) {
            const dist = Math.hypot((h.rx ?? h.pos.x) - p.pos.x, (h.ry ?? h.pos.y) - p.pos.y);
            sub = km(dist) + ' · Torpedos ' + (st.torps | 0);
            mark(h.rx ?? h.pos.x, (h.ralt ?? h.alt ?? 0) + 14, h.ry ?? h.pos.y, 'helo', 'HELI', km(dist), st.state, st.fuel);
         } else if (st.state === 'ready' && st.sorties > 0) {
            // on deck and ready: one line on what it is for and how to send it
            sub = c?.ctl?.mapOpen ? (touch() ? 'antippen' : HELO_KEY) + ', dann Punkt auf der Karte' : 'U-Jagd · ' + (touch() ? 'antippen' : HELO_KEY) + ': Start voraus';
         } else sub = 'Einsätze ' + (st.sorties | 0) + ' · Torpedos ' + (st.torps | 0);
         if (d) {
            const H = d.helo;
            setText(H.stat, txt); setCls(H.stat, 'ready', st.state === 'ready' && st.sorties > 0); setCls(H.stat, 'warn', st.state === 'return' && st.fuel < 0.2);
            setText(H.sub, this.mapMode ? (touch() ? 'Karte antippen: Punkt' : 'Karte anklicken: Punkt') : sub);
            setCls(H.bar, 'hidden', !air); setCls(H.bar, 'low', st.fuel < 0.25);
            const w = Math.round(Math.max(0, Math.min(1, st.fuel)) * 100) + '%';
            if (H.fill._w !== w) { H.fill._w = w; H.fill.style.width = w; }
            setCls(H.root, 'armed', this.mapMode);
         }
      } else this.mapMode = false;

      // ---- team plate (submarines with a team, while there is something to do)
      let showT = false;
      if (hasT && alive) {
         const st = teamStatus(world, p), tm = st.team;
         showT = !!tm || st.left > 0 || !!st.task;
         if (showT && d) {
            const P = d.team;
            let txt, sub = '', k = -1, ready = false, warn = false;
            if (tm) {
               const dist = Math.hypot(tm.pos.x - p.pos.x, tm.pos.y - p.pos.y);
               if (tm.state === 'working') { txt = 'arbeitet am Ziel'; k = 1 - Math.max(0, tm.workT || 0) / Math.max(1, tm.workTime || SEAL.workTime); sub = 'noch ' + Math.ceil(Math.max(0, tm.workT || 0)) + ' s'; }
               else if (tm.state === 'returning') {
                  txt = 'kehrt zurück'; warn = Math.abs(p.speed || 0) > SEAL.pickupSpeed || p.depth > 1;
                  sub = p.depth > 1 ? 'Aufnahme: auf Sehrohrtiefe gehen' : Math.abs(p.speed || 0) > SEAL.pickupSpeed ? 'Aufnahme: Fahrt herausnehmen' : 'Aufnahme in ' + Math.round(dist) + ' m';
               } else { txt = 'unterwegs zum Ziel'; sub = km(dist) + ' vom Boot'; }
               u.pickup = tm.state === 'returning' || tm.state === 'out' ? SEAL.pickup : 0;
            } else if (st.can) { txt = 'bereit'; ready = true; sub = (st.task?.label || 'Einsatzpunkt') + ' · ' + km(st.dist); }
            else { txt = st.why || 'nicht bereit'; warn = st.left > 0; sub = st.task && isFinite(st.dist) ? (st.task.label || 'Einsatzpunkt') + ' · ' + km(st.dist) + (st.dist > SEAL.range ? ' (max. ' + km(SEAL.range) + ')' : '') : ''; }
            setText(P.stat, txt); setCls(P.stat, 'ready', ready); setCls(P.stat, 'warn', warn && !ready);
            setText(P.sub, sub);
            setCls(P.bar, 'hidden', k < 0);
            if (k >= 0) { const w = Math.round(k * 100) + '%'; if (P.fill._w !== w) { P.fill._w = w; P.fill.style.width = w; } }
         }
      }
      if (d) {
         setCls(d.team.root, 'hidden', !showT);
         setCls(d.panel, 'over-sub', !!p?.sub);
      }

      // ---- world markers: task points and teams of the own side
      if (p && world) {
         const tps = world.taskPoints;
         if (tps) for (let i = 0; i < tps.length; i++) {
            const t = tps[i];
            if (!t || (t.side && t.side !== p.side)) continue;
            const x = t.pos ? t.pos.x : t.x, y = t.pos ? t.pos.y : t.y;
            if (x == null) continue;
            mark(x, 30, y, 'task', t.label || 'Einsatzpunkt', t.state === 'done' ? 'erledigt' : km(Math.hypot(x - p.pos.x, y - p.pos.y)), t.state || 'open', 0);
         }
         const ts = world.teams;
         if (ts) for (let i = 0; i < ts.length; i++) {
            const t = ts[i];
            if (!t || !t.pos || (t.side && t.side !== p.side) || (t.state !== 'out' && t.state !== 'returning')) continue;
            mark(t.rx ?? t.pos.x, 6, t.ry ?? t.pos.y, 'team', 'TRUPP', Math.round(Math.hypot(t.pos.x - p.pos.x, t.pos.y - p.pos.y)) + ' m', t.state, 0);
         }
      }
      for (let i = nm; i < MAX_MARK; i++) marks[i].on = false;

      // ---- map cursor while the helicopter waits for its point
      u.cur.on = false;
      if (this.mui) this.mui.ui.map.helo = this.mapMode;   // the helicopter cursor replaces the plain one
      if (this.mapMode && this.mui && c) {
         const pt = this.mui._mapPoint(world, p, c.W, c.H);
         if (pt && (this.mui.cur.moved || !touch())) { u.cur.on = true; u.cur.x = pt.x; u.cur.y = pt.y; }
      }
      return u;
   }
}

// Text under the tactical map while the helicopter mode is armed (hud3d.js).
export function opsMapHint(ui) {
   return ui.ops && ui.ops.mapMode ? 'HUBSCHRAUBER: Punkt auf der Karte ' + (touch() ? 'antippen' : 'anklicken') + (touch() ? '' : '  ·  ' + HELO_KEY + ' bricht ab') : '';
}

// World markers on the HUD canvas (hud3d.js): own helicopter, task points, team boats.
export function drawOpsHud(g, ui, W, H, t) {
   const u = ui.ops;
   if (!u || !u.on || ui.mapOpen) return;
   const marks = u.marks;
   g.save();
   g.textAlign = 'center'; g.lineJoin = 'round';
   for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      if (!m.on) continue;
      const x = Math.round(m.x), y = Math.round(m.y);
      let col = T.ally;
      if (m.kind === 'task') col = m.state === 'done' ? T.ok : T.gold;
      g.strokeStyle = 'rgba(0,0,0,0.65)'; g.lineWidth = 3.5;
      g.beginPath();
      if (m.kind === 'helo') { g.moveTo(x - 7, y - 4); g.lineTo(x + 7, y - 4); g.moveTo(x, y - 4); g.lineTo(x, y + 1); g.moveTo(x - 4, y + 3); g.lineTo(x, y + 6); g.lineTo(x + 4, y + 3); }
      else if (m.kind === 'task') { g.moveTo(x, y - 8); g.lineTo(x + 7, y); g.lineTo(x, y + 8); g.lineTo(x - 7, y); g.closePath(); }
      else { g.arc(x, y, 4, 0, TAU); }
      g.stroke();
      g.strokeStyle = col; g.lineWidth = 1.6; g.stroke();
      if (m.kind === 'task' && m.state === 'busy') { g.fillStyle = rgba(T.gold, 0.5 + 0.4 * Math.sin(t * 6)); g.fill(); }
      g.font = FONT(10.5, '700'); g.textBaseline = 'bottom';
      g.strokeText(m.label, x, y - 10); g.fillStyle = col; g.fillText(m.label, x, y - 10);
      if (m.sub) { g.font = MONO(10, '600'); g.textBaseline = 'top'; g.strokeText(m.sub, x, y + 10); g.fillStyle = 'rgba(235,240,245,0.92)'; g.fillText(m.sub, x, y + 10); }
   }
   g.restore();
}

const DASH = [4, 3], DASH_BIG = [7, 5], NO_DASH = [];
// Map layer (minimap3d.js): helicopters, dipping-sonar rings, ASW torpedoes, task points, teams,
// pickup ring, danger zone of an armed charge. opts.ops: the ui.ops snapshot (may be missing).
export function drawOpsMap(g, world, p, mx, my, sc, big, opts) {
   const u = opts && opts.ops, now = world.time || 0, side = p ? p.side : 'player';
   // ---- danger zone of an armed, announced charge / footprint of one that went off
   const bs = world.blasts;
   if (bs) for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      if (!b) continue;
      const x = mx(b.pos ? b.pos.x : b.x), y = my(b.pos ? b.pos.y : b.y), R = b.r || {};
      if (b.state === 'armed') {
         if (!b.label) continue;
         const r = Math.max(6, (+R.shock || 3000) * sc);
         g.fillStyle = rgba(T.enemy, 0.07); g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
         g.strokeStyle = rgba(T.enemy, 0.85); g.lineWidth = big ? 1.6 : 1.2; g.setLineDash(big ? DASH_BIG : DASH); g.stroke(); g.setLineDash(NO_DASH);
         if (R.heavy) { g.strokeStyle = rgba(T.enemy, 0.45); g.lineWidth = 1; g.beginPath(); g.arc(x, y, Math.max(3, R.heavy * sc), 0, TAU); g.stroke(); }
         g.fillStyle = rgba(T.enemy, 0.95); g.font = FONT(big ? 12 : 9, '700'); g.textAlign = 'center'; g.textBaseline = 'middle';
         g.fillText(big ? 'GEFAHRENZONE · ' + b.label : '!', x, big ? y - r - 9 : y);
      } else if (b.state === 'done') {
         const a = Math.max(0, 1 - (+b.age || 0) / 110);
         if (a <= 0) continue;
         g.fillStyle = rgba(T.enemy, 0.22 * a); g.beginPath(); g.arc(x, y, Math.max(4, (+R.heavy || 1500) * sc), 0, TAU); g.fill();
         const front = (+b.age || 0) * 343;
         if (front < (+R.shock || 3000) * 3) { g.strokeStyle = rgba('#ffffff', 0.7 * a); g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, Math.max(2, front * sc), 0, TAU); g.stroke(); }
      }
   }
   // ---- task points
   const tps = world.taskPoints;
   if (tps) for (let i = 0; i < tps.length; i++) {
      const t = tps[i];
      if (!t || (t.side && t.side !== side)) continue;
      const x = mx(t.pos ? t.pos.x : t.x), y = my(t.pos ? t.pos.y : t.y), s = big ? 7 : 4.5;
      const done = t.state === 'done', col = done ? T.ok : T.gold;
      g.beginPath(); g.moveTo(x, y - s); g.lineTo(x + s, y); g.lineTo(x, y + s); g.lineTo(x - s, y); g.closePath();
      g.fillStyle = rgba(col, t.state === 'busy' ? 0.55 + 0.35 * Math.sin(now * 6) : done ? 0.5 : 0.25); g.fill();
      g.strokeStyle = col; g.lineWidth = 1.4; g.stroke();
      if (big) {
         g.fillStyle = col; g.font = FONT(11, '700'); g.textAlign = 'center'; g.textBaseline = 'bottom';
         g.fillText((t.label || 'Einsatzpunkt') + (done ? ' ✓' : ''), x, y - s - 2);
         // how close the boat has to come for the team to go
         if (!done && t.state !== 'busy' && u && u.team) { g.strokeStyle = rgba(T.gold, 0.35); g.lineWidth = 1; g.setLineDash(DASH); g.beginPath(); g.arc(x, y, SEAL.range * sc, 0, TAU); g.stroke(); g.setLineDash(NO_DASH); }
      }
   }
   // ---- teams + pickup ring around the boat
   const ts = world.teams;
   if (ts) for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      if (!t || !t.pos || (t.side && t.side !== side) || t.state === 'recovered' || t.state === 'lost') continue;
      const x = mx(t.pos.x), y = my(t.pos.y);
      g.fillStyle = T.ally; g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 1;
      g.beginPath(); g.arc(x, y, big ? 3.5 : 2.2, 0, TAU); g.fill(); g.stroke();
      const o = world.shipById?.(t.ownerId);
      if (big && o && o.pos && t.state === 'returning') { g.strokeStyle = rgba(T.ally, 0.5); g.setLineDash(DASH); g.beginPath(); g.moveTo(x, y); g.lineTo(mx(o.pos.x), my(o.pos.y)); g.stroke(); g.setLineDash(NO_DASH); }
   }
   if (u && u.pickup > 0 && p && p.alive && big) {
      const x = mx(p.pos.x), y = my(p.pos.y), r = Math.max(9, u.pickup * sc);
      g.strokeStyle = rgba(T.ok, 0.6 + 0.3 * Math.sin(now * 4)); g.lineWidth = 1.5; g.setLineDash(DASH);
      g.beginPath(); g.arc(x, y, r, 0, TAU); g.stroke(); g.setLineDash(NO_DASH);
      g.fillStyle = T.ok; g.font = FONT(10, '600'); g.textAlign = 'center'; g.textBaseline = 'top';
      g.fillText('Aufnahme ' + u.pickup + ' m', x, y + r + 3);
   }
   // ---- dipping sonar: a ring running out to the range of the sonar
   if (u) for (let i = 0; i < u.pings.length; i++) {
      const q = u.pings[i], k = (now - q.t) / PING_T;
      if (k < 0 || k > 1) continue;
      g.strokeStyle = rgba(T.ally, 0.8 * (1 - k)); g.lineWidth = big ? 1.6 : 1.2;
      g.beginPath(); g.arc(mx(q.x), my(q.y), Math.max(3, HELO.dipRange * sc * (0.08 + 0.92 * k)), 0, TAU); g.stroke();
   }
   // ---- lightweight ASW torpedoes: a small ring on the usual torpedo stroke
   const tr = world.torpedoes;
   if (tr) for (let i = 0; i < tr.length; i++) {
      const t = tr[i];
      if (!t || !t.asw || !t.pos) continue;
      const own = (t.side ?? t.owner) === side;
      if (!own && t.spotted === false) continue;
      g.strokeStyle = own ? T.ok : T.enemy; g.lineWidth = 1.2;
      g.beginPath(); g.arc(mx(t.pos.x), my(t.pos.y), big ? 4 : 2.6, 0, TAU); g.stroke();
   }
   // ---- helicopters
   const hs = world.helos;
   if (hs) for (let i = 0; i < hs.length; i++) {
      const h = hs[i];
      if (!h || !h.pos || h.alive === false) continue;
      const ally = h.side === side;
      if (!ally && h.visible === false) continue;
      const x = mx(h.rx ?? h.pos.x), y = my(h.ry ?? h.pos.y), s = big ? 6 : 4, own = u && h.id === u.heloId;
      const col = own ? T.self || '#ffffff' : ally ? T.ally : T.enemy;
      if (own && u.goal.on && h.state !== 'return') {
         const gx = mx(u.goal.x), gy = my(u.goal.y);
         g.strokeStyle = rgba(T.ally, 0.55); g.lineWidth = 1; g.setLineDash(DASH);
         g.beginPath(); g.moveTo(x, y); g.lineTo(gx, gy); g.stroke(); g.setLineDash(NO_DASH);
         g.beginPath(); g.arc(gx, gy, 3, 0, TAU); g.stroke();
      }
      // rotor disc with the two blades
      g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(x - s, y - s); g.lineTo(x + s, y + s); g.moveTo(x + s, y - s); g.lineTo(x - s, y + s); g.stroke();
      g.strokeStyle = col; g.lineWidth = 1.5; g.stroke();
      g.fillStyle = col; g.beginPath(); g.arc(x, y, s * 0.42, 0, TAU); g.fill();
      if (h.state === 'dip') { g.lineWidth = 1; g.beginPath(); g.arc(x, y, s * 1.5, 0, TAU); g.stroke(); }
      if (big && ally) { g.font = FONT(10, '600'); g.textAlign = 'center'; g.textBaseline = 'top'; g.fillText('Heli', x, y + s + 2); }
   }
   // ---- cursor of the helicopter map mode
   if (u && u.cur.on && big) {
      const x = mx(u.cur.x), y = my(u.cur.y);
      g.strokeStyle = T.gold; g.lineWidth = 1.5;
      g.beginPath(); g.arc(x, y, 9, 0, TAU); g.moveTo(x - 15, y); g.lineTo(x - 4, y); g.moveTo(x + 4, y); g.lineTo(x + 15, y); g.moveTo(x, y - 15); g.lineTo(x, y - 4); g.moveTo(x, y + 4); g.lineTo(x, y + 15); g.stroke();
      if (p) { g.fillStyle = T.gold; g.font = MONO(11, '600'); g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(km(Math.hypot(u.cur.x - p.pos.x, u.cur.y - p.pos.y)), x + 18, y); }
   }
}
