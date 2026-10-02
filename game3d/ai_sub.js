// game3d/ai_sub.js — bot behaviour around submarines; ai.js asks subPlan() once per decision.
//   role 'ss'      approach surfaced, attack from periscope depth, go deep when hunted or after a
//                  salvo, surface to recharge when nobody is near
//   DD / CL        hunt a submerged contact (sonar or periscope sighting) and drop depth charges
//   BB / CA / CV   turn away from a known boat and zigzag
// Returns { want, tel, goal } or null (= ai.js carries on with its normal navigation).
import { DEG, dist2, angleDelta, interceptPoint } from './utils.js';
import { orderDepth, dropDepthCharges, SONAR_KEEP } from './submarine.js';

const HUNT_RANGE = { DD: 5000, CL: 2600 };
const AVOID_RANGE = 6000;
const _plan = { want: 0, tel: 3, goal: null };
const _pos = { x: 0, y: 0 };

export function subPlan(b, w, d, tgt, threat, searchGoal) {
   if (b.sub) return subCaptain(b, w, d, tgt, threat, searchGoal);
   if (b.ai.passive || b.ai.route || !w.hasSubs) return null;
   if (b.asw) return hunt(b, w);
   if (b.type === 'TR' || d.smarts < 0.5) return null;
   return avoid(b, w);
}

// Where the team believes an enemy boat is: null when there is no fresh knowledge.
function contact(w, e) {
   const now = w.time;
   if (e.depth < 2 && e.detected) return e.pos;
   const c = e.sonarSeen;
   if (c && now - c.t < SONAR_KEEP) return c;
   return null;
}

// ---------------------------------------------------------------- destroyers and light cruisers
function hunt(b, w) {
   const R = HUNT_RANGE[b.type] || 2600;
   let best = null, bd = R * R;
   for (const e of w.ships) {
      if (!e.alive || !e.sub || e.side === b.side || e.depth === 0) continue;
      const p = contact(w, e);
      if (!p) continue;
      const d2 = dist2(b.pos, p);
      if (d2 < bd) { bd = d2; best = p; }
   }
   if (!best) return null;
   const dd = Math.sqrt(bd);
   // the racks are at the stern: drop as the hull runs over the contact
   if (dd < 120) dropDepthCharges(b, w);
   _pos.x = best.x; _pos.y = best.y;
   _plan.want = dd > 60 ? Math.atan2(best.y - b.pos.y, best.x - b.pos.x) : b.heading;
   _plan.tel = 4; _plan.goal = dd > 500 ? _pos : null;
   return _plan;
}

// ---------------------------------------------------------------- capital ships
function avoid(b, w) {
   const now = w.time;
   let best = null, bd = AVOID_RANGE * AVOID_RANGE;
   for (const e of w.ships) {
      if (!e.alive || !e.sub || e.side === b.side) continue;
      let p = contact(w, e);
      if (!p && e.lastSeen && now - e.lastSeen.t < 25) p = e.lastSeen;
      if (!p) continue;
      const d2 = dist2(b.pos, p);
      if (d2 < bd) { bd = d2; best = p; }
   }
   if (!best) return null;
   const away = Math.atan2(b.pos.y - best.y, b.pos.x - best.x);
   _plan.want = away + Math.sin(now / 7 + b.ai.zigPhase) * 28 * DEG;
   _plan.tel = 4; _plan.goal = null;
   return _plan;
}

// ---------------------------------------------------------------- the boat itself
function subCaptain(b, w, d, tgt, threat, searchGoal) {
   const ai = b.ai, now = w.time, sb = b.sub;
   // nearest enemy the boat knows of (sighted by the team, or heard on its own hydrophone) and
   // the nearest sub hunter among them
   let dn = Infinity, dh = Infinity, hunter = null, nearest = null;
   const hyd2 = sb.hydrophone * sb.hydrophone;
   for (const e of w.ships) {
      if (!e.alive || e.side === b.side || e.type === 'TR') continue;
      const d2 = dist2(b.pos, e.pos);
      if (!w.canSee(b.side, e) && d2 > hyd2) continue;
      if (d2 < dn) { dn = d2; nearest = e; }
      if (e.asw && d2 < dh) { dh = d2; hunter = e; }
   }
   dn = Math.sqrt(dn); dh = Math.sqrt(dh);
   const bowReady = b.torps && b.torps.launchers.some(l => l.side !== 'stern' && l.reload <= 0);
   if (b.lastTorpFire > (ai.fireSeen ?? -999)) {
      ai.fireSeen = b.lastTorpFire;
      if (!bowReady) ai.deepUntil = now + 16;          // salvo away: get out from under the bloom
   }
   const hunted = now - b.pingT < 9 || dh < 2400 || dn < 1100 || (b.depth > 0 && now - b.lastHitT < 8);
   if (hunted) ai.deepUntil = Math.max(ai.deepUntil || 0, now + 10);

   // ---- depth
   let depth;
   if (b.batteryLock || b.battery <= 0.03) depth = 0;
   else if (ai.recharge) {
      depth = 0;
      if (b.battery > 0.85 || (dn < 4500 && b.battery > 0.3)) ai.recharge = false;
   } else if (b.battery < 0.2 && dn > 6000 && !hunted) { ai.recharge = true; depth = 0; }
   else if (now < (ai.deepUntil || 0) && b.battery > 0.06) depth = 2;
   else depth = dn < Math.max(b.cfg.detect.surface * 1.3, 7500) ? 1 : 0;
   if (depth !== b.depthTarget) orderDepth(b, depth, w);

   // ---- course
   const s = ai.angSide;
   _plan.goal = null; _plan.tel = 3;
   if (depth === 2 || (ai.recharge && nearest)) {
      const from = hunter || nearest;
      _plan.want = from ? Math.atan2(b.pos.y - from.pos.y, b.pos.x - from.pos.x) + s * 20 * DEG : threat.away;
      _plan.tel = depth === 2 ? 3 : 4;
   } else if (tgt) {
      const tc = b.cfg.torp;
      const dd = Math.sqrt(dist2(b.pos, tgt.pos));
      const brg = Math.atan2(tgt.pos.y - b.pos.y, tgt.pos.x - b.pos.x);
      const ip = interceptPoint(b.pos, tc.speed, tgt.pos, tgt.vel);
      const ib = ip ? Math.atan2(ip.y - b.pos.y, ip.x - b.pos.x) : brg;
      if (bowReady) {
         if (dd > tc.range * 0.72) { _plan.want = ib; _plan.tel = 4; }
         else { _plan.want = ib; _plan.tel = Math.abs(angleDelta(b.heading, ib)) > 20 * DEG ? 3 : 2; }   // creep and lay the bow on
      } else if (dd < tc.range * 0.45) {
         _plan.want = brg + Math.PI + s * 12 * DEG; _plan.tel = 4;      // open the range (stern tubes bear)
      } else {
         _plan.want = brg + s * 95 * DEG; _plan.tel = 3;
      }
   } else {
      const g = searchGoal(b, w);
      _plan.goal = g;
      _plan.want = Math.atan2(g.y - b.pos.y, g.x - b.pos.x);
      _plan.tel = 4;
   }
   return _plan;
}
