/* 線條圖示(24×24,currentColor)。A.icon(name) 回傳 SVG 字串;A.setIcon(el, name, label) 設定按鈕圖示與無障礙標籤。 */
(() => {
  const A = window.A;
  const gear = (() => {
    // 8 齒齒輪外框
    const pts = [];
    const teeth = 8, ro = 10, ri = 7.6;
    for (let i = 0; i < teeth; i++) {
      const a0 = (i / teeth) * Math.PI * 2;
      const step = Math.PI * 2 / teeth;
      const seg = [[a0 - step * 0.18, ro], [a0 + step * 0.18, ro], [a0 + step * 0.32, ri], [a0 + step * 0.68, ri]];
      seg.forEach(([a, r]) => pts.push((12 + r * Math.cos(a)).toFixed(2) + ' ' + (12 + r * Math.sin(a)).toFixed(2)));
    }
    return '<path d="M' + pts.join(' L') + 'Z"/><circle cx="12" cy="12" r="3.2"/>';
  })();
  const P = {
    gear,
    flashOff: '<path d="M13.5 3 6 13h5.5l-1 8L18 11h-5.5l1-8z"/><path d="M4 4l16 16"/>',
    flash: '<path d="M13.5 3 6 13h5.5l-1 8L18 11h-5.5l1-8z"/>',
    torch: '<path d="M8 3h8v4l-2 3v11h-4V10L8 7z"/><path d="M8 7h8M12 13v2"/>',
    hdr: '<rect x="2.5" y="6" width="19" height="12" rx="3"/><text x="12" y="15" text-anchor="middle" font-size="7.4" font-weight="700" font-family="Roboto,Arial,sans-serif" fill="currentColor" stroke="none">HDR</text>',
    raw: '<rect x="2.5" y="6" width="19" height="12" rx="3"/><text x="12" y="15" text-anchor="middle" font-size="7.4" font-weight="700" font-family="Roboto,Arial,sans-serif" fill="currentColor" stroke="none">RAW</text>',
    sparkle: '<path d="M11 3.5l1.9 5.1 5.1 1.9-5.1 1.9L11 17.5l-1.9-5.1L4 10.5l5.1-1.9z"/><path d="M18 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
    grid: '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M9.2 3.5v17M14.8 3.5v17M3.5 9.2h17M3.5 14.8h17"/>',
    focus: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/>',
    face: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/><circle cx="12" cy="12" r="4.2"/><path d="M10.4 11.2h.01M13.6 11.2h.01M10.6 13.4c.8.7 2 .7 2.8 0"/>',
    track: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5"/>',
    palette: '<path d="M12 3.2a8.8 8.8 0 1 0 0 17.6c1 0 1.6-.7 1.6-1.5 0-.5-.3-.9-.3-1.4 0-.8.6-1.4 1.4-1.4h1.7a4.8 4.8 0 0 0 4.8-4.8c0-4.6-4.1-8.5-9.2-8.5z"/><circle cx="7.6" cy="11.4" r="1.1" fill="currentColor"/><circle cx="10.2" cy="7.4" r="1.1" fill="currentColor"/><circle cx="14.8" cy="7.6" r="1.1" fill="currentColor"/>',
    filter: '<circle cx="9" cy="9.5" r="5"/><circle cx="15" cy="9.5" r="5"/><circle cx="12" cy="14.8" r="5"/>',
    flip: '<path d="M4.5 11a7.5 7.5 0 0 1 13-4.6L19.5 8.5"/><path d="M19.5 4v4.5H15"/><path d="M19.5 13a7.5 7.5 0 0 1-13 4.6L4.5 15.5"/><path d="M4.5 20v-4.5H9"/>',
    lock: '<rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
    unlock: '<rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.2"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    prev: '<path d="M14.5 6l-6 6 6 6"/>',
    next: '<path d="M9.5 6l6 6-6 6"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    upscale: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M10.5 8v5M8 10.5h5"/>',
    chip: '<rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3"/><path d="M10 10h4v4h-4z"/>',
    wand: '<path d="M4 20L15 9"/><path d="M13 7l2-2 4 4-2 2z"/><path d="M6 4v3M4.5 5.5h3M18.5 15v3M17 16.5h3"/>',
    trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/><path d="M10.5 11v5.5M13.5 11v5.5"/>',
    geo: '<path d="M7 3v14h14"/><path d="M3 7h14v14"/>',
    eraser: '<path d="M8.5 19.5L3.8 14.8a1.5 1.5 0 0 1 0-2.1l8.5-8.5a1.5 1.5 0 0 1 2.1 0l5.7 5.7a1.5 1.5 0 0 1 0 2.1l-7.9 7.5z"/><path d="M9 9.5l6 6M8.5 19.5H20"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
    resize: '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><rect x="3.5" y="11" width="9.5" height="9.5" rx="1.5"/><path d="M13.5 10.5l4-4M14 6.5h3.5V10"/>',
    play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
  };
  A.icon = (name) => '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[name] || '') + '</svg>';
  A.setIcon = (el, name, label) => {
    if (!el) return;
    if (el.dataset.icon !== name) { el.innerHTML = A.icon(name); el.dataset.icon = name; }
    if (label != null) { el.setAttribute('aria-label', label); el.title = label; }
  };
  /** 圖示 + 文字(檢視器與編輯器的動作列用) */
  A.setIconLabel = (el, name, text) => {
    if (!el) return;
    el.innerHTML = A.icon(name) + '<small>' + text + '</small>';
    el.classList.add('ilb');
  };

  // 靜態圖示
  const $ = (id) => document.getElementById(id);
  const stat = { btnSettings: ['gear', '設定'], btnLight: ['flashOff', '閃光燈:關'], btnGrid: ['grid', '格線'], btnColor: ['palette', '色彩與白平衡'],
    btnProfile: ['filter', '色彩檔案'], btnFlip: ['flip', '切換前後鏡頭'], btnHdr: ['hdr', 'HDR'], btnEnh: ['sparkle', '畫質提升'], btnFocusAssist: ['focus', '對焦模式'],
    btnRaw: ['raw', 'RAW'],
    gBack: ['back', '返回'], vClose: ['back', '返回'], vPrev: ['prev', '較舊'], vNext: ['next', '較新'], eBack: ['back', '返回'], sClose: ['back', '返回'],
    enClose: ['close', '關閉'], csClose: ['close', '關閉'], psClose: ['close', '關閉'] };
  Object.keys(stat).forEach((id) => A.setIcon($(id), stat[id][0], stat[id][1]));
  A.setIconLabel($('vEdit'), 'edit', '編輯');
  A.setIconLabel($('vUpscale'), 'upscale', '1 億畫素');
  A.setIconLabel($('vNN'), 'chip', 'AI 放大');
  A.setIconLabel($('vGemini'), 'wand', 'AI 回推');
  A.setIconLabel($('vDelete'), 'trash', '刪除');
  const et = { quality: 'sparkle', geo: 'geo', color: 'palette', size: 'resize', erase: 'eraser', ai: 'wand' };
  document.querySelectorAll('#eTabs button').forEach((b) => {
    const sp = b.querySelector('span');
    if (sp && et[b.dataset.t]) sp.innerHTML = A.icon(et[b.dataset.t]);
  });
  const ev = document.querySelector('#readouts [data-p=ev] small');
  if (ev) ev.innerHTML = A.icon('sun') + 'EV';
})();
