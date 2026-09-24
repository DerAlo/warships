// game/boss.js — boss battles: data-driven attack phases (cfg.bossPhases) that switch as the hull
// drops, each ability telegraphed before it lands so the player can react:
//   barrage  red impact rings, heavy shells after `delay` s (World.addBarrage)
//   fan      red torpedo lanes on the water for `warn` s, then a wide torpedo fan along them
//   rapid    yellow glow + banner for `warn` s, then the main battery reloads at `mult` for `dur` s
//   smoke    once on phase entry: smoke screen and a sprint to a new position
// Escorts are called by the mission's `{when: 'hp', tag: 'boss'}` waves (director.js).
// Difficulty scales intervals (bossCd), fan width (bossFan) and warning time (bossWarn).
import { sub, add, dist, fromAngle, angleOf } from './utils.js';

// Highest phase whose threshold the hull fraction has fallen below. Phase 0 is always active.
export function bossPhaseIndex(phases, hpFrac) {
   let idx = 0;
   if (!phases) return idx;
   for (let i = 1; i < phases.length; i++) if (hpFrac < phases[i].below) idx = i;
   return idx;
}

function diffOf(world) {
   const d = world.difficulty || {};
   return { cd: d.bossCd || 1, fan: d.bossFan || 0, warn: d.bossWarn || 1 };
}

function say(world, text, kind = 'warn', dur = 5) {
   if (world.director) world.director.say(text, kind, dur);
   else world.log(null, text, kind);
}

// per-tick boss brain, called from ai.js updateBot (k = current contact, may be null)
export function updateBoss(bot, world, k, dt) {
   const phases = bot.cfg.bossPhases;
   if (!phases) return;
   const D = diffOf(world);
   // ---- phase transitions: only ever forward ----
   const want = bossPhaseIndex(phases, bot.hp / bot.maxHP);
   if (bot.bossPhase == null) bot.bossPhase = 0;
   while (bot.bossPhase < want) {
      bot.bossPhase++;
      const ph = phases[bot.bossPhase];
      bot.enraged = bot.bossPhase >= 1;
      say(world, `⚠ ${bot.name} — Phase ${bot.bossPhase + 1}: ${ph.msg || ph.name}`, 'warn', 6);
      world.emit({ kind: 'bossPhase', ship: bot, phase: bot.bossPhase });
      // stagger the new abilities so they do not all fire on the same tick
      bot.fanT = 3.5 * D.cd;
      bot.rapidCd = 6 * D.cd;
      if (ph.smoke) bossSmoke(bot, world, k);
   }
   const ph = phases[bot.bossPhase];
   const seen = k && k.seen;

   // ---- barrage (red rings) ----
   const B = bot.cfg.barrage;
   if (ph.barrage && B) {
      bot.barrageT = (bot.barrageT ?? B.every * 0.5) - dt;
      if (bot.barrageT <= 0 && seen && dist(bot.pos, k.pos) <= bot.cfg.main.range) {
         const late = bot.bossPhase >= 1;
         bot.barrageT = (late ? B.everyP2 : B.every) * D.cd;
         // aimed where the target will be when the shells land, so holding course is fatal
         const at = { x: k.pos.x + k.vel.x * B.delay * 0.8, y: k.pos.y + k.vel.y * B.delay * 0.8 };
         world.addBarrage(bot, at, B, late ? B.countP2 : B.count);
      }
   }

   // ---- torpedo fan: lanes locked at warning time, launched when it runs out ----
   const F = bot.cfg.fan;
   if (bot.fanWarn) {
      bot.fanWarn.t -= dt;
      if (bot.fanWarn.t <= 0) {
         const w = bot.fanWarn;
         bot.fanWarn = null;
         const torp = { dmg: F.dmg, speed: F.speed, range: F.range };
         for (const a of w.angles) world.spawnTorpedo(bot, add(w.from, fromAngle(a, bot.cfg.beam * 0.6)), fromAngle(a, 1), torp);
         world.emit({ kind: 'torp', ship: bot });
      }
   } else if (ph.fan && F) {
      bot.fanT = (bot.fanT ?? 4) - dt;
      if (bot.fanT <= 0 && seen && dist(bot.pos, k.pos) < F.range * 0.95) {
         bot.fanT = F.every * D.cd;
         const n = Math.max(3, F.n + D.fan);
         const lead = F.range > 0 ? dist(bot.pos, k.pos) / F.speed * 0.5 : 0;
         const aimAt = { x: k.pos.x + k.vel.x * lead, y: k.pos.y + k.vel.y * lead };
         const mid = angleOf(sub(aimAt, bot.pos));
         const angles = [];
         for (let i = 0; i < n; i++) angles.push(mid + (i / (n - 1) - 0.5) * F.spread);
         const warn = F.warn * D.warn;
         bot.fanWarn = { t: warn, T: warn, angles, from: { x: bot.pos.x, y: bot.pos.y }, range: F.range };
         say(world, `🐟 ${bot.name} fächert Torpedos — raus aus den roten Bahnen!`, 'warn', 4);
      }
   }

   // ---- rapid salvo: announced, then the turrets reload at `mult` ----
   const R = bot.cfg.rapid;
   if (bot.rapidT > 0) bot.rapidT = Math.max(0, bot.rapidT - dt);
   if (bot.rapidWarn > 0) {
      bot.rapidWarn -= dt;
      if (bot.rapidWarn <= 0) {
         bot.rapidWarn = 0;
         bot.rapidT = R.dur;
         bot.rapidMult = R.mult;
         // loaded or not: every turret is ready for the first rapid salvo
         for (const t of bot.turrets) t.cd = Math.min(t.cd, 0.4);
      }
   } else if (ph.rapid && R && !(bot.rapidT > 0)) {
      bot.rapidCd = (bot.rapidCd ?? 6) - dt;
      if (bot.rapidCd <= 0 && seen) {
         bot.rapidCd = R.every * D.cd;
         bot.rapidWarn = R.warn * D.warn;
         say(world, `⚡ ${bot.name}: Schnellfeuer in ${Math.round(bot.rapidWarn)} s — Kurs wechseln!`, 'warn', 3);
      }
   }

   // ---- smoke reposition timer ----
   if (bot.bossMove) {
      bot.bossMove.t -= dt;
      if (bot.bossMove.t <= 0 || dist(bot.pos, bot.bossMove.goal) < 200) bot.bossMove = null;
   }
}

// smoke screen + a sprint abeam of the player to re-open the fight from a new bearing
function bossSmoke(bot, world, k) {
   bot.useConsumable('smoke');
   const from = k ? k.pos : world.player.pos;
   const away = angleOf(sub(bot.pos, from));
   const side = (bot.id % 2 ? 1 : -1) * 1.1;
   const A = 3400;
   let goal = add(from, fromAngle(away + side, 1700));
   goal = { x: Math.max(-A, Math.min(A, goal.x)), y: Math.max(-A, Math.min(A, goal.y)) };
   bot.bossMove = { goal, t: 14 };
}

// steering override while the boss repositions under smoke (null = normal AI)
export function bossSteer(bot) {
   if (!bot.bossMove) return null;
   return { heading: angleOf(sub(bot.bossMove.goal, bot.pos)), throttle: 1 };
}

// the boss the HUD bar should track: a live boss the player has spotted at least once
export function activeBoss(world) {
   for (const b of world.bots) {
      if (!b.alive || !b.cfg.bossPhases) continue;
      if (b.visible) b._bossSeen = true;
      if (b._bossSeen) return b;
   }
   return null;
}
