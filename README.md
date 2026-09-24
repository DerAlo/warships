# Bismarck — Offline Naval Combat

A World-of-Warships-style naval combat game. You command the battleship
*Bismarck* against 5 AI-controlled bots, offline only. Vanilla JS, no build
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

- **3D** (`index-3d.html`) — real 3D ships (Three.js, vendored locally under
  `vendor/three/` — no CDN, still fully offline) with a third-person chase
  camera. The headline mechanic: turret traverse is a real gate on firing —
  the main battery only fires once every ready turret has actually slewed
  to bear on your aim point, not the instant you click.

**Play it here:** https://deralo.github.io/warships/ · 3D: https://deralo.github.io/warships/index-3d.html

## Run locally

```
npm start
```

Then open http://localhost:5173 (2D) or http://localhost:5173/index-3d.html (3D).

## Tests

```
node --test tests/sim.test.mjs       # headless simulation tests (shared core, both modes)
node --test tests/missions.test.mjs  # headless 2D campaign checks (every mission, win/lose, stars, survival)
node tests/play.mjs 50               # balance check: N free battles per difficulty
node tests/play.mjs missions 10      # balance check: every campaign mission + survival
node tests/playwright.shots.mjs      # 2D browser self-test + screenshots
node tests/playwright2d.missions.mjs # 2D browser play-test of every mission + survival
node tests/playwright3d.shots.mjs    # 3D browser self-test + screenshots
```
