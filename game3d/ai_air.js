// game3d/ai_air.js — the AI side of carrier aviation:
//   squadThink   flies a squadron that no human controls (bot carriers, and the player's own
//                squadrons once the player hands them back): strike runs, fighter patrols
//   carrierPlan  bot carriers: keep behind the fleet, out of gun range, and launch strikes
//   airEvade     every bot ship: comb torpedo bombers, turn hard under dive bombers, keep close
//                to friends while enemy planes are up
import { DIFFICULTY } from './config.js';
import { DEG, clamp, dist2, angleDelta, interceptPoint, gaussR } from './utils.js';
import { AIR, canLaunch, launchSquadron, recallSquadron, dropWeapons, squadById } from './air.js';

const skillOf = (w, side) => (side === 'player' ? DIFFICULTY.normal : w.difficulty || DIFFICULTY.normal);
const _tv = { x: 0, y: 0 }, _from = { x: 0, y: 0 };

// ---------------------------------------------------------------- squadrons
export function squadThink(w, sq, dt) {
   if (sq.state === 'launch' || sq.state === 'return' || sq.state === 'land') return;
   if (sq.type === 'ft') return fighterThink(w, sq, dt);
   if (sq.armed <= 0) { recallSquadron(w, sq); return; }
   let tgt = sq.order && sq.order.targetId != null ? w.shipById(sq.order.targetId) : null;
   if (!tgt || !tgt.alive || tgt.depth === 2) {
      tgt = pickStrikeTarget(w, sq.side, sq.pos, sq.type, true);
      if (!tgt) {
         // nothing in sight: fly to the order point, then home
         const p = sq.order && sq.order.pos;
         if (p && dist2(sq.pos, p) > 800 * 800) { sq.want = Math.atan2(p.y - sq.pos.y, p.x - sq.pos.x); sq.aiming = false; return; }
         recallSquadron(w, sq); return;
      }
      sq.order = { kind: 'strike', targetId: tgt.id, pos: null };
      sq.ai.phase = 0;
   }
   const d = skillOf(w, sq.side);
   const ai = sq.ai;
   ai.t -= dt;
   if (ai.t <= 0) {
      // a new run: fresh lead / aim error (worse bots lead less well)
      ai.t = 12;
      ai.errL = clamp((0.5 + 0.5 * d.lead) + gaussR(w.rng) * 0.1, 0.6, 1.25);
      ai.errP.x = gaussR(w.rng) * 60 / d.lead; ai.errP.y = gaussR(w.rng) * 60 / d.lead;
      ai.dropR = 1450 + w.rng() * 450;
   }
   _tv.x = Math.cos(tgt.heading) * tgt.speed; _tv.y = Math.sin(tgt.heading) * tgt.speed;
   const dx = tgt.pos.x - sq.pos.x, dy = tgt.pos.y - sq.pos.y, dd = Math.sqrt(dx * dx + dy * dy);
   if (ai.phase === 2) {
      // overshot: fly out and come round again
      // overshot: run out of the flak (away from the target, a little off the line) and come back
      if ((ai.outT -= dt) <= 0) ai.phase = 0;
      sq.want = Math.atan2(-dy, -dx) + 0.35;
      sq.aiming = false;
      if (dd > 4200) ai.phase = 0;
      return;
   }
   if (sq.type === 'tb') {
      const brgFromT = Math.atan2(-dy, -dx);
      const rel = angleDelta(tgt.heading, brgFromT);
      const side = rel >= 0 ? 1 : -1;
      if (ai.phase === 0) {
         // set up on the target's beam, a little ahead, ~3.3 km out
         const a = tgt.heading + side * 65 * DEG, lead = dd / sq.cfg.speed;
         const px = tgt.pos.x + _tv.x * lead * 0.6 + Math.cos(a) * 3300, py = tgt.pos.y + _tv.y * lead * 0.6 + Math.sin(a) * 3300;
         sq.want = Math.atan2(py - sq.pos.y, px - sq.pos.x);
         sq.aiming = false;
         if (dist2(sq.pos, { x: px, y: py }) < 900 * 900 || dd < 3400) ai.phase = 1;
      }
      if (ai.phase === 1) {
         const ts = sq.cfg.weapon.speedKn * 2.6;
         _from.x = sq.pos.x + Math.cos(sq.heading) * AIR.tbDrop; _from.y = sq.pos.y + Math.sin(sq.heading) * AIR.tbDrop;
         _tv.x *= ai.errL; _tv.y *= ai.errL;
         const ip = interceptPoint(_from, ts, tgt.pos, _tv);
         const ax = (ip ? ip.x : tgt.pos.x) + ai.errP.x, ay = (ip ? ip.y : tgt.pos.y) + ai.errP.y;
         sq.want = Math.atan2(ay - _from.y, ax - _from.x);
         sq.aiming = dd < 3200;
         const onLine = Math.abs(angleDelta(sq.heading, sq.want)) < 7 * DEG;
         if (sq.aiming && onLine && dd <= ai.dropR && sq.aimT >= 2.2) { dropWeapons(w, sq); ai.t = 0; ai.phase = 0; return; }
         if (dd < 800 || (dd < ai.dropR && Math.abs(angleDelta(sq.heading, Math.atan2(dy, dx))) > 70 * DEG)) {
            if (sq.aimT >= AIR.tbAimMin && dd > 450) { dropWeapons(w, sq); ai.t = 0; ai.phase = 0; return; }
            ai.phase = 2; ai.outT = 9; sq.want = sq.heading + side * 0.6; sq.aiming = false;
         }
      }
   } else {
      // dive bomber: run in high, dive when close, release when the predicted position sits in the ellipse
      // the bombs land on the aim point as it is at release (dbAim ahead): lead by the fall time only
      const tImp = AIR.bombFall;
      const px = tgt.pos.x + _tv.x * tImp * ai.errL + ai.errP.x * 0.3, py = tgt.pos.y + _tv.y * tImp * ai.errL + ai.errP.y * 0.3;
      // steer so the aim point (dbAim ahead) runs over the predicted position
      sq.want = Math.atan2(py - sq.pos.y, px - sq.pos.x);
      sq.aiming = dd < 2600;
      if (sq.aiming) {
         const ex = px - sq.aimPt.x, ey = py - sq.aimPt.y;
         const c = Math.cos(sq.heading), s = Math.sin(sq.heading);
         const along = ex * c + ey * s;
         if (Math.abs(along) < Math.max(40, sq.ellipse * 0.4) && Math.abs(-ex * s + ey * c) < 22 && sq.aimT >= 2) {
            dropWeapons(w, sq); ai.t = 0; return;
         }
         if (along < -250) { ai.phase = 2; ai.outT = 8; sq.aiming = false; }
      }
   }
}

function fighterThink(w, sq, dt) {
   const c = sq.center || (sq.order && sq.order.pos);
   if (!c) { recallSquadron(w, sq); return; }
   if (sq.state === 'patrol' || sq.state === 'attack') {
      if ((sq.patrolT -= dt) <= 0) { recallSquadron(w, sq); return; }
   }
   // foe: the nearest armed enemy squadron near the post (bombers first)
   let foe = sq.foeId != null ? squadById(w, sq.foeId) : null;
   if (foe && (foe.n <= 0 || dist2(foe.pos, c) > (AIR.ftEngage * 1.5) ** 2)) foe = null;
   if (!foe) {
      let bd = AIR.ftEngage * AIR.ftEngage;
      for (const q of w.squadrons) {
         if (q.side === sq.side || q.n <= 0 || q.state === 'launch' || q.state === 'land') continue;
         const d2 = dist2(q.pos, c) * (q.armed > 0 ? 0.6 : 1);
         if (d2 < bd) { bd = d2; foe = q; }
      }
   }
   sq.foeId = foe ? foe.id : null;
   if (foe) {
      sq.state = 'attack';
      _tv.x = Math.cos(foe.heading) * foe.speed; _tv.y = Math.sin(foe.heading) * foe.speed;
      const ip = interceptPoint(sq.pos, sq.cfg.speed, foe.pos, _tv);
      const p = ip || foe.pos;
      sq.want = Math.atan2(p.y - sq.pos.y, p.x - sq.pos.x);
      sq.throttle = dist2(sq.pos, foe.pos) > 1200 * 1200 ? 1 : 0;
      return;
   }
   sq.throttle = 0;
   if (sq.state === 'attack' || sq.state === 'fly') sq.state = 'patrol';
   const dx = sq.pos.x - c.x, dy = sq.pos.y - c.y, r = Math.sqrt(dx * dx + dy * dy);
   if (r > AIR.patrolR * 1.6) sq.want = Math.atan2(-dy, -dx);
   else sq.want = Math.atan2(dy, dx) + Math.PI / 2 + clamp((r - AIR.patrolR) / AIR.patrolR, -0.6, 0.6);
}

// Best ship to strike from `from` (side = the attacker's side). TBs prefer big slow hulls, DBs
// anything that burns; heavy AA around a target counts against it. visibleOnly: only ships the
// side can see now (squadrons in the air); carriers also plan on the last known positions.
export function pickStrikeTarget(w, side, from, type, visibleOnly) {
   let best = null, bs = 0;
   for (const e of w.ships) {
      if (!e.alive || e.side === side || e.depth > 0) continue;
      const seen = w.canSee(side, e);
      if (visibleOnly && !seen) continue;
      const p = seen ? e.pos : side === 'player' ? e.lastSeen : e.pos;
      if (!p) continue;
      const d = Math.sqrt(dist2(from, p));
      if (d > 30000) continue;
      let aa = 0;
      for (const o of w.ships) {
         if (!o.alive || o.side !== e.side || !o.aa || !o.aa.range) continue;
         if (dist2(o.pos, p) < (o.aa.range * 0.8) ** 2) aa += o.aa.dps;
      }
      const t = e.type;
      const pref = type === 'tb' ? (t === 'BB' || t === 'CV' ? 1.5 : t === 'CA' ? 1.2 : t === 'DD' ? 0.35 : t === 'TR' ? 1.1 : 0.9)
         : (t === 'CV' ? 1.4 : t === 'DD' ? 0.7 : t === 'TR' ? 1.2 : 1);
      const val = (e.cfg.ai && e.cfg.ai.value) || 1;
      const s = val * pref * (1.5 - 0.6 * e.hp / e.maxHP) * (seen ? 1 : 0.6) / (d / 10000 + 0.6) / (1 + aa / 90);
      if (s > bs) { bs = s; best = e; }
   }
   return best;
}

// ---------------------------------------------------------------- bot carriers
// Returns { want, tel, goal } for ai.js decide(), and launches squadrons.
export function carrierPlan(b, w, d, threat) {
   const ai = b.ai;
   // where is the own fleet / the enemy?
   let cx = 0, cy = 0, n = 0;
   for (const o of w.ships) {
      if (o === b || !o.alive || o.side !== b.side || o.air || o.type === 'TR') continue;
      cx += o.pos.x; cy += o.pos.y; n++;
   }
   if (!n) { cx = b.pos.x; cy = b.pos.y; }
   else { cx /= n; cy /= n; }
   // nearest visible enemy surface ship
   let near = null, nd = Infinity;
   for (const e of w.ships) {
      if (!e.alive || e.side === b.side || e.depth > 0 || e.type === 'TR' || !w.canSee(b.side, e)) continue;
      const dd = dist2(b.pos, e.pos);
      if (dd < nd) { nd = dd; near = e; }
   }
   nd = Math.sqrt(nd);
   if (ai.launchT == null) ai.launchT = w.time + 6 + w.rng() * 6;
   if (w.time >= ai.launchT) { ai.launchT = w.time + 2; carrierLaunches(b, w, d, cx, cy); }

   if (near && nd < 9500) {
      // in gun range of something: run, and let the escorts deal with it
      return { want: Math.atan2(b.pos.y - near.pos.y, b.pos.x - near.pos.x), tel: 4, goal: null };
   }
   // keep station behind the fleet, away from the enemy
   let away = threat ? threat.away : 0;
   if (!threat || !(threat.near || near)) {
      let ex = 0, ey = 0, m = 0;
      for (const e of w.ships) {
         if (!e.alive || e.side === b.side) continue;
         const p = b.side === 'player' ? e.lastSeen : e.pos;
         if (p) { ex += p.x; ey += p.y; m++; }
      }
      if (m) away = Math.atan2(cy - ey / m, cx - ex / m);
   }
   const back = n ? 6500 : 0;
   const gx = cx + Math.cos(away) * back, gy = cy + Math.sin(away) * back;
   const gd = Math.sqrt((gx - b.pos.x) ** 2 + (gy - b.pos.y) ** 2);
   if (gd < 1200) return { want: b.heading + 0.25 * (ai.angSide || 1), tel: 2, goal: null };
   const goal = { x: gx, y: gy };
   return { want: Math.atan2(gy - b.pos.y, gx - b.pos.x), tel: gd > 4000 ? 4 : 3, goal };
}

function carrierLaunches(b, w, d, cx, cy) {
   const a = b.air;
   if (!a || a.deckT > 0) return;
   // fighters: enemy planes near the fleet or the carrier
   if (canLaunch(w, b, 'ft') && a.ft.hangar >= 2) {
      for (const q of w.squadrons) {
         if (q.side === b.side || q.n <= 0 || q.armed <= 0) continue;
         if (dist2(q.pos, b.pos) < 9000 * 9000 || dist2(q.pos, { x: cx, y: cy }) < 7000 * 7000) {
            const near = dist2(q.pos, b.pos) < dist2(q.pos, { x: cx, y: cy });
            launchSquadron(w, b, 'ft', { kind: 'patrol', pos: near ? { x: b.pos.x, y: b.pos.y } : { x: cx, y: cy } });
            return;
         }
      }
   }
   for (const type of ['tb', 'db']) {
      const pc = b.cfg.air[type];
      if (!canLaunch(w, b, type) || a[type].hangar < Math.min(3, pc.squad)) continue;
      // easier bots wait longer for a full deck
      if (a[type].hangar < pc.squad && w.rng() < 0.6 * (1 - d.smarts)) continue;
      const tgt = pickStrikeTarget(w, b.side, b.pos, type, false);
      if (!tgt) { scout(b, w, cx, cy); return; }
      const p = w.canSee(b.side, tgt) ? tgt.pos : b.side === 'player' ? tgt.lastSeen : tgt.pos;
      launchSquadron(w, b, type, { kind: 'strike', targetId: tgt.id, pos: { x: p.x, y: p.y } });
      return;
   }
}

// Nothing known to strike (the player side plans on sightings only): send one fighter flight out
// as a scout, toward the map centre or, from there, ahead of the fleet.
function scout(b, w, cx, cy) {
   const a = b.air;
   if (!canLaunch(w, b, 'ft') || a.ft.hangar < 2) return;
   for (const q of w.squadrons) if (q.ownerId === b.id && q.type === 'ft' && q.state !== 'land') return;
   let dx = -cx, dy = -cy, l = Math.sqrt(dx * dx + dy * dy);
   if (l < 3000) { dx = Math.cos(b.heading); dy = Math.sin(b.heading); l = 1; }
   const r = 11000 + w.rng() * 4000, sp = (w.rng() - 0.5) * 0.9;
   const ang = Math.atan2(dy, dx) + sp, lim = w.arena - 1500;
   const pos = { x: clamp(cx + Math.cos(ang) * r, -lim, lim), y: clamp(cy + Math.sin(ang) * r, -lim, lim) };
   launchSquadron(w, b, 'ft', { kind: 'patrol', pos, scout: true });
}

// ---------------------------------------------------------------- every bot ship
// Adjust a bot's desired heading for enemy planes. Cheap when nothing is in the air.
export function airEvade(b, w, want, d) {
   if (!w.squadrons.length || b.depth > 0) return want;
   let comb = null, cd = Infinity, dive = false, planes = false;
   for (const q of w.squadrons) {
      if (q.side === b.side || q.n <= 0 || q.state === 'land') continue;
      const dx = b.pos.x - q.pos.x, dy = b.pos.y - q.pos.y, d2 = dx * dx + dy * dy;
      if (d2 > 9000 * 9000) continue;
      planes = true;
      if (q.armed <= 0 || d2 > 5000 * 5000) continue;
      const toMe = Math.atan2(dy, dx);
      if (Math.abs(angleDelta(q.heading, toMe)) > 35 * DEG) continue;
      if (q.type === 'tb' && d2 < cd) { cd = d2; comb = toMe; }
      else if (q.type === 'db' && q.aiming && d2 < 2600 * 2600) dive = true;
   }
   // a fixed per-ship roll: whether this captain reacts at all (re-rolling every decision flickers)
   const roll = (b.id * 0.6180339) % 1;
   if (comb != null && roll < 0.4 + 0.6 * d.dodge) {
      // bow or stern toward the incoming torpedoes, whichever is closer
      const a = Math.abs(angleDelta(b.heading, comb)) < Math.PI / 2 ? comb : comb + Math.PI;
      b.ai.airDodge = a;
      return a;
   }
   if (dive && roll < 0.3 + 0.7 * d.dodge) return b.heading + (b.ai.angSide || 1) * 80 * DEG;
   if (planes && d.smarts > 0.5 && !b.air) {
      // stay inside the friends' flak umbrella
      let best = null, bd = Infinity;
      for (const o of w.ships) {
         if (o === b || !o.alive || o.side !== b.side || o.type === 'TR' || o.depth > 0) continue;
         const dd = dist2(o.pos, b.pos);
         if (dd < bd) { bd = dd; best = o; }
      }
      if (best && bd > 2500 * 2500 && bd < 12000 * 12000) {
         const to = Math.atan2(best.pos.y - b.pos.y, best.pos.x - b.pos.x);
         return want + clamp(angleDelta(want, to), -0.35, 0.35);
      }
   }
   return want;
}
