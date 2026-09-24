# 3D mode ("World of Warships singleplayer") — architecture & module contract

The 3D mode (`index-3d.html`) runs on its **own fork** of the simulation core in `game3d/`.
The 2D mode (`index.html`) keeps using `game/`. The two never import from each other, so the
3D mode can chase WoWs realism (scale, ballistics, spotting, consumables, teams) without breaking
the arcade 2D game, and vice versa.

## Module ownership

| File(s) | Responsibility |
|---|---|
| `config.js`, `state.js`, `ship.js`, `ai.js`, `combat.js`, `utils.js`, `missions.js`, `menu3d.js` | **Simulation + missions**: world scale, ship classes, ballistics, damage, spotting, consumables, AI, allies, mission scripting, mission/ship picker UI component |
| `render3d.js` + `water3d.js`, `sky3d.js`, `terrain3d.js`, `ships3d.js`, `fx3d.js` | **Graphics**: sea, sky, lighting, island relief, ship models, effects. Reads sim state only. |
| `camera3d.js`, `main3d.js`, `input3d.js`, `minimap3d.js`, `hud.js`, `hud3d.js`, `audio.js`, `index-3d.html` | **Controls / camera / aiming / HUD / audio / page** |

Graphics and controls only **read** simulation state (plus call the documented ship methods
below). Everything below is the contract between these three areas. Consumers must degrade
gracefully (optional chaining + sensible fallbacks) when a field is missing.

## Coordinates & scale

* Sim plane: `{x, y}`; X+ = east, Y+ = south; angle 0 = +x (east), CCW positive in sim math,
  `heading` in radians. 3D: sim `{x, y}` → `THREE.Vector3(x, height, y)`; a ship group uses
  `rotation.y = -heading`.
* **1 sim unit = 1 metre.** WoWs-like scale: maps are ~16–28 km across (`world.arena` =
  half-extent in metres, per mission, typically 8000–14000). Main-battery ranges are
  WoWs-like (DD ~9–12 km, cruisers ~13–17 km, battleships ~17–23 km), shell flight times of
  several seconds up to ~15 s at max range.
* Ship movement is time-compressed like WoWs: HUD shows knots (`ship.speedKn`), the sim moves
  ships at `knots * WORLD.KN_TO_MS` m/s (≈ 2.6, i.e. ~5× real time).
* Ship dimensions are real metres (Bismarck 251 m × 36 m).

## World (`state.js`)

```
new World(difficulty = 'normal', opts = {})   // opts.mission: mission id, opts.ship: player ship class key
world.phase            // 'playing' | 'won' | 'lost'
world.time             // seconds since start
world.arena            // half-extent (m)
world.mission          // { id, name, subtitle, briefing, type, objectives:[{id, text, state:'active'|'done'|'failed'}] }
world.env              // { time:'day'|'dawn'|'dusk'|'night', weather:'clear'|'overcast'|'rain'|'storm',
                       //   seaState:0..1, visibility:0..1 (1 = clear), sunAzimuth, sunElevation (rad) }
world.player           // the player's Ship
world.ships            // ALL ships (player, allies, enemies); includes sinking ships until they are gone
world.bots             // AI-controlled ships (allies + enemies)
world.alliesOf(ship), world.enemiesOf(ship)
world.obstacles        // [{ kind:'island'|'reef', c:{x,y}, r, lobes, height (m, islands), seed }]
world.caps             // [{ id:'A', pos:{x,y}, r, owner:null|'player'|'enemy', progress:0..1, capper:null|side, contested:bool }]
world.score            // { player, enemy, target } (domination) or null
world.timeLeft         // seconds or null
world.shells           // [{ id, pos:{x,y}, alt (m, current altitude), side, ownerId, caliber (mm), ammo:'AP'|'HE', kind:'main'|'sec', age, dur }]
world.torpedoes        // [{ id, pos, heading, speed, side, ownerId, spotted:bool }]
world.smokeClouds      // [{ c:{x,y}, r, life, side }]
world.effects          // transient visual effects [{ kind, pos, t, life, size, ... }] (muzzle, splash, explosion, ...)
world.planes           // optional [{ id, pos, alt, heading, side, kind }]
world.events           // append-only ring buffer (max ~256) of gameplay events, each with a monotonic `seq`.
                       // Consumers keep their own lastSeq. Event: { seq, t, type, srcId, dstId, dmg, pos, text }
                       // types: 'pen' 'citadel' 'overpen' 'ricochet' 'shatter' 'he' 'sec' 'torp' 'fire' 'flood'
                       //        'kill' 'sunk' 'spotted' 'unspotted' 'cap' 'capLost' 'objective' 'consumable' 'ammo'
world.stats            // player stats: { dmg, kills, citadels, pens, fires, floods, torpHits, shotsFired, hits, spottingDmg, tanked }
world.result           // on end: { victory:bool, reason:string, xp, credits }
world.isSpotted(ship)  // visible to the player's team
world.inSmoke(pos, side)
```

## Ship (`ship.js`)

```
ship.id, ship.cls, ship.name, ship.side ('player'|'enemy'), ship.isPlayer
ship.cfg               // SHIPS[cls]; cfg.hull = { type:'DD'|'CL'|'CA'|'BB'|'CV'|'TR', L, beam, draft, deckH, nation, color }
ship.pos, ship.heading, ship.speed (m/s), ship.speedKn, ship.maxSpeedKn
ship.hp, ship.maxHP, ship.alive
ship.sinking, ship.sinkT       // alive=false && sinking=true while the sink animation plays; sinkT 0..1
ship.spotted                   // enemy: visible to player team. player: ship.detected = player is spotted
ship.detectRange               // current surface detectability (m), after gun bloom etc.
ship.telegraph                 // -1 (reverse), 0 (stop), 1 (1/4), 2 (1/2), 3 (3/4), 4 (full)
ship.rudderCmd                 // -2..2 commanded rudder position; ship.rudder = actual (-1..1, lags by rudder shift time)
ship.setTelegraph(n), ship.setRudder(n)
ship.aimPoint                  // {x,y} current aim point (player: set by controls each frame)
ship.turrets                   // [{ off:{x,y} (m, ship-local, +x = bow), guns, caliber, bearing (rad, relative to bow),
                               //    elev (rad), aligned:bool, canBear:bool, alive:bool, reload, reloadMax }]
ship.ammo                      // 'HE' | 'AP' ; ship.setAmmo(type) (switching reloads the guns)
ship.fireMain(world, aimPoint) // fires every loaded + aligned turret, returns number of guns fired
ship.torps                     // { launchers:[{ off, bearing, reload, reloadMax, tubes }], spread:'narrow'|'wide', range, speedKn } or null
ship.fireTorpedoes(world, bearing)  // returns number of torpedoes launched
ship.consumables               // [{ key, name, charges (Infinity = unlimited), maxCharges, cd, cdMax, active, t, dur }]
ship.useConsumable(world, key) // key: 'repair' 'damageControl' 'smoke' 'boost' 'hydro' 'radar' ...; returns bool
ship.fires, ship.floods        // active damage-over-time modules
ship.modules                   // optional: { engine, rudder, turrets... } incapacitated flags
```

## Renderer (`render3d.js`)

```
const renderer = new Renderer3D(canvas)
renderer.setHudCanvases(minimapCanvas, compassCanvas)
renderer.resize(w, h)
renderer.buildWorld(world)   // (alias buildObstacles) called once per match: terrain, env/lighting
renderer.render(world, dt, camState)
renderer.camera              // THREE.PerspectiveCamera (for projecting HUD markers)
renderer.cam                 // ChaseCamera (camera3d.js)
renderer.setCameraPose(...), renderer.screenToWorld(nx, ny), renderer.scopeT
renderer.project(worldX, height, worldY) -> { x, y (CSS px), visible } // for floating HUD markers
```

## Menu & match flow (`menu3d.js`, `main3d.js`)

```
const menu = new Menu3D(menuEl, endEl, { onStart(opts), onPort(), onHowTo(), onClick() })
menu.show() / menu.hide()            // port: mission list + ship cards (PLAYABLE), difficulty
menu.showResults(world, opts, extra) // Sieg/Niederlage, reason, damage/kills/citadels/fires, xp/credits
menu.hideResults()
// results buttons: "Nochmal" -> onStart(same opts); "Naechste Mission" -> select next + onPort;
// "Hafen" -> onPort. main3d.onPort drops the finished World (world = null) and shows the port.
```

- `startGame(opts)` always builds a fresh `World` and calls `renderer.buildWorld(world)`, which
  clears every per-match GPU resource first; GPU memory stays flat across restarts
  (`tests/playtest3d.mjs` logs `renderer.info.memory` per round).
- The end screen appears ~2.5 s after `world.phase` turns `won`/`lost` (sinking / ending shot).
- Progress (unlocked missions, best results) lives in `localStorage['warships3d.progress.v1']`.
- Visual scale: the sim runs ~5x time-compressed (`KN_TO_MS` ~2.6 m/s per knot), so time-based
  FX (wakes) age by `speed / reference speed` to stay true to distance. Haze: `env.fogD50`
  (sky3d `resolveEnv`) is the 50% contrast distance; binocular zoom multiplies it by up to 2.5.
- Camera collision (`camera3d.js`) samples `renderer.terrain.heightAt` around the lens; when a
  hill forces a lift, the orbit arm is shortened (not lengthened), so the own ship keeps its screen
  spot. Pixel-floored FX (tracers, cap letters) scale with `tan(fov/2)` so they do not balloon at 16x.
