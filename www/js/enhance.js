/* 畫質提升:多張合成 / AI 放大 / 降噪(亮度、色彩)/ 銳利度,可存成設定檔 */
(() => {
'use strict';
const A = window.A;
const $ = A.$;

const KEYS = ['burst', 'nn', 'nnMix', 'dnL', 'dnC', 'sharp'];
A.enhZero = () => ({ burst: 1, nn: false, nnMix: 40, dnL: 0, dnC: 0, sharp: 0 });
A.cloneEnh = (e) => {
  const z = A.enhZero();
  const o = {};
  KEYS.forEach((k) => { o[k] = (e && e[k] !== undefined) ? e[k] : z[k]; });
  o.nn = !!o.nn;
  return o;
};
A.ENH_BUILTIN = [
  { id: 'off', name: '無', builtin: true, enh: { burst: 1, nn: false, nnMix: 40, dnL: 0, dnC: 0, sharp: 0 } },
  { id: 'std', name: '標準', builtin: true, enh: { burst: 1, nn: false, nnMix: 40, dnL: 20, dnC: 35, sharp: 30 } },
  { id: 'detail', name: '細節', builtin: true, enh: { burst: 3, nn: true, nnMix: 40, dnL: 15, dnC: 35, sharp: 40 } },
  { id: 'night', name: '夜景降噪', builtin: true, enh: { burst: 4, nn: false, nnMix: 40, dnL: 55, dnC: 70, sharp: 25 } },
  { id: 'max', name: '最強', builtin: true, enh: { burst: 4, nn: true, nnMix: 60, dnL: 30, dnC: 50, sharp: 35 } },
];
A.allEnhProfiles = () => A.ENH_BUILTIN.concat(A.settings.enhProfiles || []);
A.findEnhProfile = (id) => A.allEnhProfiles().find((p) => p.id === id) || null;

/** 確保 settings.enhCap / enhSet 結構完整 */
A.ensureEnhState = () => {
  const st = A.settings;
  if (!Array.isArray(st.enhProfiles)) st.enhProfiles = [];
  [['enhCap', true, 'detail'], ['enhSet', false, 'std']].forEach(([k, on, id]) => {
    let s = st[k];
    if (!s || typeof s !== 'object') s = st[k] = { on, id, enh: null };
    if (!s.enh) {
      const pr = A.findEnhProfile(s.id) || A.findEnhProfile(id);
      s.enh = A.cloneEnh(pr ? pr.enh : null);
    }
    s.enh = A.cloneEnh(s.enh);
  });
};
A.ensureEnhState();

/** 實際生效的設定(未啟用 = 全部關閉) */
A.enhEff = (s) => (s && s.on ? A.cloneEnh(s.enh) : A.enhZero());
A.enhActive = (e) => e.burst > 1 || e.nn || e.dnL > 0 || e.dnC > 0 || e.sharp > 0;
/** 轉成原生外掛參數 */
A.enhArgs = (e) => ({ nn: !!e.nn, nnMix: e.nnMix / 100, dnLuma: e.dnL, dnChroma: e.dnC, sharpen: e.sharp });
A.enhSame = (a, b) => JSON.stringify(A.cloneEnh(a)) === JSON.stringify(A.cloneEnh(b));

A.saveEnhProfile = (name, enh) => {
  const id = 'e' + Date.now().toString(36);
  A.settings.enhProfiles.push({ id, name, enh: A.cloneEnh(enh) });
  A.saveSettings();
  return id;
};

/**
 * 建立畫質提升面板。st = { on, id, enh }(會直接修改);
 * opts: { toggleLabel, showBurst, showNN, onChange() }
 */
A.buildEnhPanel = (container, st, opts) => {
  container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'look-ctrl enh-ctrl';
  container.appendChild(root);
  const changed = () => { A.saveSettings(); if (opts.onChange) opts.onChange(); };

  const sw = document.createElement('label');
  sw.className = 'switch';
  sw.innerHTML = '<input type="checkbox"><span></span>';
  sw.querySelector('span').textContent = opts.toggleLabel || '啟用畫質提升';
  const onBox = sw.querySelector('input');
  onBox.onchange = () => { st.on = onBox.checked; changed(); refresh(); };
  root.appendChild(sw);

  const chipsWrap = document.createElement('div');
  chipsWrap.innerHTML = '<div class="k-row" style="margin-bottom:6px">畫質設定檔</div>';
  const chips = document.createElement('div');
  chips.className = 'profile-list';
  chipsWrap.appendChild(chips);
  root.appendChild(chipsWrap);

  const body = document.createElement('div');
  body.className = 'look-ctrl';
  root.appendChild(body);

  const rows = {};
  const addSlider = (key, name, max, unit) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="n" style="width:78px">${name}</span><input type="range" min="0" max="${max}" step="1"><span class="v"></span>`;
    const inp = row.querySelector('input'), val = row.querySelector('.v');
    inp.oninput = () => { st.enh[key] = parseFloat(inp.value); val.textContent = Math.round(st.enh[key]) + (unit || ''); changed(); renderChips(); };
    body.appendChild(row);
    rows[key] = { inp, val, row, unit };
  };

  let burstSel = null, nnBox = null, nnRowEl = null;
  if (opts.showBurst !== false) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<span class="n" style="width:78px">多張合成</span><select class="txt" style="flex:1"><option value="1">關(單張)</option><option value="2">2 張</option><option value="3">3 張</option><option value="4">4 張</option><option value="6">6 張</option></select>';
    burstSel = row.querySelector('select');
    burstSel.onchange = () => { st.enh.burst = parseInt(burstSel.value, 10); changed(); renderChips(); };
    body.appendChild(row);
  }
  if (opts.showNN !== false) {
    const row = document.createElement('label');
    row.className = 'switch';
    row.innerHTML = '<input type="checkbox"><span>AI 放大 Real-ESRGAN(數位變焦/小圖,較慢)</span>';
    nnBox = row.querySelector('input');
    nnBox.onchange = () => { st.enh.nn = nnBox.checked; changed(); renderChips(); refresh(); };
    body.appendChild(row);
    nnRowEl = row;
    addSlider('nnMix', 'AI 強度', 100, '%');
  }
  addSlider('dnL', '亮度降噪', 100);
  addSlider('dnC', '色彩降噪', 100);
  addSlider('sharp', '銳利度', 100);

  const btns = document.createElement('div');
  btns.className = 'wb-row';
  const bNew = document.createElement('button');
  bNew.className = 'mini'; bNew.textContent = '存成新設定檔';
  const bUpd = document.createElement('button');
  bUpd.className = 'mini'; bUpd.textContent = '更新此設定檔';
  btns.appendChild(bNew); btns.appendChild(bUpd);
  root.appendChild(btns);
  bNew.onclick = () => {
    const name = prompt('畫質設定檔名稱');
    if (!name || !name.trim()) return;
    st.id = A.saveEnhProfile(name.trim(), st.enh);
    changed(); refresh();
    A.toast('已儲存畫質設定檔「' + name.trim() + '」');
  };
  bUpd.onclick = () => {
    const pr = (A.settings.enhProfiles || []).find((p) => p.id === st.id);
    if (!pr) { A.toast('內建設定檔不能覆寫,請用「存成新設定檔」'); return; }
    pr.enh = A.cloneEnh(st.enh);
    changed(); refresh();
    A.toast('已更新「' + pr.name + '」');
  };

  function renderChips() {
    chips.innerHTML = '';
    A.allEnhProfiles().forEach((p) => {
      const b = document.createElement('div');
      const cur = p.id === st.id;
      b.className = 'pchip' + (cur ? ' on' : '');
      b.textContent = p.name + (cur && !A.enhSame(p.enh, st.enh) ? '*' : '');
      b.onclick = () => { st.id = p.id; st.enh = A.cloneEnh(p.enh); changed(); refresh(); };
      if (!p.builtin) {
        const d = document.createElement('span');
        d.className = 'del'; d.textContent = '✕';
        d.onclick = (e) => {
          e.stopPropagation();
          if (!confirm('刪除畫質設定檔「' + p.name + '」?')) return;
          A.settings.enhProfiles = A.settings.enhProfiles.filter((x) => x.id !== p.id);
          if (st.id === p.id) st.id = 'std';
          ['enhCap', 'enhSet'].forEach((k) => { if (A.settings[k] && A.settings[k].id === p.id) A.settings[k].id = 'std'; });
          changed(); refresh();
        };
        b.appendChild(d);
      }
      chips.appendChild(b);
    });
  }

  function refresh() {
    onBox.checked = !!st.on;
    if (burstSel) burstSel.value = String(st.enh.burst);
    if (nnBox) { nnBox.checked = !!st.enh.nn; rows.nnMix.row.style.display = st.enh.nn ? 'flex' : 'none'; }
    ['nnMix', 'dnL', 'dnC', 'sharp'].forEach((k) => {
      const r = rows[k];
      if (!r) return;
      r.inp.value = st.enh[k];
      r.val.textContent = Math.round(st.enh[k]) + (r.unit || '');
    });
    body.style.opacity = st.on ? '1' : '0.5';
    renderChips();
  }
  refresh();
  return { refresh };
};

/* ------------------------------------------------------------------ 拍攝選單 */

A.enhChipLabel = () => {
  const s = A.settings.enhCap;
  if (!s || !s.on) return '畫質 關';
  const pr = A.findEnhProfile(s.id);
  return '畫質 ' + (pr ? pr.name : '自訂') + (pr && !A.enhSame(pr.enh, s.enh) ? '*' : '');
};
A.refreshEnhChip = () => {
  const b = $('btnEnh');
  if (!b) return;
  b.textContent = A.enhChipLabel();
  b.classList.toggle('on', !!(A.settings.enhCap && A.settings.enhCap.on));
};

A.initEnhUI = () => {
  const sheet = $('enhSheet');
  let panel = null;
  const open = () => {
    A.ensureEnhState();
    panel = A.buildEnhPanel($('enhBody'), A.settings.enhCap, {
      toggleLabel: '拍攝時啟用畫質提升', showBurst: true, showNN: true, onChange: A.refreshEnhChip,
    });
    A.openOverlay(sheet);
  };
  A.openEnhSheet = open;
  $('btnEnh').onclick = open;
  $('enClose').onclick = () => { A.closeOverlay(sheet); A.refreshEnhChip(); };
  sheet.addEventListener('click', (e) => { if (e.target === sheet) { A.closeOverlay(sheet); A.refreshEnhChip(); } });
  A.refreshEnhChip();
};

/* ------------------------------------------------------------------ 預覽用降噪(修圖頁) */

/** 與原生版相同概念的預覽實作:色彩低解析度模糊 + 亮度雙邊濾波。就地修改 RGBA data。 */
A.denoiseRGBA = (data, w, h, luma, chroma) => {
  const n = w * h;
  if (chroma > 0) {
    const cw = Math.ceil(w / 4), ch = Math.ceil(h / 4);
    let cb = new Float32Array(cw * ch), cr = new Float32Array(cw * ch);
    const cnt = new Float32Array(cw * ch);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4, k = (y >> 2) * cw + (x >> 2);
      const r = data[j], g = data[j + 1], b = data[j + 2];
      cb[k] += -0.168736 * r - 0.331264 * g + 0.5 * b;
      cr[k] += 0.5 * r - 0.418688 * g - 0.081312 * b;
      cnt[k]++;
    }
    for (let i = 0; i < cb.length; i++) { cb[i] /= cnt[i]; cr[i] /= cnt[i]; }
    const rad = 1 + Math.round(chroma / 100 * 5);
    const blur = (src) => {
      let t = new Float32Array(src.length), d = new Float32Array(src.length);
      for (let pass = 0; pass < 2; pass++) {
        for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
          let s = 0, c = 0;
          for (let k = Math.max(0, x - rad); k <= Math.min(cw - 1, x + rad); k++) { s += src[y * cw + k]; c++; }
          t[y * cw + x] = s / c;
        }
        for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
          let s = 0, c = 0;
          for (let k = Math.max(0, y - rad); k <= Math.min(ch - 1, y + rad); k++) { s += t[k * cw + x]; c++; }
          d[y * cw + x] = s / c;
        }
        src = d; d = new Float32Array(src.length);
      }
      return src;
    };
    cb = blur(cb); cr = blur(cr);
    const a = Math.min(1, chroma / 100);
    for (let y = 0; y < h; y++) {
      const fy = A.clamp((y + 0.5) / 4 - 0.5, 0, ch - 1), y0 = fy | 0, y1 = Math.min(ch - 1, y0 + 1), wy = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = A.clamp((x + 0.5) / 4 - 0.5, 0, cw - 1), x0 = fx | 0, x1 = Math.min(cw - 1, x0 + 1), wx = fx - x0;
        const s = (arr) => (arr[y0 * cw + x0] * (1 - wx) + arr[y0 * cw + x1] * wx) * (1 - wy) + (arr[y1 * cw + x0] * (1 - wx) + arr[y1 * cw + x1] * wx) * wy;
        const j = (y * w + x) * 4;
        const r = data[j], g = data[j + 1], b = data[j + 2];
        const yy = 0.299 * r + 0.587 * g + 0.114 * b;
        const ocb = -0.168736 * r - 0.331264 * g + 0.5 * b, ocr = 0.5 * r - 0.418688 * g - 0.081312 * b;
        const ncb = ocb + (s(cb) - ocb) * a, ncr = ocr + (s(cr) - ocr) * a;
        data[j] = A.clamp(Math.round(yy + 1.402 * ncr), 0, 255);
        data[j + 1] = A.clamp(Math.round(yy - 0.344136 * ncb - 0.714136 * ncr), 0, 255);
        data[j + 2] = A.clamp(Math.round(yy + 1.772 * ncb), 0, 255);
      }
    }
  }
  if (luma > 0) {
    const yb0 = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) yb0[i] = Math.round(0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]);
    const R = n >= 6e6 ? 3 : 2, sigS = R === 3 ? 2.0 : 1.4, passes = luma > 55 ? 2 : 1;
    const sw = [];
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) sw.push(Math.exp(-(dx * dx + dy * dy) / (2 * sigS * sigS)));
    let cur = yb0;
    for (let pass = 0; pass < passes; pass++) {
      const sigR = (5 + luma / 100 * 55) * (pass === 0 ? 1 : 0.7);
      const lut = new Float32Array(256);
      for (let d = 0; d < 256; d++) lut[d] = Math.exp(-(d * d) / (2 * sigR * sigR));
      const dst = new Uint8Array(n);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, c0 = cur[i];
        let sum = 0, ws = 0, q = 0;
        for (let dy = -R; dy <= R; dy++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          for (let dx = -R; dx <= R; dx++, q++) {
            const xx = Math.min(w - 1, Math.max(0, x + dx)), v = cur[yy * w + xx];
            const wt = sw[q] * lut[Math.abs(v - c0)];
            sum += wt * v; ws += wt;
          }
        }
        dst[i] = Math.round(sum / ws);
      }
      cur = dst;
    }
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const d = cur[i] - yb0[i];
      data[j] = A.clamp(data[j] + d, 0, 255);
      data[j + 1] = A.clamp(data[j + 1] + d, 0, 255);
      data[j + 2] = A.clamp(data[j + 2] + d, 0, 255);
    }
  }
};
})();
