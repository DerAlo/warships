// tests/perf3d.smoke.mjs -- smoke overdraw probe: GPU frame time with the camera inside / next to / zoomed into a
// destroyer's smoke screen and next to a burning ship, against the same views without smoke. Each frame of the
// game's own loop is timed up to a 1-pixel readback (so the GPU work is in it); vsync is off.
// Prints median / p90 frame ms and the smoke particle count per view. Not a pass/fail suite.
//
// Run:  node server.js 8821   then   URL3D=http://localhost:8821/index-3d.html node tests/perf3d.smoke.mjs [tier]
import { chromium } from 'playwright';

const URL = process.env.URL3D || 'http://localhost:8820/index-3d.html';
const TIER = process.argv[2] || 'high';
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: Number(process.env.W) || 1600, height: Number(process.env.H) || 900 }, deviceScaleFactor: Number(process.env.DPR) || 1 });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.goto(URL + '?gfx=' + TIER, { waitUntil: 'load' });
await page.waitForTimeout(1000);
await page.evaluate(() => window.__start({ difficulty: 'easy', mission: 'standard', ship: 'Z23' }));
await page.waitForFunction(() => window.__phase() === 'playing', null, { timeout: 15000 });
await page.waitForTimeout(1500);
const info = await page.evaluate(() => {
   const R = window.__renderer3d, gl = R.renderer.getContext(), px = new Uint8Array(4), post = R.post, orig = post.render.bind(post);
   window.__ft = [];
   post.render = (...a) => { const t0 = performance.now(); orig(...a); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); window.__ft.push(performance.now() - t0); };
   // the bots must not sink the player or sail into the views: everyone else far away, nobody fires
   const w = window.__world(), P = w.player;
   for (const s of w.ships) if (s !== P) { s.pos.x = P.pos.x + 30000; s.pos.y = P.pos.y + 30000; }
   P.speed = 0; if ('throttle' in P) P.throttle = 0;
   return { gpu: R.gfxState().gpu, tier: R.tier, pr: R.pixelRatio, samples: R.post.sceneRT.samples };
});
console.log('GPU', info.gpu, '| tier', info.tier, 'pr', info.pr, 'msaa', info.samples);

// a 20 s smoke screen: 18 clouds laid 1.1 s apart along the course, grown to full size
const laySmoke = () => page.evaluate(() => {
   const w = window.__world(), P = w.player;
   w.smokeClouds.length = 0;
   for (let i = 0; i < 18; i++) w.addSmoke({ c: { x: P.pos.x + 200 + i * 20, y: P.pos.y + 600 }, r: 450, maxR: 450, life: 600, side: P.side, ownerId: P.id });
   for (const c of w.smokeClouds) c.age = 10;
});
const clearSmoke = () => page.evaluate(() => { window.__world().smokeClouds.length = 0; });
const setFires = (n) => page.evaluate((n) => { const P = window.__world().player; P.fires = Array.from({ length: n }, () => ({ t: 999, mult: 0, srcId: null })); }, n);
const view = (fn, a) => page.evaluate(fn, a);

async function measure(name) {
   await page.waitForTimeout(1200);
   await page.evaluate(() => { window.__ft.length = 0; });
   const t0 = Date.now();
   await page.waitForTimeout(2500);
   const r = await page.evaluate(() => {
      const ft = window.__ft.slice().sort((a, b) => a - b), q = (k) => ft[Math.min(ft.length - 1, Math.floor(ft.length * k))];
      const fx = window.__renderer3d.fx;
      const sm = fx._smk || {};
      return { n: ft.length, med: q(0.5), p90: q(0.9), puffs: fx.puff.geometry.instanceCount, smoke: sm.n ?? -1, cov: sm.cov ?? -1, keep: sm.keep ?? 1 };
   });
   const fps = r.n / ((Date.now() - t0) / 1000);
   if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + '/smoke-' + name.replace(/[^a-z0-9]+/gi, '-') + '.jpg', type: 'jpeg', quality: 70, scale: 'css' });
   console.log(`${name.padEnd(26)} median ${r.med.toFixed(2).padStart(6)} ms  p90 ${r.p90.toFixed(2).padStart(6)} ms  ~${fps.toFixed(0).padStart(4)} fps  puffs ${r.puffs}` + (r.smoke > 0 ? `  smoke ${r.smoke} (layers ${r.cov.toFixed(1)}, kept ${(r.keep * 100).toFixed(0)} %)` : ''));
   return r;
}

const inside = () => view(() => { const P = window.__world().player; window.__renderer3d.debugView = { pos: [P.pos.x + 380, 30, P.pos.y + 600], look: [P.pos.x + 800, 40, P.pos.y + 650], fov: 58 }; });
const edge = (fov) => view((fov) => { const P = window.__world().player; window.__renderer3d.debugView = { pos: [P.pos.x + 370, 45, P.pos.y - 600], look: [P.pos.x + 370, 60, P.pos.y + 600], fov }; }, fov);
const far = () => view(() => { const P = window.__world().player; window.__renderer3d.debugView = { pos: [P.pos.x + 370, 120, P.pos.y - 2600], look: [P.pos.x + 370, 60, P.pos.y + 600], fov: 58 }; });
const fire = () => view(() => { const P = window.__world().player; window.__renderer3d.debugView = { pos: [P.pos.x + 25, 40, P.pos.y + 20], look: [P.pos.x, 30, P.pos.y], fov: 58 }; });

for (const [name, setup] of [['inside', inside], ['1.2 km', () => edge(58)], ['1.2 km, 8x zoom', () => edge(58 / 8)], ['far 3 km', far]]) {
   await setup();
   await clearSmoke();
   await measure(name + ' (no smoke)');
   await laySmoke();
   await measure(name + ' (smoke)');
}
await clearSmoke();
await fire();
await measure('burning ship (no fire)');
await setFires(4);
await page.waitForTimeout(8000);   // let the plume build up
await measure('burning ship (4 fires)');
await setFires(0);
console.log('console errors', errors.length, errors.slice(0, 3));
await browser.close();
