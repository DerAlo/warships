// game3d/shellcam.js — optional "Geschoss-Kamera": the camera rides along one of the player's
// own main-battery shells, holds briefly on the impact, then hands back to the chase rig.
//
// Same mechanism as the kill camera in main3d.js: while active, cam3.override points at this
// module's pose object ({px,py,pz,tx,ty,tz,fov}); camera3d freezes the whole chase rig (scope
// blend, zoom smoothing, stored aim pose), so clearing the override resumes the old view exactly.
// The sim keeps running at normal speed; main3d holds the guns and the HUD while `on` is set.
//
// Settings (persisted with the other player settings): settings.shellCam =
//   'off'  — never,
//   'key'  — B arms it: follows the salvo in flight, else the next own salvo (default),
//   'auto' — every own salvo with a flight time >= AUTO_MIN_FLIGHT (B still works).
//
// Shell kinematics come straight from combat.js (horizDist / arcAlt): a shell's ground position
// and altitude are analytic functions of its age, so the followed shell (and its salvo mates)
// can be drawn at the interpolated render time without the 60 Hz step jitter.
//
// Hot path (update/restore) allocates nothing: scratch objects are reused, saved shell states
// live in a Float64Array that only grows.
import { horizDist, arcAlt, ARC_A } from './combat.js';

export const SHELLCAM_MODES = ['off', 'key', 'auto'];
export const SHELLCAM_LABELS = { off: 'Aus', key: 'Mit Taste', auto: 'Jede Salve' };
export const SHELLCAM_KEY = 'B';
export const AUTO_MIN_FLIGHT = 2.5;   // s: 'auto' skips short (point-blank) salvos
export const SALVO_WINDOW = 0.25;     // s: own main shells this close in age form one salvo
export const HOLD = 0.8;              // s on the impact point
export const CAP = 12;                // s real time, hard limit for the whole cut
export const FOV = 50;

const DEG = Math.PI / 180;
const BACK = 62, UP = 10;             // m behind (along the half-flattened flight path) / above the shell
const LOOK = 500;                     // m: look-target distance along the view direction
const PITCH_MIN = -18 * DEG, PITCH_MAX = 10 * DEG;   // keeps the horizon in the 50 deg view
const BLEND_U0 = 0.6, BLEND_U1 = 0.92, BLEND_MAX = 0.6;   // late-flight look blend to the locked ship
const HOLD_BACK = 170, HOLD_UP = 55;  // vantage the camera eases to during the impact hold
const TAU_PITCH = 0.15, TAU_LOOK = 0.2, TAU_HOLD = 0.35;
const HIT_TYPES = new Set(['pen', 'citadel', 'overpen', 'ricochet', 'shatter', 'he', 'sec', 'torp']);

const clamp = (x, lo, hi) => x < lo ? lo : x > hi ? hi : x;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export function normMode(v) { return SHELLCAM_MODES.includes(v) ? v : 'key'; }

function isOwnMain(s, ownerId) {
   return !!s && s.alive !== false && s.kind === 'main' && (s.ownerId === ownerId || (s.ownerId == null && s.shooter?.id === ownerId));
}

// The shell to follow: from the owner's latest main-battery salvo (the youngest own main shell
// and everything fired within SALVO_WINDOW of it), the one whose impact point lies closest to
// the aim point it was fired at. minId: only shells with a larger id count (new salvos).
export function pickShell(shells, ownerId, minId = -Infinity) {
   let minAge = Infinity;
   for (let i = 0; i < shells.length; i++) {
      const s = shells[i];
      if (isOwnMain(s, ownerId) && s.id > minId && (s.age || 0) < minAge) minAge = s.age || 0;
   }
   if (minAge === Infinity) return null;
   let best = null, bestD = Infinity;
   for (let i = 0; i < shells.length; i++) {
      const s = shells[i];
      if (!isOwnMain(s, ownerId) || s.id <= minId || (s.age || 0) > minAge + SALVO_WINDOW) continue;
      const tg = s.target || s.pos, ap = s.aimPoint || tg;
      const d = (tg.x - ap.x) ** 2 + (tg.y - ap.y) ** 2;
      if (d < bestD) { bestD = d; best = s; }
   }
   return best;
}

// Highest id among the owner's main shells (new-salvo detection).
export function maxOwnId(shells, ownerId, prev = -Infinity) {
   let m = prev;
   for (let i = 0; i < shells.length; i++) {
      const s = shells[i];
      if (isOwnMain(s, ownerId) && s.id > m) m = s.id;
   }
   return m;
}

// Shell state at age t in 3D render space (x = sim x, y = up, z = sim y). out gets the position
// (x, y, z), the unit flight direction (dx, dy, dz), its pitch (rad) and the ground progress u.
// Returns false (out untouched beyond the fallback) for shells without the ballistic fields.
export function shellAt(s, t, out) {
   const g = s.gun;
   if (g && g.vShell && g.range && s.start && s.range > 0 && Number.isFinite(s.H)) {
      const x = Math.min(s.range, horizDist(g, Math.max(0, t)));
      const u = x / s.range;
      out.x = s.start.x + s.dirX * x;
      out.z = s.start.y + s.dirY * x;
      out.y = arcAlt(s.H, s.h0, u);
      const slope = (-s.h0 + s.H * ARC_A * (1 - 3 * u * u)) / s.range;   // d alt / d ground distance
      const n = Math.sqrt(1 + slope * slope);
      out.dx = s.dirX / n; out.dy = slope / n; out.dz = s.dirY / n;
      out.pitch = Math.atan(slope);
      out.u = u;
      return true;
   }
   // fallback (legacy shells): current position, flat direction
   const dir = Number.isFinite(s.dirX) ? null : (s.vel ? Math.atan2(s.vel.y, s.vel.x) : (s.dir || 0));
   out.x = s.pos.x; out.z = s.pos.y; out.y = Number.isFinite(s.alt) ? s.alt : 50;
   out.dx = dir === null ? s.dirX : Math.cos(dir); out.dz = dir === null ? s.dirY : Math.sin(dir); out.dy = 0;
   out.pitch = 0;
   out.u = Math.min(1, s.arc ?? ((s.age || 0) / (s.dur || 1)));
   return false;
}

// Chase pose for a shell state: camera BACK metres behind along the half-flattened flight path
// and UP metres above it; view pitch = 0.6 x flight pitch, clamped so the horizon stays in view.
// look (optional): { x, y, z, w } — blend the view toward this point by weight w.
// out: { px, py, pz, lx, ly, lz } camera position + unit look direction.
export function chasePose(st, pitch, look, out) {
   const hx = st.dx, hz = st.dz, hn = Math.hypot(hx, hz) || 1;
   const dx = hx / hn, dz = hz / hn;
   const q = pitch * 0.5, cq = Math.cos(q);
   out.px = st.x - dx * cq * BACK;
   out.pz = st.z - dz * cq * BACK;
   out.py = st.y - Math.sin(q) * BACK + UP;
   const c = clamp(pitch * 0.6, PITCH_MIN, PITCH_MAX), cc = Math.cos(c);
   let lx = dx * cc, ly = Math.sin(c), lz = dz * cc;
   if (look && look.w > 0) {
      let tx = look.x - out.px, ty = look.y - out.py, tz = look.z - out.pz;
      const tn = Math.hypot(tx, ty, tz) || 1;
      tx /= tn; ty /= tn; tz /= tn;
      lx += (tx - lx) * look.w; ly += (ty - ly) * look.w; lz += (tz - lz) * look.w;
   }
   clampPitch(lx, ly, lz, dx, dz, out);
   return out;
}

// Normalise (lx,ly,lz) with its pitch limited to [PITCH_MIN, PITCH_MAX] into out.lx/ly/lz.
// (fx, fz): heading fallback for a vertical vector.
export function clampPitch(lx, ly, lz, fx, fz, out) {
   let h = Math.hypot(lx, lz);
   if (h < 1e-6) { lx = fx; lz = fz; h = Math.hypot(lx, lz) || 1; }
   const p = clamp(Math.atan2(ly, h), PITCH_MIN, PITCH_MAX), cp = Math.cos(p);
   out.lx = lx / h * cp; out.ly = Math.sin(p); out.lz = lz / h * cp;
   return out;
}

export class ShellCam {
   // ctx: { cam3, input, hud, overlay, settings, saveSettings, simDt, hintEl,
   //        world(), phase(), torpWarn(), killCamOn(), lockedShip(), mapOpen() }
   constructor(ctx) {
      this.ctx = ctx;
      ctx.settings.shellCam = normMode(ctx.settings.shellCam);
      this.pose = { px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0, fov: FOV };
      this.on = false;
      this.state = 'idle';          // idle | follow | hold
      this.armed = false;
      this.shell = null;
      this.lastId = -Infinity;
      this.reason = '';             // why the last cut ended (tests / debugging)
      this._w0 = 0; this._holdT = 0; this._hp0 = 0; this._seq = 0; this._phase0 = '';
      this._prevRight = false; this._fireHold = false; this._world = null;
      this._st = { x: 0, y: 0, z: 0, dx: 1, dy: 0, dz: 0, pitch: 0, u: 0 };
      this._look = { x: 0, y: 0, z: 0, w: 0 };
      this._des = { px: 0, py: 0, pz: 0, lx: 1, ly: 0, lz: 0 };
      this._cam = { x: 0, y: 0, z: 0, lx: 1, ly: 0, lz: 0, pitch: 0 };
      this._imp = { x: 0, y: 0, z: 0, hx: 1, hz: 0 };
      this._saved = new Float64Array(64 * 3);
      this._savedArr = null;
      this._nSaved = 0;
   }

   get mode() { return this.ctx.settings.shellCam; }
   setMode(m) {
      this.ctx.settings.shellCam = normMode(m);
      if (this.mode === 'off') { this.armed = false; this.end('setting'); }
      this.ctx.saveSettings();
   }

   // <select> in the pause menu: values off/key/auto, labels from SHELLCAM_LABELS.
   bindSelect(el) {
      if (!el) return;
      el.value = this.mode;
      el.addEventListener('change', () => this.setMode(el.value));
   }

   // New match / back to the port: drop everything, forget old shell ids.
   reset() {
      this.end('reset');
      this.armed = false; this.shell = null; this.lastId = -Infinity; this._fireHold = false; this._world = null;
   }

   // main3d gate for fireGuns: hold fire while active and until a skip-click is released.
   blocksFire() {
      if (this._fireHold && !this.ctx.input.mouse.down) this._fireHold = false;
      return this.on || this._fireHold;
   }

   // Before frameInput (like killCamInput): the aim is frozen, any key / click / wheel / right
   // button skips back. Key taps still act on the game (the kill cam does the same), except the
   // shell-cam key itself, which only returns.
   input() {
      const inp = this.ctx.input, m = inp.mouse;
      const rightEdge = m.right && !this._prevRight;
      this._prevRight = m.right;
      if (!this.on) return;
      const skip = inp.pressed.size > 0 || m.clicked || m.wheel || rightEdge;
      if (m.clicked) this._fireHold = true;
      m.dx = 0; m.dy = 0; m.wheel = 0; m.clicked = false;
      if (skip) {
         if (inp.pressed.has(SHELLCAM_KEY)) inp.pressed.delete(SHELLCAM_KEY);
         this.end('input');
      }
   }

   // Can a cut start right now?
   _canStart(w, p) {
      const c = this.ctx;
      return !this.on && !!p?.alive && c.phase() === 'playing' && w.phase === 'playing' && !c.killCamOn() && !c.torpWarn() && !c.mapOpen?.();
   }

   // Once per frame after the sim steps and the kill cam tick, before the render:
   // B key, salvo detection, abort checks, camera pose. alpha = render interpolation fraction.
   update(dt, alpha) {
      const c = this.ctx, w = c.world(), p = w?.player;
      if (!w || !p) { if (this.on) this.end('world'); return; }
      const shells = w.shells || [];
      // a new match: shells already in the air (none, normally) never count as a new salvo
      if (w !== this._world) { this._world = w; this.lastId = maxOwnId(shells, p.id); }

      // --- shell-cam key
      if (c.input.tapped(SHELLCAM_KEY) && c.phase() === 'playing') this._onKey(w, p, shells);

      // --- new own salvo -> start (armed or 'auto')
      const newest = maxOwnId(shells, p.id, this.lastId);
      if (newest > this.lastId) {
         const prev = this.lastId;
         this.lastId = newest;
         if (this.mode !== 'off' && this._canStart(w, p)) {
            const s = pickShell(shells, p.id, prev);
            if (s && (this.armed || (this.mode === 'auto' && (s.dur || 0) >= AUTO_MIN_FLIGHT))) this.start(s, w);
         }
      }
      if (!this.on) return;

      // --- aborts (kill cam wins: it already owns cam3.override, leave it be)
      if (c.killCamOn()) { this.end('killcam'); return; }
      const wall = (performance.now() - this._w0) / 1000;
      if (c.phase() !== 'playing' || w.phase !== this._phase0) { this.end('phase'); return; }
      if (!p.alive || c.torpWarn() || c.mapOpen?.()) { this.end('danger'); return; }
      if (this._hitOnPlayer(w, p)) { this.end('hit'); return; }
      if (wall >= CAP) { this.end('cap'); return; }

      // --- follow -> hold on impact
      const s = this.shell;
      if (this.state === 'follow' && (!s || s.alive === false || (s.alive === undefined && shells.indexOf(s) < 0))) this._toHold(s);
      if (this.state === 'hold') {
         this._holdT += dt;
         if (this._holdT >= HOLD) { this.end('done'); return; }
         this._tickHold(dt);
      } else this._tickFollow(dt, alpha, shells);
   }

   _onKey(w, p, shells) {
      const c = this.ctx;
      if (this.mode === 'off') { c.hud.msg('Geschoss-Kamera ist in den Optionen ausgeschaltet', 'info'); return; }
      if (this.on) return;   // input() already turned it off this frame
      const inFlight = this._canStart(w, p) ? pickShell(shells, p.id) : null;
      if (inFlight) { this.armed = false; this.start(inFlight, w); return; }
      this.armed = !this.armed;
      c.hud.msg(this.armed ? 'Geschoss-Kamera: folgt der nächsten Salve' : 'Geschoss-Kamera abbestellt', 'info');
   }

   start(s, w) {
      const c = this.ctx, p = w.player;
      this.on = true; this.state = 'follow'; this.shell = s; this.armed = false; this.reason = '';
      this._w0 = performance.now(); this._holdT = 0; this._hp0 = p.hp; this._phase0 = w.phase;
      this._seq = 0;
      const ev = w.events;
      if (ev) for (let i = ev.length - 1; i >= 0; i--) { if (typeof ev[i].seq === 'number') { this._seq = ev[i].seq; break; } }
      this._prevRight = c.input.mouse.right;
      // cut in: the smoothed state starts at the target pose
      shellAt(s, s.age || 0, this._st);
      this._cam.pitch = this._st.pitch;
      chasePose(this._st, this._st.pitch, null, this._des);
      this._cam.lx = this._des.lx; this._cam.ly = this._des.ly; this._cam.lz = this._des.lz;
      this._writePose(this._des.px, this._des.py, this._des.pz);
      c.cam3.override = this.pose;
      c.hud.show(false);
      c.overlay?.clear();
      c.hintEl?.classList.remove('hidden');
   }

   end(reason = '') {
      if (!this.on) return;
      const c = this.ctx;
      this.on = false; this.state = 'idle'; this.shell = null; this.reason = reason;
      c.hintEl?.classList.add('hidden');
      if (c.cam3.override === this.pose) {
         c.cam3.override = null;
         const m = c.input.mouse;
         m.dx = 0; m.dy = 0; m.wheel = 0;
         const ph = c.phase();
         if ((ph === 'playing' || ph === 'paused') && !c.killCamOn()) c.hud.show(true);
      }
   }

   // New hit event on the player since the cut started (fallback: a >3 % HP drop).
   _hitOnPlayer(w, p) {
      const ev = w.events;
      let hit = false, top = this._seq;
      if (ev) {
         for (let i = ev.length - 1; i >= 0; i--) {
            const e = ev[i];
            if (typeof e.seq !== 'number' || e.seq <= this._seq) break;
            if (e.seq > top) top = e.seq;
            if (e.dstId === p.id && HIT_TYPES.has(e.type)) hit = true;
         }
      }
      this._seq = top;
      return hit || p.hp < this._hp0 - p.maxHP * 0.03;
   }

   _tickFollow(dt, alpha, shells) {
      const c = this.ctx, s = this.shell, st = this._st, cam = this._cam;
      // render time of the sim state: one step behind by (1 - alpha), like the interpolated ships
      const back = (1 - (alpha ?? 1)) * (c.simDt || 1 / 60);
      this._interpShells(shells, back);
      shellAt(s, Math.max(0, (s.age || 0) - back), st);
      const kp = 1 - Math.exp(-dt / TAU_PITCH);
      cam.pitch += (st.pitch - cam.pitch) * kp;
      // late flight: turn toward the locked target ship
      const look = this._look;
      look.w = 0;
      const tgt = c.lockedShip?.();
      if (tgt && tgt.pos) {
         look.w = smoothstep(BLEND_U0, BLEND_U1, st.u) * BLEND_MAX;
         look.x = tgt.pos.x; look.z = tgt.pos.y; look.y = (tgt.cfg?.hull?.deckH || 10) * 1.2;
      }
      chasePose(st, cam.pitch, look, this._des);
      const kl = 1 - Math.exp(-dt / TAU_LOOK);
      cam.lx += (this._des.lx - cam.lx) * kl; cam.ly += (this._des.ly - cam.ly) * kl; cam.lz += (this._des.lz - cam.lz) * kl;
      clampPitch(cam.lx, cam.ly, cam.lz, st.dx, st.dz, cam);
      this._writePose(this._des.px, this._des.py, this._des.pz);
   }

   _toHold(s) {
      const imp = this._imp, st = this._st;
      if (s && s.pos) { imp.x = s.pos.x; imp.z = s.pos.y; imp.y = Math.max(0, Math.min(Number.isFinite(s.alt) ? s.alt : 0, 40)); }
      else { imp.x = st.x; imp.z = st.z; imp.y = Math.max(0, Math.min(st.y, 40)); }
      const hn = Math.hypot(st.dx, st.dz) || 1;
      imp.hx = st.dx / hn; imp.hz = st.dz / hn;
      this.state = 'hold'; this._holdT = 0;
   }

   _tickHold(dt) {
      const cam = this._cam, imp = this._imp, o = this.pose;
      const k = 1 - Math.exp(-dt / TAU_HOLD);
      const vx = imp.x - imp.hx * HOLD_BACK, vz = imp.z - imp.hz * HOLD_BACK, vy = HOLD_UP;
      cam.x += (vx - cam.x) * k; cam.y += (vy - cam.y) * k; cam.z += (vz - cam.z) * k;
      let lx = imp.x - cam.x, ly = imp.y + 8 - cam.y, lz = imp.z - cam.z;
      const n = Math.hypot(lx, ly, lz) || 1;
      lx /= n; ly /= n; lz /= n;
      const kl = 1 - Math.exp(-dt / 0.15);
      cam.lx += (lx - cam.lx) * kl; cam.ly += (ly - cam.ly) * kl; cam.lz += (lz - cam.lz) * kl;
      const m = Math.hypot(cam.lx, cam.ly, cam.lz) || 1;
      o.px = cam.x; o.py = cam.y; o.pz = cam.z;
      o.tx = cam.x + cam.lx / m * LOOK; o.ty = cam.y + cam.ly / m * LOOK; o.tz = cam.z + cam.lz / m * LOOK;
      o.fov = FOV;
   }

   _writePose(px, py, pz) {
      const cam = this._cam, o = this.pose;
      cam.x = px; cam.y = py; cam.z = pz;
      o.px = px; o.py = py; o.pz = pz;
      o.tx = px + cam.lx * LOOK; o.ty = py + cam.ly * LOOK; o.tz = pz + cam.lz * LOOK;
      o.fov = FOV;
   }

   // Draw every in-flight shell at the interpolated render time (analytic in age), so the
   // followed shell and its salvo mates glide instead of stepping at 60 Hz. restore() undoes it.
   _interpShells(shells, back) {
      this._nSaved = 0;
      if (back <= 0) return;
      const n = shells.length;
      if (this._saved.length < n * 3) this._saved = new Float64Array(Math.max(n * 3, this._saved.length * 2));
      const sv = this._saved, st = this._st;
      for (let i = 0; i < n; i++) {
         const s = shells[i];
         sv[i * 3] = s.pos.x; sv[i * 3 + 1] = s.pos.y; sv[i * 3 + 2] = s.alt;
         if (s.alive !== false && shellAt(s, Math.max(0, (s.age || 0) - back), st)) { s.pos.x = st.x; s.pos.y = st.z; s.alt = st.y; }
      }
      this._nSaved = n;
      this._savedArr = shells;
   }

   // After the render (main3d's finally next to restoreInterp): sim state back to the step values.
   restore() {
      const n = this._nSaved;
      if (!n) return;
      const shells = this._savedArr, sv = this._saved;
      for (let i = 0; i < n && i < shells.length; i++) {
         const s = shells[i];
         s.pos.x = sv[i * 3]; s.pos.y = sv[i * 3 + 1]; s.alt = sv[i * 3 + 2];
      }
      this._nSaved = 0;
   }

   debug() {
      return { on: this.on, state: this.state, mode: this.mode, armed: this.armed, shellId: this.shell?.id ?? null,
         reason: this.reason, hold: this._holdT, pose: { ...this.pose } };
   }
}
