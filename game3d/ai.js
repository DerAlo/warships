// game3d/ai.js — bot captains for both teams. Every bot drives through the same controls API as
// the player (setTelegraph / setRudder / setAmmo / fireMain / fireTorpedoes / useConsumable).
//
// Per-bot mission hints live in ship.ai (set by missions.js):
//   passive      never fires (training targets, convoy freighters)
//   route        [{x,y}] waypoints to follow (zigzag: weave around the course)
//   patrol       [{x,y}] waypoints to loop
//   escortId     ship id to stay close to; escortIdPlayer: escort the player
//   huntId       preferred target id (navigates towards it even when unseen)
//   capId        preferred capture point (domination)
//   retreatBelow HP fraction below which the ship breaks off for good towards retreatTo
//   aggro        >1 closes range more eagerly
import { WORLD } from './config.js';
import { TAU, DEG, dist2, angleDelta, clamp, obstacleT, obstacleRadiusAt, interceptPoint, gaussR } from './utils.js';
import { flightTime } from './combat.js';

const DECIDE_DT = 0.4;             // s between navigation decisions
const TARGET_DT = 2;               // s between target re-evaluations
const CANDIDATES = [0, 15, -15, 30, -30, 50, -50, 75, -75, 100, -100, 130, -130, 165, -165].map(d => d * DEG);

// Called once per world tick (World.update). Deduped so a second call in the same tick is a no-op.
export function updateBots(world, dt) {
   if (world._aiTick === world.tick) return;
   world._aiTick = world.tick;
   // world.autoPlayer: the AI also captains the player ship (tests, attract mode)
   for (const b of world.ships) if (b.alive && (!b.isPlayer || world.autoPlayer)) think(b, world, dt);
}
// Legacy per-bot entry point (old main3d loop). World.update already runs every bot.
export function updateBot() {}

function init(b, w) {
   const ai = b.ai;
   ai._init = true;
   ai.role = ai.role || b.cfg.ai.role;
   const pr = b.cfg.ai.prefRange;
   const maxR = b.cfg.main.range * 0.92;
   ai.pref = [Math.min(pr[0], maxR * 0.8), Math.min(pr[1], maxR)];
   ai.decideT = w.rng() * DECIDE_DT;
   ai.targetT = w.rng() * TARGET_DT;
   ai.target = null;
   ai.targetSince = 0;
   ai.desired = b.heading;
   ai.tel = b.telegraph;
   ai.angSide = w.rng() < 0.5 ? 1 : -1;
   ai.dodged = new Set();
   ai.dodgeT = 0;
   ai.stuckT = 0;
   ai.reverseT = 0;
   ai.aimErr = { r: 0, l: 0 };
   ai.salvoCount = 0;
   ai.ammoT = 0;
   ai.torpT = 2 + w.rng() * 4;
   ai.consT = w.rng();
   ai.routeIdx = ai.routeIdx || 0;
   ai.zigPhase = w.rng() * TAU;
   if (ai.escortIdPlayer && w.player) ai.escortId = w.player.id;
}

function think(b, w, dt) {
   const ai = b.ai;
   if (!ai._init) init(b, w);
   const d = w.difficulty;
   ai.targetT -= dt;
   if (ai.targetT <= 0 || (ai.target && (!ai.target.alive || !w.canSee(b.side, ai.target)))) {
      ai.targetT = TARGET_DT * (0.8 + w.rng() * 0.4);
      const t = pickTarget(b, w);
      if (t !== ai.target) { ai.target = t; ai.targetSince = w.time; ai.salvoCount = 0; newAimError(b, w); }
   }
   ai.decideT -= dt;
   if (ai.decideT <= 0) { ai.decideT = DECIDE_DT; decide(b, w, d); }
   steer(b, dt);
   if (!ai.passive) { gunnery(b, w, d, dt); torpedoes(b, w, dt); }
   ai.consT -= dt;
   if (ai.consT <= 0) { ai.consT = 0.5 + w.rng() * 0.5; consumables(b, w, d); }
}

// ---------------------------------------------------------------- targeting
function pickTarget(b, w) {
   if (b.ai.passive) return null;
   let best = null, bestS = 0;
   const cur = b.ai.target;
   for (const e of w.ships) {
      if (!e.alive || e.side === b.side || !w.canSee(b.side, e)) continue;
      const dd = Math.sqrt(dist2(b.pos, e.pos));
      if (dd > b.cfg.main.range * 1.35) continue;
      let s = (e.cfg.ai.value || 40) * (1.8 - e.hp / e.maxHP * 0.8) / (1 + dd / 7000);
      if (dd <= b.cfg.main.range) s *= 1.6;
      const aspect = Math.abs(Math.sin(angleDelta(e.heading, Math.atan2(b.pos.y - e.pos.y, b.pos.x - e.pos.x))));
      s *= 0.8 + aspect * 0.4;                          // broadside targets are juicier
      if (b.ai.huntId === e.id) s *= 3;
      if (e.type === 'TR' && b.ai.huntId != null) s *= 1.5;
      if (b.ai.role === 'dd' && e.type === 'DD') s *= 1.3;
      if (e === cur) s *= 1.3;                          // hysteresis
      // spread fire: a target already engaged by team-mates is less attractive, so the player
      // (usually the closest ship) doesn't get dog-piled by the whole enemy line
      let n = 0;
      for (const o of w.ships) if (o !== b && o.alive && o.side === b.side && o.ai && o.ai.target === e) n++;
      s /= 1 + 0.3 * n;
      if (s > bestS) { bestS = s; best = e; }
   }
   return best;
}
function newAimError(b, w) {
   let e = w.difficulty.aimErr * (b.ai.salvoCount > 1 ? 0.75 : 1.2);   // first salvos are ranging shots
   if (b.ai.target && b.ai.target === w.player && !w.autoPlayer) e *= w.difficulty.vsPlayer || 1;
   b.ai.aimErr = { r: gaussR(w.rng) * e, l: gaussR(w.rng) * e * 0.5 };
}

// ---------------------------------------------------------------- navigation
function decide(b, w, d) {
   const ai = b.ai, hpF = b.hp / b.maxHP;
   const tgt = ai.target;
   let want = b.heading, tel = 3;

   // stuck on a coast or rammed: back off for a few seconds
   if (ai.reverseT > 0) {
      ai.reverseT -= DECIDE_DT;
      ai.tel = -1;
      // pre-set the rudder for the turn toward the escape heading: a rudder shift takes up to 15 s, so
      // flipping it for the astern leg would leave it on the wrong side once the ship goes ahead again
      const dh = ai.escapeHeading == null ? 0 : angleDelta(b.heading, ai.escapeHeading);
      ai.rudderOverride = Math.abs(dh) > 0.15 ? (dh > 0 ? 2 : -2) : ai.revRudder;
      if (ai.reverseT <= 0 || Math.abs(dh) < 0.35) {
         ai.reverseT = 0;
         // fresh progress window, otherwise the slow re-acceleration re-triggers the reverse forever
         ai.progPos = { x: b.pos.x, y: b.pos.y }; ai.progT = w.time;
      }
      return;
   }
   ai.rudderOverride = null;
   if ((b.grounded || (Math.abs(b.speed) < 1.5 && b.telegraph > 0)) && w.time > 5) ai.stuckT += DECIDE_DT;
   else ai.stuckT = Math.max(0, ai.stuckT - DECIDE_DT);
   // no net progress for 10 s while ordered ahead (rubbing along a coast / pinned in a pocket)
   // (only counts if the hull touched ground in the window: accelerating out of a reverse or a tight
   // turn in open water also shows little net progress)
   if (b.grounded || b.atWall) ai.touchT = w.time;
   if (!ai.progPos || w.time - ai.progT > 10) {
      if (ai.progPos && b.telegraph >= 2 && !ai.route && dist2(b.pos, ai.progPos) < 350 * 350 && w.time > 12 &&
         w.time - (ai.touchT ?? -99) < 10) ai.stuckT = 99;
      ai.progPos = { x: b.pos.x, y: b.pos.y }; ai.progT = w.time;
   }
   if (ai.stuckT > 3) {
      ai.stuckT = 0; ai.reverseT = 8; ai.revRudder = w.rng() < 0.5 ? 2 : -2;
      ai.escapeHeading = escapeHeading(b, w);
      return;
   }

   // mission retreat (permanent) or generic break-off to repair
   if (ai.retreatBelow && hpF < ai.retreatBelow) ai.retreating = true;
   if (!ai.retreating && ai.role !== 'tr' && !ai.route && d.smarts > 0.6) {
      if (hpF < 0.22 && b.consumable('repair')) ai.breakOff = true;
      if (ai.breakOff && hpF > 0.45) ai.breakOff = false;
   }
   const threat = threatVector(b, w);

   if (ai.dodgeT > 0) {
      ai.dodgeT -= DECIDE_DT;
      want = ai.dodgeHeading; tel = 4;
   } else if (ai.route) {
      const pt = ai.route[Math.min(ai.routeIdx, ai.route.length - 1)];
      if (dist2(b.pos, pt) < 700 * 700 && ai.routeIdx < ai.route.length - 1) ai.routeIdx++;
      want = Math.atan2(pt.y - b.pos.y, pt.x - b.pos.x);
      if (ai.zigzag) want += Math.sin(w.time / 20 + ai.zigPhase) * 25 * DEG;
      tel = 4;
      if (threat.near && ai.convoy && d.smarts > 0.5) want += clamp(angleDelta(want, threat.away), -0.5, 0.5);
   } else if (ai.patrol) {
      ai.patrolIdx = ai.patrolIdx || 0;
      const pt = ai.patrol[ai.patrolIdx % ai.patrol.length];
      if (dist2(b.pos, pt) < 500 * 500) ai.patrolIdx++;
      want = Math.atan2(pt.y - b.pos.y, pt.x - b.pos.x);
      tel = b.telegraph || 1;
   } else if (ai.retreating) {
      const to = ai.retreatTo || { x: b.pos.x + Math.cos(threat.away) * 5000, y: b.pos.y + Math.sin(threat.away) * 5000 };
      want = Math.atan2(to.y - b.pos.y, to.x - b.pos.x);
      tel = 4;
   } else if (ai.breakOff) {
      want = threat.away; tel = 4;
   } else {
      const esc = ai.escortId != null ? w.shipById(ai.escortId) : null;
      const cap = capGoal(b, w);
      if (esc && esc.alive && (!tgt || dist2(b.pos, esc.pos) > 3200 * 3200)) {
         // stay on the threatened side of the escorted ship
         const side = threat.near ? threat.toward : esc.heading + ai.angSide * Math.PI / 2;
         const pt = { x: esc.pos.x + Math.cos(side) * 1100 + Math.cos(esc.heading) * 600, y: esc.pos.y + Math.sin(side) * 1100 + Math.sin(esc.heading) * 600 };
         const dd = Math.sqrt(dist2(b.pos, pt));
         want = dd > 400 ? Math.atan2(pt.y - b.pos.y, pt.x - b.pos.x) : esc.heading;
         tel = dd > 1500 ? 4 : dd > 500 ? 3 : Math.max(1, esc.telegraph);
      } else if (cap && !(ai.role === 'dd' && exposed(b, w)) && (!tgt || ai.role === 'dd' || dist2(b.pos, tgt.pos) > ai.pref[1] ** 2)) {
         const dd = Math.sqrt(dist2(b.pos, cap.pos));
         want = dd > cap.r * 0.5 ? Math.atan2(cap.pos.y - b.pos.y, cap.pos.x - b.pos.x) : b.heading + 0.6 * ai.angSide;
         tel = dd > cap.r ? 4 : 2;
      } else if (tgt) {
         ({ want, tel } = engage(b, w, tgt, d, threat));
      } else {
         // nothing visible: head for the last known enemy position / hunted ship / enemy centroid
         const goal = searchGoal(b, w);
         want = Math.atan2(goal.y - b.pos.y, goal.x - b.pos.x);
         tel = 3;
      }
   }

   want = separation(b, w, want);
   want = avoidTerrain(b, w, want);
   // tight water: slow down so the rudder has time to bite before the coast arrives
   if (ai.avoidLevel >= 2 && tel > 2) tel = 2;
   else if (ai.avoidLevel === 1 && tel > 3) tel = 3;
   ai.desired = want;
   ai.tel = tel;
   checkTorpedoes(b, w, d);
}

// Heading away from the nearest coast (or the last desired heading in open water).
function escapeHeading(b, w) {
   let best = null, bd = Infinity;
   for (const o of w.obstacles) {
      if (o.kind !== 'island') continue;
      const d = Math.sqrt(dist2(b.pos, o.c)) - obstacleRadiusAt(o, Math.atan2(b.pos.y - o.c.y, b.pos.x - o.c.x));
      if (d < bd) { bd = d; best = o; }
   }
   let ax = 0, ay = 0;
   if (best && bd < 1500) {
      ax = b.pos.x - best.c.x; ay = b.pos.y - best.c.y;
      const m = Math.hypot(ax, ay) || 1;
      ax /= m; ay /= m;
   }
   // at the arena wall (alone or pinned between a coast and it): "away from the island" or the
   // last desired heading points at the wall, so escape inwards and along the wall on the side the
   // bow already points to (a full inward turn is too much for a heavy hull backing off)
   const lim = w.arena - 900, c = Math.cos(b.heading), s = Math.sin(b.heading);
   if (Math.abs(b.pos.x) > lim) { ax -= Math.sign(b.pos.x) * 0.7; ay += Math.sign(s) * 0.7; }
   if (Math.abs(b.pos.y) > lim) { ay -= Math.sign(b.pos.y) * 0.7; ax += Math.sign(c) * 0.7; }
   if (ax || ay) return Math.atan2(ay, ax);
   return b.ai.desired != null ? b.ai.desired : b.heading + Math.PI;
}

// Combat manoeuvring: close in angled, fight in the preferred band showing an angled broadside,
// kite away when too close. DDs keep outside their own detection until torpedoes are ready.
function engage(b, w, tgt, d, threat) {
   const ai = b.ai;
   const dd = Math.sqrt(dist2(b.pos, tgt.pos));
   const brg = Math.atan2(tgt.pos.y - b.pos.y, tgt.pos.x - b.pos.x);
   let [lo, hi] = ai.pref;
   if (ai.aggro) { lo /= ai.aggro; hi /= ai.aggro; }
   // an unescorted freighter shoots back with nothing: close in instead of kiting out of its
   // (small) detection range and losing it again
   if (tgt.type === 'TR' && !threat?.near) { lo = 1500; hi = Math.min(hi, 5500); }
   const s = ai.angSide;
   if (ai.role === 'dd') {
      const tr = b.torps ? b.cfg.torp.range * 0.8 : 0;
      const torpReady = b.torps && b.torps.launchers.some(l => l.reload <= 0);
      // lit up by several ships: break contact and reset detection (unless already in a torpedo run)
      if (b.detected && d.smarts > 0.4 && exposed(b, w) && !(torpReady && dd <= tr && tgt.type !== 'DD'))
         return { want: brg + Math.PI - s * 35 * DEG, tel: 4 };
      if (torpReady && tgt.type !== 'DD' && dd > tr) return { want: brg + s * 20 * DEG, tel: 4 };
      if (torpReady && dd <= tr) return { want: brg + s * 70 * DEG, tel: 4 };   // present the tubes
      const stealth = b.detectRange * 1.1;
      if (tgt.type !== 'DD' && dd < stealth) return { want: brg + Math.PI - s * 35 * DEG, tel: 4 };
      if (dd > hi) return { want: brg + s * 25 * DEG, tel: 4 };
      return { want: brg + s * 80 * DEG, tel: 4 };
   }
   // flip the angling side now and then so the AI does not circle forever
   if (w.rng() < 0.004 * d.smarts) ai.angSide = -ai.angSide;
   if (dd > hi) return { want: brg + s * 25 * DEG, tel: 4 };
   if (dd < lo) return { want: brg + Math.PI - s * 40 * DEG, tel: 4 };
   // in band: angle ~55-65 deg off the bearing so all turrets bear but the belt is angled
   const ang = (ai.role === 'bb' ? 60 : 70) * DEG;
   return { want: brg + s * ang, tel: ai.role === 'bb' ? 3 : 4 };
}

// Spotted with several enemy guns in range: a destroyer should break contact, not cap.
function exposed(b, w) {
   if (!b.detected) return false;
   let n = 0;
   for (const e of w.ships) {
      if (!e.alive || e.side === b.side || e.type === 'TR' || !w.canSee(b.side, e)) continue;
      if (dist2(b.pos, e.pos) < Math.min(e.cfg.main.range, 11000) ** 2) n++;
   }
   return n >= 2;
}

function capGoal(b, w) {
   if (!w.caps.length) return null;
   const ai = b.ai;
   // a cap swarming with visible enemies (and few friends) is a death trap, not an objective
   const hot = (c) => {
      let foe = 0, own = 0;
      for (const s of w.ships) {
         if (!s.alive || s.type === 'TR' || s === b || dist2(s.pos, c.pos) > 6500 * 6500) continue;
         if (s.side === b.side) own++; else if (w.canSee(b.side, s)) foe++;
      }
      return foe >= own + 2;
   };
   let cap = ai.capId ? w.caps.find(c => c.id === ai.capId) : null;
   if (cap && cap.owner === b.side && !cap.contested && cap.capper == null) cap = null;
   if (cap && hot(cap)) cap = null;
   if (!cap && (ai.role === 'dd' || ai.role === 'cl' || !ai.target)) {
      let bd = Infinity;
      for (const c of w.caps) {
         if (c.owner === b.side && !c.contested) continue;
         if (hot(c)) continue;
         const dd = dist2(b.pos, c.pos);
         if (dd < bd) { bd = dd; cap = c; }
      }
      if (cap && ai.role !== 'dd' && bd > 7000 * 7000) cap = null;
   }
   return cap;
}

function searchGoal(b, w) {
   const hunt = b.ai.huntId != null ? w.shipById(b.ai.huntId) : null;
   if (hunt && hunt.alive) return hunt.pos;
   let best = null, bd = Infinity;
   for (const e of w.ships) {
      if (!e.alive || e.side === b.side || e.type === 'TR' && b.ai.role !== 'dd') continue;
      const p = b.side === 'player' ? (e.lastSeen || e.pos) : e.pos;   // allies use the team's intel
      const dd = dist2(b.pos, p);
      if (dd < bd) { bd = dd; best = p; }
   }
   if (best) return best;
   for (const e of w.ships) if (e.alive && e.side !== b.side) return e.pos;
   return { x: 0, y: 0 };
}

// Where is the danger? Averages visible enemy bearings (closer = heavier).
function threatVector(b, w) {
   let x = 0, y = 0, near = false;
   for (const e of w.ships) {
      if (!e.alive || e.side === b.side || e.type === 'TR' || !w.canSee(b.side, e)) continue;
      const dx = e.pos.x - b.pos.x, dy = e.pos.y - b.pos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 14000 * 14000) near = true;
      const k = 1 / Math.max(d2, 1e6);
      x += dx * k; y += dy * k;
   }
   const toward = Math.atan2(y, x);
   return { near, toward, away: toward + Math.PI };
}

// Keep ~800 m between friendly hulls so the AI does not stack into one torpedo lane.
function separation(b, w, want) {
   let px = 0, py = 0;
   for (const o of w.ships) {
      if (o === b || !o.alive || o.side !== b.side) continue;
      const dx = b.pos.x - o.pos.x, dy = b.pos.y - o.pos.y;
      const d2 = dx * dx + dy * dy;
      const R = 650 + (b.cfg.hull.L + o.cfg.hull.L);
      if (d2 > R * R || d2 < 1) continue;
      const k = (R - Math.sqrt(d2)) / R;
      px += dx / Math.sqrt(d2) * k; py += dy / Math.sqrt(d2) * k;
   }
   if (!px && !py) return want;
   const m = Math.hypot(px, py);
   const ax = Math.cos(want) + px / m * Math.min(1.2, m * 2), ay = Math.sin(want) + py / m * Math.min(1.2, m * 2);
   return Math.atan2(ay, ax);
}

// Pick the candidate heading nearest to `want` whose look-ahead line is clear of land and the
// arena edge.
function avoidTerrain(b, w, want) {
   const look = Math.max(1000, Math.abs(b.speed) * 22 + b.cfg.hull.L * 2);
   const lim = w.arena - 700, wall = w.arena - 60;
   const near = w.obstacles.filter(o => dist2(o.c, b.pos) < (look + (o.rMax || o.r * 1.6) + 200) ** 2);
   // candidate paths replay steer() with the real rudder shift and yaw inertia: a BB laid hard over
   // one way keeps swinging that way for ~10 s after the order (a straight ray or a fixed lag
   // distance let heavy ships commit to coasts)
   const turnR = b.cfg.turnR || 700, spd = Math.max(Math.abs(b.speed), 8);
   const shift = b.cfg.rudderShift || 8, lead = shift * 0.7 + 1.2, tau = b.type === 'BB' ? 3.2 : 2;
   const n = 14;
   // number of look-ahead steps that stay clear (n = the whole path)
   const clearSteps = (h, L) => {
      const ds = L / n, dt = ds / spd, kYaw = 1 - Math.exp(-dt / tau);
      let x = b.pos.x, y = b.pos.y, hd = b.heading, r = b.rudder, om = b.omega;
      for (let k = 1; k <= n; k++) {
         const err = angleDelta(hd + om * lead, h), a = Math.abs(err);
         const rc = a > 25 * DEG ? Math.sign(err) : a > 6 * DEG ? Math.sign(err) * 0.5 : 0;
         r += clamp(rc - r, -dt / shift, dt / shift);
         om += (spd / turnR * r - om) * kYaw;
         hd += om * dt;
         x += Math.cos(hd) * ds; y += Math.sin(hd) * ds;
         const p = { x, y };
         if (Math.abs(p.x) > lim || Math.abs(p.y) > lim) {
            // allow heading back inwards when already outside the limit; points are clamped to the
            // physical arena wall (ship.js) first: a hull pinned against the wall nose-first would
            // otherwise see every turn-out path "go further out" and stay boxed in there for good
            const ax = Math.min(Math.abs(p.x), wall), ay = Math.min(Math.abs(p.y), wall);
            if (ax > Math.abs(b.pos.x) + 1 && ax > lim) return k - 1;
            if (ay > Math.abs(b.pos.y) + 1 && ay > lim) return k - 1;
         }
         for (const o of near) if (obstacleT(o, p) < 1.12) return k - 1;
      }
      // already outside the limit: the path must end further in, or a nose-into-the-wall heading
      // passes (its clamped points never get further out than the pinned hull)
      const ex = Math.min(Math.abs(x), wall), ey = Math.min(Math.abs(y), wall);
      if (Math.abs(b.pos.x) > lim && ex > Math.abs(b.pos.x) - L * 0.15) return n >> 1;
      if (Math.abs(b.pos.y) > lim && ey > Math.abs(b.pos.y) - L * 0.15) return n >> 1;
      return n;
   };
   const clear = (h, L) => clearSteps(h, L) === n;
   // narrow channels: when nothing is clear at full look-ahead, accept shorter clear runs
   // before falling back (otherwise ships oscillate between two islands at crawl speed)
   // hysteresis: keep evading to the same side as last time, otherwise the pick flip-flops between
   // port and starboard every decision while the heavy hull never actually turns
   const ai = b.ai, side = ai.avoidSide || 1;
   const levels = [1, 0.55, 0.3];
   for (let li = 0; li < levels.length; li++) {
      for (const c0 of CANDIDATES) {
         const c = c0 * side;
         if (clear(want + c, look * levels[li])) {
            if (Math.abs(c) > 0.2) ai.avoidSide = Math.sign(c);
            ai.avoidLevel = li;
            return want + c;
         }
      }
   }
   ai.avoidLevel = 3;
   // boxed in (pocket between a coast and the arena wall, or a narrow bay): take the heading all
   // round the compass with the longest clear run, mildly preferring `want`. The old "away from
   // the island" / "toward the map centre" pick pointed straight at the coast in such pockets
   // and bots ground back and forth there for the rest of the match.
   // Outside the wall limit every short path of a slow heavy hull ties, so inward headings get a
   // bonus (otherwise the pick fell back to `want`, often straight through the wall).
   const inX = Math.abs(b.pos.x) > lim ? -Math.sign(b.pos.x) : 0, inY = Math.abs(b.pos.y) > lim ? -Math.sign(b.pos.y) : 0;
   let bestH = want, bestS = -Infinity;
   for (let i = 0; i < 24; i++) {
      const h = want + i * (TAU / 24);
      const sc = clearSteps(h, look * 0.6) - 2 * Math.abs(angleDelta(want, h)) / Math.PI +
         3 * (Math.cos(h) * inX + Math.sin(h) * inY);
      if (sc > bestS) { bestS = sc; bestH = h; }
   }
   return bestH;
}

// Torpedo dodge: predicts closest approach of each visible enemy torpedo and turns parallel.
function checkTorpedoes(b, w, d) {
   const ai = b.ai;
   if (ai.dodgeT > 0) return;
   const reach = b.cfg.hull.L * 0.55 + 40;
   for (const t of w.torpedoes) {
      if (!t.alive || t.side === b.side || !t.visibleToOpp || ai.dodged.has(t.id)) continue;
      const rvx = Math.cos(t.heading) * t.speed - b.vel.x, rvy = Math.sin(t.heading) * t.speed - b.vel.y;
      const rx = t.pos.x - b.pos.x, ry = t.pos.y - b.pos.y;
      const v2 = rvx * rvx + rvy * rvy || 1;
      const tc = -(rx * rvx + ry * rvy) / v2;
      if (tc < 0 || tc > 30) continue;
      const cx = rx + rvx * tc, cy = ry + rvy * tc;
      if (cx * cx + cy * cy > reach * reach) continue;
      ai.dodged.add(t.id);
      if (w.rng() > d.dodge) continue;
      // comb the track: turn to whichever parallel heading needs less rudder
      const h1 = t.heading, h2 = t.heading + Math.PI;
      ai.dodgeHeading = Math.abs(angleDelta(b.heading, h1)) < Math.abs(angleDelta(b.heading, h2)) ? h1 : h2;
      ai.dodgeT = 7;
      if (b.consumable('boost')) b.useConsumable(w, 'boost');
      return;
   }
}

// Rudder controller with lag anticipation: uses the yaw rate to predict where the bow will
// settle, so heavy ships start counter-rudder early instead of overshooting.
function steer(b, dt) {
   const ai = b.ai;
   b.setTelegraph(ai.tel);
   if (ai.rudderOverride != null) { b.setRudder(ai.rudderOverride); return; }
   const lead = b.cfg.rudderShift * 0.7 + 1.2;
   let err = angleDelta(b.heading + b.omega * lead, ai.desired);
   // astern steering only while ordered astern: a ship still backing after a reverse order already
   // wants the rudder laid for the coming ahead leg (rudder shifts are slow)
   if (b.speed < 0 && b.telegraph < 0) err = -err;
   const a = Math.abs(err);
   b.setRudder(a > 25 * DEG ? Math.sign(err) * 2 : a > 6 * DEG ? Math.sign(err) : a > 1.5 * DEG ? Math.sign(err) * (b.type === 'DD' ? 1 : 0) : 0);
}

// ---------------------------------------------------------------- weapons
function gunnery(b, w, d, dt) {
   const ai = b.ai, tgt = ai.target;
   if (!tgt || !tgt.alive || !w.canSee(b.side, tgt)) { b.aimPoint = null; return; }
   const m = b.cfg.main;
   const dd = Math.sqrt(dist2(b.pos, tgt.pos));
   // DDs hold fire while hidden unless they duel another DD (gun bloom would reveal them)
   if (ai.role === 'dd' && !b.detected && tgt.type !== 'DD' && b.torps && b.torps.launchers.some(l => l.reload <= 2)) { b.aimPoint = tgtLead(b, tgt, d, dd); return; }
   const aim = tgtLead(b, tgt, d, dd);
   b.aimPoint = aim;
   if (dd > m.range || w.time - ai.targetSince < d.reaction) return;
   // ammo choice (re-evaluated every 8 s so the reload penalty is not paid constantly)
   ai.ammoT -= dt;
   if (ai.ammoT <= 0 && m.ap && m.he) {
      ai.ammoT = 8;
      const aspect = Math.abs(Math.sin(angleDelta(tgt.heading, Math.atan2(b.pos.y - tgt.pos.y, b.pos.x - tgt.pos.x))));
      let want = 'HE';
      if (tgt.type === 'BB' || tgt.type === 'CA' || tgt.type === 'CL') {
         const apOK = m.caliber >= 280 ? (aspect > 0.45 || dd < 9000) : (aspect > 0.7 && dd < 10000 && tgt.type !== 'BB');
         if (apOK) want = 'AP';
      }
      if (b.cfg.main.he == null) want = 'AP';
      if (want !== b.ammo && w.rng() < 0.6 + 0.4 * d.smarts) b.setAmmo(want);
   }
   let ready = 0, bearers = 0, longWait = true;
   for (const t of b.turrets) {
      if (!t.alive || !t.canBear) continue;
      bearers++;
      if (t.reload <= 0 && t.err <= WORLD.FIRE_TOL) ready++;
      else if (t.reload > 0 && t.reload < 3) longWait = false;
   }
   if (!ready || (ready < Math.ceil(bearers * 0.6) && !longWait)) return;
   if (b.fireMain(w, aim) > 0) { ai.salvoCount++; newAimError(b, w); }
}
function tgtLead(b, tgt, d, dd) {
   const t = flightTime(b.cfg.main, Math.min(dd, b.cfg.main.range));
   const k = d.lead * t;
   const e = b.ai.aimErr, bx = (tgt.pos.x - b.pos.x) / (dd || 1), by = (tgt.pos.y - b.pos.y) / (dd || 1);
   return {
      x: tgt.pos.x + tgt.vel.x * k + bx * e.r * dd - by * e.l * dd,
      y: tgt.pos.y + tgt.vel.y * k + by * e.r * dd + bx * e.l * dd,
   };
}

function torpedoes(b, w, dt) {
   const ai = b.ai;
   if (!b.torps) return;
   ai.torpT -= dt;
   if (ai.torpT > 0) return;
   ai.torpT = 0.8;
   const tgt = ai.target;
   if (!tgt || !tgt.alive || !w.canSee(b.side, tgt)) return;
   const tc = b.cfg.torp;
   const dd = Math.sqrt(dist2(b.pos, tgt.pos));
   if (dd > tc.range * (ai.role === 'dd' ? 0.85 : 0.7) || dd < 900) return;
   const ip = interceptPoint(b.pos, tc.speed, tgt.pos, tgt.vel);
   if (!ip || ip.t * tc.speed > tc.range * 0.95) return;
   // light error so spreads are not laser-perfect
   const brg = Math.atan2(ip.y - b.pos.y, ip.x - b.pos.x) + gaussR(w.rng) * w.difficulty.aimErr * 1.5;
   // never through friendlies
   for (const o of w.ships) {
      if (o === b || !o.alive || o.side !== b.side) continue;
      const od = Math.sqrt(dist2(b.pos, o.pos));
      if (od > dd + 1500) continue;
      const ob = Math.atan2(o.pos.y - b.pos.y, o.pos.x - b.pos.x);
      if (Math.abs(angleDelta(brg, ob)) < Math.atan2(o.cfg.hull.L * 0.5 + 300, od)) return;
   }
   if (!b.torpLauncherFor(brg)) return;
   b.setTorpSpread(dd > tc.range * 0.5 ? 'wide' : 'narrow');
   if (b.fireTorpedoes(w, brg) > 0) ai.torpT = 2.5;
}

function consumables(b, w, d) {
   const ai = b.ai, hpF = b.hp / b.maxHP;
   if (w.rng() > 0.35 + 0.65 * d.smarts) return;           // dumber captains react late
   const has = (k) => { const c = b.consumable(k); return c && !c.active && c.cd <= 0 && c.charges > 0; };
   if (has('damageControl') && (b.fires.length >= 2 || b.floods.length || (b.fires.length && hpF < 0.5) || b.modules.rudder > 0 || b.modules.engine > 0)) b.useConsumable(w, 'damageControl');
   if (has('repair') && hpF < 0.65 && b.healPool > b.maxHP * 0.12 && b.fires.length < 2) b.useConsumable(w, 'repair');
   const underFire = w.time - b.lastHitT < 6;
   if (has('smoke') && b.detected && (ai.role === 'dd' || ai.role === 'cl') && (underFire || hpF < 0.5) && ai.target) b.useConsumable(w, 'smoke');
   if (has('smoke') && ai.convoy === undefined && ai.escortId != null && underFire) b.useConsumable(w, 'smoke');
   if (has('hydro') || has('radar')) {
      let nearHidden = false;
      for (const e of w.ships) {
         if (!e.alive || e.side === b.side) continue;
         const dd = Math.sqrt(dist2(b.pos, e.pos));
         const r = has('radar') ? b.consumable('radar').range : b.consumable('hydro').range;
         if (dd < r * 0.9 && (!e.detected || e.inSmoke)) { nearHidden = true; break; }
      }
      if (nearHidden) b.useConsumable(w, has('radar') ? 'radar' : 'hydro');
   }
   if (has('boost') && (ai.retreating || ai.breakOff || (ai.role === 'dd' && w.caps.length && w.time < 90))) b.useConsumable(w, 'boost');
}
