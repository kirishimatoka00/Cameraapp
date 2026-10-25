/* 角度(拉直)與透視變形,預覽用。數學與原生 Geo.java 一致。 */
(() => {
'use strict';
const A = window.A;

A.geoZero = () => ({ angle: 0, pv: 0, ph: 0, rot: 0, flip: false });
A.geoNeutral = (g) => Math.abs(g.angle) < 0.01 && Math.abs(g.pv) < 0.5 && Math.abs(g.ph) < 0.5 && (g.rot & 3) === 0 && !g.flip;

function mapPt(x, y, w, h, s, cos, sin, kv, kh, o) {
  const X = (x - w / 2 + 0.5) / s, Y = (y - h / 2 + 0.5) / s;
  const X1 = X * (1 + kv * Y / h), Y1 = Y * (1 + kh * X / w);
  o[0] = X1 * cos - Y1 * sin + w / 2 - 0.5;
  o[1] = X1 * sin + Y1 * cos + h / 2 - 0.5;
  return o[0] >= 0 && o[1] >= 0 && o[0] <= w - 1 && o[1] <= h - 1;
}
function coverScale(w, h, cos, sin, kv, kh) {
  const o = [0, 0];
  for (let s = 1; s < 3; s += 0.004) {
    let ok = true;
    for (let i = 0; i <= 8 && ok; i++) {
      const t = i / 8;
      const pts = [[t * (w - 1), 0], [t * (w - 1), h - 1], [0, t * (h - 1)], [w - 1, t * (h - 1)]];
      for (const p of pts) if (!mapPt(p[0], p[1], w, h, s, cos, sin, kv, kh, o)) { ok = false; break; }
    }
    if (ok) return s;
  }
  return 3;
}

/** 回傳 { img: ImageData, w, h }。不修改輸入。 */
A.geoApply = (img, g) => {
  let w = img.width, h = img.height, d = img.data;
  const rot = g.rot & 3;
  if (rot || g.flip) {
    const nw = rot % 2 ? h : w, nh = rot % 2 ? w : h;
    const out = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      // 先翻轉再順時針轉 rot 次 90°;這裡由輸出座標反推來源
      let sx, sy;
      if (rot === 0) { sx = x; sy = y; }
      else if (rot === 1) { sx = y; sy = h - 1 - x; }
      else if (rot === 2) { sx = w - 1 - x; sy = h - 1 - y; }
      else { sx = w - 1 - y; sy = x; }
      if (g.flip) sx = w - 1 - sx;
      const si = (sy * w + sx) * 4, oi = (y * nw + x) * 4;
      out[oi] = d[si]; out[oi + 1] = d[si + 1]; out[oi + 2] = d[si + 2]; out[oi + 3] = 255;
    }
    d = out; w = nw; h = nh;
  }
  if (Math.abs(g.angle) < 0.01 && Math.abs(g.pv) < 0.5 && Math.abs(g.ph) < 0.5) {
    return { img: new ImageData(rot || g.flip ? d : new Uint8ClampedArray(d), w, h), w, h };
  }
  const a = g.angle * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
  const kv = g.pv / 100 * 0.35, kh = g.ph / 100 * 0.35;
  const s = coverScale(w, h, cos, sin, kv, kh);
  const out = new Uint8ClampedArray(w * h * 4), o = [0, 0];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    mapPt(x, y, w, h, s, cos, sin, kv, kh, o);
    const fx = Math.max(0, Math.min(w - 1, o[0])), fy = Math.max(0, Math.min(h - 1, o[1]));
    const ix = fx | 0, iy = fy | 0, jx = Math.min(w - 1, ix + 1), jy = Math.min(h - 1, iy + 1);
    const wx = fx - ix, wy = fy - iy;
    const i00 = (iy * w + ix) * 4, i10 = (iy * w + jx) * 4, i01 = (jy * w + ix) * 4, i11 = (jy * w + jx) * 4, oi = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) {
      out[oi + c] = (d[i00 + c] * (1 - wx) + d[i10 + c] * wx) * (1 - wy) + (d[i01 + c] * (1 - wx) + d[i11 + c] * wx) * wy;
    }
    out[oi + 3] = 255;
  }
  return { img: new ImageData(out, w, h), w, h };
};
})();
