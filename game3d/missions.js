// game3d/missions.js — singleplayer missions: maps (islands), environment, teams, objectives,
// scripted reinforcements and win/lose logic. MISSIONS is pure data for the menu; setupMission /
// updateMission are called by World. Mission text is German (UI), code English.
import { SHIPS, PLAYABLE } from './config.js';
import { TAU, dist2, obstacleT, obstacleRadiusAt } from './utils.js';

// ---------------------------------------------------------------- names
const POOLS = {
   Bismarck: ['Tirpitz', 'Bismarck'],
   Scharnhorst: ['Gneisenau', 'Scharnhorst'],
   Hipper: ['Prinz Eugen', 'Admiral Hipper', 'Blücher', 'Seydlitz'],
   Nuernberg: ['Leipzig', 'Nürnberg', 'Köln', 'Karlsruhe', 'Emden'],
   Z23: ['Z 24', 'Z 25', 'Z 26', 'Z 28', 'Z 29', 'Z 30', 'Hans Lody', 'Karl Galster', 'Erich Steinbrinck', 'Friedrich Ihn', 'Z 23'],
   KGV: ['King George V', 'Prince of Wales', 'Duke of York'],
   Rodney: ['HMS Rodney', 'HMS Nelson'],
   Hood: ['HMS Hood'],
   Norfolk: ['HMS Norfolk', 'HMS Suffolk', 'HMS Dorsetshire', 'HMS Devonshire', 'HMS Sussex'],
   Fiji: ['HMS Fiji', 'HMS Kenya', 'HMS Mauritius', 'HMS Nigeria', 'HMS Sheffield'],
   Jervis: ['HMS Jervis', 'HMS Javelin', 'HMS Janus', 'HMS Cossack', 'HMS Maori', 'HMS Zulu', 'HMS Sikh', 'HMS Kelly', 'HMS Kashmir', 'HMS Tartar'],
   Transport_player: ['Dampfer Ostmark', 'Dampfer Weser', 'Dampfer Elbe', 'Dampfer Oder', 'Dampfer Ems'],
   Transport_enemy: ['SS Clan Fraser', 'SS Empire Star', 'SS Port Hardy', 'SS Ohio Star', 'SS City of Leeds', 'SS Baron Kinnaird', 'Zielschiff Hulk'],
};
function nextName(w, cls, side) {
   const S = w._script;
   const pool = POOLS[cls === 'Transport' ? 'Transport_' + side : cls] || [SHIPS[cls].name];
   for (const n of pool) if (!S.used.has(n)) { S.used.add(n); return n; }
   const n = pool[0] + ' ' + (++S.dup + 1);
   S.used.add(n);
   return n;
}

// ---------------------------------------------------------------- helpers
const P = (x, y) => ({ x, y });
// Push a spawn / waypoint position out of any island (with margin).
function safePos(w, p, margin = 1.3) {
   const q = { x: p.x, y: p.y };
   for (let k = 0; k < 3; k++) {
      for (const o of w.obstacles) {
         if (obstacleT(o, q) >= margin) continue;
         const a = Math.atan2(q.y - o.c.y, q.x - o.c.x);
         const r = obstacleRadiusAt(o, a) * margin + 150;
         q.x = o.c.x + Math.cos(a) * r; q.y = o.c.y + Math.sin(a) * r;
      }
   }
   const lim = w.arena - 600;
   q.x = Math.max(-lim, Math.min(lim, q.x)); q.y = Math.max(-lim, Math.min(lim, q.y));
   return q;
}
// Reinforcements (minDist): slide the spawn point away from the nearest opposing ship so nothing
// materialises inside torpedo range of the player.
function keepAway(w, side, pos, minDist) {
   const q = { x: pos.x, y: pos.y }, lim = w.arena - 700;
   for (let k = 0; k < 4; k++) {
      let near = null, nd = Infinity;
      for (const s of w.ships) {
         if (!s.alive || s.side === side) continue;
         const d = Math.hypot(s.pos.x - q.x, s.pos.y - q.y);
         if (d < nd) { nd = d; near = s; }
      }
      if (!near || nd >= minDist) break;
      let dx = q.x - near.pos.x, dy = q.y - near.pos.y;
      const l = Math.hypot(dx, dy) || 1;
      dx /= l; dy /= l;
      q.x = Math.max(-lim, Math.min(lim, near.pos.x + dx * minDist));
      q.y = Math.max(-lim, Math.min(lim, near.pos.y + dy * minDist));
      // squeezed against the border: swing sideways along it
      if (Math.hypot(q.x - near.pos.x, q.y - near.pos.y) < minDist * 0.9) { q.x = Math.max(-lim, Math.min(lim, q.x - dy * minDist * 0.6)); q.y = Math.max(-lim, Math.min(lim, q.y + dx * minDist * 0.6)); }
   }
   return q;
}
function add(w, cls, side, pos, heading, opts = {}) {
   const ai = { ...(opts.ai || {}) };
   if (opts.minDist) {
      pos = keepAway(w, side, pos, opts.minDist);
      // face the enemy centre of mass on arrival
      const foes = w.ships.filter(s => s.alive && s.side !== side);
      if (foes.length) {
         const cx = foes.reduce((a, s) => a + s.pos.x, 0) / foes.length, cy = foes.reduce((a, s) => a + s.pos.y, 0) / foes.length;
         heading = Math.atan2(cy - pos.y, cx - pos.x);
      }
   }
   const ship = w.spawn(cls, side, safePos(w, pos), heading, {
      telegraph: opts.isPlayer ? 2 : 3, ...opts, ai,
      name: opts.name || (opts.isPlayer ? SHIPS[cls].name : nextName(w, cls, side)),
   });
   w._script.used.add(ship.name);
   return ship;
}
function objective(w, id, text, opts = {}) {
   const o = { id, text, state: 'active', optional: !!opts.optional, progress: opts.progress || null };
   w.mission.objectives.push(o);
   return o;
}
function setObj(w, id, state, text) {
   const o = w.mission.objectives.find(x => x.id === id);
   if (!o || o.state === state) return;
   if (text) o.text = text;
   o.state = state;
   w.pushEvent('objective', { text: (state === 'done' ? '✔ ' : state === 'failed' ? '✘ ' : '') + o.text, objId: id, state });
}
function objText(w, id, text) {
   const o = w.mission.objectives.find(x => x.id === id);
   if (o) o.text = text;
}
const combatants = (w, side) => w.ships.filter(s => s.alive && s.side === side && s.type !== 'TR');
const later = (S, t, fn) => S.timers.push({ t, fn });
function teamHPFrac(w, side) {
   let hp = 0, max = 0;
   for (const s of w.roster) if (s.side === side && s.type !== 'TR') { max += s.maxHP; hp += s.alive ? s.hp : 0; }
   return max ? hp / max : 0;
}

// Standard 7-ship team: slot offsets are relative to the team anchor, facing +x.
const DE_TEAM = [['Bismarck', 0, -700], ['Scharnhorst', -300, 700], ['Hipper', 500, -2500], ['Hipper', 500, 2500],
   ['Nuernberg', 700, -4000], ['Z23', 1600, -1600], ['Z23', 1600, 1600]];
const UK_TEAM = [['KGV', 0, -700], ['Rodney', -300, 700], ['Norfolk', 500, -2500], ['Norfolk', 500, 2500],
   ['Fiji', 700, 4000], ['Jervis', 1600, -1600], ['Jervis', 1600, 1600]];
// Spawn a team at anchor facing `heading`; `playerCls` takes the slot of the first matching class
// (or the first slot of the same type, or slot 0).
function spawnTeam(w, side, slots, anchor, heading, playerCls, aiFor = () => ({})) {
   let pIdx = -1;
   if (playerCls) {
      pIdx = slots.findIndex(s => s[0] === playerCls);
      if (pIdx < 0) pIdx = slots.findIndex(s => SHIPS[s[0]].hull.type === SHIPS[playerCls].hull.type);
      if (pIdx < 0) pIdx = 0;
   }
   const c = Math.cos(heading), s = Math.sin(heading);
   const out = [];
   slots.forEach(([cls, fx, fy], i) => {
      const pos = P(anchor.x + fx * c - fy * s, anchor.y + fx * s + fy * c);
      const isP = i === pIdx;
      out.push(add(w, isP ? playerCls : cls, side, pos, heading, isP ? { isPlayer: true } : { ai: aiFor(cls, i) }));
   });
   return out;
}
function pickShip(def, shipKey) {
   const allowed = def.playableShips || PLAYABLE;
   return allowed.includes(shipKey) ? shipKey : (def.recommendedShip || allowed[0]);
}
function islands(w, list) { for (const o of list) w.addIsland(o); }
// Deterministic archipelago filler: n islands in a box, keeping clear of `keepOut` circles.
function scatter(w, seed, n, box, rMin, rMax, keepOut = []) {
   let s = seed >>> 0;
   const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
   let placed = 0, guard = 0;
   while (placed < n && guard++ < n * 40) {
      const r = rMin + rnd() * (rMax - rMin);
      const c = P(box[0] + rnd() * (box[2] - box[0]), box[1] + rnd() * (box[3] - box[1]));
      if (keepOut.some(k => Math.hypot(c.x - k.x, c.y - k.y) < k.r + r * 1.6)) continue;
      if (w.obstacles.some(o => Math.hypot(c.x - o.c.x, c.y - o.c.y) < (o.rMax || o.r) + r * 1.8 + 500)) continue;
      w.addIsland({ c, r, height: 70 + rnd() * 260, seed: seed * 31 + placed, lobes: 3 + ((rnd() * 5) | 0),
         elong: 1 + rnd() * 1.4, rot: rnd() * TAU, rough: 0.35 + rnd() * 0.5 });
      placed++;
   }
}

// ---------------------------------------------------------------- mission definitions
const DEFS = [
   // ------------------------------------------------------------ 1. training
   {
      id: 'training', name: 'Übungsgefecht', subtitle: 'Schießübung in der Danziger Bucht',
      briefing: 'Kommandant, willkommen an Bord. Drei ausgemusterte Frachter dienen heute als Zielschiffe – ' +
         'sie liegen 9 bis 12 km östlich. Bringen Sie Ihr Schiff auf Fahrt, richten Sie die Türme aus und versenken Sie die Ziele. ' +
         'Achten Sie auf die Flugzeit Ihrer Granaten und halten Sie entsprechend vor. Gerüchten zufolge operieren feindliche Zerstörer in der Nähe.',
      env: { time: 'day', weather: 'clear' }, type: 'training', playableShips: null, recommendedShip: 'Hipper',
      arena: 9000, timeLimit: 15 * 60, stars: 1,
      setup(w, shipKey) {
         islands(w, [
            { c: P(0, 8300), r: 2300, height: 180, seed: 5, lobes: 6, elong: 3, rot: 0, rough: 0.4, name: 'Hela' },
            { c: P(1500, -2600), r: 700, height: 150, seed: 9, lobes: 4, rough: 0.6 },
            { c: P(-3200, -6800), r: 1100, height: 240, seed: 13, lobes: 5, elong: 1.6, rot: 0.8 },
         ]);
         add(w, shipKey, 'player', P(-6500, 0), 0, { isPlayer: true });
         const tgt = { passive: true, patrolSpeed: 1 };
         add(w, 'Transport', 'enemy', P(3200, -3800), Math.PI / 2, { telegraph: 1, speedKn: 8, ai: { ...tgt, patrol: [P(3200, -3800), P(3600, 1500)] } });
         add(w, 'Transport', 'enemy', P(5200, 600), -Math.PI / 2, { telegraph: 1, speedKn: 8, ai: { ...tgt, patrol: [P(5200, 600), P(5000, -4200)] } });
         add(w, 'Transport', 'enemy', P(4200, 3600), 0, { telegraph: 1, speedKn: 8, ai: { ...tgt, patrol: [P(4200, 3600), P(6800, 3200)] } });
         objective(w, 'targets', 'Versenken Sie die Zielschiffe (0/3)');
         w.score = { kind: 'count', player: 0, enemy: 0, target: 3 };
         w.message('Übung beginnt. Zielschiffe liegen östlich – Feuer frei!');
         w._script.phase = 1;
      },
      onSink(w, ship, killer, S) {
         if (ship.side !== 'enemy') return;
         w.score.player++;
         if (S.phase === 1) {
            const n = S.def._count(w, 'Transport');
            objText(w, 'targets', `Versenken Sie die Zielschiffe (${n}/3)`);
            if (n >= 3) {
               setObj(w, 'targets', 'done');
               S.phase = 2;
               later(S, w.time + 6, () => {
                  w.message('Alarm! Britische Zerstörer greifen aus Osten an. Z 25 kommt zur Unterstützung.', 'warn');
                  add(w, 'Jervis', 'enemy', P(8200, -4500), Math.PI * 0.9, { minDist: 10000 });
                  add(w, 'Jervis', 'enemy', P(8200, 4200), -Math.PI * 0.9, { minDist: 10000 });
                  add(w, 'Z23', 'player', P(-7000, 1500), 0, { name: 'Z 25' });
                  objective(w, 'dds', 'Wehren Sie den Zerstörerangriff ab (0/2)');
                  w.score = { kind: 'count', player: 0, enemy: 0, target: 2 };
               });
            }
         } else if (S.phase === 2 && ship.type === 'DD') {
            const n = S.def._count(w, 'Jervis');
            objText(w, 'dds', `Wehren Sie den Zerstörerangriff ab (${n}/2)`);
            if (n >= 2) { setObj(w, 'dds', 'done'); w.end(true, 'Übung erfolgreich abgeschlossen.'); }
         }
      },
      _count: (w, cls) => w.roster.filter(s => s.side === 'enemy' && s.cls === cls && !s.alive).length,
      timeout(w) { w.end(false, 'Die Übungszeit ist abgelaufen.'); },
   },

   // ------------------------------------------------------------ 2. standard battle
   {
      id: 'standard', name: 'Standardgefecht', subtitle: 'Nordkap-Schären · 7 gegen 7',
      briefing: 'Ein britischer Kampfverband wurde vor dem Nordkap gemeldet. Unser Verband aus zwei Schlachtschiffen, ' +
         'drei Kreuzern und zwei Zerstörern stellt ihn zwischen den Schären. Vernichten Sie alle feindlichen Schiffe. ' +
         'Nutzen Sie die Inseln als Deckung und bleiben Sie in der Nähe Ihrer Verbündeten.',
      env: { time: 'day', weather: 'overcast' }, type: 'annihilation', playableShips: null, recommendedShip: 'Bismarck',
      arena: 12000, timeLimit: 20 * 60, stars: 2,
      setup(w, shipKey) {
         islands(w, [
            { c: P(0, 0), r: 1300, height: 240, seed: 11, lobes: 6, rough: 0.6, peaks: [{ x: -250, y: 150, h: 330, r: 600 }] },
            { c: P(-2600, -5200), r: 1100, height: 190, seed: 23, lobes: 5, elong: 1.8, rot: 0.5 },
            { c: P(2800, 5000), r: 1150, height: 200, seed: 37, lobes: 5, elong: 1.6, rot: -0.4 },
            { c: P(4300, -2300), r: 620, height: 120, seed: 41, lobes: 4 },
            { c: P(-4300, 2600), r: 680, height: 140, seed: 53, lobes: 4 },
            { c: P(600, -9900), r: 1900, height: 380, seed: 61, lobes: 6, elong: 2.2, rot: 0.1, rough: 0.7 },
            { c: P(-900, 9800), r: 1600, height: 300, seed: 71, lobes: 6, elong: 2, rot: -0.1, rough: 0.7 },
            { c: P(7400, 6200), r: 750, height: 160, seed: 83, lobes: 4 },
            { c: P(-7400, -6000), r: 780, height: 170, seed: 89, lobes: 4 },
         ]);
         spawnTeam(w, 'player', DE_TEAM, P(-9200, 0), 0, shipKey);
         spawnTeam(w, 'enemy', UK_TEAM, P(9200, 0), Math.PI, null);
         objective(w, 'kill', 'Vernichten Sie alle feindlichen Schiffe (0/7)');
         w.score = { kind: 'kills', player: 0, enemy: 0, target: 7 };
      },
      onSink(w, ship, killer, S) { annihilationSink(w, ship, 'kill', 'Vernichten Sie alle feindlichen Schiffe'); },
      timeout(w) { timeoutByHP(w); },
   },

   // ------------------------------------------------------------ 3. domination
   {
      id: 'domination', name: 'Herrschaft', subtitle: 'Drei Punkte · Erster auf 1000',
      briefing: 'Drei strategische Seegebiete – A, B und C – entscheiden über die Kontrolle der Fjordausfahrt. ' +
         'Jeder gehaltene Punkt bringt laufend Punkte, jede Versenkung ebenfalls. Das erste Team mit 1000 Punkten gewinnt; ' +
         'fällt ein Team auf 0 oder wird vernichtet, ist das Gefecht ebenfalls entschieden. Zerstörer sollten die Punkte früh besetzen.',
      env: { time: 'day', weather: 'clear' }, type: 'domination', playableShips: null, recommendedShip: 'Hipper',
      arena: 11000, timeLimit: 20 * 60, stars: 2,
      setup(w, shipKey) {
         islands(w, [
            { c: P(-1900, -2400), r: 900, height: 210, seed: 101, lobes: 5, elong: 1.5, rot: 0.9 },
            { c: P(2000, 2500), r: 950, height: 230, seed: 103, lobes: 5, elong: 1.5, rot: 0.9 },
            { c: P(300, -9000), r: 2000, height: 420, seed: 107, lobes: 7, elong: 2.4, rot: 0.05, rough: 0.7 },
            { c: P(-300, 9100), r: 2000, height: 400, seed: 109, lobes: 7, elong: 2.4, rot: -0.05, rough: 0.7 },
            { c: P(-5200, -5600), r: 700, height: 150, seed: 113, lobes: 4 },
            { c: P(5200, 5700), r: 700, height: 150, seed: 127, lobes: 4 },
            { c: P(4900, -3900), r: 620, height: 130, seed: 131, lobes: 4 },
            { c: P(-4900, 3900), r: 620, height: 130, seed: 137, lobes: 4 },
         ]);
         w.caps = ['A', 'B', 'C'].map((id, i) => ({ id, pos: P(0, (i - 1) * 5000), r: 800, owner: null, progress: 0, capper: null, contested: false, time: 40 }));
         const capFor = (side) => (cls, i) => SHIPS[cls].hull.type === 'DD' ? { capId: i % 2 ? 'C' : 'A' } : SHIPS[cls].hull.type === 'CL' ? { capId: 'B' } : {};
         spawnTeam(w, 'player', DE_TEAM, P(-8800, 0), 0, shipKey, capFor('player'));
         spawnTeam(w, 'enemy', UK_TEAM, P(8800, 0), Math.PI, null, capFor('enemy'));
         objective(w, 'points', 'Erreichen Sie 1000 Punkte');
         objective(w, 'caps', 'Halten Sie die Punkte A, B und C', { optional: true });
         w.score = { kind: 'points', player: 300, enemy: 300, target: 1000 };
         w._script.capTick = 0;
      },
      update(w, dt, S) {
         S.capTick += dt;
         if (S.capTick >= 5) {
            S.capTick -= 5;
            for (const c of w.caps) if (c.owner) w.score[c.owner] += 3 * 2;
         }
         const own = w.caps.filter(c => c.owner === 'player').length;
         objText(w, 'caps', `Halten Sie die Punkte A, B und C (${own}/3)`);
         dominationCheck(w);
      },
      onSink(w, ship, killer, S) {
         const big = ship.type === 'BB';
         if (ship.side === 'enemy') { w.score.player += big ? 45 : 35; w.score.enemy -= big ? 60 : 45; }
         else if (ship.side === 'player') { w.score.enemy += big ? 45 : 35; w.score.player -= big ? 60 : 45; }
         if (!combatants(w, 'enemy').length) w.score.player = Math.max(w.score.player, 1000);
         if (!combatants(w, 'player').length) w.score.enemy = Math.max(w.score.enemy, 1000);
         dominationCheck(w);
      },
      timeout(w) {
         const s = w.score;
         if (s.player > s.enemy) w.end(true, 'Zeit abgelaufen – Ihr Team führt nach Punkten.');
         else w.end(false, 'Zeit abgelaufen – der Gegner führt nach Punkten.');
      },
   },

   // ------------------------------------------------------------ 4. convoy escort
   {
      id: 'convoy', name: 'Geleitzug', subtitle: 'Skagerrak-Enge · Geleitschutz',
      briefing: 'Fünf Frachter mit Nachschub für Norwegen müssen die Skagerrak-Enge passieren. Britische Kreuzer und ' +
         'Zerstörer lauern im Osten und werden in Wellen angreifen. Schützen Sie den Geleitzug, bis mindestens zwei Frachter ' +
         'den Ausgang im Osten erreichen. Gehen vier Frachter verloren, ist die Mission gescheitert. Rechnen Sie mit Torpedoangriffen.',
      env: { time: 'dusk', weather: 'overcast' }, type: 'escort', playableShips: null, recommendedShip: 'Hipper',
      arena: 12000, timeLimit: 16 * 60, stars: 3,
      setup(w, shipKey) {
         islands(w, [
            { c: P(-300, -8700), r: 2600, height: 420, seed: 201, lobes: 7, elong: 2.6, rot: 0.08, rough: 0.7, peaks: [{ x: -1200, y: 400, h: 480, r: 900 }] },
            { c: P(300, 8900), r: 2500, height: 380, seed: 203, lobes: 7, elong: 2.6, rot: -0.05, rough: 0.7 },
            { c: P(-2400, -3900), r: 1150, height: 220, seed: 207, lobes: 5, elong: 1.4, rot: 0.3 },
            { c: P(2600, 3700), r: 1250, height: 240, seed: 211, lobes: 5, elong: 1.4, rot: 0.2 },
            { c: P(7000, 3900), r: 850, height: 160, seed: 213, lobes: 4 },
            { c: P(-7200, -3700), r: 850, height: 170, seed: 217, lobes: 4 },
            { c: P(6200, -4600), r: 700, height: 140, seed: 219, lobes: 4 },
         ]);
         const route = [P(-4000, 1500), P(0, 0), P(4800, -1000), P(9800, -700)];
         const S = w._script;
         S.exit = { x: 8800, y: -700, r: 1400 };
         S.transports = [];
         for (let i = 0; i < 5; i++) {
            const t = add(w, 'Transport', 'player', P(-8000 - i * 600, 850 + (i % 2) * 550), 0,
               { telegraph: 4, speedKn: 14, nation: 'de', hpMult: 2.5, ai: { route, routeIdx: 0, passive: true, convoy: true } });
            S.transports.push(t);
         }
         add(w, shipKey, 'player', P(-6800, 2300), 0, { isPlayer: true });
         add(w, 'Z23', 'player', P(-6500, -300), 0, { ai: { escortId: S.transports[0].id } });
         add(w, 'Z23', 'player', P(-9800, 2300), 0, { ai: { escortId: S.transports[3].id } });
         add(w, 'Nuernberg', 'player', P(-7700, -700), 0, { ai: { escortId: S.transports[1].id } });
         // wave 1 waits in the east
         add(w, 'Jervis', 'enemy', P(8500, 2500), Math.PI, { ai: { huntId: S.transports[0].id } });
         add(w, 'Jervis', 'enemy', P(9200, 4200), Math.PI, { ai: { huntId: S.transports[1].id } });
         later(S, 150, () => {
            w.message('Zweite Angriffswelle aus Nordosten gemeldet!', 'warn');
            add(w, 'Norfolk', 'enemy', P(10800, -5200), Math.PI * 0.85, { minDist: 11000, ai: { huntId: S.transports[1].id } });
            add(w, 'Jervis', 'enemy', P(11000, -4000), Math.PI * 0.85, { minDist: 11000, ai: { huntId: S.transports[3].id } });
         });
         later(S, 330, () => {
            w.message('Dritte Welle: Kreuzer Fiji aus Südosten!', 'warn');
            add(w, 'Fiji', 'enemy', P(10800, 5200), -Math.PI * 0.85, { minDist: 11000, ai: { huntId: S.transports[2].id } });
         });
         objective(w, 'arrive', 'Mindestens 2 Frachter erreichen den Ausgang (0/2)');
         objective(w, 'lose', 'Nicht mehr als 3 Frachter verlieren (0 verloren)');
         w.score = { kind: 'convoy', player: 0, enemy: 0, target: 2 };
         S.arrived = 0; S.lost = 0;
         w.message('Geleitzug läuft aus. Halten Sie sich nahe bei den Frachtern.');
      },
      update(w, dt, S) {
         for (const t of S.transports) {
            if (t.alive && dist2(t.pos, S.exit) < S.exit.r * S.exit.r) {
               w.removeShip(t, 'arrived');
               S.arrived++;
               w.score.player = S.arrived;
               w.message(`${t.name} hat den Ausgang erreicht.`);
               objText(w, 'arrive', `Mindestens 2 Frachter erreichen den Ausgang (${S.arrived}/2)`);
               if (S.arrived >= 2) setObj(w, 'arrive', 'done');
            }
         }
         const inTransit = S.transports.filter(t => t.alive).length;
         if (S.arrived >= 2 && inTransit === 0) w.end(true, `${S.arrived} Frachter sicher durchgebracht.`);
      },
      onSink(w, ship, killer, S) {
         if (ship.type === 'TR' && ship.side === 'player') {
            S.lost++;
            w.score.enemy = S.lost;
            objText(w, 'lose', `Nicht mehr als 3 Frachter verlieren (${S.lost} verloren)`);
            if (S.lost >= 4) { setObj(w, 'lose', 'failed'); w.end(false, 'Der Geleitzug wurde aufgerieben.'); return; }
            if (S.arrived + S.transports.filter(t => t.alive).length < 2) { w.end(false, 'Zu wenige Frachter übrig.'); return; }
         }
         if (S.arrived >= 2 && !S.transports.some(t => t.alive)) w.end(true, `${S.arrived} Frachter sicher durchgebracht.`);
      },
      timeout(w, S) {
         if (S.arrived >= 2) w.end(true, `${S.arrived} Frachter sicher durchgebracht.`);
         else w.end(false, 'Der Geleitzug hat sein Ziel nicht rechtzeitig erreicht.');
      },
   },

   // ------------------------------------------------------------ 5. Denmark Strait
   {
      id: 'rheinuebung', name: 'Unternehmen Rheinübung', subtitle: 'Dänemarkstraße · 24. Mai 1941',
      briefing: 'Morgengrauen in der Dänemarkstraße. Bismarck und Prinz Eugen werden von HMS Hood und HMS Prince of Wales ' +
         'abgefangen, die aus Südosten heranstürmen. Die Hood ist das Stolz der Royal Navy – schnell, aber schwach am Deck ' +
         'gepanzert. Versenken Sie die Hood und versenken oder vertreiben Sie die Prince of Wales. Die Schweren Kreuzer ' +
         'Norfolk und Suffolk folgen Ihnen seit Stunden und werden bald eingreifen.',
      env: { time: 'dawn', weather: 'overcast' }, type: 'historic', playableShips: ['Bismarck'], recommendedShip: 'Bismarck',
      arena: 13000, timeLimit: 20 * 60, stars: 2,
      setup(w, shipKey) {
         islands(w, [
            { c: P(-5500, -11300), r: 3000, height: 620, seed: 301, lobes: 8, elong: 3, rot: 0.15, rough: 0.8, snow: true, name: 'Grönland' },
            { c: P(5200, -11800), r: 2700, height: 560, seed: 303, lobes: 8, elong: 2.6, rot: -0.1, rough: 0.8, snow: true },
            { c: P(-1200, -6200), r: 700, height: 180, seed: 307, lobes: 4, snow: true },
            { c: P(9800, 9800), r: 1500, height: 300, seed: 311, lobes: 6, elong: 1.8, rot: 0.7, snow: true },
         ]);
         const S = w._script;
         add(w, 'Hipper', 'player', P(-7400, -1700), 0.25, { name: 'Prinz Eugen', ai: { escortIdPlayer: true } });
         add(w, pickShip(this, shipKey), 'player', P(-8400, -2000), 0.25, { isPlayer: true });
         S.hood = add(w, 'Hood', 'enemy', P(6500, 6200), -2.35, { name: 'HMS Hood', telegraph: 4, ai: { aggro: 1.2 } });
         S.pow = add(w, 'KGV', 'enemy', P(7500, 6700), -2.35, { name: 'HMS Prince of Wales', telegraph: 4, ai: { retreatBelow: 0.35, retreatTo: P(12500, 12500) } });
         later(S, 210, () => {
            w.message('Norfolk und Suffolk schließen von achtern auf!', 'warn');
            add(w, 'Norfolk', 'enemy', P(-12000, -4800), 0.2, { name: 'HMS Norfolk', minDist: 13000 });
            add(w, 'Norfolk', 'enemy', P(-12200, -2600), 0.1, { name: 'HMS Suffolk', minDist: 13000 });
         });
         objective(w, 'hood', 'Versenken Sie HMS Hood');
         objective(w, 'pow', 'Versenken oder vertreiben Sie HMS Prince of Wales');
         objective(w, 'eugen', 'Prinz Eugen darf nicht sinken', { optional: true });
         w.score = { kind: 'kills', player: 0, enemy: 0, target: 2 };
      },
      update(w, dt, S) {
         const pow = S.pow;
         if (pow.alive && pow.ai.retreating && (Math.abs(pow.pos.x) > w.arena - 900 || Math.abs(pow.pos.y) > w.arena - 900)) {
            w.removeShip(pow, 'retreated');
            w.message('HMS Prince of Wales dreht schwer beschädigt ab!');
            setObj(w, 'pow', 'done', 'HMS Prince of Wales vertrieben');
            w.score.player++;
            rheinCheck(w);
         }
      },
      onSink(w, ship, killer, S) {
         if (ship === S.hood) { setObj(w, 'hood', 'done'); w.score.player++; w.message('Die Hood explodiert! Sie ist weg!'); }
         else if (ship === S.pow) { setObj(w, 'pow', 'done'); w.score.player++; }
         else if (ship.name === 'Prinz Eugen') setObj(w, 'eugen', 'failed');
         rheinCheck(w);
      },
      timeout(w) { w.end(false, 'Die Home Fleet ist heran – Sie müssen den Kampf abbrechen.'); },
   },

   // ------------------------------------------------------------ 6. last stand
   {
      id: 'laststand', name: 'Letztes Gefecht', subtitle: 'Nordatlantik · 27. Mai 1941',
      briefing: 'Ein Torpedotreffer hat das Ruder der Bismarck bei 12° Backbord verklemmt – Ihr Schiff zieht Kreise. ' +
         'Im Sturm nähern sich King George V und Rodney, begleitet von Kreuzern und Zerstörern. Lassen Sie Ihre Schadensbekämpfung ' +
         'das Ruder freibekommen und halten Sie zehn Minuten durch, bis der Home Fleet der Treibstoff ausgeht – oder versenken Sie beide Schlachtschiffe.',
      env: { time: 'day', weather: 'storm' }, type: 'survival', playableShips: ['Bismarck'], recommendedShip: 'Bismarck',
      arena: 11000, timeLimit: 10 * 60, stars: 3,
      setup(w, shipKey) {
         islands(w, [
            { c: P(-6500, 6500), r: 700, height: 110, seed: 401, lobes: 4, rough: 0.8 },
            { c: P(6800, -6000), r: 600, height: 90, seed: 403, lobes: 4, rough: 0.8 },
            { c: P(2500, 3200), r: 380, height: 70, seed: 405, lobes: 3, rough: 0.9 },
         ]);
         const S = w._script;
         // Heavy seas: the Home Fleet's gunlayers struggle too (the player cannot dodge with a jammed rudder)
         w.difficulty = { ...w.difficulty, aimErr: w.difficulty.aimErr * 1.4 };
         const p = add(w, pickShip(this, shipKey), 'player', P(0, 0), 0.8, { isPlayer: true, telegraph: 2 });
         p.hp = Math.round(p.maxHP * 0.85);
         p.modules.rudder = 60;           // jammed: DC (R) frees it early
         p.rudder = -0.55; p.rudderCmd = -1;
         S.kgv = add(w, 'KGV', 'enemy', P(-9000, -9500), 0.9, { name: 'King George V', telegraph: 4 });
         S.rodney = add(w, 'Rodney', 'enemy', P(-10200, -7600), 0.8, { name: 'HMS Rodney', telegraph: 4 });
         later(S, 100, () => {
            w.message('Zerstörer Cossack läuft zum Torpedoangriff an!', 'warn');
            add(w, 'Jervis', 'enemy', P(9500, 2500), Math.PI, { name: 'HMS Cossack', minDist: 10000 });
         });
         later(S, 120, () => {
            w.message('Kreuzer Norfolk und Dorsetshire greifen ein!', 'warn');
            add(w, 'Norfolk', 'enemy', P(1500, -10500), 1.6, { name: 'HMS Norfolk', minDist: 12000 });
            add(w, 'Norfolk', 'enemy', P(4000, 10500), -1.8, { name: 'HMS Dorsetshire', minDist: 12000 });
         });
         later(S, 300, () => {
            w.message('Weitere Zerstörer: Maori und Zulu!', 'warn');
            add(w, 'Jervis', 'enemy', P(10500, 4000), Math.PI, { name: 'HMS Maori', minDist: 11000 });
            add(w, 'Jervis', 'enemy', P(10500, -3000), Math.PI, { name: 'HMS Zulu', minDist: 11000 });
         });
         objective(w, 'survive', 'Überleben Sie bis zum Abdrehen der Home Fleet (10:00)');
         objective(w, 'bbs', 'Oder: Versenken Sie King George V und Rodney (0/2)');
         objective(w, 'rudder', 'Ruder freibekommen (Schadensbekämpfung)', { optional: true });
         w.score = { kind: 'kills', player: 0, enemy: 0, target: 2 };
         w.message('Ruder klemmt! Schadensbekämpfung einsetzen!', 'warn');
      },
      update(w, dt, S) {
         const p = w.player;
         if (p && p.alive && p.modules.rudder <= 0) setObj(w, 'rudder', 'done');
         const m = Math.floor(w.timeLeft / 60), s = Math.floor(w.timeLeft % 60);
         objText(w, 'survive', `Überleben Sie bis zum Abdrehen der Home Fleet (${m}:${String(s).padStart(2, '0')})`);
      },
      onSink(w, ship, killer, S) {
         if (ship === S.kgv || ship === S.rodney) {
            const n = [S.kgv, S.rodney].filter(s => !s.alive).length;
            w.score.player = n;
            objText(w, 'bbs', `Oder: Versenken Sie King George V und Rodney (${n}/2)`);
            if (n >= 2) { setObj(w, 'bbs', 'done'); setObj(w, 'survive', 'done'); w.end(true, 'Die Schlachtschiffe der Home Fleet sind versenkt!'); }
         }
      },
      timeout(w) { setObj(w, 'survive', 'done'); w.end(true, 'Die Home Fleet dreht mit leeren Bunkern ab – die Bismarck lebt!'); },
   },

   // ------------------------------------------------------------ 7. night action
   {
      id: 'night', name: 'Nachtgefecht', subtitle: 'Norwegische Schären · Zerstörerschlacht',
      briefing: 'Neumond über den Schären. Eine britische Zerstörerflottille mit Kreuzerunterstützung versucht, in den Fjord ' +
         'einzudringen. Bei Nacht sieht man Schiffe erst auf kurze Distanz – das Mündungsfeuer verrät jedoch jeden Schützen. ' +
         'Nutzen Sie Inseln, Nebel und Torpedos. Vernichten Sie den Feind.',
      env: { time: 'night', weather: 'clear' }, type: 'annihilation', playableShips: null, recommendedShip: 'Z23',
      arena: 10000, timeLimit: 15 * 60, stars: 2,
      setup(w, shipKey) {
         islands(w, [
            { c: P(0, -8600), r: 2400, height: 450, seed: 501, lobes: 8, elong: 2.8, rot: 0, rough: 0.8, peaks: [{ x: 800, y: 300, h: 520, r: 900 }] },
            { c: P(-200, 8700), r: 2300, height: 420, seed: 503, lobes: 8, elong: 2.8, rot: 0, rough: 0.8 },
         ]);
         scatter(w, 507, 11, [-6500, -6000, 6500, 6000], 380, 950, [P(-8200, 0), P(8200, 0)].map(p => ({ ...p, r: 2400 })));
         const DE = [['Z23', 0, -800], ['Z23', 0, 800], ['Z23', 500, 0], ['Nuernberg', -700, -1800], ['Hipper', -900, 1800]];
         const UK = [['Jervis', 0, -900], ['Jervis', 0, 900], ['Jervis', 500, -2400], ['Jervis', 500, 2400], ['Fiji', -700, -600], ['Norfolk', -900, 1000]];
         spawnTeam(w, 'player', DE, P(-8200, 0), 0, shipKey);
         spawnTeam(w, 'enemy', UK, P(8200, 0), Math.PI, null);
         const n = combatants(w, 'enemy').length;
         objective(w, 'kill', `Vernichten Sie alle feindlichen Schiffe (0/${n})`);
         w.score = { kind: 'kills', player: 0, enemy: 0, target: n };
      },
      onSink(w, ship) { annihilationSink(w, ship, 'kill', 'Vernichten Sie alle feindlichen Schiffe'); },
      timeout(w) { timeoutByHP(w); },
   },

   // ------------------------------------------------------------ 8. commerce raid
   {
      id: 'raid', name: 'Handelskrieg', subtitle: 'Nordatlantik · Unternehmen Berlin',
      briefing: 'Ein britischer Geleitzug aus sechs Frachtern läuft nach Osten, gesichert von einem Kreuzer und zwei Zerstörern. ' +
         'Gemeinsam mit der Gneisenau sollen Sie mindestens vier Frachter versenken, bevor sie den Schutz der Küste erreichen. ' +
         'Vorsicht: Die Funkaufklärung meldet ein britisches Schlachtschiff, das dem Geleitzug zu Hilfe eilt.',
      env: { time: 'day', weather: 'rain' }, type: 'raid', playableShips: null, recommendedShip: 'Hipper',
      arena: 12500, timeLimit: 18 * 60, stars: 3,
      setup(w, shipKey) {
         islands(w, [
            { c: P(11200, -9000), r: 2600, height: 360, seed: 601, lobes: 7, elong: 2, rot: 0.9, rough: 0.7, name: 'Küste' },
            { c: P(3000, -4500), r: 900, height: 170, seed: 603, lobes: 5 },
            { c: P(-4500, -3500), r: 750, height: 150, seed: 607, lobes: 4 },
            { c: P(5500, 6200), r: 1000, height: 190, seed: 611, lobes: 5, elong: 1.5 },
            { c: P(-6000, 8200), r: 1200, height: 230, seed: 613, lobes: 5, elong: 1.8, rot: 0.4 },
         ]);
         const S = w._script;
         const route = [P(-6000, 4500), P(0, 2200), P(6000, 800), P(11600, -2600)];
         S.exit = { x: 11000, y: -2400, r: 1300 };
         S.transports = [];
         for (let i = 0; i < 6; i++) {
            S.transports.push(add(w, 'Transport', 'enemy', P(-10800 + (i >> 1) * -700, 5600 + (i & 1) * 700), -0.2,
               { telegraph: 4, speedKn: 11, ai: { route, routeIdx: 0, passive: true, convoy: true, zigzag: true } }));
         }
         add(w, 'Fiji', 'enemy', P(-9200, 4500), -0.2, { ai: { escortId: S.transports[0].id } });
         add(w, 'Jervis', 'enemy', P(-9700, 7300), -0.2, { ai: { escortId: S.transports[1].id } });
         add(w, 'Jervis', 'enemy', P(-12000, 5200), -0.2, { ai: { escortId: S.transports[4].id } });
         add(w, pickShip(this, shipKey), 'player', P(-3000, -9000), 1.2, { isPlayer: true });
         add(w, 'Scharnhorst', 'player', P(-1500, -10000), 1.3, { name: 'Gneisenau' });
         later(S, 240, () => {
            w.message('HMS Rodney und HMS Sussex nähern sich aus Osten!', 'warn');
            add(w, 'Rodney', 'enemy', P(12000, 2500), Math.PI, { name: 'HMS Rodney', minDist: 12000 });
            add(w, 'Norfolk', 'enemy', P(12000, 4200), Math.PI, { name: 'HMS Sussex', minDist: 12000 });
         });
         objective(w, 'sink', 'Versenken Sie 4 Frachter (0/4)');
         objective(w, 'escape', 'Höchstens 2 Frachter entkommen lassen (0 entkommen)');
         w.score = { kind: 'raid', player: 0, enemy: 0, target: 4 };
         S.sunk = 0; S.escaped = 0;
      },
      update(w, dt, S) {
         for (const t of S.transports) {
            if (t.alive && dist2(t.pos, S.exit) < S.exit.r * S.exit.r) {
               w.removeShip(t, 'escaped');
               S.escaped++;
               w.score.enemy = S.escaped;
               w.message(`${t.name} ist entkommen.`, 'warn');
               objText(w, 'escape', `Höchstens 2 Frachter entkommen lassen (${S.escaped} entkommen)`);
               if (S.escaped > 2) { setObj(w, 'escape', 'failed'); w.end(false, 'Zu viele Frachter sind entkommen.'); }
            }
         }
      },
      onSink(w, ship, killer, S) {
         if (ship.type !== 'TR' || ship.side !== 'enemy') return;
         S.sunk++;
         w.score.player = S.sunk;
         objText(w, 'sink', `Versenken Sie 4 Frachter (${Math.min(S.sunk, 4)}/4)`);
         if (S.sunk >= 4) { setObj(w, 'sink', 'done'); setObj(w, 'escape', 'done'); w.end(true, `${S.sunk} Frachter versenkt – der Geleitzug ist zerschlagen.`); }
      },
      timeout(w, S) { w.end(false, `Nur ${S.sunk} Frachter versenkt – zu wenig.`); },
   },
];

// ---------------------------------------------------------------- shared win logic
function annihilationSink(w, ship, objId, base) {
   if (ship.side === 'enemy' && ship.type !== 'TR') w.score.player++;
   else if (ship.side === 'player' && ship.type !== 'TR') w.score.enemy++;
   objText(w, objId, `${base} (${w.score.player}/${w.score.target})`);
   if (!combatants(w, 'enemy').length) { setObj(w, objId, 'done'); w.end(true, 'Alle feindlichen Schiffe wurden versenkt.'); }
   else if (!combatants(w, 'player').length) w.end(false, 'Ihr Verband wurde vernichtet.');
}
function timeoutByHP(w) {
   const own = teamHPFrac(w, 'player'), foe = teamHPFrac(w, 'enemy');
   if (own > foe) w.end(true, 'Zeit abgelaufen – Ihr Verband hat die Oberhand behalten.');
   else w.end(false, 'Zeit abgelaufen – der Gegner hat die Oberhand behalten.');
}
function dominationCheck(w) {
   const s = w.score;
   if (s.player >= s.target || s.enemy <= 0) { s.player = Math.min(s.player, s.target); setObj(w, 'points', 'done'); w.end(true, 'Ihr Team hat 1000 Punkte erreicht.'); }
   else if (s.enemy >= s.target || s.player <= 0) { s.enemy = Math.min(s.enemy, s.target); setObj(w, 'points', 'failed'); w.end(false, 'Der Gegner hat 1000 Punkte erreicht.'); }
}
function rheinCheck(w) {
   const o = w.mission.objectives;
   if (o.find(x => x.id === 'hood').state === 'done' && o.find(x => x.id === 'pow').state === 'done') {
      const eu = o.find(x => x.id === 'eugen');
      if (eu.state === 'active') setObj(w, 'eugen', 'done');
      w.end(true, 'Die Dänemarkstraße gehört der Kriegsmarine.');
   }
}

// ---------------------------------------------------------------- public API
const BY_ID = Object.fromEntries(DEFS.map(d => [d.id, d]));
// Menu data only (no functions).
export const MISSIONS = DEFS.map(d => ({
   id: d.id, name: d.name, subtitle: d.subtitle, briefing: d.briefing, env: { ...d.env }, type: d.type,
   playableShips: d.playableShips ? [...d.playableShips] : [...PLAYABLE], recommendedShip: d.recommendedShip,
   timeLimit: d.timeLimit, arena: d.arena, stars: d.stars || 2,   // stars = difficulty 1..3 for the menu
}));
export const MISSION_IDS = DEFS.map(d => d.id);
export function getMission(id) { return MISSIONS.find(m => m.id === id) || null; }

export function setupMission(w, id, shipKey) {
   const def = BY_ID[id] || BY_ID.standard;
   w.arena = def.arena;
   w.setEnv(def.env);
   w.mission = { id: def.id, name: def.name, subtitle: def.subtitle, briefing: def.briefing, type: def.type, objectives: [] };
   w.timeLeft = def.timeLimit;
   w._script = { def, timers: [], used: new Set(), dup: 0, onSink: (ww, ship, killer) => def.onSink && def.onSink(ww, ship, killer, ww._script) };
   def.setup.call(def, w, pickShip(def, shipKey));
   if (!w.player) throw new Error('mission ' + def.id + ' spawned no player');
}

export function updateMission(w, dt) {
   const S = w._script;
   if (!S) return;
   if (S.timers.length) {
      const due = S.timers.filter(t => w.time >= t.t);
      if (due.length) { S.timers = S.timers.filter(t => w.time < t.t); for (const t of due) t.fn(); }
   }
   if (S.def.update) S.def.update(w, dt, S);
   if (w.phase === 'playing' && w.timeLeft != null && w.timeLeft <= 0) S.def.timeout(w, S);
}
