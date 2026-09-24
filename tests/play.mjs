// tests/play.mjs — headless full-game "playthrough": a simple bot drives the Bismarck,
// we watch a whole match unfold and report what happened. Balance & AI sanity probe for the
// free battle, every campaign mission (with star rating) and the survival mode.
import { World } from '../game/state.js';
import { updateBot } from '../game/ai.js';
import { angleOf, angleDelta, sub, dist, clamp, TAU } from '../game/utils.js';
import { WORLD } from '../game/config.js';
import { MISSIONS, SURVIVAL, missionById } from '../game/missions.js';

const DT = 1 / 60;

// ---- competent player controller: lead the target, pick AP/HE, hold range, evade under fire,
// use consumables like a human would (with reaction delays), launch torpedoes when abeam ----
function controlPlayer(w, dt) {
   const p = w.player;
   if (!p.alive) return;
   // the player only knows what is spotted; a hidden enemy is chased at its last known position
   let target = null, bestD = Infinity;
   for (const b of w.bots) {
      if (!b.alive) continue;
      const known = b.visible ? b.pos : (b.lastKnown && w.time - b.lastKnown.t < 15 ? b.lastKnown.pos : null);
      const pinged = b.cls === 'SUB' && p.cfg.sonar && dist(p.pos, b.pos) < p.cfg.sonar.range;
      if (!known && !pinged) continue;
      const kp = known || b.pos;
      // an escort mission: go for whoever is closing on the freighters
      const raiding = w.allies.some(x => x.alive && x.tag && dist(x.pos, b.pos) < 1300);
      const d = dist(p.pos, kp) + (b.visible ? 0 : 800) - (b.tag ? 1200 : 0) - (raiding ? 700 : 0)
         + (b.depth >= 0.5 ? 900 : 0);   // surface targets first; the dived boat is hunted when nothing else is near
      if (d < bestD) { bestD = d; target = b; }
   }
   if (!target) {
      // nothing spotted: sweep toward the nearest enemy's rough area (a player reads the minimap)
      for (const b of w.bots) if (b.alive && dist(p.pos, b.pos) < bestD) { bestD = dist(p.pos, b.pos); target = b; }
      if (!target) return;
   }
   const tPos = target.visible ? target.pos : (target.lastKnown ? target.lastKnown.pos : target.pos);
   const tVel = target.visible ? target.vel : { x: 0, y: 0 };
   bestD = dist(p.pos, tPos);
   p._tgt = target; p._tgtD = bestD;

   // --- aim with lead: predict where the target will be when the shell arrives ---
   const vShell = p.mainShell().vShell || 650;
   const tof = bestD / vShell;
   const pred = { x: tPos.x + tVel.x * tof, y: tPos.y + tVel.y * tof };
   const aimBearing = angleOf({ x: pred.x - p.pos.x, y: pred.y - p.pos.y });
   p.aimBearing = aimBearing;
   p.aim = { x: Math.cos(aimBearing), y: Math.sin(aimBearing) };

   // --- ammo: HE for destroyers and bow-on targets, AP for broadsides (10 s hysteresis) ---
   p._ammoCd = (p._ammoCd || 0) - dt;
   if (target.visible && p._ammoCd <= 0) {
      const rel = Math.abs(Math.sin(target.heading - angleOf(sub(target.pos, p.pos))));
      const want = target.cls === 'DD' || rel < 0.45 ? 'HE' : 'AP';
      if (p.setAmmo(want)) p._ammoCd = 10;
   }

   // --- evasion: if under fire, swing hard away from the threat; else cross broadside ---
   const threat = w.nearestThreatPos(p);
   const underFire = w.nearestThreat(p) < 500;
   let want;
   const barrage = w.barrages.find(b => dist(b.pos, p.pos) < b.r + 120);
   // an incoming torpedo a human would have seen (wake visible, ~1.5 s to react) whose track
   // passes close ahead: comb it -- turn parallel to its run, whichever way is the smaller turn
   let comb = null;
   for (const t of w.torpedoes) {
      if (!t.alive || t.owner === p.side || t.age < 1.5) continue;
      const rx = p.pos.x - t.pos.x, ry = p.pos.y - t.pos.y;
      const along = (rx * t.vel.x + ry * t.vel.y) / t.speed;
      if (along < 0 || along > 750) continue;
      const cross = Math.abs(rx * t.vel.y - ry * t.vel.x) / t.speed;
      if (cross < 160) { comb = t; break; }
   }
   if (comb && !barrage) {
      want = Math.abs(angleDelta(p.heading, comb.dir)) < Math.PI / 2 ? comb.dir : comb.dir + Math.PI;
   } else if (barrage) {
      want = angleOf(sub(p.pos, barrage.pos));   // leave the telegraphed circle
   } else if (underFire) {
      const away = angleOf({ x: p.pos.x - threat.x, y: p.pos.y - threat.y });
      want = away + 0.6; // turn away AND off the line
   } else if (bestD > p.cfg.main.range) {
      // out of gun range entirely: close in straight -- crossing broadside here just
      // holds a stable stand-off distance against a target that never gets shot at,
      // which can loop forever once only one far-off straggler is left alive.
      want = angleOf(sub(target.pos, p.pos));
   } else {
      const bearing = angleOf(sub(target.pos, p.pos));
      want = bearing + 0.5 * Math.sign(Math.sin(bearing - p.heading) || 1);
   }
   // steer clear of islands (a human just looks and avoids them; without this the
   // script drives face-first into rock and crawls at reef speed for the rest of the match).
   // Blend via angleDelta, not raw arithmetic -- averaging angles directly breaks at the +-180 wrap.
   // Buffer scales with actual TURN RADIUS (v/turnRate), same reasoning as ai.js's
   // avoidObstacles -- a fixed/speed-only buffer badly underestimates how much room a ship
   // needs once it's going fast but its angular turn rate hasn't grown to match. Steer
   // TANGENTIALLY (perpendicular to the obstacle), not radially away -- at a turn radius
   // this large, "point directly away" flips direction as the ship passes the obstacle's
   // center and oscillates instead of curving cleanly around it (same fix as ai.js).
   // Use maxSpeed, not current speed -- a collision-stalled ship at speed~0 would otherwise
   // compute a near-zero buffer, steer straight back at the obstacle, and stay stuck forever
   // (same fix as ai.js's avoidObstacles).
   // Capped (not just scaled): turn radius alone reached 900-1400m once ship speeds
   // tripled, which on a 3800m arena with 7 obstacles meant avoidance was "in range"
   // almost everywhere and permanently overrode combat steering (same fix as ai.js).
   const turnRadius = p.maxSpeed / Math.max(0.05, p.cfg.turnRate || 0.2);
   const obsBuf = clamp(turnRadius * 1.1, 350, 550);
   for (const o of w.obstacles) {
      const d = dist(p.pos, o.c);
      const buf = o.r + obsBuf;
      if (d < buf) {
         const toObs = angleOf({ x: o.c.x - p.pos.x, y: o.c.y - p.pos.y });
         const perpCW = toObs + Math.PI / 2, perpCCW = toObs - Math.PI / 2;
         const away = Math.abs(angleDelta(p.heading, perpCW)) < Math.abs(angleDelta(p.heading, perpCCW))
            ? perpCW : perpCCW;
         const wgt = 1 - d / buf;
         want = want + angleDelta(want, away) * wgt;
      }
   }
   // steer clear of the arena wall too -- otherwise driving nearly bow-on into the edge
   // clamps position and halves speed every frame (ship.js), a stable near-standstill
   // that never resolves on its own and stalls the match at the wall forever.
   {
      const half = WORLD.ARENA, edgeBuf = clamp(turnRadius * 1.3, 400, 700);
      const edgeD = half - Math.max(Math.abs(p.pos.x), Math.abs(p.pos.y));
      if (edgeD < edgeBuf) {
         const toCenter = angleOf({ x: -p.pos.x, y: -p.pos.y });
         const wgt = 1 - Math.max(0, edgeD) / edgeBuf;
         want = want + angleDelta(want, toCenter) * wgt;
      }
   }
   const hunting = target.cls === 'SUB' && target.depth >= 0.5 && !barrage && !comb;
   if (hunting) want = angleOf(sub(target.pos, p.pos));
   p.helm = clamp(angleDelta(p.heading, want) * 2.2, -1, 1);
   p.throttleIn = hunting ? 1 : bestD > 1500 ? 1 : bestD < 1000 ? -0.3 : 0.5;
   // pinned against a shore with no way on (a ship cannot turn at a standstill): drive the other
   // way for a few seconds -- astern with the rudder reversed, or ahead if it backed into the rock
   if (!(p._reverseT > 0)) {
      p._stuckT = Math.abs(p.throttleIn) > 0.2 && Math.abs(p.speed) < 4 ? (p._stuckT || 0) + dt : 0;
      if (p._stuckT > 2.5) { p._reverseT = 4; p._unstickDir = p.throttleIn > 0 ? -1 : 1; p._stuckT = 0; }
   }
   if (p._reverseT > 0) {
      p._reverseT -= dt;
      p.throttleIn = p._unstickDir;
      if (p._unstickDir < 0) p.helm = -p.helm;
   }

   // --- consumables, gated by a human reaction delay ---
   p._consCd = (p._consCd || 0) - dt;
   if (p._consCd <= 0) {
      const burning = p.fires.length + 2 * p.floods.length;
      if (burning >= 2 && p.useConsumable('dc')) p._consCd = 1.5;
      else if (p.hp < p.maxHP * 0.6 && p.healable > p.maxHP * 0.12 && p.useConsumable('repair')) p._consCd = 1.5;
      else if (p.hp < p.maxHP * 0.3 && underFire && p.useConsumable('smoke')) p._consCd = 1.5;
      else if ((bestD > 1800 || barrage) && p.useConsumable('boost')) p._consCd = 1.5;
      else if (p.cons.dcharge && w.bots.some(b => b.alive && b.cls === 'SUB' && dist(b.pos, p.pos) < 260) && p.useConsumable('dcharge')) p._consCd = 1.5;
      else if (w.env.night && !target.visible && bestD < 2400 && p.cons.flare && p.useConsumable('flare', tPos)) p._consCd = 4;
   }

   // --- fire: full salvo at the led aim point (blind into smoke at the ghost, too) ---
   if (!hunting && bestD < p.cfg.main.range && p.fireTimer <= 0) p.fireMain(w, null, p.aim, { aimPoint: pred });
   // --- torpedoes when the target is abeam and close ---
   if (p.cfg.torp && target.visible && bestD < p.cfg.torp.range * 0.7) {
      const l = p.launcherFor(aimBearing);
      if (l && l.cd <= 0) p.fireTorpedo(w, null, p.aim);
   }
   // secondaries and AA fire on their own (ship.js)
}

function play(difficulty, maxSec = 600, missionId = null, seed = null) {
   const m = missionId ? missionById(missionId) : null;
   const w = new World(difficulty, m && m.survival ? (seed ?? 1) : null, m);
   const t0 = Date.now();
   let steps = 0;
   const log = [];
   let lastKillT = -1;
   const taken = {};   // damage the Bismarck took, by attacker class + hit type (fires/floods excluded)
   while (w.phase === 'playing' && w.time < maxSec) {
      controlPlayer(w, DT);
      for (const b of w.bots) if (b.alive) updateBot(b, w, DT);
      for (const a of w.allies) if (a.alive) updateBot(a, w, DT);
      w.update(DT);
      steps++;
      // TRACE=1: a 10 s heartbeat of where the scripted player is and what it is after
      if (process.env.TRACE && steps % 600 === 0) {
         const p = w.player, t = p._tgt;
         console.log(`  [${w.time.toFixed(0)}s] pos ${Math.round(p.pos.x)},${Math.round(p.pos.y)} v${Math.round(p.speed)} hp${Math.round(p.hp)} tgt ${t ? t.cls + (t.visible ? '' : '?') + ' @' + Math.round(p._tgtD) : '-'} shots ${p.shotsFired} thr ${(p.throttleIn ?? 0).toFixed(2)}/${p.throttle.toFixed(2)} st ${(p._stuckT || 0).toFixed(1)} rv ${(p._reverseT || 0).toFixed(1)} anc ${!!p.anchorOut}`);
      }
      for (const ev of w.events) {
         if (ev.kind === 'hit' && ev.target === w.player && ev.dmg > 0) {
            const k = (ev.shooter ? ev.shooter.cls : '?') + ':' + ev.outcome;
            taken[k] = (taken[k] || 0) + Math.round(ev.dmg);
         } else if (ev.kind === 'hit' && ev.target.side === 'player' && ev.target.tag && ev.dmg > 0) {
            const k = 'Geleit<-' + (ev.shooter ? ev.shooter.cls : '?') + ':' + ev.outcome;
            taken[k] = (taken[k] || 0) + Math.round(ev.dmg);
         }
         if (ev.kind === 'sink' && ev.t !== lastKillT) {
            lastKillT = ev.t;
            log.push(`t=${ev.t.toFixed(0)}s ${ev.ship.name} (${ev.ship.cls}) ${ev.ship.side === 'enemy' ? 'versenkt' : 'VERLOREN'}`);
         } else if (ev.kind === 'escaped' || ev.kind === 'arrived') {
            log.push(`t=${w.time.toFixed(0)}s ${ev.ship ? ev.ship.name : ''} ${ev.kind === 'escaped' ? 'entkommen' : 'angekommen'}`);
         }
      }
      w.events.length = 0;
   }
   const wallMs = Date.now() - t0;
   const p = w.player;
   const summary = {
      difficulty,
      mission: missionId || 'skirmish',
      phase: w.phase,
      reason: w.endReason || '',
      stars: w.director && !w.director.survival ? w.director.stars() : null,
      wave: w.director && w.director.survival ? w.director.wave : null,
      score: w.director && w.director.survival ? w.director.score : null,
      time: Math.round(w.time),
      kills: w.killCount,
      totalBots: w.bots.length,
      playerHP: `${Math.round((p.hp / p.maxHP) * 100)}%`,
      playerDmgDealt: Math.round(p.dmgDealt),
      playerDmgTaken: Math.round(p.dmgTaken),
      playerShots: p.shotsFired,
      botShots: w.bots.reduce((a, b) => a + b.shotsFired, 0),
      botStates: {},
      taken,
      wallMs,
      log,
   };
   for (const b of w.bots) summary.botStates[b.state] = (summary.botStates[b.state] || 0) + 1;
   return summary;
}

// ---- runner ----
// `node tests/play.mjs`             -> one detailed free battle per difficulty (kill timeline)
// `node tests/play.mjs <N>`         -> N free battles per difficulty, aggregated win-rate + stats
// `node tests/play.mjs missions [N] [diff]` -> every campaign mission + survival, N runs each
// `node tests/play.mjs m5 [N] [diff]` -> one mission in detail (N=1) or aggregated
const arg = process.argv[2] || '1';
const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

function detail(s) {
   console.log(`Ergebnis: ${s.phase} nach ${s.time}s | Kills ${s.kills}/${s.totalBots} | Bismarck HP ${s.playerHP}` +
      (s.stars != null ? ` | Sterne ${s.stars}` : '') + (s.wave != null ? ` | Welle ${s.wave}, ${s.score} Pkt` : ''));
   if (s.reason) console.log('  ' + s.reason);
   console.log(`Schaden: gegeben ${s.playerDmgDealt} / erlitten ${s.playerDmgTaken} | Schüsse: Spieler ${s.playerShots}, Bots ${s.botShots}`);
   console.log('Erlitten nach Quelle: ' + Object.entries(s.taken).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v).join(', '));
   console.log(`Bot-Endzustände: ${JSON.stringify(s.botStates)} | Sim-Zeit ${s.wallMs}ms`);
   for (const l of s.log) console.log('  ' + l);
}
function aggregate(label, runs) {
   const n = runs.length;
   const wins = runs.filter(r => r.phase === 'won').length, losses = runs.filter(r => r.phase === 'lost').length;
   const stars = runs.filter(r => r.stars != null).map(r => r.stars);
   const waves = runs.filter(r => r.wave != null).map(r => r.wave);
   console.log(`${label.padEnd(24)} Sieg ${wins}/${n}  Niederl. ${losses}  Timeout ${n - wins - losses}  Ø ${Math.round(avg(runs.map(r => r.time)))}s  Ø HP ${Math.round(avg(runs.map(r => parseFloat(r.playerHP))))}%` +
      (stars.length ? `  Ø Sterne ${avg(stars).toFixed(1)}` : '') + (waves.length ? `  Ø Welle ${avg(waves).toFixed(1)}` : ''));
}

if (arg === 'missions') {
   const N = Math.max(1, parseInt(process.argv[3] || '1', 10));
   const diff = process.argv[4] || 'normal';
   for (const m of [...MISSIONS, SURVIVAL]) {
      const runs = [];
      for (let i = 0; i < N; i++) runs.push(play(diff, m.survival ? 480 : 600, m.id, 1 + i));
      aggregate(`${m.id} ${m.title} (${diff})`, runs);
   }
} else if (/^m\d+$|^survival$/.test(arg)) {
   const N = Math.max(1, parseInt(process.argv[3] || '1', 10));
   const diff = process.argv[4] || 'normal';
   if (N === 1) { console.log(`\n=== ${arg} (${diff}) ===`); detail(play(diff, 600, arg)); }
   else aggregate(`${arg} (${diff})`, Array.from({ length: N }, (_, i) => play(diff, 600, arg, 1 + i)));
} else {
   const N = Math.max(1, parseInt(arg, 10));
   if (N === 1) {
      for (const diff of ['easy', 'normal', 'hard']) { console.log(`\n=== ${diff.toUpperCase()} ===`); detail(play(diff)); }
   } else {
      for (const diff of ['easy', 'normal', 'hard']) {
         const t0 = Date.now();
         const runs = Array.from({ length: N }, () => play(diff));
         aggregate(`${diff} (${N} Läufe, ${Date.now() - t0}ms)`, runs);
         console.log(`   Ø Schaden: gegeben ${Math.round(avg(runs.map(r => r.playerDmgDealt)))} / erlitten ${Math.round(avg(runs.map(r => r.playerDmgTaken)))}`);
      }
   }
}
