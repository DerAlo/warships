// Fixture ship configs for the V2 model tests (unit test + browser preview). They follow the
// contract of gamev2/ships3d_modern.js; the real configs live in gamev2/config.js (sim agent).
// Some are deliberately a bit off the nominal size to exercise the scaling.
import { modernGunSlots, MODELS } from '../gamev2/ships3d_modern.js';
import { SHIPS as WW2 } from '../game3d/config.js';

const F = (model, nation, type, L, beam, extra = {}) => ({ model, name: model, hull: { type, L, beam, draft: 6, deckH: extra.deckH ?? 10, nation, ...extra.hull }, ...extra.cfg });
export const FIXTURES = {
   k130: F('k130', 'de', 'CO', 89.1, 13.3), f124: F('f124', 'de', 'FF', 143, 17.4), burke: F('burke', 'us', 'DD', 155, 20),
   tico: F('tico', 'us', 'CG', 173, 16.8), type45: F('type45', 'uk', 'DD', 152.4, 21.2), ford: F('ford', 'us', 'CV', 337, 41),
   u212: F('u212', 'de', 'SS', 56, 7, { deckH: 3, hull: { sup: { x: 5, len: 9, w: 2.5, h: 5 } } }),
   virginia: F('virginia', 'us', 'SS', 115, 10.4, { deckH: 3, hull: { sup: { x: 26, len: 9, w: 3, h: 5.5 } } }),
   buyan: F('buyan', 'ru', 'CO', 75, 11), gorshkov: F('gorshkov', 'ru', 'FF', 135, 16.4), slava: F('slava', 'ru', 'CG', 186, 20.8),
   kirovn: F('kirovn', 'ru', 'CG', 252, 28.5), kuznetsov: F('kuznetsov', 'ru', 'CV', 305, 35),
   kilo: F('kilo', 'ru', 'SS', 73.8, 9.9, { deckH: 3, hull: { sup: { x: 4, len: 15, w: 3.4, h: 5 } } }),
   type022: F('type022', 'cn', 'FAC', 42.6, 12.2), type054: F('type054', 'cn', 'FF', 134, 16), type052d: F('type052d', 'cn', 'DD', 157, 17),
   type055: F('type055', 'cn', 'CG', 180, 20), shandong: F('shandong', 'cn', 'CV', 305, 37.5),
   yuan: F('yuan', 'cn', 'SS', 77.6, 8.4, { deckH: 3, hull: { sup: { x: 10, len: 12, w: 3, h: 5.5 } } }),
   fac: F('fac', 'ir', 'FAC', 13, 2.9, { deckH: 1.5 }), moudge: F('moudge', 'ir', 'FF', 95, 11.1),
   ghadir: F('ghadir', 'ir', 'SS', 29, 3, { deckH: 1.5, hull: { sup: { x: 2, len: 4.5, w: 1.2, h: 2.8 } } }),
   tanker: F('tanker', 'us', 'TR', 250, 44), container: F('container', 'us', 'TR', 300, 40), lng: F('lng', 'us', 'TR', 290, 46),
   // scaling checks: a longer, beamier Burke (Flight III-ish numbers made up) and a small Kilo
   burke_scaled: F('burke', 'us', 'DD', 170, 23, { hull: { pennant: '125' } }),
};
export const MODEL_KEYS = Object.keys(MODELS);
export const WW2_REF = ['Bismarck', 'Fletcher'];

let id = 1;
export function mkModernShip(key, x = 0, y = 0, heading = 0) {
   const cfg = FIXTURES[key];
   const turrets = modernGunSlots(cfg.model, cfg.hull.L).map(g => ({ off: { x: g.x, y: 0 }, guns: g.guns, caliber: g.caliber, bearing: g.aft ? Math.PI - 0.5 : 0.5, elev: 0.12, reload: 0, alive: true }));
   return { id: id++, cls: key, cfg, side: 'player', isPlayer: false, name: key, pos: { x, y }, heading, speed: 0, speedKn: 0,
      alive: true, spotted: true, hp: 1, maxHP: 1, turrets, fires: [], floods: [], ammo: 'HE', torps: null };
}
export function mkWW2Ship(cls, x = 0, y = 0, heading = 0) {
   const cfg = WW2[cls];
   const cal = cfg.main?.caliber || 203;
   const turrets = (cfg.main?.turrets || []).map(t => ({ off: { x: t.off?.x ?? t.x ?? 0, y: t.off?.y ?? t.y ?? 0 }, guns: t.guns || 2, caliber: t.caliber || cal,
      bearing: (t.arcC || 0) + (t.arcC ? 0.25 : -0.35), elev: 0.06, reload: 0, alive: true }));
   return { id: id++, cls, cfg, side: 'player', isPlayer: false, name: cls, pos: { x, y }, heading, speed: 0, speedKn: 0,
      alive: true, spotted: true, hp: 1, maxHP: 1, turrets, fires: [], floods: [], ammo: 'HE', torps: null };
}
// triangles + meshes (= draw calls without shadows) of a ShipModels record
export function recStats(r) {
   let tris = 0, meshes = 0, bad = 0;
   const box = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };
   r.root.updateMatrixWorld(true);
   r.root.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const g = o.geometry, P = g.attributes.position;
      tris += (g.index ? g.index.count : P.count) / 3;
      const e = o.matrixWorld.elements;
      for (let i = 0; i < P.count; i++) {
         const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
         if (!Number.isFinite(x + y + z)) { bad++; continue; }
         const w = [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]];
         for (let k = 0; k < 3; k++) { if (w[k] < box.min[k]) box.min[k] = w[k]; if (w[k] > box.max[k]) box.max[k] = w[k]; }
      }
      const N = g.attributes.normal;
      for (let i = 0; i < N.count; i++) if (!Number.isFinite(N.getX(i) + N.getY(i) + N.getZ(i))) bad++;
   });
   return { tris: Math.round(tris), meshes, bad, box, size: box.max.map((v, k) => v - box.min[k]) };
}
