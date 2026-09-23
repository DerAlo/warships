// tests/shots-gfx3d.mjs — graphics screenshots for the 3D renderer. Starts a match, then
// parks the camera (renderer.debugView) at scripted spots: player close-up, islands, the
// horizon, overview. Fails on any console error / pageerror (shader compile errors land there).
// Usage: node tests/shots-gfx3d.mjs [view,view,...] [--env=time:weather:sea]
//   URL3D=http://localhost:5185/index-3d.html
// PW_MODULE: optional absolute file URL of a playwright index.mjs when none is installed locally
const { chromium } = await import(process.env.PW_MODULE || 'playwright');
import { mkdirSync } from 'node:fs';

const URL = process.env.URL3D || 'http://localhost:5185/index-3d.html';
const OUT = 'tests/shots';
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const envArg = (args.find(a => a.startsWith('--env=')) || '').slice(6);
const W = Number((args.find(a => a.startsWith('--w=')) || '--w=1280').slice(4));
const H = Math.round(W * 9 / 16);
const wanted = (args.find(a => !a.startsWith('--')) || 'game,ship,island,horizon,top').split(',');
const warm = Number((args.find(a => a.startsWith('--warm=')) || '--warm=2500').slice(7));

const errors = [];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text().slice(0, 600)); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(600);
if (envArg) {
   const [time, weather, sea] = envArg.split(':');
   await page.evaluate(([time, weather, sea]) => { window.__forceEnv = { time, weather, seaState: Number(sea || 0.4) }; }, [time, weather, sea]);
}
await page.click('#btn-play');
await page.waitForTimeout(400);
if (envArg) {
   await page.evaluate(() => { const w = window.__world(); w.env = Object.assign({}, w.env || {}, window.__forceEnv); window.__renderer3d.buildWorld(w); });
}
await page.waitForTimeout(warm);

const views = {
   game: null,
   ship: `const p = w.player; const h = p.heading; const d = 190;
      return { pos: [p.pos.x + Math.cos(h + 0.9) * d, 38, p.pos.y + Math.sin(h + 0.9) * d], look: [p.pos.x + Math.cos(h) * 20, 10, p.pos.y + Math.sin(h) * 20], fov: 50 };`,
   ship2: `const p = w.player; const h = p.heading; const d = 120;
      return { pos: [p.pos.x + Math.cos(h - 2.4) * d, 30, p.pos.y + Math.sin(h - 2.4) * d], look: [p.pos.x, 14, p.pos.y], fov: 55 };`,
   enemy: `const p = w.player; let best = null, bd = 1e9; for (const s of w.ships) { if (s === p || !s.alive) continue; const dd = Math.hypot(s.pos.x - p.pos.x, s.pos.y - p.pos.y); if (dd < bd) { bd = dd; best = s; } }
      if (!best) return null; const h = best.heading; const d = 150;
      return { pos: [best.pos.x + Math.cos(h + 1.2) * d, 30, best.pos.y + Math.sin(h + 1.2) * d], look: [best.pos.x, 8, best.pos.y], fov: 50 };`,
   island: `const isl = w.obstacles.filter(o => o.kind === 'island').sort((a, b) => b.r - a.r)[0];
      const a = 2.2; const d = isl.r * 2.3;
      return { pos: [isl.c.x + Math.cos(a) * d, isl.r * 0.28, isl.c.y + Math.sin(a) * d], look: [isl.c.x, isl.r * 0.08, isl.c.y], fov: 55 };`,
   island2: `const isl = w.obstacles.filter(o => o.kind === 'island').sort((a, b) => b.r - a.r)[1] || w.obstacles[0];
      const a = -0.6; const d = isl.r * 1.9;
      return { pos: [isl.c.x + Math.cos(a) * d, 25, isl.c.y + Math.sin(a) * d], look: [isl.c.x, isl.r * 0.12, isl.c.y], fov: 50 };`,
   reef: `const o = w.obstacles.find(o => o.kind === 'reef'); if (!o) return null;
      return { pos: [o.c.x + o.r * 1.4, 60, o.c.y + o.r * 1.4], look: [o.c.x, 0, o.c.y], fov: 55 };`,
   horizon: `const p = w.player; const L = window.__renderer3d.env.sunDir; const a = Math.atan2(L.z, L.x);
      return { pos: [p.pos.x, 24, p.pos.y], look: [p.pos.x + Math.cos(a) * 3000, 40, p.pos.y + Math.sin(a) * 3000], fov: 60 };`,
   horizon2: `const p = w.player; const L = window.__renderer3d.env.sunDir; const a = Math.atan2(L.z, L.x) + Math.PI;
      return { pos: [p.pos.x, 24, p.pos.y], look: [p.pos.x + Math.cos(a) * 3000, 60, p.pos.y + Math.sin(a) * 3000], fov: 60 };`,
   top: `const p = w.player; return { pos: [p.pos.x - 1800, 1500, p.pos.y + 1800], look: [p.pos.x + 300, 0, p.pos.y - 300], fov: 55 };`,
   water: `const p = w.player; const h = p.heading; return { pos: [p.pos.x - Math.cos(h) * 60, 9, p.pos.y - Math.sin(h) * 60 + 40], look: [p.pos.x - Math.cos(h) * 400, 0, p.pos.y - Math.sin(h) * 400 + 80], fov: 60 };`,
};

for (const name of wanted) {
   if (!(name in views)) { console.log('unknown view', name); continue; }
   const code = views[name];
   const ok = await page.evaluate((code) => {
      const r = window.__renderer3d, w = window.__world();
      if (!code) { r.debugView = null; return true; }
      const v = new Function('w', code)(w);
      r.debugView = v;
      return !!v;
   }, code);
   if (!ok) { console.log('skip', name); continue; }
   await page.waitForTimeout(name === 'game' ? 200 : 900);
   await page.screenshot({ path: `${OUT}/gfx-${name}${envArg ? '-' + envArg.replace(/:/g, '_') : ''}.png` });
   console.log('shot', name);
}
const fps = await page.evaluate(() => new Promise(res => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1500) requestAnimationFrame(f); else res(n / ((performance.now() - t0) / 1000)); }; requestAnimationFrame(f); }));
console.log('fps (software GL, meaningless):', fps.toFixed(1));
const info = await page.evaluate(() => { const i = window.__renderer3d.renderer.info; return { calls: i.render.calls, tris: i.render.triangles, geos: i.memory.geometries, tex: i.memory.textures }; });
console.log('renderer.info', JSON.stringify(info));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors');
await browser.close();
process.exit(errors.some(e => !e.startsWith('warning')) ? 1 : 0);
