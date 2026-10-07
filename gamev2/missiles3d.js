// gamev2/missiles3d.js — everything the modern mode adds to the picture: missiles in flight,
// launch / intercept / hit effects, close-in gun tracers, decoy clouds and the land positions.
// Pure presentation: reads world.missiles / world.decoys / world.sites / world.events and never
// writes to the simulation.
//
// Cost model (phones first): ONE instanced mesh for all missile bodies, trails and glows go
// through the particle pools and the tracer batch of fx3d.js (no extra draw calls), every site
// is one merged vertex-coloured mesh (+ one small mesh for a turning antenna). Particle counts
// follow GFX.effects every frame, so a tier switch needs no rebuild.
//
// Sim plane {x, y} -> THREE (x, height, y). Site groups: rotation.y = -heading.
import * as THREE from '../vendor/three/three.module.min.js';
import { patchAtmosphere } from './gfxcommon3d.js';
import { GFX } from './gfxquality.js';

const TAU = Math.PI * 2;
const MAX_BODIES = 280;
const rr = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// per missile kind: body length (m), girth factor, body colour, glow colour (HDR), glow size,
// trail colour (tracer streak, HDR), trail length (m), smoke { rate per s, life, size, grey, alpha }
const LOOK = {
   ssm: { len: 5.6, girth: 1, col: 0xd9dcd6, glow: [30, 13, 3], gs: 2.4, streak: [1.5, 1.35, 1.2], sl: 260, sm: { rate: 9, life: 2.6, s: 7, c: 0.78, a: 0.42 } },
   cruise: { len: 6.4, girth: 1.15, col: 0x6f7780, glow: [9, 5, 2], gs: 1.5, streak: [0.5, 0.5, 0.55], sl: 120, sm: { rate: 4, life: 1.6, s: 5, c: 0.55, a: 0.2 } },
   sam: { len: 4.8, girth: 0.8, col: 0xf4f4f0, glow: [34, 30, 26], gs: 3.2, streak: [2.6, 2.6, 2.8], sl: 520, sm: { rate: 14, life: 3.4, s: 9, c: 0.95, a: 0.6 } },
   aam: { len: 3.2, girth: 0.6, col: 0xf0f0ec, glow: [26, 24, 22], gs: 2.2, streak: [2, 2, 2.2], sl: 320, sm: { rate: 8, life: 2, s: 5, c: 0.95, a: 0.45 } },
   rocket: { len: 2.6, girth: 0.7, col: 0x5d6148, glow: [28, 17, 4], gs: 1.6, streak: [1.6, 1.1, 0.5], sl: 90, sm: { rate: 7, life: 1.5, s: 4, c: 0.62, a: 0.4 } },
};
// trail budget per tier: [smoke rate factor, smoke life factor]
const TRAIL_Q = [[0, 0], [0.55, 0.7], [1, 1], [1.5, 1.35]];

// ---------------------------------------------------------------- geometry helpers
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
// place a geometry: translate (x, y, z) after rotating by (rx, ry, rz)
function put(g, x, y, z, rx = 0, ry = 0, rz = 0) {
   g = g.index ? g.toNonIndexed() : g;
   _q.setFromEuler(_e.set(rx, ry, rz));
   g.applyMatrix4(_m4.compose(_v.set(x, y, z), _q, _s));
   return g;
}
const box = (w, h, d, x, y, z, c, rx, ry, rz) => ({ g: put(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz), c });
const cyl = (r0, r1, h, seg, x, y, z, c, rx, ry, rz, th) => ({ g: put(new THREE.CylinderGeometry(r0, r1, h, seg, 1, false, 0, th ?? TAU), x, y, z, rx, ry, rz), c });
const ball = (r, x, y, z, c) => ({ g: put(new THREE.SphereGeometry(r, 10, 7), x, y, z), c });

// one missile, length 1 along +X, nose at +0.5: body, ogive, four tail fins, two stub wings
function missileGeometry() {
   const parts = [
      cyl(0.045, 0.045, 0.78, 6, -0.05, 0, 0, 0xffffff, 0, 0, -Math.PI / 2),
      cyl(0.001, 0.045, 0.16, 6, 0.42, 0, 0, 0xc8c8c8, 0, 0, -Math.PI / 2),
      box(0.14, 0.26, 0.012, -0.37, 0, 0, 0x9a9a9a), box(0.14, 0.012, 0.26, -0.37, 0, 0, 0x9a9a9a),
      box(0.1, 0.012, 0.3, 0.0, 0, 0, 0xb0b0b0),
      cyl(0.03, 0.04, 0.06, 6, -0.47, 0, 0, 0x2a2a2a, 0, 0, -Math.PI / 2),
   ];
   return mergeColored(parts);
}

// ---------------------------------------------------------------- land positions
const C = { pad: 0x8f8a7c, olive: 0x4f5a3c, dark: 0x30362a, steel: 0x7d8588, white: 0xe6e8e4, concrete: 0xa9a59a, asphalt: 0x3a3c3e,
   glass: 0x1c2a33, red: 0xb5392c, sand: 0xb09b6c, berm: 0x6b6a45, black: 0x16181a, yellow: 0xd9b23a };
// a wheeled transporter with its load: chassis, cab, wheels; `load` adds the superstructure
function truck(parts, x, z, ry, load) {
   const s = Math.sin(ry), c = Math.cos(ry);
   const at = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
   let p = at(0, 0); parts.push(box(15, 1.6, 4.2, p[0], 2.2, p[1], C.dark, 0, ry, 0));
   p = at(6, 0); parts.push(box(3.4, 3.2, 4.2, p[0], 4.2, p[1], C.olive, 0, ry, 0));
   for (const lx of [-5.5, -2, 2.5, 6]) { p = at(lx, 0); parts.push(box(1.9, 1.9, 4.6, p[0], 1, p[1], C.black, 0, ry, 0)); }
   load(parts, at, ry);
}
const SITE_BUILD = {
   // coastal battery: three launch trucks with raised canister boxes fanned towards the sea
   battery(r) {
      const parts = [cyl(r * 0.92, r * 1.0, 3, 14, 0, -1.5, 0, C.sand)];
      for (const [x, z, ry] of [[8, -30, 0.25], [14, 0, 0], [8, 30, -0.25]]) {
         truck(parts, x, z, ry, (ps, at, a) => {
            const p = at(-2.5, 0);
            ps.push(box(11, 3.6, 4, p[0], 6.6, p[1], C.olive, 0, a, 0.42));
            const q = at(2.6, 0);
            for (const dz of [-1, 1]) { const e = at(2.6, dz); ps.push(box(0.4, 2.2, 1.6, e[0] + 0 * q[0], 8.7, e[1], C.black, 0, a, 0.42)); }
         });
      }
      parts.push(box(9, 5, 6, -28, 2.5, 0, C.olive), box(1.2, 10, 1.2, -28, 9, 0, C.steel));
      parts.push(box(46, 4, 3, -8, 2, -46, C.berm), box(46, 4, 3, -8, 2, 46, C.berm));
      return { parts, dish: { x: -28, y: 15, z: 0, kind: 'bar', speed: 1.6 } };
   },
   // air-defence battery: four launchers with upright tubes around a flat-faced radar
   sam(r) {
      const parts = [cyl(r * 0.92, r * 1.0, 3, 14, 0, -1.5, 0, C.pad)];
      for (const [x, z, ry] of [[26, -26, 0.8], [26, 26, -0.8], [-26, -26, 2.4], [-26, 26, -2.4]]) {
         truck(parts, x, z, ry, (ps, at) => {
            for (const [lx, lz] of [[-3.4, -1], [-3.4, 1], [-5.4, -1], [-5.4, 1]]) {
               const p = at(lx, lz);
               ps.push(cyl(0.85, 0.85, 9.5, 7, p[0], 7.6, p[1], C.white));
            }
            const b = at(-4.4, 0); ps.push(box(4.4, 1, 4.2, b[0], 3.4, b[1], C.olive));
         });
      }
      parts.push(box(10, 4.4, 6, 0, 2.2, 0, C.olive), box(2, 5, 2, 0, 6.6, 0, C.dark));
      return { parts, dish: { x: 0, y: 12.5, z: 0, kind: 'panel', speed: 0.9 } };
   },
   // radar station: a white radome, the operations block and a big turning antenna on a mast
   radar(r) {
      const parts = [cyl(r * 0.92, r * 1.0, 3, 14, 0, -1.5, 0, C.pad)];
      parts.push(box(22, 7, 14, -10, 3.5, 12, C.concrete), box(8, 3, 8, -14, 8.5, 12, C.concrete));
      parts.push(cyl(5, 6, 9, 10, 16, 4.5, 14, C.concrete), ball(8.5, 16, 14, 14, C.white));
      parts.push(cyl(1.6, 2.6, 24, 8, 4, 12, -16, C.steel), box(7, 1.2, 7, 4, 24.2, -16, C.dark));
      parts.push(box(30, 0.5, 4, -6, 0.3, -30, C.asphalt));
      return { parts, dish: { x: 4, y: 25, z: -16, kind: 'dish', speed: 0.7 } };
   },
   // airfield: runway with markings, taxiway, three arched hangars and the tower
   airfield(r) {
      const L = r * 1.9;
      const parts = [box(L, 2, 34, 0, -0.6, 0, C.asphalt), box(L * 0.7, 2, 16, -L * 0.08, -0.7, 46, C.asphalt), box(28, 2, 30, L * 0.2, -0.7, 28, C.asphalt)];
      for (let i = -5; i <= 5; i++) parts.push(box(L * 0.045, 0.3, 1.6, i * L * 0.085, 0.45, 0, C.white));
      for (const e of [-1, 1]) for (let k = -3; k <= 3; k++) parts.push(box(10, 0.3, 1.6, e * (L * 0.5 - 9), 0.45, k * 4, C.white));
      parts.push(box(L * 0.75, 2.4, 60, -L * 0.06, -1.3, 74, C.pad));
      for (const hx of [-90, -40, 10]) {
         parts.push(cyl(15, 15, 38, 10, hx, 0.4, 82, C.steel, Math.PI / 2, 0, Math.PI / 2, Math.PI));
         parts.push(box(1, 13, 26, hx - 19, 6.5, 82, C.dark));
      }
      parts.push(box(8, 22, 8, 78, 11, 76, C.concrete), box(12, 5, 12, 78, 24.5, 76, C.glass), box(13, 1, 13, 78, 27.5, 76, C.concrete));
      parts.push(cyl(7, 7, 9, 10, 108, 4.5, 84, C.white), cyl(7, 7, 9, 10, 126, 4.5, 84, C.white));
      return { parts, dish: { x: 78, y: 30.5, z: 76, kind: 'bar', speed: 1.2 } };
   },
   // command bunker: a squat concrete block dug into an earth berm, slits, aerial mast
   bunker(r) {
      const parts = [cyl(r * 0.9, r * 1.0, 3, 14, 0, -1.5, 0, C.berm)];
      parts.push(cyl(30, 44, 9, 4, 0, 4.5, 0, C.berm, 0, Math.PI / 4, 0));
      parts.push(cyl(19, 26, 12, 4, 0, 7, 0, C.concrete, 0, Math.PI / 4, 0), box(22, 3, 22, 0, 14.4, 0, C.concrete));
      for (const [x, z, ry] of [[18.6, 0, 0], [-18.6, 0, 0], [0, 18.6, Math.PI / 2], [0, -18.6, Math.PI / 2]]) parts.push(box(1.4, 1.6, 15, x, 9.6, z, C.black, 0, ry, 0));
      parts.push(box(7, 5, 9, 26, 2.5, 0, C.concrete), box(1.2, 4.2, 5, 29.6, 2.2, 0, C.black));
      parts.push(cyl(0.5, 0.8, 22, 6, -6, 27, 6, C.steel), box(6, 0.5, 0.5, -6, 34, 6, C.steel), box(4, 0.5, 0.5, -6, 30, 6, C.steel));
      return { parts, dish: null };
   },
   // gas platform at sea (site.model = 'platform', missions_special_a.js): four legs with braces, two decks,
   // quarters with the helideck, drilling derrick, process modules, crane and flare boom; fixed size
   platform() {
      const parts = [];
      for (const x of [-26, 26]) for (const z of [-20, 20]) parts.push(cyl(3.2, 3.2, 46, 8, x, 1, z, C.yellow));
      for (const z of [-20, 20]) parts.push(box(52, 1.6, 1.6, 0, 9, z, C.steel), box(58, 1.4, 1.4, 0, 16, z, C.steel, 0, 0, 0.26));
      for (const x of [-26, 26]) parts.push(box(1.6, 1.6, 40, x, 9, 0, C.steel));
      parts.push(box(64, 3, 50, 0, 25, 0, C.steel), box(74, 2.5, 58, 0, 31, 0, C.dark));
      parts.push(box(20, 14, 30, -25, 39.2, -8, C.white), box(14, 5, 18, -25, 48.7, -8, C.white), box(21, 1.2, 0.6, -25, 42, 7.2, C.glass));
      parts.push(cyl(15, 15, 1.2, 8, -44, 47, -24, C.asphalt), box(8, 0.3, 1.4, -44, 47.7, -24, C.white), box(14, 1.4, 1.4, -34, 45, -22, C.steel));
      parts.push(cyl(2.4, 9, 46, 4, 12, 55.2, 8, C.red, 0, Math.PI / 4, 0), box(7, 3, 7, 12, 79.6, 8, C.steel));
      parts.push(box(22, 9, 20, 16, 36.7, -17, C.concrete), cyl(4, 4, 18, 10, 26, 36.4, 20, C.white, 0, 0, Math.PI / 2), cyl(4, 4, 18, 10, 26, 36.4, 10, C.white, 0, 0, Math.PI / 2));
      parts.push(cyl(1.6, 1.6, 14, 6, 31, 39.2, -25, C.yellow), box(30, 1.4, 1.4, 43, 51, -25, C.yellow, 0, 0, 0.35));
      parts.push(box(44, 1.2, 1.2, 55, 41, 24, C.steel, 0, 0, 0.45), box(2.4, 3, 2.4, 75, 51, 24, C.red));
      return { parts, dish: null };
   },
   // missile launch site: an inclined rail with a big round on it, blast wall, bunkered control
   launcher(r) {
      const parts = [cyl(r * 0.92, r * 1.0, 3, 14, 0, -1.5, 0, C.pad)];
      const a = 0.5;
      parts.push(box(46, 2, 5, 4, 11.5, 0, C.steel, 0, 0, a), box(3, 22, 5, 20, 11, 0, C.steel), box(3, 9, 5, -2, 4.5, 0, C.steel));
      parts.push(cyl(1.9, 1.9, 30, 8, 6, 15, 0, C.white, 0, 0, a - Math.PI / 2), cyl(0.1, 1.9, 6, 8, 21.8, 23.6, 0, C.red, 0, 0, a - Math.PI / 2));
      parts.push(box(1, 6, 9, -7, 7.5, 0, C.red, 0, 0, a));
      parts.push(box(3, 12, 30, -30, 6, 0, C.concrete), box(16, 6, 12, 18, 3, 34, C.concrete), box(16, 6, 12, 18, 3, -34, C.concrete));
      parts.push(cyl(3.2, 3.2, 16, 10, -8, 3.2, 38, C.white, Math.PI / 2, 0, Math.PI / 2), cyl(3.2, 3.2, 16, 10, -8, 3.2, -38, C.white, Math.PI / 2, 0, Math.PI / 2));
      return { parts, dish: null };
   },
};
function dishGeometry(kind) {
   if (kind === 'dish') {
      return mergeColored([box(1.4, 9, 20, 0.8, 4, 0, C.steel, 0, 0, -0.18), box(5, 0.6, 0.6, 3.2, 4.5, 0, C.dark), box(2.4, 2.4, 2.4, 0, 0.6, 0, C.dark),
         box(0.8, 9, 3, 1.6, 4, -11, C.steel, 0, 0.5, -0.18), box(0.8, 9, 3, 1.6, 4, 11, C.steel, 0, -0.5, -0.18)]);
   }
   if (kind === 'panel') return mergeColored([box(1, 7.5, 7.5, 0.6, 4.2, 0, C.steel, 0, 0, -0.25), box(2.6, 1.6, 2.6, 0, 0.4, 0, C.dark)]);
   return mergeColored([box(1, 1.8, 11, 0, 1.4, 0, C.steel), box(1.2, 1.4, 1.2, 0, 0.2, 0, C.dark)]);
}

// ================================================================ MissileFX
export class MissileFX {
   constructor(scene, fx, terrain) {
      this.scene = scene; this.fx = fx; this.terrain = terrain;
      this.alpha = 1;                  // interpolation factor between two sim steps (set by the renderer)
      this.state = new Map();          // missile id -> { x, y, z, dx, dy, dz, dist, kind, acc, seen }
      this.sites = new Map();          // site -> { group, mesh, dish, dead, acc }
      this.dishGeo = {};
      this.lastSeq = -1;
      this.frame = 0;
      this.ciwsN = 0;                  // close-in guns firing this frame (HUD / audio may read it)
      this._streams = [];
      const mat = patchAtmosphere(new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.2, vertexColors: true }), { key: 'air' });
      this.bodies = new THREE.InstancedMesh(missileGeometry(), mat, MAX_BODIES);
      this.bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.bodies.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BODIES * 3).fill(1), 3);
      this.bodies.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.bodies.frustumCulled = false;
      this.bodies.count = 0;
      this.bodies.castShadow = false;
      scene.add(this.bodies);
      this.siteMat = patchAtmosphere(new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05, vertexColors: true }), { key: 'air' });
      this.wreckMat = patchAtmosphere(new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, vertexColors: true, color: 0x3a342e }), { key: 'air' });
      this.siteGeo = new Map();        // kind|r -> { geo, dish }
      this._col = {};
      for (const k in LOOK) this._col[k] = new THREE.Color(LOOK[k].col);
      fx.tracerHook = (T, cam) => this._tracers(T, cam);
   }

   clear() {
      this.state.clear();
      for (const r of this.sites.values()) this.scene.remove(r.group);
      this.sites.clear();
      this.bodies.count = 0;
      this.lastSeq = -1;
      this._streams.length = 0;
      this._world = null;
   }

   dispose() {
      this.clear();
      this.scene.remove(this.bodies);
      this.bodies.geometry.dispose(); this.bodies.material.dispose();
      for (const g of this.siteGeo.values()) g.geo.dispose();
      for (const k in this.dishGeo) this.dishGeo[k].dispose();
      this.siteMat.dispose(); this.wreckMat.dispose();
      if (this.fx.tracerHook) this.fx.tracerHook = null;
   }

   // Where a weapon leaves a ship. Uses a named anchor of the ship model when it has one
   // (rec.anchors[name] = {x, y, z} in ship-local metres, x = bow), else a sensible default.
   launchPoint(world, ships, id, name, out) {
      const P = world.shipById ? world.shipById(id) : null;
      if (P && P.pos) {
         const L = P.cfg?.hull?.L || P.len || 120, h = P.heading || 0;
         let lx = name === 'vls' ? L * 0.22 : name === 'ssm' ? -L * 0.05 : name === 'ciws' ? -L * 0.18 : L * 0.1, ly = name === 'ssm' ? 0 : 0, lh = name === 'ciws' ? 15 : 9;
         const rec = ships && ships.recs ? ships.recs.get(P) : null, an = rec && rec.anchors ? rec.anchors[name] : null;
         if (an) { lx = an.x ?? lx; ly = an.z ?? an.y2 ?? 0; lh = an.y ?? lh; }
         const c = Math.cos(h), s = Math.sin(h);
         out.x = P.pos.x + lx * c - ly * s; out.z = P.pos.y + lx * s + ly * c; out.y = P.depth > 0 ? 0 : lh;
         out.sub = P.depth > 0; out.h = h;
         return out;
      }
      const S = world.sites ? world.sites.find(s => s.id === id) : null;
      if (S) { const r = this.sites.get(S); out.x = S.x; out.z = S.y; out.y = (r ? r.group.position.y : 4) + 9; out.sub = false; out.h = S.heading || 0; return out; }
      return null;
   }

   update(world, dt, time, camera, ships) {
      this._world = world; this._ships = ships; this._time = time;
      this.frame++;
      const cam = camera.position, fx = this.fx, q = GFX.effects;
      const a = clamp(this.alpha, 0, 1);
      this._sites(world, dt, time, cam);
      this._events(world, ships, cam);

      // ---- missiles: bodies, engine glow, smoke
      const ms = world.missiles || [], B = this.bodies, im = B.instanceMatrix.array, ic = B.instanceColor.array;
      const tq = TRAIL_Q[q] || TRAIL_Q[1];
      // many missiles at once: thin the smoke so a saturation attack costs about as much as a duel
      const crowd = ms.length > 24 ? 24 / ms.length : 1;
      const zk = camera.fov ? Math.tan(camera.fov * Math.PI / 360) / Math.tan(55 * Math.PI / 360) : 1;
      let n = 0;
      const f = this.frame, G = fx.glow, P = fx.puff;
      for (const m of ms) {
         if (!m.alive) continue;
         const L = LOOK[m.kind] || LOOK.ssm;
         const x = m.px + (m.x - m.px) * a, z = m.py + (m.y - m.py) * a, y = Math.max(2, m.alt);
         let st = this.state.get(m.id);
         if (!st) {
            st = { x, y, z, dx: Math.cos(m.heading), dy: 0, dz: Math.sin(m.heading), dist: 0, kind: m.kind, acc: Math.random(), seen: f, vy: 0 };
            this.state.set(m.id, st);
         }
         const hx = Math.cos(m.heading), hz = Math.sin(m.heading);
         // climb angle from the height change, smoothed (the sim moves height in steps)
         const hd = Math.hypot(x - st.x, z - st.z);
         if (hd > 0.5) st.vy += (clamp((y - st.y) / hd, -1.2, 1.2) - st.vy) * 0.25;
         const inv = 1 / Math.hypot(1, st.vy);
         st.dx = hx * inv; st.dy = st.vy * inv; st.dz = hz * inv;
         st.x = x; st.y = y; st.z = z; st.seen = f;
         const dist = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
         st.dist = dist;
         if (n < MAX_BODIES) {
            // kept a few pixels long at any range so a missile can be followed by eye
            const sc = Math.max(1.5, dist * zk / 520), len = L.len * sc, gi = L.len * sc * L.girth;
            // basis: X = flight direction, Z = right, Y = up
            let rx = -st.dz, rz = st.dx; const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
            const ux = -st.dy * rz * 1, uy = st.dx * rz - st.dz * rx, uz = st.dy * rx;
            const o = n * 16;
            im[o] = st.dx * len; im[o + 1] = st.dy * len; im[o + 2] = st.dz * len; im[o + 3] = 0;
            im[o + 4] = ux * gi; im[o + 5] = uy * gi; im[o + 6] = uz * gi; im[o + 7] = 0;
            im[o + 8] = rx * gi; im[o + 9] = 0; im[o + 10] = rz * gi; im[o + 11] = 0;
            im[o + 12] = x; im[o + 13] = y; im[o + 14] = z; im[o + 15] = 1;
            const c = this._col[m.kind] || this._col.ssm;
            ic[n * 3] = c.r; ic[n * 3 + 1] = c.g; ic[n * 3 + 2] = c.b;
            n++;
         }
         // engine: one soft point that lives for this frame only
         const gs = L.gs * Math.max(1, dist * zk / 420);
         let p = G.t();
         p.x = x - st.dx * L.len * 0.6; p.y = y - st.dy * L.len * 0.6; p.z = z - st.dz * L.len * 0.6;
         p.life = 0.05; p.s0 = gs; p.s1 = gs; p.r = L.glow[0]; p.g = L.glow[1]; p.b = L.glow[2]; p.fin = 0; p.fout = 0; p.shape = 0;
         G.emit(true);
         // smoke: puffs dropped along the path
         if (tq[0] > 0 && dist < 14000) {
            st.acc += dt * L.sm.rate * tq[0] * crowd * (dist > 6000 ? 0.5 : 1);
            const sm = L.sm, far = Math.max(1, dist / 1400);
            while (st.acc >= 1) {
               st.acc -= 1;
               const back = rr(0, m.speed * dt);
               p = P.t();
               p.x = x - st.dx * back + rr(-1, 1); p.y = y - st.dy * back + rr(-0.6, 0.6); p.z = z - st.dz * back + rr(-1, 1);
               p.vx = -st.dx * 6 + rr(-1.5, 1.5); p.vy = rr(0.3, 2); p.vz = -st.dz * 6 + rr(-1.5, 1.5); p.drag = 1.2;
               p.life = sm.life * tq[1] * rr(0.8, 1.2); p.s0 = sm.s * far; p.s1 = sm.s * 3.4 * far; p.grow = 2;
               p.r = sm.c; p.g = sm.c; p.b = sm.c * 1.02; p.r1 = sm.c * 0.8; p.g1 = sm.c * 0.8; p.b1 = sm.c * 0.82;
               p.a = sm.a; p.fin = 0.04; p.fout = 0.55; p.shape = 1; p.lit = 0.8; p.wind = 0.6; p.rot = rr(0, TAU); p.spin = rr(-0.5, 0.5);
               P.emit();
            }
         }
      }
      B.count = n;
      B.instanceMatrix.needsUpdate = true; B.instanceColor.needsUpdate = true;
      if (this.state.size > n) for (const [id, st] of this.state) if (st.seen !== f) this.state.delete(id);

      this._decoys(world, dt, cam);
      this._ciws(world, ships, cam, dt);
   }

   // ---------------------------------------------------------------- tracers (called by FX._shells)
   _tracers(T, cam) {
      const w = this._world;
      if (!w) return;
      const zk = this.fx._zk || 1;
      // exhaust streak behind every missile: reads as a smoke trail at any range, costs one quad
      for (const m of w.missiles || []) {
         if (!m.alive) continue;
         const st = this.state.get(m.id);
         if (!st) continue;
         const L = LOOK[m.kind] || LOOK.ssm, c = L.streak;
         const wd = Math.max(1.2, st.dist * 0.0022 * Math.max(zk, 0.12));
         const fade = clamp(st.dist / 200, 0.2, 1);
         T.add(st.x, st.y, st.z, st.dx, st.dy, st.dz, L.sl + st.dist * 0.01, wd * 4.5, c[0], c[1], c[2], 0.5 * fade);
         T.add(st.x, st.y, st.z, st.dx, st.dy, st.dz, L.len * 3, wd * 5, L.glow[0] * 0.25, L.glow[1] * 0.25, L.glow[2] * 0.25, 0.9 * fade);
      }
      // close-in guns: a rope of tracers from the mount to the target
      const N = GFX.effects >= 2 ? 9 : GFX.effects >= 1 ? 6 : 4, t = this._time || 0;
      for (const s of this._streams) {
         const dx = s.tx - s.x, dy = s.ty - s.y, dz = s.tz - s.z, d = Math.hypot(dx, dy, dz) || 1;
         const ax = dx / d, ay = dy / d, az = dz / d;
         const cd = Math.hypot(s.x - cam.x, s.y - cam.y, s.z - cam.z);
         const wd = Math.max(0.5, cd * 0.0013 * Math.max(zk, 0.12));
         for (let i = 0; i < N; i++) {
            const u = (t * 2.6 + i / N + s.ph) % 1, k = u * d;
            // light spread of the burst
            const j = Math.sin((i + s.ph * 9) * 12.9898 + Math.floor(t * 2.6 + i / N) * 4.1) * 0.006 * k;
            T.add(s.x + ax * k + az * j, s.y + ay * k + j * 0.5, s.z + az * k - ax * j, ax, ay, az, 26 + cd * 0.004, wd * 5, 7, 2.6, 0.5, 0.9 * (1 - u * 0.5));
         }
      }
   }

   // ---------------------------------------------------------------- close-in guns
   _ciws(world, ships, cam, dt) {
      const S = this._streams;
      let n = 0;
      const one = (P, x, y, z) => {
         const list = P.ciwsTgt;
         if (!P.alive || !list || !list.length) return;
         for (let i = 0; i < list.length; i++) {
            const st = this.state.get(list[i]);
            if (!st) continue;
            const s = S[n] || (S[n] = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, ph: 0 });
            n++;
            // alternate fore / aft mount
            const h = P.heading || 0, off = (i % 2 ? 1 : -1) * (P.cfg?.hull?.L || 0) * 0.2;
            s.x = x + Math.cos(h) * off; s.y = y; s.z = z + Math.sin(h) * off;
            s.tx = st.x; s.ty = st.y; s.tz = st.z; s.ph = ((P.id * 7 + i * 3) % 10) / 10;
            // muzzle: a flicker at the mount, on higher tiers a wisp of gun smoke
            const G = this.fx.glow, p = G.t();
            p.x = s.x; p.y = s.y; p.z = s.z; p.life = 0.05; p.s0 = rr(2.5, 4.5); p.s1 = p.s0; p.r = 22; p.g = 11; p.b = 3; p.fin = 0; p.fout = 0; p.shape = 0;
            G.emit(true);
            if (GFX.effects >= 2 && Math.random() < dt * 14) {
               const q = this.fx.puff.t();
               q.x = s.x; q.y = s.y + 1; q.z = s.z; q.vx = rr(-2, 2); q.vy = rr(1, 3); q.vz = rr(-2, 2); q.drag = 1; q.life = rr(1, 1.8); q.s0 = 2; q.s1 = 8; q.grow = 2;
               q.r = 0.6; q.g = 0.6; q.b = 0.6; q.a = 0.3; q.fin = 0.05; q.fout = 0.5; q.shape = 1; q.lit = 0.7; q.wind = 1; q.rot = rr(0, TAU);
               this.fx.puff.emit();
            }
         }
      };
      for (const P of world.ships || []) if (P.ciwsTgt && P.ciwsTgt.length) one(P, P.pos.x, 15, P.pos.y);
      for (const P of world.sites || []) if (P.ciwsTgt && P.ciwsTgt.length) one(P, P.x, 12, P.y);
      S.length = n;
      this.ciwsN = n;
   }

   // ---------------------------------------------------------------- decoy clouds
   _decoys(world, dt, cam) {
      const ds = world.decoys;
      if (!ds || !ds.length || GFX.effects < 1) return;
      const G = this.fx.glow, per = GFX.effects >= 2 ? 3 : 1;
      for (const d of ds) {
         const age = world.time - d.t0;
         if (age < 0 || Math.hypot(d.x - cam.x, d.y - cam.z) > 9000) continue;
         // chaff glitter: a few strips catching the sun, one frame each
         const R = Math.min(70, 20 + age * 6);
         for (let i = 0; i < per; i++) {
            const p = G.t(), a = rr(0, TAU), r = Math.sqrt(Math.random()) * R;
            p.x = d.x + Math.cos(a) * r; p.y = 22 + rr(-14, 22) + Math.max(0, 20 - age) * 0.6; p.z = d.y + Math.sin(a) * r;
            p.life = rr(0.08, 0.2); p.s0 = rr(0.8, 1.8); p.s1 = p.s0 * 0.5; p.r = 9; p.g = 9.5; p.b = 11; p.fin = 0.2; p.fout = 0.5; p.shape = 0;
            G.emit();
         }
      }
   }
   _decoyBurst(x, z, h) {
      const fx = this.fx, G = fx.glow, P = fx.puff, q = GFX.effects;
      const c = Math.cos(h), s = Math.sin(h);
      // mortar pops on both beams, then the cloud blooms above the sea
      for (const side of [-1, 1]) {
         const bx = x - s * side * 55, bz = z + c * side * 55, by = 38;
         let p = G.t();
         p.x = bx; p.y = by; p.z = bz; p.life = 0.25; p.s0 = 5; p.s1 = 22; p.grow = 3; p.r = 26; p.g = 26; p.b = 30; p.r1 = 4; p.g1 = 4; p.b1 = 5; p.fin = 0; p.fout = 0.3; p.shape = 0;
         G.emit();
         const nb = 3 + q * 3;
         for (let i = 0; i < nb; i++) {
            p = P.t();
            const a = rr(0, TAU), sp = rr(6, 22);
            p.x = bx; p.y = by; p.z = bz; p.vx = Math.cos(a) * sp; p.vy = rr(-3, 9); p.vz = Math.sin(a) * sp; p.drag = 1.1; p.grav = 0.25;
            p.life = rr(7, 12) * (q >= 2 ? 1.4 : 1); p.s0 = 7; p.s1 = rr(30, 46); p.grow = 2.2;
            p.r = 0.86; p.g = 0.88; p.b = 0.92; p.r1 = 0.7; p.g1 = 0.72; p.b1 = 0.76; p.a = 0.34; p.fin = 0.05; p.fout = 0.5; p.shape = 1; p.lit = 0.9; p.wind = 0.5; p.rot = rr(0, TAU); p.spin = rr(-0.2, 0.2);
            P.emit();
         }
         const ns = 8 + q * 10;
         for (let i = 0; i < ns; i++) {
            p = G.t();
            const a = rr(0, TAU), el = rr(-0.3, 1.1), sp = rr(12, 46);
            p.x = bx; p.y = by; p.z = bz; p.vx = Math.cos(a) * Math.cos(el) * sp; p.vy = Math.sin(el) * sp; p.vz = Math.sin(a) * Math.cos(el) * sp;
            p.drag = 1.6; p.grav = 2.2; p.life = rr(1.2, 3.2); p.s0 = 1.1; p.s1 = 0.4; p.r = 10; p.g = 10.5; p.b = 12; p.fin = 0; p.fout = 0.6; p.shape = 0;
            G.emit();
         }
         // flares: bright, slowly sinking, a short smoke thread
         for (let i = 0; i < 2; i++) {
            p = G.t();
            p.x = bx; p.y = by; p.z = bz; p.vx = rr(-14, 14) - s * side * 18; p.vy = rr(10, 20); p.vz = rr(-14, 14) + c * side * 18;
            p.drag = 0.5; p.grav = 5.5; p.life = rr(3.2, 4.6); p.s0 = 5; p.s1 = 2.5; p.r = 44; p.g = 30; p.b = 14; p.r1 = 20; p.g1 = 6; p.b1 = 1; p.fin = 0.02; p.fout = 0.35; p.shape = 0;
            G.emit();
         }
      }
      fx._light(x, 40, z, 5e4, 0.6, 1, 0.9, 0.75);
   }

   // ---------------------------------------------------------------- one-shot effects
   // blast out of a deck canister: flame along the launch bearing, smoke rolling over the deck
   _canister(x, y, z, hdg, k = 1) {
      const fx = this.fx, G = fx.glow, P = fx.puff, q = GFX.effects;
      const dx = Math.cos(hdg), dz = Math.sin(hdg);
      let p = G.t();
      p.x = x; p.y = y; p.z = z; p.life = 0.3; p.s0 = 5 * k; p.s1 = 20 * k; p.grow = 3; p.r = 44; p.g = 24; p.b = 8; p.r1 = 7; p.g1 = 2; p.b1 = 0.3; p.fin = 0; p.fout = 0.2; p.shape = 0;
      G.emit();
      const nf = 2 + q;
      for (let i = 0; i < nf; i++) {
         p = G.t();
         const u = i / nf;
         p.x = x - dx * (4 + u * 14) * k; p.y = y + rr(-1, 2); p.z = z - dz * (4 + u * 14) * k;
         p.vx = -dx * rr(20, 50); p.vy = rr(0, 6); p.vz = -dz * rr(20, 50); p.drag = 3;
         p.life = rr(0.25, 0.5); p.s0 = 4 * k; p.s1 = 11 * k; p.grow = 2.5; p.r = 20; p.g = 9; p.b = 2; p.r1 = 3; p.g1 = 0.6; p.b1 = 0.1; p.fin = 0.02; p.fout = 0.4; p.shape = 1; p.rot = rr(0, TAU);
         G.emit();
      }
      const ns = 3 + q * 3;
      for (let i = 0; i < ns; i++) {
         p = P.t();
         p.x = x + rr(-3, 3); p.y = y + rr(0, 3); p.z = z + rr(-3, 3);
         p.vx = -dx * rr(6, 26) + rr(-5, 5); p.vy = rr(2, 9); p.vz = -dz * rr(6, 26) + rr(-5, 5); p.drag = 1.3; p.grav = -0.4;
         p.life = rr(4, 7.5); p.s0 = 6 * k; p.s1 = rr(24, 38) * k; p.grow = 2.4;
         p.r = 0.82; p.g = 0.8; p.b = 0.78; p.r1 = 0.62; p.g1 = 0.61; p.b1 = 0.6; p.a = 0.6; p.fin = 0.05; p.fout = 0.5; p.shape = 1; p.lit = 0.8; p.wind = 1; p.rot = rr(0, TAU); p.spin = rr(-0.4, 0.4);
         P.emit();
      }
      fx._light(x, y + 5, z, 9e4 * k, 0.45, 1, 0.7, 0.4);
   }
   // vertical launch: a jet of flame straight up and a smoke column standing over the cells
   _vls(x, y, z, k = 1) {
      const fx = this.fx, G = fx.glow, P = fx.puff, q = GFX.effects;
      let p = G.t();
      p.x = x; p.y = y + 2; p.z = z; p.life = 0.35; p.s0 = 6 * k; p.s1 = 18 * k; p.grow = 3; p.r = 48; p.g = 30; p.b = 12; p.r1 = 8; p.g1 = 2.5; p.b1 = 0.4; p.fin = 0; p.fout = 0.25; p.shape = 0;
      G.emit();
      p = G.t();
      p.x = x; p.y = y; p.z = z; p.axY = 1; p.h = 34 * k; p.life = 0.45; p.s0 = 4 * k; p.s1 = 9 * k; p.grow = 2;
      p.r = 30; p.g = 16; p.b = 5; p.r1 = 5; p.g1 = 1.2; p.b1 = 0.2; p.fin = 0.02; p.fout = 0.5; p.shape = 3;
      G.emit();
      const ns = 4 + q * 3;
      for (let i = 0; i < ns; i++) {
         p = P.t();
         const u = i / ns;
         p.x = x + rr(-2.5, 2.5); p.y = y + u * 30 * k; p.z = z + rr(-2.5, 2.5);
         p.vx = rr(-3, 3); p.vy = rr(6, 20) * (1 - u * 0.5); p.vz = rr(-3, 3); p.drag = 0.9; p.grav = -0.5;
         p.life = rr(4.5, 8); p.s0 = 5 * k; p.s1 = rr(20, 32) * k; p.grow = 2.4;
         p.r = 0.93; p.g = 0.92; p.b = 0.9; p.r1 = 0.7; p.g1 = 0.7; p.b1 = 0.7; p.a = 0.62; p.fin = 0.05; p.fout = 0.5; p.shape = 1; p.lit = 0.85; p.wind = 1; p.rot = rr(0, TAU); p.spin = rr(-0.4, 0.4);
         P.emit();
      }
      fx._light(x, y + 8, z, 1.1e5 * k, 0.5, 1, 0.75, 0.45);
   }
   // a missile killed in the air: white flash, burning fragments carrying on, a grey smudge
   _intercept(x, y, z, hard) {
      const fx = this.fx, G = fx.glow, P = fx.puff, q = GFX.effects, k = hard ? 1.5 : 0.9;
      let p = G.t();
      p.x = x; p.y = y; p.z = z; p.life = 0.2; p.s0 = 7 * k; p.s1 = 30 * k; p.grow = 3; p.r = 52; p.g = 46; p.b = 36; p.r1 = 9; p.g1 = 4; p.b1 = 1; p.fin = 0; p.fout = 0.2; p.shape = 0;
      G.emit();
      const ns = Math.round((6 + q * 6) * k);
      for (let i = 0; i < ns; i++) {
         p = G.t();
         const a = rr(0, TAU), el = rr(-0.9, 0.9), sp = rr(30, 110);
         p.x = x; p.y = y; p.z = z; p.vx = Math.cos(a) * Math.cos(el) * sp; p.vy = Math.sin(el) * sp; p.vz = Math.sin(a) * Math.cos(el) * sp;
         p.grav = 9.8; p.drag = 0.5; p.life = rr(0.6, 1.6); p.s0 = 0.9; p.s1 = 0.4; p.stretch = 0.07;
         p.r = 20; p.g = 10; p.b = 3; p.r1 = 5; p.g1 = 1; p.b1 = 0.15; p.fin = 0; p.fout = 0.6; p.shape = 3;
         G.emit();
      }
      const nb = 1 + (q >= 2 ? 2 : q);
      for (let i = 0; i < nb; i++) {
         p = P.t();
         p.x = x + rr(-3, 3); p.y = y + rr(-2, 3); p.z = z + rr(-3, 3); p.vx = rr(-5, 5); p.vy = rr(-1, 3); p.vz = rr(-5, 5); p.drag = 0.9;
         p.life = rr(3.5, 6); p.s0 = 8 * k; p.s1 = 30 * k; p.grow = 2.6; p.r = 0.2; p.g = 0.19; p.b = 0.18; p.r1 = 0.36; p.g1 = 0.35; p.b1 = 0.34;
         p.a = 0.7; p.fin = 0.04; p.fout = 0.5; p.shape = 1; p.lit = 0.6; p.wind = 1; p.rot = rr(0, TAU); p.spin = rr(-0.3, 0.3);
         P.emit();
      }
      fx._light(x, y, z, 1.2e5 * k, 0.3, 1, 0.9, 0.7);
   }
   // warhead on target: far bigger than a shell hit -- fireball rolling up, black column, ring on the sea
   _warhead(x, y, z, k, land) {
      const fx = this.fx, G = fx.glow, P = fx.puff, q = GFX.effects;
      fx._explosion(x, y, z, 460, false, 1.25 * k);
      let p;
      const nf = 2 + q;
      for (let i = 0; i < nf; i++) {
         p = G.t();
         p.x = x + rr(-5, 5) * k; p.y = y + rr(2, 8) * k; p.z = z + rr(-5, 5) * k; p.vx = rr(-4, 4); p.vy = rr(14, 30) * k; p.vz = rr(-4, 4); p.drag = 1.1;
         p.life = rr(0.9, 1.6); p.s0 = 9 * k; p.s1 = 34 * k; p.grow = 2.6; p.r = 20; p.g = 8; p.b = 1.8; p.r1 = 2.4; p.g1 = 0.4; p.b1 = 0.06; p.fin = 0.03; p.fout = 0.45; p.shape = 1; p.rot = rr(0, TAU); p.spin = rr(-1, 1);
         G.emit();
      }
      const ns = 3 + q * 2;
      for (let i = 0; i < ns; i++) {
         p = P.t();
         p.x = x + rr(-4, 4) * k; p.y = y + rr(2, 10) * k; p.z = z + rr(-4, 4) * k; p.vx = rr(-3, 3); p.vy = rr(8, 22) * k; p.vz = rr(-3, 3); p.drag = 0.5; p.grav = -1;
         p.life = rr(7, 12); p.s0 = 10 * k; p.s1 = rr(44, 64) * k; p.grow = 2.4; p.r = 0.05; p.g = 0.045; p.b = 0.04; p.r1 = 0.2; p.g1 = 0.19; p.b1 = 0.18;
         p.a = 0.85; p.fin = 0.05; p.fout = 0.45; p.shape = 1; p.lit = 0.6; p.wind = 1; p.rot = rr(0, TAU); p.spin = rr(-0.3, 0.3);
         P.emit();
      }
      if (!land && y < 40 && fx.decals) fx.decals.add(1, x, z, 0, 24 * k, 170 * k, 1.8, 0.6, 3);
      fx._light(x, y + 8, z, 2.6e5 * k, 0.6, 1, 0.6, 0.3);
   }

   _events(world, ships, cam) {
      const ev = world.events;
      if (!ev || !ev.length) return;
      if (this.lastSeq < 0 && ev[ev.length - 1].seq > 40 && world.time > 3) this.lastSeq = ev[ev.length - 1].seq;   // joined a running battle
      const o = this._o || (this._o = { x: 0, y: 0, z: 0, sub: false, h: 0 });
      let i = ev.length - 1;
      while (i >= 0 && ev[i].seq > this.lastSeq) i--;
      for (i++; i < ev.length; i++) {
         const e = ev[i];
         this.lastSeq = e.seq;
         if (!e.pos) continue;
         if (Math.hypot(e.pos.x - cam.x, e.pos.y - cam.z) > 16000) continue;
         switch (e.type) {
            case 'ssmLaunch': {
               if (e.air) break;
               const m = world.missiles.find(q => q.id === e.missileId);
               if (!this.launchPoint(world, ships, e.srcId, 'ssm', o)) break;
               if (o.sub) this.fx._splash(o.x, o.z, 380, true);
               else this._canister(o.x, o.y, o.z, m ? m.heading : o.h, 1);
               break;
            }
            case 'cruiseLaunch':
               if (!this.launchPoint(world, ships, e.srcId, 'vls', o)) break;
               if (o.sub) { this.fx._splash(o.x, o.z, 406, true); this._vls(o.x, 1, o.z, 0.7); }
               else this._vls(o.x, o.y, o.z, 1.15);
               break;
            case 'samLaunch':
               if (!this.launchPoint(world, ships, e.srcId, 'vls', o)) break;
               this._vls(o.x, o.y, o.z, 0.7);
               break;
            case 'rockets': {
               if (!this.launchPoint(world, ships, e.srcId, 'rockets', o)) break;
               const h = e.to ? Math.atan2(e.to.y - e.pos.y, e.to.x - e.pos.x) : o.h;
               this._canister(o.x, o.y - 3, o.z, h, 0.8);
               break;
            }
            case 'intercept': this._intercept(e.pos.x, Math.max(6, e.alt || 10), e.pos.y, e.by !== 'ciws'); break;
            case 'samMiss':
               if (GFX.effects >= 1) this.fx._flak(e.pos.x, Math.max(6, e.alt || 10), e.pos.y, 0.8);
               break;
            case 'missileHit': {
               const S = world.sites ? world.sites.find(s => s.id === e.dstId) : null;
               if (e.kind === 'rocket') { this.fx._explosion(e.pos.x, S ? this._siteY(S) + 4 : 6, e.pos.y, 203, false, 0.9); break; }
               this._warhead(e.pos.x, S ? this._siteY(S) + 6 : 9, e.pos.y, e.kind === 'cruise' ? 1.2 : 1, !!S);
               break;
            }
            case 'decoy': {
               const P = world.shipById ? world.shipById(e.srcId) : null;
               this._decoyBurst(P ? P.pos.x : e.pos.x, P ? P.pos.y : e.pos.y, P ? P.heading : 0);
               break;
            }
            case 'siteDestroyed': {
               const S = world.sites ? world.sites.find(s => s.id === e.dstId) : null;
               const y = S ? this._siteY(S) : 8;
               this._warhead(e.pos.x, y + 8, e.pos.y, 1.7, true);
               this.fx._explosion(e.pos.x + rr(-20, 20), y + 6, e.pos.y + rr(-20, 20), 406, true, 1.1);
               break;
            }
            default:
         }
      }
   }

   // ---------------------------------------------------------------- land positions
   _siteY(S) { const r = this.sites.get(S); return r ? r.group.position.y : 4; }
   _siteGeo(kind, r) {
      const key = kind + '|' + r;
      let g = this.siteGeo.get(key);
      if (!g) {
         const b = (SITE_BUILD[kind] || SITE_BUILD.bunker)(r);
         g = { geo: mergeColored(b.parts), dish: b.dish };
         this.siteGeo.set(key, g);
      }
      return g;
   }
   _sites(world, dt, time, cam) {
      const sites = world.sites;
      if (!sites || !sites.length) return;
      const q = GFX.effects;
      for (const S of sites) {
         let r = this.sites.get(S);
         if (!r) {
            const g = this._siteGeo(S.model || S.kind, S.r);
            const group = new THREE.Group();
            const mesh = new THREE.Mesh(g.geo, this.siteMat);
            mesh.castShadow = false; mesh.receiveShadow = false;
            group.add(mesh);
            let dish = null;
            if (g.dish) {
               const dg = this.dishGeo[g.dish.kind] || (this.dishGeo[g.dish.kind] = dishGeometry(g.dish.kind));
               dish = new THREE.Mesh(dg, this.siteMat);
               dish.position.set(g.dish.x, g.dish.y, g.dish.z);
               dish.userData.speed = g.dish.speed;
               group.add(dish);
            }
            // stand on the highest ground under the footprint so nothing is buried in a slope
            const T = this.terrain;
            let h = 2;
            if (T && T.heightAt) {
               h = Math.max(h, T.heightAt(S.x, S.y));
               const rr2 = S.r * 0.6;
               let hi = h;
               for (let k = 0; k < 4; k++) hi = Math.max(hi, T.heightAt(S.x + Math.cos(k * TAU / 4) * rr2, S.y + Math.sin(k * TAU / 4) * rr2));
               h = Math.min(hi, h + 14) + 0.6;
            }
            group.position.set(S.x, h, S.y);
            group.rotation.y = -(S.heading || 0);
            this.scene.add(group);
            r = { group, mesh, dish, dead: false, acc: Math.random() };
            this.sites.set(S, r);
         }
         const frac = S.alive ? S.hp / (S.maxHp || 1) : 0;
         if (!S.alive && !r.dead) {
            r.dead = true;
            r.mesh.material = this.wreckMat;
            if (S.kind !== 'airfield') r.mesh.scale.y = 0.62;
            if (r.dish) r.dish.visible = false;
         }
         if (r.dish && !r.dead && S.radarOn !== false) r.dish.rotation.y = time * r.dish.userData.speed + S.id;
         // damage: smoke from half health, fire below a quarter; a wreck keeps smouldering
         if (q < 1 || frac > 0.55) continue;
         const d = Math.hypot(S.x - cam.x, S.y - cam.z);
         if (d > 12000) continue;
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
            if (!r.dead && frac < 0.25 || r.dead && Math.random() < 0.4) {
               p = this.fx.glow.t();
               p.x = S.x + ox + rr(-5, 5); p.y = y + rr(3, 7); p.z = S.y + oz + rr(-5, 5); p.vy = rr(4, 9); p.drag = 0.8;
               p.life = rr(0.5, 0.9); p.s0 = 6; p.s1 = 13; p.grow = 2; p.r = 16; p.g = 6; p.b = 1.2; p.r1 = 2; p.g1 = 0.3; p.b1 = 0.05; p.fin = 0.1; p.fout = 0.5; p.shape = 1; p.rot = rr(0, TAU);
               this.fx.glow.emit();
            }
         }
      }
   }
}
