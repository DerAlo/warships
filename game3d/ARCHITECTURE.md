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

## Submarines (`submarine.js`, `ai_sub.js`, `subui.js`)

Class `SS` ("U-Boot"): a ship whose config has a `sub` block (`SUB()` in `config.js`). All
submarine rules live in `submarine.js` (sim), `ai_sub.js` (bots) and `subui.js` (HUD, keys, audio
hooks); the shared files only call into them.

- State on the ship: `depth` (0 surfaced, 1 periscope depth, 2 deep; the state the hull is in),
  `depthTarget`, `depthF` (0..2, continuous) and `depthM` (metres below surfaced trim, read by the renderer),
  `battery` 0..1, `batteryLock` (forced up until 15 %), `sonarSeen {x, y, t}`, `pingT`.
  Orders: `orderDepth(ship, depth, world)`, or `diveDeeper` / `diveUp`.
- Who hits what: **surfaced** = a normal small ship. **Periscope depth** = shells do
  `PERI_SHELL_MULT` (0.5), torpedoes and ramming hit in full, depth charges hit. **Deep** = shells,
  torpedoes and ramming pass over; only depth charges (`DC`: full damage within 45 m, none beyond
  135 m) reach it.
- Who sees what: `subDetectRange` replaces the surface detectability — periscope depth
  `sub.periDetect` scaled by speed (the feather), `sub.torpBloom` for `SUB_BLOOM_T` s after a
  salvo, deep = never. A deep boat spots nothing; `hydrophoneContacts` gives it bearings only.
- Sonar: `updateSonar` runs every `SONAR_DT`; range per hunter class in `SONAR_RANGE`, scaled by
  how loud the boat is (speed, depth). A hit sets `sonarSeen` and emits `sonar`.
- Depth charges: `ASW` gives DD and CL `ship.asw { charges, reload }`; `dropDepthCharges(ship,
  world)`; `world.depthCharges` is a fixed pool (`alive` flag, never shrinks). Events: `dcDrop`,
  `depthCharge` (explosion, for FX/audio), `dc` (damage), `ram`, `depth`.
- Bots (`subPlan` from `ai.js`): boats close at periscope depth, fire inside `subFireRange`, go
  deep after a salvo or when a hunter is on top of them, run clear and surface to recharge below
  30 % battery. DD/CL steer onto a contact (weaving) and drop on it; BB/CA/CV turn away and zigzag.
  Surface bots do not launch torpedoes at a dived boat.
- Client: `SubUi` owns keys F/G, the depth/battery and depth-charge panels, the periscope overlay
  (`cam3.peri` switches `camera3d.js` to the periscope rig) and calls the optional audio hooks
  `subDive`, `subSurface`, `sonarPing`, `depthCharge`, `setSubmerged`.
- Saved profiles: the boats are appended to the tech tree; `progress3d.js` fills missing ship
  entries on load, so older `warships3d.profile.v1` data keeps working.

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
ship.lockTarget               // ship id of the X lock (main3d syncs it; secondaries' fallback)
ship.secTarget, ship.setSecTarget(id|null)  // secondary priority target (Ctrl+click; bots: their gun target);
                               //   the sim drops it when the target sinks or stays unseen for 10 s
ship.manualSec                // skill manualSec: secondaries fire ONLY at secTarget (none = silent), tighter dispH
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

## Audio (`audio.js`, `audiosynth.js`)

No sample files. `audiosynth.js` is a pure-JS offline synth (`render(name, sampleRate)`, seeded, so
every run sounds the same); `audio.js` turns the results into cached AudioBuffers (pre-rendered in
idle slices after the first gesture) and mixes them: pooled voice channels (low-pass, gain, stereo
pan, reverb send; `MAX_VOICES`, priorities, lowest gets stolen) -> world bus -> bus compressor ->
effects volume -> master -> limiter -> soft clip. Interface sounds bypass the world bus, music has
its own volume bus. Every method is a silent no-op until `init()` ran on a user gesture.

```
audio.setListener(x, y, camYaw)              // once per frame; pans by bearing relative to the camera
audio.mainGun(caliber, barrels, dist, pos?)  // dist 0 = own guns; far = delayed (d / 1500 m/s), muffled, rolling
audio.secondary(dist, pos?), audio.splash(dist, big, pos?), audio.sink(dist, pos?)
audio.impact(kind, dist, pos?, big?)         // 'pen' 'citadel' 'overpen' 'ricochet' 'shatter' 'he' 'sec' 'terrain'
                                             // 'torpHit' 'detonation' 'torpLaunch' 'explosion' (world.effects kinds)
audio.hit(big, eventType?)                   // own ship is hit, heard from inside the hull
audio.updateEngine(speed, maxSpeed, muted, throttle01?)
audio.updateAmbient(seaState, muted, weather?, fires?)   // sea, wind, rain, thunder, fire crackle, bow wash
audio.updateMusic(level)                     // -1 off, 0 calm, 1 spotted, 2 heavy fire, 3 low HP
audio.setVolumes(music, sfx), audio.setMuted(bool), audio.stats()
// interface: uiClick, lock, denied, ammoSwitch, reloaded, ribbon(kind), alert(kind), torpWarning,
//            spottedAlarm, consumable(key), radio, objective('done'|'failed'|'new'), endCue(victory)
// submarines (safe at any time): subDive(), subSurface(), sonarPing(dist), depthCharge(dist), setSubmerged(on)
```

`tests/playwright3d.audio.mjs` renders every sound through the desk in an OfflineAudioContext and
checks level, spectrum and duration; it also writes WAV files to `tests/shots/` for listening.

## Menu & match flow (`menu3d.js`, `main3d.js`)

```
const menu = new Menu3D(menuEl, endEl, { onStart(opts), onPort(), onHowTo(), onClick() })
menu.show() / menu.hide()            // port: mission list + ship cards (PLAYABLE), difficulty
menu.showResults(world, opts, extra) // Sieg/Niederlage, reason, damage/kills/citadels/fires, xp/credits
menu.hideResults()
menu.loadout(ship)                   // career snapshot { modules, skills } -> new World(diff, { loadout })
// progress3d.js (pure): calcRewards (World.end), unlock/module/skill rules, profile storage,
// applyLoadout(cfg, loadout) -> modified cfg copy handed to the player Ship once at spawn (opts.cfg);
// bots and SHIPS[] stay untouched, nothing runs per frame (Adrenalinrausch is evaluated per salvo).
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

## Multiplayer (`net/`)

Serverless co-op, host-authoritative. The interfaces to matchmaking and the wire protocol are in
`net/CONTRACT.md`; this is how the game side is put together.

```
net/coop.js      coopSlots(missionId)            humans a mission takes (0 = not playable in co-op)
net/setup.js     buildNetWorld(o)                same World on every peer: seed, mission, difficulty,
                 validClass, cleanLoadout        humans in place of allied bots (slot order = players)
net/command.js   makeCommand / applyCommand      continuous controls (telegraph, rudder, aim, lock)
                 execAction(ship, world, a)      one-shot actions; used by singleplayer too
net/codec.js     encodeShips / decodeSnap,       binary ship snapshot; localSide() is the one place
                 encodeOwn / decodeOwn           that maps host sides to local sides (PvP later)
net/host.js      makeHost(world, o)              applies commands, records events, sends snap/evt/sync
net/replica.js   makeReplica(world, o)           client: replaces world.update, applies host state
net/game.js      createNetGame(session, hooks)   handshake, channel wiring, quit/onEnd, byte counters
net/lobby.js     Lobby, makeBackend(mode)        game list, knock, room, hand-over (UI: mpui.js)
net/mqtt.js      MqttClient, BROKERS             minimal MQTT 3.1.1 over WSS, the public broker list
net/relay.js     Bus, makeBusLobby,              lobby channel and the game room transport: relay to
                 makeRoomTransport               every peer at once, direct channel where it comes up
net/transport_rtc.js  makeRtcCarrier             the WebRTC data channel (Trystero over Nostr relays)
main3d.js        startNetGame(session)           = window.__startNetGame; window.__net() -> info
```

- **Host.** The real `World` runs as in singleplayer. Ships of remote humans carry `ship.human`
  (the AI skips them); every sim step the host applies each player's latest command and executes
  queued actions in order (a fire order that finds no gun ready is retried for 15 ticks, so a
  click made on the client's slightly earlier reload read-out is not lost). `world.net` hooks
  record events, effects, smoke, log lines, shell and torpedo spawns/removals and ship
  spawns/removals. Statistics are kept per human (`ship.stats`), so each client gets its own
  results screen and career rewards; the host's `world.stats` stays the host's own.
- **Client.** `makeReplica` swaps `world.update` for a step that never simulates ships or decides
  damage: it interpolates ship state from the snapshot ring, integrates shells and torpedoes
  locally (visual only), ages effects and smoke, and replays host events into `world.events`.
  `world.player` is the client's own ship, so renderer, HUD, camera, minimap, audio, lead marker
  and shell cam read the world unchanged.
- **Rates.** Ship snapshots 20 Hz (every 3 sim steps, `SNAP_EVERY`), event batches when something
  happened, slow state (score, caps, timer, objectives, weather) 4 Hz, scoreboard and personal
  statistics 1 Hz. Commands: at most 30/s while something changes, 10/s keep-alive.
- **Interpolation.** The client renders `delay = clamp(0.06 + 2.5 * jitter, 0.1, 0.3)` s behind the
  host clock (offset and jitter are running averages over snapshot arrivals), extrapolates up to
  0.25 s when snapshots are late and jumps when it is off by more than 0.4 s. Snapshots carry the
  host tick; late or out-of-order ones are dropped. Event batches are numbered and applied in
  order (a gap is waited for 2 s, then skipped).
- **Prediction.** Own actions run through `execAction` on the replica at once: muzzle flash,
  reload start, shells (adopted by the host's shell record when it arrives, dropped after 1.2 s
  otherwise), consumables, ammo, spread, depth orders. Telegraph and rudder read-outs, turret
  traverse, aim and camera are local. Hull motion is **not** predicted: the own ship follows the
  interpolated host state like every other ship. Own reloads and cooldowns are shown ahead by the
  measured round trip, so "ready" on the client means ready when the order reaches the host.
- **Match flow.** `startGame` (singleplayer) and `startNetGame` both end in `beginMatch()`. In a
  net game the pause menu and photo mode are overlays: `frame()` keeps stepping the world
  (`live`), and a hidden host tab is stepped by a worker timer. The results screen offers only
  "Zur Lobby"; `toMenu()` calls `net.quit()`, which calls `session.onEnd` exactly once.
- **Leaving.** Host quits or goes silent for 5 s: the client ends with a German notice
  (`TEXT` in `net/game.js`). A client that leaves (`bye` or transport leave) hands its ship back
  to the AI. A sunk human keeps watching; the match is lost when no human ship is afloat.
- **Rejoin.** A captain who dropped out (tab reloaded, network gone, left by mistake) goes back
  in while the match runs: a seat token from the start (sessionStorage) lets the lobby re-admit
  that tab only, the host moves the slot to the new peer id and sends the missed state as state
  (`more` + `resync`: later ships, roster, objectives, torpedoes, smoke, own statistics and
  telegraph), not as the missed events. `tests/playwright3d.mp.rejoin.mjs` (real brokers,
  2026-10, measured): back in the battle ~1 s after the click, old ship, objectives and
  statistics equal to the host's, 20 snapshots/s again; in hybrid mode the direct channel came
  back after a reload and after a cut connection (the probe before using a channel, see
  "Transport", covers the old "up, then down at once" report). Trystero's console error for a
  channel the other side closed abruptly is turned into a warning in `transport_rtc.js`.
- **Transport.** Two browsers behind home routers often get no WebRTC path (no TURN server), so
  the room never depends on one: `makeRoomTransport` reaches every peer over public MQTT brokers
  from the first moment and moves a peer to the data channel once a probe sent over it came back
  answered (an "open" channel may be dead, e.g. after a re-join), and back when it is silent
  for 5 s or the peer says it stopped using it. Both routes share one framing with sequence numbers, so a switch loses
  nothing. Reliable channels are repaired with NACKs; `snap` and `cmd` are latest-wins and are
  sent at full rate to the peer's fastest broker only (thinned copies to the others keep them
  measured). Measured from one machine in 2026-10: relay 20 snapshots/s, round trip ~25 ms,
  largest gap ~150 ms; on the rate-limited broker alone 7.5 snapshots/s and ~175 ms. The
  interpolation delay does not look at the snapshot interval yet, so that last case stutters.
  Everything sent in one turn leaves as one publish per peer and broker (microtask flush). On a
  rate-limited broker one publish on the room topic carries a sealed bundle for every waiting peer
  (`publishMulti`), so 3 clients do not split its ~8 messages/s three ways.
- **3 and 4 players** (`tests/playwright3d.mp.multi.mjs`, one Chromium per player, real
  brokers, one machine, 2026-10, measured): 4 players relay only: host upload 63 kB/s
  (~0.5 Mbit/s, game data 33 kB/s; the rest are the copies to the other brokers and the
  encryption), ~100 publishes/s (HiveMQ 63, mosquitto 28, emqx 8, no broker dropped or backed
  up), every client 20 snapshots/s, largest gap 100–250 ms, 22 kB/s down. 3 players relay only:
  42 kB/s up, every client 20/s. Hybrid (3 and 4 players): every client went direct, host upload
  24 kB/s (3) / 36 kB/s (4), 20/s each. Rate-limited broker alone (`ONLY=emqx`), 4 players:
  7.5 snapshots/s per client, largest gap ~220 ms (2.5/s and 1.2 s gaps before the shared
  publish). The room lists 4 players without clipping at 1280x720.
- **Tests.** `tests/net3d.test.mjs` (node, virtual clock over `makeMemoryHub`, prints the measured
  bandwidth), `tests/playwright3d.net.mjs` (two pages over `makeLocalTransport`; set
  `window.__netMeasure = true` before the start to count bytes), `tests/relay3d.test.mjs` (node,
  the room transport over a fake broker network with loss, reordering and a rate limit),
  `tests/playwright3d.mp.relay.mjs` (needs internet: two separate Chromium instances over the
  real brokers, `MODE=blocked|direct|relayonly`, prints the measured link quality),
  `tests/playwright3d.mp.multi.mjs` (the same with `PLAYERS=3|4`, `MODE=hybrid|relayonly|blocked`,
  `ONLY=<broker>`; prints host upload, publishes per broker and per client snapshot rate and gaps),
  `tests/playwright3d.mp.rejoin.mjs` (reload and network cut mid-battle, back through the list,
  an outsider refused; `MODE=hybrid|relayonly`).
