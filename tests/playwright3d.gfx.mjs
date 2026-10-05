// tests/playwright3d.gfx.mjs -- graphics quality tiers (game3d/gfxquality.js): desktop starts on "high", a touch
// device on "medium", ?gfx=low forces the low tier (no bloom, no MSAA, pixel ratio 1), the pause-menu select switches
// live, ?diag shows the GPU box, and the blank-frame watchdog steps down when every frame comes out white.
// Also: "ultra" is a real step above "high", the single options behind "Erweitert" (custom values: stored, applied
// on start, dropped by a tier choice and by a watchdog step-down), and the smoke-screen overdraw budget.
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
const HIGH = { pr: 2, samples: 4, bloom: true, bloomLevels: 5, shadow: 4096, shadowFit: 1, oceanSegs: 256, detail: 2, effects: 2 };
const same = (a, b) => Object.keys(b).every(k => a[k] === b[k]);
// set a pause-menu control the way the player does
const pick = (page, id, value) => page.evaluate(([id, value]) => {
   const e = document.getElementById(id);
   if (e.type === 'checkbox') e.checked = value; else e.value = String(value);
   e.dispatchEvent(new Event('change'));
}, [id, value]);
const stored = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

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
   check('high is the tier it was', same(g.options, HIGH) && g.custom === false && g.detail === 2 && g.effects === 2, g.options);
   // ultra: above high in every respect the GPU allows
   await page.evaluate(() => window.__setGfx('ultra'));
   await page.waitForTimeout(500);
   g = await gfx();
   check('ultra: MSAA 8 (or the GPU maximum), deeper bloom, tight shadow box, detail and effects 3',
      g.tier === 'ultra' && g.samples === Math.min(8, g.maxSamples) && g.samples > 4 && g.bloom && g.bloomLevels === 6 && g.shadow === 4096 && g.shadowFit < 1 && g.detail === 3 && g.effects === 3,
      { samples: g.samples, max: g.maxSamples, bloomLevels: g.bloomLevels, fit: g.shadowFit, detail: g.detail, effects: g.effects });
   check('ultra: still a normal frame', await page.evaluate(async () => {
      await new Promise(r => setTimeout(r, 2500));
      const s = window.__gfx();
      return s.tier === 'ultra' && s.probes > 0 && s.blankStrikes === 0;
   }));
   await pick(page, 'opt-gfx', 'ultra');
   await page.waitForTimeout(300);
   check('pause select offers Ultra and stores it', (await gfx()).tier === 'ultra' && (await stored(page, 'ks3d.gfx')) === 'ultra');

   // single options ("Erweitert"): a tier fills them in, changing one makes the choice custom
   await pick(page, 'opt-gfx', 'high');
   await page.waitForTimeout(300);
   const ui = () => page.evaluate(() => Object.fromEntries(['opt-gfx', 'gfx-pr', 'gfx-aa', 'gfx-shadow', 'gfx-effects', 'gfx-detail', 'gfx-ocean'].map(id => [id, document.getElementById(id).value]).concat([['gfx-bloom', document.getElementById('gfx-bloom').checked]])));
   let u = await ui();
   check('a tier fills in the single options', u['opt-gfx'] === 'high' && u['gfx-aa'] === '4' && u['gfx-bloom'] === true && u['gfx-shadow'] === 'high' && u['gfx-effects'] === '2' && u['gfx-detail'] === '2' && u['gfx-ocean'] === '256', u);
   await pick(page, 'gfx-aa', 2);
   await pick(page, 'gfx-bloom', false);
   await pick(page, 'gfx-shadow', 'low');
   await pick(page, 'gfx-effects', 0);
   await pick(page, 'gfx-detail', 3);
   await pick(page, 'gfx-ocean', 320);
   await page.waitForTimeout(400);
   g = await gfx(); u = await ui();
   const cust = JSON.parse((await stored(page, 'ks3d.gfxCustom')) || 'null');
   check('single options apply live', g.custom === true && g.tier === 'high' && g.samples === 2 && g.bloom === false && g.shadow === 1024 && g.effects === 0 && g.detail === 3,
      { custom: g.custom, samples: g.samples, bloom: g.bloom, shadow: g.shadow, effects: g.effects, detail: g.detail });
   check('GFX.detail / GFX.effects hold the custom values', await page.evaluate(async () => { const m = await import('./game3d/gfxquality.js'); return m.GFX.detail === 3 && m.GFX.effects === 0 && m.GFX.tier === 'high'; }));
   check('the tier select reads "Benutzerdefiniert"', u['opt-gfx'] === 'custom' && await page.evaluate(() => { const s = document.getElementById('opt-gfx'); return s.selectedOptions[0].textContent === 'Benutzerdefiniert' && !s.selectedOptions[0].hidden; }), u['opt-gfx']);
   check('custom options are stored', !!cust && cust.base === 'high' && cust.samples === 2 && cust.bloom === false && cust.shadow === 1024 && cust.effects === 0 && cust.detail === 3 && cust.oceanSegs === 320, cust);
   check('ocean density waits for the reload', g.options.oceanSegs === 320 && g.oceanSegs === 256, { asked: g.options.oceanSegs, built: g.oceanSegs });
   await page.reload({ waitUntil: 'load' });
   await page.waitForTimeout(1200);
   g = await gfx(); u = await ui();
   check('custom options apply on the next start', g.custom === true && g.tier === 'high' && g.samples === 2 && g.bloom === false && g.shadow === 1024 && g.effects === 0 && g.detail === 3 && g.oceanSegs === 320 && u['opt-gfx'] === 'custom' && u['gfx-aa'] === '2' && u['gfx-ocean'] === '320',
      { custom: g.custom, samples: g.samples, bloom: g.bloom, shadow: g.shadow, ocean: g.oceanSegs, sel: u['opt-gfx'] });
   await pick(page, 'opt-gfx', 'high');
   await page.waitForTimeout(300);
   g = await gfx();
   check('choosing a tier drops the custom options', g.custom === false && same(g.options, HIGH) && g.samples === 4 && g.bloom === true && (await stored(page, 'ks3d.gfxCustom')) === null
      && await page.evaluate(() => document.getElementById('opt-gfx').querySelector('[value=custom]').hidden), g.options);
   await page.evaluate(() => localStorage.setItem('ks3d.gfxCustom', '{"base":"high","samples":7,"pr":"x","effects":99,"shadow":4096'));
   await page.reload({ waitUntil: 'load' });
   await page.waitForTimeout(1000);
   g = await gfx();
   check('a damaged custom entry is ignored', g.tier === 'high' && g.custom === false && same(g.options, HIGH), g.options);
   await page.evaluate(() => localStorage.removeItem('ks3d.gfxCustom'));
   // pause-menu select stores the choice
   await page.evaluate(() => { const s = document.getElementById('opt-gfx'); s.value = 'medium'; s.dispatchEvent(new Event('change')); });
   await page.waitForTimeout(300);
   g = await gfx();
   check('pause select sets medium and stores it', g.tier === 'medium' && (await page.evaluate(() => localStorage.getItem('ks3d.gfx'))) === 'medium', g.tier);
   await page.evaluate(() => { const s = document.getElementById('opt-gfx'); s.value = 'auto'; s.dispatchEvent(new Event('change')); });
   check('auto clears the stored choice', (await page.evaluate(() => localStorage.getItem('ks3d.gfx'))) === null);

   // watchdog: paint every finished frame white -> steps down to medium, then low, and remembers it;
   // custom options on top of "high" go with the first step
   await page.evaluate(() => window.__renderer3d.setTier('high'));
   await pick(page, 'gfx-aa', 2);
   g = await gfx();
   check('custom on top of auto', g.custom === true && g.tier === 'high' && (await stored(page, 'ks3d.gfxCustom')) !== null && (await stored(page, 'ks3d.gfx')) === null);
   await page.evaluate(() => {
      const R = window.__renderer3d, post = R.post, orig = post.render.bind(post);
      post.render = (...a) => { orig(...a); const gl = R.renderer.getContext(); gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT); };
   });
   const t0 = Date.now();
   while (Date.now() - t0 < 15000 && (await gfx()).tier !== 'low') await page.waitForTimeout(250);
   g = await gfx();
   check('white frames step the tier down to low', g.tier === 'low', { tier: g.tier, last: g.lastProbe });
   check('the step-down discards the custom options', g.custom === false && g.samples === 0 && g.options.samples === 0 && (await stored(page, 'ks3d.gfxCustom')) === null
      && (await page.evaluate(() => document.getElementById('gfx-aa').value)) === '0', { custom: g.custom, samples: g.samples });
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
// a 3x screen: high stops at pixel ratio 2, ultra renders the device's own resolution
{
   const { ctx, page, gfx } = await open('', { viewport: { width: 960, height: 540 }, deviceScaleFactor: 3 });
   let g = await gfx();
   check('3x screen: high renders at pixel ratio 2', g.tier === 'high' && g.pixelRatio === 2, { tier: g.tier, pr: g.pixelRatio });
   await page.evaluate(() => window.__setGfx('ultra'));
   await page.waitForTimeout(500);
   g = await gfx();
   const buf = await page.evaluate(() => { const gl = window.__renderer3d.renderer.getContext(); return [gl.drawingBufferWidth, gl.drawingBufferHeight]; });
   check('3x screen: ultra renders at pixel ratio 3', g.pixelRatio === 3 && buf[0] === 2880 && buf[1] === 1620, { pr: g.pixelRatio, buf });
   await pick(page, 'gfx-pr', 1);
   await page.waitForTimeout(300);
   g = await gfx();
   check('resolution option: 1x on a 3x screen', g.custom === true && g.pixelRatio === 1 && g.samples === Math.min(8, g.maxSamples), { pr: g.pixelRatio, samples: g.samples });
   await page.evaluate(() => localStorage.removeItem('ks3d.gfxCustom'));
   await ctx.close();
}
// the pause menu with the graphics options open on a landscape phone: everything reachable, 44 px targets
{
   const { ctx, page } = await open('?nohint', { viewport: { width: 740, height: 360 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
   await page.evaluate(() => { document.getElementById('pause').classList.remove('hidden'); document.getElementById('gfx-adv').open = true; });
   await page.waitForTimeout(300);
   const lay = await page.evaluate(() => {
      const card = document.querySelector('#pause .card'), cr = card.getBoundingClientRect();
      const ctl = [...card.querySelectorAll('#opt-gfx, #gfx-adv summary, #gfx-adv select, #gfx-adv .check-row')];
      const bad = [];
      for (const e of ctl) {
         e.scrollIntoView({ block: 'nearest' });
         const r = e.getBoundingClientRect();
         if (r.height < 44 || r.width < 44 || r.left < cr.left || r.right > cr.right || r.top < cr.top - 1 || r.bottom > cr.bottom + 1) bad.push([e.id || e.tagName, Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]);
      }
      return { touch: document.body.classList.contains('touch'), n: ctl.length, bad, card: [Math.round(cr.left), Math.round(cr.top), Math.round(cr.right), Math.round(cr.bottom)], vw: innerWidth, vh: innerHeight, scrollX: card.scrollWidth > card.clientWidth + 1 };
   });
   check('phone: graphics options fit the pause card with 44 px targets', lay.touch && lay.n === 9 && !lay.bad.length && lay.card[0] >= 0 && lay.card[1] >= 0 && lay.card[2] <= lay.vw && lay.card[3] <= lay.vh && !lay.scrollX, lay);
   await page.screenshot({ path: 'tests/shots/3d-gfx-options-phone.png' });
   await ctx.close();
}
// smoke screens: a destroyer's screen is ~800 big puffs; with the camera inside, most of them are culled or
// thinned out (the overdraw budget of fx3d.js), from afar all of them are drawn; fewer puffs at effects 0
{
   const { ctx, page } = await open('?gfx=high');
   await page.evaluate(() => window.__start({ difficulty: 'easy', mission: 'standard', ship: 'Z23' }));
   await page.waitForFunction(() => window.__phase() === 'playing');
   await page.waitForTimeout(1200);
   const smoke = (view) => page.evaluate(async (view) => {
      const w = window.__world(), P = w.player, R = window.__renderer3d;
      for (const s of w.ships) if (s !== P) { s.pos.x = P.pos.x + 30000; s.pos.y = P.pos.y + 30000; }
      w.smokeClouds.length = 0;
      for (let i = 0; i < 18; i++) w.addSmoke({ c: { x: P.pos.x + 200 + i * 20, y: P.pos.y + 600 }, r: 450, maxR: 450, life: 600, side: P.side, ownerId: P.id });
      for (const c of w.smokeClouds) c.age = 10;
      R.debugView = view === 'inside'
         ? { pos: [P.pos.x + 380, 30, P.pos.y + 600], look: [P.pos.x + 800, 40, P.pos.y + 650], fov: 58 }
         : { pos: [P.pos.x + 370, 120, P.pos.y - 2600], look: [P.pos.x + 370, 60, P.pos.y + 600], fov: 58 };
      await new Promise(r => setTimeout(r, 700));
      const s = R.fx._smk;
      return { clouds: w.smokeClouds.length, drawn: s.n, layers: Math.round(s.cov * 10) / 10, keep: Math.round(s.keep * 1000) / 1000, culled: s.culled };
   }, view);
   const far = await smoke('far');
   check('smoke from afar: every puff drawn, under the budget', far.clouds === 18 && far.drawn === 18 * 44 && far.keep === 1 && far.culled === 0, far);
   const ins = await smoke('inside');
   check('camera inside the smoke: puffs culled and thinned to the budget', ins.culled > 100 && ins.keep < 0.5 && ins.drawn < 200 && ins.layers > 16, ins);
   await page.evaluate(() => window.__setGfxOpt({ effects: 0 }));
   const far0 = await smoke('far');
   check('effects 0: half the smoke puffs', far0.drawn === 18 * 22 && far0.keep === 1, far0);
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
   // (the ?diag box refreshes once a second)
   await page.waitForFunction(() => /contextLost: true/.test(document.getElementById('gfx-diag')?.textContent || ''), null, { timeout: 3000 }).catch(() => {});
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
