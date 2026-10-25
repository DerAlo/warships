// game3d/missions_coast.js — fourth batch of operations, built by coastMissions(H) from the helpers
// of missions.js (same contract as missions_west.js). Fictionalised what-if scenarios, no real persons.
//   vwaffe       a battleship shells V-2 launch sites on the Dutch coast before their rockets lift off
//   nachtdock    night raid: an old destroyer rams the caisson of a dry dock under the coastal guns
//   fjord        Tirpitz breaks out of a Norwegian fjord under carrier strikes, into a storm
//   sturmgeleit  a cruiser screens a crippled battleship through a North Sea storm against torpedo boats
// vwaffe and nachtdock use land targets (sites.js); they are single-player (net/setup.js NO_COOP).
import { canLaunch, launchSquadron } from './air.js';
import { SHIPS } from './config.js';
import { addSite, damageSite } from './sites.js';
import { obstacleT } from './utils.js';

// Light craft (S-boats, Vorpostenboote): a destroyer hull cut down to what such a boat was, as in
// missions_west.js. Only values change, never the number of turrets or launchers.
const sBoat = () => {
   const c = SHIPS.Gnevny, m = c.main;
   return {
      ...c, speedKn: 40,
      detect: { ...c.detect, surface: 4800, fire: 5600 },
      main: { ...m, range: 2600, reload: 2.5, ap: { ...m.ap, dmg: 300 }, he: { ...m.he, dmg: 260, fire: 0.01 } },
      torp: { ...c.torp, range: 4500, launchers: c.torp.launchers.map(l => ({ ...l, tubes: 2 })) },
   };
};
// Vorpostenboot: an armed trawler, guns only (the torpedo tubes of the hull stay, with a token reach)
const vpBoat = () => { const c = sBoat(); return { ...c, speedKn: 22, torp: { ...c.torp, range: 400, dmg: 2500 } }; };
const RAMP_IDS = ['A', 'B', 'C', 'D', 'E'];

export function coastMissions(H) {
   const { P, add, objective, setObj, objText, later, radio, zone, inZone, islands } = H;
   const pct = (f) => Math.max(0, Math.round(f * 100));
   const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
   const mmss = (t) => { t = Math.max(0, Math.ceil(t)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
   // the first open water west of the land that fills the east of the map, along the line y
   const coastX = (w, y) => {
      const q = { x: 0, y };
      for (q.x = w.arena; q.x > -w.arena; q.x -= 20) if (w.obstacles.every(o => obstacleT(o, q) > 1)) return q.x;
      return 0;
   };
   const ashore = (w, y, depth) => P(coastX(w, y) + depth, y);
   const offMap = (w, ship) => {
      for (const list of [w.ships, w.roster, w.bots]) { const i = list.indexOf(ship); if (i >= 0) list.splice(i, 1); }
      return ship;
   };
   // a site's mark on the minimap is a mission zone (the minimap labels zones); gone when the site is
   const markSite = (w, s, label, kind) => { s.zone = zone(w, s.x, s.y, Math.max(260, s.r * 4), label, kind); return s.zone; };
   const unmark = (w, s) => { const z = w.mission.zones, i = z.indexOf(s.zone); if (i >= 0) z.splice(i, 1); s.zone = null; };
   // the nearest live, known site of `list` within `range` of ship b (by priority fn when given)
   const pickSite = (b, list, range, prio) => {
      let best = null, bs = Infinity;
      for (const s of list) {
         if (!s.alive || s.hidden) continue;
         const d = dist(b.pos, s);
         if (d > range) continue;
         const v = prio ? prio(s, d) : d;
         if (v < bs) { bs = v; best = s; }
      }
      return best;
   };
   // the carrier strikes of the fjord: the squadrons need a base to start from and return to
   const strike = (w, cv, type, target) => {
      if (!cv || !target || !target.alive || w.phase !== 'playing') return false;
      cv.air.deckT = 0;
      cv.air[type].hangar = Math.max(cv.air[type].hangar, cv.cfg.air[type].squad);
      return canLaunch(w, cv, type) && !!launchSquadron(w, cv, type, { kind: 'strike', targetId: target.id, pos: { x: target.pos.x, y: target.pos.y } });
   };

   return [
      // ------------------------------------------------------------ op: V-2 launch sites
      // Five launch sites a little inland count down to their launch; each rocket that lifts off is
      // one more on London. A battleship has the range to reach them from beyond the shoals, coastal
      // batteries and the fast boats of the nearby harbour keep her busy. Which ramp is next matters
      // more than how many guns are left on the coast.
      {
         id: 'vwaffe', group: 'ops', name: 'Die Rampen von Scheveningen', subtitle: 'Niederländische Küste · Oktober 1944 (fiktive Operation)',
         fleet: { own: 'HMS Warspite · HMS Jervis, HMS Javelin', foe: '5 V-2-Abschussrampen · 3 Küstenbatterien · Schnellboote, Zerstörer' },
         briefing: 'Aus den Wäldern hinter den Dünen von Den Haag steigen seit Wochen die V-2-Raketen auf, gegen die es keine Abwehr gibt – jede schlägt ohne Vorwarnung in London ein. ' +
            'Die Luftaufklärung hat fünf Abschussrampen an der Küste ausgemacht, die heute betankt werden. Die Admiralität schickt die alte Warspite: Ihre 38-cm-Geschütze reichen weiter landeinwärts als jedes andere Schiff in der Nordsee. ' +
            'Zerstören Sie die Rampen, bevor ihre Raketen starten – der Countdown jeder Rampe steht auf Ihrer Karte. Sprenggranaten (HE) zerschlagen die leichten Startgestelle, Panzergranaten bohren sich wirkungslos in den Sand. ' +
            'Küstenbatterien schießen zurück, und aus dem Hafen laufen Schnellboote aus. Starten zu viele Raketen, ist die Operation gescheitert.',
         debrief: 'Ein Szenario, das so nicht stattgefunden hat: Die V-2-Stellungen bei Den Haag waren mobil, gut getarnt und lagen meist zu weit landeinwärts für Schiffsartillerie. ' +
            'Die Warspite aber beschoss im Herbst 1944 tatsächlich die Küste – bei Brest, Le Havre und vor Walcheren, wo ihre Geschütze im November 1944 deutsche Küstenbatterien niederhielten, damit die Landungsboote die Scheldemündung öffnen konnten. ' +
            'Bis zum März 1945 fielen über 1.300 V-2 auf England, davon mehr als die Hälfte auf London. Erst der Vormarsch der Alliierten setzte den Starts ein Ende.',
         env: { time: 'day', weather: 'overcast' }, type: 'historic', playableShips: ['Warspite'], recommendedShip: 'Warspite',
         arena: 13000, timeLimit: 14 * 60, stars: 2,
         setup(w, shipKey) {
            islands(w, [
               { c: P(14600, -6200), r: 3300, height: 40, seed: 2101, lobes: 6, elong: 2.2, rot: Math.PI / 2, rough: 0.3, name: 'Zuid-Holland' },
               { c: P(14400, 6400), r: 3300, height: 45, seed: 2103, lobes: 6, elong: 2.2, rot: Math.PI / 2, rough: 0.3, name: 'Den Haag' },
               { c: P(-2600, -10600), r: 900, height: 25, seed: 2105, lobes: 4, elong: 2, rot: 0.2, rough: 0.6, name: 'Sandbank' },
            ]);
            const S = w._script, key = w.difficulty.key;
            S.maxLaunch = key === 'easy' ? 3 : key === 'hard' ? 1 : 2;   // rockets the operation can afford
            S.launched = 0; S.tick = 0; S.down = 0;
            // ramps: staggered countdowns, refuelled after a launch; C and E are found later
            const R = [[-7600, 550, 180, false], [-2600, 1100, 260, false], [1600, 1300, 380, true], [6000, 700, 320, false], [9200, 1200, 470, true]];
            const rearm = key === 'easy' ? 360 : key === 'hard' ? 260 : 300;
            S.ramps = R.map(([y, depth, t, hidden], i) => addSite(w, 'ramp', 'enemy', ashore(w, y, depth), { name: 'Rampe ' + RAMP_IDS[i], countdown: t * (key === 'easy' ? 1.15 : 1), rearm, hidden, heading: Math.PI }));
            for (const r of S.ramps) if (!r.hidden) markSite(w, r, r.name, 'goal');
            S.batteries = [
               addSite(w, 'battery', 'enemy', ashore(w, -4800, 160), { name: 'Batterie Kijkduin', gun: 'light', detect: 9000, heading: Math.PI }),
               addSite(w, 'battery', 'enemy', ashore(w, 3700, 160), { name: 'Batterie Scheveningen', gun: 'light', detect: 9000, heading: Math.PI }),
               addSite(w, 'battery', 'enemy', ashore(w, -9800, 250), { name: 'Batterie Hoek', gun: 'heavy', detect: 12000, heading: Math.PI, delay: 40 }),
            ];
            for (const b of S.batteries) markSite(w, b, b.name, 'danger');
            const me = add(w, shipKey, 'player', P(-4200, -1000), 0, { isPlayer: true, name: 'HMS Warspite', telegraph: 3 });
            // the autopilot (tests) steams up and down a bombardment line inside her range
            me.ai.patrol = [P(500, -5200), P(700, 4200)];
            me.ai.shoreFirst = true;
            S.escort = [['HMS Jervis', P(-3800, 900)], ['HMS Javelin', P(-3600, -2900)]]
               .map(([name, pos]) => add(w, 'Jervis', 'player', pos, 0, { name, dmgMult: 0.5, ai: { escortIdPlayer: true } }));
            // the harbour's light forces: S-boats first, the destroyers once the shelling starts
            S.waves = 0;
            const boats = (n, y0, text) => {
               if (w.phase !== 'playing') return;
               for (let i = 0; i < n; i++) {
                  const b = add(w, 'Gnevny', 'enemy', P(9600, y0 + i * 600), Math.PI, {
                     name: 'S ' + (38 + S.waves * 3 + i), cfg: sBoat(), nation: 'de', telegraph: 4, minDist: 6500, hpMult: w.difficulty.botHP * 0.4,
                     ai: { huntId: me.id, press: true, aggro: 1.5 },
                  });
                  b.dmgMult *= 0.8;
               }
               S.waves++;
               radio(w, 'Radar HMS Jervis', text, 'warn');
            };
            later(S, 70, () => boats(3, -1200, 'Schnellboote laufen aus Scheveningen aus – drei Stück, hohe Fahrt!'));
            later(S, 300, () => {
               if (w.phase !== 'playing') return;
               for (const y of [-3500, -2700]) add(w, 'Z23', 'enemy', P(9400, y), Math.PI, { telegraph: 4, minDist: 8000, hpMult: w.difficulty.botHP * 0.75, dmgMult: w.difficulty.botDmg * 0.6, ai: { huntId: me.id, aggro: 1.2 } });
               radio(w, 'Radar HMS Jervis', 'Zwei Zerstörer aus Hoek van Holland, Kurs auf uns! Wir gehen dazwischen.', 'warn');
            });
            later(S, 520, () => boats(3, 2000, 'Zweite Schnellbootgruppe aus Norden – Torpedoalarm!'));
            later(S, 4, () => radio(w, 'Admiralität', 'Warspite, die Rampen werden betankt. Jede Rakete, die startet, trifft London. Beginnen Sie mit der Rampe, deren Uhr zuerst abläuft.'));
            later(S, 120, () => this._reveal(w, S, 2, 'Fotoaufklärung: weitere Rampe C im Wald hinter den Dünen – auf Ihrer Karte markiert!'));
            later(S, 260, () => this._reveal(w, S, 4, 'Widerstandsgruppe meldet Rampe E bei Wassenaar – Countdown läuft!'));
            S.onRocket = (ww, site) => this._rocket(ww, ww._script, site);
            S.onSiteDestroyed = (ww, site) => this._down(ww, ww._script, site);
            objective(w, 'ramps', 'Zerstören Sie alle V-2-Abschussrampen (0/5)');
            objective(w, 'launch', `Höchstens ${S.maxLaunch} Raketen dürfen starten (0/${S.maxLaunch})`);
            objective(w, 'batteries', 'Schalten Sie die drei Küstenbatterien aus (0/3)', { optional: true });
            objective(w, 'clean', 'Keine einzige Rakete startet', { optional: true });
            w.score = { kind: 'kills', player: 0, enemy: 0, target: 5 };
         },
         _reveal(w, S, i, text) {
            const r = S.ramps[i];
            if (!r.alive || w.phase !== 'playing') return;
            r.hidden = false;
            markSite(w, r, r.name, 'goal');
            radio(w, 'Aufklärung', text, 'warn');
         },
         _rocket(w, S, site) {
            if (w.phase !== 'playing') return;
            S.launched++;
            w.score.enemy = S.launched;
            setObj(w, 'clean', 'failed');
            radio(w, 'Admiralität', `${site.name}: Rakete gestartet – Brennschluss in einer Minute, Einschlag London in fünf. (${S.launched}/${S.maxLaunch})`, 'warn');
            objText(w, 'launch', `Höchstens ${S.maxLaunch} Raketen dürfen starten (${Math.min(S.launched, S.maxLaunch)}/${S.maxLaunch})`);
            if (S.launched > S.maxLaunch) {
               setObj(w, 'launch', 'failed', `Zu viele Raketen gestartet (${S.launched})`);
               w.end(false, 'Zu viele V-2 sind gestartet – London brennt, die Operation ist gescheitert.');
            }
         },
         _down(w, S, site) {
            unmark(w, site);
            if (site.kind === 'battery') {
               const n = S.batteries.filter(b => !b.alive).length;
               objText(w, 'batteries', `Schalten Sie die drei Küstenbatterien aus (${n}/3)`);
               if (n === 3) setObj(w, 'batteries', 'done', 'Alle Küstenbatterien ausgeschaltet');
               radio(w, 'Artillerieoffizier', site.name + ' schweigt!');
               return;
            }
            if (site.kind !== 'ramp') return;
            const n = S.ramps.filter(r => !r.alive).length;
            w.score.player = n;
            objText(w, 'ramps', `Zerstören Sie alle V-2-Abschussrampen (${n}/5)`);
            radio(w, 'Beobachter', site.armed === false && site.launches ? site.name + ' zerstört.' : site.name + ' fliegt in die Luft – der Treibstoff brennt!');
            if (n === 5) {
               setObj(w, 'ramps', 'done', 'Alle Abschussrampen zerstört');
               setObj(w, 'launch', 'done');
               if (!S.launched) setObj(w, 'clean', 'done');
               w.end(true, 'Alle V-2-Rampen an der Küste sind zerstört – heute fällt keine Rakete mehr auf London.');
            }
         },
         update(w, dt, S) {
            if (w.phase !== 'playing') return;
            if ((S.tick -= dt) > 0) return;
            S.tick = 1;
            for (const r of S.ramps) if (r.alive && !r.hidden && r.zone) r.zone.label = r.armed ? `${r.name} ${mmss(r.countdown)}` : r.name;
            // the bots: the Warspite (autopilot) works down the countdowns, the escort the batteries
            const me = w.player;
            if (me && me.alive && me.ai) me.ai.shoreAim = pickSite(me, S.ramps, me.cfg.main.range * 0.97, (s, d) => (s.armed ? s.countdown : 900) + d / 200);
            for (const e of S.escort) if (e.alive) e.ai.shoreAim = pickSite(e, S.batteries, e.cfg.main.range * 0.95) || pickSite(e, S.ramps, e.cfg.main.range * 0.95);
            if (!S.warned) {
               const next = S.ramps.find(r => r.alive && !r.hidden && r.armed && r.countdown < 30);
               if (next) { S.warned = true; radio(w, 'Admiralität', next.name + ' meldet Startbereitschaft – noch 30 Sekunden!', 'warn'); later(S, w.time + 40, () => { S.warned = false; }); }
            }
         },
         onSink(w, ship, killer, S) {
            if (ship.side === 'player' && ship !== w.player) radio(w, 'HMS Warspite', ship.name + ' ist gesunken. Weiterfeuern!', 'warn');
         },
         timeout(w, S) {
            setObj(w, 'ramps', 'failed');
            w.end(false, 'Die Zeit ist um – die übrigen Rampen feuern im Schutz der Nacht.');
         },
      },

      // ------------------------------------------------------------ op: the dock gate
      // An old destroyer, lightened and stuffed with explosives, runs up a defended estuary by night
      // and rams the caisson of the only dry dock on the coast that can take a battleship. Shelling
      // the gate does little: the ship herself is the weapon. Batteries see her only in their
      // searchlights (or when the patrol boats report her), so speed and the dark are her armour.
      {
         id: 'nachtdock', group: 'ops', name: 'Rammstoß im Morgengrauen', subtitle: 'Atlantikküste · März 1942 (fiktive Operation)',
         fleet: { own: 'HMS Thornbury (Zerstörer, Sprengladung) · 3 Motorbarkassen', foe: 'Docktor · 3 Küstenbatterien · Vorpostenboote, Torpedoboot' },
         briefing: 'An der französischen Atlantikküste liegt das einzige Trockendock, in dem ein deutsches Schlachtschiff repariert werden könnte. Ohne dieses Dock wagt sich keines mehr in den Atlantik. ' +
            'Ihr Schiff, die alte HMS Thornbury, wurde erleichtert, am Bug verstärkt und mit vier Tonnen Sprengstoff beladen. Ihr Auftrag: Rammen Sie das Docktor am Ende der Flussmündung – mit mindestens 12 Knoten. ' +
            'Ein Zeitzünder sprengt die Ladung kurz darauf. Die Küstenbatterien sehen Sie nur im Licht ihrer Scheinwerfer oder wenn ein Vorpostenboot Sie meldet: Bleiben Sie schnell und dunkel. ' +
            'Granaten richten gegen das Stahltor wenig aus – das Schiff selbst ist die Waffe.',
         debrief: 'Das Vorbild dieses Szenarios ist der Angriff auf St-Nazaire am 28. März 1942: Der alte Zerstörer HMS Campbeltown rammte unter deutscher Flagge und schwerem Feuer das Tor des Normandie-Docks. ' +
            'Am nächsten Mittag, als deutsche Offiziere das Wrack besichtigten, zündete die versteckte Ladung und zerstörte das Docktor – das Dock blieb bis Kriegsende unbrauchbar, die Tirpitz kam nie in den Atlantik. ' +
            'Der Preis war hoch: Von 611 Männern der Kommandotruppe und der Boote kehrten nur 228 nach England zurück.',
         env: { time: 'night', weather: 'rain' }, type: 'historic', playableShips: ['Jervis'], recommendedShip: 'Jervis',
         arena: 11000, timeLimit: 12 * 60, stars: 3,
         setup(w, shipKey) {
            islands(w, [
               { c: P(1800, -6900), r: 2300, height: 70, seed: 2201, lobes: 7, elong: 2.6, rot: 0.04, rough: 0.5, name: 'Nordufer' },
               { c: P(1800, 6900), r: 2300, height: 60, seed: 2203, lobes: 7, elong: 2.6, rot: -0.04, rough: 0.5, name: 'Südufer' },
               { c: P(10600, 0), r: 2200, height: 40, seed: 2205, lobes: 5, elong: 1.6, rot: Math.PI / 2, rough: 0.35, name: 'Hafen' },
            ]);
            const S = w._script, key = w.difficulty.key;
            S.need = 12;   // knots at the gate
            // the dock gate on the harbour shore, the water in front of it is the goal
            const hx = coastX(w, 0);
            S.gate = addSite(w, 'gate', 'enemy', P(hx + 50, 0), { name: 'Docktor', heading: Math.PI });
            S.front = zone(w, hx - 260, 0, 380, 'Docktor', 'goal');
            S.batteries = [
               addSite(w, 'battery', 'enemy', this._shore(w, -1400, -1, 120), { name: 'Batterie Pointe', gun: 'light', guns: 2, reload: 11, detect: 4200, hp: 6500 }),
               addSite(w, 'battery', 'enemy', this._shore(w, 4100, 1, 120), { name: 'Batterie Ville', gun: 'light', guns: 2, reload: 11, detect: 4200, hp: 6500 }),
               addSite(w, 'battery', 'enemy', ashore(w, -1500, 120), { name: 'Batterie Mole', gun: 'light', guns: 2, reload: 12, detect: 3600, hp: 6500, delay: 20 }),
            ];
            for (const b of S.batteries) markSite(w, b, b.name, 'danger');
            const me = add(w, shipKey, 'player', P(-9400, 300), 0, { isPlayer: true, name: 'HMS Thornbury', telegraph: 4, hpMult: key === 'easy' ? 1.7 : key === 'hard' ? 1.3 : 1.45 });
            me.ai.route = [P(-3000, 0), P(3500, 0), P(S.front.x, 0)];   // only read by the autopilot (tests)
            me.ai.routeIdx = 0;
            // the launches run up with her and draw fire; light guns only
            S.mls = [0, 1, 2].map(i => {
               const b = add(w, 'Gnevny', 'player', P(-9900 - i * 300, -700 + i * 700), 0, { name: 'ML ' + (192 + i), cfg: sBoat(), dmgMult: 0.6, hpMult: 0.35, ai: { escortIdPlayer: true } });
               return b;
            });
            // Vorpostenboote patrol the mouth, a torpedo boat waits inside the harbour
            S.patrol = [[P(-1000, -1800), P(-1000, 1800)], [P(3600, 1600), P(3600, -1600)]].map((pts, i) => add(w, 'Gnevny', 'enemy', pts[0], Math.PI / 2, {
               name: 'Vp ' + (1601 + i), cfg: vpBoat(), nation: 'de', telegraph: 2, hpMult: w.difficulty.botHP * 0.45, ai: { patrol: pts },
            }));
            later(S, 150, () => {
               if (w.phase !== 'playing') return;
               const z = SHIPS.Z23;   // a torpedo boat: a destroyer hull with lighter torpedoes
               S.tb = add(w, 'Z23', 'enemy', P(6500, -1200), Math.PI, { name: 'T 22', telegraph: 4, cfg: { ...z, torp: { ...z.torp, range: 2500, dmg: Math.round(z.torp.dmg * 0.4) } }, hpMult: w.difficulty.botHP * 0.6, ai: { huntId: me.id, aggro: 1.4 } });
               radio(w, 'Signalgast', 'Torpedoboot läuft aus dem Hafenbecken aus – es kommt uns entgegen!', 'warn');
            });
            later(S, 3, () => radio(w, 'Kommandant', 'Alle Mann auf Gefechtsstation. Volle Fahrt, Kurs Docktor – und betet, dass die Scheinwerfer uns nicht finden.'));
            later(S, 40, () => radio(w, 'Ausguck', 'Vorpostenboot voraus! Wenn es uns meldet, sind alle Batterien wach.', 'warn'));
            S.onSiteDestroyed = (ww, site) => this._down(ww, ww._script, site);
            S.tick = 0;
            objective(w, 'ram', 'Rammen Sie das Docktor mit mindestens 12 kn');
            objective(w, 'blow', 'Die Sprengladung muss zünden');
            objective(w, 'batteries', 'Schalten Sie zwei der drei Batterien aus (0/2)', { optional: true });
            objective(w, 'hull', 'Erreichen Sie das Dock mit über 50 % Zustand', { optional: true });
            w.score = { kind: 'kills', player: 0, enemy: 0, target: 1 };
         },
         // a point `depth` m inside the estuary's north (side -1) or south (+1) bank at x
         _shore(w, x, side, depth) {
            const q = { x, y: 0 };
            while (Math.abs(q.y) < w.arena && w.obstacles.every(o => obstacleT(o, q) > 1)) q.y += side * 20;
            return P(x, q.y + side * depth);
         },
         _down(w, S, site) {
            unmark(w, site);
            if (site === S.gate) {
               setObj(w, 'ram', 'done'); setObj(w, 'blow', 'done', 'Docktor gesprengt');
               if (!S.rammed) setObj(w, 'hull', 'failed');
               w.score.player = 1;
               w.end(true, 'Das Docktor ist zerstört – das Dock bleibt für Jahre unbrauchbar.');
               return;
            }
            const n = S.batteries.filter(b => !b.alive).length;
            objText(w, 'batteries', `Schalten Sie zwei der drei Batterien aus (${Math.min(2, n)}/2)`);
            if (n >= 2) setObj(w, 'batteries', 'done', 'Batterien ausgeschaltet');
            radio(w, 'Artillerieoffizier', site.name + ' ist still!');
         },
         update(w, dt, S) {
            if (w.phase !== 'playing') return;
            const me = w.player;
            if (!S.rammed && me && me.alive && inZone(me, S.front)) {
               if (me.speedKnots >= S.need) {
                  S.rammed = w.time;
                  S.blowT = w.time + (w.difficulty.key === 'hard' ? 30 : 22);
                  setObj(w, 'ram', 'done', 'Docktor gerammt');
                  setObj(w, 'hull', me.hp / me.maxHP > 0.5 ? 'done' : 'failed');
                  me.speed = 0; me.setTelegraph?.(0);
                  damageSite(w, S.gate, S.gate.maxHp * 0.15, me);
                  w.addEffect('explosion', { x: S.gate.x - 120, y: S.gate.y }, 1.2, 40, { big: true });
                  w.shakeAdd(1.5);
                  radio(w, 'Kommandant', 'Wir sitzen fest im Tor! Zeitzünder läuft – alle Mann von Bord, Kommandos an Land!', 'warn');
               } else if (!S.slowMsg) {
                  S.slowMsg = true;
                  radio(w, 'Erster Offizier', 'Zu langsam! Wir brauchen mindestens 12 Knoten, sonst prallen wir nur ab – Anlauf nehmen!', 'warn');
                  later(S, w.time + 15, () => { S.slowMsg = false; });
               }
            }
            if (S.rammed && w.time >= S.blowT && S.gate.alive) damageSite(w, S.gate, S.gate.hp + 1, me);
            if ((S.tick -= dt) > 0) return;
            S.tick = 1;
            if (S.rammed && S.gate.alive) objText(w, 'blow', `Die Sprengladung muss zünden (${mmss(S.blowT - w.time)})`);
            else if (!S.rammed && me && me.alive) objText(w, 'ram', `Rammen Sie das Docktor mit mindestens 12 kn (${me.speedKnots.toFixed(0)} kn, ${(dist(me.pos, S.front) / 1000).toFixed(1)} km)`);
            for (const m of S.mls) if (m.alive) m.ai.shoreAim = pickSite(m, S.batteries, 2400);
            if (me && me.alive && me.ai) me.ai.shoreAim = pickSite(me, S.batteries, 6000);
            // first time the patrol is spotted reporting the destroyer: the coast wakes up
            if (!S.alarm && me && me.detected) { S.alarm = true; radio(w, 'Funker', 'Sie haben uns! Scheinwerfer an Land – die Batterien eröffnen das Feuer!', 'warn'); }
         },
         onSink(w, ship, killer, S) {
            // once she sits in the gate, the charge goes off whether she is still afloat or not
            if (ship === w.player && S.rammed && S.gate.alive) damageSite(w, S.gate, S.gate.hp + 1, null);
         },
         timeout(w, S) {
            if (S.rammed && S.gate.alive) { damageSite(w, S.gate, S.gate.hp + 1, w.player); return; }
            setObj(w, 'ram', 'failed');
            w.end(false, 'Der Morgen graut – im Tageslicht kommt kein Schiff mehr bis zum Dock.');
         },
      },

      // ------------------------------------------------------------ op: fjord breakout
      // The player has the Tirpitz in a fjord. Carrier aircraft attack while the sky is clear; a storm
      // front closes in after a few minutes and grounds them, but at the mouth a cruiser squadron
      // waits. Get her into the open sea.
      {
         id: 'fjord', group: 'ops', name: 'Ausbruch aus dem Altafjord', subtitle: 'Nordnorwegen · April 1944 (fiktive Operation)',
         fleet: { own: 'Schlachtschiff Tirpitz · Z 29, Z 30', foe: 'Trägerflugzeuge (HMS Victorious) · 2 Kreuzer, 2 Zerstörer' },
         briefing: 'Seit Monaten liegt die Tirpitz in den Fjorden Nordnorwegens – allein ihre Anwesenheit bindet die halbe Home Fleet. Heute soll sie ausbrechen, um die Geleitzüge nach Murmansk anzugreifen. ' +
            'Doch ein britischer Träger steht vor der Küste: Sturzkampf- und Torpedoflieger greifen an, solange das Wetter klar ist. Von Westen zieht eine Sturmfront heran – sobald sie da ist, bleiben die Flugzeuge am Boden. ' +
            'An der Fjordmündung warten zwei Kreuzer und zwei Zerstörer. Bringen Sie die Tirpitz in die offene See im Osten. Weichen Sie den Torpedos aus, halten Sie die Flak in Bewegung und brechen Sie durch.',
         debrief: 'Diesen Ausbruch hat es nie gegeben. Am 3. April 1944 griffen Flugzeuge der Träger Victorious und Furious die Tirpitz im Kåfjord an (Operation Tungsten) und trafen sie mit 14 Bomben. ' +
            'Das Schiff war monatelang außer Gefecht. Im Herbst verlegte es nach Tromsø, wo es am 12. November 1944 von Lancaster-Bombern mit Tallboy-Bomben versenkt wurde. ' +
            'Ihre eigentliche Wirkung entfaltete die Tirpitz als „Fleet in being“: Allein die Möglichkeit, sie könnte auslaufen, zwang die Royal Navy, schwere Einheiten im Norden zu halten.',
         env: { time: 'dawn', weather: 'clear', front: { at: 270, dur: 70, to: 'storm', text: 'Sturmfront aus Westen' } },
         type: 'historic', playableShips: ['Bismarck'], recommendedShip: 'Bismarck',
         arena: 12000, timeLimit: 14 * 60, stars: 2,
         setup(w, shipKey) {
            islands(w, [
               { c: P(-5400, -6600), r: 2700, height: 640, seed: 2301, lobes: 9, elong: 3, rot: 0.03, rough: 0.8, snow: true, name: 'Nordufer' },
               { c: P(-5400, 6600), r: 2700, height: 620, seed: 2303, lobes: 9, elong: 3, rot: -0.03, rough: 0.8, snow: true, name: 'Südufer' },
               { c: P(2400, -9000), r: 1300, height: 300, seed: 2305, lobes: 6, elong: 1.5, rot: 0.4, rough: 0.7, snow: true, name: 'Sørøya' },
            ]);
            const S = w._script, key = w.difficulty.key;
            S.exit = zone(w, 8600, 0, 2200, 'Offene See', 'goal');
            const me = add(w, shipKey, 'player', P(-10200, 0), 0, { isPlayer: true, name: 'Tirpitz', telegraph: 3 });
            me.ai.route = [P(-6000, 0), P(1000, 0), P(4500, 600), P(S.exit.x, S.exit.y)];   // only read by the autopilot (tests)
            S.escort = [['Z 29', P(-8800, -700)], ['Z 30', P(-9000, 700)]]
               .map(([name, pos]) => add(w, 'Z23', 'player', pos, 0, { name, dmgMult: 0.5, ai: { escortIdPlayer: true } }));
            // the carrier stands off the coast, off the map
            S.cv = offMap(w, add(w, 'Illustrious', 'enemy', P(9000, -10500), 0, { name: 'HMS Victorious', telegraph: 0, ai: { passive: true } }));
            S.cv.pos.x = w.arena + 2500; S.cv.pos.y = -w.arena * 0.6;
            S.cv.speed = 0;
            S.cv.air.ft.max = S.cv.air.ft.hangar = 0;
            S.cv.dmgMult = (key === 'easy' ? 0.55 : key === 'hard' ? 0.95 : 0.75);
            S.stormAt = 270;
            const waves = [[30, ['db', 'tb']], [110, ['tb', 'db']], [190, ['db', 'tb']], [255, ['tb']]];
            for (const [t, types] of waves) types.forEach((type, i) => later(S, t + i * 9, () => {
               if (strike(w, S.cv, type, w.player) && i === 0) radio(w, 'Funkmessbeobachtung', type === 'tb' ? 'Torpedoflieger im Anflug, tief über dem Wasser!' : 'Sturzkampfbomber über den Bergen – Flak frei!', 'warn');
            }));
            later(S, S.stormAt + 40, () => radio(w, 'Admiral Nordmeer', 'Der Sturm ist da – die Träger können nicht mehr starten. Jetzt durchbrechen!'));
            // the cruiser squadron waits off the mouth and closes when she comes out
            S.cruisers = [['Norfolk', 'HMS Norfolk', P(6400, -2600)], ['Fiji', 'HMS Jamaica', P(6900, 2400)]]
               .map(([cls, name, pos]) => add(w, cls, 'enemy', pos, Math.PI, { name, telegraph: 1, dmgMult: w.difficulty.botDmg * 0.75, ai: { huntId: me.id, patrol: [pos, P(pos.x + 1500, pos.y * 0.5)] } }));
            S.dds = [P(5200, -800), P(5600, 1200)].map(pos => add(w, 'Jervis', 'enemy', pos, Math.PI, { telegraph: 1, dmgMult: w.difficulty.botDmg * 0.6, ai: { patrol: [pos, P(pos.x + 1800, pos.y)] } }));
            S.screen = [...S.cruisers, ...S.dds];
            S.tick = 0; S.engaged = false; S.planes0 = 0;
            later(S, 3, () => radio(w, 'Kommandant', 'Anker auf. Äußerste Kraft voraus, Kurs Fjordmündung – die Flak bleibt besetzt.'));
            objective(w, 'escape', 'Brechen Sie in die offene See im Osten durch');
            objective(w, 'flak', 'Schießen Sie 4 Flugzeuge ab (0/4)', { optional: true });
            objective(w, 'cruisers', 'Versenken Sie beide Kreuzer', { optional: true });
            w.score = { kind: 'kills', player: 0, enemy: 0, target: 4 };
         },
         update(w, dt, S) {
            if (w.phase !== 'playing') return;
            const me = w.player;
            if (!me || !me.alive) return;
            // the screen leaves its patrol line once the Tirpitz is near the mouth (or shoots at it)
            if (!S.engaged && (me.pos.x > 0 || S.screen.some(s => s.hp < s.maxHP))) {
               S.engaged = true;
               for (const s of S.screen) if (s.alive) { s.ai.patrol = null; s.ai.huntId = me.id; s.ai.press = true; s.setTelegraph?.(4); }
               radio(w, 'Ausguck', 'Kreuzer an der Mündung, zwei Zerstörer davor – sie laufen an!', 'warn');
            }
            if (inZone(me, S.exit)) {
               setObj(w, 'escape', 'done', 'Die Tirpitz steht in der offenen See');
               w.end(true, 'Die Tirpitz ist ausgebrochen – im Sturm verliert die Home Fleet ihre Spur.');
               return;
            }
            if ((S.tick -= dt) > 0) return;
            S.tick = 1;
            const down = w.stats.planesDown || 0;
            if (down < 4) objText(w, 'flak', `Schießen Sie 4 Flugzeuge ab (${down}/4)`);
            else setObj(w, 'flak', 'done', `${down} Flugzeuge abgeschossen`);
         },
         onSink(w, ship, killer, S) {
            if (ship.side === 'enemy') w.score.player++;
            if (S.cruisers.includes(ship)) {
               if (S.cruisers.every(c => !c.alive)) setObj(w, 'cruisers', 'done', 'Beide Kreuzer versenkt');
               radio(w, 'Artillerieoffizier', ship.name + ' sinkt!');
            }
         },
         timeout(w, S) {
            setObj(w, 'escape', 'failed');
            w.end(false, 'Der Ausbruch ist gescheitert – die Home Fleet schließt das Nordmeer ab.');
         },
      },

      // ------------------------------------------------------------ op: storm escort
      // A mine has crippled a battleship; at 8 knots she limps home through a North Sea storm. The
      // player's cruiser and two destroyers are all that stand between her and the torpedo boats that
      // come out of the dark in waves, with a heavy cruiser behind them. The storm caps sight at 8 km:
      // every attack comes from close range.
      {
         id: 'sturmgeleit', group: 'ops', name: 'Geleit im Sturm', subtitle: 'Nordsee · Dezember 1942 (fiktive Operation)',
         fleet: { own: 'HMS Norfolk · HMS Valiant (beschädigt) · HMS Kelly, HMS Kashmir', foe: 'Zerstörer und Torpedoboote in drei Wellen · Admiral Hipper' },
         briefing: 'Die HMS Valiant ist vor der norwegischen Küste auf eine Mine gelaufen. Mit Schlagseite und nur acht Knoten schleppt sie sich nach Scapa Flow – mitten in einen Nordseesturm. ' +
            'Der deutsche Funkdienst hat sie gefunden: Zerstörer und Torpedoboote laufen aus, und die Admiral Hipper ist in See. Die Home Fleet ist unterwegs, braucht aber noch zehn Minuten. ' +
            'Sie führen das Geleit. Im Sturm reicht die Sicht keine acht Kilometer – jeder Angriff kommt aus nächster Nähe. Stellen Sie sich zwischen Valiant und Angreifer, zwingen Sie die Torpedoboote zum Abdrehen, bevor sie feuern. Die Valiant darf nicht sinken.',
         debrief: 'Ein erfundenes Gefecht, aber eine vertraute Lage: Beschädigte Großkampfschiffe waren das bevorzugte Ziel leichter Seestreitkräfte – die Prince of Wales vor Malaya, die Bismarck im Atlantik. ' +
            'Die echte HMS Valiant überstand den Krieg, obwohl italienische Kampfschwimmer sie im Dezember 1941 im Hafen von Alexandria mit Haftminen schwer beschädigten. ' +
            'Die Admiral Hipper traf am Silvestertag 1942 in der Barentssee im Sturm auf ein Geleit – britische Zerstörer und zwei leichte Kreuzer schlugen sie und die Lützow ab.',
         env: { time: 'dusk', weather: 'storm' }, type: 'historic', playableShips: ['Norfolk'], recommendedShip: 'Norfolk',
         arena: 12000, timeLimit: 10 * 60, stars: 2,
         setup(w, shipKey) {
            islands(w, [
               { c: P(-3400, 9800), r: 1300, height: 140, seed: 2401, lobes: 6, elong: 1.8, rot: 0.3, rough: 0.6, name: 'Fair Isle' },
               { c: P(7600, -9200), r: 1000, height: 110, seed: 2403, lobes: 5, elong: 1.6, rot: -0.5, rough: 0.6 },
            ]);
            const S = w._script, key = w.difficulty.key;
            S.bb = add(w, 'Warspite', 'player', P(-6000, 800), 0, {
               name: 'HMS Valiant', telegraph: 2, speedKn: 8, dmgMult: 0.7, hpMult: 1.4,
               ai: { route: [P(-1000, 600), P(4000, 0), P(11000, 0)], routeIdx: 0 },
            });
            S.bb.hp = S.bb.maxHP * 0.7;   // the mine
            const me = add(w, shipKey, 'player', P(-4800, 2200), 0, { isPlayer: true, name: 'HMS Norfolk', telegraph: 2 });
            me.ai.escortId = S.bb.id;   // only read by the autopilot (tests)
            S.escort = [['HMS Kelly', P(-5000, -800)], ['HMS Kashmir', P(-6900, 2200)]]
               .map(([name, pos]) => add(w, 'Jervis', 'player', pos, 0, { name, dmgMult: 0.5, ai: { escortId: S.bb.id } }));
            const k = key === 'easy' ? 0.8 : key === 'hard' ? 1.05 : 0.9;
            S.waves = [];
            const wave = (t, list, text) => later(S, t, () => {
               if (w.phase !== 'playing' || !S.bb.alive) return;
               const ships = list.map(([cls, x, y, extra]) => add(w, cls, 'enemy', P(S.bb.pos.x + x, y), Math.atan2(-y, -x), {
                  telegraph: 4, minDist: cls === 'Hipper' ? 9000 : 7000, ...(extra || {}),
                  ai: { huntId: S.bb.id, press: true, aggro: 1.3, retreatBelow: cls === 'Hipper' ? 0.4 : 0.45, ...(extra && extra.ai) },
               }));
               for (const s of ships) s.dmgMult *= k * 0.6;
               S.waves.push(...ships);
               radio(w, 'Radar HMS Norfolk', text, 'warn');
            });
            wave(45, [['Z23', 7500, -7500], ['Z23', 8200, -6800]], 'Zwei Zerstörer aus Nordost, Kurs auf die Valiant!');
            wave(190, [['Z23', -5200, -7600], ['Gnevny', -3600, -8400, { name: 'T 25', cfg: sBoat(), hpMult: 0.5 }]], 'Neue Kontakte im Westen – Torpedoboote, sie greifen von achtern an!');
            wave(330, [['Hipper', 10500, -5600, { name: 'Admiral Hipper' }]], 'Großer Schatten in Nordost – das ist die Admiral Hipper!');
            wave(470, [['Z23', 4200, 7600], ['Gnevny', 5800, 8200, { name: 'T 26', cfg: sBoat(), hpMult: 0.5 }]], 'Dritte Welle, diesmal aus Süden – alle Rohre klar!');
            S.lastWaveAt = 470;
            later(S, 4, () => radio(w, 'HMS Valiant', 'Wir machen acht Knoten, mehr gibt die Welle nicht her. Halten Sie uns die Torpedoboote vom Leib.'));
            later(S, 300, () => radio(w, 'Home Fleet', 'Duke of York und Kreuzer laufen mit Höchstfahrt – noch fünf Minuten.'));
            S.tick = 0; S.torps = 0;
            objective(w, 'valiant', 'Die Valiant muss durchhalten, bis die Home Fleet eintrifft (10:00)');
            objective(w, 'hipper', 'Versenken Sie die Admiral Hipper', { optional: true });
            objective(w, 'half', 'Die Valiant behält über 40 % Zustand', { optional: true });
            w.score = { kind: 'kills', player: 0, enemy: 0, target: 8 };
         },
         update(w, dt, S) {
            if (w.phase !== 'playing') return;
            if ((S.tick -= dt) > 0) return;
            S.tick = 1;
            const bb = S.bb;
            objText(w, 'valiant', `Die Valiant muss durchhalten, bis die Home Fleet eintrifft (${mmss(w.timeLeft)} · Zustand ${pct(bb.hp / bb.maxHP)} %)`);
            if (bb.hp / bb.maxHP < 0.4) setObj(w, 'half', 'failed');
            if (!S.lowMsg && bb.hp / bb.maxHP < 0.3) { S.lowMsg = true; radio(w, 'HMS Valiant', 'Wassereinbruch im Kesselraum, Schlagseite nimmt zu – wir halten nicht mehr lange!', 'warn'); }
            // every wave out and beaten: the attack is over before the Home Fleet arrives
            for (const s of S.waves) if (s.alive && s.ai.retreating && !s._gone) { s._gone = true; radio(w, 'Radar HMS Norfolk', s.name + ' dreht brennend ab!'); }
            if (w.time > S.lastWaveAt + 5 && S.waves.length && S.waves.every(s => !s.alive || s.ai.retreating)) this._won(w, S, 'Alle Angreifer sind versenkt oder abgedreht – die Valiant erreicht Scapa Flow.');
         },
         _won(w, S, reason) {
            setObj(w, 'valiant', 'done', 'Die Valiant ist gerettet');
            if (S.bb.hp / S.bb.maxHP >= 0.4) setObj(w, 'half', 'done');
            w.end(true, reason);
         },
         onSink(w, ship, killer, S) {
            if (ship.side === 'enemy') w.score.player++;
            if (ship.name === 'Admiral Hipper') { setObj(w, 'hipper', 'done', 'Admiral Hipper versenkt'); radio(w, 'HMS Kelly', 'Die Hipper sinkt! Hurra für die Norfolk!'); }
            if (ship === S.bb) {
               setObj(w, 'valiant', 'failed'); setObj(w, 'half', 'failed');
               w.end(false, 'Die Valiant ist gekentert – der Sturm nimmt 1.200 Mann mit in die Tiefe.');
            }
         },
         timeout(w, S) {
            if (S.bb.alive) this._won(w, S, 'Die Home Fleet ist da – die Angreifer drehen ab, die Valiant ist in Sicherheit.');
            else w.end(false, 'Die Valiant ist verloren.');
         },
      },
   ];
}
