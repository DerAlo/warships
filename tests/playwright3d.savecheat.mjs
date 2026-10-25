// tests/playwright3d.savecheat.mjs -- port cheat (ten clicks on the logo) and save file export /
// import, in V1 (index-3d.html) and V2 (index-v2.html). Exit code 1 on a failed check or console error.
//
// Run:  node server.js 8771   then   BASE=http://localhost:8771 node tests/playwright3d.savecheat.mjs
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import * as CFG2 from '../gamev2/config.js';

const BASE = process.env.BASE || 'http://localhost:8771';
const OUT = process.env.OUT || 'tests/shots';
mkdirSync(OUT, { recursive: true });
const errors = [], results = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   if (!ok || process.env.VERBOSE) console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};
const browser = await chromium.launch({ args: process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const hook = (page) => {
   page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
   page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
};
const cheatShips = CFG2.CHEAT_SHIPS || [];

for (const [tag, page0, key] of [['V1', 'index-3d.html', 'warships3d'], ['V2', 'index-v2.html', 'warshipsv2']]) {
   const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 }, acceptDownloads: true });
   const page = await ctx.newPage(); hook(page);
   await page.goto(`${BASE}/${page0}`);
   await page.waitForSelector('.m3-card');
   const before = await page.evaluate(() => ({ won: document.querySelectorAll('.m3-mis .done').length, xp: document.querySelector('.m3-purse b')?.textContent }));
   // nine clicks do nothing, a pause resets the count
   for (let i = 0; i < 9; i++) await page.click('.m3-logo');
   await page.waitForTimeout(1700);
   await page.click('.m3-logo');
   check(`${tag} nine clicks + pause: no cheat`, !(await page.$('.m3-toast')));
   for (let i = 0; i < 10; i++) await page.click('.m3-logo');
   const after = await page.evaluate((key) => {
      const pf = JSON.parse(localStorage.getItem(key + '.profile.v1') || '{}'), pr = JSON.parse(localStorage.getItem(key + '.progress.v1') || '{}');
      return {
         toast: document.querySelector('.m3-toast')?.textContent || '', notWon: [...document.querySelectorAll('.m3-mis')].filter(e => !e.querySelector('.done') && !e.querySelector('.m3-medal')).length,
         medalsOff: document.querySelectorAll('.m3-mis .m3-medal i:not(.on)').length, medals: document.querySelectorAll('.m3-mis .m3-medal').length,
         cheat: pf.cheat, skills: (pf.skills || []).length, missions: Object.values(pr.missions || {}).filter(r => r.won).length, nMis: document.querySelectorAll('.m3-mis').length,
         capt: document.querySelector('[data-act="captain"] b')?.textContent,
      };
   }, key);
   check(`${tag} ten clicks: cheat applied`, /freigeschaltet/.test(after.toast) && after.cheat === true && after.skills >= 10 && after.capt === '11', after);
   check(`${tag} every mission won, every operation with three clasps`, after.notWon === 0 && after.medalsOff === 0 && after.missions === after.nMis && after.nMis > 10, { ...after, before });
   await page.click('[data-mis="standard"]');
   await page.click('.m3-tabs [data-nat="all"]');
   const locks = await page.evaluate(() => ({ lock: document.querySelectorAll('.m3-card.lock').length, cards: document.querySelectorAll('.m3-card').length }));
   check(`${tag} no ship locked in a normal battle`, locks.lock === 0, locks);
   if (tag === 'V2' && cheatShips.length) {
      const has = await page.evaluate((ks) => ks.every(k => document.querySelector(`.m3-card[data-ship="${k}"]:not(.off):not(.lock)`)), cheatShips);
      check('V2 cheat: prototype ships selectable in a normal battle', has, cheatShips);
   }
   await page.screenshot({ path: `${OUT}/savecheat-${tag}-port.png` });
   // export
   await page.click('[data-act="captain"]');
   await page.screenshot({ path: `${OUT}/savecheat-${tag}-captain.png` });
   const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-cap="export"]')]);
   const file = `${OUT}/savecheat-${tag}.json`;
   await dl.saveAs(file);
   const save = JSON.parse(readFileSync(file, 'utf8'));
   check(`${tag} export: file name and content`, /^kriegsschiffe-speicherstand-\d{4}-\d\d-\d\d\.json$/.test(dl.suggestedFilename()) && JSON.parse(save.data[key + '.profile.v1']).cheat === true, dl.suggestedFilename());
   await ctx.close();

   // import into a fresh profile
   const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 810 } });
   const p2 = await ctx2.newPage(); hook(p2);
   await p2.goto(`${BASE}/${page0}`);
   await p2.waitForSelector('.m3-card');
   await p2.click('[data-act="captain"]');
   // a broken file: message, nothing changes
   let [fc] = await Promise.all([p2.waitForEvent('filechooser'), p2.click('[data-cap="import"]')]);
   await fc.setFiles({ name: 'kaputt.json', mimeType: 'application/json', buffer: Buffer.from('{"hallo":1}') });
   await p2.waitForSelector('.m3-savemsg');
   check(`${tag} import of a foreign file is refused`, /kein Kriegsschiffe-Speicherstand/.test(await p2.textContent('.m3-savemsg')));
   [fc] = await Promise.all([p2.waitForEvent('filechooser'), p2.click('[data-cap="import"]')]);
   await Promise.all([p2.waitForEvent('load'), fc.setFiles(file)]);
   await p2.waitForSelector('.m3-card');
   const imp = await p2.evaluate(() => ({ capt: document.querySelector('[data-act="captain"] b')?.textContent, done: document.querySelectorAll('.m3-mis .done').length + document.querySelectorAll('.m3-mis .m3-medal i.on').length }));
   check(`${tag} import restores the career after the reload`, imp.capt === '11' && imp.done > 3, imp);
   await ctx2.close();
}
await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed, ${errors.length} console errors`);
for (const e of errors.slice(0, 20)) console.log('  ERR ' + e);
process.exit(failed.length || errors.length ? 1 : 0);
