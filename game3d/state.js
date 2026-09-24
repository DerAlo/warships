// game3d/state.js — the World: mission container, fixed-step update, spotting, capture points,
// events/stats bookkeeping and the query surface used by AI, renderer and HUD.
import { WORLD, DIFFICULTY, TUNE, SHIPS } from './config.js';
import { applyLoadout, calcRewards } from './progress3d.js';
import { makeRng, dist2, clamp, makeLobes, segBlockedByIslands, pointSegDist, TAU } from './utils.js';
import { Ship } from './ship.js';
import { resolveShells, resolveTorpedoes } from './combat.js';
import { updateBots } from './ai.js';
import { setupMission, updateMission } from './missions.js';

const ENV_VIS = { clear: 1, overcast: 0.9, rain: 0.78, storm: 0.7 };
const ENV_SEA = { clear: 0.3, overcast: 0.45, rain: 0.55, storm: 0.92 };
// weather-dependent part of world.env (explicit values in e win)
function envWeather(time, weather, e) {
   return {
      seaState: e.seaState ?? ENV_SEA[weather] ?? 0.3,
      visibility: e.visibility ?? (ENV_VIS[weather] ?? 1) * (time === 'night' ? 0.6 : time === 'day' ? 1 : 0.9),
      wind: e.wind ?? (weather === 'storm' ? 1 : weather === 'rain' ? 0.6 : 0.3),
      // hard ceiling on visual detection (m), gun bloom included -- WoWs "cyclone" rule
      spotCap: e.spotCap ?? (weather === 'storm' ? 8000 : Infinity),
   };
}
const SUN = { day: [0.9, 0.75], dawn: [1.75, 0.07], dusk: [-1.6, 0.06], night: [2.4, -0.35] };

export class World {
   // opts: { mission: id, ship: playable class key, seed }. Legacy call: new World(diff, seed).
   constructor(difficulty = 'normal', opts = {}) {
      if (opts === null || typeof opts !== 'object') opts = { seed: opts };
      this.difficultyKey = DIFFICULTY[difficulty] ? difficulty : 'normal';
      this.difficulty = DIFFICULTY[this.difficultyKey];
      this.seed = opts.seed ?? ((Date.now() ^ (Math.random() * 1e9)) >>> 0);
      this.rng = makeRng(this.seed);
      this._nextId = 1;
      this.tick = 0;
      this.time = 0;
      this.phase = 'playing';
      // Capability flags read by main3d.js: secondaries fire automatically, bots are driven inside update().
      this.autoSecondaries = true;
      this.aiInternal = true;
      this.arena = WORLD.ARENA;
      this.ships = [];          // alive + sinking
      this.roster = [];         // every ship that took part (scoreboard), never pruned
      this.bots = [];           // AI ships (allies + enemies), never pruned
      this.player = null;
      this.shells = [];
      this.torpedoes = [];
      this.smokeClouds = [];
      this.effects = [];
      this.planes = [];
      this.events = [];
      this._eventSeq = 0;
      this.obstacles = [];
      this.caps = [];
      this.score = null;
      this.timeLeft = null;
      this.mission = null;
      this.result = null;
      this.env = null;
      this.stats = {
         dmg: 0, kills: 0, citadels: 0, pens: 0, overpens: 0, ricochets: 0, shatters: 0, heHits: 0, secHits: 0,
         fires: 0, floods: 0, torpHits: 0, torpsFired: 0, shotsFired: 0, hits: 0, spottingDmg: 0, tanked: 0,
         potential: 0, healed: 0, caps: 0, spotted: 0,
      };
      this.logLines = [];
      this.killCount = 0;       // legacy HUD: enemy ships sunk
      this._shake = 0;
      this._maxTerrainH = 0;
      this._spotT = 0;
      this._byId = new Map();
      this.setEnv({});
      this.loadout = opts.loadout || null;   // career modules + captain skills for the player ship (progress3d.js)
      setupMission(this, opts.mission || 'standard', opts.ship || null);
      this._updateSpotting();
   }

   // ---------------- setup helpers (missions.js) ----------------
   setEnv(e) {
      const time = e.time || 'day', weather = e.weather || 'clear';
      const [az, el] = SUN[time] || SUN.day;
      this.env = {
         time, weather,
         ...envWeather(time, weather, e),
         sunAzimuth: e.sunAzimuth ?? az, sunElevation: e.sunElevation ?? el,
         // dynamic weather: an optional front { at (s), dur (s), to, text } rolls in mid-battle;
         // frontK = 0..1 blend (quantised, so the renderer re-resolves the sky only ~25 times)
         front: null, frontK: 0,
      };
      if (e.front) this.scheduleFront(e.front);
      return this.env;
   }
   // Schedule (or, with at <= world.time, start right away) a weather front. The blend drives
   // visibility, sea state, wind, the spotting cap and (via combat.weatherDispersion) dispersion.
   scheduleFront({ at = this.time, dur = 60, to = 'storm', text = null } = {}) {
      const env = this.env;
      env.front = {
         at, dur: Math.max(1, dur), to, from: env.weather, text: text ?? (to === 'storm' ? 'Sturmfront zieht auf' : 'Regenfront zieht auf'),
         announced: false,
         base: { visibility: env.visibility, seaState: env.seaState, wind: env.wind, spotCap: env.spotCap },
         target: envWeather(env.time, to, {}),
      };
      env.frontK = 0;
      return env.front;
   }
   _updateWeather() {
      const env = this.env, f = env.front;
      if (!f || this.time < f.at) return;
      if (!f.announced) {
         f.announced = true;
         this.message(f.text + ' – Sicht sinkt, Streuung steigt', 'warn');
         this.pushEvent('weather', { text: f.text, to: f.to });
      }
      const k = Math.round(clamp((this.time - f.at) / f.dur, 0, 1) * 25) / 25;
      if (k === env.frontK) return;
      env.frontK = k;
      const B = f.base, T = f.target, mix = (a, b) => a + (b - a) * k;
      env.visibility = mix(B.visibility, T.visibility);
      env.seaState = mix(B.seaState, T.seaState);
      env.wind = mix(B.wind, T.wind);
      // the spotting ceiling closes in from 20 km (or the old cap) to the storm cap
      env.spotCap = T.spotCap === Infinity ? B.spotCap : Math.min(B.spotCap, mix(Math.min(B.spotCap, 20000), T.spotCap));
      if (k >= 0.5) env.weather = f.to;
   }
   addIsland(o) {
      const isl = {
         kind: o.kind || 'island', c: { x: o.c.x, y: o.c.y }, r: o.r, height: o.height ?? 150, seed: o.seed ?? 1,
         lobeCount: typeof o.lobes === 'number' ? o.lobes : 5, elong: o.elong || 1, rot: o.rot || 0,
         rough: o.rough ?? 0.5, peaks: o.peaks || null, name: o.name || null, snow: !!o.snow,
      };
      isl.lobes = makeLobes({ ...isl, lobes: isl.lobeCount });
      isl.rMax = isl.lobes.reduce((a, l) => Math.max(a, l.r), 0);
      this.obstacles.push(isl);
      const peakH = isl.peaks ? isl.peaks.reduce((a, k) => Math.max(a, k.h), 0) : 0;
      if (isl.kind === 'island') this._maxTerrainH = Math.max(this._maxTerrainH, isl.height * 1.4, peakH * 1.05);
      return isl;
   }
   spawn(cls, side, pos, heading, opts = {}) {
      const d = this.difficulty;
      const bot = !opts.isPlayer;
      const ship = new Ship(this, cls, side, pos, heading, {
         hpMult: bot && side === 'enemy' ? d.botHP : 1,
         dmgMult: bot && side === 'enemy' ? d.botDmg : 1,
         ...(!bot && this.loadout && SHIPS[cls] ? { cfg: applyLoadout(SHIPS[cls], this.loadout) } : null),
         ...opts,
      });
      this.ships.push(ship);
      this.roster.push(ship);
      this._byId.set(ship.id, ship);
      if (opts.isPlayer) this.player = ship;
      else this.bots.push(ship);
      return ship;
   }
   // Take a ship out of the battle without sinking it (escaped / arrived / retreated).
   removeShip(ship, reason = 'escaped') {
      if (!ship.alive) return;
      ship.alive = false; ship.sinking = false; ship.escaped = reason;
      this.ships = this.ships.filter(s => s !== ship);
   }

   // ---------------- queries ----------------
   shipById(id) { return id == null ? null : this._byId.get(id) || null; }
   alliesOf(ship) { return this.ships.filter(s => s.alive && s.side === ship.side && s !== ship); }
   enemiesOf(ship) { return this.ships.filter(s => s.alive && s.side !== ship.side); }
   sideShips(side) { return this.ships.filter(s => s.alive && s.side === side); }
   // Can the team `side` currently see `target`?
   canSee(side, target) { return target.side === side || target.detected; }
   // Enemy ships: visible to the player's team. The player: is the player detected (legacy HUD).
   isSpotted(ship) {
      if (!ship) return false;
      if (ship === this.player) return ship.detected;
      return ship.side === 'player' ? true : ship.spotted;
   }
   // Any smoke cloud covering pos (smoke hides whoever is inside, friend or foe).
   inSmoke(pos) {
      for (const c of this.smokeClouds) if (dist2(pos, c.c) < c.r * c.r) return true;
      return false;
   }
   smokeBlocks(a, b) {
      for (const c of this.smokeClouds) if (c.r > 60 && pointSegDist(c.c, a, b) < c.r * 0.85) return true;
      return false;
   }
   losBlocked(a, b) { return segBlockedByIslands(a, b, this.obstacles); }
   // Legacy HUD "under fire": distance from ship to the nearest incoming enemy shell impact.
   nearestThreat(ship) {
      let best = Infinity;
      for (const s of this.shells) if (s.side !== ship.side) best = Math.min(best, Math.sqrt(dist2(s.target, ship.pos)));
      for (const t of this.torpedoes) if (t.side !== ship.side && t.visibleToOpp) best = Math.min(best, Math.sqrt(dist2(t.pos, ship.pos)));
      return best;
   }

   // ---------------- spawning of transient things ----------------
   addShell(s) { if (this.shells.length < TUNE.maxShells) this.shells.push(s); }
   addTorpedo(t) { this.torpedoes.push(t); }
   addSmoke(c) { this.smokeClouds.push({ age: 0, ...c, c: { x: c.c.x, y: c.c.y } }); }
   addEffect(kind, pos, life = 1, size = 10, extra = {}) {
      const e = { kind, pos: { x: pos.x, y: pos.y }, t: 0, age: 0, life, size, big: false, ...extra };
      this.effects.push(e);
      if (this.effects.length > TUNE.maxEffects) this.effects.splice(0, this.effects.length - TUNE.maxEffects);
      return e;
   }
   pushEvent(type, data = {}) {
      const e = { seq: ++this._eventSeq, t: this.time, type, srcId: null, dstId: null, dmg: 0, pos: null, text: '', ...data };
      this.events.push(e);
      if (this.events.length > TUNE.maxEvents) this.events.splice(0, this.events.length - TUNE.maxEvents);
      return e;
   }
   log(who, text, type = 'info') {
      this.logLines.push({ text: (who && who.name ? who.name + ': ' : '') + text, type, t: this.time });
      if (this.logLines.length > TUNE.maxLog) this.logLines.shift();
   }
   message(text, type = 'info') {           // mission radio message: log + HUD banner event
      this.log(null, text, type);
      this.pushEvent('objective', { text, level: type });
   }
   shakeAdd(m) { this._shake = Math.max(this._shake || 0, m); }

   // ---------------- bookkeeping hooks (ship.js / combat.js) ----------------
   onHit(shooter, target, type, proj) {
      if (!shooter) return;
      if (type !== 'ricochet' && type !== 'shatter') shooter.hits++;
      if (!shooter.isPlayer) return;
      const st = this.stats;
      // main-battery accuracy = hits / shotsFired: secondaries fire on their own and are counted apart
      if (type === 'torp') st.torpHits++;
      else if (proj?.kind !== 'sec') st.hits++;   // secondary shatters too
      if (type === 'citadel') st.citadels++;
      else if (type === 'pen') st.pens++;
      else if (type === 'overpen') st.overpens++;
      else if (type === 'ricochet') st.ricochets++;
      else if (type === 'shatter') st.shatters++;
      else if (type === 'he') st.heHits++;
      else if (type === 'sec') st.secHits++;
   }
   onDamage(target, shooter, amt, type) {
      if (shooter && shooter.isPlayer) this.stats.dmg += amt;
      else if (shooter && shooter.side === 'player' && target.side !== 'player' && target.spottedByPlayer) this.stats.spottingDmg += amt;
      if (target.isPlayer) this.stats.tanked += amt;
   }
   onStatus(ship, shooter, kind, zone) {
      this.pushEvent(kind, { srcId: shooter ? shooter.id : null, dstId: ship.id, pos: { x: ship.pos.x, y: ship.pos.y }, zone,
         text: kind === 'fire' ? 'Brand' : 'Wassereinbruch' });
      if (shooter && shooter.isPlayer) this.stats[kind === 'fire' ? 'fires' : 'floods']++;
      if (ship.isPlayer) this.log(null, kind === 'fire' ? '🔥 Feuer an Bord!' : '💧 Wassereinbruch!', 'warn');
   }
   onSink(ship, killer, type) {
      if (ship.side === 'enemy') this.killCount++;
      if (killer) {
         killer.kills++;
         if (killer.isPlayer) {
            this.stats.kills++;
            this.pushEvent('kill', { srcId: killer.id, dstId: ship.id, pos: { x: ship.pos.x, y: ship.pos.y }, text: ship.name + ' versenkt' });
         }
      }
      this.pushEvent('sunk', { srcId: killer ? killer.id : null, dstId: ship.id, pos: { x: ship.pos.x, y: ship.pos.y }, text: ship.name + ' gesunken', cause: type });
      this.log(null, (ship.side === 'enemy' ? '🎯 Versenkt: ' : '💀 Verlust: ') + ship.name + (killer ? ' (' + killer.name + ')' : ''), ship.side === 'enemy' ? 'kill' : 'warn');
      const L = ship.cfg.hull.L;
      for (let i = 0; i < 3; i++) {
         const f = (i - 1) * 0.3;
         this.addEffect('explosion', { x: ship.pos.x + Math.cos(ship.heading) * L * f, y: ship.pos.y + Math.sin(ship.heading) * L * f },
            1.6 + i * 0.3, 30 + L * 0.15, { big: true, sink: true, shipId: ship.id });
      }
      if (type === 'citadel' && ship.type !== 'DD') this.addEffect('detonation', ship.pos, 3, 60 + L * 0.3, { big: true, shipId: ship.id });
      if (ship === this.player) this.shakeAdd(2);
      if (this._script && this._script.onSink) this._script.onSink(this, ship, killer);
      if (ship === this.player) this.end(false, 'Ihr Schiff wurde versenkt.');
   }

   // ---------------- end of battle ----------------
   flightTime(ship, R) { return ship && ship.flightTime ? ship.flightTime(R) : 0; }

   end(victory, reason) {
      if (this.phase !== 'playing') return;
      this.phase = victory ? 'won' : 'lost';
      const st = this.stats, d = this.difficulty;
      for (const o of this.mission ? this.mission.objectives : []) {
         if (o.state === 'active') o.state = victory && !o.optional ? 'done' : 'failed';
      }
      const rw = calcRewards({ victory, stats: st, rewardMult: d.rewardMult || 1, alive: !!(this.player && this.player.alive),
         objectives: this.mission ? this.mission.objectives : [] });
      this.result = { victory, reason, xp: rw.xp, credits: rw.credits, rewards: rw, time: this.time, stats: { ...st } };
      this.pushEvent('objective', { text: (victory ? 'SIEG — ' : 'NIEDERLAGE — ') + reason, level: victory ? 'win' : 'lose', end: true });
      this.log(null, (victory ? '🏆 ' : '💀 ') + reason, victory ? 'kill' : 'warn');
   }

   // ---------------- update ----------------
   update(dt) {
      this.time += dt;
      this.tick++;
      if (this.phase === 'playing' && this.timeLeft != null) this.timeLeft = Math.max(0, this.timeLeft - dt);
      updateBots(this, dt);
      for (const s of this.ships) s.update(dt, this);
      this._collideShips();
      resolveShells(this, dt);
      resolveTorpedoes(this, dt);
      this._updateSmoke(dt);
      this._updateEffects(dt);
      this._spotT -= dt;
      if (this._spotT <= 0) { this._spotT = WORLD.SPOT_DT; this._updateSpotting(); }
      this._updateCaps(dt);
      this._updateWeather();
      if (this.phase === 'playing') updateMission(this, dt);
      if (this.ships.some(s => !s.alive && !s.sinking)) this.ships = this.ships.filter(s => s.alive || s.sinking);
      if (this._shake) { this._shake *= Math.pow(0.02, dt); if (this._shake < 0.02) this._shake = 0; }
   }

   _updateSmoke(dt) {
      for (const c of this.smokeClouds) {
         c.age += dt; c.life -= dt;
         c.r = Math.min(c.maxR || WORLD.SMOKE_RADIUS, c.r + dt * 70);
         if (c.life < 6) c.r *= Math.pow(0.85, dt);      // dissipates at the end
      }
      if (this.smokeClouds.some(c => c.life <= 0)) this.smokeClouds = this.smokeClouds.filter(c => c.life > 0);
   }
   _updateEffects(dt) {
      for (const e of this.effects) { e.t += dt; e.age += dt; }
      if (this.effects.some(e => e.t >= e.life)) this.effects = this.effects.filter(e => e.t < e.life);
   }

   // Team-shared surface spotting: detectability range (after bloom/smoke/weather), island and
   // smoke line of sight, 2 km proximity, radar/hydro. Updated every SPOT_DT seconds.
   _updateSpotting() {
      const ships = this.ships, prox2 = WORLD.PROXIMITY * WORLD.PROXIMITY;
      for (const T of ships) {
         if (!T.alive) continue;
         let seen = false, byPlayer = false;
         for (const O of ships) {
            if (!O.alive || O.side === T.side) continue;
            if (seen && !O.isPlayer) continue;
            const d2 = dist2(O.pos, T.pos);
            let sees = d2 < prox2;
            if (!sees) {
               const radar = O.consumableActive('radar') ? O.consumable('radar').range : 0;
               const hydro = O.consumableActive('hydro') ? O.consumable('hydro').range : 0;
               if (d2 < Math.max(radar, hydro) ** 2) sees = true;
               else if (T.detectRange > 0 && d2 < T.detectRange * T.detectRange) {
                  sees = !this.losBlocked(O.pos, T.pos) && (T.inSmoke || !this.smokeBlocks(O.pos, T.pos));
               }
            }
            if (sees) { seen = true; if (O.isPlayer) byPlayer = true; }
         }
         const was = T.detected;
         T.detected = seen;
         T.spottedByPlayer = byPlayer;
         T.spotted = T.side === 'player' ? true : seen;
         if (seen) {
            T.lastSeen = { x: T.pos.x, y: T.pos.y, heading: T.heading, speed: T.speed, t: this.time };
            if (!was && T.side === 'enemy') {
               this.pushEvent('spotted', { dstId: T.id, text: T.name + ' entdeckt', pos: { x: T.pos.x, y: T.pos.y } });
               if (byPlayer) this.stats.spotted++;
            }
         }
         if (was !== seen && T === this.player) this.pushEvent(seen ? 'spotted' : 'unspotted', { dstId: T.id, text: seen ? 'Sie wurden entdeckt!' : 'Nicht mehr entdeckt' });
         else if (was && !seen && T.side === 'enemy') this.pushEvent('unspotted', { dstId: T.id, text: T.name + ' außer Sicht' });
      }
      // torpedoes: seen by the opposing team within their detect range (or hydrophone range)
      for (const t of this.torpedoes) {
         let vis = false;
         for (const O of ships) {
            if (!O.alive || O.side === t.side) continue;
            const hyd = O.consumableActive('hydro') ? O.consumable('hydro').torpRange || 0 : 0;
            const r = Math.max((t.detect || 1300) * (O.torpSpot || 1), hyd);
            if (dist2(O.pos, t.pos) < r * r) { vis = true; break; }
         }
         t.visibleToOpp = vis;
         t.spotted = t.side === 'player' || vis;
      }
   }

   _updateCaps(dt) {
      if (!this.caps.length) return;
      for (const cap of this.caps) {
         let np = 0, ne = 0;
         for (const s of this.ships) {
            if (!s.alive || s.type === 'TR' || dist2(s.pos, cap.pos) > cap.r * cap.r) continue;
            if (s.side === 'player') np++; else ne++;
         }
         cap.contested = np > 0 && ne > 0;
         cap.inside = { player: np, enemy: ne };
         if (cap.contested) continue;
         const side = np ? 'player' : ne ? 'enemy' : null;
         if (!side || side === cap.owner) {
            cap.progress = Math.max(0, cap.progress - dt / (cap.time || 45) * 0.5);
            if (cap.progress <= 0) cap.capper = null;
            continue;
         }
         if (cap.capper !== side) { cap.capper = side; cap.progress = 0; }
         const n = Math.min(3, side === 'player' ? np : ne);
         cap.progress += dt / (cap.time || 45) * (1 + 0.35 * (n - 1));
         if (cap.progress >= 1) {
            const prev = cap.owner;
            cap.owner = side; cap.progress = 0; cap.capper = null;
            if (side === 'player') {
               this.stats.caps++;
               this.pushEvent('cap', { text: 'Punkt ' + cap.id + ' eingenommen', capId: cap.id, pos: { ...cap.pos } });
               this.log(null, '🚩 Punkt ' + cap.id + ' eingenommen', 'kill');
            } else {
               this.pushEvent('capLost', { text: 'Punkt ' + cap.id + (prev === 'player' ? ' verloren' : ' vom Feind eingenommen'), capId: cap.id, pos: { ...cap.pos } });
               this.log(null, '⚑ Punkt ' + cap.id + (prev === 'player' ? ' verloren' : ' vom Feind eingenommen'), 'warn');
            }
         }
      }
   }

   // Soft hull-vs-hull collisions (keel segments), heavier ship shoves the lighter one.
   _collideShips() {
      const ships = this.ships;
      for (let i = 0; i < ships.length; i++) {
         const a = ships[i];
         if (!a.alive) continue;
         for (let j = i + 1; j < ships.length; j++) {
            const b = ships[j];
            if (!b.alive) continue;
            const reach = (a.cfg.hull.L + b.cfg.hull.L) / 2;
            if (dist2(a.pos, b.pos) > reach * reach) continue;
            const hit = keelContact(a, b);
            if (!hit) continue;
            const wa = b.maxHP / (a.maxHP + b.maxHP), wb = 1 - wa;
            a.pos.x += hit.nx * hit.depth * wa; a.pos.y += hit.ny * hit.depth * wa;
            b.pos.x -= hit.nx * hit.depth * wb; b.pos.y -= hit.ny * hit.depth * wb;
            // friction only for the part of each hull's motion that drives into the other: a glancing
            // or T-bone contact must not pin a ship that is trying to slide off or pull away
            const into = (s, sg) => clamp(-(Math.cos(s.heading) * hit.nx + Math.sin(s.heading) * hit.ny) * sg * Math.sign(s.speed), 0.1, 1);
            a.speed *= 1 - 0.015 * into(a, 1); b.speed *= 1 - 0.015 * into(b, -1);
         }
      }
   }
}

// Closest approach of two keel lines; returns push normal (from b to a) and overlap depth.
function keelContact(a, b) {
   const seg = (s) => {
      const h = s.cfg.hull.L * 0.46, c = Math.cos(s.heading), n = Math.sin(s.heading);
      return [{ x: s.pos.x + c * h, y: s.pos.y + n * h }, { x: s.pos.x - c * h, y: s.pos.y - n * h }];
   };
   const [a0, a1] = seg(a), [b0, b1] = seg(b);
   let best = null;
   const test = (p, q0, q1, sign) => {
      const vx = q1.x - q0.x, vy = q1.y - q0.y;
      const t = clamp(((p.x - q0.x) * vx + (p.y - q0.y) * vy) / (vx * vx + vy * vy || 1), 0, 1);
      const cx = q0.x + vx * t, cy = q0.y + vy * t;
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (!best || d < best.d) best = { d, nx: (p.x - cx) * sign, ny: (p.y - cy) * sign };
   };
   test(a0, b0, b1, 1); test(a1, b0, b1, 1); test(b0, a0, a1, -1); test(b1, a0, a1, -1);
   const minD = (a.cfg.hull.beam + b.cfg.hull.beam) * 0.5;
   if (best.d >= minD) return null;
   const l = best.d || 1;
   if (best.d < 1e-3) { best.nx = Math.cos(a.heading + Math.PI / 2); best.ny = Math.sin(a.heading + Math.PI / 2); }
   else { best.nx /= l; best.ny /= l; }
   return { nx: best.nx, ny: best.ny, depth: (minD - best.d) * 0.5 };
}

export { TAU };
