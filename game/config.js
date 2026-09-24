// game/config.js — the single source of truth for numbers.
// Units: meters, radians, m/s, seconds. World: X+ = east, Y+ = south, angle 0 = +x (east), CCW positive.
import { TAU, DEG } from './utils.js';

// ============ WORLD ============
export const WORLD = {
   ARENA: 3800,                 // half-extent; coords in [-3800, 3800]. Tight enough that a
                                // fleeing ship can't cross the map and stall the match forever.
   SHELL_SPEED_MAIN: 650,       // m/s
   SHELL_SPEED_SEC: 600,
   TORP_SPEED: 40,              // m/s
   TORP_RANGE: 1000,           // fizzes past this
   MIN_THROTTLE: 0.35,        // ships keep "way"; turns stay readable
   REPAIR_RATE: 0.03,          // HP fraction/s when out of danger
   SMOKE_RADIUS: 400,
   SMOKE_DURATION: 8,          // default emission time when a class doesn't configure one
   SMOKE_LIFE: 22,             // s a laid cloud stays opaque -- long enough to actually fight from
   DETECT_CONE: 40 * DEG,      // gun must roughly face target to fire
   THREAT_RANGE: 500,          // enemy shell within => "under fire"
   LOW_HP: 0.40,              // -> retreat
   CRIT_HP: 0.18,            // -> forced retreat / smoke
   REEF_SPEED_CAP: 0.5,       // shallow water hard-caps speed to this fraction of max
   SIM_DT: 1 / 60,
};

// ============ SHIP CLASSES ============
// Every class is one mover + a weapons loadout. Player (Bismarck) is beefier than the enemy BB.
// turretSlew (rad/s) = how fast turrets rotate to track the aim point. Speeds are deliberately
// arcade-high with unchanged turn rates, which is what makes the anchor turn (Space) matter.
//
// Per-class data is the single hook for new ship types (torpedo boats, subs, carriers, coastal
// batteries...):
//   L / beam   hull footprint (m) -> hit boxes, citadel band, proximity spotting, rendering
//   turrets    [{x, guns}] along the keel; x > 0 trains from the bow, x < 0 from the stern,
//              each can swing HANDLING.turretArc either side of that home direction
//   main.ammo  optional {AP:{...}, HE:{...}} shell types; without it `main` is the only shell
//   torp       optional; `launchers` = side mounts with firing arcs (deg, + = starboard),
//              without them a centreline mount that can fire in any direction
//   cons       consumables {repair, dc, smoke, boost} with charges / dur / cd
//   ai         behaviour profile read by ai.js (role, leash, smoke use, hidden-target tactics)
//   detect     concealment (m): enemies inside this radius spot the ship (WoWs model); smoke
//              hides it anyway unless they are inside its proximity radius
//   sight      optional cap on the ship's own spotting range; stealth optional detect multiplier
export const SHIPS = {
   DD: {
      key: 'DD', name: 'Zerstörer', color: '#6f8a9c', L: 120, beam: 13,
      hp: 975, maxSpeed: 141, turnRate: 0.36, turretSlew: 1.2, detect: 1450, prefRange: 550, flankDeg: 60, armor: 70,
      main: { guns: 2, caliber: 105, dmg: 70, reload: 1.8, range: 850, type: 'HE', ap: 0, vShell: 600, fire: 0.06 },
      turrets: [ { x: 36, guns: 1 }, { x: -36, guns: 1 } ],
      // a launch every ~25 s with a 3-fish fan: a real threat, but one a moving target can dodge
      torp: { tubes: 3, dmg: 900, speed: 200, range: 1150, salvo: 3, cd: 25, spread: 4 * DEG },
      cons: { smoke: { charges: 2, dur: 8, cd: 30 }, dc: { charges: 2, dur: 5, cd: 40 } },
      aa: { guns: 4, dps: 70, vsShip: 0, range: 700, reload: 0.2 },
      ai: { role: 'torpedo', commitTime: 130, smokeChance: 0.5, smokeHP: 0.75, huntHidden: true, torpSmoke: true },
   },
   LC: {
      key: 'LC', name: 'Kleinkreuzer', color: '#5f7f9a', L: 170, beam: 18,
      hp: 2250, maxSpeed: 108, turnRate: 0.27, turretSlew: 0.95, detect: 1900, prefRange: 900, flankDeg: 55, armor: 120,
      main: { guns: 6, caliber: 152, dmg: 95, reload: 3.1, range: 1200, type: 'HE', ap: 140, vShell: 620,
         ammo: { AP: { type: 'AP', dmg: 95, ap: 140, fire: 0 }, HE: { type: 'HE', dmg: 70, ap: 0, fire: 0.08 } } },
      turrets: [ { x: 50, guns: 2 }, { x: 32, guns: 2 }, { x: -48, guns: 2 } ],
      torp: null,
      cons: { smoke: { charges: 1, dur: 8, cd: 40 }, dc: { charges: 2, dur: 5, cd: 40 } },
      aa: { guns: 8, dps: 110, vsShip: 0, range: 800, reload: 0.2 },
      ai: { role: 'cruiser', commitTime: 150, smokeChance: 0.25, smokeHP: 0.6, smokeFire: true, reposition: true },
   },
   HC: {
      key: 'HC', name: 'Schwerkreuzer', color: '#4d6b86', L: 205, beam: 22,
      hp: 3600, maxSpeed: 90, turnRate: 0.23, turretSlew: 0.75, detect: 2150, prefRange: 1150, flankDeg: 55, armor: 150,
      main: { guns: 10, caliber: 203, dmg: 140, reload: 4.4, range: 1400, type: 'AP', ap: 200, vShell: 640,
         ammo: { AP: { type: 'AP', dmg: 140, ap: 200, fire: 0 }, HE: { type: 'HE', dmg: 95, ap: 0, fire: 0.10 } } },
      turrets: [ { x: 64, guns: 2 }, { x: 44, guns: 2 }, { x: -38, guns: 2 }, { x: -56, guns: 2 }, { x: -76, guns: 2 } ],
      torp: null,
      cons: { dc: { charges: 2, dur: 5, cd: 40 } },
      aa: { guns: 10, dps: 120, vsShip: 0, range: 850, reload: 0.2 },
      ai: { role: 'cruiser', commitTime: 170, reposition: true },
   },
   EB: {
      key: 'EB', name: 'Feindes Linienschiff', color: '#8a5a4a', L: 251, beam: 36,
      hp: 5700, maxSpeed: 75, turnRate: 0.18, turretSlew: 0.58, detect: 2500, prefRange: 1450, flankDeg: 45, armor: 240,
      main: { guns: 6, caliber: 356, dmg: 290, reload: 5.4, range: 1650, type: 'AP', ap: 300, vShell: 650 },
      turrets: [ { x: 66, guns: 3 }, { x: -66, guns: 3 } ],
      torp: null,
      cons: { dc: { charges: 3, dur: 6, cd: 40 } },
      reactionMult: 1.2, // heavier = slower to commit
      ai: { role: 'battleship', commitTime: 200, holdThrottle: 0.55 },
   },
   // ---- campaign classes (missions.js) ----
   // Torpedo boat: tiny, very fast, paper-thin. Comes in swarms; the danger is the combined fans.
   TB: {
      key: 'TB', name: 'Torpedoboot', color: '#72848e', L: 50, beam: 7, draw: 'tb',
      hp: 380, maxSpeed: 178, turnRate: 0.55, turretSlew: 2.2, detect: 950, prefRange: 650, flankDeg: 70, armor: 12,
      main: { guns: 1, caliber: 40, dmg: 16, reload: 0.9, range: 650, type: 'HE', ap: 0, vShell: 560, fire: 0.02 },
      turrets: [ { x: 12, guns: 1 } ],
      torp: { tubes: 2, dmg: 650, speed: 190, range: 1000, salvo: 2, cd: 20, spread: 5 * DEG },
      ai: { role: 'torpedo', swarm: true, commitTime: 90, huntHidden: true },
   },
   // Submarine: deep = invisible and immune; periscope depth = revealed only up close and only
   // secondaries/depth charges reach it; surfaced = an ordinary (fragile) target. `air` forces it up.
   SUB: {
      key: 'SUB', name: 'U-Boot', color: '#46565a', L: 72, beam: 7, draw: 'sub',
      hp: 950, maxSpeed: 78, turnRate: 0.32, turretSlew: 1.4, detect: 1000, prefRange: 1100, flankDeg: 60, armor: 20,
      main: { guns: 1, caliber: 88, dmg: 40, reload: 2.5, range: 700, type: 'HE', ap: 0, vShell: 600, fire: 0.04 },
      turrets: [ { x: 14, guns: 1 } ],
      torp: { tubes: 3, dmg: 700, speed: 150, range: 1500, salvo: 3, cd: 36, spread: 4.5 * DEG },
      sub: { diveTime: 2.6, deepSpeed: 0.55, air: 55, recharge: 7, reveal: 560 },
      ai: { role: 'sub', commitTime: 1e9 }, noRepair: true,
   },
   // Transport: slow, unarmoured, one pop-gun. Mission cargo (convoy hunt / escort).
   TR: {
      key: 'TR', name: 'Transporter', color: '#6b6250', L: 150, beam: 21, draw: 'tr',
      hp: 1900, maxSpeed: 58, turnRate: 0.16, turretSlew: 0.8, detect: 2100, prefRange: 0, flankDeg: 0, armor: 25,
      main: { guns: 1, caliber: 76, dmg: 22, reload: 2.2, range: 750, type: 'HE', ap: 0, vShell: 580, fire: 0.03 },
      turrets: [ { x: -58, guns: 1 } ],
      torp: null,
      ai: { role: 'transport', commitTime: 1e9 }, noRepair: true,
   },
   // Carrier: weak guns, keeps its distance and sends torpedo / dive-bomber squadrons (air.js).
   CV: {
      key: 'CV', name: 'Flugzeugträger', color: '#596068', L: 236, beam: 32, draw: 'cv',
      hp: 5200, maxSpeed: 72, turnRate: 0.17, turretSlew: 0.9, detect: 2300, prefRange: 2800, flankDeg: 0, armor: 150,
      main: { guns: 4, caliber: 127, dmg: 55, reload: 3.0, range: 1000, type: 'HE', ap: 0, vShell: 620, fire: 0.06 },
      turrets: [ { x: 92, guns: 2 }, { x: -92, guns: 2 } ],
      torp: null,
      aa: { guns: 12, dps: 0, vsShip: 0, range: 600, reload: 0.3 },
      air: { hangar: 28, squad: 4, launchEvery: 30, first: 9 },
      cons: { dc: { charges: 3, dur: 6, cd: 40 } },
      ai: { role: 'carrier', commitTime: 1e9, noRetreat: true },
   },
   // Coastal battery: static fort on an island. Long range, slow heavy guns, full traverse.
   CB: {
      key: 'CB', name: 'Küstenbatterie', color: '#6d6a60', L: 66, beam: 44, draw: 'cb', static: true,
      hp: 3600, maxSpeed: 0, turnRate: 0, turretSlew: 0.4, detect: 2700, sight: 3000, prefRange: 0, flankDeg: 0, armor: 160,
      turretArc: Math.PI,
      main: { guns: 4, caliber: 305, dmg: 250, reload: 9.5, range: 2300, type: 'AP', ap: 300, vShell: 620 },
      turrets: [ { x: 16, guns: 2 }, { x: -16, guns: 2 } ],
      torp: null,
      ai: { role: 'static', commitTime: 1e9, noRetreat: true }, noRepair: true,
   },
   // Minelayer: lays a trail of contact mines and runs -- chasing it means sailing into them.
   ML: {
      key: 'ML', name: 'Minenleger', color: '#667a6c', L: 96, beam: 12, draw: 'ml',
      hp: 1150, maxSpeed: 112, turnRate: 0.34, turretSlew: 1.2, detect: 1300, prefRange: 0, flankDeg: 0, armor: 30,
      main: { guns: 1, caliber: 88, dmg: 38, reload: 2.2, range: 800, type: 'HE', ap: 0, vShell: 600, fire: 0.04 },
      turrets: [ { x: 32, guns: 1 } ],
      torp: null,
      mines: { every: 3.2, max: 16 },
      cons: { smoke: { charges: 1, dur: 8, cd: 40 } },
      ai: { role: 'minelayer', commitTime: 1e9, noRetreat: true },
   },
   // Boss: the super-battleship. Three triple turrets, secondaries, and a telegraphed barrage
   // (red target rings, then heavy shells land there -- get out of them).
   BOSS: {
      key: 'BOSS', name: 'Leviathan', color: '#5d3b36', L: 330, beam: 48, draw: 'boss',
      hp: 16000, maxSpeed: 64, turnRate: 0.13, turretSlew: 0.45, detect: 2900, prefRange: 1500, flankDeg: 40, armor: 255,
      main: { guns: 9, caliber: 460, dmg: 270, reload: 9, range: 2100, type: 'AP', ap: 330, vShell: 660 },
      turrets: [ { x: 108, guns: 3 }, { x: 76, guns: 3 }, { x: -100, guns: 3 } ],
      sec: { guns: 12, caliber: 150, dmg: 45, reload: 1.8, range: 1100, type: 'HE', ap: 0, vShell: 600, fire: 0.04, burst: 4 },
      torp: null,
      barrage: { every: 28, everyP2: 19, count: 5, countP2: 7, radius: 160, delay: 4.2, dmg: 950, spread: 360 },
      // attack phases (boss.js): each entry becomes active once hull drops below `below`
      bossPhases: [
         { below: 1, name: 'Sperrfeuer', barrage: true },
         { below: 0.66, name: 'Torpedofächer', msg: 'fächert Torpedos — Bug in die roten Bahnen drehen!', barrage: true, fan: true },
         { below: 0.33, name: 'Raserei', msg: 'legt Nebel und eröffnet Schnellfeuer!', barrage: true, smoke: true, rapid: true },
      ],
      fan: { every: 24, n: 7, spread: 56 * DEG, warn: 2.8, dmg: 900, speed: 150, range: 1800 },
      rapid: { every: 26, dur: 9, mult: 0.5, warn: 2.4 },
      cons: { dc: { charges: 5, dur: 6, cd: 35 }, smoke: { charges: 2, dur: 10, cd: 50 } },
      reactionMult: 1.1,
      ai: { role: 'battleship', commitTime: 1e9, holdThrottle: 0.5, noRetreat: true, boss: true }, noRepair: true,
   },
   // Chapter I boss: the fast battlecruiser. Long, lean hull with two funnels and four twin turrets.
   HOOD: {
      key: 'HOOD', name: 'Schlachtkreuzer Hood', color: '#5a4038', L: 300, beam: 34, draw: 'boss', bossStyle: 'hood',
      hp: 9000, maxSpeed: 84, turnRate: 0.16, turretSlew: 0.55, detect: 2700, prefRange: 1400, flankDeg: 45, armor: 200,
      main: { guns: 8, caliber: 381, dmg: 230, reload: 8, range: 1900, type: 'AP', ap: 300, vShell: 650 },
      turrets: [ { x: 96, guns: 2 }, { x: 70, guns: 2 }, { x: -78, guns: 2 }, { x: -102, guns: 2 } ],
      sec: { guns: 8, caliber: 140, dmg: 38, reload: 2.0, range: 1000, type: 'HE', ap: 0, vShell: 600, fire: 0.04, burst: 4 },
      torp: null,
      barrage: { every: 30, everyP2: 26, count: 3, countP2: 4, radius: 150, delay: 4.4, dmg: 800, spread: 300 },
      bossPhases: [
         { below: 1, name: 'Gefechtsfahrt', barrage: true },
         { below: 0.66, name: 'Torpedofächer', msg: 'dreht zum Torpedoangriff — Bug in die roten Bahnen drehen!', fan: true },
         { below: 0.33, name: 'Nebel & Schnellfeuer', msg: 'legt Nebel, setzt sich ab und eröffnet Schnellfeuer!', smoke: true, rapid: true, barrage: true },
      ],
      fan: { every: 22, n: 5, spread: 44 * DEG, warn: 3.0, dmg: 750, speed: 145, range: 1700 },
      rapid: { every: 28, dur: 8, mult: 0.5, warn: 2.6 },
      cons: { dc: { charges: 3, dur: 6, cd: 35 }, smoke: { charges: 2, dur: 10, cd: 50 } },
      ai: { role: 'battleship', commitTime: 1e9, holdThrottle: 0.6, noRetreat: true, boss: true }, noRepair: true,
   },
   // Chapter II boss: all three triple turrets forward of the bridge -- the unmistakable silhouette.
   RODNEY: {
      key: 'RODNEY', name: 'Schlachtschiff Rodney', color: '#54403a', L: 300, beam: 46, draw: 'boss', bossStyle: 'rodney',
      hp: 10000, maxSpeed: 62, turnRate: 0.13, turretSlew: 0.5, detect: 2800, prefRange: 1500, flankDeg: 35, armor: 240,
      main: { guns: 9, caliber: 406, dmg: 205, reload: 9.5, range: 2000, type: 'AP', ap: 320, vShell: 640 },
      turrets: [ { x: 112, guns: 3 }, { x: 80, guns: 3 }, { x: 44, guns: 3 } ],
      turretArc: 150 * DEG,
      sec: { guns: 12, caliber: 152, dmg: 42, reload: 1.9, range: 1050, type: 'HE', ap: 0, vShell: 600, fire: 0.04, burst: 4 },
      torp: null,
      barrage: { every: 30, everyP2: 24, count: 3, countP2: 5, radius: 150, delay: 4.4, dmg: 720, spread: 340 },
      bossPhases: [
         { below: 1, name: 'Sperrfeuer', barrage: true },
         { below: 0.6, name: 'Schnellfeuer', msg: 'lädt im Schnellfeuer — Deckung hinter den Inseln suchen!', barrage: true, rapid: true },
         { below: 0.3, name: 'Nebel & Torpedos', msg: 'verschwindet im Nebel und fächert Torpedos!', smoke: true, fan: true, barrage: true },
      ],
      fan: { every: 22, n: 6, spread: 50 * DEG, warn: 2.8, dmg: 850, speed: 145, range: 1700 },
      rapid: { every: 26, dur: 9, mult: 0.5, warn: 2.4 },
      cons: { dc: { charges: 4, dur: 6, cd: 35 }, smoke: { charges: 2, dur: 10, cd: 50 } },
      ai: { role: 'battleship', commitTime: 1e9, holdThrottle: 0.5, noRetreat: true, boss: true }, noRepair: true,
   },
   Bismarck: {
      key: 'Bismarck', name: 'Bismarck', color: '#3a4a55', L: 251, beam: 36,
      hp: 7800, maxSpeed: 90, turnRate: 0.21, turretSlew: 0.62, detect: 2400, prefRange: 0, flankDeg: 0, armor: 285,
      // Two shell types. AP: citadels on broadside targets, ricochets off angled ones,
      // over-pens thin hulls. HE: lower but reliable damage + fires -- the answer to destroyers
      // and bow-on battleships. Switching (1/2) costs `switchTime` of reload on loaded turrets.
      main: { guns: 8, caliber: 283, reload: 4.8, range: 1800, vShell: 650, switchTime: 2.0,
         dmg: 300, type: 'AP', ap: 280,
         ammo: {
            AP: { type: 'AP', dmg: 300, ap: 280, fire: 0 },
            HE: { type: 'HE', dmg: 175, ap: 0, fire: 0.14 },
         } },
      turrets: [ { x: 78, guns: 2 }, { x: 56, guns: 2 }, { x: -52, guns: 2 }, { x: -74, guns: 2 } ],
      sec:  { guns: 16, caliber: 105, dmg: 40, reload: 1.3, range: 1100, type: 'HE', ap: 0, vShell: 600, fire: 0.03, burst: 4 },
      aa:   { guns: 20, dps: 190, vsShip: 10, range: 950, reload: 0.15 },
      // hydrophone: submerged submarines inside this range show up as ping contacts (render.js)
      sonar: { range: 1150, every: 4 },
      // Port + starboard launchers with independent reloads. A launcher only fires into its own
      // beam arc, so a torpedo attack means presenting a side to the target.
      torp: { tubes: 3, dmg: 1900, speed: 192, range: 1350, salvo: 3, cd: 30,
         launchers: [
            { id: 'port', label: 'BB', side: -1, arcMin: -155, arcMax: -25 },
            { id: 'stbd', label: 'StB', side: 1, arcMin: 25, arcMax: 155 },
         ] },
      // charges (Infinity = unlimited); cd starts once the active phase ends
      cons: {
         repair: { charges: 4, dur: 16, cd: 45, rate: 0.009 }, // heals from the restorable pool
         dc:     { charges: Infinity, dur: 8, cd: 35 },         // extinguish/pump out + immunity
         smoke:  { charges: 3, dur: 8, cd: 40 },
         boost:  { charges: Infinity, dur: 4, cd: 16, mult: 1.3 },
         dcharge: { charges: 8, dur: 1, cd: 9 },   // depth charges off the stern (anti-sub)
         flare:  { charges: 6, dur: 1, cd: 12 },   // star shell at the cursor (lights up the night)
      },
      isPlayer: true,
   },
};

// ============ VISION / SMOKE ============
// Smoke blocks SIGHT, not projectiles. A ship inside or behind a cloud is unspotted unless an
// enemy is inside its proximity radius; firing the main battery "blooms" the shooter for a few
// seconds out to a caliber-dependent medium range. A ship sitting in smoke can still see OUT
// (there are no allied spotters in a 1-vs-fleet fight, so blinding the smoker would make smoke
// useless for the player).
export const VISION = {
   proxLengths: 2.5, proxMin: 300, proxMax: 700,         // proximity reveal = 2.5 hull lengths
   bloomTime: 6,                                         // s revealed after a main-battery salvo
   bloomPerCaliber: 5.5, bloomMin: 800, bloomMax: 1700,  // bloom range (m) = caliber(mm) * 5.5
   smokeEdge: 0.9,        // opaque fraction of a cloud's radius
   ghostTime: 15,         // s a "last known position" ghost stays on screen
   blindWindow: 12,       // s the AI keeps area-firing at a target it lost
   blindSpread: 4.0,      // dispersion multiplier for blind fire
   blindReloadMult: 2.2,  // blind fire cadence: reload x this
   blindMaxExtrap: 2.0,   // s of dead reckoning from the last seen course
   searchAfter: 10,       // s after losing contact before hunters move in on the smoke
};

// ============ CAMPAIGN SYSTEMS ============
// Aircraft (air.js): carrier squadrons fly attack runs; ship AA (ship._autoAA) shoots planes down.
export const AIR = {
   speed: 175, turn: 1.1, hp: 200,
   torp: { dmg: 950, speed: 150, range: 1000 }, torpDrop: 760,   // torpedo bombers release here
   bomb: { dmg: 700, fire: 0.35, sigma: 55, fall: 1.1 }, diveStart: 950, diveDrop: 160,
   egress: 5,                    // s flying away after the attack before turning home
};
// Contact mines: armed after `arm` s, seen only inside `reveal` of an enemy ship.
export const MINES = { trigger: 24, dmg: 1500, reveal: 480, arm: 2.5, flood: 0.6 };
// Depth charges roll off the stern and go off after `fuse` s; only submarines take damage.
export const DCHARGE = { count: 4, fuse: 1.8, radius: 170, dmg: 760 };
// Star shells: a flare that lights a circle for `life` s -- everything inside is spotted.
export const FLARE = { r: 760, life: 14, flight: 1.5, range: 2400 };
// Mission conditions (missions.js env). visionMult scales every detect radius; dispersion scales
// every gun's spread (heavy seas).
export const ENV = {
   clear: { visionMult: 1, dispersion: 1 },
   night: { visionMult: 0.5, dispersion: 1.1, night: true },
   storm: { visionMult: 0.8, dispersion: 1.5, storm: true },
   fog:   { visionMult: 0.7, dispersion: 1.05, fog: true },
};

// ============ WEAPON HANDLING ============
export const HANDLING = {
   alignTolPlayer: 3 * DEG,   // a player turret fires only once it points within this of the aim
   alignTolBot: 20 * DEG,
   turretArc: 145 * DEG,      // half-arc each turret can train away from its home direction
   rippleGap: 0.35,           // s between turrets in hold-to-ripple fire
   clickHold: 0.22,           // s: LMB held longer than this turns click-salvo into ripple fire
   torpSpread: { narrow: 2.5 * DEG, wide: 8 * DEG }, // angle between adjacent torpedoes
   // Plunging fire: a main-battery shell is only low enough to strike a hull (or an island) in the
   // last `hitWindow` of its flight, then splashes a little past the aim point. So shells arc over
   // ships (and rocks) in between, and a miss lands visibly instead of flying on across the map.
   hitWindow: 0.35,
   overshoot: 0.08,
   rangeSigma: 0.025,         // 1-sigma range dispersion as a fraction of the aimed range
   maxAimMult: 1.05,          // the player can't fire at points beyond range * this
};

// ============ DIFFICULTY ============
// Rider multipliers on bot accuracy / HP / damage. One-knob presets. sigmaDeg only scales the
// *bots'* aim; the player's dispersion is fixed.
export const DIFFICULTY = {
   easy:   { reactionTime: 1.6, leadQuality: 0.30, sigmaDeg: 2.2,  salvoMult: 0.6, detectMult: 0.8,  botHP: 0.8,  botDmg: 0.7,  bossCd: 1.3, bossFan: -2, bossWarn: 1.25 },
   normal: { reactionTime: 0.9, leadQuality: 0.70, sigmaDeg: 0.55, salvoMult: 1.0, detectMult: 1.0,  botHP: 1.0,  botDmg: 0.66, bossCd: 1.0, bossFan: 0,  bossWarn: 1.0 },
   hard:   { reactionTime: 0.30, leadQuality: 1.0,  sigmaDeg: 0.2,  salvoMult: 1.15, detectMult: 1.15, botHP: 1.1,  botDmg: 0.9,  bossCd: 0.8, bossFan: 2,  bossWarn: 0.85 },
};

// ============ ENCOUNTER ============
// Default mission: one wave, 5 bots, Bismarck at origin facing +x (east). Spawn ring 2000 m so the
// first shots come quickly. `new World(diff, seed, mission)` can override bots/pressure/obstacles.
export const ENCOUNTER = {
   ring: 2000,
   bots: [
      { cls: 'EB', bearing: 0 },          // dead ahead — the duel
      { cls: 'HC', bearing: 110 * DEG },  // right flank / rear
      { cls: 'LC', bearing: -110 * DEG }, // left flank / rear
      { cls: 'DD', bearing: 55 * DEG },   // front-right, pounce
      { cls: 'DD', bearing: -55 * DEG },  // front-left, pounce
   ],
   // Optional pressure wave at 60s if any enemy survives:
   pressureAt: 60,
   pressure: [ { cls: 'DD', bearing: 30 * DEG }, { cls: 'DD', bearing: -30 * DEG } ],
};

// ============ MAP / OBSTACLES ============
// Islands are solid rock (ships bounce off, descending shells and torpedoes detonate on them);
// reefs are shallow water (slow you down, no cover). Placed across the middle of the arena with
// >=700m clearance to every spawn point.
export const OBSTACLES = [
   { kind: 'island', c: { x: -1082, y: 389 },  r: 450, irregular: true },
   { kind: 'island', c: { x: 731,   y: -796 }, r: 380, irregular: true },
   { kind: 'island', c: { x: -539,  y: -842 }, r: 260, irregular: true },
   { kind: 'island', c: { x: 260,   y: 966 },  r: 300, irregular: true },
   { kind: 'reef',   c: { x: 1071,  y: 307 },  r: 320 },
   { kind: 'reef',   c: { x: -1558, y: -1418 }, r: 280 },
   { kind: 'reef',   c: { x: -6,    y: -1569 },r: 240 },
];

// ============ COMBAT / DAMAGE MODEL ============
// Bouncing shells + citadel = the core WoWs "feel".
export const COMBAT = {
   // penetration: pPen = 1/(1+exp(-margin/penK)); margin = effAP/armor - 1,
   // effAP = ap * (1 - 0.5 * glance), glance = 1 - |cos(incidence)|
   penK: 0.18,
   // AP ricochet vs the belt: none below ricStart incidence, certain above ricAuto. Overmatch:
   // armour thinner than ap * overmatch can't deflect the shell at all (big guns vs destroyers).
   ricStart: 45 * DEG, ricAuto: 62 * DEG, overmatch: 0.35,
   overPen: 1.5,          // margin above this => through-and-through, no citadel
   overPenMult: 0.33,     // ...for a third of the shell's damage (thin hulls shrug off AP)
   citadelLen: 0.40,      // citadel = central fraction of the hull length
   citadelMult: 1.35,
   concentration: { minShells: 4, mult: 1.5 }, // salvo piling into the citadel within 1.5s
   grazeMult: 0.4,        // penetrating hit outside the citadel
   // HE doesn't bounce but heavy belts soak part of it: dmg * clamp(heBase - armor/heArmorDiv)
   heBase: 1.15, heArmorDiv: 500, heMin: 0.55,
   heFireDefault: 0.12,
   // Fire/flood are a fraction of the burning ship's max HP per second (times the igniter's
   // difficulty dmgMult) with a finite burn time: a flat 100 HP/s used to delete a destroyer in
   // 10s while barely tickling the Bismarck. Damage control (E) is the counter.
   fire: { rate: 0.004, dur: 30, max: 3, spread: 6, spreadP: 0.25 },
   flood: { rate: 0.006, dur: 25, max: 2, slow: 0.06 },
   torpCentralMult: 1.30, // central third of the hull on a torpedo
   torpFlood: 0.5,
   igniteFire: 0.05,      // extra fire chance on an AP citadel hit
   // what fraction of each damage type the repair party can later restore
   restorable: { citadel: 0.1, main: 0.5, secondary: 0.5, fire: 1.0, flood: 1.0, torpedo: 0.33, aa: 1.0, gun: 0.5 },
};

// ============ COLORS / PALETTE ============
export const PALETTE = {
   seaDeep: '#0e3350',
   seaMid: '#124062',
   seaShallow: '#1f5f86',
   foam: '#bfe3ff',
   sun: '#ffd48a',
   sunGlow: 'rgba(255,210,140,0.16)',
   skyTop: '#0a1830',
   skyHorizon: '#2a4a6a',
   ship: '#46555f',
   shipDark: '#2b363e',
   deck: '#5a6b74',
   fire: '#ff7a2d',
   fireCore: '#ffd24a',
   smoke: 'rgba(120,120,120,0.5)',
   enemy: '#c65a4a',
   friendly: '#4ad07a',
   danger: '#ff4d3d',
};

// ============ TUNING ============
export const TUNE = {
   waveHeight: 0.05,      // 0..1 sea roughness
   timeOfDay: 0.75,       // 0..1 day cycle (0.75 = late afternoon, golden)
   fogDist: 2600,         // m; beyond this, fade to horizon color
   shellLife: 8,         // s before a stray shell despawns
   maxProjectiles: 400,
   maxParticles: 1400,
   // Fixed camera: the view is sized so ~CAM_VIEW m fit in the half of the smaller screen
   // dimension, then the camera leans toward the cursor so the aimed-at side reaches past main
   // battery range. No zoom controls -- the minimap is the overview.
   camView: 1050,
   camLookMouse: 0.55,    // fraction of the cursor's screen offset the camera leans toward
   camLookMax: 720,       // m cap on that lean
   camLookHeading: 90,    // m of lean along the heading
};
