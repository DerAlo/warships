// game3d/theme.js — canvas-side access to the Kriegsschiffe design tokens.
// The tokens themselves live in ONE place: the :root block at the top of index-3d.html (DOM UI
// uses them through var()). Canvas drawing cannot use var(), so this module reads the custom
// properties once at import time into a plain object; drawing code then only does property
// lookups (no getComputedStyle per frame). The fallbacks mirror index-3d.html for pages or tests
// without that stylesheet.
const FALLBACK = {
   hud: '#f1e9d4', 'hud-dim': '#b9ae93', gold: '#e6c06e',
   ally: '#5ec2f2', 'ally-soft': '#c6ebfb', enemy: '#f5503a', 'enemy-soft': '#ffd3c2', self: '#fff8e6', neutral: '#e8dfc8',
   ok: '#a3dc72', warn: '#f4d24c', bad: '#ec5b42', dead: '#5e5b54',
   he: '#ff9a4a', ap: '#a9d3ec', torp: '#9fe3b5', fire: '#ff6a1a', flood: '#4aa8ff',
   reticle: '#f6efdc', lead: '#ff3b22', 'lead-torp': '#4ff09a',
   'map-sea': '#163843', 'map-sea-2': '#0f2a33', 'map-land': '#8e8a62', 'map-coast': '#e1cf9a', 'map-grid': '#d8c79a', 'map-ink': '#0c1a20',
   font: 'Bahnschrift, "DIN Alternate", "Segoe UI", sans-serif', mono: 'Bahnschrift, "DIN Alternate", Consolas, monospace',
};

function read() {
   const out = { ...FALLBACK };
   if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return out;
   const cs = getComputedStyle(document.documentElement);
   for (const k of Object.keys(FALLBACK)) {
      const v = cs.getPropertyValue('--' + k).trim();
      if (v) out[k] = v;
   }
   return out;
}

// '#rrggbb' (or '#rgb') + alpha -> 'rgba(r,g,b,a)'; anything else is returned unchanged
export function rgba(hex, a) {
   let h = String(hex).trim();
   if (h[0] !== '#') return h;
   h = h.slice(1);
   if (h.length === 3) h = h.split('').map(c => c + c).join('');
   const n = parseInt(h.slice(0, 6), 16);
   return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export const T = read();
// canvas font strings (Bahnschrift on Windows, system fallbacks elsewhere)
export const FONT = (px, weight = '') => `${weight ? weight + ' ' : ''}${px}px ${T.font}`;
export const MONO = (px, weight = '') => `${weight ? weight + ' ' : ''}${px}px ${T.mono}`;

// The Kriegsschiffe mark: a brass-rimmed shield with a twin-gun turret, its barrels crossed, over
// three waves. Same markup as the loading screen in index-3d.html; styled by the .ks-mark rules
// there (colours via tokens).
export const CREST_SVG = '<svg class="ks-crest" viewBox="0 0 40 46" aria-hidden="true">'
   + '<path class="sh" d="M20 1.5 37.5 7v15c0 11-7.5 18.5-17.5 22.5C10 40.5 2.5 33 2.5 22V7Z"/>'
   + '<path class="rim" d="M20 5 34.2 9.5V22c0 9-6 15.2-14.2 18.7C11.8 37.2 5.8 31 5.8 22V9.5Z"/>'
   + '<g class="br"><rect x="18.6" y="6.5" width="2.8" height="18" rx=".8" transform="rotate(-36 20 24)"/><rect x="18.6" y="6.5" width="2.8" height="18" rx=".8" transform="rotate(36 20 24)"/></g>'
   + '<path class="tu" d="M12 30.5h16l-2.2-7.2H14.2Z"/><rect class="tu" x="10" y="30.5" width="20" height="2.6" rx=".8"/>'
   + '<path class="wv" d="M10 36.6q2.5-1.8 5 0t5 0 5 0 5 0"/></svg>';

export function logoSvg(sub = 'Seekrieg der Gegenwart') {
   return `<div class="ks-mark">${CREST_SVG}<span class="wm"><b>Kriegsschiffe</b>${sub ? `<i>${sub}</i>` : ''}</span></div>`;
}
