// game3d/ai_sub.js — bot behaviour around submarines; ai.js asks subPlan() once per decision.
//   role 'ss'      approach surfaced, attack from periscope depth, go deep when hunted or after a
//                  salvo, surface to recharge when nobody is near
//   DD / CL        hunt a submerged contact (sonar or periscope sighting) and drop depth charges
//   BB / CA / CV   turn away from a known boat and zigzag
// Returns { want, tel, goal } or null (= ai.js carries on with its normal navigation).
import { DEG, dist2, angleDelta, interceptPoint } from './utils.js';
import { orderDepth, dropDepthCharges, SONAR_KEEP, PERI_PROX } from './submarine.js';

const HUNT_RANGE = { DD: 5000, CL: 2600 };
const AVOID_RANGE = 6000;
// an escort may not lose its charge: a contact this far from the escorted ship is left alone (the
// escort rejoins; a boat that stays deep and slow is left behind by the convoy)
const ESCORT_LEASH = 3000;
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
   const esc = b.ai.escortId != null ? w.shipById(b.ai.escortId) : null;
   const leash = esc && esc.alive ? esc.pos : null;
   for (const e of w.ships) {
      if (!e.alive || !e.sub || e.side === b.side || e.depth === 0) continue;
      const p = contact(w, e);
      if (!p || (leash && dist2(leash, p) > ESCORT_LEASH * ESCORT_LEASH)) continue;
      const d2 = dist2(b.pos, p);
      if (d2 < bd) { bd = d2; best = p; }
   }
   if (!best) return null;
   const dd = Math.sqrt(bd);
   // the racks are at the stern: drop as the hull runs over the contact
   if (dd < 120) dropDepthCharges(b, w);
   // weave on the run-in: a straight course down the bearing is a gift to the boat's bow tubes
   const brg = Math.atan2(best.y - b.pos.y, best.x - b.pos.x);
   const off = dd > 500 ? Math.sin(w.time / 3.2 + (b.ai.zigPhase || 0)) * Math.min(dd * 0.3, 420) : 0;
   _pos.x = best.x - Math.sin(brg) * off; _pos.y = best.y + Math.cos(brg) * off;
   _plan.want = dd > 60 ? Math.atan2(_pos.y - b.pos.y, _pos.x - b.pos.x) : b.heading;
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
// Torpedo range a bot boat fires at: short against a destroyer (snap shot down the throat),
// about half the run against everything else. ai.js torpedoes() uses the same gate.
export function subFireRange(b, tgt) {
   return tgt.type === 'DD' ? 1300 : Math.min(b.cfg.torp.range * 0.55, 4200);
}

// a hunter heading at the boat (within 25 deg of the bearing to it)
function runIn(h, b) {
   return Math.abs(angleDelta(h.heading, Math.atan2(b.pos.y - h.pos.y, b.pos.x - h.pos.x))) < 25 * DEG;
}

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
   let bowReady = false, sternReady = false;
   if (b.torps) for (const l of b.torps.launchers) if (l.reload <= 0) { if (l.side === 'stern') sternReady = true; else bowReady = true; }
   if (b.lastTorpFire > (ai.fireSeen ?? -999)) {
      ai.fireSeen = b.lastTorpFire;
      if (!bowReady) ai.deepUntil = now + 14;          // salvo away: get out from under the bloom
   }
   const pinged = now - b.pingT < 6;
   // a hunter coming in with tubes loaded: come up for a snap shot instead of waiting for the charges
   // (bow tubes, or a stern tube when the hunter is already astern)
   const hb = hunter ? Math.abs(angleDelta(b.heading, Math.atan2(hunter.pos.y - b.pos.y, hunter.pos.x - b.pos.x))) : 0;
   // (never inside PERI_PROX: a periscope that close is seen and shot at once)
   const duel = !!hunter && dh < 3600 && dh > PERI_PROX + 150 && (bowReady || (sternReady && hb > 115 * DEG)) && b.battery > 0.1 && !b.batteryLock;
   const hunted = !duel && ((hunter && dh < 2400) || dn < 600 || (pinged && dh < 3600 && !bowReady) || (b.depth > 0 && now - b.lastHitT < 6));
   if (hunted) ai.deepUntil = Math.max(ai.deepUntil || 0, now + 8);
   if (duel) { ai.deepUntil = 0; if (ai.target !== hunter && w.canSee(b.side, hunter)) { ai.target = hunter; ai.targetSince = now - 5; ai.targetT = 2; } }

   // ---- depth: the battery decides. Recharging means running out of sight first.
   const safeR = Math.max(b.cfg.detect.surface * 1.15, 6000);
   if (!ai.recharge && b.battery < 0.3 && !duel && !(hunted && b.battery > 0.12)) ai.recharge = true;
   let depth;
   if (b.batteryLock || b.battery <= 0.02) depth = 0;
   else if (ai.recharge) {
      const up = b.depthTarget === 0 ? dn > safeR * 0.8 : dn > safeR;
      depth = up ? 0 : (hunter && dh < 700 && b.battery > 0.06 ? 2 : 1);
      if (b.battery > 0.92 || (b.battery > 0.5 && dn < safeR)) ai.recharge = false;
   } else if (duel) depth = 1;
   else if (now < (ai.deepUntil || 0) && b.battery > 0.08) depth = 2;
   else depth = dn < Math.max(b.cfg.detect.surface * 1.3, 7500) ? 1 : 0;
   if (depth !== b.depthTarget) orderDepth(b, depth, w);

   // ---- course
   const s = ai.angSide;
   _plan.goal = null; _plan.tel = 3;
   if (ai.recharge) {
      const from = hunter && dh < dn * 1.5 ? hunter : nearest;
      _plan.want = from ? Math.atan2(b.pos.y - from.pos.y, b.pos.x - from.pos.x) : threat.away;
      _plan.tel = 4;
   } else if (duel) {
      const ip = interceptPoint(b.pos, b.cfg.torp.speed, hunter.pos, hunter.vel);
      const ib = ip ? Math.atan2(ip.y - b.pos.y, ip.x - b.pos.x) : Math.atan2(hunter.pos.y - b.pos.y, hunter.pos.x - b.pos.x);
      _plan.want = bowReady ? ib : ib + Math.PI;
      _plan.tel = 2;
   } else if (depth === 2) {
      const from = hunter || nearest;
      if (!from) { _plan.want = threat.away; _plan.tel = 2; }
      else {
         const brg = Math.atan2(from.pos.y - b.pos.y, from.pos.x - b.pos.x);
         const df = from === hunter ? dh : dn;
         if (from === hunter && bowReady && df > 700) { _plan.want = brg; _plan.tel = 1; }          // lie in wait, bow on
         // sidestep only a real run-in (the hunter coming straight at us); an escort pinging or merely
         // passing overhead is crept away from – full speed deep drains the battery within minutes
         else if (df < 800 && from === hunter && runIn(from, b)) { _plan.want = brg + s * 90 * DEG; _plan.tel = 4; }
         else { _plan.want = brg + Math.PI + s * 25 * DEG; _plan.tel = 1; }                           // creep away, quiet
      }
   } else if (tgt) {
      const tc = b.cfg.torp;
      const dd = Math.sqrt(dist2(b.pos, tgt.pos));
      const brg = Math.atan2(tgt.pos.y - b.pos.y, tgt.pos.x - b.pos.x);
      const ip = interceptPoint(b.pos, tc.speed, tgt.pos, tgt.vel);
      const ib = ip ? Math.atan2(ip.y - b.pos.y, ip.x - b.pos.x) : brg;
      const fireR = subFireRange(b, tgt);
      if (bowReady) {
         if (dd > fireR) { _plan.want = ib; _plan.tel = 4; }
         else { _plan.want = ib; _plan.tel = Math.abs(angleDelta(b.heading, ib)) > 20 * DEG ? 3 : 2; }   // creep and lay the bow on
      } else if (sternReady && dd < fireR) {
         _plan.want = ib + Math.PI; _plan.tel = 2;                      // stern tube
      } else if (dd < 2600) {
         _plan.want = brg + Math.PI + s * 12 * DEG; _plan.tel = 4;      // open the range while the tubes reload
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
