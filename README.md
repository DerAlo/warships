# Bismarck — Offline Naval Combat

A World-of-Warships-style top-down naval combat game. You command the
battleship *Bismarck* against 5 AI-controlled bots, offline only. Vanilla
JS/Canvas, no build step, no dependencies at runtime.

**Play it here:** https://deralo.github.io/warships/

## Run locally

```
npm start
```

Then open http://localhost:5173.

## Tests

```
node --test tests/sim.test.mjs   # headless simulation tests
node tests/play.mjs 50           # balance check: N full matches per difficulty
node tests/playwright.shots.mjs  # browser self-test + screenshots
```
