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
      // ========================================================= 2. Rotes Meer – Bab al-Mandab
      {
         id: 'redsea', group: 'ops', name: 'Rotes Meer – Bab al-Mandab', subtitle: 'Flugkörperabwehr · Containerschiffe unter Beschuss von Land',
         briefing: 'Drei Containerschiffe laufen nach Süden durch die Meerenge. Von der Ostküste werden Seezielflugkörper in Wellen gestartet. ' +
            'Sie führen die Luftverteidigung: Bleiben Sie zwischen Küste und Geleit und teilen Sie Ihre Flugkörper ein – die Magazine sind endlich. ' +
            'Der Zerstörer im Verband hat bereits Angriffe abgewehrt und nur noch halbe Magazine. ' +
            'Startrampen, die gefeuert haben, werden geortet: Dann können Marschflugkörper sie ausschalten.',
         debrief: 'Das Geleit ist durch die Meerenge. Wer jeden Flugkörper mit dem teuersten Abwehrmittel bekämpft, steht am Ende mit leeren Magazinen da – ' +
            'und die sicherste Abwehr ist eine Startrampe, die nicht mehr feuert.',
         fleet: { own: 'Luftverteidigungsschiff, 1 Zerstörer, 3 Containerschiffe', foe: '3 Startrampen, Radarstation, Flugabwehrstellung an der Ostküste' },
         env: { time: 'dusk', weather: 'clear' }, type: 'escort', playableShips: ['Burke', 'Ticonderoga'], recommendedShip: 'Burke',
         arena: 20000, timeLimit: 11 * 60, stars: 2,
         setup(w, shipKey) {
            const S = w._script;
            islands(w, [
               { c: P(18200, 0), r: 3400, height: 520, seed: 71, lobes: 6, elong: 4, rot: Math.PI / 2, rough: 0.7, name: 'Ostküste' },
               { c: P(-15500, -7000), r: 1500, height: 180, seed: 77, lobes: 5, elong: 1.6, rot: 1.2, rough: 0.5, name: 'Westinseln' },
               { c: P(-13000, 9500), r: 1100, height: 140, seed: 83, lobes: 4, rough: 0.5 },
            ]);
            add(w, shipKey, 'player', P(-200, 13200), -Math.PI / 2, { isPlayer: true });
            const route = [P(-2500, 5000), P(-1800, -3000), P(-2200, -9500)];
            S.convoy = ['MV Hansa Carrier', 'MV Baltic Star', 'MV Elbe Trader'].map((name, i) =>
               add(w, 'Container', 'player', P(-2200, 14800 + i * 1250), -Math.PI / 2, { name, speedKn: 18, ai: { route } }));
            S.ally = add(w, 'Daring', 'player', P(-3600, 16600), -Math.PI / 2, { ai: { escortId: S.convoy[2].id } });
            S.ally.mag.aster30 = by(w, 12, 10, 8); S.ally.mag.camm = by(w, 10, 8, 6);
            S.goal = zone(w, -2200, -9500, 1800, 'Golf von Aden');
            S.need = 2; S.arrived = 0; S.lost = 0; S.tick = 0; S.queue = []; S.wave = 0; S.launched = 0;
            S.launchers = [['Startrampe Nord', 7500], ['Startrampe Mitte', 300], ['Startrampe Süd', -7000]].map(([name, y]) => {
               const L = addSite(w, 'launcher', 'enemy', P(15000, y), { name, hidden: true, hp: by(w, 9000, 16000, 18000), ssm: { type: 'kh35', n: 400 } });
               L.cfg.weapons.ssm.push({ type: 'oniks', n: 400 }); L.mag.oniks = 400;
               return L;
            });
            S.radar = addSite(w, 'radar', 'enemy', P(15000, 3900), { name: 'Radarstation Küste' });
            if (w.difficultyKey !== 'easy') S.sam = addSite(w, 'sam', 'enemy', P(15000, -3300), { name: 'Flugabwehrstellung Küste', sam: { type: 'hq16', n: by(w, 0, 14, 20), ch: 2 } });
            objective(w, 'convoy', 'Schützen Sie die Containerschiffe (0/3 am Ziel, mindestens 2)');
            objective(w, 'all', 'Kein Containerschiff geht verloren', { optional: true });
            objective(w, 'sites', 'Schalten Sie die georteten Startrampen aus (0/3)', { optional: true });
            w.score = { kind: 'count', player: 0, enemy: 0, target: 3 };
            radio(w, 'Geleitführer', 'Geleit läuft nach Süden. Erwarten Flugkörper von der Ostküste – Radar an, Abwehr klar.');
            // waves: every living launcher ripples n missiles; from the fifth wave on the first of each is supersonic
            const T0 = 30, GAP = by(w, 62, 54, 48);
            for (let k = 0; k < 9; k++) later(S, T0 + k * GAP, () => this.wave(w, S, k));
            later(S, T0 + 2.5 * GAP, () => radio(w, 'Operationszentrale', 'Magazinstand beachten. Feuerordnung anpassen – nicht jeden Flugkörper doppelt bekämpfen.'));
            later(S, T0 + 4 * GAP - 8, () => radio(w, 'Operationszentrale', 'Warnung: Die nächsten Salven enthalten Überschall-Flugkörper. Täuschkörper bereithalten.', 'warn'));
         },
         wave(w, S, k) {
            const live = S.launchers.filter(L => L.alive);
            if (!live.length || S.arrived + S.lost >= S.convoy.length) return;
            S.wave++;
            const n = by(w, 1, 2, 2) + (k >= by(w, 2, 2, 3) ? 1 : 0) + (k >= by(w, 99, 5, 6) ? 1 : 0);
            radio(w, 'Operationszentrale', `Flugkörperstart an der Ostküste, Welle ${S.wave}. Anflug aus Ost.`, 'warn');
            for (const L of live) for (let i = 0; i < n; i++)
               S.queue.push({ L, t: w.time + S.launchers.indexOf(L) * 2.5 + i * 1.3, type: k >= 4 && i === 0 && w.difficultyKey !== 'easy' ? 'oniks' : 'kh35', tries: 0 });
         },
         update(w, dt, S) {
            // launch queue: one round per entry, at a merchant (every fourth round at an escort)
            for (let i = S.queue.length - 1; i >= 0; i--) {
               const q = S.queue[i], L = q.L;
               if (w.time < q.t) continue;
               const ships = S.convoy.filter(m => m.alive);
               if (!L.alive || !ships.length || q.tries++ > 200) { S.queue.splice(i, 1); continue; }
               let T = ships[(S.launched + S.launchers.indexOf(L)) % ships.length];
               if (S.launched % 4 === 3) {
                  const esc = w.ships.filter(e => e.alive && e.side === 'player' && !S.convoy.includes(e));
                  if (esc.length) T = esc[S.launched % esc.length];
               }
               const m = (T.targetable && launchSSM(w, L, { targetId: T.id }, q.type)) || (q.tries > 3 ? launchSSM(w, L, { x: T.pos.x, y: T.pos.y }, q.type) : null);
               if (!m) continue;
               S.launched++;
               S.queue.splice(i, 1);
               if (!L.detected && !L.locating) {
                  L.locating = true;
                  later(S, w.time + 7, () => {
                     if (!L.alive) return;
                     L.detected = L.targetable = true;
                     radio(w, 'Operationszentrale', L.name + ' geortet. Freigabe für Marschflugkörper.');
                  });
               }
            }
            if ((S.tick -= dt) > 0) return;
            S.tick = 1;
            if (!convoyTick(w, S, 'Schützen Sie die Containerschiffe')) return;
            if (S.arrived >= S.need) {
               if (!S.lost) setObj(w, 'all', 'done');
               setObj(w, 'convoy', 'done');
               w.end(true, S.lost ? 'Das Geleit ist durch die Meerenge – ein Schiff ging verloren.' : 'Alle Containerschiffe haben die Meerenge sicher passiert.');
            } else w.end(false, 'Zu viele Schiffe gingen verloren.');
         },
         onSiteDestroyed(w, site, by_, S) {
            if (site === S.radar) { radio(w, 'Operationszentrale', 'Radarstation zerstört. Die Rampen feuern jetzt ohne Zieldaten – deutlich ungenauer.'); return; }
            if (!S.launchers.includes(site)) return;
            const n = S.launchers.filter(L => !L.alive).length;
            objText(w, 'sites', `Schalten Sie die georteten Startrampen aus (${n}/3)`);
            if (n >= 3) { setObj(w, 'sites', 'done'); radio(w, 'Operationszentrale', 'Alle Startrampen ausgeschaltet. Der Beschuss hört auf.'); }
            else radio(w, 'Operationszentrale', site.name + ' ausgeschaltet.');
         },
         onSink(w, ship, killer, S) {
            if (!convoyLoss(w, S, ship)) return;
            radio(w, 'Geleitführer', ship.name + ' ist schwer getroffen und sinkt. Rettungsmittel sind ausgebracht.', 'warn');
            if (S.lost > S.convoy.length - S.need) w.end(false, 'Zwei Containerschiffe gingen verloren – der Auftrag ist gescheitert.');
         },
         timeout(w, S) {
            if (S.arrived >= S.need) { setObj(w, 'convoy', 'done'); w.end(true, 'Das Geleit ist durch die Meerenge – ein Nachzügler blieb zurück.'); }
            else w.end(false, 'Die Zeit ist abgelaufen – das Geleit hat die Meerenge nicht passiert.');
         },
      },
   ];
}
