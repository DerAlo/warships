// gamev2/ai_missile.js — V2: what a bot captain does with missiles, rockets and soft kill. Called
// from ai.js (think). Deliberately simple rules:
//    - anti-ship missiles: at the best enemy ship its side holds a fire-control track on, inside
//      range and with a free line over the sea (skimmers); a salvo sized to the target's defences,
//      then a pause; a target a team-mate is firing at is preferred
//    - rockets (swarm boats): a salvo at the gun target once it is inside rocket range
//    - decoys when a seeker is heard (ship.seekerWarn), the jammer when missiles are tracked inbound
import { MISSILES } from './config.js';
import { ssmBlock, ssmType, launchSSM, fireRockets, rocketState, threatsTo } from './missile.js';

const SALVO_MAX = 6;

// How many missiles a bot spends on target T: one more than half its SAM channels and gun mounts.
function salvoFor(T) {
   const W = T.cfg.weapons || {};
   let ch = 0;
   for (const s of W.sam || []) ch += s.ch;
   return Math.min(SALVO_MAX, Math.max(1, 1 + Math.round(ch / 2 + (W.ciws ? W.ciws.n : 0) / 2)));
}

function pickSsmTarget(b, w, c) {
   let best = null, bestS = 0;
   for (const e of w.ships) {
      if (!e.alive || e.side === b.side || !e.targetable || e.depth > 0) continue;
      const d = Math.hypot(e.pos.x - b.pos.x, e.pos.y - b.pos.y);
      if (d > c.range * 0.92 || d < 1500) continue;
      if (c.skim && w.losBlocked(b.pos, e.pos)) continue;
      if (e.maxHP < c.dmg * 0.25) continue;                 // not worth a missile (speedboats)
      let s = (e.cfg.ai.value || 40) / (1 + d / 20000);
      if (e === b.ai.target || e.id === b.ai.huntId) s *= 1.5;
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
   if (ai.ssmT > 0) return;
   ai.ssmT = 1.3;
   const type = ssmType(b), c = type && MISSILES[type];
   if (!c || !(b.mag[type] > 0)) { ai.ssmT = 15; return; }
   let T = ai.ssmLeft > 0 ? w.shipById(ai.ssmTgt) : null;
   if (T && ssmBlock(w, b, { targetId: T.id }, type)) T = null;
   if (!T) {
      T = pickSsmTarget(b, w, c);
      if (!T) { ai.ssmLeft = 0; ai.ssmT = 2 + w.rng() * 2; return; }
      ai.ssmTgt = T.id;
      ai.ssmLeft = Math.min(b.mag[type], Math.max(1, Math.round(salvoFor(T) * (0.6 + 0.4 * d.smarts))));
   }
   if (!launchSSM(w, b, { targetId: T.id }, type)) return;
   ai.ssmAt = w.time;
   if (--ai.ssmLeft <= 0) ai.ssmT = (24 + w.rng() * 16) / (0.6 + 0.4 * d.smarts);
}

export function botSoftKill(b, w, d) {
   const ai = b.ai;
   if (!b.seekerWarn && !w.missiles.length) return;
   if ((ai.softT || 0) > w.time) return;
   ai.softT = w.time + 0.5 + (1 - d.smarts) * 1.5;        // dumber captains react late
   const has = (k) => { const c = b.consumable(k); return c && !c.active && c.cd <= 0 && c.charges > 0; };
   if (b.seekerWarn && w.time - b.seekerWarn.t < 1.5 && has('decoy')) { b.useConsumable(w, 'decoy'); return; }
   if (has('jammer') && threatsTo(w, b).some(t => t.tti < 25)) b.useConsumable(w, 'jammer');
}
