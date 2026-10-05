// tests/playwright3d.gfx.mjs -- graphics quality tiers (game3d/gfxquality.js): desktop starts on "high", a touch
// device on "medium", ?gfx=low forces the low tier (no bloom, no MSAA, pixel ratio 1), the pause-menu select switches
// live, ?diag shows the GPU box, and the blank-frame watchdog steps down when every frame comes out white.
// Exit code 1 on a failed check or a console error.
//
// Run:  node server.js 8820   then   URL3D=http://localhost:8820/index-3d.html node tests/playwright3d.gfx.mjs
import { chromium } from 'playwright';

const URL = process.env.URL3D || 'http://localhost:8820/index-3d.html';
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + JSON.stringify(info) : ''));
};
const browser = await chromium.launch({ args: process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
async function open(query = '', ctxOpts = {}) {
   const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...ctxOpts });
   const page = await ctx.newPage();
   page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
   page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
   await page.goto(URL + query, { waitUntil: 'load' });
   await page.waitForTimeout(1500);
   return { ctx, page, gfx: () => page.evaluate(() => window.__gfx()) };
}

{
   const { ctx, page, gfx } = await open();
   let g = await gfx();
   check('desktop starts on high', g.tier === 'high' && g.samples === 4 && g.bloom === true, { tier: g.tier, samples: g.samples, bloom: g.bloom });
   check('GPU facts readable', typeof g.gpu === 'string' && g.maxTex > 0, { gpu: g.gpu, webgl2: g.webgl2 });
   check('watchdog probed a normal frame without strikes', g.probes > 0 && g.blankStrikes === 0 && !g.stillBlank, { probes: g.probes, last: g.lastProbe });
   await page.evaluate(() => window.__setGfx('low'));
   await page.waitForTimeout(500);
   g = await gfx();
   check('switch to low live', g.tier === 'low' && g.samples === 0 && g.bloom === false && g.pixelRatio === 1 && g.shadow === 1024, g);
   await page.evaluate(() => window.__setGfx('high'));
   await page.waitForTimeout(500);
   g = await gfx();
   check('and back to high', g.tier === 'high' && g.samples === 4 && g.bloom === true, { tier: g.tier });
   // pause-menu select stores the choice
   await page.evaluate(() => { const s = document.getElementById('opt-gfx'); s.value = 'medium'; s.dispatchEvent(new Event('change')); });
   await page.waitForTimeout(300);
   g = await gfx();
   check('pause select sets medium and stores it', g.tier === 'medium' && (await page.evaluate(() => localStorage.getItem('ks3d.gfx'))) === 'medium', g.tier);
   await page.evaluate(() => { const s = document.getElementById('opt-gfx'); s.value = 'auto'; s.dispatchEvent(new Event('change')); });
   check('auto clears the stored choice', (await page.evaluate(() => localStorage.getItem('ks3d.gfx'))) === null);

   // watchdog: paint every finished frame white -> steps down to medium, then low, and remembers it
   await page.evaluate(() => {
      const R = window.__renderer3d, post = R.post, orig = post.render.bind(post);
      post.render = (...a) => { orig(...a); const gl = R.renderer.getContext(); gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT); };
      R.setTier('high');
   });
   const t0 = Date.now();
   while (Date.now() - t0 < 15000 && (await gfx()).tier !== 'low') await page.waitForTimeout(250);
   g = await gfx();
   check('white frames step the tier down to low', g.tier === 'low', { tier: g.tier, last: g.lastProbe });
   check('fallback remembered for the next visit', (await page.evaluate(() => localStorage.getItem('ks3d.gfxFallback'))) === 'low');
   await page.reload({ waitUntil: 'load' });
   await page.waitForTimeout(1000);
   check('next visit starts on the remembered fallback', (await gfx()).tier === 'low');
   await page.evaluate(() => localStorage.removeItem('ks3d.gfxFallback'));
   await ctx.close();
}
{
   const { ctx, gfx } = await open('?nohint', { viewport: { width: 915, height: 412 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.625 });
   const g = await gfx();
   check('touch device starts on medium', g.tier === 'medium' && g.samples === 2 && g.pixelRatio === 1.5, { tier: g.tier, pr: g.pixelRatio });
   await ctx.close();
}
// a lost WebGL context (what a phone GPU running out of memory does): dark veil instead of a white canvas,
// the next tier is remembered, and after the browser hands the context back the battle goes on one tier lower
{
   const { ctx, page, gfx } = await open('?diag');
   await page.evaluate(() => window.__start({ difficulty: 'easy', mission: 'standard', ship: 'Bismarck' }));
   await page.waitForFunction(() => window.__phase() === 'playing');
   await page.waitForTimeout(1500);
   await page.evaluate(() => { window.__loseExt = window.__renderer3d.renderer.getContext().getExtension('WEBGL_lose_context'); window.__loseExt.loseContext(); });
   await page.waitForTimeout(400);
   let g = await gfx();
   check('context loss: veil instead of a white canvas', await page.locator('#gfx-lost').isVisible() && g.contextLost === true && g.losses === 1, { lost: g.contextLost, losses: g.losses });
   check('context loss: GPU facts still in ?diag', typeof g.gpu === 'string' && g.maxTex > 0 && /contextLost: true/.test(await page.evaluate(() => document.getElementById('gfx-diag').textContent)));
   check('context loss: next tier remembered', (await page.evaluate(() => localStorage.getItem('ks3d.gfxFallback'))) === 'medium');
   await page.evaluate(() => window.__loseExt.restoreContext());
   const t0 = Date.now();
   while (Date.now() - t0 < 8000 && !((g = await gfx()).probes > 1)) await page.waitForTimeout(250);
   const lit = (g.lastProbe || []).some((v, i) => i % 4 !== 3 && v > 8 && v < 240);
   check('context restored: veil gone, one tier lower, the scene draws again', !(await page.locator('#gfx-lost').count()) && g.tier === 'medium' && !g.contextLost && lit, { tier: g.tier, last: g.lastProbe });
   // (on a desktop the released pointer lock pauses the battle; "Weiter" goes on)
   check('context restored: still in the battle', await page.evaluate(() => ['playing', 'paused'].includes(window.__phase())));
   await page.screenshot({ path: 'tests/shots/3d-gfx-restored.png' });
   // lost for good: the reload button turns up
   await page.evaluate(() => window.__renderer3d.renderer.getContext().getExtension('WEBGL_lose_context').loseContext());
   await page.waitForTimeout(4500);
   check('context lost for good: reload button', await page.locator('#gfx-lost-reload').isVisible());
   await page.screenshot({ path: 'tests/shots/3d-gfx-lost.png' });
   await page.click('#gfx-lost-reload');
   await page.waitForLoadState('load'); await page.waitForTimeout(1000);
   check('reload starts on the remembered lower tier', (await gfx()).tier === 'low');
   await page.evaluate(() => localStorage.removeItem('ks3d.gfxFallback'));
   await ctx.close();
}
// no WebGL at all (Chrome locks it for a while after a page crashed the graphics): the loading screen
// explains it and offers a reload and the 2D version instead of animating forever
{
   const ctx = await browser.newContext({ viewport: { width: 915, height: 412 } });
   await ctx.addInitScript(() => {
      const get = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...a) { return /webgl/.test(kind) ? null : get.call(this, kind, ...a); };
   });
   const page = await ctx.newPage();
   await page.goto(URL, { waitUntil: 'load' });
   await page.waitForTimeout(1500);
   const fail = page.locator('#loading .ld-fail');
   check('no WebGL: the loading screen says so', await fail.isVisible() && /Keine 3D-Grafik/.test(await fail.textContent()), await fail.count() ? await fail.textContent() : 'none');
   const fits = await page.evaluate(() => [...document.querySelectorAll('#loading .ld-fail, #ld-retry, #loading .ld-act a')].every(e => {
      const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.height >= (e.matches('.ld-fail') ? 0 : 44);
   }));
   check('no WebGL: message and buttons fit a landscape phone', fits);
   await page.screenshot({ path: 'tests/shots/3d-gfx-nowebgl.png' });
   await page.click('#ld-retry');
   await page.waitForLoadState('load'); await page.waitForTimeout(800);
   check('no WebGL: "Neu laden" reloads', await page.locator('#loading').isVisible());
   await ctx.close();
}
{
   const { ctx, page, gfx } = await open('?gfx=low&diag');
   check('?gfx=low forces low', (await gfx()).tier === 'low');
   const txt = await page.evaluate(() => document.getElementById('gfx-diag')?.textContent || '');
   check('?diag shows the GPU box', /tier: low/.test(txt) && /gpu:/.test(txt), txt.slice(0, 80));
   await ctx.close();
}
await browser.close();
const failed = results.filter(r => !r.ok).length;
for (const e of errors.slice(0, 10)) console.log('CONSOLE ERROR ' + e);
console.log(`gfx: ${results.length - failed}/${results.length} checks passed, ${errors.length} console errors`);
process.exit(failed || errors.length ? 1 : 0);
