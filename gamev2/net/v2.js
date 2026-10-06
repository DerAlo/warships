// gamev2/net/v2.js — replication of what the modern mode adds to the World (host -> client):
// missiles, helicopters and homing ASW torpedoes in the binary snapshot, the captain's own weapon
// state in the own-ship detail, and the slow things (sensor picture, land sites, special-forces
// teams, task points, blasts, decoys) as a JSON message that is only sent when it changed.
// A team only ever gets what its side sees. No DOM in here.
//
// Snapshot block (codec.js puts it behind the squadrons), little endian:
//   u16 nM · per missile (16 bytes, +4 with an aim point):
//      u24 id · u8 type (M_TYPES) · u8 f1 (kind 0..2 | host side enemy 8 | seeker 16 | detected 32
//      | seduced 64 | aim point follows 128) · u8 f2 (tk 0..2 | eng 0..3 << 3 | on a decoy 32
//      | ref is the seeker's lock 64) · i16 x/2 · i16 y/2 · u8 heading · u8 alt (sqrt code)
//      · u8 speed/4 · u24 ref (lock or target id, 0 = none) [· i16 tx/2 · i16 ty/2]
//   u8 nH · per helicopter (14 bytes): u16 id · u16 owner · u8 bits (enemy 1 | state << 1
//      | point mode 8 | tracked by the other side 16) · i16 x/2 · i16 y/2 · u8 heading · u8 alt
//      · u8 speed · u8 fuel/255 · u8 torpedoes
//   u8 nA · per ASW torpedo (8 bytes): u24 id · i16 x/2 · i16 y/2 · u8 heading  (they home: the
//      client cannot run them on a straight line like the others)
// Own-ship V2 detail (before codec's own detail): u16 length · see encodeOwnV2.
import { MISSILES } from '../config.js';
import { addSite, siteById } from '../sites.js';
import { DOCTRINES } from '../missile.js';
import { HELO } from '../helo.js';
import { SEAL } from '../seal.js';
import { squadById, squadVisibleTo } from '../air.js';

const TAU = Math.PI * 2;
export const M_TYPES = Object.keys(MISSILES);
if (!M_TYPES.includes('rocket')) M_TYPES.push('rocket');
export const M_KINDS = ['ssm', 'cruise', 'rocket', 'sam', 'aam'];
export const M_TKS = ['point', 'ship', 'site', 'missile', 'squad', 'bearing'];
export const HELO_STATES = ['transit', 'dip', 'return'];
export const TEAM_STATES = ['out', 'working', 'returning', 'recovered', 'lost'];
export const TASK_STATES = ['open', 'busy', 'done'];
export const MAX_M = 320, MAX_H = 32, MAX_A = 64, M_BYTES = 16, H_BYTES = 14, A_BYTES = 8;
// actions the replica does not predict: the host launches, the snapshot shows it
export const V2_ACTS = { m: 1, b: 1, M: 1, k: 1, K: 1, o: 1, h: 1, S: 1, g: 1 };
export const V2_CONS = { decoy: 1, helo: 1 };

const SIDE_CODE = { player: 1, enemy: 2 }, SIDES = [null, 'player', 'enemy'];
const flipS = (side, flip) => !flip ? side : side === 'player' ? 'enemy' : side === 'enemy' ? 'player' : side;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => Math.round(v * 1000) / 1000;
const p16 = (v) => { v = Math.round(v / 2); return v < -32767 ? -32767 : v > 32767 ? 32767 : v; };
const u8c = (v, k = 1) => { v = Math.round(v * k); return v < 0 ? 0 : v > 255 ? 255 : v; };
const u16c = (v, k = 1) => { v = Math.round(v * k); return v < 0 ? 0 : v > 65535 ? 65535 : v; };
const put24 = (dv, o, v) => { v = (v >>> 0) & 0xffffff; dv.setUint16(o, v & 0xffff, true); dv.setUint8(o + 2, v >>> 16); };
const get24 = (dv, o) => dv.getUint16(o, true) | dv.getUint8(o + 2) << 16;
const lerpA = (a, b, k) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return a + d * k; };

// ================================================================ what a side sees
const platform = (world, id) => (id == null ? null : world.shipById(id) || siteById(world, id));
const platformSeen = (world, id, side) => { const P = platform(world, id); return !!P && (P.side === side || !!P.detected || !P.alive); };
// Its own missiles, every threat its sensors track, and the SAMs / rockets of a launcher it sees.
export function missileVisibleTo(world, m, side) {
   if (m.side === side || m.detected) return true;
   if (m.kind === 'aam') { const q = m.sqId != null ? squadById(world, m.sqId) : null; return !!q && squadVisibleTo(q, side); }
   return (m.kind === 'sam' || m.kind === 'rocket') && platformSeen(world, m.ownerId, side);
}
export const heloVisibleTo = (h, side) => h.side === side || (h.side === 'enemy' ? !!h.visible : !!h.visE);
const torpVisibleTo = (t, side) => t.side === side || !!t.visibleToOpp;

// ================================================================ snapshot block
export function encodeV2(dv, o, world, side) {
   let at = o, n = 0;
   o += 2;
   for (const m of world.missiles) {
      if (!m.alive || n >= MAX_M || !missileVisibleTo(world, m, side)) continue;
      n++;
      const lock = m.lock != null;
      const ref = lock ? m.lock : (m.tk !== 'point' && m.tk !== 'bearing' && typeof m.target === 'number') ? m.target : 0;
      const pt = !ref;
      put24(dv, o, m.id);
      dv.setUint8(o + 3, Math.max(0, M_TYPES.indexOf(m.type)));
      dv.setUint8(o + 4, Math.max(0, M_KINDS.indexOf(m.kind)) | (m.side === 'enemy' ? 8 : 0) | (m.seekerOn ? 16 : 0) | (m.detected ? 32 : 0) | (m.seduced ? 64 : 0) | (pt ? 128 : 0));
      dv.setUint8(o + 5, Math.max(0, M_TKS.indexOf(m.tk)) | Math.min(3, m.eng | 0) << 3 | (m.lockDecoy != null ? 32 : 0) | (lock ? 64 : 0));
      dv.setInt16(o + 6, p16(m.x), true); dv.setInt16(o + 8, p16(m.y), true);
      dv.setUint8(o + 10, u8c(((m.heading % TAU) + TAU) % TAU, 256 / TAU) & 255);
      dv.setUint8(o + 11, u8c(Math.sqrt(Math.max(0, m.alt)), 2.5));
      dv.setUint8(o + 12, u8c(m.speed, 0.25));
      put24(dv, o + 13, ref);
      o += M_BYTES;
      if (pt) { dv.setInt16(o, p16(m.tx), true); dv.setInt16(o + 2, p16(m.ty), true); o += 4; }
   }
   dv.setUint16(at, n, true);
   at = o++; n = 0;
   for (const h of world.helos) {
      if (!h.alive || n >= MAX_H || !heloVisibleTo(h, side)) continue;
      n++;
      dv.setUint16(o, h.id & 0xffff, true); dv.setUint16(o + 2, h.ownerId & 0xffff, true);
      dv.setUint8(o + 4, (h.side === 'enemy' ? 1 : 0) | Math.max(0, HELO_STATES.indexOf(h.state)) << 1 | (h.mode === 'point' ? 8 : 0) | ((h.side === 'enemy' ? h.visible : h.visE) ? 16 : 0));
      dv.setInt16(o + 5, p16(h.pos.x), true); dv.setInt16(o + 7, p16(h.pos.y), true);
      dv.setUint8(o + 9, u8c(((h.heading % TAU) + TAU) % TAU, 256 / TAU) & 255);
      dv.setUint8(o + 10, u8c(h.alt)); dv.setUint8(o + 11, u8c(h.speed));
      dv.setUint8(o + 12, u8c(h.fuel / (h.fuelMax || 1), 255)); dv.setUint8(o + 13, u8c(h.torps));
      o += H_BYTES;
   }
   dv.setUint8(at, n);
   at = o++; n = 0;
   for (const t of world.torpedoes) {
      if (!t.asw || !t.alive || n >= MAX_A || !torpVisibleTo(t, side)) continue;
      n++;
      put24(dv, o, t.id);
      dv.setInt16(o + 3, p16(t.pos.x), true); dv.setInt16(o + 5, p16(t.pos.y), true);
      dv.setUint8(o + 7, u8c(((t.heading % TAU) + TAU) % TAU, 256 / TAU) & 255);
      o += A_BYTES;
   }
   dv.setUint8(at, n);
   return o;
}

export function makeV2Snap() {
   const M = MAX_M, H = MAX_H, A = MAX_A;
   return {
      nm: 0, mid: new Uint32Array(M), mtype: new Uint8Array(M), mf1: new Uint8Array(M), mf2: new Uint8Array(M),
      mx: new Float32Array(M), my: new Float32Array(M), mh: new Float32Array(M), malt: new Float32Array(M), msp: new Float32Array(M),
      mref: new Uint32Array(M), mtx: new Float32Array(M), mty: new Float32Array(M), mi: new Map(),
      nh: 0, hid: new Uint16Array(H), hown: new Uint16Array(H), hb: new Uint8Array(H), hx: new Float32Array(H), hy: new Float32Array(H),
      hh: new Float32Array(H), halt: new Float32Array(H), hsp: new Float32Array(H), hfuel: new Float32Array(H), htorp: new Uint8Array(H), hi: new Map(),
      na: 0, aid: new Uint32Array(A), ax: new Float32Array(A), ay: new Float32Array(A), ah: new Float32Array(A), ai: new Map(),
   };
}
// Returns the offset behind the block, -1 when the bytes make no sense. (Throws on a short buffer;
// codec.decodeSnap catches that.)
export function decodeV2(dv, o, v) {
   const nm = dv.getUint16(o, true); o += 2;
   if (nm > MAX_M) return -1;
   v.mi.clear();
   for (let i = 0; i < nm; i++) {
      const f1 = dv.getUint8(o + 4);
      v.mid[i] = get24(dv, o); v.mtype[i] = dv.getUint8(o + 3); v.mf1[i] = f1; v.mf2[i] = dv.getUint8(o + 5);
      v.mx[i] = dv.getInt16(o + 6, true) * 2; v.my[i] = dv.getInt16(o + 8, true) * 2;
      v.mh[i] = dv.getUint8(o + 10) / 256 * TAU; v.malt[i] = (dv.getUint8(o + 11) / 2.5) ** 2; v.msp[i] = dv.getUint8(o + 12) * 4;
      v.mref[i] = get24(dv, o + 13);
      o += M_BYTES;
      if (f1 & 128) { v.mtx[i] = dv.getInt16(o, true) * 2; v.mty[i] = dv.getInt16(o + 2, true) * 2; o += 4; }
      v.mi.set(v.mid[i], i);
   }
   v.nm = nm;
   const nh = dv.getUint8(o++);
   if (nh > MAX_H) return -1;
   v.hi.clear();
   for (let i = 0; i < nh; i++) {
      v.hid[i] = dv.getUint16(o, true); v.hown[i] = dv.getUint16(o + 2, true); v.hb[i] = dv.getUint8(o + 4);
      v.hx[i] = dv.getInt16(o + 5, true) * 2; v.hy[i] = dv.getInt16(o + 7, true) * 2;
      v.hh[i] = dv.getUint8(o + 9) / 256 * TAU; v.halt[i] = dv.getUint8(o + 10); v.hsp[i] = dv.getUint8(o + 11);
      v.hfuel[i] = dv.getUint8(o + 12) / 255; v.htorp[i] = dv.getUint8(o + 13);
      v.hi.set(v.hid[i], i);
      o += H_BYTES;
   }
   v.nh = nh;
   const na = dv.getUint8(o++);
   if (na > MAX_A) return -1;
   v.ai.clear();
   for (let i = 0; i < na; i++) {
      v.aid[i] = get24(dv, o); v.ax[i] = dv.getInt16(o + 3, true) * 2; v.ay[i] = dv.getInt16(o + 5, true) * 2; v.ah[i] = dv.getUint8(o + 7) / 256 * TAU;
      v.ai.set(v.aid[i], i);
      o += A_BYTES;
   }
   v.na = na;
   return o;
}

// ================================================================ own-ship detail
//   u16 length of what follows · u8 bits (radar 1 | jammer 2 | helo out 4 | team out 8 | seeker
//   warning 16 | rockets 32 | ASW tubes 64) · u8 doctrine | ssmSel << 2 · u24 priority target
//   · u16 s*100 since the last missile launch (65535 = long ago) · u8 nMag · n x (u8 type, u16 rounds)
//   · u8 nCh · n x (u24 target, u24 SAM id, u8 ready in s*10) · u8 nCiws · n x u24 missile id
//   · rockets: u16 ready in s*100 · ASW tubes: u8 rounds, u16 ready in s*100
//   · u16 helicopter ready in s*100 · helo out: u24 id · u8 teams left (255 = not a boat)
//   · team out: u24 id · seeker warning: u8 age s*10, u8 bearing, u24 missile id
function channels(P) {
   if (P.samCh) return P.samCh;
   const out = [];
   for (const s of P.cfg.weapons.sam) for (let i = 0; i < s.ch; i++) out.push({ type: s.type, tgt: null, mid: null, readyT: 0 });
   return P.samCh = out;
}
export function encodeOwnV2(dv, o, s, world) {
   const at = o, now = world.time;
   o += 2;
   const sw = s.seekerWarn && now - s.seekerWarn.t < 3 ? s.seekerWarn : null;
   const rk = s.cfg.weapons && s.cfg.weapons.rockets ? s.rk : null, ltt = s.ltt || null;
   dv.setUint8(o, (s.radarOn ? 1 : 0) | (s.jamming ? 2 : 0) | (s.heloOut != null ? 4 : 0) | (s.teamOut != null ? 8 : 0) | (sw ? 16 : 0) | (rk ? 32 : 0) | (ltt ? 64 : 0));
   dv.setUint8(o + 1, Math.max(0, DOCTRINES.indexOf(s.samDoctrine)) | Math.min(63, s.ssmSel | 0) << 2);
   put24(dv, o + 2, s.samPriority != null ? s.samPriority : 0);
   const age = now - s.lastSsmFire;
   dv.setUint16(o + 5, age >= 0 && age < 600 ? u16c(age, 100) : 65535, true);
   o += 7;
   const mag = s.mag || {};
   let n = 0;
   const nAt = o++;
   for (const k in mag) {
      const i = M_TYPES.indexOf(k);
      if (i < 0 || n >= 16) continue;
      n++;
      dv.setUint8(o, i); dv.setUint16(o + 1, u16c(mag[k]), true); o += 3;
   }
   dv.setUint8(nAt, n);
   const ch = s.cfg.weapons && s.cfg.weapons.sam && s.cfg.weapons.sam.length ? channels(s) : [], nc = Math.min(ch.length, 24);
   dv.setUint8(o++, nc);
   for (let i = 0; i < nc; i++) {
      put24(dv, o, ch[i].tgt != null ? ch[i].tgt : 0); put24(dv, o + 3, ch[i].mid != null ? ch[i].mid : 0);
      dv.setUint8(o + 6, u8c(ch[i].readyT - now, 10));
      o += 7;
   }
   const cw = s.ciwsTgt || [], nw = Math.min(cw.length, 8);
   dv.setUint8(o++, nw);
   for (let i = 0; i < nw; i++) { put24(dv, o, cw[i]); o += 3; }
   if (rk) { dv.setUint16(o, u16c(rk.readyT - now, 100), true); o += 2; }
   if (ltt) { dv.setUint8(o, u8c(ltt.n)); dv.setUint16(o + 1, u16c(ltt.readyT - now, 100), true); o += 3; }
   dv.setUint16(o, u16c((s.heloT || 0) - now, 100), true); o += 2;
   if (s.heloOut != null) { put24(dv, o, s.heloOut); o += 3; }
   dv.setUint8(o++, s.sub && s.teamsLeft != null ? Math.min(254, s.teamsLeft) : 255);
   if (s.teamOut != null) { put24(dv, o, s.teamOut); o += 3; }
   if (sw) { dv.setUint8(o, u8c(now - sw.t, 10)); dv.setUint8(o + 1, u8c(((sw.brg % TAU) + TAU) % TAU, 256 / TAU) & 255); put24(dv, o + 2, sw.id); o += 5; }
   dv.setUint16(at, o - at - 2, true);
   return o;
}
// lead (s): the round trip, as codec.decodeOwn (a launcher reads "ready" that much earlier).
export function decodeOwnV2(dv, o, s, world, lead = 0) {
   try {
      const now = world.time, len = dv.getUint16(o, true), end = o + 2 + len;
      o += 2;
      if (len < 12) return false;
      const bits = dv.getUint8(o), b1 = dv.getUint8(o + 1), pr = get24(dv, o + 2), age = dv.getUint16(o + 5, true);
      o += 7;
      s.radarOn = !!(bits & 1); s.jamming = !!(bits & 2);
      s.samDoctrine = DOCTRINES[b1 & 3] || 'free'; s.ssmSel = b1 >> 2;
      s.samPriority = pr ? pr : null;
      s.lastSsmFire = age === 65535 ? -999 : now - age / 100 - lead;
      const nm = dv.getUint8(o++);
      if (!s.mag) s.mag = {};
      for (let i = 0; i < nm; i++) { const k = M_TYPES[dv.getUint8(o)]; if (k) s.mag[k] = dv.getUint16(o + 1, true); o += 3; }
      const nc = dv.getUint8(o++), ch = nc ? channels(s) : null;
      for (let i = 0; i < nc; i++) {
         const c = ch[i];
         if (c) { const t = get24(dv, o), m = get24(dv, o + 3); c.tgt = t ? t : null; c.mid = m ? m : null; c.readyT = now + Math.max(0, dv.getUint8(o + 6) / 10 - lead); }
         o += 7;
      }
      const nw = dv.getUint8(o++), cw = s.ciwsTgt || (s.ciwsTgt = []);
      cw.length = 0;
      for (let i = 0; i < nw; i++) { cw.push(get24(dv, o)); o += 3; }
      if (bits & 32) {
         const c = s.cfg.weapons.rockets;
         if (c) { const rk = s.rk || (s.rk = { readyT: 0, salvo: c.salvo || c.n, reload: c.reload, range: c.range }); rk.readyT = now + Math.max(0, dv.getUint16(o, true) / 100 - lead); }
         o += 2;
      }
      if (bits & 64) {
         const l = s.ltt || (s.ltt = { n: 0, readyT: 0 });
         l.n = dv.getUint8(o); l.readyT = now + Math.max(0, dv.getUint16(o + 1, true) / 100 - lead);
         o += 3;
      }
      s.heloT = now + Math.max(0, dv.getUint16(o, true) / 100 - lead); o += 2;
      if (bits & 4) { s.heloOut = get24(dv, o); o += 3; } else s.heloOut = null;
      const tl = dv.getUint8(o++);
      if (tl !== 255) s.teamsLeft = tl;
      if (bits & 8) { s.teamOut = get24(dv, o); o += 3; } else s.teamOut = null;
      if (bits & 16) {
         s.seekerWarn = { t: now - dv.getUint8(o) / 10, brg: dv.getUint8(o + 1) / 256 * TAU, id: get24(dv, o + 2), d2: 0 };
         o += 5;
      } else if (s.seekerWarn && now - s.seekerWarn.t > 3) s.seekerWarn = null;
      return o <= end;
   } catch (e) { return false; }
}

// ================================================================ slow state (JSON, on change)
//   sh  ships:  [id, bits (radar 1 | jammer 2 | fire-control track on it 4), esm?: x, y, err, brg, by]
//       own side: every ship; other side: the detected ones, and the ones only ESM hears (bits 8)
//   sn  land sites the client may not have: [id, kind, side, x, y, name, r, maxHp]
//   si  land sites: [id, hp fraction, bits (alive 1 | radar 2 | detected 4 | targetable 8), esm?: x, y, err]
//   tp  task points: [id, x, y, kind, label, workTime, side, siteId, state, teamId]   (own side)
//   tm  special-forces teams: [id, side, ownerId, taskId, x, y, state, men, work left, reason] (own side)
//   bl  blasts: [id, x, y, rDestroyed, rHeavy, rShock, t0, done, label]
//   dc  decoys: [id, side, shipId, x, y, t0]   (own side, or beside a ship that is seen)
// known: { sig: {}, sites: Set } per team (what it was sent last); full: everything, whatever was sent.
const esmRow = (row, e) => { if (e) row.push(Math.round(e.x / 10) * 10, Math.round(e.y / 10) * 10, Math.round(e.err), r3(e.brg), e.by ?? 0); };
export function slowV2(world, side, known, full = false) {
   const p = {};
   p.sh = [];
   for (const s of world.ships) {
      if (!s.alive) continue;
      const own = s.side === side;
      if (!own && !s.detected && !s.esmSeen) continue;
      const seen = own || s.detected;
      const row = [s.id, seen ? (s.radarOn && s.cfg.radar ? 1 : 0) | (s.jamming ? 2 : 0) | (s.targetable ? 4 : 0) : 8];
      if (!own && s.esmSeen) { row[1] |= 8; esmRow(row, s.esmSeen); }
      p.sh.push(row);
   }
   p.si = [];
   const sn = [];
   for (const s of world.sites) {
      const own = s.side === side;
      if (!own && !s.detected && !s.esmSeen && s.alive) continue;
      if (full || !known || !known.sites.has(s.id)) { sn.push([s.id, s.kind, SIDE_CODE[s.side] || 0, r1(s.x), r1(s.y), s.name, s.r, s.maxHp]); if (known) known.sites.add(s.id); }
      const row = [s.id, r3(s.hp / (s.maxHp || 1)), (s.alive ? 1 : 0) | (s.radarOn ? 2 : 0) | (s.detected ? 4 : 0) | (s.targetable ? 8 : 0)];
      if (!own) esmRow(row, s.esmSeen);
      p.si.push(row);
   }
   p.tp = [];
   for (const t of world.taskPoints) if (t.side === side) p.tp.push([t.id, r1(t.x), r1(t.y), t.kind, t.label, t.workTime, SIDE_CODE[t.side] || 0, t.siteId, TASK_STATES.indexOf(t.state), t.teamId]);
   p.tm = [];
   for (const t of world.teams) if (t.side === side) p.tm.push([t.id, SIDE_CODE[t.side] || 0, t.ownerId, t.taskId, Math.round(t.x), Math.round(t.y), TEAM_STATES.indexOf(t.state), t.n, Math.round(t.workT), t.reason || 0]);
   p.bl = world.blasts.map(b => [b.id, r1(b.x), r1(b.y), Math.round(b.r.destroyed), Math.round(b.r.heavy), Math.round(b.r.shock), r3(b.t0), b.state === 'done' ? 1 : 0, b.label]);
   p.dc = [];
   for (const d of world.decoys) if (d.side === side || platformSeen(world, d.shipId, side)) p.dc.push([d.id, SIDE_CODE[d.side] || 0, d.shipId, r1(d.x), r1(d.y), r3(d.t0)]);
   const out = { k: 'v2' };
   let any = false;
   for (const key in p) {
      const sig = JSON.stringify(p[key]);
      if (!full && known && known.sig[key] === sig) continue;
      if (known) known.sig[key] = sig;
      out[key] = p[key]; any = true;
   }
   if (sn.length) { out.sn = sn; any = true; }
   return any ? out : null;
}
export const makeKnown = (world) => ({ sig: {}, sites: new Set(world.sites.map(s => s.id)) });

// ================================================================ replica
// o: { sideOf(hostSide) -> local side, me() -> the local ship, torp(id) -> the replica's torpedo }
export function makeV2Client(world, o) {
   const mBy = new Map(), hBy = new Map();
   let stamp = 0;
   const pos = (id) => {
      const P = platform(world, id);
      if (P) return P.pos;
      const m = mBy.get(id);
      return m && m.alive ? m : null;
   };

   function missiles(A, B, k, F) {
      const out = world.missiles;
      let n = 0;
      for (let i = 0; i < F.nm; i++) {
         const id = F.mid[i], f1 = F.mf1[i], f2 = F.mf2[i];
         let m = mBy.get(id), fresh = false;
         if (!m) {
            fresh = true;
            const side = o.sideOf(f1 & 8 ? 'enemy' : 'player'), type = M_TYPES[F.mtype[i]] || 'rocket';
            m = { id, side, team: side, kind: M_KINDS[f1 & 7] || 'ssm', type, x: 0, y: 0, px: 0, py: 0, sx: F.mx[i], sy: F.my[i], alt: 0, heading: 0, speed: 0,
               ownerId: null, sqId: null, chI: -1, dmg: 0, target: null, tk: 'point', tx: F.mx[i], ty: F.my[i], seekerOn: false, lock: null, lockDecoy: null,
               seduced: false, detected: false, eng: 0, t: 0, alive: true, net: true };
            mBy.set(id, m);
         }
         const ia = A === F ? i : A.mi.get(id), ib = B === F ? i : B.mi.get(id);
         let x = F.mx[i], y = F.my[i], alt = F.malt[i], h = F.mh[i];
         if (ia !== undefined && ib !== undefined && A !== B) {
            x = A.mx[ia] + (B.mx[ib] - A.mx[ia]) * k; y = A.my[ia] + (B.my[ib] - A.my[ia]) * k;
            alt = Math.max(0, A.malt[ia] + (B.malt[ib] - A.malt[ia]) * k); h = lerpA(A.mh[ia], B.mh[ib], Math.min(1, k));
         }
         m.px = fresh ? x : m.x; m.py = fresh ? y : m.y;
         m.x = x; m.y = y; m.alt = alt; m.heading = h; m.speed = F.msp[i];
         m.seekerOn = !!(f1 & 16); m.detected = !!(f1 & 32); m.seduced = !!(f1 & 64);
         m.tk = M_TKS[f2 & 7] || 'point'; m.eng = (f2 >> 3) & 3; m.lockDecoy = f2 & 32 ? -1 : null;
         const ref = F.mref[i];
         m.lock = (f2 & 64) && ref ? ref : null;
         m.target = ref ? ref : null;
         if (f1 & 128) { m.tx = F.mtx[i]; m.ty = F.mty[i]; }
         else if (ref) { const p = pos(ref); if (p) { m.tx = p.x; m.ty = p.y; } }
         m._st = stamp;
         out[n++] = m;
      }
      out.length = n;
      if (mBy.size > n) for (const [id, m] of mBy) if (m._st !== stamp) { m.alive = false; mBy.delete(id); }
   }

   function helos(A, B, k, F) {
      const out = world.helos, me = o.me();
      let n = 0;
      for (let i = 0; i < F.nh; i++) {
         const id = F.hid[i], b = F.hb[i];
         let h = hBy.get(id);
         if (!h) {
            const side = o.sideOf(b & 1 ? 'enemy' : 'player'), ship = world.shipById(F.hown[i]);
            h = { id, side, ownerId: F.hown[i], isHelo: true, kind: 'helo', type: 'helo', model: 'helo', nation: ship ? ship.cfg.hull.nation : null,
               name: (ship && ship.cfg.helo && ship.cfg.helo.name) || 'Bordhubschrauber', n: 1, n0: 1, hp: 1, pos: { x: F.hx[i], y: F.hy[i] }, alt: F.halt[i],
               prev: { x: F.hx[i], y: F.hy[i], alt: F.halt[i], h: F.hh[i] }, heading: F.hh[i], want: F.hh[i], speed: 0, state: 'transit', mode: 'screen',
               goal: { x: F.hx[i], y: F.hy[i] }, fuel: HELO.fuel, fuelMax: HELO.fuel, torps: 0, armed: 0, dipT: 0, dips: 0, alive: true, visible: true, visE: true, eng: 0, net: true };
            hBy.set(id, h);
         }
         const ia = A === F ? i : A.hi.get(id), ib = B === F ? i : B.hi.get(id);
         let x = F.hx[i], y = F.hy[i], alt = F.halt[i], hd = F.hh[i];
         if (ia !== undefined && ib !== undefined && A !== B) {
            x = A.hx[ia] + (B.hx[ib] - A.hx[ia]) * k; y = A.hy[ia] + (B.hy[ib] - A.hy[ia]) * k;
            alt = Math.max(0, A.halt[ia] + (B.halt[ib] - A.halt[ia]) * k); hd = lerpA(A.hh[ia], B.hh[ib], Math.min(1, k));
         }
         h.prev.x = h.pos.x; h.prev.y = h.pos.y; h.prev.alt = h.alt; h.prev.h = h.heading;
         h.pos.x = x; h.pos.y = y; h.alt = alt; h.heading = h.want = hd; h.speed = F.hsp[i];
         h.state = HELO_STATES[(b >> 1) & 3] || 'transit'; h.mode = b & 8 ? 'point' : 'screen';
         h.fuel = F.hfuel[i] * h.fuelMax; h.torps = h.armed = F.htorp[i];
         // seen by the other side (the HUD of its own ship warns); a helo of the other side is in the
         // snapshot only while this side sees it
         if (h.side === 'player') { h.visible = true; h.visE = !!(b & 16); } else { h.visible = true; h.visE = true; }
         const ship = world.shipById(h.ownerId);
         if (ship && ship !== me) ship.heloOut = id;
         h._st = stamp;
         out[n++] = h;
      }
      out.length = n;
      if (hBy.size > n) for (const [id, h] of hBy) if (h._st !== stamp) {
         h.alive = false; h.n = 0; hBy.delete(id);
         const ship = world.shipById(h.ownerId);
         if (ship && ship !== me && ship.heloOut === id) ship.heloOut = null;
      }
   }

   function aswTorps(A, B, k, F) {
      for (let i = 0; i < F.na; i++) {
         const id = F.aid[i], t = o.torp(id);
         if (!t) continue;
         const ia = A === F ? i : A.ai.get(id), ib = B === F ? i : B.ai.get(id);
         let x = F.ax[i], y = F.ay[i], h = F.ah[i];
         if (ia !== undefined && ib !== undefined && A !== B) { x = A.ax[ia] + (B.ax[ib] - A.ax[ia]) * k; y = A.ay[ia] + (B.ay[ib] - A.ay[ia]) * k; h = lerpA(A.ah[ia], B.ah[ib], Math.min(1, k)); }
         t.pos.x = x; t.pos.y = y; t.heading = t.dir = h; t.asw = true;
      }
   }

   // every frame, with the two snapshots the replica interpolates between (F: the one whose lists count)
   function apply(A, B, k, F) {
      stamp++;
      missiles(A.v2, B.v2, k, F.v2);
      helos(A.v2, B.v2, k, F.v2);
      aswTorps(A.v2, B.v2, k, F.v2);
      const now = world.time;
      for (const b of world.blasts) if (b.state === 'done') b.age = Math.max(0, now - b.t0);
   }

   const fit = (list, rows, make, set) => {
      const by = new Map(list.map(x => [x.id, x]));
      list.length = 0;
      for (const r of rows) {
         if (!Array.isArray(r) || !fin(r[0])) continue;
         let x = by.get(r[0]);
         if (!x) x = make(r);
         set(x, r);
         list.push(x);
      }
   };
   const esm = (r, i) => (fin(r[i]) && fin(r[i + 1]) ? { x: r[i], y: r[i + 1], t: world.time, err: +r[i + 2] || 0, brg: +r[i + 3] || 0, by: r[i + 4] || 0 } : null);

   // the slow state (sync k:'v2', and inside a resync)
   function slow(m) {
      if (!m || typeof m !== 'object') return;
      const me = o.me();
      if (Array.isArray(m.sh)) {
         for (const s of world.ships) { if (s.side !== 'player') { s.targetable = false; s.esmSeen = null; } }
         for (const r of m.sh) {
            const s = Array.isArray(r) ? world.shipById(r[0]) : null;
            if (!s || s.isSite) continue;
            const b = r[1] | 0;
            if (s !== me) { s.radarOn = !!(b & 1); s.jamming = !!(b & 2); }
            s.targetable = !!(b & 4);
            if (s.side !== 'player') { s.esmSeen = b & 8 ? esm(r, 2) : null; if ((b & 8) && !(b & 7) && !s.detected) s.radarOn = true; }
         }
      }
      if (Array.isArray(m.sn)) for (const r of m.sn) {
         if (!Array.isArray(r) || !fin(r[0]) || siteById(world, r[0]) || !fin(r[3]) || !fin(r[4])) continue;
         try {
            const s = addSite(world, r[1], o.sideOf(SIDES[r[2]] || 'enemy'), { x: r[3], y: r[4] }, { id: r[0], inland: true, name: String(r[5] || ''), r: fin(r[6]) ? r[6] : undefined });
            if (fin(r[7])) { s.maxHp = s.maxHP = s.hp = r[7]; }
         } catch (e) { /* a kind this build does not know */ }
      }
      // a site of the other side that is not in the list is neither seen nor heard any more
      if (Array.isArray(m.si)) for (const s of world.sites) if (s.side !== 'player' && s.alive) { s.detected = false; s.targetable = false; s.esmSeen = null; }
      if (Array.isArray(m.si)) for (const r of m.si) {
         const s = Array.isArray(r) ? siteById(world, r[0]) : null;
         if (!s) continue;
         const b = r[2] | 0;
         s.hp = (+r[1] || 0) * s.maxHp; s.alive = !!(b & 1); s.radarOn = !!(b & 2); s.detected = !!(b & 4); s.targetable = !!(b & 8);
         if (!s.alive) { s.hp = 0; s.radarOn = false; }
         s.esmSeen = s.side !== 'player' ? esm(r, 3) : null;
      }
      if (Array.isArray(m.tp)) fit(world.taskPoints, m.tp,
         (r) => ({ id: r[0], x: 0, y: 0, pos: { x: 0, y: 0 }, kind: 'sabotage', label: '', workTime: SEAL.workTime, side: 'player', siteId: null, state: 'open', teamId: null }),
         (p, r) => {
            p.x = p.pos.x = +r[1] || 0; p.y = p.pos.y = +r[2] || 0; p.kind = String(r[3] || 'sabotage'); p.label = String(r[4] || ''); p.workTime = +r[5] || 0;
            p.side = o.sideOf(SIDES[r[6]] || 'player'); p.siteId = fin(r[7]) ? r[7] : null; p.state = TASK_STATES[r[8]] || 'open'; p.teamId = fin(r[9]) ? r[9] : null;
         });
      if (Array.isArray(m.tm)) fit(world.teams, m.tm,
         (r) => ({ id: r[0], side: 'player', ownerId: null, taskId: null, x: +r[4] || 0, y: +r[5] || 0, pos: { x: +r[4] || 0, y: +r[5] || 0 }, heading: 0, speed: SEAL.speed, n: SEAL.men,
            state: 'out', t: 0, workT: 0, workTime: SEAL.workTime, seenT: 0, reason: null }),
         (t, r) => {
            const x = +r[4] || 0, y = +r[5] || 0, st = TEAM_STATES[r[6]] || 'out';
            if (Math.abs(x - t.x) + Math.abs(y - t.y) > 0.5) t.heading = Math.atan2(y - t.y, x - t.x);
            if (st !== t.state) t.t = 0;
            t.side = o.sideOf(SIDES[r[1]] || 'player'); t.ownerId = r[2]; t.taskId = r[3]; t.x = t.pos.x = x; t.y = t.pos.y = y;
            t.state = st; t.n = +r[7] || 0; t.workT = +r[8] || 0; t.reason = r[9] || null;
            const sub = world.shipById(t.ownerId);
            if (sub && sub !== me) sub.teamOut = st === 'recovered' || st === 'lost' ? null : t.id;
         });
      if (Array.isArray(m.bl)) fit(world.blasts, m.bl,
         (r) => ({ id: r[0], x: 0, y: 0, pos: { x: 0, y: 0 }, r: { destroyed: 0, heavy: 0, shock: 0 }, t0: 0, state: 'armed', age: 0, label: '', hit: null }),
         (b, r) => {
            b.x = b.pos.x = +r[1] || 0; b.y = b.pos.y = +r[2] || 0; b.r.destroyed = +r[3] || 0; b.r.heavy = +r[4] || 0; b.r.shock = +r[5] || 0;
            b.t0 = +r[6] || 0; b.state = r[7] ? 'done' : 'armed'; b.label = String(r[8] || 'Detonation');
            b.age = b.state === 'done' ? Math.max(0, world.time - b.t0) : 0;
         });
      if (Array.isArray(m.dc)) fit(world.decoys, m.dc,
         (r) => ({ id: r[0], side: 'player', shipId: null, x: 0, y: 0, t0: 0, n: 0 }),
         (d, r) => { d.side = o.sideOf(SIDES[r[1]] || 'player'); d.shipId = r[2]; d.x = +r[3] || 0; d.y = +r[4] || 0; d.t0 = +r[5] || 0; });
   }

   // another host took over: its snapshots bring everything again
   function reset() {
      for (const m of mBy.values()) m.alive = false;
      mBy.clear(); world.missiles.length = 0;
      for (const h of hBy.values()) { h.alive = false; h.n = 0; }
      hBy.clear(); world.helos.length = 0;
   }
   return { apply, slow, reset };
}

// ================================================================ PvP: who hears of an event
// Returns the item a team gets, null for nothing, undefined when the general rules (host.js) decide.
const OWN_ONLY = { doctrine: 1, radar: 1, heloLaunch: 1, heloOrder: 1, heloDip: 1, heloLanded: 1, teamOut: 1, teamWork: 1, teamDone: 1, teamRecovered: 1, teamLost: 1,
   aswTorp: 1, seduced: 1, samMiss: 1, missileLost: 1 };
const LAUNCH = { ssmLaunch: 1, cruiseLaunch: 1, samLaunch: 1, aamLaunch: 1, rockets: 1, decoy: 1 };
export function v2EventFor(world, it, S) {
   const type = it[1], d = it[2] || {};
   if (type === 'vampire') return d.side !== S ? null : S === 'player' ? it : ['e', type, { ...d, side: 'player' }];
   if (type === 'intercept') { const P = platform(world, d.srcId); return P ? (P.side === S ? it : null) : undefined; }
   if (type === 'heloLost') { const P = platform(world, d.dstId), K = platform(world, d.srcId); return (P && P.side === S) || (K && K.side === S) ? it : null; }
   if (type === 'sonar' && d.helo) { const P = platform(world, d.srcId); return P && P.side === S ? it : null; }
   if (OWN_ONLY[type]) { const P = platform(world, d.srcId); return P && P.side === S ? it : null; }
   if (LAUNCH[type]) {
      if (d.sqId != null) return undefined;         // launched by aircraft: seen with the squadron
      return platformSeen(world, d.srcId, S) ? it : null;
   }
   return undefined;
}

// ================================================================ host migration (full fidelity)
const cp = (v, d = 3) => {
   if (typeof v === 'number') return Number.isFinite(v) ? r3(v) : null;
   if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
   if (typeof v !== 'object' || d <= 0) return null;
   if (Array.isArray(v)) return v.map(x => cp(x, d - 1));
   const out = {};
   for (const k in v) if (k[0] !== '_') out[k] = cp(v[k], d - 1);
   return out;
};
const rows = (list) => {
   if (!list.length) return null;
   const k = Object.keys(list[0]).filter(key => key[0] !== '_');
   return { k, r: list.map(x => k.map(key => cp(x[key]))) };
};
const unrows = (p, flip) => {
   if (!p || !Array.isArray(p.k) || !Array.isArray(p.r)) return [];
   return p.r.map(r => {
      const x = {};
      p.k.forEach((key, i) => { x[key] = r[i]; });
      if (flip) { if (x.side) x.side = flipS(x.side, true); if (x.team === 'player' || x.team === 'enemy') x.team = flipS(x.team, true); if (x.owner) x.owner = flipS(x.owner, true); }
      if ('pos' in x && 'x' in x) x.pos = { x: x.x, y: x.y };
      return x;
   });
};
const SITE_KEYS = ['hp', 'alive', 'radarOn', 'mag', 'samCh', 'ciwsTgt', 'nextT', 'salvoLeft', 'salvoTgt', 'lastSsmFire', 'samDoctrine', 'samPriority', 'air', 'detected', 'targetable'];
export function packV2(world) {
   return {
      ms: rows(world.missiles.filter(m => m.alive)), hl: rows(world.helos.filter(h => h.alive)), tm: rows(world.teams), tp: rows(world.taskPoints),
      bl: rows(world.blasts), dc: rows(world.decoys),
      sn: world.sites.map(s => [s.id, s.kind, SIDE_CODE[s.side] || 0, r1(s.x), r1(s.y), s.name, s.r, s.maxHp]),
      si: world.sites.map(s => [s.id, ...SITE_KEYS.map(k => cp(s[k]))]),
      at: world.torpedoes.filter(t => t.asw && t.alive).map(t => [t.id, t.homeId, r1(t.tx), r1(t.ty), r3(t.speed), t.speedKn, t.arm, t.locked ? 1 : 0]),
   };
}
// The missiles launched since the last full state, in full (host.js sends them to the successor in
// the tick they start: a host that vanishes leaves a full state up to a second old).
export function packMissiles(list) { return rows(list); }
// v: packV2 of the old host; flip: this World sails the other team as 'player'; dtm: the state's age (s)
// mids: the missiles the successor's newest snapshot carried; one it should have seen (its own, or
// a tracked one) and that is missing there was shot down or hit in the meantime
// late: { tick: of that snapshot, list: [{ t, tm, ms: packMissiles }] } the launches after the full state
export function restoreV2(world, v, flip = false, dtm = 0, mids = null, late = null) {
   if (!v || typeof v !== 'object') return;
   const sideOf = (s) => flipS(s, flip);
   world.missiles = unrows(v.ms, flip);
   const age = new Map(), young = new Set(), added = [];
   for (const m of world.missiles) age.set(m.id, dtm);
   if (late && Array.isArray(late.list)) for (const e of late.list) {
      if (!e || !(e.t >= 0)) continue;
      for (const m of unrows(e.ms, flip)) {
         if (typeof m.id !== 'number' || age.has(m.id) || !m.alive || !Number.isFinite(m.x + m.y + m.heading + m.speed)) continue;
         age.set(m.id, Math.max(0, late.tick * (1 / 60) - (e.tm || 0)));
         if (e.t > late.tick) young.add(m.id);      // younger than the newest snapshot: it cannot be in there
         world.missiles.push(m); added.push(m);
      }
   }
   if (mids) world.missiles = world.missiles.filter(m => mids.has(m.id) || young.has(m.id) || !(m.side === 'player' || m.detected));
   for (const m of world.missiles) { const d = age.get(m.id) || 0; m.x += Math.cos(m.heading) * m.speed * d; m.y += Math.sin(m.heading) * m.speed * d; m.px = m.x; m.py = m.y; }
   world.helos = unrows(v.hl, flip);
   if (flip) for (const h of world.helos) { const a = h.visible; h.visible = h.visE; h.visE = a; }
   world.teams = unrows(v.tm, flip);
   world.taskPoints = unrows(v.tp, flip);
   world.blasts = unrows(v.bl, false);
   world.decoys = unrows(v.dc, flip);
   for (const r of v.sn || []) {
      if (!Array.isArray(r) || siteById(world, r[0])) continue;
      try { const s = addSite(world, r[1], sideOf(SIDES[r[2]] || 'enemy'), { x: r[3], y: r[4] }, { id: r[0], inland: true, name: r[5], r: r[6] }); s.maxHp = s.maxHP = r[7]; } catch (e) { /* unknown kind */ }
   }
   for (const r of v.si || []) {
      const s = Array.isArray(r) ? siteById(world, r[0]) : null;
      if (!s) continue;
      SITE_KEYS.forEach((k, i) => { const x = r[1 + i]; if (x !== null || k === 'samPriority' || k === 'salvoTgt') s[k] = x; });
      if (!s.samCh) delete s.samCh;
      s.esmSeen = null;
   }
   // the launcher's magazine in the full state is the one from before these launches
   for (const m of added) {
      if (m.sqId != null || m.ownerId == null) continue;
      const P = world.shipById(m.ownerId) || siteById(world, m.ownerId);
      if (P && P.mag && P.mag[m.type] > 0) P.mag[m.type]--;
   }
   const at = new Map((v.at || []).map(r => [r[0], r]));
   for (const t of world.torpedoes) {
      const r = at.get(t.id);
      if (!r) continue;
      t.asw = true; t.homeId = r[1]; t.tx = r[2]; t.ty = r[3]; t.speed = r[4]; t.speedKn = r[5]; t.arm = r[6]; t.locked = !!r[7];
   }
   world.torpedoes = world.torpedoes.filter(t => t.speed > 0);
}
