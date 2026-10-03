// game3d/net/codec.js — the binary ship snapshot (channel `snap`, host -> client).
//
// One message = the state of every ship afloat or sinking (the same bytes for all clients of a
// team; PvP: only what that team can see, see encodeShips) followed by the receiving client's
// own-ship detail (reloads, consumables, fires ...).
// Everything little endian:
//   u8 kind (1) · u32 tick (sequence number) · u32 ack (own actions executed) · u16 echo (last
//   command sequence number received, for the round-trip estimate) · u8 nShips
//   per ship: u32 id · u8 f1 · u8 f2 · f32 x · f32 y · u16 heading · i16 speed*100 · i8 rudder
//             · i8 heel · u16 hp fraction · u8 fires<<4|floods · u8 depthF*100 · u8 sinkT*255
//             · u8 nT · nT x u8 turret bearing
//   own detail: see encodeOwn()
// Decoding of everything side-related goes through localSide(), the single place a PvP client
// of the other team swaps 'player' and 'enemy'.
import { DEEP_M, periDepthM } from '../submarine.js';

export const SIM_DT = 1 / 60;
export const MAX_SHIPS = 64, MAX_TURRETS = 8;
export const SNAP_KIND = 1, SNAP_HEAD = 12;
const TAU = Math.PI * 2;

// Host sides -> sides as the local player sees them. Co-op: every human is on the host's side;
// PvP: flip = the client sails for the other team (its World was flipped, setup.flipSides).
export function localSide(side, flip = false) {
   return !flip ? side : side === 'player' ? 'enemy' : side === 'enemy' ? 'player' : side;
}

export const F_ALIVE = 1, F_SINKING = 2, F_DETECTED = 4, F_SPOTTED = 8, F_SMOKE = 16, F_BLOOM = 32, F_GROUNDED = 64;

const u8c = (v, k, max = 255) => { v = Math.round(v * k); return v < 0 ? 0 : v > max ? max : v; };
const i8c = (v, k) => { v = Math.round(v * k); return v < -127 ? -127 : v > 127 ? 127 : v; };
const u16c = (v, k) => { v = Math.round(v * k); return v < 0 ? 0 : v > 65535 ? 65535 : v; };

// Can the team sailing as `side` see ship s? Its own ships, every enemy it has spotted, and
// every wreck (a sinking ship is no secret).
export const visibleTo = (s, side) => s.side === side || s.detected || !s.alive;

// ---- host: common part. Returns the offset behind the last ship.
// side (PvP): only the ships that team can see (visibleTo); an enemy it has not spotted is not
// in the message at all, so a client never learns where it is.
export function encodeShips(dv, world, side = null) {
   const ships = world.ships;
   dv.setUint8(0, SNAP_KIND);
   dv.setUint32(1, world.tick >>> 0, true);
   dv.setUint32(5, 0, true);
   dv.setUint16(9, 0, true);
   let o = SNAP_HEAD, n = 0;
   for (let i = 0; i < ships.length && n < MAX_SHIPS; i++) {
      const s = ships[i];
      if (side && !visibleTo(s, side)) continue;
      n++;
      dv.setUint32(o, s.id, true);
      o += 2;                       // the offsets below were laid out for a 2-byte id
      dv.setUint8(o + 2,(s.alive ? F_ALIVE : 0) | (s.sinking ? F_SINKING : 0) | (s.detected ? F_DETECTED : 0) | (s.spotted ? F_SPOTTED : 0)
         | (s.inSmoke ? F_SMOKE : 0) | (s.blooming ? F_BLOOM : 0) | (s.grounded ? F_GROUNDED : 0));
      dv.setUint8(o + 3, (s.depth & 3) | ((s.telegraph + 1) & 7) << 2 | ((s.rudderCmd + 2) & 7) << 5);
      dv.setFloat32(o + 4, s.pos.x, true);
      dv.setFloat32(o + 8, s.pos.y, true);
      dv.setUint16(o + 12, Math.round((((s.heading % TAU) + TAU) % TAU) / TAU * 65536) & 0xffff, true);
      dv.setInt16(o + 14, Math.max(-32767, Math.min(32767, Math.round(s.speed * 100))), true);
      dv.setInt8(o + 16, i8c(s.rudder, 127));
      dv.setInt8(o + 17, i8c(s.heel, 500));
      const hp = s.hp > 0 ? Math.max(1, u16c(s.hp / s.maxHP, 65535)) : 0;
      dv.setUint16(o + 18, hp, true);
      dv.setUint8(o + 20, Math.min(15, s.fires.length) << 4 | Math.min(15, s.floods.length));
      dv.setUint8(o + 21, u8c(s.depthF, 100));
      dv.setUint8(o + 22, u8c(s.sinkT, 255));
      const T = s.turrets, nT = Math.min(T.length, MAX_TURRETS);
      dv.setUint8(o + 23, nT);
      o += 24;
      for (let k = 0; k < nT; k++) dv.setUint8(o++, Math.round((((T[k].bearing % TAU) + TAU) % TAU) / TAU * 256) & 255);
   }
   dv.setUint8(11, n);
   return o;
}

// ---- client: a pooled, decoded snapshot
export function makeSnap() {
   const N = MAX_SHIPS;
   return {
      tick: -1, t: 0, ack: 0, echo: 0, n: 0, own: 0,
      id: new Uint32Array(N), f1: new Uint8Array(N), f2: new Uint8Array(N),
      x: new Float32Array(N), y: new Float32Array(N), hd: new Float32Array(N), sp: new Float32Array(N),
      rud: new Float32Array(N), heel: new Float32Array(N), hp: new Float32Array(N), ff: new Uint8Array(N),
      dep: new Float32Array(N), sink: new Float32Array(N), nT: new Uint8Array(N), tb: new Float32Array(N * MAX_TURRETS),
   };
}

export function snapTick(dv) { return dv.byteLength >= SNAP_HEAD && dv.getUint8(0) === SNAP_KIND ? dv.getUint32(1, true) : -1; }

// Fills `s`; s.own = offset of the own-ship detail. Returns false for a malformed message.
export function decodeSnap(dv, s) {
   try {
      if (dv.getUint8(0) !== SNAP_KIND) return false;
      s.tick = dv.getUint32(1, true); s.t = s.tick * SIM_DT;
      s.ack = dv.getUint32(5, true);
      s.echo = dv.getUint16(9, true);
      const n = dv.getUint8(11);
      if (n > MAX_SHIPS) return false;
      let o = SNAP_HEAD;
      for (let i = 0; i < n; i++) {
         s.id[i] = dv.getUint32(o, true);
         o += 2;
         s.f1[i] = dv.getUint8(o + 2); s.f2[i] = dv.getUint8(o + 3);
         s.x[i] = dv.getFloat32(o + 4, true); s.y[i] = dv.getFloat32(o + 8, true);
         s.hd[i] = dv.getUint16(o + 12, true) / 65536 * TAU;
         s.sp[i] = dv.getInt16(o + 14, true) / 100;
         s.rud[i] = dv.getInt8(o + 16) / 127;
         s.heel[i] = dv.getInt8(o + 17) / 500;
         s.hp[i] = dv.getUint16(o + 18, true) / 65535;
         s.ff[i] = dv.getUint8(o + 20);
         s.dep[i] = dv.getUint8(o + 21) / 100;
         s.sink[i] = dv.getUint8(o + 22) / 255;
         const nT = dv.getUint8(o + 23);
         if (nT > MAX_TURRETS) return false;
         s.nT[i] = nT;
         o += 24;
         for (let k = 0; k < nT; k++) { let b = dv.getUint8(o++) / 256 * TAU; if (b > Math.PI) b -= TAU; s.tb[i * MAX_TURRETS + k] = b; }
      }
      s.n = n; s.own = o;
      return true;
   } catch (e) { return false; }
}

// Depth in metres as submarine.js derives it from depthF.
export function depthMetres(cfg, f) {
   if (!cfg.sub || f <= 0) return 0;
   const pm = periDepthM(cfg);
   return f <= 1 ? f * pm : pm + (f - 1) * DEEP_M;
}

// ---- own-ship detail: what only the captain's HUD needs
//   u32 ship id · u8 nT · nT x (u16 reload cs, u8 disabledT*4) · u8 nL · nL x u16 reload cs
//   · u8 nC · nC x (u8 charges, u16 cd cs, u16 t cs, u8 active) · u16 engine cs · u16 rudder cs
//   · u8 bits (1 AP, 2 wide spread, 4 battery lock, 8 has asw) · u16 secTarget (0 = none)
//   · f32 detectRange · f32 healPool · u8 nFires · n x (u8 zone, u16 t cs, u16 dur cs)
//   · u8 nFloods · n x (...) · u8 battery*255 · u8 depthTarget · u8 ping age*10 (255 = none)
//   · u16 asw reload cs · u8 asw charges left
export function encodeOwn(dv, o, s, world) {
   dv.setUint32(o, s.id, true); o += 4;
   const T = s.turrets, nT = Math.min(T.length, MAX_TURRETS);
   dv.setUint8(o++, nT);
   for (let i = 0; i < nT; i++) { dv.setUint16(o, u16c(T[i].reload, 100), true); dv.setUint8(o + 2, T[i].alive ? 0 : Math.max(1, u8c(T[i].disabledT, 4))); o += 3; }
   const L = s.torps ? s.torps.launchers : null, nL = L ? Math.min(L.length, 8) : 0;
   dv.setUint8(o++, nL);
   for (let i = 0; i < nL; i++) { dv.setUint16(o, u16c(L[i].reload, 100), true); o += 2; }
   const C = s.consumables, nC = Math.min(C.length, 8);
   dv.setUint8(o++, nC);
   for (let i = 0; i < nC; i++) {
      const c = C[i];
      dv.setUint8(o, c.charges === Infinity ? 255 : Math.min(254, c.charges));
      dv.setUint16(o + 1, u16c(c.cd, 100), true); dv.setUint16(o + 3, u16c(c.t, 100), true);
      dv.setUint8(o + 5, c.active ? 1 : 0);
      o += 6;
   }
   dv.setUint16(o, u16c(s.modules.engine, 100), true); dv.setUint16(o + 2, u16c(s.modules.rudder, 100), true); o += 4;
   dv.setUint8(o++, (s.ammo === 'AP' ? 1 : 0) | (s.torps && s.torps.spread === 'wide' ? 2 : 0) | (s.batteryLock ? 4 : 0) | (s.asw ? 8 : 0));
   dv.setUint32(o, s.secTarget != null ? s.secTarget : 0, true); o += 4;
   dv.setFloat32(o, Number.isFinite(s.detectRange) ? s.detectRange : 1e9, true); dv.setFloat32(o + 4, s.healPool, true); o += 8;
   for (const list of [s.fires, s.floods]) {
      const n = Math.min(list.length, 8);
      dv.setUint8(o++, n);
      for (let i = 0; i < n; i++) { dv.setUint8(o, list[i].zone & 255); dv.setUint16(o + 1, u16c(list[i].t, 100), true); dv.setUint16(o + 3, u16c(list[i].dur, 100), true); o += 5; }
   }
   dv.setUint8(o, u8c(s.battery, 255)); dv.setUint8(o + 1, s.depthTarget & 3);
   const ping = world.time - s.pingT;
   dv.setUint8(o + 2, ping >= 0 && ping < 25 ? u8c(ping, 10, 254) : 255);
   o += 3;
   dv.setUint16(o, s.asw ? u16c(s.asw.reload, 100) : 0, true); dv.setUint8(o + 2, s.asw ? Math.min(255, s.asw.left) : 0);
   return o + 3;
}

function fitList(list, n) {
   while (list.length > n) list.pop();
   while (list.length < n) list.push({ zone: 0, t: 0, dur: 1, srcId: null, mult: 1 });
}

// Applies the detail to `s` (the client's own ship). Returns false when it does not fit the ship.
// lead (s): the round trip. A command sent when the read-out shows "ready" arrives at the host
// exactly when the weapon is ready there, so reloads and cooldowns are shown that much further on.
export function decodeOwn(dv, o, s, world, lead = 0) {
   try {
      if (dv.getUint32(o, true) !== s.id) return false;
      o += 4;
      const T = s.turrets, nT = dv.getUint8(o++);
      for (let i = 0; i < nT; i++) {
         const t = T[i], dis = dv.getUint8(o + 2);
         if (t) { t.reload = Math.max(0, dv.getUint16(o, true) / 100 - lead); t.alive = dis === 0; t.disabledT = dis / 4; }
         o += 3;
      }
      const L = s.torps ? s.torps.launchers : null, nL = dv.getUint8(o++);
      for (let i = 0; i < nL; i++) { if (L && L[i]) L[i].reload = Math.max(0, dv.getUint16(o, true) / 100 - lead); o += 2; }
      const C = s.consumables, nC = dv.getUint8(o++);
      for (let i = 0; i < nC; i++) {
         const c = C[i];
         if (c) {
            const ch = dv.getUint8(o);
            c.charges = ch === 255 ? Infinity : ch;
            c.cd = Math.max(0, dv.getUint16(o + 1, true) / 100 - lead); c.t = dv.getUint16(o + 3, true) / 100; c.active = dv.getUint8(o + 5) === 1;
         }
         o += 6;
      }
      s.modules.engine = dv.getUint16(o, true) / 100; s.modules.rudder = dv.getUint16(o + 2, true) / 100; o += 4;
      const bits = dv.getUint8(o++);
      s.ammo = bits & 1 ? 'AP' : 'HE';
      if (s.torps) s.torps.spread = bits & 2 ? 'wide' : 'narrow';
      s.batteryLock = !!(bits & 4);
      const sec = dv.getUint32(o, true); o += 4;
      s.secTarget = sec ? sec : null;
      const dr = dv.getFloat32(o, true);
      s.detectRange = dr >= 1e9 ? Infinity : dr; s.healPool = dv.getFloat32(o + 4, true); o += 8;
      for (const list of [s.fires, s.floods]) {
         const n = dv.getUint8(o++);
         fitList(list, n);
         for (let i = 0; i < n; i++) { const f = list[i]; f.zone = dv.getUint8(o); f.t = dv.getUint16(o + 1, true) / 100; f.dur = dv.getUint16(o + 3, true) / 100; o += 5; }
      }
      s.battery = dv.getUint8(o) / 255; s.depthTarget = dv.getUint8(o + 1);
      const ping = dv.getUint8(o + 2);
      s.pingT = ping === 255 ? -999 : world.time - ping / 10;
      o += 3;
      if (s.asw && (bits & 8)) { s.asw.reload = dv.getUint16(o, true) / 100; s.asw.left = dv.getUint8(o + 2); }
      return true;
   } catch (e) { return false; }
}
export { fitList };
