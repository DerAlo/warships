# Bismarck — Offline Naval Combat

A World-of-Warships-style naval combat game. You command the battleship
*Bismarck* against 5 AI-controlled bots, offline only. Vanilla JS, no build
step. Two ways to play, sharing the same simulation core (game/state.js,
game/ship.js, game/ai.js, game/combat.js):

- **2D** (`index.html`) — top-down Canvas 2D view.
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
node --test tests/sim.test.mjs     # headless simulation tests (shared core, both modes)
node tests/play.mjs 50             # balance check: N full matches per difficulty
node tests/playwright.shots.mjs    # 2D browser self-test + screenshots
node tests/playwright3d.shots.mjs  # 3D browser self-test + screenshots
```
