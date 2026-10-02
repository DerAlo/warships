// game3d/net/replica.js — the client side of a net game. The client's World is built from the
// same start data as the host's (setup.js) but never simulates ships and never decides damage:
// world.update() is replaced by step() below, which
//   - keeps a render clock ~100 ms behind the host (more when the connection jitters) and
//     interpolates every ship between the two snapshots around it
//   - replays the host's recorded events, effects, smoke, log lines and ship arrivals at the
//     moment the render clock reaches them
//   - flies shells and torpedoes locally from their spawn data (same ballistics as combat.js)
//   - predicts the own ship's controls: telegraph / rudder read-outs, turret traverse, firing
//     (muzzle flash, reload, shells), consumables, depth orders. The hull itself is NOT
//     predicted; it follows the host like every other ship.
// All side-related decoding goes through codec.localSide(). No DOM in here.
import { WORLD, TUNE } from '../config.js';
import { flightTime, horizDist, apexHeight, fallAngle, arcAlt } from '../combat.js';
import { execAction } from './command.js';
import {
   SIM_DT, MAX_TURRETS, F_ALIVE, F_SINKING, F_DETECTED, F_SMOKE, F_BLOOM, F_GROUNDED,
   makeSnap, decodeSnap, decodeOwn, snapTick, depthMetres, localSide,
} from './codec.js';

const RING = 32;                    // snapshots kept (1.6 s)
const MIN_DELAY = 0.1, MAX_DELAY = 0.3;
const EXTRAPOLATE = 0.25;           // s a ship may run on past the newest snapshot
const PRED_MAX = 1.2;               // s a predicted shell waits for the host's confirmation
const SILENCE = 5;                  // s without a snapshot = connection to the host lost
const GAP_WAIT = 2;                 // s an event batch may be missing before it is skipped
const SIDES = [null, 'player', 'enemy'];
const TAU = Math.PI * 2;
const KN = WORLD.KN_TO_MS;
// events the client already raised itself when it predicted the action
const PREDICTED = { ammo: 1, consumable: 1, subInfo: 1, dcDrop: 1, depth: 1 };
const HIT_SHAKE = { citadel: 1.4, pen: 0.5, overpen: 0.5, ricochet: 0.5, shatter: 0.5, he: 0.5, sec: 0.5, torp: 1.6, dc: 1, ram: 1.2 };

const angD = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return d; };
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
function fitN(list, n) {
   while (list.length > n) list.pop();
   while (list.length < n) list.push({ zone: list.length, t: 30, dur: 30, srcId: null, mult: 1 });
}

// o: { send(channel, data), now() -> seconds, onLost(why) }
export function makeReplica(world, o) {
   const me = world.player;
   const byId = world._byId;
   const snaps = [];                 // ascending by tick
   const spare = [];
   for (let i = 0; i < RING; i++) spare.push(makeSnap());
   let newestTick = -1, synced = false, rt = 0, off = 0, jit = 0, delay = MIN_DELAY, lastSnapAt = o.now();
   let rtt = 0, lead = 0, lastEcho = -1;
   const sentAt = new Float64Array(64), sentSeq = new Int32Array(64).fill(-1);
   // event batches
   const batches = new Map();
   let nextBatch = 0, gapSince = 0;
   // commands
   const ctl = { telegraph: 0, rudder: 0, ax: null, ay: null, lock: null };
   let seq = 0, dirty = true, sinceSend = 99, actBase = 0, actsNew = false, ack = 0;
   const unacked = [];
   // shells / torpedoes
   const shellByHost = new Map(), torpByHost = new Map(), predQ = [];
   let pendingEnd = null, endAt = 0, ended = false, lost = false, lastSt = -1;
   const _p = { x: 0, y: 0 };

   world._nextId = Math.max(world._nextId, 1 << 24);   // local ids (predicted shells) stay clear of host ids
   world.net = null;                                   // nothing on a replica walks the humans list

   // ---------------------------------------------------------------- prediction
   // Runs the action on the local copy of the own ship: instant feedback (muzzle flash, reload,
   // sound, shells in the air). It is sent only if it did something here; the host decides.
   world.addShell = (s) => {
      s.pred = true; s.t0 = rt; s.lead = 0; s.hid = 0;
      predQ.push(s);
      if (world.shells.length < TUNE.maxShells) world.shells.push(s);
   };
   world.addTorpedo = () => { /* torpedoes appear when the host has launched them */ };

   function act(a) {
      if (!me || !me.alive || ended || lost) return 0;
      if (a[0] === 'f') { a[1] = Math.round(a[1] * 10) / 10; a[2] = Math.round(a[2] * 10) / 10; }
      const r = execAction(me, world, a);
      if (r) { unacked.push(a); actsNew = true; }
      return r;
   }

   function control(c) {
      const ap = c.aim;
      const ax = ap ? Math.round(ap.x * 10) / 10 : null, ay = ap ? Math.round(ap.y * 10) / 10 : null;
      const lock = c.lock == null ? null : c.lock;
      if (c.telegraph !== ctl.telegraph || c.rudder !== ctl.rudder || ax !== ctl.ax || ay !== ctl.ay || lock !== ctl.lock) {
         ctl.telegraph = c.telegraph; ctl.rudder = c.rudder; ctl.ax = ax; ctl.ay = ay; ctl.lock = lock;
         dirty = true;
      }
   }

   // at most 30 messages a second while something changes, 10 a second otherwise
   function sendCmd() {
      sinceSend++;
      if (!(((dirty || actsNew) && sinceSend >= 2) || sinceSend >= 6)) return;
      while (unacked.length && actBase < ack) { unacked.shift(); actBase++; }
      o.send('cmd', [seq, ctl.telegraph, ctl.rudder, ctl.ax, ctl.ay, ctl.lock, actBase, unacked]);
      sentAt[seq & 63] = o.now(); sentSeq[seq & 63] = seq & 0xffff;
      seq++; sinceSend = 0; dirty = false; actsNew = false;
   }

   // ---------------------------------------------------------------- snapshots in
   function onSnap(data) {
      if (!(data instanceof Uint8Array) || lost) return;
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const tick = snapTick(dv);
      if (tick <= newestTick) return;                  // late or duplicate: drop
      const s = spare.pop() || snaps.shift();
      if (!decodeSnap(dv, s)) { spare.push(s); return; }
      snaps.push(s);
      newestTick = tick;
      const now = o.now();
      lastSnapAt = now;
      // clock offset host -> local: follow early arrivals quickly, late ones slowly
      const d = s.t - now;
      if (!synced) { synced = true; off = d; rt = Math.max(0, now + off - delay); }
      else {
         off += (d - off) * (d > off ? 0.2 : 0.02);
         jit += (Math.abs(d - off) - jit) * 0.05;
         const want = Math.min(MAX_DELAY, Math.max(MIN_DELAY, 0.06 + 2.5 * jit));
         delay += (want - delay) * 0.05;
      }
      // round trip from the echoed command sequence number (minus the mean wait for a snapshot)
      if (s.echo !== lastEcho) {
         lastEcho = s.echo;
         const i = s.echo & 63;
         if (sentSeq[i] === s.echo) {
            const smp = Math.max(0, now - sentAt[i] - 0.025);
            rtt = rtt ? rtt + (smp - rtt) * 0.1 : smp;
            lead = Math.min(0.5, rtt);
         }
      }
      ack = s.ack;
      // own-ship detail: applied from the newest snapshot, but never over an action still in flight
      if (me && s.ack >= actBase + unacked.length) decodeOwn(dv, s.own, me, world, lead);
   }

   function onEvt(d) {
      if (lost || !Array.isArray(d) || !fin(d[0]) || !fin(d[1]) || !Array.isArray(d[2])) return;
      if (d[0] >= nextBatch) batches.set(d[0], d);
   }

   function onSync(m) {
      if (lost || !m || typeof m !== 'object') return;
      if (m.k === 'st') applyState(m);
      else if (m.k === 'me') { if (m.stats && typeof m.stats === 'object') Object.assign(world.stats, m.stats); }
      else if (m.k === 'own') world.log(null, String(m.text || ''), m.type || 'info');
      else if (m.k === 'end') { if (!pendingEnd && !ended) { pendingEnd = m; endAt = o.now() + 1; } }
      else if (m.k === 'abort') hostLost('abort');
   }

   function hostLost(why) {
      if (lost || ended || pendingEnd) return;
      lost = true;
      o.onLost(why);
   }

   // ---------------------------------------------------------------- slow state
   function applyState(m) {
      if (!fin(m.t) || m.t <= lastSt) return;
      lastSt = m.t;
      if (world.phase === 'playing') world.timeLeft = fin(m.tl) ? m.tl : null;
      if (fin(m.kc)) world.killCount = m.kc;
      const sc = m.sc;
      if (Array.isArray(sc)) {
         // (PvP: a client on the other side swaps the two numbers here)
         const w = world.score || (world.score = { kind: sc[3], player: 0, enemy: 0, target: 0 });
         w.kind = sc[3]; w.player = sc[0]; w.enemy = sc[1]; w.target = sc[2];
      } else world.score = null;
      if (Array.isArray(m.cp)) for (let i = 0; i < m.cp.length && i < world.caps.length; i++) {
         const c = m.cp[i], cap = world.caps[i];
         cap.owner = localSide(SIDES[c[0]] || null); cap.capper = localSide(SIDES[c[1]] || null);
         cap.progress = c[2]; cap.contested = !!c[3];
      }
      const e = m.env, env = world.env;
      if (Array.isArray(e)) {
         env.weather = e[0]; env.frontK = e[1];
         if (e[2]) { const f = env.front || (env.front = { at: 0, dur: 1, announced: true, text: '' }); f.to = e[2]; f.from = e[3]; }
         env.visibility = e[4]; env.seaState = e[5]; env.wind = e[6]; env.spotCap = e[7] == null ? Infinity : e[7];
      }
      if (world.mission) {
         if (Array.isArray(m.obj)) world.mission.objectives = m.obj;
         if (Array.isArray(m.zn)) world.mission.zones = m.zn;
      }
      if (Array.isArray(m.sn)) {
         world.hasSubs = true;
         for (const s of world.ships) s._sn = false;
         for (const c of m.sn) {
            const s = byId.get(c[0]);
            if (!s) continue;
            const q = s.sonarSeen || (s.sonarSeen = { x: 0, y: 0, t: 0, by: 0, evT: 0 });
            q.x = c[1]; q.y = c[2]; q.t = world.time - c[3]; s._sn = true;
         }
         for (const s of world.ships) if (!s._sn) s.sonarSeen = null;
      }
      if (Array.isArray(m.ro)) for (const r of m.ro) { const s = byId.get(r[0]); if (s) { s.dmgDealt = r[1]; s.kills = r[2]; } }
   }

   function applyEnd(m) {
      ended = true; pendingEnd = null;
      world.phase = m.victory ? 'won' : 'lost';
      if (m.stats && typeof m.stats === 'object') Object.assign(world.stats, m.stats);
      world.result = { victory: !!m.victory, reason: String(m.reason || ''), xp: m.xp || 0, credits: m.credits || 0, rewards: m.rewards || null,
         time: fin(m.time) ? m.time : world.time, stats: { ...world.stats } };
      if (Array.isArray(m.ro)) for (const r of m.ro) {
         const s = byId.get(r[0]);
         if (!s) continue;
         s.dmgDealt = r[1]; s.kills = r[2];
         if (!r[3] && s.alive) { s.alive = false; if (r[5]) s.escaped = r[5]; else s.hp = 0; }
         else if (r[3]) s.hp = r[4] * s.maxHP;
      }
      if (world.mission && Array.isArray(m.obj)) world.mission.objectives = m.obj;
   }

   // ---------------------------------------------------------------- recorded items
   function gunOf(owner, kind) { return kind === 0 ? owner.cfg.main : owner.cfg.sec || owner.cfg.main; }

   // it: ['s', id, ownerId, kind, ammo, sx, sy, tx, ty, tick]
   function spawnShell(it) {
      const owner = byId.get(it[2]);
      if (!owner) return;
      const gun = gunOf(owner, it[3]);
      const sx = it[5], sy = it[6], tx = it[7], ty = it[8];
      const R = Math.max(30, Math.hypot(tx - sx, ty - sy));
      const t0 = (it[9] - 1) * SIM_DT;
      if (rt - t0 > flightTime(gun, R) + 0.5) return;   // long over (the tab was in the background)
      let s = null;
      if (owner === me && it[3] === 0) {
         // the host's version of a shell this client predicted: keep the object, take the trajectory
         while (predQ.length && !s) { const c = predQ.shift(); if (c.alive && c.pred) s = c; }
      }
      if (s) { s.lead = Math.max(0, t0 - s.t0); s.pred = false; }
      else {
         if (world.shells.length >= TUNE.maxShells) return;
         s = { id: world._nextId++, pos: { x: sx, y: sy }, start: { x: 0, y: 0 }, target: { x: 0, y: 0 }, aimPoint: null, lead: 0, pred: false,
            alt: 0, u: 0, age: 0, alive: true, arc: 0, vel: { x: 0, y: 0 }, dmg: 0, hePen: 0, fire: 0 };
         world.shells.push(s);
      }
      const dirX = (tx - sx) / R, dirY = (ty - sy) / R, dur = flightTime(gun, R);
      s.hid = it[1]; s.t0 = t0;
      s.start.x = sx; s.start.y = sy; s.target.x = tx; s.target.y = ty; s.aimPoint = s.target;
      s.dirX = dirX; s.dirY = dirY; s.range = R; s.dur = dur; s.arcDur = dur;
      s.H = apexHeight(gun, R); s.h0 = (owner.cfg.hull.deckH || 10) + 3; s.fall = fallAngle(gun, R);
      s.side = owner.side; s.owner = owner.side; s.ownerId = owner.id; s.shooter = owner;
      s.caliber = gun.caliber; s.ammo = it[4] ? 'AP' : 'HE'; s.kind = it[3] === 0 ? 'main' : 'sec'; s.gun = gun;
      s.vel.x = dirX * gun.vShell; s.vel.y = dirY * gun.vShell; s.dir = Math.atan2(dirY, dirX);
      shellByHost.set(s.hid, s);
   }

   // it: ['T', id, ownerId, x, y, heading, tick]
   function spawnTorp(it) {
      const owner = byId.get(it[2]);
      const tc = owner && owner.cfg.torp;
      if (!tc) return;
      const t = {
         id: it[1], pos: { x: it[3], y: it[4] }, start: { x: it[3], y: it[4] }, heading: it[5], dir: it[5],
         speed: tc.speed, speedKn: tc.speedKn, side: owner.side, owner: owner.side, ownerId: owner.id, dmg: 0, flood: 0,
         range: tc.range, detect: tc.detect, traveled: 0, age: 0, alive: true, spotted: owner.side === 'player', visibleToOpp: false,
         t0: (it[6] - 1) * SIM_DT, cx: Math.cos(it[5]), cy: Math.sin(it[5]),
      };
      world.torpedoes.push(t);
      torpByHost.set(t.id, t);
   }

   // it: ['n', id, cls, side, x, y, heading, { name, speedKn, maxHP, telegraph, depth, color, nation }]
   function spawnShip(it) {
      if (byId.has(it[1])) return;
      const q = it[7] || {};
      const keep = world._nextId;
      world._nextId = it[1];
      try {
         _p.x = it[4]; _p.y = it[5];
         const s = world.spawn(it[2], localSide(it[3]), _p, it[6], { name: q.name, speedKn: q.speedKn, telegraph: q.telegraph, depth: q.depth, color: q.color, nation: q.nation });
         if (fin(q.maxHP)) { s.maxHP = q.maxHP; s.hp = q.maxHP; }
      } catch (e) { /* unknown class: the ship stays invisible, the battle goes on */ }
      world._nextId = keep;
   }

   function applyItem(it) {
      switch (it[0]) {
         case 'e': {
            const d = it[2] || {};
            if (me && d.srcId === me.id && PREDICTED[it[1]] && !d.forced) break;
            world.pushEvent(it[1], d);
            if (me) {
               if (d.dstId === me.id && d.srcId != null && HIT_SHAKE[it[1]]) world.shakeAdd(HIT_SHAKE[it[1]]);
               else if (it[1] === 'ram' && d.srcId === me.id) world.shakeAdd(1.2);
               else if (it[1] === 'sunk' && d.dstId === me.id) world.shakeAdd(2);
            }
            break;
         }
         case 's': spawnShell(it); break;
         case 'x': { const s = shellByHost.get(it[1]); if (s) { s.alive = false; shellByHost.delete(it[1]); } break; }
         case 'T': spawnTorp(it); break;
         case 'X': { const t = torpByHost.get(it[1]); if (t) { t.alive = false; torpByHost.delete(it[1]); } break; }
         case 'v': { const t = torpByHost.get(it[1]); if (t) { t.visibleToOpp = !!it[2]; t.spotted = t.side === 'player' || !!it[2]; } break; }
         case 'f': {
            const x = it[6] || undefined;
            // own main guns and tubes: the flash was shown when the action was predicted
            if (me && x && x.shipId === me.id && ((it[1] === 'muzzle' && !x.sec) || it[1] === 'torpLaunch')) break;
            _p.x = it[2]; _p.y = it[3];
            world.addEffect(it[1], _p, it[4], it[5], x);
            break;
         }
         case 'k': _p.x = it[1]; _p.y = it[2]; world.addSmoke({ c: _p, r: it[3], maxR: it[4] || undefined, life: it[5], side: localSide(it[6]), ownerId: it[7] }); break;
         case 'l': world.log(null, String(it[1]), it[2]); break;
         case 'n': spawnShip(it); break;
         case 'r': { const s = byId.get(it[1]); if (s) world.removeShip(s, it[2] || 'escaped'); break; }
      }
   }

   function applyEvents(now) {
      for (;;) {
         const b = batches.get(nextBatch);
         if (!b) {
            if (!batches.size) { gapSince = 0; return; }
            // a batch went missing (cannot happen on a reliable link; be robust anyway)
            if (!gapSince) { gapSince = now; return; }
            if (now - gapSince < GAP_WAIT) return;
            let min = Infinity;
            for (const k of batches.keys()) if (k < min) min = k;
            nextBatch = min; gapSince = 0;
            continue;
         }
         gapSince = 0;
         if (b[1] * SIM_DT > rt) return;
         batches.delete(nextBatch++);
         const items = b[2];
         for (let i = 0; i < items.length; i++) { const it = items[i]; if (Array.isArray(it)) applyItem(it); }
      }
   }

   // ---------------------------------------------------------------- ships
   function indexOf(S, id, hint) {
      if (hint < S.n && S.id[hint] === id) return hint;
      for (let i = 0; i < S.n; i++) if (S.id[i] === id) return i;
      return -1;
   }

   // A, B: snapshots to blend (k may exceed 1 = extrapolation); F: where the discrete state comes from
   function applyShips(A, B, k, F, dt) {
      const span = B.t - A.t;
      for (let i = 0; i < F.n; i++) {
         const id = F.id[i];
         const s = byId.get(id);
         if (!s) continue;
         s._seen = F.tick;
         let ia = indexOf(A, id, i), ib = indexOf(B, id, i);
         const SA = ia < 0 ? B : A, SB = ib < 0 ? A : B;
         if (ia < 0) ia = ib; if (ib < 0) ib = ia;
         const dh = angD(SA.hd[ia], SB.hd[ib]);
         let x = SA.x[ia] + (SB.x[ib] - SA.x[ia]) * k, y = SA.y[ia] + (SB.y[ib] - SA.y[ia]) * k;
         const kk = k > 1 ? 1 : k;      // only position and heading run on past the newest snapshot
         const hd = (((SA.hd[ia] + dh * k) % TAU) + TAU) % TAU;
         const sp = SA.sp[ia] + (SB.sp[ib] - SA.sp[ia]) * kk;
         s.pos.x = x; s.pos.y = y; s.heading = hd; s.speed = sp; s.speedKn = sp / KN;
         s.vel.x = Math.cos(hd) * sp; s.vel.y = Math.sin(hd) * sp;
         s.omega = span > 0 && SA !== SB ? dh / span : 0;
         s.rudder = SA.rud[ia] + (SB.rud[ib] - SA.rud[ia]) * kk;
         s.heel = SA.heel[ia] + (SB.heel[ib] - SA.heel[ia]) * kk;
         s.sinkT = SA.sink[ia] + (SB.sink[ib] - SA.sink[ia]) * kk;
         const f1 = F.f1[i], f2 = F.f2[i];
         if (s.sub) {
            const df = SA.dep[ia] + (SB.dep[ib] - SA.dep[ia]) * kk;
            s.depthF = df; s.depth = f2 & 3; s.depthM = depthMetres(s.cfg, df);
         }
         // health
         if (s.hitFlash > 0) s.hitFlash = Math.max(0, s.hitFlash - dt * 2.5);
         if (f1 & F_ALIVE) {
            const hp = F.hp[i] * s.maxHP;
            if (hp < s.hp - 0.5) { s.hitFlash = 1; s.lastHitT = rt; }
            s.hp = hp;
         } else if (s.alive) { s.alive = false; s.hp = 0; s.floods.length = 0; }
         if (!s.alive) s.sinking = !!(f1 & F_SINKING);
         // spotting
         const det = !!(f1 & F_DETECTED);
         s.detected = det;
         s.spotted = localSide(s.side) === 'player' ? true : det;
         s.inSmoke = !!(f1 & F_SMOKE); s.blooming = !!(f1 & F_BLOOM); s.grounded = !!(f1 & F_GROUNDED);
         if (det) {
            const ls = s.lastSeen || (s.lastSeen = { x: 0, y: 0, heading: 0, speed: 0, t: 0 });
            ls.x = x; ls.y = y; ls.heading = hd; ls.speed = sp; ls.t = rt;
         }
         if (s === me) continue;         // own controls, turrets, fires: predicted / own detail
         s.telegraph = ((f2 >> 2) & 7) - 1; s.rudderCmd = ((f2 >> 5) & 7) - 2;
         const ff = F.ff[i];
         if (s.fires.length !== ff >> 4) fitN(s.fires, ff >> 4);
         if (s.floods.length !== (ff & 15)) fitN(s.floods, ff & 15);
         const T = s.turrets, nT = Math.min(T.length, SA.nT[ia], SB.nT[ib]);
         for (let j = 0; j < nT; j++) {
            const a = SA.tb[ia * MAX_TURRETS + j];
            T[j].bearing = a + angD(a, SB.tb[ib * MAX_TURRETS + j]) * kk;
         }
      }
      // ships the host no longer lists have gone under (or left the battle)
      const ships = world.ships;
      let gone = false;
      for (let i = 0; i < ships.length; i++) {
         const s = ships[i];
         if (s._seen !== undefined && s._seen !== F.tick) { if (s.alive) { s.alive = false; s.hp = 0; } s.sinking = false; gone = true; }
      }
      if (gone) world.ships = ships.filter(s => s.alive || s.sinking);
   }

   function interpolate(dt) {
      const n = snaps.length;
      if (!n) return;
      let i = n - 1;
      while (i > 0 && snaps[i].t > rt) i--;
      const A = snaps[i];
      if (A.t > rt) applyShips(A, A, 0, A, dt);                         // before the oldest snapshot
      else if (i < n - 1) { const B = snaps[i + 1]; applyShips(A, B, (rt - A.t) / (B.t - A.t), A, dt); }
      else if (n > 1) {                                                  // past the newest: run on a little
         const Q = snaps[n - 2];
         applyShips(Q, A, 1 + Math.min(rt - A.t, EXTRAPOLATE) / (A.t - Q.t), A, dt);
      } else applyShips(A, A, 0, A, dt);
   }

   // The own ship's read-outs between two own-detail updates.
   function ownStep(dt) {
      if (!me || !me.alive) return;
      me._updateTurrets(dt);
      if (me.torps) for (const l of me.torps.launchers) if (l.reload > 0) l.reload = Math.max(0, l.reload - dt);
      for (const c of me.consumables) {
         if (c.active) { c.t -= dt; if (c.t <= 0) { c.active = false; c.t = 0; c.cd = c.cdMax; } }
         else if (c.cd > 0) c.cd = Math.max(0, c.cd - dt);
      }
      const m = me.modules;
      if (m.engine > 0) m.engine = Math.max(0, m.engine - dt);
      if (m.rudder > 0) m.rudder = Math.max(0, m.rudder - dt);
      if (me.asw && me.asw.reload > 0) me.asw.reload = Math.max(0, me.asw.reload - dt);
   }

   // ---------------------------------------------------------------- shells, torpedoes
   function flyShells(dt) {
      const shells = world.shells;
      let dead = false;
      for (let i = 0; i < shells.length; i++) {
         const s = shells[i];
         if (!s.alive) { dead = true; continue; }
         let age;
         if (s.pred) { age = rt - s.t0; if (age > PRED_MAX) { s.alive = false; dead = true; continue; } }
         else {
            // an adopted shell is ahead of the host's; it loses that lead gradually, never jumps back
            if (s.lead > 0) s.lead = Math.max(0, s.lead - dt * 0.5);
            age = rt - s.t0 + s.lead;
         }
         if (age < 0) age = 0;
         s.age = age;
         const x = Math.min(s.range, horizDist(s.gun, age)), u = x / s.range;
         s.u = u; s.arc = Math.min(1, age / s.dur);
         s.pos.x = s.start.x + s.dirX * x; s.pos.y = s.start.y + s.dirY * x;
         s.alt = arcAlt(s.H, s.h0, u);
         if (u >= 1) {
            s.alive = false; dead = true;
            if (!s.pred) world.addEffect('splash', s.target, 1.6, 8 + s.caliber * 0.09, { big: s.caliber >= 280 });
         }
      }
      if (dead) {
         let j = 0;
         for (let i = 0; i < shells.length; i++) {
            const s = shells[i];
            if (s.alive) shells[j++] = s; else if (s.hid) shellByHost.delete(s.hid);
         }
         shells.length = j;
      }
   }

   function runTorps() {
      const T = world.torpedoes;
      let dead = false;
      for (let i = 0; i < T.length; i++) {
         const t = T[i];
         if (!t.alive) { dead = true; continue; }
         const age = Math.max(0, rt - t.t0);
         t.age = age; t.traveled = t.speed * age;
         t.pos.x = t.start.x + t.cx * t.traveled; t.pos.y = t.start.y + t.cy * t.traveled;
         if (t.traveled >= t.range) { t.alive = false; dead = true; torpByHost.delete(t.id); }
      }
      if (dead) world.torpedoes = T.filter(t => t.alive);
   }

   // ---------------------------------------------------------------- the step
   function step(dt) {
      const now = o.now();
      if (lost) return;
      if (!synced) { if (now - lastSnapAt > SILENCE * 2) hostLost('timeout'); return; }
      const err = now + off - delay - rt;
      if (err > 0.4 || err < -0.4) rt += err;
      else rt += dt * (1 + Math.max(-0.05, Math.min(0.05, err)));
      if (rt < 0) rt = 0;
      world.time = rt; world.tick = Math.floor(rt / SIM_DT + 1e-6);
      if (world.phase === 'playing' && world.timeLeft != null) world.timeLeft = Math.max(0, world.timeLeft - dt);
      applyEvents(now);
      interpolate(dt);
      ownStep(dt);
      flyShells(dt);
      runTorps();
      world._updateSmoke(dt);
      world._updateEffects(dt);
      if (world._shake) { world._shake *= Math.pow(0.02, dt); if (world._shake < 0.02) world._shake = 0; }
      if (pendingEnd && (rt >= pendingEnd.t * SIM_DT || now >= endAt)) applyEnd(pendingEnd);
      sendCmd();
      if (!ended && !pendingEnd && now - lastSnapAt > SILENCE) hostLost('timeout');
   }
   world.update = step;

   return {
      act, control, onSnap, onEvt, onSync, hostLost,
      // called every frame even when the sim loop does not run (results screen, menus)
      pump() { if (!ended && !pendingEnd && !lost && o.now() - lastSnapAt > (synced ? SILENCE : SILENCE * 2)) hostLost('timeout'); },
      get ended() { return ended; },
      get lost() { return lost; },
      info() { return { rt, delay, jitter: jit, rtt, snaps: snaps.length, newestTick, synced, unacked: unacked.length, batches: batches.size }; },
   };
}
