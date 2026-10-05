// tests/playwrightv2.perf.mjs -- frame cost of V2 (index-v2.html) next to the WW2 game (index-3d.html).
// Like with like: the same headless browser, the same viewport and graphics tier, frame rate uncapped.
// Phone tiers (medium, low) at 844x390 with touch, desktop tier high at 1440x810. For every scene: mean and
// p95 frame time, draw calls and triangles per frame (renderer.info, all passes of one frame).
// Scenes: WW2 fleet fight at gun range, WW2 carrier battle with squadrons up, V2 idle at sea, V2 fleet fight
// with 20+ missiles in the air and the air defence answering, redsea under a full salvo, countdown during the
// detonation, philsea with the air group up. Headless numbers are not phone numbers: only the ratios count.
// Exit code 1 when a scene did not really run, when a phone tier of V2 draws clearly more than the WW2 game,
// or on a console error. Screenshots go to tests/shots/v2-perf-<tier>-<scene>.png.
//
// Run:  node server.js 8838   then   URLV2=http://localhost:8838/index-v2.html node tests/playwrightv2.perf.mjs
//       (ONLY=medium,low,high to limit the tiers; SCENES=ww2,idle,fleet,redsea,countdown,philsea; NO_GPU=1 for software GL)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.URLV2 || 'http://localhost:8838/index-v2.html';
const URL3D = process.env.URL3D || URL.replace('index-v2.html', 'index-3d.html');
const OUT = process.env.OUT || 'tests/shots';
const ONLY = (process.env.ONLY || 'medium,low,high').split(',');
const SCENES = (process.env.SCENES || 'ww2,idle,fleet,redsea,countdown,philsea').split(',');
const MS = +(process.env.MS || 6000);
mkdirSync(OUT, { recursive: true });
const errors = [], results = [], rows = [];
const check = (name, ok, info = '') => {
   results.push({ name, ok: !!ok });
   console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== '' ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''));
};
const GPU = process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ args: [...GPU, '--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-precise-memory-info'] });

const VIEW = {
   medium: { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 },
   low: { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 },
   high: { viewport: { width: 1440, height: 810 } },
};

async function open(tag, url, tier, start) {
   const ctx = await browser.newContext(VIEW[tier]);
   const page = await ctx.newPage();
   page.on('console', m => { if (m.type() === 'error') errors.push(tag + ': ' + m.text().slice(0, 300)); });
   page.on('pageerror', e => errors.push(tag + ' PAGEERROR: ' + e.message + ' ' + String(e.stack || '').split('\n').slice(1, 3).join(' | ')));
   await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = function () { return Promise.reject(new Error('blocked by test')); }; });
   await page.goto(url + '?nohint&gfx=' + tier, { waitUntil: 'load' });
   await page.waitForFunction(() => typeof window.__phase === 'function' && window.__phase() === 'menu', null, { timeout: 30000 });
   await page.evaluate(o => window.__start(o), start);
   await page.waitForFunction(() => window.__phase() === 'playing', null, { timeout: 30000 });
   await page.waitForTimeout(2500);
   // the ships of the player's side live through the scene, so the battle does not end under the measurement
   await page.evaluate(() => {
      const w = window.__world();
      window.__keepAlive = setInterval(() => { for (const s of w.ships) if (s.alive && s.side === w.player.side) s.hp = s.maxHP; }, 100);
   });
   return { page, ctx };
}

// frame times, draw calls and triangles over ms; `probe` is evaluated every frame for the scene's own counters
const sample = (page, ms) => page.evaluate((ms) => new Promise(res => {
   const R = window.__renderer3d, I = R.renderer.info, w = window.__world();
   const d = []; let calls = 0, tris = 0, cMax = 0, tMax = 0, n = 0, mis = 0, misMax = 0, samMax = 0, sqMax = 0, airMax = 0;
   let last = performance.now(); const t0 = last;
   // garbage and DOM writes per frame: heap growth between two frames (drops are collections), mutation records
   let heap = performance.memory ? performance.memory.usedJSHeapSize : 0, alloc = 0, gcs = 0, muts = 0;
   const mo = new MutationObserver(l => { muts += l.length; });
   mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
   const f = (t) => {
      d.push(t - last); last = t;
      if (performance.memory) { const h = performance.memory.usedJSHeapSize; if (h > heap) alloc += h - heap; else if (h < heap - 65536) gcs++; heap = h; }
      const c = I.render.calls, k = I.render.triangles;
      calls += c; tris += k; n++; if (c > cMax) cMax = c; if (k > tMax) tMax = k;
      const ms_ = w.missiles || [];
      let sam = 0; for (const m of ms_) if (m.kind === 'sam') sam++;
      mis += ms_.length; if (ms_.length > misMax) misMax = ms_.length; if (sam > samMax) samMax = sam;
      const sq = (w.squadrons || []).length; if (sq > sqMax) sqMax = sq;
      const ad = R.air ? R.air.drawn || 0 : 0; if (ad > airMax) airMax = ad;
      if (t - t0 < ms) return requestAnimationFrame(f);
      d.shift(); d.sort((a, b) => a - b);
      muts += mo.takeRecords().length; mo.disconnect();
      res({ allocKB: +(alloc / n / 1024).toFixed(1), gcs, muts: +(muts / n).toFixed(2), heapMB: +(heap / 1048576).toFixed(1), n: d.length, mean: +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(2), p95: +d[Math.floor(d.length * 0.95)].toFixed(2),
         calls: Math.round(calls / n), callsMax: cMax, tris: Math.round(tris / n), trisMax: tMax,
         missiles: Math.round(mis / n), missilesMax: misMax, samMax, sqMax, airMax, phase: window.__phase(),
         mem: { geo: I.memory.geometries, tex: I.memory.textures, prog: I.programs ? I.programs.length : 0 }, dom: document.getElementsByTagName('*').length });
   };
   requestAnimationFrame(f);
}), ms);

// ---- scene set-ups (run in the page) ---------------------------------------------------------------
// every hostile ship onto a ring around the player, so the whole battle is in view and in range
const ring = (page, r0, r1) => page.evaluate(([r0, r1]) => {
   const w = window.__world(), p = w.player; let i = 0;
   const foes = w.ships.filter(s => s.alive && s.side !== p.side);
   for (const s of foes) {
      const a = p.heading - 0.7 + 1.4 * (foes.length > 1 ? i / (foes.length - 1) : 0.5), r = r0 + (r1 - r0) * ((i * 7) % 5) / 4; i++;
      s.pos.x = p.pos.x + Math.cos(a) * r; s.pos.y = p.pos.y + Math.sin(a) * r;
      if (s.prev) { s.prev.x = s.pos.x; s.prev.y = s.pos.y; }
      s.detected = true; s.visible = true;
   }
   window.__setAim(0, (r0 + r1) / 2);
   return foes.length;
}, [r0, r1]);
// hostile batteries around the player fire `n` anti-ship missiles in all; with keep > 0 the salvo is topped up
const salvo = (page, n, keep = 0) => page.evaluate(async ([n, keep]) => {
   const w = window.__world(), p = w.player, M = await import('./gamev2/missile.js'), St = await import('./gamev2/sites.js');
   const spots = [[10500, -5500], [9000, 7500], [12500, 800]];
   const sites = spots.map(([dx, dy]) => {
      const c = Math.cos(p.heading), s = Math.sin(p.heading);
      return St.addSite(w, 'battery', 'enemy', { x: p.pos.x + c * dx - s * dy, y: p.pos.y + s * dx + c * dy });
   });
   let k = 0;
   const fire = (m) => {
      for (let i = 0; i < m; i++) {
         const site = sites[k++ % sites.length]; site.lastSsmFire = -99; site.hp = site.maxHP; site.alive = true;
         if (site.mag) for (const q in site.mag) site.mag[q] = 99;
         const brg = Math.atan2(p.pos.y - site.pos.y, p.pos.x - site.pos.x);
         M.launchSSM(w, site, { bearing: brg + ((k % 7) - 3) * 0.02 });
      }
   };
   fire(n);
   // the player's side answers: outbound missiles as well
   const tgt = w.ships.find(s => s.alive && s.side !== p.side);
   for (let i = 0; i < 6; i++) { p.lastSsmFire = -99; if (p.mag) for (const q in p.mag) p.mag[q] = Math.max(p.mag[q], 8); M.launchSSM(w, p, tgt ? { targetId: tgt.id } : { bearing: p.heading }); }
   if (keep) window.__topUp = setInterval(() => { const a = w.missiles.filter(m => m.kind !== 'sam').length; if (a < keep) fire(keep - a); }, 400);
   return w.missiles.length;
}, [n, keep]);

// every carrier puts its whole air group up: strike flights at the nearest hostile ship, fighters on patrol ahead
const airUp = async (page, mod) => {
   for (const type of ['ft', 'db', 'tb']) {
      await page.evaluate(async ([mod, type]) => {
         const w = window.__world(), A = await import(mod);
         for (const s of w.ships) if (s.alive && s.air) {
            let foe = null, best = 1e12;
            for (const e of w.ships) if (e.alive && e.side !== s.side) { const d = Math.hypot(e.pos.x - s.pos.x, e.pos.y - s.pos.y); if (d < best) { best = d; foe = e; } }
            s.air.deckT = 0;
            const ahead = { x: s.pos.x + Math.cos(s.heading) * 1800, y: s.pos.y + Math.sin(s.heading) * 1800 };
            A.launchSquadron(w, s, type, type === 'ft' || !foe ? { kind: 'patrol', pos: ahead } : { kind: 'strike', targetId: foe.id });
         }
      }, [mod, type]);
      await page.waitForTimeout(2500);
   }
   await page.waitForTimeout(3500);
};

const SCENE = {
   // WW2: the standard battle, both fleets at gun range and firing
   'ww2-fight': { url: URL3D, start: { mission: 'standard', ship: 'Bismarck', difficulty: 'normal' }, setup: async page => { await ring(page, 4500, 8000); await page.waitForTimeout(7000); } },
   // WW2: carrier battle with every squadron of the player's carrier in the air
   'ww2-carrier': { url: URL3D, start: { mission: 'midway', difficulty: 'normal' }, setup: page => airUp(page, './game3d/air.js') },
   'v2-idle': { url: URL, start: { mission: 'training', ship: 'Burke', difficulty: 'normal' }, setup: async page => {
      await page.evaluate(() => { const w = window.__world(); for (const s of w.ships) if (s.side !== w.player.side) s.telegraph = 0; w.bots.length = 0; window.__setAim(0, 5000); });
      await page.waitForTimeout(1500);
   } },
   'v2-fleet': { url: URL, start: { mission: 'standard', ship: 'Burke', difficulty: 'normal' }, setup: async page => { await ring(page, 9000, 14000); await salvo(page, 24, 22); await page.waitForTimeout(3500); } },
   'v2-redsea': { url: URL, start: { mission: 'redsea', difficulty: 'normal' }, setup: async page => { await salvo(page, 24); await page.waitForTimeout(3000); } },
   'v2-countdown': { url: URL, start: { mission: 'countdown', difficulty: 'normal' }, setup: async page => {
      await page.evaluate(async () => {
         const w = window.__world(), p = w.player, B = await import('./gamev2/blast.js');
         window.__b = B.addBlast(w, { x: p.pos.x + Math.cos(p.heading) * 6000, y: p.pos.y + Math.sin(p.heading) * 6000, radius: 3000, delay: 0.3, label: 'Test' });
         window.__setAim(0, 6000);
      });
      await page.waitForFunction(() => window.__b.state === 'done', null, { timeout: 8000 });
   } },
   'v2-philsea': { url: URL, start: { mission: 'philsea', ship: 'Ford', difficulty: 'normal' }, setup: page => airUp(page, './gamev2/air.js') },
};
const WANT = n => SCENES.includes(n.startsWith('ww2') ? 'ww2' : n.slice(3));

const stats = {};
for (const tier of ['medium', 'low', 'high']) {
   if (!ONLY.includes(tier)) continue;
   stats[tier] = {};
   for (const [name, sc] of Object.entries(SCENE)) {
      if (!WANT(name)) continue;
      const tag = tier + '/' + name;
      const { page, ctx } = await open(tag, sc.url, tier, sc.start);
      await sc.setup(page);
      const g = await page.evaluate(() => { const g = window.__gfx(); return { tier: g.tier, pr: g.pixelRatio, gpu: g.gpu }; });
      const s = await sample(page, MS);
      await page.screenshot({ path: `${OUT}/v2-perf-${tier}-${name}.png` });
      stats[tier][name] = s; s.gpu = g.gpu; s.pr = g.pr;
      rows.push([tier, name, s.mean, s.p95, s.calls, s.callsMax, s.tris, s.trisMax, s.missilesMax, s.samMax, s.sqMax, s.mem.geo, s.mem.tex, s.dom, s.allocKB, s.muts]);
      console.log(`ROW ${tag}  mean ${s.mean} ms  p95 ${s.p95} ms  calls ${s.calls} (max ${s.callsMax})  tris ${s.tris} (max ${s.trisMax})  missiles ${s.missiles}/${s.missilesMax} sam ${s.samMax} squadrons ${s.sqMax} planes drawn ${s.airMax}  geo ${s.mem.geo} tex ${s.mem.tex} dom ${s.dom}  garbage ${s.allocKB} KB/frame (${s.gcs} collections)  DOM writes ${s.muts}/frame  phase ${s.phase}  pr ${g.pr}`);
      check(`${tag}: runs on the asked tier, still in the battle`, g.tier === tier && s.phase === 'playing', { tier: g.tier, phase: s.phase });
      if (name === 'v2-fleet') check(`${tag}: 20+ missiles in the air and SAMs flying`, s.missilesMax >= 20 && s.samMax >= 1, { missiles: s.missilesMax, sam: s.samMax });
      if (name === 'v2-redsea') check(`${tag}: full salvo in the air`, s.missilesMax >= 20, { missiles: s.missilesMax, sam: s.samMax });
      if (name === 'v2-countdown') check(`${tag}: the detonation is drawn`, await page.evaluate(() => window.__renderer3d.blast.active === 1 && window.__renderer3d.blast.lobes > 3));
      if (name === 'v2-philsea' || name === 'ww2-carrier') check(`${tag}: squadrons are up and drawn`, s.sqMax >= 2 && s.airMax >= 4, { squadrons: s.sqMax, drawn: s.airMax });
      await ctx.close();
   }
}
await browser.close();

console.log('\nGPU: ' + (Object.values(stats).flatMap(t => Object.values(t))[0]?.gpu || '?') + '   (headless Chromium, frame rate uncapped' + (process.env.NO_GPU ? ', software GL' : '') + ')');
console.log('tier    scene          mean ms  p95 ms  calls  (max)   tris     (max)   missiles sam sq  geo  tex  dom  KB/frame DOM/frame');
for (const r of rows) console.log(r[0].padEnd(8) + r[1].padEnd(14) + String(r[2]).padStart(8) + String(r[3]).padStart(8) + String(r[4]).padStart(7) + String(r[5]).padStart(7) + String(r[6]).padStart(9) + String(r[7]).padStart(9) + String(r[8]).padStart(8) + String(r[9]).padStart(5) + String(r[10]).padStart(4) + String(r[11]).padStart(5) + String(r[12]).padStart(5) + String(r[13]).padStart(6) + String(r[14]).padStart(9) + String(r[15]).padStart(8));

// phones must not get heavier than the WW2 game: every V2 scene against the heavier of the two WW2 scenes
for (const tier of ['medium', 'low']) {
   const t = stats[tier]; if (!t || !t['ww2-fight']) continue;
   const ww = [t['ww2-fight'], t['ww2-carrier']].filter(Boolean);
   const ref = { calls: Math.max(...ww.map(s => s.callsMax)), tris: Math.max(...ww.map(s => s.trisMax)), mean: Math.max(...ww.map(s => s.mean)) };
   for (const [name, s] of Object.entries(t)) {
      if (!name.startsWith('v2')) continue;
      check(`${tier}/${name}: draw calls not above the WW2 game (+10 %)`, s.callsMax <= ref.calls * 1.1, { v2: s.callsMax, ww2: ref.calls });
      check(`${tier}/${name}: triangles not above the WW2 game (+10 %)`, s.trisMax <= ref.tris * 1.1, { v2: s.trisMax, ww2: ref.tris });
      check(`${tier}/${name}: mean frame time not above the WW2 game (+15 % and 1 ms)`, s.mean <= ref.mean * 1.15 + 1, { v2: s.mean, ww2: ref.mean });
   }
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed, console errors: ${errors.length}`);
for (const e of errors.slice(0, 12)) console.log('  ERR ' + e);
process.exit(failed.length || errors.length ? 1 : 0);
