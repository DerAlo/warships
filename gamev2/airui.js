// game3d/airui.js — client side of the carriers and their squadrons (sim: air.js): the air-group
// panel, plane-type selection, launch and take-over (E), the squadron view (camera behind the
// flight, steering, boost, attack run with torpedo fan / bombing ellipse, recall), the AA focus
// key for every ship, squadron markers on screen and on the map, messages and audio hooks.
// main3d.js owns one AirUi and calls reset / input / event / frame / fill; hud3d.js draws the
// `ui.air` snapshot with drawAir(), minimap3d.js the squadrons with drawAirMap(). Nothing here
// allocates per frame (marker and polyline points are pooled).
//
// Every order goes through the command actions of net/command.js (launch 'L', take 'P', hand
// back 'H', recall 'R', patrol 'W', drop 'B', AA focus 'F'), run directly in singleplayer and on
// a net host, sent to the host by a net client (main3d's act()). The stick of the flight in hand
// (wanted heading, throttle, attack run) is written to the squadron directly, or on a net client
// handed to main3d as `netCtl` for the command stream (CONTRACT.md); a client sees its planes
// from the host's snapshots.
import { AIR, AIR_TYPES, AIR_NAMES, planeCount, activeSquad, canLaunch, squadById, nextAaFocus } from './air.js';
import { execAction } from './net/command.js';
import { angleDelta, clamp, clamp01 } from './utils.js';
import { T, rgba } from './theme.js';

const TAU = Math.PI * 2;
const MAX_MARKS = 24, FAN_PTS = 9, ELL_PTS = 28;
const STEER_MOUSE = 0.0026;       // rad of wanted heading per mouse px
const STEER_KEYS = 1.1;           // rad/s of wanted heading while A / D are held
const STEER_MAX = 1.1;            // wanted heading at most this far off the current heading
const LAUNCH_WAIT = 4;            // s a net client waits for the flight it launched to show up
const DIST_MIN = 140, DIST_MAX = 900, DIST0 = 330;
const LOOK_AHEAD = { tb: 700, db: 620, ft: 1100 };
const TYPE_KEYS = { 1: 'tb', 2: 'db', 3: 'ft' };
const CSS = `
#air-panel { position: absolute; right: 16px; bottom: 262px; width: 214px; padding: 8px 10px; font: 12px var(--mono, Consolas, monospace); color: var(--hud, #e6f0fa); }
#air-panel .ap-title { font: 700 11px var(--font, 'Segoe UI', sans-serif); letter-spacing: .08em; color: var(--hud-dim, #9db4c8); margin-bottom: 5px; display: flex; justify-content: space-between; }
#air-panel .ap-row { display: flex; align-items: baseline; gap: 6px; padding: 2px 4px; border-radius: 3px; color: var(--hud-dim, #9db4c8); }
#air-panel .ap-row b { width: 12px; color: var(--hud-dim, #9db4c8); }
#air-panel .ap-row .ap-n { flex: 1; }
#air-panel .ap-row .ap-c { color: var(--hud, #e6f0fa); font-weight: 700; min-width: 18px; text-align: right; }
#air-panel .ap-row .ap-x { color: var(--hud-dim, #9db4c8); font-size: 10px; min-width: 64px; text-align: right; }
#air-panel .ap-row.on { color: var(--hud, #e6f0fa); background: var(--panel-edge, rgba(170,200,230,.22)); }
#air-panel .ap-row.on b { color: var(--gold, #ffd479); }
#air-panel .ap-row.up .ap-n::after { content: ' ▲'; color: var(--ally, #5dff8c); font-size: 9px; }
#air-panel .ap-deck { margin-top: 4px; color: var(--hud-dim, #9db4c8); }
#air-panel .ap-deck.ready { color: var(--ally, #5dff8c); }
#air-panel .ap-sq { margin-top: 2px; }
#air-panel .ap-bar { height: 6px; margin: 3px 0 1px; background: rgba(255,255,255,.12); border-radius: 3px; overflow: hidden; }
#air-panel .ap-bar i { display: block; height: 100%; width: 100%; background: var(--ally, #5dff8c); }
#air-panel .ap-bar.boost i { background: var(--gold, #ffd479); }
#air-panel .ap-lbl { display: flex; justify-content: space-between; color: var(--hud-dim, #9db4c8); font-size: 11px; }
#air-panel .ap-aa, #aa-panel span { color: var(--hud, #e6f0fa); }
#air-panel .ap-aa { margin-top: 4px; }
#air-panel .ap-keys { margin-top: 5px; color: var(--hud-dim, #9db4c8); font-size: 11px; line-height: 1.35; }
#air-panel .ap-keys b, #aa-panel b { color: var(--hud, #e6f0fa); }
#aa-panel { position: absolute; right: 16px; bottom: 312px; padding: 5px 10px; font: 12px var(--mono, Consolas, monospace); color: var(--hud-dim, #9db4c8); }
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
const setW = (e, f) => { const v = Math.round(clamp01(f) * 100); if (e && e._w !== v) { e._w = v; e.style.width = v + '%'; } };
const AA_TEXT = { '-1': 'Backbord', 0: 'gleichmäßig', 1: 'Steuerbord' };
const pt = () => ({ x: 0, y: 0, visible: false });
// touch overlay on (touch3d.js sets body.touch): hints name the on-screen buttons, not the keys
const touch = () => typeof document !== 'undefined' && !!document.body?.classList.contains('touch');

export class AirUi {
   // onView(on): main3d's hook when the squadron view opens / closes (camera override, shell cam)
   constructor({ hud, audio, onView }) {
      this.hud = hud; this.audio = audio; this.onView = onView || (() => {});
      this.dom = null;
      this.flying = false;        // squadron view active
      this.sqId = null;           // the squadron in the player's hands
      this.want = 0;              // wanted heading (absolute)
      this.dist = DIST0;          // camera distance behind the flight
      this.camH = 0;              // smoothed camera heading
      this.wasDown = false;       // LMB state last frame (release = drop)
      this.lingerT = 0;           // s the camera stays on a flight that just turned home
      this.aiming = false;        // attack run held (LMB)
      this.aimHold = 0;           // s it has been held
      this.pending = null;        // net client: { type, t } a launch on its way to the host
      this.netCtl = null;         // net client: [sqId, want, throttle, aiming] for the command stream
      this.cam3 = null;
      this.pose = { px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0, fov: 55 };
      this.focus = { x: 0, y: 0 };          // renderer shadow focus while flying
      this.msgT = { lost: -9, down: -9 };
      this.seen = new Set();                // enemy squadrons already announced
      this.flakSndT = 0;
      this.ui = {
         carrier: false, flying: false, type: 'tb', aiming: false, ready: false, aimFrac: 0, minFrac: 0, armed: 0, n: 0,
         path: pt(), wantPt: pt(), nFan: 0, fan: [0, 1, 2].map(() => Array.from({ length: FAN_PTS }, pt)), arm: [pt(), pt()],
         nEll: 0, ell: Array.from({ length: ELL_PTS }, pt), center: pt(),
         nMarks: 0, marks: Array.from({ length: MAX_MARKS }, () => ({ ...pt(), ally: false, own: false, ctl: false, type: 'tb', n: 0, home: false })),
      };
   }

   _build() {
      if (this.dom || typeof document === 'undefined') return;
      const st = el('style'); st.textContent = CSS; document.head.appendChild(st);
      const rows = AIR_TYPES.map((t, i) => `<div class="ap-row" data-t="${t}"><b>${i + 1}</b><span class="ap-n">${AIR_NAMES[t]}</span>`
         + '<span class="ap-c">0</span><span class="ap-x"></span></div>').join('');
      const panel = el('div', 'air-panel', 'panel hidden',
         '<div class="ap-title"><span>LUFTGRUPPE</span><span class="ap-st"></span></div>'
         + '<div class="ap-hangar">' + rows + '<div class="ap-deck"></div></div>'
         + '<div class="ap-sq hidden"><div class="ap-sqn"></div>'
         + '<div class="ap-bar fuel"><i></i></div><div class="ap-lbl"><span>Treibstoff</span><span class="ap-fuel"></span></div>'
         + '<div class="ap-bar boost"><i></i></div><div class="ap-lbl"><span>Leistung (W)</span><span class="ap-boost"></span></div></div>'
         + '<div class="ap-aa">Flak: <span class="ap-aav"></span><i class="kb"> · <b>4</b></i></div>'
         + '<div class="ap-keys"></div>');
      const aa = el('div', 'aa-panel', 'panel hidden', 'FLAK <i class="kb"><b>4</b> · </i><span></span>');
      const host = document.getElementById('hud') || document.getElementById('bottom-right');
      if (host) { host.appendChild(panel); host.appendChild(aa); }
      this.dom = {
         panel, aa, aaV: aa.querySelector('span'),
         rows: [...panel.querySelectorAll('.ap-row')], hangar: panel.querySelector('.ap-hangar'), deck: panel.querySelector('.ap-deck'),
         st: panel.querySelector('.ap-st'), sq: panel.querySelector('.ap-sq'), sqn: panel.querySelector('.ap-sqn'),
         fuel: panel.querySelector('.fuel i'), fuelT: panel.querySelector('.ap-fuel'),
         boost: panel.querySelector('.boost i'), boostT: panel.querySelector('.ap-boost'),
         aaP: panel.querySelector('.ap-aav'), keys: panel.querySelector('.ap-keys'),
      };
      this.dom.cnt = this.dom.rows.map(r => r.querySelector('.ap-c'));
      this.dom.ext = this.dom.rows.map(r => r.querySelector('.ap-x'));
   }

   reset(world, cam3) {
      this._build();
      this.cam3 = cam3 || this.cam3;
      this._close(false);
      this.dist = DIST0; this.lingerT = 0; this.wasDown = false;
      this.aiming = false; this.aimHold = 0; this.pending = null; this.netCtl = null;
      this.msgT.lost = -9; this.msgT.down = -9;
      this.seen.clear();
      const p = world?.player, d = this.dom;
      if (d) {
         setCls(d.panel, 'hidden', !p?.air);
         setCls(d.aa, 'hidden', true);
      }
   }
   stop() { this._close(false); }

   squad(world) { return this.flying && world ? squadById(world, this.sqId) : null; }

   // ---- view switching
   _take(world, sq, run) {
      run(['P', sq.id]);
      this.sqId = sq.id; this.aiming = false; this.aimHold = 0; this.pending = null;
      this.want = sq.heading; this.camH = sq.heading; this.lingerT = 0;
      this.wasDown = true;                     // a held button must be released first
      if (!this.flying) { this.flying = true; this.onView(true); }
      if (this.cam3) this.cam3.override = this.pose;
      this._pose(world, sq, 1);
      const k = touch()
         ? (sq.type === 'ft' ? 'Patrouille: Knopf antippen' : 'Angriff halten: Anflug, loslassen: Abwurf') + ' · Rückruf / Schiff: Knöpfe rechts'
         : (sq.type === 'ft' ? 'LMB: Patrouille' : 'LMB halten: Anflug, loslassen: Abwurf') + ' · F: Rückruf · E: Schiff';
      this.hud.msg(AIR_NAMES[sq.type] + ' übernommen – ' + k, 'info');
   }
   _close(msg = true) {
      if (!this.flying) return;
      this.flying = false; this.sqId = null; this.lingerT = 0;
      if (this.cam3 && this.cam3.override === this.pose) this.cam3.override = null;
      this.onView(false);
      if (msg) this.audio.uiClick?.();
   }
   // hand the flight back to its pilots: bombers pick a target themselves, fighters patrol here
   // (air.releaseSquadron)
   _release(world, sq, run) {
      if (sq) run(['H', sq.id]);
      this._close();
   }

   // Per frame (main3d frameInput). Returns true while the squadron view owns the controls (the
   // ship's helm, guns and camera keys are skipped). act: main3d's act() (orders); client: a net
   // client (the host flies the planes; the stick goes out as `netCtl`, see the header).
   input(inp, p, world, dt, opts) {
      const { mapOpen = false, sens = 1, client = false, act = null } = opts || {};
      const run = act || ((a) => execAction(p, world, a));
      this.netCtl = null;
      if (!p) return false;
      if (p.air && inp.tapped('4')) {   // AA sector: carriers only, 4 is the rocket launcher elsewhere
         if (!p.alive || !p.aa?.range || !run(['F', nextAaFocus(p.aaFocus)])) this.audio.denied?.();
         else this.audio.uiClick?.();
      }
      if (this.flying) {
         const sq = this.squad(world);
         if (!sq || sq.n <= 0 || !p.alive) {
            if (sq?.n > 0) this._release(world, sq, run); else this._close();
            if (p.alive) this.hud.msg(sq ? 'Zurück auf der Brücke' : 'Staffel verloren – zurück auf der Brücke', 'warn');
            return false;
         }
         if (inp.tapped('E')) { this._release(world, sq, run); return true; }
         if (sq.state === 'return' || sq.state === 'land') {
            // the flight turned home (weapons gone, fuel, recall): watch it for a moment
            if ((this.lingerT += dt) > 3) this._close();
            this._wheel(inp, mapOpen);
            return true;
         }
         if (inp.tapped('F')) { run(['R', sq.id]); this._close(); return true; }
         this._wheel(inp, mapOpen);
         // steering: wanted heading from A / D and the mouse, never far off the current heading
         let w = this.want;
         if (inp.down('A')) w -= STEER_KEYS * dt;
         if (inp.down('D')) w += STEER_KEYS * dt;
         if (!mapOpen) w += clamp(inp.mouse.dx, -2000, 2000) * STEER_MOUSE * sens;
         const off = clamp(angleDelta(sq.heading, w), -STEER_MAX, STEER_MAX);
         this.want = sq.heading + off;
         sq.want = this.want;
         const th = inp.down('W') ? 1 : inp.down('S') ? -1 : 0;
         if (!client) sq.throttle = th;
         // weapons: hold for the attack run, release to drop (fighters: click = patrol ahead)
         const down = !mapOpen && inp.mouse.down, click = !mapOpen && inp.mouse.clicked;
         if (sq.type === 'ft') {
            this.aiming = false;
            if (click) {
               const h = sq.heading;
               run(['W', sq.id, sq.pos.x + Math.cos(h) * 900, sq.pos.y + Math.sin(h) * 900]);
               this._close();
               return true;
            }
         } else if (sq.armed > 0 && sq.state !== 'launch') {
            if (down && !this.wasDown) { this.aiming = true; this.aimHold = 0; }
            else if (!down && (this.wasDown || click) && this.aiming) {
               // a net client knows the run's length from its own hold (the host's lags by the ping)
               const need = sq.type === 'tb' ? AIR.tbAimMin : AIR.dbAimMin;
               if ((client && this.aimHold < need) || !run(['B', sq.id])) { this.audio.denied?.(); this.hud.msg(touch() ? 'Anflug zu kurz – Angriff länger halten' : 'Anflug zu kurz – Taste länger halten', 'warn'); }
               this.aiming = false;
            }
            if (!down && !click) this.aiming = false;
            if (this.aiming) this.aimHold += dt;
         } else this.aiming = false;
         if (!client) sq.aiming = this.aiming;
         this.wasDown = down;
         if (client) this.netCtl = [sq.id, this.want, th, this.aiming ? 1 : 0];
         return true;
      }
      // ship view of a carrier: 1/2/3 pick the plane type, E launches it or takes over the flight
      if (!p.air || !p.alive) { this.pending = null; return false; }
      // a net client: the flight it launched shows up in a snapshot a moment later
      if (this.pending) {
         const q = activeSquad(world, p, this.pending.type);
         if (q && q.n > 0) { this._take(world, q, run); return true; }
         if ((this.pending.t -= dt) <= 0) this.pending = null;
      }
      for (const k in TYPE_KEYS) {
         if (inp.tapped(k)) {
            const t = TYPE_KEYS[k];
            if (p.air.sel !== t) { p.air.sel = t; this.audio.ammoSwitch?.(); }
         }
      }
      if (inp.tapped('E') && !this.pending) {
         const t = p.air.sel;
         const q = activeSquad(world, p, t);
         if (q) this._take(world, q, run);
         else if (canLaunch(world, p, t)) {
            const s = run(['L', t]);
            if (s && typeof s === 'object') this._take(world, s, run);
            else if (s) this.pending = { type: t, t: LAUNCH_WAIT };
         } else {
            this.audio.denied?.();
            const c = planeCount(world, p, t);
            this.hud.msg(p.air.deckT > 0 ? 'Flugdeck belegt – noch ' + Math.ceil(p.air.deckT) + ' s'
               : c.ready < 1 ? 'Keine ' + AIR_NAMES[t] + ' startbereit' : 'Start nicht möglich', 'warn');
         }
      }
      return false;
   }

   _wheel(inp, mapOpen) {
      const w = inp.mouse.wheel;
      if (!mapOpen && w) this.dist = clamp(this.dist * Math.pow(1.15, Math.sign(w)), DIST_MIN, DIST_MAX);
   }

   // Sim events main3d does not handle (its switch default).
   event(e, p, world) {
      const A = this.audio, hud = this.hud, mine = e.srcId === p.id;
      switch (e.type) {
         case 'airLaunch': if (mine) { hud.msg(e.text, 'info'); A.consumable?.('fighter'); } break;
         case 'airLand': if (mine) hud.msg(e.text, 'info'); break;
         case 'airInfo': if (mine && e.text) hud.msg(e.text, e.level || 'info'); break;
         case 'airDrop':
            if (mine) {
               hud.msg(e.text, 'info');
               if (e.kind === 'tb') A.splash?.(this.flying ? 300 : 3000, false, e.pos);
            }
            break;
         case 'aaFocus': if (mine) hud.msg(e.text, 'info'); break;
         case 'planeDown': {
            const t = world.time;
            if (e.dstId === p.id && t - this.msgT.lost > 2) { this.msgT.lost = t; hud.msg(e.n > 0 ? 'Eigene Maschine abgeschossen' : 'Staffel aufgerieben', 'warn'); }
            else if (mine && t - this.msgT.down > 1.5) { this.msgT.down = t; hud.msg('Feindflugzeug abgeschossen', 'good'); A.ribbon?.('sec'); }
            if (e.pos) A.explosion?.(false, this._dist(p, e.pos), e.pos);
            break;
         }
         default: break;
      }
   }
   _dist(p, pos) {
      const x = this.flying ? this.pose.px : p.pos.x, y = this.flying ? this.pose.pz : p.pos.y;
      return Math.hypot(pos.x - x, pos.y - y);
   }

   // After main3d's ship interpolation: render positions of all squadrons, the squadron camera.
   frame(world, alpha, dt) {
      const sqs = world?.squadrons;
      if (!sqs) return null;
      for (let i = 0; i < sqs.length; i++) {
         const q = sqs[i], r = q.prev;
         q.rx = r.x + (q.pos.x - r.x) * alpha; q.ry = r.y + (q.pos.y - r.y) * alpha;
         q.ralt = r.alt + (q.alt - r.alt) * alpha; q.rh = r.h + angleDelta(r.h, q.heading) * alpha;
      }
      if (!this.flying) return null;
      const sq = squadById(world, this.sqId);
      if (!sq) return null;
      if (this.cam3 && !this.cam3.override) this.cam3.override = this.pose;
      this._pose(world, sq, 1 - Math.exp(-dt / 0.3));
      this.focus.x = sq.rx; this.focus.y = sq.ry;
      return this.focus;
   }
   _pose(world, sq, k) {
      const x = sq.rx ?? sq.pos.x, y = sq.ry ?? sq.pos.y, alt = sq.ralt ?? sq.alt, h = sq.rh ?? sq.heading;
      this.camH += angleDelta(this.camH, h) * k;
      const c = Math.cos(this.camH), s = Math.sin(this.camH), D = this.dist, o = this.pose;
      o.px = x - c * D; o.pz = y - s * D; o.py = alt + 30 + D * 0.42;
      const ahead = LOOK_AHEAD[sq.type] || 800;
      o.tx = x + c * ahead; o.tz = y + s * ahead; o.ty = sq.type === 'ft' ? alt * 0.6 : 0;
   }

   // Fills the reused ui.air snapshot; project(x, h, y, out) is main3d's world -> screen.
   fill(ui, p, world, project, dt) {
      const u = this.ui, d = this.dom;
      ui.air = u;
      u.carrier = !!p.air; u.flying = this.flying;
      u.nFan = 0; u.nEll = 0; u.nMarks = 0; u.aiming = false;
      const sqs = world.squadrons || [];
      // squadron markers: everything the team can see (own flight under control excluded)
      for (let i = 0; i < sqs.length && u.nMarks < MAX_MARKS; i++) {
         const q = sqs[i];
         if (q.n <= 0 || q.state === 'land' || !q.visible) continue;
         if (this.flying && q.id === this.sqId) continue;
         const m = u.marks[u.nMarks];
         project(q.rx ?? q.pos.x, (q.ralt ?? q.alt) + 30, q.ry ?? q.pos.y, m);
         if (!m.visible) continue;
         m.ally = q.side === p.side; m.own = q.ownerId === p.id; m.type = q.type; m.n = q.n; m.home = q.state === 'return';
         u.nMarks++;
         if (!m.ally && !this.seen.has(q.id) && q.armed > 0) {
            this.seen.add(q.id);
            if (Math.hypot(q.pos.x - p.pos.x, q.pos.y - p.pos.y) < 9000) { this.hud.msg('Feindliche ' + AIR_NAMES[q.type] + ' im Anflug', 'warn'); this.audio.spottedAlarm?.(); }
         }
      }
      // flak sound around the squadron the camera follows (or around the own ship)
      this.flakSndT -= dt;
      const sq = this.squad(world);
      if (sq && sq.underFire > 0 && this.flakSndT <= 0) { this.flakSndT = clamp(1.6 - sq.underFire / 120, 0.18, 1.2); this.audio.secondary?.(260, sq.pos); }
      if (sq) this._aim(u, sq, project);
      // ---- DOM
      if (!d) return;
      const showAA = !p.air && p.alive && !!p.aa?.range && (world.hasAir || p.aaFocus !== 0);
      setCls(d.aa, 'hidden', !showAA);
      if (showAA) setText(d.aaV, AA_TEXT[p.aaFocus] || 'gleichmäßig');
      if (!p.air) return;
      setCls(d.panel, 'hidden', !p.alive && !this.flying);
      setText(d.aaP, AA_TEXT[p.aaFocus] || 'gleichmäßig');
      setCls(d.hangar, 'hidden', this.flying);
      setCls(d.sq, 'hidden', !this.flying);
      if (this.flying && sq) {
         setText(d.st, sq.state === 'return' ? 'RÜCKFLUG' : sq.aiming ? 'ANFLUG' : 'IM FLUG');
         setText(d.sqn, AIR_NAMES[sq.type] + ' ' + sq.n + '/' + sq.n0 + (sq.type === 'ft' ? '' : ' · bewaffnet ' + sq.armed));
         const fuel = sq.fuel / Math.max(1, p.cfg.air.fuel);
         setW(d.fuel, fuel); setText(d.fuelT, Math.max(0, Math.ceil(sq.fuel)) + ' s');
         if (d.fuel._low !== fuel < 0.25) { d.fuel._low = fuel < 0.25; d.fuel.style.background = fuel < 0.25 ? 'var(--enemy, #ff5a4d)' : ''; }
         setW(d.boost, sq.boost / AIR.boostMax); setText(d.boostT, sq.throttle > 0 ? 'Vollgas' : sq.throttle < 0 ? 'gedrosselt' : 'Reise');
         setText(d.keys, touch() ? 'Ruderleiste lenkt · Hebel: Tempo' : sq.type === 'ft' ? 'A/D Maus lenken · W/S Tempo · LMB Patrouille · F Rückruf · E Schiff'
            : 'A/D Maus lenken · W/S Tempo · LMB halten Anflug · F Rückruf · E Schiff');
         return;
      }
      setText(d.st, '');
      const a = p.air;
      for (let i = 0; i < AIR_TYPES.length; i++) {
         const t = AIR_TYPES[i], c = planeCount(world, p, t);
         setCls(d.rows[i], 'on', a.sel === t);
         setCls(d.rows[i], 'up', !!activeSquad(world, p, t));
         setText(d.cnt[i], String(c.ready));
         setText(d.ext[i], (c.service ? 'W ' + c.service : '') + (c.air ? (c.service ? ' · ' : '') + 'L ' + c.air : ''));
      }
      const ok = a.deckT <= 0;
      setCls(d.deck, 'ready', ok);
      setText(d.deck, ok ? 'Flugdeck frei' : 'Flugdeck belegt ' + Math.ceil(a.deckT) + ' s');
      setText(d.keys, touch() ? '' : activeSquad(world, p, a.sel) ? '1-3 Typ · E Staffel übernehmen' : '1-3 Typ · E Staffel starten');
   }

   // flight path marker, wanted heading, torpedo fan / bombing ellipse (from the render pose)
   _aim(u, sq, project) {
      const x = sq.rx ?? sq.pos.x, y = sq.ry ?? sq.pos.y, alt = sq.ralt ?? sq.alt, h = sq.rh ?? sq.heading;
      const c = Math.cos(h), s = Math.sin(h);
      u.type = sq.type; u.armed = sq.armed; u.n = sq.n; u.aiming = !!sq.aiming;
      project(x + c * 1500, alt, y + s * 1500, u.path);
      project(x + Math.cos(this.want) * 1500, alt, y + Math.sin(this.want) * 1500, u.wantPt);
      if (sq.type === 'ft' || sq.armed <= 0 || sq.state === 'return') { u.ready = false; u.aimFrac = 0; return; }
      const min = sq.type === 'tb' ? AIR.tbAimMin : AIR.dbAimMin, full = sq.type === 'tb' ? AIR.tbAimFull : AIR.dbAimFull;
      u.ready = sq.aiming && sq.aimT >= min;
      u.aimFrac = sq.aiming ? clamp01(sq.aimT / full) : 0;
      u.minFrac = min / full;
      if (sq.type === 'tb') {
         const dx = x + c * AIR.tbDrop, dy = y + s * AIR.tbDrop, R = sq.cfg.weapon.range || 3000;
         for (let l = 0; l < 3; l++) {
            const a = h + (l - 1) * sq.spread * 0.5, ca = Math.cos(a), sa = Math.sin(a), line = u.fan[l];
            for (let i = 0; i < FAN_PTS; i++) {
               const r = R * i / (FAN_PTS - 1);
               project(dx + ca * r, 0, dy + sa * r, line[i]);
            }
         }
         u.nFan = 3;
         const al = h - sq.spread * 0.5, ar = h + sq.spread * 0.5;
         project(dx + Math.cos(al) * AIR.tbArm, 0, dy + Math.sin(al) * AIR.tbArm, u.arm[0]);
         project(dx + Math.cos(ar) * AIR.tbArm, 0, dy + Math.sin(ar) * AIR.tbArm, u.arm[1]);
      } else {
         const cx = x + c * AIR.dbAim, cy = y + s * AIR.dbAim, R = sq.ellipse;
         project(cx, 0, cy, u.center);
         for (let i = 0; i < ELL_PTS; i++) {
            const a = i / ELL_PTS * TAU, uu = Math.cos(a) * R, vv = Math.sin(a) * R * 0.5;
            project(cx + c * uu - s * vv, 0, cy + s * uu + c * vv, u.ell[i]);
         }
         u.nEll = ELL_PTS;
      }
   }
}

// ---------------------------------------------------------------- canvas drawing (hud3d.js)
const COL_ALLY = T.ally, COL_ENEMY = T.enemy, COL_OWN = T['ally-soft'], COL_AIM = T.gold, COL_LOOSE = rgba(T.hud, 0.7);
function glyph(g, x, y, s) {
   // a small plane seen from above, nose up
   g.beginPath();
   g.moveTo(x, y - s); g.lineTo(x, y + s * 0.9);                 // fuselage
   g.moveTo(x - s, y - s * 0.15); g.lineTo(x + s, y - s * 0.15); // wing
   g.moveTo(x - s * 0.45, y + s * 0.8); g.lineTo(x + s * 0.45, y + s * 0.8);
   g.stroke();
}
const SHORT = { tb: 'TB', db: 'SB', ft: 'J' };

export function drawAir(g, ui, W, H, t) {
   const a = ui.air;
   if (!a) return;
   g.save();
   g.lineCap = 'round';
   g.font = '600 11px Segoe UI, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
   g.shadowColor = 'rgba(0,0,0,0.85)'; g.shadowBlur = 3;
   for (let i = 0; i < a.nMarks; i++) {
      const m = a.marks[i];
      const col = !m.ally ? COL_ENEMY : m.own ? COL_OWN : COL_ALLY;
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 2;
      g.globalAlpha = m.home ? 0.55 : 1;
      glyph(g, m.x, m.y, 6);
      g.fillText(SHORT[m.type] + ' ' + m.n, m.x + 9, m.y);
   }
   g.globalAlpha = 1;
   if (a.flying) {
      // torpedo fan: three lines from the drop point, the arming distance as a bar
      const col = a.ready ? COL_AIM : COL_LOOSE;
      g.strokeStyle = col; g.lineWidth = a.ready ? 2 : 1.4;
      if (a.nFan) {
         g.beginPath();
         for (let l = 0; l < a.nFan; l++) {
            const L = a.fan[l];
            for (let i = 1; i < L.length; i++) {
               const p0 = L[i - 1], p1 = L[i];
               if (!p0.visible || !p1.visible) continue;
               g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y);
            }
         }
         if (a.arm[0].visible && a.arm[1].visible) { g.moveTo(a.arm[0].x, a.arm[0].y); g.lineTo(a.arm[1].x, a.arm[1].y); }
         g.stroke();
      }
      if (a.nEll) {
         g.beginPath();
         let first = true;
         for (let i = 0; i <= a.nEll; i++) {
            const q = a.ell[i % a.nEll];
            if (!q.visible) { first = true; continue; }
            if (first) { g.moveTo(q.x, q.y); first = false; } else g.lineTo(q.x, q.y);
         }
         g.stroke();
         if (a.ready) { g.globalAlpha = 0.15; g.fillStyle = COL_AIM; g.fill(); g.globalAlpha = 1; }
         if (a.center.visible) { g.beginPath(); g.arc(a.center.x, a.center.y, 3, 0, TAU); g.stroke(); }
      }
      // flight path marker + wanted heading
      g.strokeStyle = 'rgba(235,245,255,0.9)'; g.lineWidth = 1.6;
      if (a.path.visible) {
         const x = a.path.x, y = a.path.y;
         g.beginPath(); g.arc(x, y, 7, 0, TAU);
         g.moveTo(x - 15, y); g.lineTo(x - 7, y); g.moveTo(x + 7, y); g.lineTo(x + 15, y); g.moveTo(x, y - 7); g.lineTo(x, y - 12);
         g.stroke();
      }
      if (a.wantPt.visible) {
         const x = a.wantPt.x, y = a.wantPt.y;
         g.strokeStyle = COL_AIM; g.beginPath(); g.moveTo(x - 5, y - 5); g.lineTo(x + 5, y + 5); g.moveTo(x + 5, y - 5); g.lineTo(x - 5, y + 5); g.stroke();
      }
      // attack-run progress (bottom centre)
      if (a.aiming) {
         const w = 180, x0 = W / 2 - w / 2, y0 = H * 0.72;
         g.fillStyle = 'rgba(8,16,24,0.6)'; g.fillRect(x0 - 2, y0 - 2, w + 4, 10);
         g.fillStyle = a.ready ? COL_AIM : 'rgba(235,245,255,0.7)'; g.fillRect(x0, y0, w * a.aimFrac, 6);
         g.fillStyle = '#ffffff'; g.fillRect(x0 + w * a.minFrac - 1, y0 - 3, 2, 12);
         g.textAlign = 'center'; g.fillStyle = a.ready ? COL_AIM : COL_LOOSE;
         g.fillText(a.ready ? (a.type === 'tb' ? 'Loslassen: Torpedos los' : 'Loslassen: Bomben los') : 'Anflug …', W / 2, y0 + 20);
      } else if (a.armed > 0 && a.type !== 'ft') {
         g.textAlign = 'center'; g.fillStyle = COL_LOOSE;
         g.fillText((touch() ? 'Angriff halten: Zielanflug (' : 'LMB halten: Zielanflug (') + a.armed + ' bewaffnet)', W / 2, H * 0.72 + 6);
      }
   }
   g.restore();
}

// Minimap / tactical map (minimap3d.js): squadrons the team can see, the controlled one white.
export function drawAirMap(g, world, p, mx, my, big, ctlId) {
   const sqs = world.squadrons;
   if (!sqs || !sqs.length) return;
   g.save();
   g.lineCap = 'round'; g.lineWidth = big ? 2 : 1.4;
   const s = big ? 6 : 4;
   for (const q of sqs) {
      if (q.n <= 0 || q.state === 'land' || !q.visible) continue;
      const ally = p && q.side === p.side;
      g.strokeStyle = q.id === ctlId ? '#ffffff' : !ally ? COL_ENEMY : q.ownerId === p?.id ? COL_OWN : COL_ALLY;
      g.globalAlpha = q.state === 'return' ? 0.55 : 1;
      const x = mx(q.pos.x), y = my(q.pos.y);
      g.save(); g.translate(x, y); g.rotate(q.heading + Math.PI / 2);
      glyph(g, 0, 0, s);
      g.restore();
      if (big && ally && q.type === 'ft' && q.center && q.state === 'patrol') {
         g.globalAlpha = 0.35; g.beginPath(); g.arc(mx(q.center.x), my(q.center.y), Math.abs(mx(AIR.patrolR) - mx(0)), 0, TAU); g.stroke();
      }
   }
   g.restore();
}
