// gamev2/missions_west.js — operations 1-5 (Hormus, Rotes Meer, Ostsee, Schwarzes Meer, Nordatlantik).
// Definitions are built with the helpers of missions.js (passed in, no import cycle).
// All five are fictional present-day scenarios: no real persons, merchant ships are only ever
// protected, never targets. Radio traffic is German (UI), code and comments English.
//
// Shared conventions of the scripts:
//    S (= world._script) carries the mission state; S.tick refreshes objective texts once a second.
//    by(w, easy, normal, hard) picks a value for the difficulty.
//    Allied bots fight with reduced damage (dmgMult) so the player decides the battle; a human
//    captain who takes such a ship in co-op fights at full strength (net/setup.js).
import { addSite } from './sites.js';
import { launchSSM } from './missile.js';
import { addTaskPoint } from './seal.js';

export function westMissions(H) {
   const { P, add, objective, setObj, objText, later, radio, zone, inZone, islands } = H;
   const by = (w, e, n, h) => (w.difficultyKey === 'easy' ? e : w.difficultyKey === 'hard' ? h : n);
   const hyp = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
   const objState = (w, id) => (w.mission.objectives.find(o => o.id === id) || {}).state;
   // a merchant that has reached the goal zone leaves the battle
   const arrive = (w, ship) => { w.removeShip(ship, 'arrived'); };

   // Convoy bookkeeping shared by the escort missions (Hormus, Rotes Meer, Nordatlantik).
   // S.convoy = merchants, S.goal = zone, S.need = how many have to arrive, S.arrived / S.lost counters.
   function convoyTick(w, S, text) {
      for (const m of S.convoy) {
         if (m.alive && inZone(m, S.goal)) { arrive(w, m); S.arrived++; w.score.player = S.arrived; }
      }
      objText(w, 'convoy', `${text} (${S.arrived}/${S.convoy.length} am Ziel, mindestens ${S.need})`);
      if (S.arrived + S.lost < S.convoy.length) return false;
      return true;
   }
   function convoyLoss(w, S, ship) {
      if (!S.convoy.includes(ship)) return false;
      S.lost++; w.score.enemy = S.lost;
      setObj(w, 'all', 'failed');
      return true;
   }

   return [
      // ========================================================= 1. Straße von Hormus
      {
         id: 'hormus', group: 'ops', name: 'Straße von Hormus', subtitle: 'Geleitschutz · Schnellboote, Kleinst-U-Boot, Küstenbatterien',
         briefing: 'Drei Tanker laufen durch die Meerenge nach Osten. Bewaffnete Schnellboote haben in den letzten Tagen Handelsschiffe bedrängt, ' +
            'an der Nordküste stehen Flugkörperbatterien, und ein Kleinst-U-Boot wird im Fahrwasser vermutet. ' +
            'Bleiben Sie beim Geleit. Schnellboote sind Ziele für das Geschütz – Flugkörper sind für sie zu schade. ' +
            'Gegen anfliegende Flugkörper helfen Nahbereichsabwehr und Täuschkörper. Mindestens zwei Tanker müssen durchkommen.',
         debrief: 'Das Geleit ist durch. Schnellboote bekämpft man mit dem Geschütz, anfliegende Flugkörper mit Abwehr und Täuschkörpern – ' +
            'und wer beim Geleit bleibt, schützt es auch.',
         fleet: { own: 'Geleitschiff, 1 Korvette, 3 Tanker', foe: 'Schnellbootgruppen, 1 Kleinst-U-Boot, 2 Küstenbatterien' },
         env: { time: 'day', weather: 'clear' }, type: 'escort', playableShips: ['Sachsen', 'Burke', 'Daring'], recommendedShip: 'Sachsen',
         arena: 20000, timeLimit: 12 * 60, stars: 1,
         setup(w, shipKey) {
            const S = w._script;
            islands(w, [
               { c: P(1500, 17800), r: 3000, height: 320, seed: 21, lobes: 6, elong: 3.6, rot: 0, rough: 0.6, name: 'Nordküste' },
               { c: P(-4000, -17600), r: 2800, height: 420, seed: 33, lobes: 6, elong: 2.8, rot: 0.1, rough: 0.8, name: 'Südkap' },
               { c: P(-3200, 6400), r: 850, height: 120, seed: 41, lobes: 4, rough: 0.5, name: 'Westinsel' },
               { c: P(5600, 7200), r: 1100, height: 160, seed: 47, lobes: 5, rough: 0.5, name: 'Felseninsel' },
               { c: P(9500, -8200), r: 900, height: 140, seed: 53, lobes: 4, rough: 0.5, name: 'Südriff' },
            ]);
            add(w, shipKey, 'player', P(-12200, 600), 0, { isPlayer: true });
            S.escort = add(w, 'Braunschweig', 'player', P(-14800, -1900), 0, { dmgMult: 0.6, ai: { escortId: null } });
            const route = [P(-4000, -900), P(4500, 200), P(9800, 0)];
            S.convoy = [
               add(w, 'Tanker', 'player', P(-13600, -600), 0, { name: 'MT Nordstern', speedKn: 18, ai: { route } }),
               add(w, 'LNG', 'player', P(-14800, -600), 0, { name: 'LNG Aurora', speedKn: 18, ai: { route } }),
               add(w, 'Tanker', 'player', P(-16000, -600), 0, { name: 'MT Seeadler', speedKn: 18, ai: { route } }),
            ];
            S.escort.ai.escortId = S.convoy[2].id;
            S.goal = zone(w, 9800, 0, 1800, 'Golf von Oman');
            S.need = 2; S.arrived = 0; S.lost = 0; S.tick = 0; S.boats = 0;
            // the batteries stay silent (radar off, not yet located) until the convoy is deep in the strait
            S.batteries = [
               addSite(w, 'battery', 'enemy', P(5600, 6000), { name: 'Küstenbatterie Felseninsel', hidden: true, radarOn: false, delay: 1e9, ssm: { type: 'noor', n: by(w, 4, 6, 8) } }),
               addSite(w, 'battery', 'enemy', P(10500, 14500), { name: 'Küstenbatterie Nord', hidden: true, radarOn: false, delay: 1e9, ssm: { type: 'noor', n: by(w, 4, 6, 8) } }),
            ];
            S.sub = add(w, 'Ghadir', 'enemy', P(4200, -2600), Math.PI, { depth: 1, telegraph: 1, ai: { huntId: S.convoy[0].id } });
            objective(w, 'convoy', 'Geleiten Sie die Tanker durch die Meerenge (0/3 am Ziel, mindestens 2)');
            objective(w, 'all', 'Alle drei Schiffe erreichen den Golf von Oman', { optional: true });
            objective(w, 'sub', 'Versenken Sie das Kleinst-U-Boot', { optional: true });
            w.score = { kind: 'count', player: 0, enemy: 0, target: 3 };
            radio(w, 'Geleitführer', 'Geleit läuft mit 18 Knoten an. Halten Sie Position am Geleit, Radar an.');
            const wave = (n, from, hunt, text) => {
               radio(w, 'Ausguck', text, 'warn');
               for (let i = 0; i < n; i++) {
                  const a = (i - (n - 1) / 2) * 420;
                  add(w, 'Boghammar', 'enemy', P(from.x + a, from.y + Math.abs(a) * 0.4), Math.atan2(-from.y, -from.x), { minDist: 6500, speedKn: 38, hpMult: 0.7, dmgMult: by(w, 1, 1.1, 1.25), ai: { huntId: hunt.id, aggro: 1.5 } });
               }
               S.boats += n;
            };
            later(S, 40, () => wave(by(w, 4, 4, 5), P(-6500, 9500), S.convoy[0], 'Schnellboote von Norden, schnell näher kommend. Geschütz klar!'));
            later(S, 215, () => wave(by(w, 5, 5, 6), P(3500, 11500), S.convoy[1], 'Zweite Schnellbootgruppe hinter der Felseninsel hervor. Sie halten auf die Tanker zu.'));
            later(S, by(w, 345, 315, 285), () => {
               radio(w, 'Operationszentrale', 'Feuerleitradar von der Nordküste! Die Küstenbatterien schalten auf. Flugkörperabwehr klar, Täuschkörper bereithalten.', 'warn');
               for (const b of S.batteries) if (b.alive) { b.radarOn = true; b.detected = b.targetable = true; b.nextT = 10 + S.batteries.indexOf(b) * 12; }
            });
            later(S, 410, () => wave(by(w, 4, 4, 6), P(10500, -11500), S.convoy[2], 'Dritte Gruppe von Südosten, hinter dem Riff hervor.'));
            later(S, 130, () => radio(w, 'Operationszentrale', 'Hinweis: Ein Kleinst-U-Boot wird im Fahrwasser voraus vermutet. Sonar besetzen, Bordhubschrauber bereithalten.'));
         },
         update(w, dt, S) {
            if ((S.tick -= dt) > 0) return;
            S.tick = 1;
            if (!convoyTick(w, S, 'Geleiten Sie die Tanker durch die Meerenge')) return;
            if (S.arrived >= S.need) {
               if (S.arrived === S.convoy.length) setObj(w, 'all', 'done');
               setObj(w, 'convoy', 'done');
               w.end(true, S.lost ? 'Das Geleit hat die Meerenge passiert – ein Tanker ging verloren.' : 'Alle Tanker haben die Meerenge sicher passiert.');
            } else w.end(false, 'Zu viele Tanker gingen verloren.');
         },
         onSink(w, ship, killer, S) {
            if (ship === S.sub) { setObj(w, 'sub', 'done'); radio(w, 'Operationszentrale', 'Unterwasserkontakt vernichtet. Gute Arbeit.'); return; }
            if (!convoyLoss(w, S, ship)) return;
            radio(w, 'Geleitführer', ship.name + ' sinkt. Die Besatzung geht in die Boote.', 'warn');
            if (S.lost > S.convoy.length - S.need) w.end(false, 'Zwei Tanker gingen verloren – der Auftrag ist gescheitert.');
         },
         timeout(w, S) {
            if (S.arrived >= S.need) { setObj(w, 'convoy', 'done'); w.end(true, 'Das Geleit hat die Meerenge passiert – ein Nachzügler blieb zurück.'); }
            else w.end(false, 'Die Zeit ist abgelaufen – das Geleit hat die Meerenge nicht passiert.');
         },
      },
   ];
}
