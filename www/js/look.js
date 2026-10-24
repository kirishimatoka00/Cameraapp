/* 色彩設定(Look):數學、預覽濾鏡、內建/自訂色彩檔案。
 * processPixels 的公式必須與原生 LookMath.java 完全一致。
 */
(() => {
'use strict';
const A = window.A;

const K_SHADOW = 1.0, K_HIGHLIGHT = 0.4, K_CONTRAST = 0.8;

A.neutralLook = () => ({
  ev: 0, contrast: 0, highlights: 0, shadows: 0, saturation: 0,
  tint: 0, temperature: 0, detail: 0,
  wbMode: 'auto',        // auto | kelvin | custom
  kelvin: 5500,
  gains: [1, 1, 1],
});
A.cloneLook = (l) => {
  const n = Object.assign(A.neutralLook(), JSON.parse(JSON.stringify(l || {})));
  if (!Array.isArray(n.gains) || n.gains.length < 3) n.gains = [1, 1, 1];
  return n;
};

/* ------------------------------------------------------------------ 色溫 → RGB */

A.kelvinRGB = (K) => {
  const t = A.clamp(K, 1000, 40000) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (v) => A.clamp(v, 1, 255) / 255;
  return [c(r), c(g), c(b)];
};
/* 以 5500K 為基準的相對增益(假設場景光源為 K,補償成中性) */
A.kelvinGains = (K) => {
  const ref = A.kelvinRGB(5500), c = A.kelvinRGB(K);
  const g = [ref[0] / c[0], ref[1] / c[1], ref[2] / c[2]];
  return [g[0] / g[1], 1, g[2] / g[1]];
};

/* ------------------------------------------------------------------ Look → 演算參數 */

A.lookParams = (look, opts) => {
  look = look || A.neutralLook();
  const skipWb = opts && opts.skipWb;
  let gr = 1, gg = 1, gb = 1;
  if (!skipWb) {
    if (look.wbMode === 'kelvin') {
      const g = A.kelvinGains(look.kelvin);
      gr *= g[0]; gg *= g[1]; gb *= g[2];
    } else if (look.wbMode === 'custom') {
      gr *= look.gains[0]; gg *= look.gains[1]; gb *= look.gains[2];
    }
  }
  const t = look.temperature / 100;
  gr *= 1 + 0.30 * t; gb *= 1 - 0.30 * t;
  const tn = look.tint / 100;
  gg *= 1 - 0.20 * tn; gr *= 1 + 0.06 * tn; gb *= 1 + 0.06 * tn;
  const r4 = (v) => Math.round(v * 10000) / 10000;
  return {
    ev: look.ev, contrast: look.contrast, highlights: look.highlights, shadows: look.shadows,
    saturation: look.saturation, detail: look.detail,
    gains: [r4(gr), r4(gg), r4(gb)],
  };
};
A.paramsNeutral = (p, ignoreDetail) => (
  p.ev === 0 && p.contrast === 0 && p.highlights === 0 && p.shadows === 0 && p.saturation === 0 &&
  p.gains[0] === 1 && p.gains[1] === 1 && p.gains[2] === 1 && (ignoreDetail || !(p.detail > 0))
);
A.lookIsNeutral = (look, opts) => A.paramsNeutral(A.lookParams(look, opts));

/* ------------------------------------------------------------------ 像素演算(與 LookMath.java 同步) */

const S2L = new Float32Array(256);
const L2S = new Float32Array(4097);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
for (let i = 0; i <= 4096; i++) {
  const l = i / 4096;
  L2S[i] = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
}
const enc = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : L2S[(x * 4096 + 0.5) | 0]);
const c01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** data: Uint8ClampedArray(RGBA),就地處理 */
A.processPixels = (data, p) => {
  if (A.paramsNeutral(p, true)) return;
  const ev2 = Math.pow(2, p.ev);
  const gR = p.gains[0] * ev2, gG = p.gains[1] * ev2, gB = p.gains[2] * ev2;
  const cf = 1 + p.contrast / 100 * K_CONTRAST;
  const sat = 1 + p.saturation / 100;
  const sh = p.shadows / 100, hi = p.highlights / 100;
  const doTone = sh !== 0 || hi !== 0, doC = p.contrast !== 0, doS = p.saturation !== 0;
  for (let i = 0; i < data.length; i += 4) {
    let r = enc(S2L[data[i]] * gR), g = enc(S2L[data[i + 1]] * gG), b = enc(S2L[data[i + 2]] * gB);
    if (doTone) {
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const f = 1 + K_SHADOW * sh * (1 - l) * (1 - l) + K_HIGHLIGHT * hi * l * l;
      r *= f; g *= f; b *= f;
    }
    if (doC) { r = (r - 0.5) * cf + 0.5; g = (g - 0.5) * cf + 0.5; b = (b - 0.5) * cf + 0.5; }
    if (doS) {
      const l2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = l2 + (r - l2) * sat; g = l2 + (g - l2) * sat; b = l2 + (b - l2) * sat;
    }
    data[i] = (c01(r) * 255 + 0.5) | 0;
    data[i + 1] = (c01(g) * 255 + 0.5) | 0;
    data[i + 2] = (c01(b) * 255 + 0.5) | 0;
  }
};

/** 預覽用 unsharp(只作用於亮度;與原生版相同概念,半徑依影像大小) */
A.unsharp = (data, w, h, amount, radius) => {
  if (amount <= 0 || radius < 1) return;
  const n = w * h;
  let y = new Float32Array(n), t = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) y[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  const pre = new Float64Array(Math.max(w, h) + 1);
  const boxH = (s, d) => {
    for (let r = 0; r < h; r++) {
      const b = r * w;
      pre[0] = 0;
      for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + s[b + x];
      for (let x = 0; x < w; x++) {
        const lo = Math.max(0, x - radius), hi = Math.min(w, x + radius + 1);
        d[b + x] = (pre[hi] - pre[lo]) / (hi - lo);
      }
    }
  };
  const boxV = (s, d) => {
    for (let x = 0; x < w; x++) {
      pre[0] = 0;
      for (let r = 0; r < h; r++) pre[r + 1] = pre[r] + s[r * w + x];
      for (let r = 0; r < h; r++) {
        const lo = Math.max(0, r - radius), hi = Math.min(h, r + radius + 1);
        d[r * w + x] = (pre[hi] - pre[lo]) / (hi - lo);
      }
    }
  };
  for (let k = 0; k < 2; k++) { boxH(y, t); boxV(t, y); }
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const orig = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
    const d = amount * (orig - y[i]);
    data[j] = Math.min(255, Math.max(0, Math.round(data[j] + d)));
    data[j + 1] = Math.min(255, Math.max(0, Math.round(data[j + 1] + d)));
    data[j + 2] = Math.min(255, Math.max(0, Math.round(data[j + 2] + d)));
  }
};
A.detailAmount = (d) => d / 100 * 1.5;
A.detailRadius = (w, h) => Math.max(1, Math.round(Math.max(w, h) / 1500));

/* ------------------------------------------------------------------ 即時預覽濾鏡(SVG,近似) */

A.updatePreviewFilter = (p) => {
  const el = A.$('video');
  if (A.paramsNeutral(p, true)) { el.style.filter = ''; return; }
  const ev2 = Math.pow(2, p.ev);
  const g = p.gains.map((v) => (v * ev2).toFixed(4));
  A.$('fx1').setAttribute('values',
    `${g[0]} 0 0 0 0  0 ${g[1]} 0 0 0  0 0 ${g[2]} 0 0  0 0 0 1 0`);
  const cf = 1 + p.contrast / 100 * K_CONTRAST;
  const sh = p.shadows / 100, hi = p.highlights / 100;
  const tv = [];
  for (let i = 0; i <= 32; i++) {
    const v = i / 32;
    let f = v * (1 + K_SHADOW * sh * (1 - v) * (1 - v) + K_HIGHLIGHT * hi * v * v);
    f = (f - 0.5) * cf + 0.5;
    tv.push(c01(f).toFixed(4));
  }
  const tbl = tv.join(' ');
  ['fx2r', 'fx2g', 'fx2b'].forEach((id) => A.$(id).setAttribute('tableValues', tbl));
  A.$('fx3').setAttribute('values', String(Math.max(0, 1 + p.saturation / 100)));
  el.style.filter = 'url(#lookfx)';
};

/* ------------------------------------------------------------------ 色彩檔案 */

A.BUILTIN_PROFILES = [
  { id: 'standard', name: '標準', builtin: true, look: {} },
  { id: 'vivid', name: '鮮豔', builtin: true, look: { contrast: 15, saturation: 30, detail: 15 } },
  { id: 'soft', name: '柔和', builtin: true, look: { contrast: -15, saturation: -10, highlights: -15, shadows: 15 } },
  { id: 'portrait', name: '人像', builtin: true, look: { contrast: -5, saturation: 8, temperature: 6, shadows: 10 } },
  { id: 'cinema', name: '電影', builtin: true, look: { contrast: 12, saturation: -15, temperature: -8, tint: 5, highlights: -20, shadows: 10 } },
  { id: 'retro', name: '復古', builtin: true, look: { contrast: -10, saturation: -20, temperature: 20, tint: 8, shadows: 8 } },
  { id: 'mono', name: '黑白', builtin: true, look: { saturation: -100, contrast: 20, detail: 20 } },
];
A.allProfiles = () => A.BUILTIN_PROFILES.concat(A.settings.profiles);
A.findProfile = (id) => A.allProfiles().find((p) => p.id === id) || null;

/** 目前相機使用的 Look */
A.currentLook = () => A.cloneLook(A.settings.look);
A.setCurrentLook = (look, profileId) => {
  A.settings.look = A.cloneLook(look);
  if (profileId !== undefined) A.settings.profileId = profileId;
  A.saveSettings();
  document.dispatchEvent(new CustomEvent('lookchange'));
};
A.applyProfile = (id) => {
  const pr = A.findProfile(id);
  if (!pr) return;
  A.setCurrentLook(A.cloneLook(pr.look), id);
};
A.saveCustomProfile = (name, look) => {
  const id = 'c' + Date.now().toString(36);
  A.settings.profiles.push({ id, name, look: A.cloneLook(look) });
  A.saveSettings();
  return id;
};
A.deleteCustomProfile = (id) => {
  A.settings.profiles = A.settings.profiles.filter((p) => p.id !== id);
  if (A.settings.profileId === id) A.settings.profileId = 'standard';
  A.saveSettings();
};
})();
