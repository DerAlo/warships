// game3d/sites3d.js — the land targets of the coastal operations (sites.js) in the picture: one merged,
// vertex-coloured mesh per position, the V-2 standing on its launch table, rockets lifting off,
// the muzzle flashes of the coastal guns, wrecks and damage smoke.
// Pure presentation: reads world.sites / world.events, never writes to the simulation.
// Adapted from the modern mode's site renderer (gamev2/missiles3d.js), not imported from it.
//
// Cost: nothing at all in missions without sites. With sites: one mesh per site (+ one rocket mesh
// per ramp), a fixed pool of flying rockets, trails through the fx3d particle pools (rate follows
// GFX.effects), no allocation per frame.
// Sim plane {x, y} -> THREE (x, height, y). Site groups: rotation.y = -heading (local +X = heading).
import * as THREE from '../vendor/three/three.module.min.js';
import { patchAtmosphere } from './gfxcommon3d.js';
import { GFX } from './gfxquality.js';

const TAU = Math.PI * 2;
const rr = (a, b) => a + Math.random() * (b - a);
const MAX_FLIGHTS = 4;
const FLIGHT_T = 16;      // s a rocket stays in the picture

// merge non-indexed geometries with a flat colour each (vendor/three has no BufferGeometryUtils)
function mergeColored(parts) {
   let n = 0;
   for (const p of parts) n += p.g.attributes.position.count;
   const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
   const c = new THREE.Color();
   let o = 0;
   for (const p of parts) {
      const cnt = p.g.attributes.position.count;
      pos.set(p.g.attributes.position.array, o * 3);
      nor.set(p.g.attributes.normal.array, o * 3);
      c.set(p.c);
      for (let i = 0; i < cnt; i++) { col[(o + i) * 3] = c.r; col[(o + i) * 3 + 1] = c.g; col[(o + i) * 3 + 2] = c.b; }
      o += cnt;
      p.g.dispose();
   }
   const m = new THREE.BufferGeometry();
   m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
   m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
   m.setAttribute('color', new THREE.BufferAttribute(col, 3));
   m.computeBoundingSphere();
   return m;
}
const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _m4 = new THREE.Matrix4(), _v = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
function put(g, x, y, z, rx = 0, ry = 0, rz = 0) {
   g = g.index ? g.toNonIndexed() : g;
   _q.setFromEuler(_e.set(rx, ry, rz));
   g.applyMatrix4(_m4.compose(_v.set(x, y, z), _q, _s));
   return g;
}
const box = (w, h, d, x, y, z, c, rx, ry, rz) => ({ g: put(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz), c });
const cyl = (r0, r1, h, seg, x, y, z, c, rx, ry, rz) => ({ g: put(new THREE.CylinderGeometry(r0, r1, h, seg), x, y, z, rx, ry, rz), c });

const C = { concrete: 0x9d998e, dark: 0x30362a, field: 0x56603f, olive: 0x4c5638, steel: 0x6c7276, black: 0x18191a,
   white: 0xdcddd6, sand: 0xa69468, berm: 0x5f6040, rust: 0x6e4a33, wood: 0x6b5236 };

// a V-2, 14 m, standing on its tail at y = 0: black-and-white trial paint, four fins
function rocketGeometry() {
   const parts = [
      cyl(0.82, 0.82, 4.2, 10, 0, 2.6, 0, C.black), cyl(0.82, 0.82, 4.2, 10, 0, 6.8, 0, C.white),
      cyl(0.4, 0.82, 4.4, 10, 0, 11.1, 0, C.black), cyl(0.02, 0.4, 1.3, 8, 0, 13.95, 0, C.white),
      cyl(0.82, 0.55, 0.6, 10, 0, 0.2, 0, C.dark),
   ];
   for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      parts.push(box(0.12, 2.6, 1.6, Math.cos(a) * 1.4, 1.4, Math.sin(a) * 1.4, i & 1 ? C.white : C.black, 0, -a, 0));
   }
   return mergeColored(parts);
}

const SITE_BUILD = {
   // launch site in a forest clearing: firing table, the Meillerwagen trailer laid down beside it,
   // fuel bowsers and a blast-proof control car
   ramp() {
      const parts = [cyl(36, 40, 2, 14, 0, -0.9, 0, C.field), box(14, 0.6, 14, 0, 0.3, 0, C.concrete)];
      parts.push(box(4, 1.6, 4, 0, 1.2, 0, C.steel), box(5.2, 0.4, 5.2, 0, 2, 0, C.dark));
      parts.push(box(16, 1, 2.6, -11, 1.4, 0, C.olive), box(1.2, 9, 2.6, -3.6, 5, 0, C.olive, 0, 0, -0.08));
      for (const [x, z] of [[8, 16], [-6, 18]]) parts.push(box(9, 2.6, 3, x, 1.6, z, C.olive), cyl(1.2, 1.2, 6, 8, x - 1, 3.2, z, C.steel, 0, 0, Math.PI / 2));
      parts.push(box(6, 3, 3.4, 12, 1.8, -14, C.dark), box(30, 0.3, 4, -2, 0.2, -18, C.sand));
      for (const [x, z] of [[-26, -24], [24, -26], [-24, 26], [28, 20], [-32, 4], [6, -34]]) parts.push(cyl(0.01, 4.5, 14, 6, x, 9, z, C.dark), cyl(0.5, 0.6, 3, 5, x, 1.5, z, C.wood));
      return { parts, pad: { x: 0, y: 2.2, z: 0 } };
   },
   // coastal battery: three casemated guns in a concrete bunker row facing the sea, earth berms
   battery(r) {
      const parts = [cyl(r * 0.9, r, 2, 14, 0, -0.9, 0, C.sand)];
      for (const z of [-16, 0, 16]) {
         parts.push(box(12, 6, 11, -2, 3, z, C.concrete), box(6, 2.4, 6, 5.5, 3.2, z, C.dark));
         parts.push(cyl(0.45, 0.6, 14, 6, 13, 3.4, z, C.steel, 0, 0, -Math.PI / 2));
      }
      parts.push(box(6, 3, 48, -12, 1.5, 0, C.berm), box(8, 5, 8, -20, 2.5, 22, C.concrete), box(1, 9, 1, -20, 9, 22, C.steel));
      return { parts, pad: null };
   },
   // dock caisson: a steel gate between two concrete dock heads, the dry dock behind it
   gate() {
      const parts = [box(18, 16, 110, 0, 2, 0, C.rust), box(18.6, 1.2, 111, 0, 10.4, 0, C.dark)];
      parts.push(box(40, 14, 30, 10, 1, -70, C.concrete), box(40, 14, 30, 10, 1, 70, C.concrete));
      parts.push(box(140, 4, 150, 90, -1, 0, C.concrete), box(130, 6, 96, 86, -2.5, 0, C.dark));
      parts.push(box(6, 24, 6, 20, 12, -78, C.steel), box(30, 2, 2, 8, 23, -78, C.steel));
      return { parts, pad: null };
   },
   bunker(r) {
      const parts = [cyl(r * 0.9, r, 2, 14, 0, -0.9, 0, C.berm), cyl(18, 24, 9, 4, 0, 4.5, 0, C.concrete, 0, Math.PI / 4, 0)];
      for (const [x, z, ry] of [[12.6, 0, 0], [-12.6, 0, 0]]) parts.push(box(1.2, 1.4, 12, x, 7, z, C.black, 0, ry, 0));
      return { parts, pad: null };
   },
   flak(r) {
      const parts = [cyl(r * 0.9, r, 2, 12, 0, -0.9, 0, C.berm), cyl(9, 10, 2.4, 12, 0, 1.2, 0, C.concrete)];
      for (let i = 0; i < 4; i++) parts.push(cyl(0.25, 0.3, 6, 5, Math.cos(i * TAU / 4) * 2, 4.2, Math.sin(i * TAU / 4) * 2, C.steel, 0.6, 0, 0));
      return { parts, pad: null };
   },
};

const _p = new THREE.Vector3(), _d = new THREE.Vector3();

export class SiteModels {
   constructor(scene, fx, terrain) {
      this.scene = scene; this.fx = fx; this.terrain = terrain;
      this.sites = new Map();          // site -> { group, mesh, rocket, dead, acc }
      this.geo = new Map();            // kind|r -> geometry
      this.mat = patchAtmosphere(new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05, vertexColors: true }), { key: 'air' });
      this.wreckMat = patchAtmosphere(new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, vertexColors: true, color: 0x3a3632 }), { key: 'air' });
      this.rocketGeo = null;
      this.flights = [];               // pooled rockets in the air
      this.lastSeq = -1; this._evInit = false;
   }

   clear() {
      for (const r of this.sites.values()) this.scene.remove(r.group);
      this.sites.clear();
      for (const f of this.flights) { f.on = false; f.mesh.visible = false; }
      this.lastSeq = -1; this._evInit = false;
   }

   dispose() {
      this.clear();
      for (const f of this.flights) this.scene.remove(f.mesh);
      this.flights.length = 0;
      for (const g of this.geo.values()) g.dispose();
      this.geo.clear();
      if (this.rocketGeo) this.rocketGeo.dispose();
      this.mat.dispose(); this.wreckMat.dispose();
   }

   update(world, dt, time, cam) {
      const sites = world.sites;
      if (!sites || !sites.length) { if (this.sites.size) this.clear(); return; }
      this._events(world);
      this._sites(sites, dt, cam);
      this._flights(dt);
   }

   _siteY(S) { const r = this.sites.get(S); return r ? r.group.position.y : 4; }

   _geo(kind, r) {
      const key = kind + '|' + r;
      let g = this.geo.get(key);
      if (!g) { g = mergeColored((SITE_BUILD[kind] || SITE_BUILD.bunker)(r).parts); this.geo.set(key, g); }
      return g;
   }

   _build(S) {
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(this._geo(S.kind, S.r), this.mat);
      group.add(mesh);
      let rocket = null;
      if (S.kind === 'ramp') {
         if (!this.rocketGeo) this.rocketGeo = rocketGeometry();
         rocket = new THREE.Mesh(this.rocketGeo, this.mat);
         rocket.position.set(0, 2.2, 0);
         group.add(rocket);
      }
      // stand on the highest ground under the footprint so nothing is buried in a slope
      const T = this.terrain;
      let h = 1;
      if (T && T.heightAt) {
         h = Math.max(h, T.heightAt(S.x, S.y));
         let hi = h;
         const rad = S.r * 0.6;
         for (let k = 0; k < 4; k++) hi = Math.max(hi, T.heightAt(S.x + Math.cos(k * TAU / 4) * rad, S.y + Math.sin(k * TAU / 4) * rad));
         h = Math.min(hi, h + 12) + 0.4;
      }
      group.position.set(S.x, h, S.y);
      group.rotation.y = -(S.heading || 0);
      this.scene.add(group);
      const r = { group, mesh, rocket, dead: false, acc: Math.random() };
      this.sites.set(S, r);
      return r;
   }

   _sites(sites, dt, cam) {
      const q = GFX.effects;
      for (const S of sites) {
         const r = this.sites.get(S) || this._build(S);
         if (r.rocket) r.rocket.visible = S.alive && S.armed && !S.hidden;
         if (S.kind === 'battery' && S.alive) r.group.rotation.y = -(S.heading || 0);
         if (!S.alive && !r.dead) {
            r.dead = true;
            r.mesh.material = this.wreckMat;
            r.mesh.scale.y = S.kind === 'gate' ? 0.45 : 0.62;
         }
         // damage: smoke from half health, fire below a quarter; a wreck keeps smouldering
         const frac = S.alive ? S.hp / (S.maxHp || 1) : 0;
         if (q < 1 || frac > 0.55) continue;
         if (Math.hypot(S.x - cam.x, S.y - cam.z) > 12000) continue;
         r.acc += dt * (r.dead ? 2.2 : frac < 0.25 ? 3 : 1.4) * (q >= 2 ? 1.5 : 1);
         const y = r.group.position.y;
         while (r.acc >= 1) {
            r.acc -= 1;
            const ox = Math.sin(S.id * 3.1) * S.r * 0.3, oz = Math.cos(S.id * 1.7) * S.r * 0.3;
            let p = this.fx.puff.t();
            p.x = S.x + ox + rr(-4, 4); p.y = y + rr(4, 9); p.z = S.y + oz + rr(-4, 4); p.vx = rr(-1.5, 1.5); p.vy = rr(7, 13); p.vz = rr(-1.5, 1.5); p.drag = 0.25; p.grav = -0.6;
            p.life = rr(7, 11); p.s0 = 9; p.s1 = rr(40, 58); p.grow = 2.2; p.r = 0.05; p.g = 0.045; p.b = 0.04; p.r1 = 0.22; p.g1 = 0.21; p.b1 = 0.2;
            p.a = r.dead ? 0.7 : 0.8; p.fin = 0.08; p.fout = 0.5; p.shape = 1; p.lit = 0.6; p.wind = 1; p.rot = rr(0, TAU); p.spin = rr(-0.3, 0.3);
            this.fx.puff.emit();
            if ((!r.dead && frac < 0.25) || (r.dead && Math.random() < 0.4)) {
               p = this.fx.glow.t();
               p.x = S.x + ox + rr(-5, 5); p.y = y + rr(3, 7); p.z = S.y + oz + rr(-5, 5); p.vx = 0; p.vy = rr(4, 9); p.vz = 0; p.drag = 0.8; p.grav = 0;
               p.life = rr(0.5, 0.9); p.s0 = 6; p.s1 = 13; p.grow = 2; p.r = 16; p.g = 6; p.b = 1.2; p.r1 = 2; p.g1 = 0.3; p.b1 = 0.05; p.a = 1; p.fin = 0.1; p.fout = 0.5; p.shape = 1; p.rot = rr(0, TAU);
               this.fx.glow.emit();
            }
         }
      }
   }

   _events(world) {
      const ev = world.events;
      if (!Array.isArray(ev) || !ev.length) return;
      if (!this._evInit) {
         this._evInit = true;
         for (const e of ev) if (Number.isFinite(e?.seq) && e.seq > this.lastSeq) this.lastSeq = e.seq;
         return;
      }
      let max = this.lastSeq;
      for (const e of ev) {
         if (!e || !Number.isFinite(e.seq) || e.seq <= this.lastSeq) continue;
         if (e.seq > max) max = e.seq;
         if (e.type !== 'siteFire' && e.type !== 'rocket' && e.type !== 'siteDestroyed') continue;
         const S = this._find(world, e.type === 'siteDestroyed' ? e.dstId : e.srcId);
         if (!S) continue;
         const y = this._siteY(S);
         if (e.type === 'siteFire') {
            const b = Number.isFinite(e.bearing) ? e.bearing : S.heading || 0;
            const cb = Math.cos(b), sb = Math.sin(b), n = e.guns || 1;
            _d.set(cb, 0.18, sb).normalize();
            for (let i = 0; i < n; i++) {
               const off = (i - (n - 1) / 2) * 16;
               _p.set(S.x + cb * 20 - sb * off, y + 4, S.y + sb * 20 + cb * off);
               this.fx.muzzle(_p, _d, e.caliber || 150, i * 0.07);
            }
         } else if (e.type === 'rocket') this._launch(S, y);
         else this.fx._explosion(S.x + rr(-15, 15), y + 6, S.y + rr(-15, 15), S.kind === 'ramp' ? 460 : 406, true, S.kind === 'ramp' ? 1.4 : 1.1);
      }
      this.lastSeq = max;
   }

   _find(world, id) {
      for (const S of world.sites) if (S.id === id) return S;
      return null;
   }

   // a rocket lifts off the table: slow at first, then climbing away westwards (towards England)
   _launch(S, y) {
      let f = null;
      for (const g of this.flights) if (!g.on) { f = g; break; }
      if (!f) {
         if (this.flights.length >= MAX_FLIGHTS) f = this.flights.reduce((a, b) => (a.t > b.t ? a : b));
         else {
            if (!this.rocketGeo) this.rocketGeo = rocketGeometry();
            f = { mesh: new THREE.Mesh(this.rocketGeo, this.mat), on: false, t: 0, x: 0, y: 0, z: 0, acc: 0 };
            f.mesh.matrixAutoUpdate = true;
            this.scene.add(f.mesh);
            this.flights.push(f);
         }
      }
      f.on = true; f.t = 0; f.x0 = S.x; f.y0 = y + 2.2; f.z0 = S.y; f.acc = 0;
      f.mesh.visible = true;
      f.mesh.position.set(f.x0, f.y0, f.z0);
      f.mesh.rotation.set(0, 0, 0);
      this.fx._light(S.x, y + 20, S.y, 4e6, 2.2, 1, 0.7, 0.35);
      // the blast at the table: a ring of dust and flame
      const P = this.fx.puff, n = GFX.effects >= 2 ? 16 : 8;
      for (let i = 0; i < n; i++) {
         const a = i / n * TAU, p = P.t();
         p.x = S.x; p.y = y + 1.5; p.z = S.y; p.vx = Math.cos(a) * rr(18, 30); p.vy = rr(1, 4); p.vz = Math.sin(a) * rr(18, 30); p.drag = 0.9; p.grav = -0.3;
         p.life = rr(4, 7); p.s0 = 8; p.s1 = rr(30, 45); p.grow = 2; p.r = 0.55; p.g = 0.5; p.b = 0.42; p.r1 = 0.62; p.g1 = 0.6; p.b1 = 0.56;
         p.a = 0.75; p.fin = 0.05; p.fout = 0.5; p.shape = 1; p.lit = 0.8; p.wind = 0.6; p.rot = rr(0, TAU); p.spin = rr(-0.3, 0.3);
         P.emit();
      }
   }

   _flights(dt) {
      const q = GFX.effects, rate = q >= 3 ? 30 : q >= 2 ? 22 : q >= 1 ? 12 : 5;
      for (const f of this.flights) {
         if (!f.on) continue;
         f.t += dt;
         if (f.t > FLIGHT_T) { f.on = false; f.mesh.visible = false; continue; }
         // altitude: accelerating climb (a ~ 2.2 g compressed); pitch over to the west after 4 s
         const t = f.t, alt = 6 * t * t + 2 * t;
         const pitch = Math.min(0.75, Math.max(0, t - 4) * 0.09);
         const run = Math.max(0, t - 4) ** 2 * 3.2;
         f.mesh.position.set(f.x0 - run, f.y0 + alt, f.z0);
         f.mesh.rotation.set(0, 0, pitch);
         // flame and the white trail from the tail
         f.acc += dt * rate;
         const sp = Math.sin(pitch), cp = Math.cos(pitch);
         const tx = f.mesh.position.x + sp * 1, ty = f.mesh.position.y - cp * 1, tz = f.z0;
         while (f.acc >= 1) {
            f.acc -= 1;
            let p = this.fx.glow.t();
            p.x = tx + sp * 2; p.y = ty - cp * 2; p.z = tz; p.vx = sp * 30; p.vy = -cp * 30; p.vz = 0; p.drag = 3; p.grav = 0;
            p.life = 0.25; p.s0 = 4.5; p.s1 = 9; p.grow = 1.5; p.r = 30; p.g = 16; p.b = 5; p.r1 = 8; p.g1 = 2; p.b1 = 0.4; p.a = 1; p.fin = 0; p.fout = 0.5; p.shape = 0;
            this.fx.glow.emit();
            p = this.fx.puff.t();
            p.x = tx + rr(-1, 1); p.y = ty + rr(-1, 1); p.z = tz + rr(-1, 1); p.vx = rr(-1, 1); p.vy = rr(-1, 1); p.vz = rr(-1, 1); p.drag = 0.4; p.grav = 0;
            p.life = rr(6, 9); p.s0 = 5; p.s1 = rr(16, 24); p.grow = 1.6; p.r = 0.9; p.g = 0.9; p.b = 0.88; p.r1 = 0.78; p.g1 = 0.78; p.b1 = 0.76;
            p.a = 0.6; p.fin = 0.02; p.fout = 0.6; p.shape = 1; p.lit = 0.8; p.wind = 1; p.rot = rr(0, TAU); p.spin = rr(-0.2, 0.2);
            this.fx.puff.emit();
         }
      }
   }
}
