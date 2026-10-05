// gamev2/ai_missile.js — V2: what a bot captain does with missiles, rockets and soft kill. Called
// from ai.js (think). Deliberately simple rules:
//    - anti-ship missiles: at the best enemy ship its side holds a fire-control track on, inside
//      range and with a free line over the sea (skimmers); a salvo sized to the target's defences,
//      then a pause; a target a team-mate is firing at is preferred
//    - strike coordination (world.strike[side] = { id, t }): the captain who opens a salvo marks the
//      target; from difficulty "normal" up every team-mate with a track and rounds joins at once,
//      so the missiles of several ships arrive together and saturate the defence
//    - rockets (swarm boats): a salvo at the gun target once it is inside rocket range
//    - decoys when a seeker is heard (ship.seekerWarn), the jammer when missiles are tracked inbound
import { MISSILES } from './config.js';
import { ssmBlock, ssmType, launchSSM, fireRockets, rocketState, threatsTo } from './missile.js';

const SALVO_MAX = 8;
const JOIN_T = 10;                   // s a strike call stays open for team-mates

// How many missiles a bot spends on target T: two more than half its SAM channels plus its gun mounts.
export function salvoFor(T) {
   const W = T.cfg.weapons || {};
   let ch = 0;
   for (const s of W.sam || []) ch += s.ch;
   return Math.min(SALVO_MAX, Math.max(2, 2 + Math.round(ch / 2 + (W.ciws ? W.ciws.n : 0))));
}

function pickSsmTarget(b, w, c, call) {
   let best = null, bestS = 0;
   for (const e of w.ships) {
      if (!e.alive || e.side === b.side || !e.targetable || e.depth > 0) continue;
      const d = Math.hypot(e.pos.x - b.pos.x, e.pos.y - b.pos.y);
      if (d > c.range * 0.92 || d < 1500) continue;
      if (c.skim && w.losBlocked(b.pos, e.pos)) continue;
      if (e.maxHP < c.dmg * 0.25) continue;                 // not worth a missile (speedboats)
      let s = (e.cfg.ai.value || 40) / (1 + d / 20000);
      if (e === b.ai.target || e.id === b.ai.huntId) s *= 1.5;
      if (call && call.id === e.id) s *= 3;
      // join a salvo a team-mate has just fired: single missiles are stopped, salvos saturate
      for (const o of w.ships) if (o !== b && o.alive && o.side === b.side && o.ai && o.ai.ssmTgt === e.id && w.time - (o.ai.ssmAt ?? -99) < 15) { s *= 1.8; break; }
      if (s > bestS) { bestS = s; best = e; }
   }
   return best;
}

export function botMissiles(b, w, d, dt) {
   const ai = b.ai, W = b.cfg.weapons;
   if (!W) return;
   if (W.rockets) {
      const T = ai.target, st = rocketState(b);
      if (T && T.alive && w.time >= st.readyT && w.canSee(b.side, T)) {
         const dd = Math.hypot(T.pos.x - b.pos.x, T.pos.y - b.pos.y), tf = dd / W.rockets.speed;
         if (dd < W.rockets.range * 0.9) fireRockets(w, b, { x: T.pos.x + T.vel.x * tf * d.lead, y: T.pos.y + T.vel.y * tf * d.lead });
      }
   }
   if (!W.ssm || !W.ssm.length || b.depth > 0) return;
   ai.ssmT = (ai.ssmT ?? 6 + w.rng() * 8) - dt;
   // a team-mate has just called a strike: join it now instead of waiting out the own pause
   const call = d.smarts >= 0.8 && w.strike ? w.strike[b.side] : null;
   const open = call && w.time - call.t < JOIN_T ? call : null;
   if (open && ai.joined !== open.t && ai.ssmT > 0 && !(ai.ssmLeft > 0)) { ai.joined = open.t; ai.ssmT = w.rng() * 0.6 * (2 - d.smarts); }
   if (ai.ssmT > 0) return;
   ai.ssmT = 1.3;
   const type = ssmType(b), c = type && MISSILES[type];
   if (!c || !(b.mag[type] > 0)) { ai.ssmT = 15; return; }
   let T = ai.ssmLeft > 0 ? w.shipById(ai.ssmTgt) : null;
   if (T && ssmBlock(w, b, { targetId: T.id }, type)) T = null;
   if (!T) {
      T = pickSsmTarget(b, w, c, open);
      if (!T) { ai.ssmLeft = 0; ai.ssmT = 2 + w.rng() * 2; return; }
      ai.ssmTgt = T.id;
      ai.ssmLeft = Math.min(b.mag[type], Math.max(1, Math.round(salvoFor(T) * (0.4 + 0.6 * d.smarts))));
      if (!open || open.id !== T.id) (w.strike || (w.strike = {}))[b.side] = { id: T.id, t: w.time };
      ai.joined = w.strike[b.side].t;
   }
   if (!launchSSM(w, b, { targetId: T.id }, type)) return;
   ai.ssmAt = w.time;
   if (--ai.ssmLeft <= 0) ai.ssmT = (22 + w.rng() * 14) / (0.3 + 0.7 * d.smarts);
}

export function botSoftKill(b, w, d) {
   const ai = b.ai;
   if (!b.seekerWarn && !w.missiles.length) return;
   if ((ai.softT || 0) > w.time) return;
   ai.softT = w.time + 0.5 + (1 - d.smarts) * 1.5;        // dumber captains react late
   const has = (k) => { const c = b.consumable(k); return c && !c.active && c.cd <= 0 && c.charges > 0; };
   // (an easy captain misses every second seeker warning)
   if (b.seekerWarn && w.time - b.seekerWarn.t < 1.5 && has('decoy') && (d.smarts >= 0.8 || w.rng() < 0.5)) { b.useConsumable(w, 'decoy'); return; }
   if (has('jammer') && threatsTo(w, b).some(t => t.tti < 25)) b.useConsumable(w, 'jammer');
}
