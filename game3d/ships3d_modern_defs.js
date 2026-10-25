// game3d/ships3d_modern_defs.js — model definitions for ships3d_modern.js in the WW2 mode: only the
// cheat-only railgun ship Donar (copied from gamev2/ships3d_modern_defs.js; keep the two in step).
// Each entry: nominal size (L, B, T draught, D freeboard amidships, metres), kind, hull form P (see
// makeHullShape), default nation / pennant, gunSlots (trainable mounts, in sim turret order) and
// build(k), which draws the rest with the Kit (x forward, y up, z starboard).
const PI = Math.PI;
const WARSHIP = { pb: 2.25, tr: 0.66, sheer: 0.6, flare: 1.2, rake: 0.05, nMid: 4.5, tumble: 1 };
const P = (o) => ({ ...WARSHIP, ...o });
const both = (fn) => { fn(1); fn(-1); };

// enclosed pyramid mast on y0; returns its top
function pyramid(k, x0, x1, hw, y0, h, o = {}) {
   return k.hs(x0, x1, hw, y0, h, { s: hw * (o.taper ?? 0.6), rf: (x1 - x0) * 0.22, ra: (x1 - x0) * 0.22, cf: hw * 0.5, ca: hw * 0.5, col: k.c.sup, ...o });
}
function hangarDoor(k, x, y0, y1, hw) { if (k.det >= 1) k.bx(x - 0.12, x + 0.05, y0 + 0.3, y1 - 0.8, -hw, hw, k.c.dark); }

export const MODELS = {
   // ================= experimental =================
   // Donar: wave-piercing tumblehome hull, one faceted deckhouse with flush arrays, railguns fore and
   // superfiring aft over the flight deck, lasers instead of guns for close-in defence, no funnel.
   donar: {
      L: 192, B: 25, T: 8, D: 8.6, kind: 'ship', nation: 'de', pennant: '1', hullCol: 0x4c535b, supCol: 0x535a62, deckCol: 0x3b4046,
      P: P({ sheer: 0.12, tr: 0.74, flare: 1.0, rake: -0.045, tumble: 0.8, pb: 2.6, nMid: 5 }),
      gunSlots: [{ style: 'rail', x: 66 }, { style: 'rail', x: -52, aft: true, y: 16.4 }],
      build(k) {
         const c = k.c, arrCol = shade3(c.sup, 0.72);
         k.vls('vlsFore', 40, 56, 6.2, null, 80);
         const yl = k.hs(31, 38.5, 4.4, null, 3.2, { s: 1.2, cf: 2, rf: 0.6 });
         k.ciws('laser', 35, yl, 0, 0);
         // main deckhouse: steep inward-sloped faces, big corner chamfers carry the four array faces
         const y1 = k.hs(-27, 31, 10.8, null, 10.5, { s: 3.2, cf: 6, ca: 4.5, rf: 2.2, ra: 1.2 });
         for (const i of [0, 2, 4, 6]) k.arr(i, 0.55, 3.4, 4, arrCol);
         const y2 = k.hs(-18, 25, 7.4, y1, 6, { s: 2.2, cf: 4.2, ca: 3, rf: 1.6, win: [0.45, 0.78] });
         both(s => k.ciws('laser', -6, y1, s * 7.4, s * PI / 2));
         // integrated mast: a sharp faceted pyramid with the volume-search arrays
         const yt = pyramid(k, -1, 17, 4.8, y2, 13, { taper: 0.7, s: 3.4, cf: 2.6, ca: 2.6, rf: 3.2, ra: 2.8 });
         for (const i of [0, 2, 4, 6]) k.arr(i, 0.45, 1.5, 4, c.radar);
         k.mast(8, yt, 3, 0.45, 0.2, { col: c.dark });
         k.mastTop(8, yt + 3);
         both(s => k.decoy(-22, y1 - 3, s * 8.2, s * 1.2));
         k.vls('vlsAft', -40, -28.5, 6.2, null, 80);
         // hangar block; the aft railgun fires over the flight deck from its roof
         const ya = k.hs(-66, -41, 10.6, null, 7.4, { s: 2.4, ra: 0.4, rf: 1.4, cf: 2, ca: 0.5 });
         hangarDoor(k, -65.8, k.dk(-66), ya - 0.6, 7.5);
         k.ciws('laser', -44, ya, 0, PI);
         k.helo(-94, -67);
         k.num('1');
      },
   },
};

function shade3(rgb, f) { return [rgb[0] * f, rgb[1] * f, rgb[2] * f]; }
