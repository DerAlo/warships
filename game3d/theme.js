// game3d/theme.js — canvas-side access to the Kriegsschiffe design tokens.
// The tokens themselves live in ONE place: the :root block at the top of index-3d.html (DOM UI
// uses them through var()). Canvas drawing cannot use var(), so this module reads the custom
// properties once at import time into a plain object; drawing code then only does property
// lookups (no getComputedStyle per frame). The fallbacks mirror index-3d.html for pages or tests
// without that stylesheet.
const FALLBACK = {
   hud: '#f1e9d4', 'hud-dim': '#b9ae93', gold: '#e6c06e',
   ally: '#5ec2f2', 'ally-soft': '#c6ebfb', enemy: '#ff6b3b', 'enemy-soft': '#ffd3c2', self: '#fff8e6', neutral: '#e8dfc8',
   ok: '#a3dc72', warn: '#f2c14e', bad: '#ec5b42', dead: '#5e5b54',
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

// The Kriegsschiffe mark: the signal flags K and S on a halyard plus the wordmark. Same markup as
// the loading screen in index-3d.html; styled by the .ks-logo rules there (colours via tokens).
export function logoSvg(sub = 'Seekrieg 1939 – 1945') {
   return '<div class="ks-logo"><svg viewBox="0 0 34 44" aria-hidden="true"><path class="hl" d="M3 1v42"/><path class="hl" d="M3 3h3M3 22h3"/>'
      + '<rect class="fy" x="6" y="3" width="13" height="16"/><rect class="fb" x="19" y="3" width="13" height="16"/>'
      + '<rect class="fw" x="6" y="22" width="26" height="16"/><rect class="fb" x="14" y="27" width="10" height="6"/></svg>'
      + `<span class="wm"><b>Kriegsschiffe</b><i>${sub}</i></span></div>`;
}
