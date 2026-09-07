// tests/play.mjs — headless full-game "playthrough": a simple bot drives the Bismarck,
// we watch a whole match unfold and report what happened. Balance & AI sanity probe.
import { World } from '../game/state.js';
import { updateBot } from '../game/ai.js';
import { angleOf, angleDelta, sub, dist, clamp, TAU } from '../game/utils.js';
import { WORLD } from '../game/config.js';

const DT = 1 / 60;

// ---- competent player controller: lead the target, hold range, evade under fire, smoke when hurt ----
function controlPlayer(w, dt) {
   const p = w.player;
   if (!p.alive) return;
   let target = null, bestD = Infinity;
   for (const b of w.bots) {
      if (!b.alive) continue;
      const d = dist(p.pos, b.pos);
      if (d < bestD) { bestD = d; target = b; }
   }
   if (!target) return;

   // --- aim with lead: predict where the target will be when the shell arrives ---
   const vShell = p.cfg.main.vShell || 650;
   const tof = bestD / vShell;
   const predX = target.pos.x + target.vel.x * tof;
   const predY = target.pos.y + target.vel.y * tof;
   const aimBearing = angleOf({ x: predX - p.pos.x, y: predY - p.pos.y });
   p.aimBearing = aimBearing;
   p.aim = { x: Math.cos(aimBearing), y: Math.sin(aimBearing) };

   // --- evasion: if under fire, swing hard away from the threat; else cross broadside ---
   const threat = w.nearestThreatPos(p);
   const underFire = w.nearestThreat(p) < 500;
   let want;
   if (underFire) {
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
   p.helm = clamp(angleDelta(p.heading, want) * 2.2, -1, 1);
   p.throttleIn = bestD > 1500 ? 1 : bestD < 1000 ? -0.3 : 0.5;

   // --- smoke when critically hurt ---
   if (p.hp < p.maxHP * 0.25 && p.smoke.cd <= 0 && !p.smoke.active) {
      p.smoke.active = true; p.smoke.t = 8; p.smoke.cd = 33;
   }

   // --- repair fires/floods with a human-like reaction delay (repairAll() itself has no
   // cooldown -- a real player is limited by how fast they can notice+press R, not by game
   // rules, so gate this the same way to avoid a superhuman instant-heal bot) ---
   if ((p.fires.length || p.floods.length) && p._repairCd === undefined) p._repairCd = 0;
   if (p._repairCd > 0) p._repairCd -= dt;
   if ((p.fires.length || p.floods.length) && p._repairCd <= 0) {
      p.repairAll();
      p._repairCd = 2.5; // reaction + re-notice delay before the next repair press
   }

   // --- fire ---
   if (bestD < p.cfg.main.range && p.fireTimer <= 0) p.fireMain(w, target, p.aim);
   if (p.cfg.sec && bestD < p.cfg.sec.range && p.secTimer <= 0) p.fireSecondary(w, target, p.aim);
}

function play(difficulty, maxSec = 600) {
   const w = new World(difficulty);
   const t0 = Date.now();
   let steps = 0;
   const log = [];
   let lastKillT = -1;
   while (w.phase === 'playing' && w.time < maxSec) {
      controlPlayer(w, DT);
      for (const b of w.bots) updateBot(b, w, DT);
      w.update(DT);
      steps++;
      for (const ev of w.events) {
         if (ev.kind === 'sink' && ev.t !== lastKillT) {
            lastKillT = ev.t;
            log.push(`t=${ev.t.toFixed(0)}s ${ev.ship.name} (${ev.ship.cls}) ${ev.ship.side === 'enemy' ? 'versenkt' : 'VERLOREN'}`);
         }
      }
      w.events.length = 0;
   }
   const wallMs = Date.now() - t0;
   const p = w.player;
   const summary = {
      difficulty,
      phase: w.phase,
      time: Math.round(w.time),
      kills: w.killCount,
      totalBots: w.bots.length,
      playerHP: `${Math.round((p.hp / p.maxHP) * 100)}%`,
      playerDmgDealt: Math.round(p.dmgDealt),
      playerDmgTaken: Math.round(p.dmgTaken),
      playerShots: p.shotsFired,
      botShots: w.bots.reduce((a, b) => a + b.shotsFired, 0),
      botStates: {},
      wallMs,
      log,
   };
   for (const b of w.bots) summary.botStates[b.state] = (summary.botStates[b.state] || 0) + 1;
   return summary;
}

// ---- runner ----
// `node tests/play.mjs`        -> one detailed match per difficulty (kill timeline)
// `node tests/play.mjs <N>`    -> N matches per difficulty, aggregated win-rate + stats
const N = Math.max(1, parseInt(process.argv[2] || '1', 10));

if (N === 1) {
   for (const diff of ['easy', 'normal', 'hard']) {
      const s = play(diff);
      console.log(`\n=== ${diff.toUpperCase()} ===`);
      console.log(`Ergebnis: ${s.phase} nach ${s.time}s | Kills ${s.kills}/${s.totalBots} | Bismarck HP ${s.playerHP}`);
      console.log(`Schaden: gegeben ${s.playerDmgDealt} / erlitten ${s.playerDmgTaken} | Schüsse: Spieler ${s.playerShots}, Bots ${s.botShots}`);
      console.log(`Bot-Endzustände: ${JSON.stringify(s.botStates)} | Sim-Zeit ${s.wallMs}ms`);
      for (const l of s.log) console.log('  ' + l);
   }
} else {
   const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
   for (const diff of ['easy', 'normal', 'hard']) {
      let wins = 0, losses = 0, draws = 0;
      const times = [], hps = [], dealt = [], taken = [];
      const t0 = Date.now();
      for (let i = 0; i < N; i++) {
         const s = play(diff);
         if (s.phase === 'won') wins++;
         else if (s.phase === 'lost') losses++;
         else draws++;
         times.push(s.time); hps.push(parseFloat(s.playerHP));
         dealt.push(s.playerDmgDealt); taken.push(s.playerDmgTaken);
      }
      const wallMs = Date.now() - t0;
      console.log(`\n=== ${diff.toUpperCase()} (${N} Läufe, ${wallMs}ms) ===`);
      console.log(`Win-Rate: ${wins}/${N} (${Math.round(100 * wins / N)}%) | Niederlagen ${losses} | Unentschieden/Timeout ${draws}`);
      console.log(`Ø Zeit: ${Math.round(avg(times))}s | Ø Bismarck-HP am Ende: ${Math.round(avg(hps))}%`);
      console.log(`Ø Schaden: gegeben ${Math.round(avg(dealt))} / erlitten ${Math.round(avg(taken))}`);
   }
}
