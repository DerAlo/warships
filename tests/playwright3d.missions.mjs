// tests/playwright3d.missions.mjs -- smoke sweep for the 3D mode: starts every mission (cycling
// the playable ships), drives, fires guns and torpedoes, uses every consumable, opens map /
// scoreboard / binoculars / lock, renders a couple of real frames and screenshots each mission.
// Exit code 1 on any console error. The 3D draw is skipped between screenshots (window.__setRender)
// because headless software GL is slow. Missions or ships unknown to the sim fall back silently.
//
// Run:  node server.js 5173   then   node tests/playwright3d.missions.mjs
//       (URL3D=..., OUT=..., MISSIONS=a,b,..., SHIPS=a,b,... to override)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const URL = process.env.URL3D || 'http://localhost:5173/index-3d.html';
const OUT = process.env.OUT || 'tests/shots';
mkdirSync(OUT, { recursive: true });
const missions = (process.env.MISSIONS || 'training,standard,domination,convoy,rheinuebung,laststand,night,raid').split(',');
const ships = (process.env.SHIPS || 'Bismarck,Hipper,Nuernberg,Z23').split(',');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(800);
let i = 0;
for (const mission of missions) {
   const ship = ships[i++ % ships.length];
   const e0 = errors.length;
   await page.evaluate(([mission, ship]) => { window.__start({ difficulty: 'normal', mission, ship }); window.__setRender(false); }, [mission, ship]);
   await page.waitForTimeout(300);
   const info = await page.evaluate(() => ({ phase: window.__phase(), ship: window.__world()?.player?.name, mission: window.__world()?.mission?.key || window.__world()?.mission?.id }));
   // drive: full speed, turn, shoot, torps, consumables, map, board
   for (const k of ['w', 'w', 'w', 'd']) await page.keyboard.press(k);
   for (let t = 0; t < 12; t++) {
      await page.mouse.move(640, 360); await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up();
      if (t === 3) { await page.keyboard.press('3'); await page.evaluate(() => window.__setAim(Math.PI / 2, 5000)); await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up(); await page.keyboard.press('1'); await page.evaluate(() => window.__setAim(0, 8000)); }
      if (t === 5) for (const k of ['r', 't', 'y', 'u']) await page.keyboard.press(k);
      if (t === 6) { await page.keyboard.press('m'); await page.waitForTimeout(200); await page.keyboard.press('m'); }
      if (t === 7) { await page.keyboard.down('Tab'); await page.waitForTimeout(200); await page.keyboard.up('Tab'); }
      if (t === 8) { await page.keyboard.press('x'); await page.keyboard.press('Shift'); await page.mouse.wheel(0, -200); }
      if (t === 9) { await page.keyboard.press('Shift'); await page.keyboard.press('2'); }
      await page.waitForTimeout(250);
   }
   // render a couple of frames for real too
   await page.evaluate(() => window.__setRender(true));
   await page.waitForTimeout(1500);
   await page.screenshot({ path: `${OUT}/3d-mission-${mission}.png` });
   await page.evaluate(() => window.__setRender(false));
   const st = await page.evaluate(() => ({ t: window.__world().time.toFixed(1), fired: window.__fired(), phase: window.__phase() }));
   console.log(mission, ship, JSON.stringify(info), JSON.stringify(st), 'errors:', errors.length - e0);
}
// ---- atmosphere: weather front, kill camera, photo mode, night flashes (draw calls stay flat)
{
   const fail = (m) => { console.log('ATMO FAIL:', m); errors.push('atmo: ' + m); };
   const ev = (fn, a) => page.evaluate(fn, a);
   const gl = () => ev(() => { const r = window.__renderer3d.renderer.info; return { calls: r.render.calls, prog: r.programs?.length, geo: r.memory.geometries, tex: r.memory.textures }; });
   const camState = () => ev(() => { const c = window.__cam3; return { yaw: +c.yaw.toFixed(4), range: Math.round(c.range), bino: c.bino, zoom: c.zoom, dist: Math.round(c.dist), ov: !!c.override }; });
   await ev(() => { window.__start({ difficulty: 'normal', mission: 'standard' }); window.__setRender(true); });
   await page.waitForTimeout(800);
   const g0 = await gl();
   // weather front rolls in over 3 s
   await ev(() => { const w = window.__world(); w.scheduleFront({ at: w.time, dur: 3, to: 'storm' }); });
   await page.waitForTimeout(4500);
   const wx = await ev(() => { const e = window.__world().env; return { weather: e.weather, k: e.frontK, vis: +e.visibility.toFixed(2), cap: e.spotCap }; });
   const g1 = await gl();
   if (wx.weather !== 'storm' || wx.k !== 1) fail('front did not complete ' + JSON.stringify(wx));
   const msg = await ev(() => document.getElementById('hud')?.textContent || '');
   if (!/Sturmfront/.test(msg)) console.log('  (hint) Sturmfront banner not in HUD text any more');
   console.log('weather front', JSON.stringify(wx), 'calls', g0.calls, '->', g1.calls, 'prog', g0.prog, '->', g1.prog);
   // kill camera: cut away, click skips, exact camera restore
   const c0 = await camState();
   const on = await ev(() => window.__killCam());
   if (!on) fail('kill cam did not start');
   await page.waitForTimeout(400);
   if (!(await camState()).ov) fail('kill cam override missing');
   await page.mouse.click(640, 360);
   await page.waitForTimeout(200);
   const c1 = await camState();
   if (await ev(() => window.__killCamOn())) fail('click did not skip the kill cam');
   if (JSON.stringify(c0) !== JSON.stringify(c1)) fail('kill cam changed camera ' + JSON.stringify(c0) + ' vs ' + JSON.stringify(c1));
   await ev(() => window.__killCam());
   await page.waitForTimeout(2800);
   if (await ev(() => window.__killCamOn())) fail('kill cam did not end by itself');
   console.log('kill cam ok', JSON.stringify(c1));
   // photo mode: O pauses, drag orbits, wheel zooms, O restores
   const p0 = await camState();
   await page.keyboard.press('o');
   await page.waitForTimeout(200);
   const t0 = await ev(() => window.__world().time);
   const ph0 = await ev(() => window.__photo());
   await page.mouse.move(640, 360); await page.mouse.down(); await page.mouse.move(760, 330, { steps: 4 }); await page.mouse.up();
   await page.mouse.wheel(0, 300);
   await page.waitForTimeout(400);
   const ph1 = await ev(() => window.__photo());
   const t1 = await ev(() => window.__world().time);
   const hudHidden = await ev(() => document.getElementById('hud').classList.contains('hidden') && !document.getElementById('photo-hint').classList.contains('hidden'));
   if (!ph1.on || t1 !== t0) fail('photo mode must pause the sim ' + t0 + ' ' + t1);
   if (!(ph1.yaw !== ph0.yaw && ph1.dist > ph0.dist)) fail('photo orbit/zoom did not respond ' + JSON.stringify([ph0, ph1]));
   if (!hudHidden) fail('photo mode must hide the HUD and show the hint');
   if (process.env.ATMO_SHOT) await page.screenshot({ path: `${OUT}/3d-photo-storm.png` });
   await page.keyboard.press('o');
   await page.waitForTimeout(200);
   const p1 = await camState();
   if ((await ev(() => window.__phase())) !== 'playing') fail('O did not leave photo mode');
   if (JSON.stringify(p0) !== JSON.stringify(p1)) fail('photo mode changed camera ' + JSON.stringify(p0) + ' vs ' + JSON.stringify(p1));
   console.log('photo mode ok', JSON.stringify(ph1));
   // night: salvos light the scene through the fixed light pool -> no new programs, flat calls
   await ev(() => { window.__start({ difficulty: 'normal', mission: 'night' }); window.__setRender(true); });
   await page.waitForTimeout(800);
   const n0 = await gl();
   for (let i = 0; i < 6; i++) { await page.mouse.down(); await page.waitForTimeout(80); await page.mouse.up(); await page.waitForTimeout(300); }
   await ev(() => { const w = window.__world(), p = w.player; window.__renderer3d.fx.starShell(p.pos.x + 800, p.pos.y); });
   await page.waitForTimeout(600);
   const n1 = await gl();
   const ft = await ev(() => new Promise(r => { const t = []; let last = performance.now(); const f = (now) => { t.push(now - last); last = now; if (t.length < 40) requestAnimationFrame(f); else r(+(t.slice(5).reduce((a, b) => a + b, 0) / 35).toFixed(1)); }; requestAnimationFrame(f); }));
   if (n1.prog !== n0.prog) fail(`night flashes compiled new programs ${n0.prog} -> ${n1.prog}`);
   console.log('night flashes calls', n0.calls, '->', n1.calls, 'prog', n0.prog, '->', n1.prog, 'frame ms', ft, 'fired', JSON.stringify(await ev(() => window.__fired())));
   await ev(() => window.__setRender(false));
}
console.log('TOTAL ERRORS', errors.length);
for (const e of [...new Set(errors)].slice(0, 10)) console.log(' -', e);
await browser.close();
process.exit(errors.length ? 1 : 0);
