// tests/repro-pause.mjs — adversarial repro: edge-triggered keys consumed per sim step.
// Drives the rAF loop with a fake clock so one animation frame spans exactly N sim steps,
// and dispatches keydown/keyup synchronously around the frame for deterministic timing.
import { chromium } from 'playwright';

const URL = process.env.URL3D || 'http://localhost:5173/index-3d.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));

await page.addInitScript(() => {
   let t = 1000; // fake clock, ms
   performance.now = () => t;
   const cbs = new Set();
   window.requestAnimationFrame = (cb) => { cbs.add(cb); return cbs.size; };
   window.__stepFrame = (dtMs) => {
      t += dtMs;
      const list = [...cbs]; cbs.clear();
      for (const cb of list) cb(t);
   };
   // Synchronous key event dispatch (bypasses Playwright's async input queue).
   const mk = (type, code) => new KeyboardEvent(type, { code, key: code === 'Space' ? ' ' : code.slice(-1).toLowerCase(), bubbles: true, cancelable: true });
   window.__keyDown = (code) => window.dispatchEvent(mk('keydown', code));
   window.__keyUp = (code) => window.dispatchEvent(mk('keyup', code));
});

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(800);
await page.click('.chip[data-diff="easy"]');
await page.click('#btn-play');
await page.waitForTimeout(200);

const pauseHidden = () => page.evaluate(() => document.getElementById('pause').classList.contains('hidden'));
const anchorLogs = () => page.evaluate(() => window.__world().logLines.filter(l => l.text.includes('Anker fällt!')).length);
const resume = async () => { await page.click('#btn-resume'); await page.evaluate(() => window.__stepFrame(17)); };

// Tap a key such that keydown lands BEFORE the frame and keyup AFTER it:
// the key is therefore in Input3D.pressed for every sim step of that frame.
const tapInFrame = (code, dtMs) => page.evaluate(([c, d]) => {
   window.__keyDown(c);
   window.__stepFrame(d);
   window.__keyUp(c);
}, [code, dtMs]);

// --- Case A: 1-sim-step frame (17 ms), tap P once -> should pause ---
await tapInFrame('KeyP', 17);
console.log('A) 1-step frame, tap P -> pause overlay hidden?', await pauseHidden(), '(expect false = paused)');
await resume();
console.log('A2) resumed via button -> pause overlay hidden?', await pauseHidden(), '(expect true)');

// --- Case B: 2-sim-step frame (34 ms > 2*SIM_DT), tap P once ---
await tapInFrame('KeyP', 34);
console.log('B) 2-step frame, tap P -> pause overlay hidden?', await pauseHidden(), '(BUG if true: pause did nothing)');
if (!(await pauseHidden())) await resume(); // if B correctly paused, resume for C

// --- Case C: 3-sim-step frame (50 ms), tap P once ---
await tapInFrame('KeyP', 50);
console.log('C) 3-step frame, tap P -> pause overlay hidden?', await pauseHidden(), '(expect false = paused, odd parity)');
if (!(await pauseHidden())) console.log('C-note: still playing (even-parity double-toggle again?)');
await resume();

// --- Case D: SPACE anchor log duplication in a 2-step frame ---
const before = await anchorLogs();
await tapInFrame('Space', 34);
const after = await anchorLogs();
console.log(`D) 2-step frame, tap SPACE once -> "Anker fällt!" logs: ${before} -> ${after} (BUG if delta > 1)`);

// --- Case E: can P resume from paused? (separate observation) ---
await tapInFrame('KeyP', 17); // pause
console.log('E-pre) paused -> overlay hidden?', await pauseHidden());
await tapInFrame('KeyP', 17); // try to resume with P
console.log('E) tap P while paused -> pause overlay hidden?', await pauseHidden(), '(true = P resumes; false = P cannot resume, button only)');

await browser.close();
