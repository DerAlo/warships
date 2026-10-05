// tests/playwrightv2.models.mjs — V2 model preview: builds every modern ship model at detail 0 and 3
// through the real builder (tests/v2-models.html, fixtures from tests/v2.modelfixtures.mjs), checks
// for exceptions, NaN bounds and zero size, records triangle / draw-call counts next to the WW2
// reference ships and saves a screenshot per model (side view above a three-quarter view).
// Usage: URLV2=http://localhost:8825 node tests/playwrightv2.models.mjs [key,key,...] [--detail=3] [--views=side,quarter]
const { chromium } = await import(process.env.PW_MODULE || 'playwright');
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = (process.env.URLV2 || 'http://localhost:8825').replace(/\/$/, '');
const OUT = process.env.SHOTS_OUT || 'tests/shots';
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const only = args.find(a => !a.startsWith('--'));
const shotDetail = Number(opt('detail', 3));
const views = opt('views', 'side,quarter').split(',');
const W = 1100, H = 520;
const REF = ['Bismarck', 'Fletcher'];

const errors = [];
const fails = [];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 500)); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
const open = async () => {
   await page.goto(`${BASE}/tests/v2-models.html`, { waitUntil: 'load' });
   await page.waitForFunction(() => window.__lab && window.__lab.frames > 2, null, { timeout: 240000 });
};
await open();

const keys = await page.evaluate(async () => Object.keys((await import('./v2.modelfixtures.mjs')).FIXTURES));
const airOnly = only === 'air';   // 'air' alone: just the aircraft line-up
const list = airOnly ? [] : only ? only.split(',') : keys.filter(k => !k.includes('_'));
const stats = {};
const settle = () => page.waitForFunction(() => window.__lab.frames > 3, null, { timeout: 120000 });
let n = 0;
const stitch = await browser.newPage({ viewport: { width: W, height: H * views.length } });

for (const key of [...(only ? [] : REF), ...list]) {
   stats[key] = {};
   if (n++ % 4 === 3) await open();   // a fresh page now and then: the software renderer slows down as discarded worlds pile up
   for (const det of only ? [shotDetail] : [0, 1, 2, 3]) {
      const st = await page.evaluate(([k, d]) => { try { return window.__lab.show(k, d); } catch (e) { return { error: String(e && e.stack || e) }; } }, [key, det]);
      if (st.error) { fails.push(`${key}@${det}: ${st.error}`); continue; }
      if (st.bad) fails.push(`${key}@${det}: ${st.bad} NaN vertices`);
      if (!(st.size[0] > 1 && st.size[1] > 0.5 && st.size[2] > 0.5)) fails.push(`${key}@${det}: zero size ${st.size}`);
      stats[key][det] = st;
      if (det !== shotDetail || REF.includes(key)) continue;
      const imgs = [];
      for (const v of views) {
         await page.evaluate(v => window.__lab.view(v), v);
         await settle();
         if (v === views[0]) stats[key].frame = await page.evaluate(() => window.__lab.frameInfo());
         imgs.push((await page.screenshot({ type: 'png' })).toString('base64'));
      }
      await stitch.setContent(`<body style="margin:0;background:#000">${imgs.map(b => `<img style="display:block" src="data:image/png;base64,${b}">`).join('')}</body>`);
      await stitch.screenshot({ path: `${OUT}/v2-model-${key}.png` });
   }
}

if (opt('air', '1') !== '0' && (!only || airOnly)) {
   // every aircraft model in a line, banking slightly, seen from the side and from above
   for (const det of [0, 3]) {
      const n = await page.evaluate(async (det) => {
         const { airFixtures } = await import('./v2.airfixtures.mjs');
         const list = airFixtures();
         window.__lab.air(det, list);
         window.__lab.R.debugView = { pos: [90, 176, 140], look: [90, 150, 0], fov: 40 };
         return list.length;
      }, det).catch(e => { fails.push('air: ' + e.message); return 0; });
      if (!n) continue;
      await settle();
      const a = (await page.screenshot({ type: 'png' })).toString('base64');
      await page.evaluate(() => { window.__lab.R.debugView = { pos: [90, 310, 4], look: [90, 150, 0], fov: 40 }; window.__lab.frames = 0; });
      await settle();
      const b = (await page.screenshot({ type: 'png' })).toString('base64');
      stats['air@' + det] = await page.evaluate(() => window.__lab.R.air.stats ? window.__lab.R.air.stats() : null);
      await stitch.setContent(`<body style="margin:0;background:#000"><img style="display:block" src="data:image/png;base64,${a}"><img style="display:block" src="data:image/png;base64,${b}"></body>`);
      await stitch.screenshot({ path: `${OUT}/v2-model-aircraft-d${det}.png` });
   }
}
await browser.close();

const row = (k) => `${k.padEnd(11)}` + [0, 1, 2, 3].map(d => stats[k][d] ? `${String(stats[k][d].tris).padStart(6)}/${String(stats[k][d].meshes).padEnd(2)}` : '     -   ').join(' ');
if (!only || airOnly) {
   console.log('model       d0 tris/draws  d1  d2  d3');
   for (const k of Object.keys(stats)) if (!k.startsWith('air@')) console.log(row(k));
   for (const k of Object.keys(stats)) if (k.startsWith('air@')) console.log(k, JSON.stringify(stats[k]));
   if (!only) writeFileSync(`${OUT}/v2-model-stats.json`, JSON.stringify(stats, null, 1));
   // phone tiers must not be heavier than the WW2 ships they stand next to
   for (const k of list) for (const d of [0, 1]) {
      const s = stats[k][d], ref = stats[s && s.size[0] > 135 ? 'Bismarck' : 'Fletcher'][d];
      if (s && ref && (s.tris > ref.tris || s.meshes > stats.Fletcher[d].meshes)) fails.push(`${k}@${d} heavier than WW2 reference: ${s.tris}/${s.meshes}`);
   }
}
for (const e of errors) console.log(e);
for (const f of fails) console.log('FAIL ' + f);
console.log(errors.length || fails.length ? `FAILED (${errors.length} console errors, ${fails.length} checks)` : `OK ${list.length} models`);
process.exit(errors.length || fails.length ? 1 : 0);
