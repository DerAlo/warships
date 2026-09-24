// game/missions.js — the campaign: mission data (map, forces, waves, objectives, stars) plus the
// endless survival generator. Pure data + small builders; the runtime lives in director.js.
//
// Mission shape (every field optional except id/title):
//   player     {cls, pos, heading}
//   obstacles  map layout (replaces config OBSTACLES)
//   env        'clear' | 'night' | 'storm' (config ENV) ; squalls: rain cells for storms
//   bots       initial enemies   [{cls, pos, heading?, tag?, path?, exit?, speedMult?, name?}]
//   allies     AI ships on the player's side (same spec)
//   waves      [{at: s} | {when: 'cleared'} | {when: 'hp', tag, below} | {when: 'sunk', tag} + bots/allies/msg,
//               heal: fraction of the missing hull patched on arrival (boss intros)]
//   mines      [{x, y}] pre-laid contact mines ; minefields [{c, r, n}] expand to mines
//   zones      map markers [{c, r, label, kind: 'exit' | 'goal'}]
//   objectives [{type: 'sinkAll' | 'sink' | 'intercept' | 'escort' | 'survive', ...}]
//   stars      [{type: 'hp', min} | {type: 'time', max} | {type: 'allOf', tag} | {type: 'stat', key, min|max}
//               | {type: 'alliesAlive'}]  -- each met criterion adds a star to the base one for winning
//   hints      [{at: s, text}] tutorial / flavour lines
import { DEG, makeRng } from './utils.js';

const isl = (x, y, r) => ({ kind: 'island', c: { x, y }, r, irregular: true });
const reef = (x, y, r) => ({ kind: 'reef', c: { x, y }, r });

// Battery on an island's shore, facing `toward` (so the approach from the sea has a clear shot).
function battery(o, toward, extra = {}) {
   const a = Math.atan2(toward.y - o.c.y, toward.x - o.c.x);
   const d = o.r - 45;   // on the shoreline, so the guns see the water and the water sees them
   return { cls: 'CB', pos: { x: o.c.x + Math.cos(a) * d, y: o.c.y + Math.sin(a) * d }, heading: a, tag: 'battery', ...extra };
}

// ---------- the campaign ----------
const FORT_A = isl(1500, -1500, 470), FORT_B = isl(2300, 900, 420), FORT_C = isl(-500, -2500, 400);

export const MISSIONS = [
   {
      id: 'm1', num: 1, title: 'Jungfernfahrt', tag: 'Einführung',
      briefing: 'Erste Feindfahrt der Bismarck. Ein kleiner Verband kreuzt vor der Küste — lerne Ruder, Salven und Munitionswahl, bevor es ernst wird.',
      player: { cls: 'Bismarck', pos: { x: -2300, y: 1300 }, heading: -0.45 },
      obstacles: [isl(-400, 1500, 380), isl(900, -900, 420), reef(-1500, -400, 300), isl(2200, 1500, 300)],
      bots: [
         { cls: 'TR', pos: { x: -500, y: 200 }, heading: 0, name: 'Zielschiff', path: [{ x: 700, y: 300 }, { x: 700, y: 900 }, { x: -800, y: 700 }, { x: -800, y: 100 }], loop: true, speedMult: 0.6 },
         { cls: 'TR', pos: { x: 100, y: -500 }, heading: Math.PI, name: 'Zielschiff', path: [{ x: -900, y: -700 }, { x: -300, y: -1300 }, { x: 400, y: -700 }], loop: true, speedMult: 0.6 },
      ],
      waves: [
         { when: 'cleared', msg: '⚠ Zwei Zerstörer laufen an — Sprenggranaten laden [2]!',
            bots: [{ cls: 'DD', pos: { x: 2600, y: -1600 } }, { cls: 'DD', pos: { x: 2900, y: -900 } }] },
         { when: 'cleared', msg: '⚠ Ein Kreuzer mit Begleitschutz — AP [1] auf seine Breitseite!',
            bots: [{ cls: 'LC', pos: { x: 2800, y: 200 } }, { cls: 'DD', pos: { x: 2400, y: -2400 } }] },
      ],
      objectives: [{ type: 'sinkAll', text: 'Alle Feindschiffe versenken' }],
      stars: [{ type: 'hp', min: 0.6 }, { type: 'time', max: 360 }],
      hints: [
         { at: 1, text: '⌨ W/S: Fahrstufe · A/D: Ruder — halte auf die Zielschiffe zu' },
         { at: 8, text: '🖱 Maus richtet die Türme, Linksklick feuert eine Salve (halten = Turm für Turm)' },
         { at: 16, text: '🎯 Führe dein Ziel: zieh den Cursor vor den Bug fahrender Schiffe' },
         { at: 26, text: '🔁 1 = AP (Panzergranaten), 2 = HE (Sprenggranaten, Brände)' },
         { at: 40, text: '🐟 T halten zeigt den Torpedofächer, loslassen feuert — nur querab' },
         { at: 60, text: '🔧 R repariert, E löscht Brände, F legt Nebel, Shift = Boost' },
      ],
   },
   {
      id: 'm2', num: 2, title: 'Konvoi-Jagd', tag: 'Abfangen',
      briefing: 'Ein feindlicher Geleitzug mit fünf Transportern versucht, nach Osten durchzubrechen. Versenke mindestens vier, bevor sie den Hafen erreichen.',
      player: { cls: 'Bismarck', pos: { x: -2700, y: 300 }, heading: -0.2 },
      obstacles: [isl(-200, 900, 420), isl(1400, -300, 360), reef(300, -1100, 300), isl(-1600, -1500, 320), reef(2400, 1300, 280)],
      zones: [{ c: { x: 3500, y: -2500 }, r: 380, label: 'FEINDHAFEN', kind: 'exit' }],
      bots: (() => {
         const exit = { x: 3500, y: -2500, r: 380 };
         const path = [{ x: 0, y: -2300 }, { x: 1800, y: -2100 }];
         const tr = (x, y) => ({ cls: 'TR', pos: { x, y }, heading: 0.05, tag: 'convoy', path, exit, speedMult: 0.72 });
         return [
            tr(-1700, -2500), tr(-2050, -2200), tr(-2350, -2550), tr(-2700, -2250), tr(-3000, -2600),
            { cls: 'DD', pos: { x: -1300, y: -2000 }, heading: 0 },
            { cls: 'DD', pos: { x: -2500, y: -1800 }, heading: 0 },
            { cls: 'LC', pos: { x: -2100, y: -2900 }, heading: 0 },
         ];
      })(),
      waves: [
         { at: 75, msg: '⚠ Ein Schwerer Kreuzer eilt dem Konvoi zu Hilfe!', bots: [{ cls: 'HC', pos: { x: 3300, y: -600 } }] },
      ],
      objectives: [{ type: 'intercept', tag: 'convoy', need: 4, text: 'Transporter versenken' }],
      stars: [{ type: 'allOf', tag: 'convoy', text: 'Alle fünf Transporter versenkt' }, { type: 'hp', min: 0.5 }],
      hints: [
         { at: 2, text: '🧭 Der Konvoi fährt im Norden nach Osten — schneide ihm den Weg ab' },
         { at: 14, text: '💡 Transporter sind ungepanzert: HE setzt sie in Brand' },
      ],
   },
   {
      id: 'm3', num: 3, title: 'Wolfsrudel', tag: 'Schwärme & U-Boote',
      briefing: 'Torpedobootschwärme und U-Boote lauern im Schärengarten. Weiche den Torpedofächern aus und jage die U-Boote mit Wasserbomben.',
      player: { cls: 'Bismarck', pos: { x: 0, y: 2100 }, heading: -Math.PI / 2 },
      obstacles: [isl(-1300, 300, 300), isl(1200, -100, 280), isl(-200, -1100, 260), isl(1900, -1900, 320),
         isl(-2200, -1600, 300), reef(400, 800, 220), reef(-700, -300, 200), reef(2400, 700, 240)],
      bots: [
         { cls: 'TB', pos: { x: -700, y: -2100 } }, { cls: 'TB', pos: { x: -400, y: -2300 } },
         { cls: 'TB', pos: { x: 500, y: -2200 } }, { cls: 'TB', pos: { x: 800, y: -2000 } },
      ],
      waves: [
         { at: 30, msg: '🎧 Hydrophon: Schraubengeräusche! U-Boote — Wasserbomben mit [C]',
            bots: [{ cls: 'SUB', pos: { x: 2800, y: 1100 } }, { cls: 'SUB', pos: { x: -2600, y: 400 } }] },
         // mission 3 of 9: the final pack is one boat lighter than it was so the curve keeps rising
         { when: 'cleared', msg: '⚠ Das ganze Rudel greift an!',
            bots: [{ cls: 'DD', pos: { x: 0, y: -3000 } }, { cls: 'TB', pos: { x: -2900, y: -1000 } },
               { cls: 'TB', pos: { x: 3000, y: -1200 } }, { cls: 'SUB', pos: { x: 0, y: -2600 } }] },
         // chapter finale: the boss steams in once the pack is gone; escorts answer its call
         { when: 'cleared', heal: 0.5, msg: '👑 BOSS: Schlachtkreuzer Hood läuft aus Norden an! (Notreparatur)',
            bots: [{ cls: 'HOOD', pos: { x: 300, y: -3100 }, heading: Math.PI / 2, tag: 'boss' }] },
         { when: 'hp', tag: 'boss', below: 0.66, msg: '⚠ Hood ruft Zerstörer zu Hilfe!',
            bots: [{ cls: 'DD', pos: { x: -2900, y: -2400 } }, { cls: 'DD', pos: { x: 3000, y: -2300 } }] },
      ],
      boss: 'HOOD',
      objectives: [{ type: 'sinkAll', text: 'Das Wolfsrudel vernichten' }, { type: 'sink', tag: 'boss', text: 'Schlachtkreuzer Hood versenken' }],
      stars: [{ type: 'hp', min: 0.5 }, { type: 'stat', key: 'torpHitsTaken', max: 2, text: 'Höchstens 2 Torpedotreffer erlitten' }],
      hints: [
         { at: 2, text: '⚠ Torpedoboote sind flink und zerbrechlich — Sekundärbatterie und HE helfen' },
         { at: 12, text: '🐟 Dreh den Bug in anlaufende Torpedofächer, dann passen sie vorbei' },
      ],
   },
   {
      id: 'm4', num: 4, title: 'Nachtgefecht', tag: 'Nacht',
      briefing: 'Mondlose Nacht. Sichtweiten sind halbiert — wer feuert, verrät sich durch sein Mündungsfeuer. Leuchtgranaten [G] erhellen das Zielgebiet.',
      env: 'night',
      player: { cls: 'Bismarck', pos: { x: -2500, y: 1700 }, heading: -0.6 },
      obstacles: [isl(-900, 300, 360), isl(600, -700, 330), isl(-300, -2000, 300), isl(1900, 700, 300), reef(-1800, -900, 260), reef(900, 1600, 260)],
      bots: [
         { cls: 'EB', pos: { x: 1900, y: -1600 } },
         { cls: 'HC', pos: { x: 1200, y: -2300 } },
         { cls: 'LC', pos: { x: 2500, y: -500 } },
         { cls: 'DD', pos: { x: 1100, y: -1150 } },
      ],
      // night halves the sighting range, so the whole squadron at once was a coin flip even on
      // normal: the second destroyer now arrives with the torpedo boats
      waves: [
         { at: 100, msg: '⚠ Torpedoboote kommen aus der Dunkelheit!', bots: [{ cls: 'TB', pos: { x: -3200, y: -1600 } }, { cls: 'TB', pos: { x: -3000, y: -2000 } }, { cls: 'DD', pos: { x: 2600, y: -2400 } }] },
      ],
      objectives: [{ type: 'sinkAll', text: 'Den Nachtverband versenken' }],
      stars: [{ type: 'hp', min: 0.5 }, { type: 'time', max: 480 }],
      hints: [
         { at: 2, text: '🌙 Nacht: Feinde sehen dich erst spät — und du sie auch' },
         { at: 10, text: '✨ G feuert eine Leuchtgranate auf den Cursor: alles im Lichtkreis ist aufgeklärt' },
         { at: 22, text: '🔥 Jede Salve verrät deine Position — feuern, dann Kurs ändern' },
      ],
   },
   {
      id: 'm5', num: 5, title: 'Küstenfestung', tag: 'Festung & Minen',
      briefing: 'Drei schwere Küstenbatterien sperren die Einfahrt. Minenleger verseuchen die Fahrrinnen. Schalte alle Batterien aus — und achte auf Minen.',
      player: { cls: 'Bismarck', pos: { x: -2900, y: 2500 }, heading: -0.7 },
      obstacles: [FORT_A, FORT_B, FORT_C, isl(-1600, -300, 280), reef(300, 300, 280), reef(-200, 1700, 240)],
      bots: [
         battery(FORT_A, { x: -800, y: 600 }),
         battery(FORT_B, { x: -600, y: 1600 }),
         battery(FORT_C, { x: -1800, y: 400 }),
         { cls: 'ML', pos: { x: 400, y: -600 }, path: [{ x: -800, y: 600 }, { x: 900, y: 1500 }, { x: 1200, y: -400 }], loop: true },
         { cls: 'ML', pos: { x: -1400, y: -1400 }, path: [{ x: -2500, y: 300 }, { x: -2100, y: -1200 }, { x: -600, y: -1100 }, { x: -2100, y: -1200 }], loop: true },
         { cls: 'DD', pos: { x: 800, y: -2000 } },
         { cls: 'DD', pos: { x: 3000, y: -300 } },
      ],
      minefields: [{ c: { x: -1100, y: 1100 }, r: 420, n: 7 }, { c: { x: 500, y: 1000 }, r: 380, n: 6 }, { c: { x: -900, y: -500 }, r: 380, n: 6 }],
      waves: [
         { at: 110, msg: '⚠ Ein Kreuzer läuft aus dem Hafen aus!', bots: [{ cls: 'LC', pos: { x: 3200, y: -2600 } }, { cls: 'DD', pos: { x: 3400, y: -2200 } }] },
      ],
      objectives: [{ type: 'sink', tag: 'battery', text: 'Küstenbatterien zerstören' }],
      stars: [{ type: 'hp', min: 0.5 }, { type: 'stat', key: 'mineHits', max: 0, text: 'Keinen Minentreffer erlitten' }],
      hints: [
         { at: 2, text: '🏰 Batterien schießen weit und hart — nähere dich im Zickzack' },
         { at: 12, text: '💣 Minen tauchen erst auf kurze Distanz auf (roter Ring). Die Sekundärbatterie räumt sichtbare Minen' },
      ],
   },
   {
      id: 'm6', num: 6, title: 'Trägerangriff', tag: 'Luftangriff',
      briefing: 'Ein Flugzeugträger schickt Welle um Welle Torpedo- und Sturzkampfbomber. Deine Flak ist die Verteidigung — finde und versenke den Träger.',
      player: { cls: 'Bismarck', pos: { x: -2800, y: 2700 }, heading: -0.78 },
      obstacles: [isl(-900, 900, 380), isl(900, -300, 420), isl(-1800, -1400, 320), reef(1700, 1500, 300), isl(2300, -2000, 280)],
      bots: [
         { cls: 'CV', pos: { x: 3000, y: -3000 }, heading: Math.PI * 0.75, tag: 'carrier' },
         { cls: 'HC', pos: { x: 2500, y: -2400 } },
         { cls: 'LC', pos: { x: 3100, y: -2200 } },
         { cls: 'DD', pos: { x: 1600, y: -1300 } },
         { cls: 'DD', pos: { x: 2200, y: -700 } },
      ],
      waves: [
         { when: 'sunk', tag: 'carrier', heal: 0.6, msg: '👑 BOSS: Schlachtschiff Rodney rächt den Träger! (Notreparatur)',
            bots: [{ cls: 'RODNEY', pos: { x: 3300, y: -900 }, heading: Math.PI * 0.85, tag: 'boss' }] },
         { when: 'hp', tag: 'boss', below: 0.6, msg: '⚠ Rodney ruft Kreuzer zu Hilfe!',
            bots: [{ cls: 'LC', pos: { x: 3300, y: 1200 } }, { cls: 'LC', pos: { x: 1200, y: -3300 } }] },
      ],
      boss: 'RODNEY',
      objectives: [{ type: 'sink', tag: 'carrier', text: 'Flugzeugträger versenken' }, { type: 'sink', tag: 'boss', text: 'Schlachtschiff Rodney versenken' }],
      stars: [{ type: 'hp', min: 0.5 }, { type: 'stat', key: 'planesDown', min: 10, text: 'Mindestens 10 Flugzeuge abgeschossen' }],
      hints: [
         { at: 2, text: '✈ Die Flak feuert automatisch — Flugzeuge in Reichweite werden abgeschossen' },
         { at: 14, text: '🐟 Torpedobomber werfen quer ab: dreh ihnen Bug oder Heck zu' },
         { at: 26, text: '🎯 Sturzkampfbomber zielen auf deine Position — Kurswechsel im letzten Moment!' },
      ],
   },
   {
      id: 'm7', num: 7, title: 'Sturmfront', tag: 'Schwere See',
      briefing: 'Orkanböen und hohe Wellen: Die Streuung aller Geschütze ist groß, Regenwände verschlucken ganze Schiffe. Kämpfe dich durch den feindlichen Verband.',
      env: 'storm',
      player: { cls: 'Bismarck', pos: { x: -2700, y: -700 }, heading: 0.2 },
      obstacles: [reef(-1000, 300, 340), reef(600, -1200, 320), reef(900, 1300, 300), isl(-300, -2300, 300), isl(2300, 200, 280), reef(-2000, 1900, 300)],
      squalls: 6,
      bots: [
         { cls: 'EB', pos: { x: 2200, y: 700 } },
         { cls: 'LC', pos: { x: 1800, y: -900 } },
         { cls: 'LC', pos: { x: 2700, y: 1800 } },
         { cls: 'DD', pos: { x: 1200, y: 100 } },
         { cls: 'DD', pos: { x: 2000, y: -2100 } },
      ],
      waves: [
         { at: 120, msg: '⚠ Torpedoboote nutzen den Sturm für einen Angriff!', bots: [{ cls: 'TB', pos: { x: -600, y: 3200 } }, { cls: 'TB', pos: { x: -200, y: 3300 } }, { cls: 'DD', pos: { x: 200, y: 3200 } }] },
      ],
      objectives: [{ type: 'sinkAll', text: 'Den Verband im Sturm versenken' }],
      stars: [{ type: 'hp', min: 0.5 }, { type: 'time', max: 540 }],
      hints: [
         { at: 2, text: '🌊 Schwere See: große Streuung — näher ran oder mit HE auf Treffer setzen' },
         { at: 12, text: '🌧 In Regenböen bist du (und der Feind) unsichtbar — nutze sie als Deckung' },
      ],
   },
   {
      id: 'm8', num: 8, title: 'Geleitschutz', tag: 'Eskorte',
      briefing: 'Vier eigene Transporter müssen den Sammelpunkt im Nordosten erreichen. Ein Zerstörer und ein Kreuzer helfen dir. Mindestens zwei Transporter müssen durchkommen.',
      player: { cls: 'Bismarck', pos: { x: -2650, y: 2350 }, heading: -0.8 },
      obstacles: [isl(-1500, 700, 360), isl(300, -200, 380), isl(1700, -1700, 300), reef(-400, 1600, 280), isl(1300, 1500, 320), reef(-800, -1800, 300)],
      zones: [{ c: { x: 3300, y: -3100 }, r: 400, label: 'SAMMELPUNKT', kind: 'goal' }],
      allies: (() => {
         const exit = { x: 3300, y: -3100, r: 400 };
         // threads the gap between the three central islands instead of running over them
         const path = [{ x: -1600, y: 1800 }, { x: -300, y: 700 }, { x: 800, y: 450 }, { x: 1250, y: -700 }, { x: 2400, y: -1300 }];
         const tr = (x, y, n) => ({ cls: 'TR', pos: { x, y }, heading: -0.8, tag: 'escort', path, exit, speedMult: 0.95, hpMult: 2.8, name: 'Frachter ' + n });
         return [
            tr(-2350, 2500, 'Anna'), tr(-2650, 2800, 'Berta'), tr(-2800, 2300, 'Clara'), tr(-3050, 2650, 'Dora'),
            { cls: 'DD', pos: { x: -2400, y: 2800 }, heading: -0.8, name: 'Z 23', asw: true },
            { cls: 'LC', pos: { x: -2900, y: 2000 }, heading: -0.8, name: 'Emden' },
         ];
      })(),
      bots: [
         { cls: 'TB', pos: { x: -2600, y: -500 } }, { cls: 'TB', pos: { x: -1900, y: -600 } },
      ],
      waves: [
         { at: 50, msg: '🎧 U-Boot auf der Route voraus — Z 23 und deine Wasserbomben [C]!', bots: [{ cls: 'SUB', pos: { x: 1200, y: 200 } }, { cls: 'TB', pos: { x: 2700, y: 1700 } }] },
         { at: 115, msg: '⚠ Feindlicher Kreuzerverband aus Osten!', bots: [{ cls: 'HC', pos: { x: 3400, y: 2300 } }, { cls: 'DD', pos: { x: 3000, y: 2700 } }] },
         { at: 140, msg: '⚠ Torpedoboote greifen den Geleitzug an!', bots: [{ cls: 'TB', pos: { x: 3300, y: -1800 } }, { cls: 'TB', pos: { x: 3100, y: -2200 } }] },
      ],
      objectives: [{ type: 'escort', tag: 'escort', need: 2, text: 'Transporter zum Sammelpunkt geleiten' }],
      stars: [{ type: 'allOf', tag: 'escort', text: 'Alle vier Transporter gerettet' }, { type: 'hp', min: 0.4 }],
      hints: [
         { at: 2, text: '🛡 Bleib nah am Geleitzug — die Feinde haben es auf die Frachter abgesehen' },
         { at: 16, text: '🔫 Rechtsklick konzentriert die Sekundärbatterie auf einen Angreifer' },
      ],
   },
   {
      id: 'm9', num: 9, title: 'Endkampf', tag: 'Boss',
      briefing: 'Das Großkampfschiff „Leviathan" führt die gesamte feindliche Flotte. Sein Sperrfeuer wird angekündigt — verlasse die roten Zielkreise. Versenke das Flaggschiff.',
      player: { cls: 'Bismarck', pos: { x: -2500, y: 2100 }, heading: -0.7 },
      obstacles: [isl(-900, 600, 380), isl(700, -300, 340), isl(-300, -1700, 300), isl(1900, 1100, 320), reef(-1900, -600, 280), reef(2300, -1900, 280)],
      allies: [
         { cls: 'HC', pos: { x: -2900, y: 2500 }, heading: -0.7, name: 'Prinz Eugen', tag: 'friend' },
         { cls: 'DD', pos: { x: -2100, y: 2600 }, heading: -0.7, name: 'Z 24', tag: 'friend', asw: true },
      ],
      bots: [
         { cls: 'BOSS', pos: { x: 1900, y: -1600 }, tag: 'boss' },
         { cls: 'HC', pos: { x: 1300, y: -2300 } },
         { cls: 'DD', pos: { x: 400, y: -2200 } },
         { cls: 'DD', pos: { x: 2900, y: 0 } },
      ],
      waves: [
         { when: 'hp', tag: 'boss', below: 0.75, msg: '⚠ Zwei Kreuzer eilen dem Leviathan zu Hilfe!', bots: [{ cls: 'LC', pos: { x: 3300, y: -600 } }, { cls: 'LC', pos: { x: 2600, y: -3200 } }] },
         { when: 'hp', tag: 'boss', below: 0.4, msg: '⚠ Leviathan ruft Verstärkung — Torpedoboote!', bots: [{ cls: 'TB', pos: { x: 3300, y: -3000 } }, { cls: 'TB', pos: { x: 3500, y: -2600 } }, { cls: 'TB', pos: { x: 3000, y: -3300 } }] },
      ],
      boss: 'BOSS',
      objectives: [{ type: 'sink', tag: 'boss', text: 'Leviathan versenken' }],
      stars: [{ type: 'hp', min: 0.4 }, { type: 'alliesAlive', text: 'Beide Begleitschiffe überleben' }],
      hints: [
         { at: 2, text: '👑 Der Leviathan ist schwer gepanzert — AP nur auf die Breitseite, sonst HE und Torpedos' },
         { at: 14, text: '🎯 Rote Kreise = angekündigtes Sperrfeuer. Raus da, bevor die Granaten einschlagen!' },
      ],
   },
];

// Three chapters of three missions; the last mission of each ends in a boss battle whose win
// earns a medal (progress.js) that toughens the Bismarck's hull for the rest of the campaign.
export const CHAPTERS = [
   { num: 1, title: 'Nordmeer', missions: ['m1', 'm2', 'm3'], medal: 'Bronzener Anker' },
   { num: 2, title: 'Atlantik', missions: ['m4', 'm5', 'm6'], medal: 'Silberner Anker' },
   { num: 3, title: 'Letzte Fahrt', missions: ['m7', 'm8', 'm9'], medal: 'Goldener Anker' },
];
export function chapterOf(id) { return CHAPTERS.find(c => c.missions.includes(id)) || null; }
export const MEDAL_HULL = 0.05;   // +5 % hull per medal in campaign missions

// ---------- survival ----------
// Endless escalating waves around a mid-sized archipelago. A wave is bought from a point budget
// that grows every round; heavier classes unlock as the waves climb.
export const SURVIVAL = {
   id: 'survival', num: 0, title: 'Überleben', tag: 'Endlos',
   briefing: 'Endlose, immer stärkere Angriffswellen. Zwischen den Wellen wird ein Teil des Rumpfes repariert. Wie lange hält die Bismarck durch?',
   player: { cls: 'Bismarck', pos: { x: 0, y: 0 }, heading: -Math.PI / 2 },
   obstacles: [isl(-1400, -900, 340), isl(1300, -1100, 300), isl(-1100, 1400, 300), isl(1500, 1200, 360), reef(0, -2000, 280), reef(2300, 0, 260), reef(-2300, 200, 260), reef(0, 2200, 260)],
   survival: true,
   bots: [],
   objectives: [{ type: 'survival', text: 'Überleben' }],
   stars: [],
};

// point cost per class and the wave from which it may appear
export const SURV_POOL = [
   { cls: 'TB', cost: 1, from: 1 }, { cls: 'DD', cost: 2, from: 1 }, { cls: 'LC', cost: 3, from: 2 },
   { cls: 'SUB', cost: 3, from: 3 }, { cls: 'ML', cost: 2, from: 4 }, { cls: 'HC', cost: 4, from: 4 },
   { cls: 'EB', cost: 6, from: 5 }, { cls: 'CV', cost: 7, from: 7 },
];
export const SURV_POINTS = { TB: 60, DD: 120, LC: 180, SUB: 200, ML: 100, HC: 260, EB: 400, CV: 450, BOSS: 1500, HOOD: 1000, RODNEY: 1200, TR: 40 };

// Composition of survival wave n (1-based), spawned on a ring around `center`.
// `obstacles` lets other generators (daily.js) reuse the budget/spawn logic on their own map.
export function survivalWave(n, center, seed = n * 7919, obstacles = SURVIVAL.obstacles, pool = SURV_POOL) {
   const rng = makeRng(seed);
   const out = [];
   if (n % 10 === 0) out.push({ cls: 'BOSS', tag: 'boss' });
   let budget = Math.round(3 + n * 2.3);
   pool = pool.filter(p => p.from <= n);
   let guard = 0;
   while (budget > 0 && guard++ < 40) {
      const fits = pool.filter(p => p.cost <= budget);
      if (!fits.length) break;
      // bias toward pricier ships as the waves climb so later waves are not just TB carpets
      const p = fits[Math.min(fits.length - 1, Math.floor(Math.pow(rng(), 1 / (1 + n * 0.12)) * fits.length))];
      out.push({ cls: p.cls });
      budget -= p.cost;
   }
   // spread the wave across 1-3 attack directions
   const dirs = 1 + Math.min(2, Math.floor(n / 3));
   const base = rng() * Math.PI * 2;
   return out.map((spec, i) => {
      const a = base + (i % dirs) * (Math.PI * 2 / dirs) + (rng() - 0.5) * 30 * DEG;
      const r = 2500 + rng() * 500;
      const lim = 3500;
      const pos = { x: Math.max(-lim, Math.min(lim, center.x + Math.cos(a) * r)), y: Math.max(-lim, Math.min(lim, center.y + Math.sin(a) * r)) };
      // never spawn on (or hugging) an island or reef: push the spot out past the shoreline
      for (const o of obstacles) {
         const dx = pos.x - o.c.x, dy = pos.y - o.c.y, dd = Math.hypot(dx, dy) || 1, need = o.r + 220;
         if (dd < need) { pos.x = o.c.x + dx / dd * need; pos.y = o.c.y + dy / dd * need; }
      }
      return { ...spec, pos };
   });
}

export function missionById(id) {
   if (id === SURVIVAL.id) return SURVIVAL;
   return MISSIONS.find(m => m.id === id) || null;
}
export function nextMission(id) {
   const i = MISSIONS.findIndex(m => m.id === id);
   return i >= 0 && i < MISSIONS.length - 1 ? MISSIONS[i + 1] : null;
}
