// gamev2/missions_east.js — operations 6-10 of the modern mode (fictional present-day scenarios):
//    barents    Barentssee: carrier group defence, survive the big salvo, then the counter-strike
//    reefs      Südchinesisches Meer – Riffe: blind the radar, then the coastal batteries
//    strait     Taiwanstraße: bring a supply convoy through at night
//    philsea    Philippinensee: carrier against carrier, who is found first suffers
//    countdown  Finale – Countdown: a launcher on an island, a timer, cruise missiles or a commando team
// Each definition has the shape of missions.js DEFS; H = missionHelpers. Everything a mission keeps
// between ticks lives in world._script (S) and refers to ships by id (co-op swaps bot hulls for
// human captains after setup, world.replaceShip keeps the id).
// Balance: EAST_TUNE holds the knobs per mission and difficulty (tests/v2.missions.east.test.mjs
// measures them with a bot captain). Allied bots hit with `ally` times the normal damage and keep
// their cruise missiles in the cells, so the mission is decided by the human captains.
import { addSite } from './sites.js';
import { addBlast } from './blast.js';
import { addTaskPoint } from './seal.js';
import { launchSSM, ssmBlock } from './missile.js';
import { launchSquadron } from './air.js';
import { setRadar } from './sensors.js';

export const EAST_TUNE = {
   window: 120,              // s the allied bots keep firing after a human captain's last launch or hit
   barents: {
      easy: { ally: 1, salvoAt: 120, granit: 12, oniks: 4, raids: 1, pjHp: 0.2, corv: 1, close: 8500, again: 540, granit2: 8, oniks2: 0 },
      normal: { ally: 0.8, salvoAt: 120, granit: 20, oniks: 8, raids: 2, pjHp: 0.4, corv: 1, close: 14000, again: 480, granit2: 12, oniks2: 4 },
      hard: { ally: 0.6, salvoAt: 110, granit: 24, oniks: 10, raids: 3, pjHp: 0.5, corv: 2, close: 13000, again: 460, granit2: 16, oniks2: 6 },
      ship: { Daring: t => ({ granit: Math.round(t.granit * 1.3), oniks: t.oniks + 2 }) },
   },
   reefs: {
      easy: { ally: 0.6, boats: 3, boatsAt: 300, frig: 2, samCh: 2, blindCh: 1, samN: 8, relief: ['Typ054A'], reliefHp: 0.6 },
      normal: { ally: 0.5, boats: 3, boatsAt: 240, frig: 2, samCh: 2, blindCh: 1, samN: 10, relief: ['Typ052D'], reliefHp: 1 },
      hard: { ally: 0.4, boats: 3, boatsAt: 160, frig: 2, samCh: 3, blindCh: 1, samN: 13, relief: ['Typ055'], reliefHp: 1 },
      ship: { Ticonderoga: t => ({ reliefHp: t.reliefHp * 0.75 }) },
   },
   strait: {
      easy: { ally: 0.6, fac1: 3, fac2: 3, dd: 1, w2: 190, w3: 330, raid: 90, sub: 1 },
      normal: { ally: 0.5, fac1: 3, fac2: 3, dd: 1, w2: 160, w3: 300, raid: 70, sub: 1 },
      hard: { ally: 0.4, fac1: 3, fac2: 4, dd: 1, w2: 140, w3: 270, raid: 60, sub: 1 },
      ship: { Burke: t => ({ raid: Math.round(t.raid * 1.4), fac1: t.fac1 - 1 }) },
   },
   philsea: {
      easy: { ally: 0.6, auto: 260, surprise: 70, out: 0.75, frig: 1, dd: 0, salvoAt: 540, salvo: 5, again: 0 },
      normal: { ally: 0.5, auto: 200, surprise: 55, out: 0.5, frig: 1, dd: 0, salvoAt: 450, salvo: 10, again: 75 },
      hard: { ally: 0.4, auto: 150, surprise: 40, out: 0.5, frig: 1, dd: 0, salvoAt: 400, salvo: 14, again: 70 },
      // an escort captain relies on the carrier bot: it hits harder and the Shandong stops flying earlier
      ship: Object.fromEntries(['Burke', 'Ticonderoga', 'Daring'].map(k => [k, t => ({ ally: t.ally * 1.6, out: Math.min(0.9, t.out + 0.15) })])),
   },
   countdown: {
      // surface run, three acts: air defence -> drone (`drone` s) finds the command bunker and the launcher
      // fires at the group (`fuse` s to the detonation, at the latest `strikeAt` s into the mission, again
      // every `again` s while the bunker stands) -> `drone2` s later the drone has the launcher
      easy: { ally: 0.6, time: 720, samCh: 2, samN: 16, recon: 40, hp: 9000, corv: 1, boats: 2, sub: 0, work: 30, tlam: 26, asw: 0, subTime: 650, subBoats: 1,
         drone: 50, fuse: 100, drone2: 65, again: 0, strikeAt: 330, bunkHp: 7000 },
      normal: { ally: 0.5, time: 690, samCh: 3, samN: 20, recon: 60, hp: 11000, corv: 2, boats: 3, sub: 0, work: 35, tlam: 22, asw: 0, subTime: 570, subBoats: 3,
         drone: 60, fuse: 85, drone2: 80, again: 170, strikeAt: 300, bunkHp: 9000 },
      hard: { ally: 0.4, time: 660, samCh: 3, samN: 24, recon: 75, hp: 12000, corv: 2, boats: 4, sub: 1, work: 40, tlam: 21, asw: 0, subTime: 545, subBoats: 4,
         drone: 60, fuse: 75, drone2: 80, again: 140, strikeAt: 270, bunkHp: 10000 },
      // the clock of a submarine run (the German boat is the slower one)
      ship: { U212: (t, k) => ({ subTime: t.subTime + 60 + (k === 'normal' ? 15 : 0) }), Virginia: (t, k) => ({ subTime: t.subTime - (k === 'normal' ? 15 : 0) }) },
   },
};

export function eastMissions(H) {
   const { P, add, objective, setObj, objText, later, radio, zone, inZone, islands, SHIPS } = H;
   // knobs of the difficulty, plus the adjustment (EAST_TUNE.<id>.ship[<ship>]) of the ship the player sails
   const tune = (w, id) => {
      const T = EAST_TUNE[id], t = T[w.difficultyKey] || T.normal, o = T.ship && T.ship[w._script && w._script.shipKey];
      return o ? { ...t, ...(typeof o === 'function' ? o(t, w.difficultyKey) : o) } : t;
   };
   const human = (s) => !!(s && (s.isPlayer || s.human));
   // co-op: human captains beyond the first (world.net is set after setup, so ask at the event, not in setup)
   const extraCaptains = (w) => Math.max(0, (w.net && w.net.humans ? w.net.humans.length : 1) - 1);
   const live = (w, id) => { const s = w.shipById(id); return s && s.alive ? s : null; };
   const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
   const hash = (w, salt) => {
      let h = (Math.imul((w.seed >>> 0) ^ 0x51ed27, 2654435761) + Math.imul(salt + 1, 40503)) >>> 0;
      h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13;
      return (h >>> 0) / 4294967296;
   };
   const mmss = (t) => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');

   // The own group: slots [class, ahead (m), to starboard (m)] around `at`. The player takes the slot
   // of its class, else slot `o.swap`; a submarine comes in addition at `o.subAt`. The other hulls are
   // allied bots: `o.dmg` damage, cruise missiles held back. Returns the ships in slot order (+ the boat).
   function fleet(w, shipKey, slots, at, hdg, o = {}) {
      const isSub = SHIPS[shipKey].hull.type === 'SS' && o.subAt;
      let pi = isSub ? -1 : slots.findIndex(s => s[0] === shipKey);
      if (pi < 0 && !isSub) pi = o.swap ?? 0;
      const c = Math.cos(hdg), s = Math.sin(hdg), out = [];
      slots.forEach(([cls, f, r], i) => {
         const pos = P(at.x + f * c - r * s, at.y + f * s + r * c);
         if (i === pi) { out.push(add(w, shipKey, 'player', pos, hdg, { isPlayer: true })); return; }
         const b = add(w, cls, 'player', pos, hdg, { dmgMult: o.dmg ?? 1, telegraph: 2, ai: { ...(o.ai || {}) } });
         const cw = b.cfg.weapons.cruise;
         if (cw && b.mag[cw.type]) b.mag[cw.type] = 0;
         out.push(b);
      });
      if (isSub) out.push(add(w, shipKey, 'player', o.subAt, o.subHdg ?? hdg, { isPlayer: true }));
      return out;
   }
   const ids = (list) => list.map(s => s.id);
   // every allied bot follows `lead` (the ship the mission is about, or the player)
   function follow(group, lead) { for (const s of group) if (s !== lead && !s.isPlayer && s.ai) s.ai.escortId = lead.id; }
   // scripted ripple salvo: the platform launches n missiles of its selected type, one per launch gap
   // (load: the platform has reloaded, the salvo does not depend on what is left in the cells)
   function ripple(S, fromId, n, aim, load) { (S.ripples || (S.ripples = [])).push({ fromId, n, aim, load }); }
   function runRipples(w, S) {
      if (!S.ripples) return false;
      let busy = false;
      for (const r of S.ripples) {
         if (r.n <= 0) continue;
         const from = live(w, r.fromId), aim = from && r.aim();
         if (!aim) { r.n = 0; continue; }
         if (r.load) for (const x of from.cfg.weapons.ssm) from.mag[x.type] = Math.max(from.mag[x.type] || 0, 1);
         const m = launchSSM(w, from, aim);
         if (m) { r.n--; from.mag[m.type]++; }      // the scripted salvo does not empty the magazine
         else if (ssmBlock(w, from, aim) !== 'reload') r.n = 0;
         if (r.n > 0) busy = true;
      }
      return busy;
   }
   // The allied bots fire on the lead of the human captains: an anti-ship or cruise missile launch or
   // damage dealt by a human opens their fire for EAST_TUNE.window seconds, an armed strike of a human
   // carrier in the air keeps it open (air defence is always free).
   // o.deck: bot carriers also hold their deck outside the window; o.hold: weapons tight regardless.
   function coordinate(w, S, o = {}) {
      let sum = 0;
      for (const s of w.ships) if (s.side === 'player' && human(s) && s.stats) sum += (s.stats.ssmFired || 0) * 1e4 + (s.stats.dmg || 0);
      if (S.coSum !== undefined && sum > S.coSum) S.freeT = w.time + (o.win || EAST_TUNE.window);
      S.coSum = sum;
      // a human carrier leads with its strike: bombers on the way count like a launch
      for (const q of w.squadrons) {
         if (q.side !== 'player' || q.type === 'ft' || q.n <= 0 || q.armed <= 0 || q.state === 'return' || q.state === 'land') continue;
         if (human(w.shipById(q.ownerId))) { S.freeT = Math.max(S.freeT || 0, w.time + 30); break; }
      }
      const free = !o.hold && w.time < (S.freeT || 0);
      for (const s of w.ships) {
         if (s.side !== 'player' || human(s) || s.type === 'TR' || !s.ai) continue;
         s.ai.passive = !free;
         if (o.deck && !free && s.air) s.air.deckT = Math.max(s.air.deckT, 2);
      }
      return free;
   }
   // The time limit is part of the order: the objective names it (lim) and the radio counts down the
   // last two minutes (clock, from update), so a mission never just stops.
   const lim = (w) => ` (Zeitlimit ${mmss((defs.find(d => d.id === w.mission.id) || {}).timeLimit || 0)})`;
   function clock(w, S, from, text) {
      for (const k of [120, 60]) if (w.timeLeft <= k && (S.clockSaid || 999) > k) { S.clockSaid = k; radio(w, from, text(k === 120 ? 'zwei Minuten' : 'eine Minute'), 'warn'); }
   }
   // why the escorts hold their fire (coordinate): said once, shortly after the start
   const holdLine = (w, S, t, from, text) => later(S, t, () => radio(w, from, text));
   const ownLost = (w) => w.roster.some(s => s.side === 'player' && s.type !== 'TR' && !s.alive && !s.escaped);
   const release = (s, hunt) => { if (!s || !s.ai) return; s.ai.passive = false; s.ai.anchored = false; delete s.ai.patrol; if (hunt != null) { s.ai.huntId = hunt; s.ai.press = true; } };

   // Countdown, surface run: the launcher's strike at the group. An armed blast with a label is the
   // danger zone on the map; it is centred on the flagship's position at the launch, so every ship can
   // leave it (`fuse` s), and it is gone when the command bunker falls before the detonation.
   const STRIKE_R = { destroyed: 1400, heavy: 2800, shock: 4400 };
   function strike(w, S) {
      const T = tune(w, 'countdown'), site = (id) => w.sites.find(s => s.id === id && s.alive);
      if (S.strikeId) {
         const left = S.strikeT0 - w.time;
         for (const k of [30, 10]) if (left <= k && S.strikeSaid > k) { S.strikeSaid = k; radio(w, 'Luftlage', `Einschlag in ${k} Sekunden${k === 10 ? '!' : '.'}`, 'warn'); }
         const b = w.blasts.find(x => x.id === S.strikeId);
         if (b) evacuate(w, S, b);
         return;
      }
      const B = site(S.bunkerId), flag = w.player && w.player.alive ? w.player : S.own.map(id => live(w, id)).find(Boolean);
      if (w.time < S.strikeAt || !B || !flag || !site(S.launcherId) || S.shown && !T.again) return;
      const first = !S.struck;
      const b = addBlast(w, { x: flag.pos.x, y: flag.pos.y, r: STRIKE_R, delay: T.fuse, label: 'Gegenschlag der Rampe' });
      S.strikeId = b.id; S.strikeT0 = b.t0; S.strikeSaid = 99; S.struck = (S.struck || 0) + 1; S.strikeAt = Infinity;
      radio(w, 'Luftlage', `Start von der Insel – der Flugkörper zielt auf Ihren Verband! Einschlag in ${T.fuse} Sekunden. Verlassen Sie die Gefahrenzone auf der Karte mit Höchstfahrt.`, 'warn');
      objText(w, 'launcher', 'Gegenschlag: Verlassen Sie die Gefahrenzone – oder zerstören Sie vor dem Einschlag den Führungsbunker');
      if (first) {
         B.detected = B.targetable = true;
         later(S, w.time + 7, () => { if (S.strikeId && site(S.bunkerId)) radio(w, 'Lagezentrum', (S.adDone ? 'Die Drohne' : 'Die Funkaufklärung') + ' hat den Führungsbunker der Insel erfasst. Fällt er vor dem Einschlag, verliert der Flugkörper seine Zieldaten.'); });
      }
      evacuate(w, S, b);
   }
   // the allied bots leave the zone on the shortest way (and do not follow the flagship back into it);
   // strikeOver lets them close up again
   function evacuate(w, S, b) {
      for (const id of S.own) {
         const s = live(w, id), d = s && dist(s.pos, b);
         if (!s || human(s) || !s.ai || s.ai.evac || d > b.r.shock + 800) continue;
         const k = (b.r.shock + 2500) / Math.max(d, 1);
         s.ai.route = [P(b.x + (s.pos.x - b.x) * k, b.y + (s.pos.y - b.y) * k)]; s.ai.routeIdx = 0; s.ai.evac = true;
      }
   }
   function strikeOver(w, S, why) {
      const T = tune(w, 'countdown');
      S.strikeId = null;
      for (const id of S.own) { const s = live(w, id); if (s && s.ai && s.ai.evac) { delete s.ai.route; delete s.ai.evac; s.ai.routeIdx = 0; } }
      objText(w, 'launcher', 'Zerstören Sie die Startrampe, bevor der Countdown abläuft');
      if (w.phase !== 'playing' || S.shown) return;
      if (T.again && w.sites.some(s => s.id === S.bunkerId && s.alive)) S.strikeAt = w.time + T.again;
      if (S.adDone) {
         S.reconAt = w.time + T.drone2;
         later(S, w.time + 6, () => radio(w, 'Lagezentrum', why + '. Die Drohne ist auf dem Weg dorthin – Zieldaten in etwa einer Minute.'));
      }
   }

   const defs = [
      // --------------------------------------------------------------------- 6. Barentssee
      {
         id: 'barents', group: 'ops', name: 'Barentssee', subtitle: 'Operation 6 · Trägerverband unter Beschuss',
         briefing: 'Der Trägerverband um die Gerald R. Ford steht in der Barentssee. Ein Verband um den Schlachtkreuzer ' +
            'Pjotr Weliki hat östlich Stellung bezogen, vom Küstenflugplatz starten Bomber. Die Aufklärung rechnet mit ' +
            'einer großen Flugkörpersalve auf den Träger. Halten Sie den Schirm geschlossen, bringen Sie die Ford durch ' +
            'die Salve – danach haben Sie Feuerfreigabe für den Gegenschlag auf den Schlachtkreuzer.',
         debrief: 'Der Verband hat die Salve aufgefangen und den Schlachtkreuzer ausgeschaltet. Beide Seiten ziehen ihre ' +
            'Einheiten zurück; die Lage in der Barentssee beruhigt sich.',
         env: { time: 'dusk', weather: 'overcast' }, type: 'ops', playableShips: ['Ford', 'Burke', 'Ticonderoga', 'Daring', 'Sachsen'],
         recommendedShip: 'Ford', arena: 24000, timeLimit: 720, stars: 2,
         setup(w, shipKey) {
            const S = w._script; S.shipKey = shipKey; const T = tune(w, 'barents');
            islands(w, [
               { c: P(3000, 21000), r: 2400, height: 210, seed: 7, lobes: 6, elong: 2.4, rot: 0.1, rough: 0.5, name: 'Nordküste' },
               { c: P(-4000, -17000), r: 1000, height: 150, seed: 19, lobes: 4, rough: 0.5 },
            ]);
            const g = fleet(w, shipKey, [['Ford', 0, 0], ['Ticonderoga', 2600, 0], ['Burke', 600, -2400], ['Burke', 600, 2400], ['Daring', -2200, 900]],
               P(-13500, -1000), 0, { swap: 4, dmg: T.ally });      // weapons tight from the first tick (coordinate)
            const ford = g[0];
            follow(g, ford);
            S.fordId = ford.id; S.own = ids(g);
            const hold = { passive: true, patrol: [P(12500, -4500), P(12500, 2500)] };
            const pj = add(w, 'PjotrWeliki', 'enemy', P(12500, -2500), Math.PI / 2, { telegraph: 1, hpMult: T.pjHp * w.difficulty.botHP, ai: { ...hold } });
            const foes = [pj,
               add(w, 'Gorschkow', 'enemy', P(10500, -4200), Math.PI / 2, { telegraph: 1, ai: { ...hold, patrol: [P(10500, -6200), P(10500, 800)] } }),
               add(w, 'Gorschkow', 'enemy', P(10500, -800), Math.PI / 2, { telegraph: 1, ai: { ...hold, patrol: [P(10500, -2800), P(10500, 4200)] } })];
            for (let i = 0; i < T.corv; i++) foes.push(add(w, 'BuyanM', 'enemy', P(14500, -5500 + i * 6000), Math.PI / 2, { telegraph: 1, ai: { ...hold, patrol: [P(14500, -7500 + i * 6000), P(14500, -3500 + i * 6000)] } }));
            S.pjId = pj.id; S.foes = ids(foes);
            const field = addSite(w, 'airfield', 'enemy', P(3000, 19600), { name: 'Flugplatz Nordküste' });
            field.nextT = 1e9;                         // the raids are scripted (no free strikes)
            addSite(w, 'radar', 'enemy', P(1500, 19600), { name: 'Radarstation Nordküste' });
            S.fieldId = field.id;
            objective(w, 'salvo', 'Bringen Sie die Gerald R. Ford durch die Flugkörpersalve');
            objective(w, 'screen', 'Verlieren Sie kein Schiff des Verbands', { optional: true });
            objective(w, 'deck', 'Halten Sie die Ford über 60 % Rumpfstärke', { optional: true });
            S.phase = 0;
            const raid = (type) => { const f = w.sites.find(x => x.id === S.fieldId), F = live(w, S.fordId); if (f && f.alive && F) launchSquadron(w, f, type, { kind: 'strike', targetId: F.id }); };
            later(S, 5, () => radio(w, 'Flottenkommando', 'Gegnerischer Verband 26 km östlich. Feuer nur zur Abwehr – halten Sie den Schirm um die Ford.'));
            holdLine(w, S, 14, 'Verbandsführer', 'Die Geleitschiffe halten ihre Seezielflugkörper zurück, bis das Flaggschiff den Gegenschlag eröffnet – dann feuert der Verband mit.');
            later(S, T.salvoAt - 40, () => { radio(w, 'Aufklärung', 'Startvorbereitungen beim Gegner erkannt. Bomber vom Küstenflugplatz gestartet.', 'warn'); raid('tb'); });
            later(S, T.salvoAt, () => {
               radio(w, 'Luftlage', 'Flugkörperalarm. Große Salve aus Ost, Ziel Träger. Alle Einheiten Abwehr frei.', 'warn');
               const at = () => { const F = live(w, S.fordId); return F ? { x: F.pos.x, y: F.pos.y } : null; };
               ripple(S, S.pjId, T.granit, at);
               for (const id of S.foes) { const s = live(w, id); if (s && s.cfg.name !== pj.cfg.name && s.cfg.weapons.ssm.length) ripple(S, id, s.type === 'CO' ? 1 : T.oniks, at); }
               S.phase = 1; S.salvoT = w.time;
            });
            // the battle cruiser does not wait for the clock: reloaded, it fires a second salvo at the carrier
            if (T.again) {
               later(S, T.again - 35, () => { if (live(w, S.pjId) && S.phase === 2) radio(w, 'Aufklärung', 'Der Schlachtkreuzer hat nachgeladen – eine zweite Salve auf den Träger steht bevor. Schalten Sie ihn vorher aus!', 'warn'); });
               later(S, T.again, () => {
                  if (!live(w, S.pjId) || S.phase !== 2) return;
                  radio(w, 'Luftlage', 'Flugkörperalarm. Zweite Salve des Schlachtkreuzers, Ziel Träger.', 'warn');
                  const at = () => { const F = live(w, S.fordId); return F ? { x: F.pos.x, y: F.pos.y } : null; };
                  ripple(S, S.pjId, T.granit2, at, true);
                  for (const id of S.foes) { const s = live(w, id); if (s && id !== S.pjId && s.type !== 'CO' && T.oniks2 && s.cfg.weapons.ssm.length) ripple(S, id, T.oniks2, at, true); }
               });
            }
            if (T.raids > 1) later(S, T.salvoAt + 110, () => raid('db'));
            if (T.raids > 2) later(S, T.salvoAt + 230, () => raid('tb'));
         },
         update(w, dt, S) {
            const busy = runRipples(w, S), T = tune(w, 'barents');
            if (S.phase === 1 && !busy && w.time - S.salvoT > 12 && !w.missiles.some(m => m.alive && m.kind === 'ssm' && m.side === 'enemy')) {
               S.phase = 2;
               setObj(w, 'salvo', 'done');
               objective(w, 'strike', 'Gegenschlag: Schalten Sie den Schlachtkreuzer Pjotr Weliki aus, bevor sich sein Verband absetzt' + lim(w));
               radio(w, 'Flottenkommando', 'Salve überstanden. Feuerfreigabe erteilt – der Verband feuert mit Ihnen, sobald Sie den Gegenschlag eröffnen.');
               // the enemy group closes to missile range of the carrier and fights there
               const F0 = live(w, S.fordId), pj0 = w.shipById(S.pjId);
               for (const id of S.foes) {
                  const s = live(w, id);
                  if (!s) continue;
                  release(s, S.fordId);
                  if (F0 && pj0) s.ai.route = [P(F0.pos.x + T.close + (s.pos.x - pj0.pos.x), F0.pos.y + (s.pos.y - pj0.pos.y))];
               }
            }
            coordinate(w, S, { hold: S.phase < 2, deck: w.time >= T.salvoAt - 40 && S.phase < 2 ? false : true });
            clock(w, S, 'Aufklärung', (t) => `Der gegnerische Verband bereitet das Absetzen vor – noch ${t} für den Gegenschlag auf den Schlachtkreuzer.`);
            const F = w.shipById(S.fordId);
            if (F && F.alive && F.hp < F.maxHP * 0.6) setObj(w, 'deck', 'failed');
         },
         onSink(w, ship, killer, S) {
            if (ship.id === S.fordId) { w.end(false, 'Die Gerald R. Ford ist gesunken.'); return; }
            if (ship.side === 'player') setObj(w, 'screen', 'failed');
            if (ship.id === S.pjId) {
               if (S.phase < 2) setObj(w, 'salvo', 'done');
               setObj(w, 'strike', 'done'); setObj(w, 'screen', 'done'); setObj(w, 'deck', 'done');
               w.end(true, 'Der Schlachtkreuzer ist ausgeschaltet, der Träger ist einsatzbereit.');
            }
         },
         timeout(w) { w.end(false, 'Der gegnerische Verband hat sich abgesetzt – der Gegenschlag kam zu spät.'); },
      },

      // --------------------------------------------------------------------- 7. Südchinesisches Meer
      {
         id: 'reefs', group: 'ops', name: 'Südchinesisches Meer – Riffe', subtitle: 'Operation 7 · Radar blenden, Batterien ausschalten',
         briefing: 'Auf drei ausgebauten Riffen stehen eine Radarstation, zwei Küstenbatterien und zwei Flugabwehrstellungen. ' +
            'Fregatten und Flugkörperschnellboote sichern die Riffe. Solange das Radar sendet, fängt die Flugabwehr Ihre ' +
            'Marschflugkörper ab und die Batterien sehen weit. Blenden Sie zuerst das Radar, dann schalten Sie beide ' +
            'Batterien mit Marschflugkörpern aus. Rechnen Sie danach mit einem Entsatzverband. Die Riffe sind reine Militäranlagen.',
         debrief: 'Radar und Küstenbatterien sind ausgefallen, der Entsatzverband ist abgedreht. Die Seewege an den Riffen sind wieder frei befahrbar.',
         env: { time: 'day', weather: 'clear' }, type: 'ops', playableShips: ['Burke', 'Ticonderoga'],
         recommendedShip: 'Burke', arena: 20000, timeLimit: 600, stars: 2,
         setup(w, shipKey) {
            const S = w._script; S.shipKey = shipKey; const T = tune(w, 'reefs');
            islands(w, [
               { c: P(6000, -7500), r: 1200, height: 40, seed: 31, lobes: 5, rough: 0.3, name: 'Nordriff' },
               { c: P(9500, 0), r: 1500, height: 50, seed: 37, lobes: 6, rough: 0.3, name: 'Mittelriff' },
               { c: P(6000, 7500), r: 1200, height: 40, seed: 43, lobes: 5, rough: 0.3, name: 'Südriff' },
            ]);
            const g = fleet(w, shipKey, [['Burke', 0, 0], ['Ticonderoga', -1800, 2200], ['Burke', -1800, -2200], ['Daring', 1500, 2600]],
               P(-16500, 0), 0, { swap: 1, dmg: T.ally, subAt: P(-15000, -3500) });
            follow(g, w.player);
            S.own = ids(g);
            const sam = { type: 'hq16', n: T.samN, ch: T.samCh };
            S.radarId = addSite(w, 'radar', 'enemy', P(8500, 0), { name: 'Radarstation Mittelriff' }).id;
            S.bat = [addSite(w, 'battery', 'enemy', P(5200, -7500), { name: 'Batterie Nordriff', radar: null, delay: 25 }).id,
               addSite(w, 'battery', 'enemy', P(5200, 7500), { name: 'Batterie Südriff', radar: null, delay: 25 }).id];
            S.sam = [addSite(w, 'sam', 'enemy', P(6000, -6500), { name: 'Flugabwehr Nordriff', sam }).id,
               addSite(w, 'sam', 'enemy', P(6000, 6500), { name: 'Flugabwehr Südriff', sam }).id];
            S.frig = [];
            for (let i = 0; i < T.frig; i++) {
               const y = i ? 4500 : -4500;
               S.frig.push(add(w, 'Typ054A', 'enemy', P(4000, y), Math.PI / 2, { telegraph: 1, ai: { patrol: [P(4000, y), P(4000, -y * 0.2)] } }).id);
            }
            S.boats = [];
            for (let i = 0; i < T.boats; i++) {
               const a = (i % 2 ? 1 : -1), k = Math.floor(i / 2);
               S.boats.push(add(w, 'Typ022', 'enemy', P(12500 + k * 900, a * (3000 + k * 1200)), Math.PI, { telegraph: 0, ai: { anchored: true } }).id);
            }
            objective(w, 'radar', 'Blenden Sie das Radar: Radarstation Mittelriff zerstören');
            objective(w, 'bat', 'Schalten Sie die Küstenbatterien aus (0/2)' + lim(w));
            objective(w, 'sam', 'Zerstören Sie beide Flugabwehrstellungen (0/2)', { optional: true });
            objective(w, 'screen', 'Verlieren Sie kein eigenes Schiff', { optional: true });
            S.blind = false; S.out = false;
            S.boatsOut = () => {
               if (S.out) return;
               S.out = true;
               const own = S.own.map(id => live(w, id)).filter(Boolean);      // the boats spread over the group
               let n = 0;
               for (const id of S.boats) { const b = live(w, id); if (b) { release(b, own.length ? own[n % own.length].id : null); b.setTelegraph(4); n++; } }
               if (n) radio(w, 'Lagezentrum', 'Schnellboote laufen hinter dem Mittelriff aus. Rechnen Sie mit Flugkörpern aus Ost.', 'warn');
            };
            later(S, 5, () => radio(w, 'Lagezentrum', 'Die Riffe liegen 22 km voraus. Erst das Radar – solange es sendet, kommt kaum ein Marschflugkörper durch.'));
            holdLine(w, S, 14, 'Verbandsführer', 'Der Verband wartet auf Ihre Feuereröffnung: Die Geleitschiffe schießen erst, wenn das Flaggschiff feuert, und stellen das Feuer zwei Minuten nach Ihrem letzten Schuss wieder ein.');
            later(S, T.boatsAt, () => S.boatsOut());
         },
         update(w, dt, S) {
            coordinate(w, S, {});
            clock(w, S, 'Flottenkommando', (t) => S.relief ? `Noch ${t}: Der Entsatzverband muss abgewehrt sein, sonst hält er die Riffe.` : `Noch ${t}: Radar und Batterien müssen fallen, sonst bleiben die Seewege gesperrt.`);
         },
         onSiteDestroyed(w, site, by, S) {
            const dead = (list) => list.filter(id => !w.sites.find(s => s.id === id).alive).length;
            if (site.id === S.radarId) {
               S.blind = true;
               setObj(w, 'radar', 'done');
               for (const s of w.sites) if (s.kind === 'sam' && s.side === 'enemy') for (const x of s.cfg.weapons.sam) x.ch = Math.min(x.ch, tune(w, 'reefs').blindCh);
               radio(w, 'Lagezentrum', 'Radar ist aus. Die Flugabwehr feuert nur noch mit eigenem Feuerleitradar – jetzt die Batterien.');
               S.boatsOut();
            }
            objText(w, 'bat', `Schalten Sie die Küstenbatterien aus (${dead(S.bat)}/2)` + lim(w));
            objText(w, 'sam', `Zerstören Sie beide Flugabwehrstellungen (${dead(S.sam)}/2)`);
            if (dead(S.sam) >= 2) setObj(w, 'sam', 'done');
            if (dead(S.bat) >= 2) {
               setObj(w, 'bat', 'done');
               if (!S.blind && site.kind === 'battery') radio(w, 'Lagezentrum', 'Beide Batterien sind aus. Es fehlt noch die Radarstation.');
            }
            // radar and batteries are out: a relief group comes in from the east
            if (S.blind && dead(S.bat) >= 2 && !S.relief) {
               const T = tune(w, 'reefs'), own = S.own.map(id => live(w, id)).filter(Boolean);
               // co-op: a half-strength frigate joins the relief group per further human captain (two at most:
               // measured with three, four captains ran out of time)
               S.relief = T.relief.concat(Array(Math.min(2, extraCaptains(w))).fill('Typ054A')).map((cls, i) => add(w, cls, 'enemy', P(17500, (i ? 1 : -1) * 2500 * i - 1500), Math.PI,
                  { minDist: 14000, telegraph: 4, hpMult: (i < T.relief.length ? T.reliefHp : 0.5) * w.difficulty.botHP, ai: { huntId: own.length ? own[(i + 1) % own.length].id : null, press: true } }).id);
               objective(w, 'relief', 'Wehren Sie den Entsatzverband ab (0/' + S.relief.length + ')' + lim(w));
               radio(w, 'Lagezentrum', 'Radar und Batterien sind aus. Ein Entsatzverband läuft von Osten an – wehren Sie ihn ab, dann sind die Seewege frei.', 'warn');
            }
         },
         onSink(w, ship, killer, S) {
            if (ship.side === 'player') { setObj(w, 'screen', 'failed'); return; }
            if (!S.relief || !S.relief.includes(ship.id)) return;
            const n = S.relief.filter(id => !live(w, id)).length;
            objText(w, 'relief', 'Wehren Sie den Entsatzverband ab (' + n + '/' + S.relief.length + ')' + lim(w));
            if (n < S.relief.length) return;
            setObj(w, 'relief', 'done');
            if (!ownLost(w)) setObj(w, 'screen', 'done');
            w.end(true, 'Radar und Küstenbatterien sind ausgeschaltet, der Entsatzverband ist abgewehrt.');
         },
         timeout(w, S) { w.end(false, S.relief ? 'Die Zeit ist abgelaufen – der Entsatzverband hält die Riffe.' : 'Die Zeit ist abgelaufen – die Batterien beherrschen weiter die Seewege.'); },
      },

      // --------------------------------------------------------------------- 8. Taiwanstraße
      {
         id: 'strait', group: 'ops', name: 'Taiwanstraße', subtitle: 'Operation 8 · Blockadebrecher bei Nacht',
         briefing: 'Drei Versorgungsschiffe mit Lebensmitteln, Treibstoff und Medikamenten sollen durch die Straße nach Norden. ' +
            'Zerstörer und Fregatten, Schnellbootrudel, ein U-Boot und Küstenflieger versuchen den Konvoi zu stoppen. ' +
            'Die Frachter laufen nur unter Ihrem Schutz: Bleiben Sie beim Konvoi, sonst stoppt er. Mindestens zwei Schiffe ' +
            'müssen den Zielraum erreichen. Schützen Sie die zivilen Besatzungen.',
         debrief: 'Der Konvoi hat den Zielraum erreicht, die Versorgung ist für die nächsten Wochen gesichert.',
         env: { time: 'night', weather: 'overcast', front: { at: 200, dur: 80, to: 'rain' } }, type: 'ops',
         playableShips: ['Sachsen', 'Burke', 'Daring', 'Ticonderoga'], recommendedShip: 'Sachsen', arena: 20000, timeLimit: 630, stars: 2,
         setup(w, shipKey) {
            const S = w._script; S.shipKey = shipKey; const T = tune(w, 'strait');
            islands(w, [
               { c: P(19500, 4000), r: 2600, height: 260, seed: 51, lobes: 6, elong: 2.6, rot: Math.PI / 2, rough: 0.5, name: 'Ostküste' },
               { c: P(-10500, 3000), r: 900, height: 120, seed: 57, lobes: 4, rough: 0.5 },
               { c: P(-8500, -8000), r: 700, height: 100, seed: 59, lobes: 4, rough: 0.5 },
            ]);
            const route = [P(0, -6000), P(-1200, 1500), P(0, 9500)];
            const tr = { passive: true, convoy: true, route };
            const ships = [add(w, 'Container', 'player', P(0, -14000), Math.PI / 2, { name: 'MV Aurora', ai: { ...tr } }),
               add(w, 'LNG', 'player', P(-1000, -15300), Math.PI / 2, { name: 'MT Castor', ai: { ...tr } }),
               add(w, 'Container', 'player', P(1000, -15300), Math.PI / 2, { name: 'MV Meridian', ai: { ...tr } })];
            S.conv = ids(ships); S.arrived = 0; S.lost = 0;
            const g = fleet(w, shipKey, [['Sachsen', 2600, 0], ['Daring', 0, 2600], ['Burke', 0, -2600], ['Burke', -2800, 0]],
               P(0, -14600), Math.PI / 2, { swap: 0, dmg: T.ally });
            follow(g, ships[0]);
            S.own = ids(g);
            S.goal = zone(w, 0, 10000, 2600, 'Zielraum', 'goal');
            const field = addSite(w, 'airfield', 'enemy', P(17000, 4000), { name: 'Küstenflugplatz', interval: T.raid, delay: 60 });
            addSite(w, 'radar', 'enemy', P(17000, 1500), { name: 'Küstenradar' });
            S.fieldId = field.id;
            if (T.sub) S.subId = add(w, 'Yuan', 'enemy', P(-2500, 2500), -Math.PI / 2, { depth: 1, telegraph: 1, ai: { huntId: ships[0].id } }).id;
            objective(w, 'conv', 'Bringen Sie mindestens zwei Versorgungsschiffe in den Zielraum (0/2)' + lim(w));
            objective(w, 'all', 'Bringen Sie alle drei Schiffe durch', { optional: true });
            if (T.sub) objective(w, 'sub', 'Versenken Sie das U-Boot auf der Route', { optional: true });
            const wave = (list, from, text) => {
               const tgt = S.conv.map(id => live(w, id)).find(Boolean);
               if (!tgt) return;
               list.forEach((cls, i) => add(w, cls, 'enemy', P(from.x + (i % 2) * 900, from.y + i * 800), 0, { minDist: 12500, ai: { huntId: tgt.id, press: true } }));
               radio(w, 'Luftlage', text, 'warn');
            };
            later(S, 5, () => radio(w, 'Konvoiführer', 'Konvoi ist bereit. Wir halten Kurs Nord und bleiben dicht bei Ihnen.'));
            later(S, 30, () => wave(Array(T.fac1).fill('Typ022'), P(15000, -7000), 'Schnellbootrudel läuft von Osten an.'));
            later(S, T.w2, () => wave(['Typ054A', ...(T.dd ? ['Typ052D'] : [])], P(13000, 12000), 'Überwassereinheiten aus Nordost, Kurs auf den Konvoi.'));
            later(S, T.w3, () => wave(Array(T.fac2).fill('Typ022'), P(-15000, 9000), 'Zweites Schnellbootrudel aus Nordwest.'));
            S.holdMsg = 0;
         },
         update(w, dt, S) {
            const left = S.conv.map(id => live(w, id)).filter(Boolean);
            clock(w, S, 'Konvoiführer', (t) => `Noch ${t}, dann schließt sich die Blockade vor dem Zielraum. Bleiben Sie dicht bei uns, damit wir Fahrt halten.`);
            // the freighters only run while a human captain is close to the leading ship
            const lead = left[0];
            const near = !lead || w.ships.some(s => s.alive && s.side === 'player' && human(s) && dist(s.pos, lead.pos) < (S.held ? 5000 : 7000));
            if (near === !!S.held) {
               S.held = !near;
               for (const f of left) f.ai.anchored = S.held;
               if (S.held && w.time > S.holdMsg) { S.holdMsg = w.time + 45; radio(w, 'Konvoiführer', 'Wir stoppen und warten auf Geleit. Ohne Schutz laufen wir nicht weiter.', 'warn'); }
            }
            for (const f of left) {
               f.ai.anchored = !!S.held;
               if (!inZone(f, S.goal)) continue;
               w.removeShip(f, 'arrived');
               S.arrived++;
               objText(w, 'conv', `Bringen Sie mindestens zwei Versorgungsschiffe in den Zielraum (${Math.min(2, S.arrived)}/2)` + lim(w));
               radio(w, f.name, 'Zielraum erreicht. Danke für das Geleit.');
            }
            if (S.arrived + S.lost >= 3 || (S.arrived >= 2 && S.lost >= 1)) {
               if (S.arrived >= 3) setObj(w, 'all', 'done');
               setObj(w, 'conv', 'done');
               w.end(true, S.arrived >= 3 ? 'Alle drei Versorgungsschiffe haben den Zielraum erreicht.' : 'Zwei Versorgungsschiffe haben den Zielraum erreicht.');
            }
         },
         onSink(w, ship, killer, S) {
            if (ship.id === S.subId) { setObj(w, 'sub', 'done'); return; }
            if (!S.conv.includes(ship.id)) return;
            S.lost++;
            setObj(w, 'all', 'failed');
            if (S.lost >= 2) w.end(false, 'Zwei Versorgungsschiffe sind verloren – der Konvoi ist gescheitert.');
            else radio(w, 'Konvoiführer', ship.name + ' ist verloren. Die Besatzung ist in den Booten – wir laufen weiter.', 'warn');
         },
         timeout(w) { w.end(false, 'Die Zeit ist abgelaufen – der Konvoi hat den Zielraum nicht erreicht.'); },
      },

      // --------------------------------------------------------------------- 9. Philippinensee
      {
         id: 'philsea', group: 'ops', name: 'Philippinensee', subtitle: 'Operation 9 · Träger gegen Träger',
         briefing: 'Irgendwo östlich steht der Verband um den Träger Shandong – beide Seiten fahren ohne Radar. Wer zuerst ' +
            'sendet, wird zuerst gehört; wer zuerst gefunden wird, bekommt den ersten Schlag. Klären Sie mit Jägern und ' +
            'Bordhubschraubern auf, halten Sie das eigene Radar aus, bis Sie den Gegner haben, und setzen Sie dann den ' +
            'Flugbetrieb der Shandong außer Gefecht. Die Gerald R. Ford darf nicht verloren gehen.',
         debrief: 'Das Flugdeck der Shandong ist ausgefallen, der gegnerische Verband läuft ab. Die Ford bleibt einsatzbereit.',
         env: { time: 'day', weather: 'clear' }, type: 'ops', playableShips: ['Ford', 'Burke', 'Ticonderoga', 'Daring'],
         recommendedShip: 'Ford', arena: 26000, timeLimit: 720, stars: 3,
         setup(w, shipKey) {
            const S = w._script; S.shipKey = shipKey; const T = tune(w, 'philsea');
            islands(w, [
               { c: P(-2000, 3000), r: 800, height: 90, seed: 61, lobes: 4, rough: 0.4 },
               { c: P(1500, -9000), r: 700, height: 80, seed: 67, lobes: 4, rough: 0.4 },
            ]);
            const g = fleet(w, shipKey, [['Ford', 0, 0], ['Ticonderoga', 2600, 0], ['Burke', 600, -2400], ['Burke', 600, 2400], ['Daring', -2200, 900]],
               P(-15000, 0), 0, { swap: 4, dmg: T.ally });
            const ford = g[0];
            follow(g, ford);
            S.fordId = ford.id; S.own = ids(g);
            const ey = [-13000, -9000, -4500, 4500, 9000, 13000][Math.floor(hash(w, 3) * 6)], ex = 6000 + Math.floor(hash(w, 5) * 4000);
            const hold = (dx, dy) => ({ passive: true, patrol: [P(ex + dx, ey + dy - 1800), P(ex + dx, ey + dy + 1800)] });
            const sd = add(w, 'Shandong', 'enemy', P(ex, ey), Math.PI / 2, { telegraph: 1, ai: { patrol: hold(0, 0).patrol } });
            const foes = [sd, add(w, 'Typ055', 'enemy', P(ex - 2600, ey), Math.PI / 2, { telegraph: 1, ai: hold(-2600, 0) })];
            if (T.dd) foes.push(add(w, 'Typ052D', 'enemy', P(ex - 600, ey - 2400), Math.PI / 2, { telegraph: 1, ai: hold(-600, -2400) }));
            for (let i = 0; i < T.frig; i++) foes.push(add(w, 'Typ054A', 'enemy', P(ex - 600 + i * 2400, ey + 2400), Math.PI / 2, { telegraph: 1, ai: hold(-600 + i * 2400, 2400) }));
            S.sdId = sd.id; S.foes = ids(foes); S.area = { x: ex, y: ey };
            for (const s of w.ships) if (s.radarOn) setRadar(w, s, false);         // both groups start under emission control
            objective(w, 'find', 'Finden Sie den Verband der Shandong');
            objective(w, 'first', 'Klären Sie den Gegner auf, bevor er Sie findet', { optional: true });
            objective(w, 'deck', 'Halten Sie die Ford über 70 % Rumpfstärke', { optional: true });
            S.hot = false; S.found = false; S.hotAt = T.auto;
            later(S, 5, () => radio(w, 'Flottenkommando', 'Funk- und Radarstille im Verband. Jäger und Hubschrauber klären nach Osten auf.'));
            holdLine(w, S, 14, 'Verbandsführer', 'Der Verband hält Feuerdisziplin: Die Geleitschiffe schießen erst, wenn das Flaggschiff den Angriff eröffnet – ein früher Schuss würde unsere Position verraten.');
            // the escorts of the Shandong do not let the clock decide: late in the operation they fire what they
            // have reloaded at the Ford (salvo missiles per ship still afloat)
            later(S, T.salvoAt - 35, () => { if (S.foes.some(id => id !== S.sdId && live(w, id))) radio(w, 'Aufklärung', 'Die Geleitschiffe der Shandong drehen auf uns ein – eine Flugkörpersalve auf die Ford steht bevor.', 'warn'); });
            const salvo = () => {
               if (w.phase !== 'playing') return;
               const at = () => { const F = live(w, S.fordId); return F ? { x: F.pos.x, y: F.pos.y } : null; };
               let n = 0;
               for (const id of S.foes) { const e = live(w, id); if (e && id !== S.sdId && e.cfg.weapons.ssm.length) { ripple(S, id, T.salvo, at, true); n++; } }
               if (n) radio(w, 'Luftlage', 'Flugkörperalarm. Salve vom Verband der Shandong, Ziel Träger.', 'warn');
               if (n && T.again) later(S, w.time + T.again, salvo);
            };
            later(S, T.salvoAt, salvo);
            later(S, 70, () => {
               if (S.found) return;
               const n = S.area.y < -6000 ? 'Südost' : S.area.y > 6000 ? 'Nordost' : 'Ost';
               S.hint = zone(w, S.area.x - 1500 + (hash(w, 9) - 0.5) * 3000, S.area.y + (hash(w, 11) - 0.5) * 3000, 6000, 'Peilung', 'danger');
               radio(w, 'Seefernaufklärer', `Kurze Funkpeilung im Sektor ${n}. Der Verband steht vermutlich im markierten Gebiet.`);
            });
         },
         update(w, dt, S) {
            const T = tune(w, 'philsea'), sd = w.shipById(S.sdId);
            if (!sd) return;
            runRipples(w, S);
            coordinate(w, S, {});
            clock(w, S, 'Aufklärung', (t) => `Noch ${t}, dann ist der Verband der Shandong außer Reichweite.`);
            if (!S.found && S.foes.some(id => { const s = live(w, id); return s && s.detected; })) {
               S.found = true;
               setObj(w, 'find', 'done');
               objective(w, 'strike', 'Setzen Sie den Flugbetrieb der Shandong außer Gefecht, bevor ihr Verband abläuft' + lim(w));
               for (const id of S.own) { const s = live(w, id); if (s && !human(s) && s.ai && s.id !== S.fordId) { delete s.ai.escortId; s.ai.huntId = S.sdId; s.ai.press = true; } }   // the escorts close in on the carrier
               if (!S.hot) {
                  setObj(w, 'first', 'done');
                  S.hotAt = Math.max(w.time + T.surprise, Math.min(S.hotAt, w.time + T.surprise));
                  radio(w, 'Luftlage', 'Kontakt: Verband Shandong aufgeklärt. Der Gegner hat uns noch nicht – Angriff frei.');
               } else radio(w, 'Luftlage', 'Kontakt: Verband Shandong aufgeklärt. Angriff frei.');
            }
            if (!S.hot) {
               const seen = w.time > 20 && w.ships.some(s => s.alive && s.side === 'player' && s.depth === 0 && (s.detected || s.esmSeen));
               if (seen || w.time >= S.hotAt) {
                  S.hot = true;
                  if (!S.found) setObj(w, 'first', 'failed');
                  for (const id of S.foes) { const s = live(w, id); if (!s) continue; setRadar(w, s, true); if (s !== sd) release(s, null); }
                  radio(w, 'Luftlage', seen && !S.found ? 'Wir sind aufgeklärt. Der Gegner startet seine Maschinen – Luftangriff zu erwarten.'
                     : 'Der Gegner geht auf Sendung und startet seine Maschinen. Luftangriff zu erwarten.', 'warn');
               } else if (sd.alive && sd.air) sd.air.deckT = Math.max(sd.air.deckT, 2);      // deck not yet ready
            }
            if (sd.alive && sd.hp <= sd.maxHP * T.out) {
               if (!S.found) setObj(w, 'find', 'done');
               setObj(w, 'strike', 'done');
               const F = live(w, S.fordId);
               if (F && F.hp >= F.maxHP * 0.7) setObj(w, 'deck', 'done');
               w.end(true, 'Der Flugbetrieb der Shandong ist ausgefallen – der gegnerische Verband läuft ab.');
            }
         },
         onSink(w, ship, killer, S) {
            if (ship.id === S.fordId) w.end(false, 'Die Gerald R. Ford ist gesunken.');
            else if (ship.id === S.sdId) {
               const F = live(w, S.fordId);
               if (F && F.hp >= F.maxHP * 0.7) setObj(w, 'deck', 'done');
               w.end(true, 'Die Shandong ist ausgeschaltet.');
            }
         },
         timeout(w) { w.end(false, 'Die Zeit ist abgelaufen – der Träger Shandong ist weiter einsatzbereit.'); },
      },

      // --------------------------------------------------------------------- 10. Finale – Countdown
      {
         id: 'countdown', group: 'ops', name: 'Finale – Countdown', subtitle: 'Operation 10 · Die Startrampe auf der Insel',
         briefing: 'Ein abtrünniger Kommandeur hat sich mit einer mobilen Startrampe auf einer Felseninsel verschanzt und droht ' +
            'mit dem Start. Korvetten, eine Fregatte und Flugabwehrstellungen decken die Insel. Die Rampe steht in einem ' +
            'Felsstollen: Schalten Sie Radar und Flugabwehr aus, dann klärt eine Drohne das Ziel auf und Ihre ' +
            'Marschflugkörper können die Rampe zerstören, bevor der Countdown abläuft. Rechnen Sie damit, dass die Rampe ' +
            'vorher auf Ihren Verband feuert: Die Gefahrenzone erscheint auf der Karte – laufen Sie heraus. Ein U-Boot ' +
            'kann stattdessen einen Kommandotrupp am Einsatzpunkt absetzen. Die Insel ist unbewohnt.',
         debrief: 'Die Startrampe ist zerstört, der Start wurde verhindert. Der Kommandeur hat sich ergeben.',
         env: { time: 'dusk', weather: 'overcast' }, type: 'ops', playableShips: ['Ticonderoga', 'Virginia', 'U212'],
         recommendedShip: 'Ticonderoga', arena: 22000, timeLimit: 720, stars: 3,
         setup(w, shipKey) {
            const S = w._script; S.shipKey = shipKey; const T = tune(w, 'countdown');
            S.surface = SHIPS[shipKey].hull.type !== 'SS';
            w.timeLeft = S.surface ? T.time : T.subTime;
            const C = P(9000, 0), R = 2400;
            islands(w, [{ c: C, r: R, height: 320, seed: 71, lobes: 6, rough: 0.55, name: 'Felseninsel', peaks: [{ x: 300, y: 200, h: 420, r: 900 }] }]);
            const g = fleet(w, shipKey, [['Ticonderoga', 0, 0], ['Burke', -1600, -2400], ['Burke', -1600, 2400], ['Daring', 1600, 2600]],
               P(-14000, 1500), 0, { swap: 0, dmg: T.ally, subAt: P(-3000, -14500), subHdg: Math.PI / 3 });
            follow(g, w.player);
            S.own = ids(g);
            // the surface flagship sails with the same load of cruise missiles whatever the class
            const cw = w.player.cfg.weapons.cruise;
            if (cw && !w.player.sub) w.player.mag[cw.type] = T.tlam;
            const at = (a) => P(C.x + Math.cos(a) * R * 0.6, C.y + Math.sin(a) * R * 0.6);
            const sam = { type: 'hq16', n: T.samN, ch: T.samCh };
            // the launcher stands in a rock tunnel: no target data until a drone can fly over the island
            const rampe = addSite(w, 'launcher', 'enemy', at(-1.75), { name: 'Startrampe', hp: T.hp, hidden: true });
            S.launcherId = rampe.id; S.lhp = rampe.hp;
            rampe.hp = rampe.maxHp = rampe.maxHP = 1e9;      // out of reach in the tunnel until the drone has it
            S.sam = [addSite(w, 'sam', 'enemy', at(Math.PI), { name: 'Flugabwehr West', sam }).id, addSite(w, 'sam', 'enemy', at(-1.2), { name: 'Flugabwehr Süd', sam }).id];
            S.radarId = addSite(w, 'radar', 'enemy', at(2.5), { name: 'Radarstation' }).id;
            addSite(w, 'battery', 'enemy', at(1.3), { name: 'Küstenbatterie', delay: 30 });
            // surface run: the bunker that feeds the launcher its target data, unknown until the drone is up
            if (S.surface) { S.bunkerId = addSite(w, 'bunker', 'enemy', at(0.4), { name: 'Führungsbunker', hp: T.bunkHp, hidden: true }).id; S.strikeAt = T.strikeAt; }
            const dir = Math.atan2(rampe.y - C.y, rampe.x - C.x);
            addTaskPoint(w, { x: rampe.x + Math.cos(dir) * 120, y: rampe.y + Math.sin(dir) * 120, kind: 'sabotage', label: 'Startrampe', workTime: T.work, siteId: rampe.id });
            const scr = [add(w, 'Gorschkow', 'enemy', P(3800, 1500), Math.PI / 2, { telegraph: 1, ai: { patrol: [P(3800, 4000), P(3800, -1500)] } })];
            for (let i = 0; i < T.corv; i++) scr.push(add(w, 'BuyanM', 'enemy', P(5200, i ? 4500 : 500), Math.PI / 2, { telegraph: 1, ai: { patrol: [P(5200, i ? 4500 : 500), P(5200, i ? 1500 : -2500)] } }));
            S.boats = [];
            const nBoats = SHIPS[shipKey].hull.type === 'SS' ? T.subBoats : T.boats;
            for (let i = 0; i < nBoats; i++) {
               const a0 = (hash(w, 20) + i / nBoats) * 2 * Math.PI, ring = [];
               for (let k = 0; k < 6; k++) ring.push(P(C.x + Math.cos(a0 + k * Math.PI / 3) * (R + 3400), C.y + Math.sin(a0 + k * Math.PI / 3) * (R + 3400)));
               S.boats.push(add(w, 'Typ022', 'enemy', ring[0], a0 + Math.PI / 2, { telegraph: 2, ai: { passive: true, patrol: ring } }).id);
            }
            if (T.sub && SHIPS[shipKey].hull.type !== 'SS') add(w, 'Kilo', 'enemy', P(6500, -6500), 0, { depth: 1, telegraph: 1, ai: { patrol: [P(5000, -6000), P(9500, -6500)] } });      // guards the approach to the launcher
            // a submarine meets a sonar screen on its way in: frigates with towed arrays patrol across the approach
            if (w.player.sub) {
               const lines = [[P(6800, -3800), P(4200, -7200)], [P(9600, -9000), P(6800, -7200)], [P(2200, -3000), P(3800, -5600)]];
               for (let i = 0; i < T.asw; i++) scr.push(add(w, 'Typ054A', 'enemy', lines[i][0], Math.PI, { telegraph: 1, ai: { patrol: [lines[i][0], lines[i][1]] } }));
            }
            S.screen = ids(scr);
            S.test = zone(w, -1500, 17500, 3600, 'Sperrgebiet (geräumt)', 'danger');
            objective(w, 'ad', 'Schalten Sie Radar und Flugabwehr der Insel aus (0/3)');
            objective(w, 'launcher', 'Zerstören Sie die Startrampe, bevor der Countdown abläuft');
            objective(w, 'screen', `Schalten Sie den Sicherungsverband aus (0/${scr.length})`, { optional: true });
            objective(w, 'early', 'Zerstören Sie die Rampe mit mehr als zwei Minuten Reserve', { optional: true });
            w._script.onBlast = (ww, b) => {
               if (b.id === S.warnId) radio(ww, 'Flottenkommando', 'Detonation im geräumten Sperrgebiet, weit draußen über See. Keine Schiffe, keine Personen im Gebiet. ' +
                  `Das war die Warnung – der nächste Start erfolgt in ${mmss(ww.timeLeft)}.`, 'warn');
               else if (b.id === S.finalId) ww.end(false, 'Der Countdown ist abgelaufen – die Rampe hat gestartet.');
               else if (b.id === S.strikeId) {
                  radio(ww, 'Luftlage', b.hit.ships ? 'Detonation im Verband! Schadensmeldungen laufen ein.' : 'Detonation achteraus – kein eigenes Schiff in der Gefahrenzone.', 'warn');
                  strikeOver(ww, S, 'Die Rampe ist zum Nachladen an den Stolleneingang gefahren');
               }
            };
            w._script.onTaskDone = (ww) => radio(ww, 'Kommandotrupp', 'Ladungen gezündet, Rampe zerstört. Wir kommen zurück zum Boot.');
            w._script.onTeamLost = (ww) => {
               if (ww.phase !== 'playing') return;
               const can = ww.ships.some(s => s.alive && s.side === 'player' && ((s.cfg.weapons.cruise && s.mag[s.cfg.weapons.cruise.type] > 0) || (s.sub && s.cfg.sub.seal && (s.teamsLeft ?? 1) > 0)));
               if (can) radio(ww, 'Flottenkommando', 'Der Kommandotrupp ist aufgeklärt worden und bricht ab. Die Rampe muss anders fallen.', 'warn');
               else ww.end(false, 'Der Kommandotrupp wurde entdeckt – die Rampe ist nicht mehr zu erreichen.');
            };
            later(S, 5, () => radio(w, 'Flottenkommando', `Der Countdown läuft: ${mmss(w.timeLeft)}. Erst Radar und Flugabwehr – dann kann die Drohne die Rampe im Stollen aufklären.` +
               (S.surface ? ' Rechnen Sie mit einem Gegenschlag der Rampe auf Ihren Verband.' : '')));
            if (S.surface) holdLine(w, S, 14, 'Verbandsführer', 'Die Geleitschiffe warten auf Ihre Freigabe: Sie eröffnen das Feuer erst, wenn das Flaggschiff schießt.');
            later(S, 22, () => radio(w, 'Luftlage', 'Start von der Insel erkannt. Flugbahn führt in das geräumte Sperrgebiet im Norden – kein Schiff, kein Land in der Nähe.', 'warn'));
            later(S, 34, () => { S.warnId = addBlast(w, { x: S.test.x, y: S.test.y, r: { destroyed: 700, heavy: 1700, shock: 3200 }, delay: 8, label: 'Detonation im Sperrgebiet' }).id; });
         },
         update(w, dt, S) {
            coordinate(w, S, {});
            if (S.reconAt && w.time >= S.reconAt) {
               S.reconAt = 0; S.shown = true;
               const L = w.sites.find(s => s.id === S.launcherId);
               if (L && L.alive) { L.hp = L.maxHp = L.maxHP = S.lhp; L.detected = L.targetable = true; radio(w, 'Lagezentrum', 'Die Drohne hat die Rampe im Stollen aufgeklärt. Zieldaten liegen vor – Marschflugkörper frei.'); }
            }
            // nothing left that could reach the launcher: no cruise missile on board or in the air, no team
            if (w.time > 30 && !S.spent) {
               const means = w.ships.some(s => s.alive && s.side === 'player' && ((s.cfg.weapons.cruise && s.mag[s.cfg.weapons.cruise.type] > 0) || (s.sub && s.cfg.sub.seal && ((s.teamsLeft ?? 1) > 0 || s.teamOut != null))))
                  || w.missiles.some(m => m.alive && m.kind === 'cruise' && m.side === 'player');
               if (!means) { S.spent = true; w.end(false, 'Keine Marschflugkörper mehr an Bord – die Rampe ist nicht mehr zu erreichen.'); return; }
            }
            if (S.surface) strike(w, S);
            if (!S.shown) { const L = w.sites.find(s => s.id === S.launcherId); if (L && L.alive) L.hp = L.maxHp; }   // safe in the tunnel
            // the launch at the end of the countdown: the detonation falls together with the timer
            if (!S.finalId && w.timeLeft <= 4) {
               S.finalId = addBlast(w, { x: S.test.x + 600, y: S.test.y - 400, r: { destroyed: 700, heavy: 1700, shock: 3200 }, delay: Math.max(0, w.timeLeft - 0.1), label: 'Start von der Insel' }).id;
               radio(w, 'Luftlage', 'Start von der Insel. Der Flugkörper ist in der Luft.', 'warn');
            }
         },
         onSiteDestroyed(w, site, by, S) {
            if (site.id === S.launcherId) {
               setObj(w, 'launcher', 'done');
               if (w.timeLeft > 120) setObj(w, 'early', 'done');
               w.end(true, 'Die Startrampe ist zerstört – der Start wurde verhindert.');
               return;
            }
            if (!S.out) {
               S.out = true;
               const own = S.own.map(id => live(w, id)).filter(Boolean);
               let k = 0;
               for (const id of S.boats) { const b = live(w, id); if (b) { release(b, own.length ? own[k % own.length].id : null); b.setTelegraph(4); k++; } }
               if (k) radio(w, 'Lagezentrum', 'Die Wachboote der Insel laufen aus. Rechnen Sie mit Flugkörpern.', 'warn');
            }
            const dead = (id) => !w.sites.find(s => s.id === id).alive;
            const n = S.sam.filter(dead).length, r = dead(S.radarId) ? 1 : 0;
            objText(w, 'ad', `Schalten Sie Radar und Flugabwehr der Insel aus (${n + r}/3)`);
            if (site.id === S.radarId) {
               for (const x of w.sites) if (x.kind === 'sam' && x.side === 'enemy') for (const y of x.cfg.weapons.sam) y.ch = Math.min(y.ch, 1);
               radio(w, 'Lagezentrum', 'Das Inselradar ist aus. Die Flugabwehr feuert nur noch mit eigenem Feuerleitradar.');
            }
            if (site.id === S.bunkerId) {
               // without the bunker the launcher has no target data: a missile in the air goes astray
               if (S.strikeId) {
                  w.blasts = w.blasts.filter(b => b.id !== S.strikeId);
                  radio(w, 'Luftlage', 'Führungsbunker zerstört – der Flugkörper hat seine Zieldaten verloren und stürzt weit vor dem Verband ins Meer.');
                  strikeOver(w, S, 'Ohne Führungsbunker muss die Rampe zum Zielen an den Stolleneingang');
               } else radio(w, 'Lagezentrum', 'Der Führungsbunker ist zerstört. Die Rampe kann Ihren Verband nicht mehr erfassen.');
               return;
            }
            if (n + r >= 3 && !S.adDone) {
               const T = tune(w, 'countdown');
               S.adDone = true;
               setObj(w, 'ad', 'done');
               if (!S.surface) {
                  S.reconAt = w.time + T.recon;
                  radio(w, 'Lagezentrum', 'Radar und Flugabwehr der Insel schweigen. Die Aufklärungsdrohne ist unterwegs – Zieldaten für die Rampe in etwa einer Minute.');
               } else if (S.struck && !S.strikeId) {
                  S.reconAt = w.time + T.drone2;
                  radio(w, 'Lagezentrum', 'Radar und Flugabwehr der Insel schweigen. Die Aufklärungsdrohne ist unterwegs zum Stolleneingang – Zieldaten für die Rampe in etwa einer Minute.');
               } else {
                  if (!S.struck) S.strikeAt = Math.min(S.strikeAt, w.time + T.drone);
                  radio(w, 'Lagezentrum', 'Radar und Flugabwehr der Insel schweigen. Die Aufklärungsdrohne ist unterwegs. Die Rampe steht noch tief im Stollen.');
               }
            }
         },
         onSink(w, ship, killer, S) {
            if (!S.screen.includes(ship.id)) return;
            const n = S.screen.filter(id => !live(w, id)).length;
            objText(w, 'screen', `Schalten Sie den Sicherungsverband aus (${n}/${S.screen.length})`);
            if (n >= S.screen.length) { setObj(w, 'screen', 'done'); radio(w, 'Lagezentrum', 'Der Sicherungsverband ist ausgeschaltet.'); }
         },
         timeout(w, S) { if (!S.finalId || w.blasts.every(b => b.id !== S.finalId)) w.end(false, 'Der Countdown ist abgelaufen – die Rampe hat gestartet.'); },
      },
   ];
   return defs;
}
