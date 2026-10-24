/* 色彩控制 UI:可重複使用的 Look 控制項、色彩面板、色彩檔案選單 */
(() => {
'use strict';
const A = window.A;
const $ = A.$;

const WB_PRESETS = [
  { id: 'auto', name: '自動' },
  { id: 'k5500', name: '日光', k: 5500 },
  { id: 'k6500', name: '陰天', k: 6500 },
  { id: 'k7500', name: '陰影', k: 7500 },
  { id: 'k4200', name: '日光燈', k: 4200 },
  { id: 'k3000', name: '鎢絲燈', k: 3000 },
  { id: 'kcustom', name: '自訂 K' },
  { id: 'gray', name: '灰點' },
];
A.WB_PRESETS = WB_PRESETS;

const SLIDERS = [
  { key: 'ev', name: 'EV', min: -3, max: 3, step: 0.1, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(1) },
  { key: 'contrast', name: '對比', min: -100, max: 100, step: 1 },
  { key: 'highlights', name: '亮部細節', min: -100, max: 100, step: 1 },
  { key: 'shadows', name: '陰影', min: -100, max: 100, step: 1 },
  { key: 'saturation', name: '飽和度', min: -100, max: 100, step: 1 },
  { key: 'tint', name: '色調', min: -100, max: 100, step: 1 },
  { key: 'temperature', name: '色溫', min: -100, max: 100, step: 1 },
  { key: 'detail', name: '細節增強', min: 0, max: 100, step: 1 },
];

/** 灰點取樣 → 白平衡增益(在線性空間讓取樣色變成中性) */
A.grayGains = (r, g, b) => {
  const lin = (v) => {
    const c = A.clamp(v, 1, 254) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const lr = lin(r), lg = lin(g), lb = lin(b);
  return [+(lg / lr).toFixed(4), 1, +(lg / lb).toFixed(4)];
};

function wbActiveId(look) {
  if (look.wbMode === 'auto') return 'auto';
  if (look.wbMode === 'custom') return 'gray';
  const p = WB_PRESETS.find((w) => w.k === look.kelvin);
  return p ? p.id : 'kcustom';
}
A.wbLabel = (look) => {
  if (look.wbMode === 'auto') return 'AUTO';
  if (look.wbMode === 'custom') return '灰點';
  return look.kelvin + 'K';
};

/**
 * 在 container 內建立 Look 控制項。
 * opts: { get(): Look, set(look), pickGray(cb): 啟動灰點取樣 }
 * 回傳 { refresh() }
 */
A.buildLookControls = (container, opts) => {
  container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'look-ctrl';
  container.appendChild(root);

  // 白平衡
  const wbBox = document.createElement('div');
  wbBox.innerHTML = '<div class="k-row" style="margin-bottom:8px">白平衡</div>';
  const wbRow = document.createElement('div');
  wbRow.className = 'wb-row';
  wbBox.appendChild(wbRow);
  const kRow = document.createElement('div');
  kRow.className = 'k-row';
  kRow.style.marginTop = '10px';
  kRow.innerHTML = '<span class="n" style="width:54px">色溫 K</span><input type="range" min="2000" max="10000" step="100"><span class="v" style="width:54px;text-align:right;font:12px var(--mono);color:var(--text)"></span>';
  wbBox.appendChild(kRow);
  root.appendChild(wbBox);
  const kInput = kRow.querySelector('input');
  const kVal = kRow.querySelector('.v');

  const wbBtns = {};
  WB_PRESETS.forEach((w) => {
    const b = document.createElement('button');
    b.className = 'mini';
    b.textContent = w.name;
    b.onclick = () => {
      const l = opts.get();
      if (w.id === 'auto') { l.wbMode = 'auto'; }
      else if (w.id === 'gray') {
        opts.pickGray((gains) => {
          const n = opts.get();
          n.wbMode = 'custom'; n.gains = gains;
          opts.set(n); refresh();
        });
        return;
      } else if (w.id === 'kcustom') { l.wbMode = 'kelvin'; }
      else { l.wbMode = 'kelvin'; l.kelvin = w.k; }
      opts.set(l); refresh();
    };
    wbRow.appendChild(b);
    wbBtns[w.id] = b;
  });
  kInput.oninput = () => {
    const l = opts.get();
    l.wbMode = 'kelvin'; l.kelvin = parseInt(kInput.value, 10);
    opts.set(l); refresh();
  };

  // 滑桿
  const rows = {};
  SLIDERS.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'row dbl';
    row.innerHTML = `<span class="n" title="點兩下重設">${s.name}</span><input type="range" min="${s.min}" max="${s.max}" step="${s.step}"><span class="v"></span>`;
    const inp = row.querySelector('input'), val = row.querySelector('.v'), nm = row.querySelector('.n');
    const fmt = s.fmt || ((v) => String(Math.round(v)));
    inp.oninput = () => {
      const l = opts.get();
      l[s.key] = parseFloat(inp.value);
      val.textContent = fmt(l[s.key]);
      opts.set(l);
    };
    let last = 0;
    nm.onclick = () => {
      const now = Date.now();
      if (now - last < 350) {
        const l = opts.get(); l[s.key] = 0; opts.set(l); refresh();
      }
      last = now;
    };
    root.appendChild(row);
    rows[s.key] = { inp, val, fmt };
  });

  function refresh() {
    const l = opts.get();
    const act = wbActiveId(l);
    Object.entries(wbBtns).forEach(([id, b]) => b.classList.toggle('on', id === act));
    kRow.style.display = l.wbMode === 'kelvin' ? 'flex' : 'none';
    kInput.value = l.kelvin;
    kVal.textContent = l.kelvin + 'K';
    if (l.wbMode === 'custom') {
      wbBtns.gray.innerHTML = '灰點 <span class="swatch" style="background:rgb(' +
        [255 * 0.5 * l.gains[0], 255 * 0.5, 255 * 0.5 * l.gains[2]].map((v) => Math.round(A.clamp(v, 0, 255))).join(',') + ')"></span>';
    } else {
      wbBtns.gray.textContent = '灰點';
    }
    SLIDERS.forEach((s) => {
      const r = rows[s.key];
      r.inp.value = l[s.key];
      r.val.textContent = r.fmt(l[s.key]);
    });
  }
  refresh();
  return { refresh };
};

/* ------------------------------------------------------------------ 相機的色彩面板 */

A.profileLabel = () => {
  const pr = A.findProfile(A.settings.profileId);
  const name = pr ? pr.name : '自訂';
  let mod = false;
  if (pr) {
    const a = JSON.stringify(A.cloneLook(pr.look)), b = JSON.stringify(A.cloneLook(A.settings.look));
    mod = a !== b;
  } else mod = true;
  return name + (mod && pr ? '*' : '');
};

A.initLookUI = () => {
  const sheet = $('colorSheet');
  let ctrl = null;
  const openColor = () => {
    if (!ctrl) {
      ctrl = A.buildLookControls($('csBody'), {
        get: () => A.currentLook(),
        set: (l) => A.setCurrentLook(l),
        pickGray: (cb) => {
          A.closeOverlay(sheet);
          A.toast('點擊取景畫面中應為中性灰/白的位置', 4000);
          A.S.pickGray = (g) => { A.S.pickGray = null; A.openOverlay(sheet); cb(g); };
        },
      });
    }
    ctrl.refresh();
    A.openOverlay(sheet);
  };
  A.openColorSheet = openColor;
  $('btnColor').onclick = openColor;
  $('csClose').onclick = () => A.closeOverlay(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) A.closeOverlay(sheet); });
  $('csReset').onclick = () => {
    const pr = A.findProfile(A.settings.profileId);
    A.setCurrentLook(A.cloneLook(pr ? pr.look : {}));
    if (ctrl) ctrl.refresh();
  };

  // 色彩檔案
  const ps = $('profileSheet');
  const renderProfiles = () => {
    const box = $('profileList');
    box.innerHTML = '';
    A.allProfiles().forEach((p) => {
      const b = document.createElement('div');
      b.className = 'pchip' + (p.id === A.settings.profileId ? ' on' : '');
      b.textContent = p.name;
      b.onclick = () => { A.applyProfile(p.id); renderProfiles(); };
      if (!p.builtin) {
        const d = document.createElement('span');
        d.className = 'del'; d.textContent = '✕';
        d.onclick = (e) => {
          e.stopPropagation();
          if (confirm('刪除色彩檔案「' + p.name + '」?')) { A.deleteCustomProfile(p.id); renderProfiles(); updateChips(); }
        };
        b.appendChild(d);
      }
      box.appendChild(b);
    });
  };
  A.renderProfiles = renderProfiles;
  const openProfiles = () => { renderProfiles(); A.openOverlay(ps); };
  A.openProfileSheet = openProfiles;
  $('btnProfile').onclick = openProfiles;
  $('psClose').onclick = () => A.closeOverlay(ps);
  ps.addEventListener('click', (e) => { if (e.target === ps) A.closeOverlay(ps); });
  $('btnSaveProfile').onclick = () => {
    const name = $('profileName').value.trim();
    if (!name) { A.toast('請輸入檔案名稱'); return; }
    const id = A.saveCustomProfile(name, A.currentLook());
    A.settings.profileId = id;
    A.saveSettings();
    $('profileName').value = '';
    renderProfiles(); updateChips();
    A.toast('已儲存色彩檔案「' + name + '」');
  };

  function updateChips() { $('btnProfile').textContent = A.profileLabel(); }
  A.updateProfileChip = updateChips;
  document.addEventListener('lookchange', updateChips);
  if (!A.settings.look) A.settings.look = A.neutralLook();
  updateChips();
};
})();
