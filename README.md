# Bismarck — Offline Naval Combat

A World-of-Warships-style naval combat game with German warships of 1939–45 and
AI-controlled opponents (and allies), offline only. Vanilla JS, no build
step. Two ways to play, each with its own simulation core (2D: `game/`, 3D: `game3d/`,
see `game3d/ARCHITECTURE.md`):

- **2D** (`index.html`) — top-down Canvas 2D view with a fixed camera (no
  zoom; the minimap is the overview):
  - **Campaign** of 9 missions (convoy hunt, escort, night action, storm,
    carrier strike, boss fight, …) with briefings, objectives and a 3-star
    rating, plus an endless **Survival** mode with waves and a saved record.
  - **Gunnery:** AP vs HE shells — AP into a broadside scores citadels, steep
    angles ricochet; HE is reliable damage and sets fires. Click for a full
    salvo, hold to ripple-fire turret by turret.
  - **Torpedo spread** (narrow / wide fan), secondary battery focus, flak
    against aircraft.
  - **Consumables:** repair party, damage control, smoke screen, engine
    boost, depth charges, star shells.
  - **Realistic smoke** that blocks vision (not shells) — firing the main
    battery gives away your position through gun bloom.
  - **New enemy types:** torpedo-boat swarms, submarines (hydrophone pings),
    transports, carriers with torpedo / dive-bomber squadrons, coastal
    batteries, mines.
  - **Ribbons** and floating damage numbers for hits, citadels, fires and
    kills; end screen with detailed stats.

  2D controls:

  | Key | Action |
  |---|---|
  | W / S | Throttle up / down |
  | A / D | Rudder left / right |
  | Mouse | Aim turrets |
  | Left click | Full salvo · hold = turret by turret |
  | 1 / 2 | AP / HE shells |
  | Right click | Focus secondary battery on target |
  | T | Hold = aim torpedo fan, release = launch |
  | Q | Torpedo fan narrow / wide |
  | R | Repair party (heal hull) |
  | E | Damage control (extinguish fires / stop flooding) |
  | F | Smoke screen |
  | Shift | Engine boost |
  | C | Depth charges (vs. submarines) |
  | G | Star shell at cursor (night) |
  | Space | Anchor turn (hold: brake + tighter turn) |
  | P / Esc | Pause |

- **3D** (`index-3d.html`) — a singleplayer *World of Warships*: real 3D ships
  (Three.js, vendored locally under `vendor/three/` — no CDN, still fully offline).
  - **Missions:** Übungsgefecht (training), Standardgefecht (7 vs 7),
    Herrschaft (domination, three capture points), Geleitzug (convoy escort),
    Unternehmen Rheinübung, Letztes Gefecht, Nachtgefecht (destroyer night
    action) and Handelskrieg (commerce raid), each with briefing and objectives.
  - **Playable ships:** Bismarck (battleship), Admiral Hipper (heavy cruiser),
    Nürnberg (light cruiser) and Z 23 (destroyer), each with its own guns,
    torpedoes and consumables.
  - **WoWs scale:** 1 unit = 1 m, maps 16–28 km across, WoWs-like gun ranges,
    shell flight times, spotting/detectability and time-compressed movement.
    Turret traverse is a real gate on firing — only loaded turrets that have
    slewed onto the aim point fire.
  - **Graphics:** animated sea with wakes, sky with time of day and weather
    (dawn, dusk, night, rain, storm), distance haze, island relief, smoke
    screens, muzzle flashes, splashes, fires and flooding. Some missions have a
    weather front that rolls in mid-battle ("Sturmfront zieht auf"): the sky and
    fog darken, rain sets in, waves build, visibility and spotting drop and
    dispersion rises slightly. At night, muzzle flashes light up their
    surroundings and star shells hang over newly spotted enemies. Sunk ships
    list and go down, leaving smoke and a fading oil slick.
  - **Kill camera:** a short cut (about 2 s) to a ship you just sank. Any key or
    click skips it. It never starts during danger, stops as soon as you take
    fire, and can be turned off in the pause menu ("Versenkungs-Kamera").
  - **Sound:** synthesized effects, alert tones ("Torpedos voraus!", "Feuer an
    Bord!", "Wassereinbruch!", "Zitadelle getroffen!", "Gegner versenkt") and
    music that follows the combat (calm, spotted, heavy fire, low health).
    Music and effects volume are set in the pause menu and saved.
  - **Controls (WoWs-style):** fixed centre crosshair with lead ruler and
    turret readiness display.

  | Key | Action |
  |-----|--------|
  | W / S | Engine telegraph one step up / down |
  | A / D | Rudder one step port / starboard |
  | Q | Rudder amidships |
  | Mouse | Bearing (sideways) and range (up/down) |
  | Left click | Fire (only loaded, trained turrets) |
  | Mouse wheel | Zoom ladder: camera distance → binoculars 2× / 4× / 8× / 16× |
  | Shift | Binoculars on/off (last magnification) |
  | C / right click | Free camera (turrets keep the target) |
  | 1 / 2 | HE / AP shells |
  | 3 | Torpedoes · press 3 again: narrow/wide spread |
  | X | Lock / release target |
  | L | Lead marker on/off |
  | R / T | Damage control / repair party |
  | Y / U | Special consumables (boost, smoke …) |
  | M / Tab | Tactical map / scoreboard |
  | H | Controls help |
  | P / Esc | Pause |
  | O | Photo mode: pauses the game, free camera (drag + mouse wheel), no HUD · O / Esc: back |

**Play it here:** https://deralo.github.io/warships/ · 3D: https://deralo.github.io/warships/index-3d.html

## Run locally

```
npm start
```

Then open http://localhost:5173 (2D) or http://localhost:5173/index-3d.html (3D).

## Tests

```
node --test tests/sim.test.mjs       # headless 2D simulation tests
node --test tests/missions.test.mjs  # headless 2D campaign checks (every mission, win/lose, stars, survival)
node tests/play.mjs 50               # balance check: N free battles per difficulty
node tests/play.mjs missions 10      # balance check: every campaign mission + survival
node tests/playwright.shots.mjs      # 2D browser self-test + screenshots
node tests/playwright2d.missions.mjs # 2D browser play-test of every mission + survival
node tests/playwright3d.shots.mjs    # 3D browser self-test + screenshots
node --test tests/sim3d.test.mjs     # headless 3D simulation tests (ballistics, AI, missions)
node --test tests/zoom3d.test.mjs    # 3D mouse-wheel zoom / binoculars ladder
node tests/playwright3d.zoom.mjs     # 3D browser check of the wheel zoom
node tests/playwright3d.missions.mjs # 3D browser play-test of every mission
node tests/perf3d.mjs                # 3D draw calls + GPU memory across restarts
```
