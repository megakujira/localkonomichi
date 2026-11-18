// このみち — UI とアプリ全体の流れ
import { PRESETS, DATA_RADIUS } from './presets.js';
import { buildQuery, fetchOverpass, trimElements, parseElements, DATA_VERSION } from './osm.js';
import { Graph } from './graph.js';
import { generateLoops, buildInstructions, locateOnRoute, routeSegments, routeLatLngs, SPEEDS } from './router.js';
import { haversine } from './geo.js';

const $ = s => document.querySelector(s);
// 外部由来の文字列(OSMの名称など)を innerHTML に入れないための DOM ヘルパー
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}

const PREF = { green: { label: '緑', em: '🌳', sub: '公園・並木' }, water: { label: '水辺', em: '💧', sub: '川・池・海' }, both: { label: '両方', em: '🌳💧', sub: 'どちらも' } };
const SPEED_LABEL = { slow: 'ゆっくり', normal: 'ふつう', fast: '速め' };
const CROSS_OPT = { major: { label: '幹線道路のみ', sub: '大きな道' }, residential: { label: '住宅街の道まで', sub: 'おすすめ' }, all: { label: 'すべて', sub: '路地も含む' } };
const ARROW = { start: '🚶', goal: '🏁', right: '→', left: '←', 'slight-right': '↗', 'slight-left': '↖', 'sharp-right': '↘', 'sharp-left': '↙', uturn: '↩' };

const S = {
  start: { ...PRESETS[0], label: PRESETS[0].name },
  pref: 'both', minutes: 30, speed: 'normal',
  cross: 'residential', // 横断歩道を必ず使う道: major / residential / all
  area: null,           // {center, radius, parsed, graph, source}
  results: null, selected: 0,
  diag: {},
  guide: null,
};

// ---------------- 地図 ----------------
const map = L.map('map', { zoomControl: false }).setView([S.start.lat, S.start.lon], 15);
L.control.zoom({ position: 'topright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>' }).addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const featureLayer = L.layerGroup();
const canvas = L.canvas({ padding: 0.3 });
let startMarker = null, meMarker = null;

function setStart(lat, lon, label, { pan = true } = {}) {
  S.start = { lat, lon, label };
  if (!startMarker) {
    startMarker = L.marker([lat, lon], { draggable: true, keyboard: false, icon: L.divIcon({ className: '', html: '<div class="pin-start">S</div>', iconSize: [30, 30], iconAnchor: [15, 15] }) }).addTo(map);
    startMarker.on('dragend', () => { const p = startMarker.getLatLng(); setStart(p.lat, p.lng, '地図で指定した地点', { pan: false }); renderSetup(); });
  } else startMarker.setLatLng([lat, lon]);
  if (pan) map.setView([lat, lon], Math.max(map.getZoom(), 15));
}
map.on('click', e => { if (S.guide || S.busy) return; setStart(e.latlng.lat, e.latlng.lng, '地図で指定した地点', { pan: false }); clearResults(); renderSetup(); });

$('#chkLayers').addEventListener('change', drawFeatures);
function drawFeatures() {
  featureLayer.clearLayers();
  if (!$('#chkLayers').checked || !S.area) { map.removeLayer(featureLayer); return; }
  featureLayer.addTo(map);
  const { parsed } = S.area;
  const ll = pts => pts.map(p => [p.lat, p.lon]);
  const draw = (list, color) => {
    for (const f of list) {
      for (const r of f.rings) L.polygon(ll(r), { renderer: canvas, color, weight: 0.5, fillColor: color, fillOpacity: 0.3, interactive: false }).addTo(featureLayer);
      for (const l of f.lines) L.polyline(ll(l), { renderer: canvas, color, weight: 2, opacity: 0.7, interactive: false }).addTo(featureLayer);
    }
  };
  draw(parsed.greens, '#2f9e63'); draw(parsed.waters, '#2b7de0');
}

// ---------------- データ取得（同梱 → キャッシュ → Overpass） ----------------
const idb = {
  db: null,
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((res, rej) => { const r = indexedDB.open('konomichi', 1); r.onupgradeneeded = () => r.result.createObjectStore('areas', { keyPath: 'key' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return this.db;
  },
  async all() { try { const db = await this.open(); return await new Promise((res, rej) => { const r = db.transaction('areas').objectStore('areas').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); } catch { return []; } },
  async put(v) { try { const db = await this.open(); db.transaction('areas', 'readwrite').objectStore('areas').put(v); } catch { /* キャッシュできなくても動作に影響なし */ } },
};

const neededRadius = (minutes, speed) => Math.min(DATA_RADIUS, Math.max(700, minutes * speed * 0.3 + 300));
const covers = (c, r, lat, lon, need) => haversine(c.lat, c.lon, lat, lon) + need <= r;

async function loadData(lat, lon, need, status) {
  // 1) すでに読み込み済みのエリアで足りるか
  if (S.area && covers(S.area.center, S.area.radius, lat, lon, need)) return { area: S.area, reused: true };
  const t0 = performance.now();
  let record = null, source = '';
  // 2) 同梱データ
  const preset = PRESETS.find(p => covers({ lat: p.lat, lon: p.lon }, DATA_RADIUS, lat, lon, need));
  if (preset) {
    status('同梱の地図データを読み込み中…');
    try { const res = await fetch(`data/${preset.id}.json`); if (res.ok) { record = await res.json(); source = '同梱データ（事前取得したOSM）'; } } catch { /* 次へ */ }
  }
  // 3) ブラウザのキャッシュ
  if (!record) {
    const hit = (await idb.all()).find(a => a.v === DATA_VERSION && covers(a.center, a.radius, lat, lon, need));
    if (hit) { record = hit; source = 'ブラウザのキャッシュ（IndexedDB）'; }
  }
  // 4) Overpass API
  if (!record) {
    const radius = Math.max(need + 250, 900);
    status('OpenStreetMap から緑・水辺・道路を取得中…（公開サーバーは混み合うと30秒以上かかります）');
    const { json, endpoint } = await fetchOverpass(buildQuery(lat, lon, radius), { onStatus: status });
    record = { key: `${lat.toFixed(4)},${lon.toFixed(4)},${Math.round(radius)}`, v: DATA_VERSION, center: { lat, lon }, radius, fetchedAt: new Date().toISOString(), elements: trimElements(json.elements) };
    source = `Overpass API（${new URL(endpoint).host}）`;
    idb.put(record);
  }
  const t1 = performance.now();
  status('緑・水辺を道ごとに判定中…');
  await new Promise(r => setTimeout(r, 30));
  const parsed = parseElements(record.elements);
  const graph = new Graph(parsed, record.center);
  const t2 = performance.now();
  const area = { center: record.center, radius: record.radius, parsed, graph, source, fetchedAt: record.fetchedAt };
  S.diag.load = { source, fetchMs: Math.round(t1 - t0), buildMs: Math.round(t2 - t1), elements: record.elements.length };
  return { area, reused: false };
}

// ---------------- スマホ: パネルの開閉 ----------------
const isWide = () => window.matchMedia('(min-width: 900px)').matches;
function setSummary(text) {
  $('#sheetSummary').replaceChildren(el('span', { class: 't' }, text), el('span', { class: 'open', 'aria-hidden': 'true' }, '▲ 開く'));
}
function setSheet(min) {
  if (document.body.classList.contains('sheet-min') === min) return;
  document.body.classList.toggle('sheet-min', min);
  const h = $('#sheetHandle');
  h.setAttribute('aria-expanded', String(!min));
  h.setAttribute('aria-label', min ? 'パネルを開く' : 'パネルを縮めて地図を大きく表示');
  requestAnimationFrame(() => { map.invalidateSize(); if (S.results) fitRoute(); });
}
{
  const h = $('#sheetHandle');
  let y0 = null, moved = false;
  h.addEventListener('click', () => { if (moved) { moved = false; return; } setSheet(!document.body.classList.contains('sheet-min')); });
  h.addEventListener('pointerdown', e => { y0 = e.clientY; moved = false; });
  h.addEventListener('pointerup', e => {
    if (y0 == null) return;
    const dy = e.clientY - y0; y0 = null;
    if (Math.abs(dy) > 24) { moved = true; setSheet(dy > 0); }   // 下へスワイプで縮める / 上へで開く
  });
  h.addEventListener('pointercancel', () => { y0 = null; });
}

// ---------------- 画面: 設定 ----------------
const view = $('#view');
function clearResults() { S.results = null; S.routeBounds = null; routeLayer.clearLayers(); }

function seg(items, current, onPick, cls = '') {
  return el('div', { class: `seg c3 ${cls}`, role: 'group' }, items.map(([v, em, label, sub]) =>
    el('button', { type: 'button', 'data-v': v, 'aria-pressed': String(current === v), onclick: () => onPick(v) },
      em ? el('span', { class: 'em', 'aria-hidden': 'true' }, em) : null, el('span', {}, label), sub ? el('span', { class: 'sub' }, sub) : null)));
}

function renderSetup() {
  document.body.classList.remove('guiding');
  const results = el('ul', { class: 'results-list hidden', id: 'searchResults' });
  const input = el('input', { type: 'search', id: 'q', placeholder: '駅名・地名・施設名で出発地を探す', 'aria-label': '出発地を検索', autocomplete: 'off', enterkeyhint: 'search' });
  const doSearch = async () => {
    const q = input.value.trim(); if (!q) return;
    results.classList.remove('hidden'); results.replaceChildren(el('li', {}, el('button', { type: 'button', disabled: true }, '検索中…')));
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=ja&q=${encodeURIComponent(q)}`);
      const list = await r.json();
      results.replaceChildren(...(list.length ? list.map(x => el('li', {}, el('button', { type: 'button', onclick: () => { setStart(+x.lat, +x.lon, x.display_name.split(',').slice(0, 2).join(' ')); clearResults(); renderSetup(); } }, x.display_name))) : [el('li', {}, el('button', { type: 'button', disabled: true }, '見つかりませんでした'))]));
    } catch { results.replaceChildren(el('li', {}, el('button', { type: 'button', disabled: true }, '検索に失敗しました。ネットワークを確認してください'))); }
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

  const need = neededRadius(S.minutes, SPEEDS[S.speed]);
  const bundled = PRESETS.some(p => covers({ lat: p.lat, lon: p.lon }, DATA_RADIUS, S.start.lat, S.start.lon, need));
  const dataNote = bundled ? '同梱データで即時に検索できます' : S.area && covers(S.area.center, S.area.radius, S.start.lat, S.start.lon, need) ? '読み込み済みのデータを使います' : '初回は OpenStreetMap から取得します（30秒以上かかることがあります）';

  setSummary(`📍 ${S.start.label || '指定した地点'} ・ ${S.minutes}分 ・ ${PREF[S.pref].label}`);
  view.replaceChildren(
    el('div', { class: 'field' },
      el('span', { class: 'label' }, '出発地'),
      el('div', { class: 'start-box' }, el('span', { class: 'pin', 'aria-hidden': 'true' }, '📍'),
        el('div', { class: 'txt' }, S.start.label || '指定した地点', el('small', {}, dataNote)),
        el('button', { class: 'btn sm', type: 'button', onclick: useMyLocation }, '現在地')),
      el('div', { class: 'search' }, input, el('button', { class: 'btn sm', type: 'button', onclick: doSearch }, '検索')), results,
      el('div', { class: 'row', role: 'group', 'aria-label': 'デモ用の出発地' }, PRESETS.map(p =>
        el('button', { class: 'chip', type: 'button', 'aria-pressed': String(S.start.id === p.id), onclick: () => { setStart(p.lat, p.lon, p.name); S.start.id = p.id; clearResults(); renderSetup(); } }, p.name.split('（')[0].replace('・', ' '))))),
    el('div', { class: 'field' }, el('span', { class: 'label' }, '好きな景色'),
      seg(Object.entries(PREF).map(([v, p]) => [v, p.em, p.label, p.sub]), S.pref, v => { S.pref = v; renderSetup(); })),
    el('div', { class: 'field' }, el('span', { class: 'label' }, '使える時間（出発地に戻ってくるまで）'),
      seg([[15, '', '15分'], [30, '', '30分'], [60, '', '60分']].map(([v, e, l]) => [v, e, l]), [15, 30, 60].includes(S.minutes) ? S.minutes : null, v => { S.minutes = v; renderSetup(); }, 'small'),
      el('div', { class: 'range-row' }, el('input', { type: 'range', min: 10, max: 90, step: 5, value: S.minutes, 'aria-label': '使える時間（分）', oninput: e => { S.minutes = +e.target.value; $('#minOut').textContent = `あと ${S.minutes} 分`; }, onchange: renderSetup }), el('output', { id: 'minOut' }, `あと ${S.minutes} 分`))),
    el('div', { class: 'field' }, el('span', { class: 'label' }, '歩く速さ'),
      seg(Object.keys(SPEEDS).map(k => [k, '', SPEED_LABEL[k], `${(SPEEDS[k] * 60 / 1000).toFixed(1)}km/h`]), S.speed, v => { S.speed = v; renderSetup(); }, 'small')),
    el('div', { class: 'field' }, el('span', { class: 'label' }, '横断歩道を必ず使う道'),
      seg(Object.entries(CROSS_OPT).map(([v, o]) => [v, '', o.label, o.sub]), S.cross, v => { S.cross = v; renderSetup(); }, 'small'),
      S.cross === 'all' ? el('p', { class: 'hint' }, '路地では横断歩道が地図データに載っていないことが多く、遠回りになったりルートが見つからなかったりします') : null),
    el('button', { class: 'btn primary', type: 'button', id: 'go', onclick: search }, 'ルートを探す'));
}

function toast(msg, ms = 3500) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), ms); }

function useMyLocation() {
  if (!navigator.geolocation) return toast('この端末では現在地を取得できません');
  toast('現在地を取得中…', 8000);
  navigator.geolocation.getCurrentPosition(p => { setStart(p.coords.latitude, p.coords.longitude, '現在地'); clearResults(); renderSetup(); toast('現在地を出発地にしました'); },
    () => toast('現在地を取得できませんでした。位置情報の許可を確認するか、地図をタップして出発地を指定してください', 6000), { enableHighAccuracy: true, timeout: 10000 });
}

// ---------------- 検索 ----------------
function renderLoading(msg, progress = null) {
  setSummary(`⏳ ${msg}${progress != null ? ` ${Math.round(progress * 100)}%` : ''}`);
  view.replaceChildren(el('div', { class: 'loading' }, el('div', { class: 'spinner', 'aria-hidden': 'true' }), el('div', { class: 'msg' }, msg),
    progress != null ? el('div', { class: 'bar' }, el('i', { style: `width:${Math.round(progress * 100)}%` })) : null,
    el('div', { class: 'sub' }, '地図データ © OpenStreetMap contributors')));
}

async function search() {
  if (S.busy) return;
  S.busy = true; clearResults();
  const speed = SPEEDS[S.speed];
  try {
    renderLoading('地図データを準備中…');
    const need = neededRadius(S.minutes, speed);
    const { area, reused } = await loadData(S.start.lat, S.start.lon, need, m => renderLoading(m));
    S.area = area; drawFeatures();
    const g = area.graph;
    const snap = g.nearestNode(g.proj.x(S.start.lon), g.proj.y(S.start.lat));
    if (!snap || snap.dist > 300) throw new Error('出発地の近くに歩ける道が見つかりませんでした。別の場所を指定してください。');
    renderLoading('ルートを組み立て中…', 0);
    const { routes, diag } = await generateLoops(g, snap.node, { pref: S.pref, minutes: S.minutes, speed, crossing: S.cross, onProgress: p => renderLoading('ルートを組み立て中…', p) });
    S.diag.route = diag; S.diag.reused = reused; S.diag.snap = Math.round(snap.dist);
    S.results = { routes, startNode: snap.node, speed };
    S.selected = 0;
    renderResults();
  } catch (e) {
    console.error(e);
    view.replaceChildren(el('div', { class: 'notice' }, el('b', {}, 'ルートを作れませんでした'), e.message), el('button', { class: 'btn primary', type: 'button', onclick: renderSetup }, '条件を変える'));
  } finally { S.busy = false; }
}

// ---------------- 画面: 結果 ----------------
const pct = x => `${Math.round(x * 100)}%`;
function meter(label, cls, share, rate) {
  return el('div', { class: 'meter' }, el('span', {}, label), el('span', { class: 'track' }, el('span', { class: `fill ${cls}`, style: `width:${Math.round(share * 100)}%` })), el('span', { class: 'val' }, `${pct(share)} ${rate}`));
}

function renderResults() {
  const { routes, speed } = S.results;
  const g = S.area.graph;
  const children = [];
  const best = routes[0];
  const cur = routes[S.selected];
  setSummary(cur ? `${S.selected === 0 ? '★ ' : ''}${cur.title} ・ 約${Math.round(cur.minutes)}分` : '条件に合うルートが見つかりませんでした');
  const sat = best ? (S.pref === 'green' ? best.stats.greenShare : S.pref === 'water' ? best.stats.waterShare : best.stats.anyShare) : 0;
  if (!best) {
    children.push(el('div', { class: 'notice' }, el('b', {}, '条件に合うルートが見つかりませんでした'), '時間を長くするか、出発地を変えてみてください。',
      S.cross !== 'major' ? el('div', { class: 'row' }, el('button', { class: 'chip', type: 'button', onclick: () => { S.cross = S.cross === 'all' ? 'residential' : 'major'; search(); } }, `横断歩道の条件を「${CROSS_OPT[S.cross === 'all' ? 'residential' : 'major'].label}」にゆるめて探す`)) : null));
  } else if (sat < 0.15) {
    const alt = S.pref === 'water' ? 'green' : S.pref === 'green' ? 'water' : null;
    children.push(el('div', { class: 'notice' }, el('b', {}, `この周辺では${PREF[S.pref].label}に触れる道がほとんどありません`),
      `${PREF[S.pref].label}に触れる区間は全体の${pct(sat)}です。`, alt ? el('div', { class: 'row' }, el('button', { class: 'chip', type: 'button', onclick: () => { S.pref = alt; search(); } }, `${PREF[alt].label}で探し直す`)) : null));
  } else if (sat < 0.4) {
    children.push(el('div', { class: 'notice' }, el('b', {}, `${PREF[S.pref].label}はやや少なめのエリアです`), `時間を長くすると、より多く触れるルートが見つかることがあります。`));
  }
  routes.forEach((r, i) => {
    children.push(el('button', { class: 'card', type: 'button', 'aria-pressed': String(S.selected === i), onclick: () => { S.selected = i; renderResults(); } },
      el('h3', {}, `${i === 0 ? '★ ' : ''}${r.title}`),
      el('div', { class: 'meta' }, `約${Math.round(r.minutes)}分 ・ ${(r.lengthM / 1000).toFixed(1)}km ・ 行き帰りが近い道 ${pct(Math.max(r.stats.near, r.stats.overlap))}`),
      meter('緑', 'g', r.stats.greenShare, r.stats.greenRate), meter('水辺', 'w', r.stats.waterShare, r.stats.waterRate),
      (r.waters.length || r.greens.length) ? el('div', { class: 'names' }, [r.waters.length ? `水辺: ${r.waters.map(x => x.name).join('・')}` : '', r.greens.length ? `緑: ${r.greens.map(x => x.name).join('・')}` : ''].filter(Boolean).join(' ／ ')) : null));
  });
  if (best) children.push(el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => { clearResults(); renderSetup(); } }, '条件を変える'), el('button', { class: 'btn primary', type: 'button', onclick: startGuide }, 'このルートで歩く')));
  else children.push(el('button', { class: 'btn primary', type: 'button', onclick: () => { clearResults(); renderSetup(); } }, '条件を変える'));
  view.replaceChildren(...children);
  drawRoutes();
}

function drawRoutes() {
  routeLayer.clearLayers();
  const { routes, startNode } = S.results;
  const g = S.area.graph;
  const COLORS = { green: '#2f9e63', water: '#2b7de0', plain: '#7b8794' };
  let bounds = null;
  routes.forEach((r, i) => {
    if (i === S.selected) return;
    const line = L.polyline(routeLatLngs(g, r), { color: '#6b7a73', weight: 4, opacity: 0.5, dashArray: '2 8', lineCap: 'round' }).addTo(routeLayer);
    line.on('click', () => { S.selected = i; renderResults(); });
  });
  const r = routes[S.selected];
  if (!r) return;
  const segs = routeSegments(g, r);
  for (const s of segs) L.polyline(s.pts, { color: '#fff', weight: 10, opacity: 0.95, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(routeLayer);
  for (const s of segs) {
    const pl = L.polyline(s.pts, { color: COLORS[s.type], weight: 6, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(routeLayer);
    bounds = bounds ? bounds.extend(pl.getBounds()) : pl.getBounds();
  }
  S.routeBounds = bounds;
  fitRoute();
}

// 選択中のルート全体が、パネルに隠れずに見えるように地図を合わせる
function fitRoute() {
  const bounds = S.routeBounds; if (!bounds || S.guide) return;
  const panelH = $('#panel').offsetHeight;
  map.fitBounds(bounds, isWide() ? { paddingTopLeft: [430, 30], paddingBottomRight: [30, 30] } : { paddingTopLeft: [20, 20], paddingBottomRight: [20, Math.min(panelH, window.innerHeight * 0.68) + 20] });
}

// ---------------- 案内 ----------------
function startGuide() {
  const route = S.results.routes[S.selected], g = S.area.graph;
  const ins = buildInstructions(g, route);
  S.guide = { route, ...ins, along: 0, off: 0, offCount: 0, sim: null, follow: true, watch: null, finished: false, lastFix: null, speed: S.results.speed };
  document.body.classList.add('guiding');
  $('#panel').classList.add('hidden'); $('#guideTop').classList.remove('hidden'); $('#guideBottom').classList.remove('hidden');
  // 曲がり角マーカー
  for (const st of S.guide.steps.slice(1, -1)) L.marker([st.lat, st.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: '', html: '<div class="pin-turn"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }) }).addTo(routeLayer);
  meMarker = L.marker([ins.steps[0].lat, ins.steps[0].lon], { interactive: false, keyboard: false, zIndexOffset: 1000, icon: L.divIcon({ className: '', html: '<div class="pin-me"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(map);
  map.setView([ins.steps[0].lat, ins.steps[0].lon], 18);
  setFollow(true);
  if (navigator.geolocation) S.guide.watch = navigator.geolocation.watchPosition(onFix, () => toast('位置情報を取得できません。「デモ歩行」で操作を試せます', 5000), { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  renderGuide();
}

function onFix(p) {
  const G = S.guide; if (!G || G.sim) return;
  const g = S.area.graph, x = g.proj.x(p.coords.longitude), y = g.proj.y(p.coords.latitude);
  const loc = locateOnRoute(g, G.route, G.cum, x, y);
  G.lastFix = { lat: p.coords.latitude, lon: p.coords.longitude };
  meMarker.setLatLng([p.coords.latitude, p.coords.longitude]);
  G.offCount = loc.off > 60 ? G.offCount + 1 : 0;
  G.off = loc.off;
  if (G.offCount === 0) G.along = Math.max(G.along, loc.along);
  renderGuide(); if (G.follow) map.panTo([p.coords.latitude, p.coords.longitude], { animate: true });
}

// 地図を指で動かしたら自動追従を止め、「現在地に戻る」で再開する
function setFollow(on) {
  const G = S.guide; if (!G) return;
  G.follow = on;
  $('#btnRecenter').classList.toggle('hidden', on);
  if (on && meMarker) map.panTo(meMarker.getLatLng(), { animate: true });
}
map.on('dragstart', () => { if (S.guide && S.guide.follow) setFollow(false); });
$('#btnRecenter').addEventListener('click', () => setFollow(true));

function pointAt(G, along) {
  const g = S.area.graph, nodes = G.route.nodes, cum = G.cum;
  let i = 0; while (i + 2 < nodes.length && cum[i + 1] < along) i++;
  const t = Math.max(0, Math.min(1, (along - cum[i]) / ((cum[i + 1] - cum[i]) || 1)));
  const a = nodes[i], b = nodes[i + 1];
  return [g.proj.lat(g.ny[a] + (g.ny[b] - g.ny[a]) * t), g.proj.lon(g.nx[a] + (g.nx[b] - g.nx[a]) * t)];
}

function toggleSim() {
  const G = S.guide;
  if (G.sim) { clearInterval(G.sim); G.sim = null; renderGuide(); return; }
  G.offCount = 0; G.off = 0;
  G.sim = setInterval(() => {
    G.along = Math.min(G.total, G.along + 9);           // 実速度の約30倍
    const ll = pointAt(G, G.along); meMarker.setLatLng(ll); if (G.follow) map.panTo(ll, { animate: false });
    renderGuide();
    if (G.along >= G.total) { clearInterval(G.sim); G.sim = null; }
  }, 250);
  renderGuide();
}

const roundDist = d => (d < 100 ? Math.max(5, Math.round(d / 5) * 5) : Math.round(d / 10) * 10);

function renderGuide() {
  const G = S.guide; if (!G) return;
  const steps = G.steps;
  const done = G.along >= G.total - 15;
  let idx = steps.findIndex((s, i) => i > 0 && s.at > G.along + 3);
  if (idx < 0) idx = steps.length - 1;
  const st = steps[idx], dist = Math.max(0, st.at - G.along);
  const remain = Math.max(0, G.total - G.along), min = Math.ceil(remain / G.speed);
  const top = $('#guideTop');
  top.classList.toggle('off', G.offCount >= 3);
  if (done) {
    top.replaceChildren(el('div', { class: 'arrow', 'aria-hidden': 'true' }, '🏁'), el('div', {}, el('div', { class: 'big' }, 'おつかれさまでした！'), el('div', { class: 'via' }, `${(G.total / 1000).toFixed(1)}km を歩きました`)));
  } else if (G.offCount >= 3) {
    top.replaceChildren(el('div', { class: 'arrow', 'aria-hidden': 'true' }, '⚠'), el('div', {}, el('div', { class: 'big' }, 'ルートから外れています'), el('div', { class: 'via' }, `約${Math.round(G.off)}m 離れています`)));
  } else {
    const first = idx === 1 && G.along < 10 && steps[0].via;
    const walk = steps[idx - 1]?.walk, sj = walk && (walk.side === 'right' ? '右' : '左');
    const why = walk && (walk.why === 'turn' ? `次の角で${sj}へ曲がるため` : walk.why === 'scene' ? `${steps[idx - 1].scene || '景色'}のある側` : '歩道がなければ右側通行');
    top.replaceChildren(el('div', { class: 'arrow', 'aria-hidden': 'true' }, ARROW[st.turn] || '↑'),
      el('div', {}, el('div', { class: 'dist' }, `${roundDist(dist)}m`), el('div', { class: 'big' }, st.turn === 'goal' ? 'ゴール（出発地）' : `次の角を${st.text}`),
        el('div', { class: 'via' }, [first ? `出発: ${steps[0].via}を進む` : '', st.via ? `${st.via}を進む` : '', st.scene ? `${st.sceneType === 'water' ? '💧' : '🌳'} ${st.scene}沿い` : ''].filter(Boolean).join(' ・ ')),
        walk ? el('div', { class: 'side' }, el('b', {}, `🚶 道の${sj}側を歩く`), el('small', {}, why)) : null));
  }
  const bottom = $('#guideBottom');
  bottom.replaceChildren(
    el('div', { class: 'stats' }, el('b', {}, done ? '到着' : `残り ${min}分`), el('span', {}, `${(remain / 1000).toFixed(2)}km`), el('span', { class: 'fine' }, G.lastFix ? 'GPS測位中' : (G.sim ? 'デモ歩行中' : 'GPS待機中')),
      el('button', { class: 'fold', type: 'button', 'aria-expanded': String(!G.compact), 'aria-label': G.compact ? '操作ボタンを表示' : '小さくして地図を広く表示', onclick: () => { G.compact = !G.compact; document.body.classList.toggle('guide-compact', G.compact); renderGuide(); } }, G.compact ? '▲' : '▼')),
    el('div', { class: 'bar' }, el('i', { style: `width:${Math.round(G.along / G.total * 100)}%` })),
    el('div', { class: 'btns' },
      G.offCount >= 3 ? el('button', { class: 'btn primary', type: 'button', onclick: replan }, 'ここから引き直す') : el('button', { class: 'btn', type: 'button', onclick: toggleSim }, G.sim ? '一時停止' : 'デモ歩行 ×30'),
      el('button', { class: 'btn danger', type: 'button', onclick: endGuide }, done ? '閉じる' : '終了')));
}

function replan() {
  const G = S.guide, remainMin = Math.max(10, Math.round((G.total - G.along) / G.speed));
  const here = G.lastFix; endGuide();
  if (here) { setStart(here.lat, here.lon, '現在地'); S.minutes = remainMin; search(); }
}

function endGuide() {
  const G = S.guide; if (!G) return;
  if (G.watch != null) navigator.geolocation.clearWatch(G.watch);
  if (G.sim) clearInterval(G.sim);
  if (meMarker) { map.removeLayer(meMarker); meMarker = null; }
  S.guide = null;
  $('#guideTop').classList.add('hidden'); $('#guideBottom').classList.add('hidden'); $('#btnRecenter').classList.add('hidden'); $('#panel').classList.remove('hidden');
  document.body.classList.remove('guiding', 'guide-compact');
  if (S.results) { renderResults(); } else renderSetup();
}

// ---------------- 計測値 ----------------
$('#btnDiag').addEventListener('click', () => {
  const rows = [], add = (k, v) => rows.push(el('tr', {}, el('th', {}, k), el('td', {}, v)));
  const a = S.area;
  if (!a) add('状態', 'まだルート検索を実行していません');
  else {
    const st = a.graph.stats, d = S.diag;
    add('データの取得元', a.source);
    add('取得/読込にかかった時間', d.load && !d.reused ? `${(d.load.fetchMs / 1000).toFixed(1)}秒` : '（読み込み済みを再利用）');
    add('OSM要素数', d.load ? `${d.load.elements.toLocaleString()}件` : '-');
    add('歩行者ネットワーク', `ノード${st.nodes.toLocaleString()} / エッジ${st.edges.toLocaleString()} / 計${st.networkKm.toFixed(0)}km`);
    add('緑地・水域・街路樹', `緑地${st.features.green} / 水域${st.features.water} / 街路樹${st.features.trees}本`);
    add('緑に触れる道（全道路比）', pct(st.greenShare));
    add('水辺に触れる道（全道路比）', pct(st.waterShare));
    add('グラフ構築+緑水辺判定', `${st.ms.total}ms`);
    if (d.route) { add('ルート候補', `${d.route.valid}/${d.route.candidates}件が条件を満たした`); add('ルート生成時間', `${d.route.ms}ms`); add('目標距離', `${d.route.targetM}m`); }
  }
  $('#diagBody').replaceChildren(el('table', {}, ...rows));
  $('#diag').showModal();
});

// ---------------- 起動 ----------------
setStart(S.start.lat, S.start.lon, S.start.label); S.start.id = PRESETS[0].id;
renderSetup();
window.__konomichi = S; // 検証用
