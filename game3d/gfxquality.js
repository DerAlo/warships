// game3d/gfxquality.js — graphics quality tiers, the blank-frame watchdog and the ?diag overlay.
// Tiers trade pixel ratio, MSAA, bloom, shadow-map size and ocean mesh density. "auto" picks
// "medium" on phones/tablets and "high" elsewhere; the pause menu stores a fixed choice. The
// watchdog samples the finished frame a few times after start: a frame that comes out white at
// every probe (what broken half-float / NaN paths do on some mobile GPUs) steps the tier down and
// remembers the fallback for the next visit.

export const TIERS = {
   high:   { label: 'Hoch',    pr: 2,   samples: 4, bloom: true,  shadow: 4096, oceanSegs: 256 },
   medium: { label: 'Mittel',  pr: 1.5, samples: 2, bloom: true,  shadow: 2048, oceanSegs: 192 },
   low:    { label: 'Niedrig', pr: 1,   samples: 0, bloom: false, shadow: 1024, oceanSegs: 128 },
};
const ORDER = ['high', 'medium', 'low'];
const PREF_KEY = 'ks3d.gfx', FALLBACK_KEY = 'ks3d.gfxFallback';

const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } };

export function isMobileDevice() {
   const mm = (q) => (typeof matchMedia === 'function' ? matchMedia(q).matches : false);
   const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
   return (mm('(pointer: coarse)') && !mm('(pointer: fine)')) || /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
}

export function gfxPref() {
   const q = new URLSearchParams(location.search).get('gfx');
   if (q && (q === 'auto' || TIERS[q])) return q;
   const p = lsGet(PREF_KEY);
   return p && TIERS[p] ? p : 'auto';
}
export function setGfxPref(p) { lsSet(PREF_KEY, p === 'auto' ? null : p); if (p !== 'auto') lsSet(FALLBACK_KEY, null); }

// the tier to start with: a fixed choice wins, else the device default, lowered by a remembered fallback
export function startTier(pref = gfxPref()) {
   if (TIERS[pref]) return pref;
   let t = isMobileDevice() ? 'medium' : 'high';
   const fb = lsGet(FALLBACK_KEY);
   if (fb && TIERS[fb] && ORDER.indexOf(fb) > ORDER.indexOf(t)) t = fb;
   return t;
}
export function lowerTier(t) { return ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(t) + 1)]; }
export function rememberFallback(t) { lsSet(FALLBACK_KEY, t); }

// classify one set of probe pixels (RGBA bytes): white = every probe nearly white
export function frameLooksBlank(px) {
   let white = 0;
   const n = px.length >> 2;
   for (let i = 0; i < n; i++) if (Math.min(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) >= 240) white++;
   return n > 0 && white === n;
}

// probe positions (fractions of the canvas, y up as in readPixels): sky, both flanks, sea
export const PROBES = [[0.5, 0.8], [0.15, 0.55], [0.85, 0.55], [0.5, 0.3], [0.25, 0.12], [0.75, 0.12]];

export function gpuInfo(gl) {
   if (!gl) return {};
   const dbg = gl.getExtension('WEBGL_debug_renderer_info');
   const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
   return {
      webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
      gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      floatRT: !!gl.getExtension('EXT_color_buffer_float'),
      halfRT: !!gl.getExtension('EXT_color_buffer_half_float'),
      fragHighp: hp ? hp.precision : 0,
      maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxSamples: gl.MAX_SAMPLES ? gl.getParameter(gl.MAX_SAMPLES) : 0,
   };
}

// ?diag: a small always-on box with the GPU facts and the live quality state (for bug reports)
export function mountDiag(getState) {
   if (!/[?&]diag\b/.test(location.search)) return;
   const el = document.createElement('div');
   el.id = 'gfx-diag';
   el.style.cssText = 'position:fixed;left:4px;bottom:4px;z-index:300;max-width:60vw;background:rgba(0,0,0,.78);color:#cfe;'
      + 'font:11px/1.35 monospace;padding:6px 8px;border-radius:4px;pointer-events:none;white-space:pre-wrap';
   document.body.appendChild(el);
   const tick = () => {
      const s = getState();
      el.textContent = Object.entries(s).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
   };
   tick();
   setInterval(tick, 1000);
}
