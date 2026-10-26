// gamev2/missions_special_c.js — the operation of the experimental railgun ship (fictional present-day scenario):
//    railgun    Unternehmen Donnerkeil: the Donar shells an island fortress from beyond the reach of its batteries
//               while hypersonic missiles from hidden ramps come in waves; a task force and a pack of fast attack
//               craft sortie from behind the island
// Each definition has the shape of missions.js DEFS; H = missionHelpers. Everything the mission keeps between
// ticks lives in world._script (S) as plain data and refers to ships by id.
// Convention of the mission files: merchant ships are protected, never targets (there are none here).
// Balance: RAIL_TUNE holds the knobs per difficulty (tests/v2.missions.railgun.test.mjs measures them with the
// bot captain of tests/v2.missions.railgun.captain.mjs).
import { addSite } from './sites.js';
import { launchSSM } from './missile.js';
import { obstacleRadiusAt } from './utils.js';

export const RAIL_TUNE = {
   railgun: {
      // gap: s between two waves of the ramps · per: missiles per living ramp and wave (+1 from wave `more`) ·
      // rampHp: hit points of a ramp (a railgun hit does about 2200) · dwell: s a located ramp stays before it
      // drives to its next firing position and is hidden again · tfAt: s until the task force sorties ·
      // fac: fast attack craft · facAt: s until they come · batN: missiles per coastal battery
      easy: { gap: 65, per: 1, more: 5, rampHp: 7000, dwell: 35, tfAt: 200, fac: 2, facAt: 320, batN: 6 },
      normal: { gap: 50, per: 1, more: 2, rampHp: 8000, dwell: 24, tfAt: 150, fac: 4, facAt: 260, batN: 8 },
      hard: { gap: 46, per: 1, more: 2, rampHp: 9000, dwell: 27, tfAt: 120, fac: 5, facAt: 220, batN: 10 },
   },
};
const tune = (w, id) => RAIL_TUNE[id][w.difficultyKey] || RAIL_TUNE[id].normal;

export function specialMissionsC(H) {
   const { P, add, objective, setObj, objText, later, radio, islands } = H;
   const alive = (w, id) => { const s = w.shipById(id); return !!(s && s.alive); };

   return [
      {
         id: 'railgun', group: 'ops', name: 'Unternehmen Donnerkeil', subtitle: 'Railgun-Erprobung · Inselfestung · Hyperschall-Sättigungsangriff',
         briefing: 'Die Inselfestung Skarnholm sperrt mit Küstenbatterien, Flugabwehr und versteckten Hyperschall-Startrampen die Durchfahrt. ' +
            'Das Versuchsschiff Donar soll sie ausschalten – aus 35 Kilometern, weit außerhalb der Reichweite der Batterien (30 km). ' +
            'Die Railgun trifft auf 42 Kilometer, ihre Geschosse kann keine Flugabwehr abfangen; Marschflugkörper dagegen schon. ' +
            'Die Startrampen sind getarnt: Erst wenn sie feuern, werden sie geortet. Rechnen Sie mit Sättigungsangriffen – und mit einem Verband, der hinter der Insel ausläuft.',
         debrief: 'Skarnholm schweigt. Die Erprobung hat gezeigt, was eine Railgun auf große Entfernung leistet – ' +
            'und dass auch das stärkste Schiff nur so gut ist wie die Abwehr gegen den Angriff, den es selbst nicht verhindern kann.',
         fleet: { own: 'Versuchsschiff Donar, 1 Fregatte', foe: 'Inselfestung (2 Batterien, 2 Flugabwehrstellungen, Radar, Flugplatz, 3 Startrampen), 1 Zerstörer, 2 Fregatten, Schnellboote' },
         env: { time: 'dusk', weather: 'overcast' }, type: 'ops', playableShips: ['Donar'], recommendedShip: 'Donar',
         arena: 26000, timeLimit: 16 * 60, stars: 3,
         setup(w, shipKey) {
            const S = w._script, T = tune(w, 'railgun');
            islands(w, [
               { c: P(15000, 0), r: 3800, height: 460, seed: 151, lobes: 6, elong: 2.2, rot: Math.PI / 2, rough: 0.6, name: 'Skarnholm' },
               { c: P(-4000, -13500), r: 900, height: 120, seed: 157, lobes: 4, rough: 0.5 },
               { c: P(1500, 14000), r: 700, height: 90, seed: 163, lobes: 3, rough: 0.5 },
            ]);
            const p = add(w, shipKey, 'player', P(-21000, 2500), 0, { isPlayer: true, telegraph: 2 });
            S.pid = p.id;
            S.ally = add(w, 'Sachsen', 'player', P(-22800, 4300), 0, { name: 'Hessen', ai: { escortId: p.id } }).id;
            const site = (kind, x, y, opts) => addSite(w, kind, 'enemy', P(x, y), opts);
            S.fort = [
               site('battery', 11000, -3600, { name: 'Küstenbatterie Nord', ssm: { type: 'vulkan', n: T.batN }, salvo: 2, interval: 26 }),
               site('battery', 11000, 3600, { name: 'Küstenbatterie Süd', ssm: { type: 'vulkan', n: T.batN }, salvo: 2, interval: 26 }),
               site('radar', 12000, -900, { name: 'Radarstation Skarnholm' }),
               site('airfield', 13500, 6000, { name: 'Flugplatz Skarnholm' }),
            ].map(s => s.id);
            S.sams = [
               site('sam', 12000, -2400, { name: 'Flugabwehr Nord', sam: { type: 'hq16', n: 24, ch: 2 } }),
               site('sam', 12000, 2200, { name: 'Flugabwehr Süd', sam: { type: 'hq16', n: 24, ch: 2 } }),
            ].map(s => s.id);
            S.bunker = site('bunker', 16500, -7000, { name: 'Kommandobunker' }).id;
            // mobile ramps: three firing positions each on the coast (angle around the island); after it has been
            // located a ramp drives on to the next one and is hidden again (onLocated)
            const isl = w.obstacles[0];
            S.spots = [[-2.05, -1.8, -1.6], [2.75, -2.95, 3.1], [1.45, 1.75, 2.05]].map(as => as.map(a => {
               const r = obstacleRadiusAt(isl, a) * 0.95;
               return { x: isl.c.x + Math.cos(a) * r, y: isl.c.y + Math.sin(a) * r };
            }));
            S.ramps = ['Startrampe Alpha', 'Startrampe Bravo', 'Startrampe Charlie'].map((name, i) =>
               site('launcher', S.spots[i][0].x, S.spots[i][0].y, { name, inland: true, hidden: true, hp: T.rampHp, ssm: { type: 'zirkon', n: 99 } }).id);
            S.spot = [0, 0, 0];
            S.tf = []; S.facs = []; S.queue = []; S.wave = 0; S.launched = 0; S.tick = 0; S.radarUp = true;
            objective(w, 'ramps', 'Schalten Sie die Startrampen aus (0/3)');
            objective(w, 'fort', 'Schalten Sie Batterien, Radar und Flugplatz aus (0/4)');
            objective(w, 'tf', 'Versenken Sie den auslaufenden Verband (0/3)');
            objective(w, 'ally', 'Die Fregatte Hessen bleibt einsatzfähig', { optional: true });
            objective(w, 'bunker', 'Zerstören Sie den Kommandobunker', { optional: true });
            w.score = { kind: 'count', player: 0, enemy: 0, target: 10 };
            radio(w, 'Erprobungsleitung', 'Donar, Sie haben Feuerfreigabe auf Skarnholm. Bleiben Sie außerhalb von 30 Kilometern – dort reichen die Batterien nicht hin.');
            later(S, 12, () => radio(w, 'Erprobungsleitung', 'Hinweis: Die Flugabwehr der Insel fängt Marschflugkörper ab. Railgun-Geschosse kann sie nicht bekämpfen.'));
            for (let k = 0; k < 14; k++) later(S, 45 + k * T.gap, () => this.wave(w, S, k));
            later(S, T.tfAt, () => this.sortie(w, S));
            later(S, T.facAt, () => this.facs(w, S));
         },
         wave(w, S, k) {
            const T = tune(w, 'railgun');
            const live = S.ramps.map(id => w.sites.find(s => s.id === id)).filter(L => L && L.alive);
            if (!live.length || w.phase !== 'playing') return;
            S.wave++;
            const n = T.per + (k >= T.more ? 1 : 0);
            radio(w, 'Operationszentrale', `Hyperschallstart auf Skarnholm, Welle ${S.wave}: ${n * live.length} Flugkörper. Abwehr klar!`, 'warn');
            live.forEach((L, j) => { for (let i = 0; i < n; i++) S.queue.push({ id: L.id, t: w.time + j * 2 + i * 1.2, tries: 0 }); });
         },
         sortie(w, S) {
            if (w.phase !== 'playing') return;
            const hunt = { huntId: S.pid, press: true };
            S.tf = [
               add(w, 'Typ052D', 'enemy', P(1500, -19500), 2.3, { name: 'Zerstörer Sturmvogel', ai: hunt }),
               add(w, 'Typ054A', 'enemy', P(3500, -18000), 2.3, { name: 'Fregatte Brandung', ai: hunt }),
               add(w, 'Typ054A', 'enemy', P(-500, -21000), 2.3, { name: 'Fregatte Gischt', ai: hunt }),
            ].map(s => s.id);
            radio(w, 'Operationszentrale', 'Ein Zerstörer und zwei Fregatten lösen sich aus dem Schatten der Nordklippe und nehmen Kurs auf Sie. Ihre Seezielflugkörper reichen 26 Kilometer.', 'warn');
         },
         facs(w, S) {
            if (w.phase !== 'playing') return;
            const T = tune(w, 'railgun');
            for (let i = 0; i < T.fac; i++)
               S.facs.push(add(w, 'Typ022', 'enemy', P(-2000 + i * 900, -19000 - (i % 2) * 700), Math.PI / 2, { name: 'Schnellboot ' + (i + 1), ai: { huntId: S.pid, press: true } }).id);
            radio(w, 'Operationszentrale', `${T.fac} Schnellboote aus der Nordbucht, schnell anlaufend. Sie tragen Seezielflugkörper.`, 'warn');
         },
         // a located ramp drives on to its next firing position: hidden again, it fires from there next wave
         relocate(w, S, L) {
            if (!L.alive || w.phase !== 'playing') return;
            const i = S.ramps.indexOf(L.id), q = S.spots[i][S.spot[i] = (S.spot[i] + 1) % S.spots[i].length];
            L.x = L.pos.x = q.x; L.y = L.pos.y = q.y;
            L.detected = L.targetable = false; L.locating = false;
            radio(w, 'Operationszentrale', L.name + ' hat die Stellung gewechselt – Kontakt verloren.');
         },
         update(w, dt, S) {
            // launch queue: one zirkon per entry, at the Donar (every third at the frigate); without the radar the
            // ramps fire at a point near the last known position
            for (let i = S.queue.length - 1; i >= 0; i--) {
               const q = S.queue[i];
               if (w.time < q.t) continue;
               const L = w.sites.find(s => s.id === q.id);
               const own = [S.pid, S.ally].map(id => w.shipById(id)).filter(s => s && s.alive);
               if (!L || !L.alive || !own.length || q.tries++ > 200) { S.queue.splice(i, 1); continue; }
               const Tg = own[S.launched % 3 === 2 && own.length > 1 ? 1 : 0];
               let m = null;
               if (S.radarUp) m = (Tg.targetable && launchSSM(w, L, { targetId: Tg.id }, 'zirkon')) || (q.tries > 3 ? launchSSM(w, L, { x: Tg.pos.x, y: Tg.pos.y }, 'zirkon') : null);
               else {
                  const a = (S.launched * 2.39996) % (2 * Math.PI), r = 900 + (S.launched % 4) * 350;
                  m = launchSSM(w, L, { x: Tg.pos.x + Math.cos(a) * r, y: Tg.pos.y + Math.sin(a) * r }, 'zirkon');
               }
               if (!m) continue;
               S.launched++;
               S.queue.splice(i, 1);
               if (!L.detected && !L.locating) {
                  L.locating = true;
                  later(S, w.time + 6, () => {
                     if (!L.alive) return;
                     L.detected = L.targetable = true;
                     radio(w, 'Operationszentrale', L.name + ' geortet. Feuerfreigabe – sie wird die Stellung wechseln!');
                     later(S, w.time + tune(w, 'railgun').dwell, () => this.relocate(w, S, L));
                  });
               }
            }
            if ((S.tick -= dt) > 0) return;
            S.tick = 1;
            if (!alive(w, S.pid)) return;
            const done = (o) => w.mission.objectives.find(x => x.id === o)?.state === 'done';
            if (done('ramps') && done('fort') && done('tf')) {
               if (alive(w, S.ally)) setObj(w, 'ally', 'done');
               w.end(true, 'Skarnholm ist ausgeschaltet, der Verband versenkt – die Durchfahrt ist frei.');
            }
         },
         onSiteDestroyed(w, site, by, S) {
            if (site.id === S.bunker) { setObj(w, 'bunker', 'done'); w.score.player++; radio(w, 'Erprobungsleitung', 'Kommandobunker getroffen. Die Festung ist führungslos.'); return; }
            if (S.ramps.includes(site.id)) {
               const n = S.ramps.filter(id => !w.sites.find(s => s.id === id)?.alive).length;
               w.score.player++;
               objText(w, 'ramps', `Schalten Sie die Startrampen aus (${n}/3)`);
               if (n >= 3) { setObj(w, 'ramps', 'done'); S.queue.length = 0; radio(w, 'Operationszentrale', 'Alle Startrampen zerstört. Keine Hyperschallstarts mehr.'); }
               else radio(w, 'Operationszentrale', site.name + ' zerstört.');
               return;
            }
            if (S.fort.includes(site.id)) {
               const n = S.fort.filter(id => !w.sites.find(s => s.id === id)?.alive).length;
               w.score.player++;
               if (site.kind === 'radar') { S.radarUp = false; radio(w, 'Operationszentrale', 'Radarstation zerstört. Die Rampen feuern jetzt ohne Zieldaten – deutlich ungenauer.'); }
               else radio(w, 'Operationszentrale', site.name + ' ausgeschaltet.');
               objText(w, 'fort', `Schalten Sie Batterien, Radar und Flugplatz aus (${n}/4)`);
               if (n >= 4) setObj(w, 'fort', 'done');
            }
         },
         onSink(w, ship, killer, S) {
            if (ship.id === S.pid) { w.end(false, 'Die Donar ist verloren.'); return; }
            if (ship.id === S.ally) { setObj(w, 'ally', 'failed'); radio(w, 'Hessen', 'Wir sinken – verlassen das Schiff!', 'warn'); return; }
            if (S.tf.includes(ship.id)) {
               const n = S.tf.filter(id => !alive(w, id)).length;
               w.score.player++;
               objText(w, 'tf', `Versenken Sie den auslaufenden Verband (${n}/3)`);
               if (n >= 3) setObj(w, 'tf', 'done');
            }
         },
         timeout(w) { w.end(false, 'Die Zeit ist abgelaufen – Skarnholm sperrt die Durchfahrt weiter.'); },
      },
   ];
}
