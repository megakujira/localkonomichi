// OpenStreetMap (Overpass API) からの取得と、分類済みフィーチャへの変換。
// ブラウザ(app.js)と Node(scripts/*.mjs) の両方から使えるよう、DOM には依存しない。

// 取得データの形式。クエリや保持するタグを変えたら上げる（古いキャッシュを使わないため）
// 2: 横断歩道・信号ノードと footway/crossing タグを追加
export const DATA_VERSION = 2;

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
];

const ROAD_RE = '^(footway|path|pedestrian|steps|cycleway|track|residential|living_street|unclassified|service|tertiary|tertiary_link|secondary|secondary_link|primary|primary_link)$';
const LEISURE_RE = '^(park|garden|nature_reserve|recreation_ground)$';
const LANDUSE_RE = '^(grass|forest|meadow|village_green|recreation_ground|orchard)$';
const NATURAL_RE = '^(wood|scrub|grassland|heath|wetland|water|coastline|bay|tree_row)$';
const WATERWAY_RE = '^(river|stream|canal|riverbank|tidal_channel)$';

export function buildQuery(lat, lon, radius, { trees = true } = {}) {
  const a = `(around:${Math.round(radius)},${lat.toFixed(6)},${lon.toFixed(6)})`;
  return `[out:json][timeout:120];
(
  way["highway"~"${ROAD_RE}"]["foot"!~"^no$"]["access"!~"^(private|no)$"]["service"!~"^(parking_aisle|driveway|drive-through|emergency_access)$"]${a};
  way["leisure"~"${LEISURE_RE}"]${a};
  relation["leisure"~"${LEISURE_RE}"]${a};
  way["landuse"~"${LANDUSE_RE}"]${a};
  relation["landuse"~"${LANDUSE_RE}"]${a};
  way["natural"~"${NATURAL_RE}"]${a};
  relation["natural"~"^(wood|water|wetland|grassland|scrub)$"]${a};
  way["waterway"~"${WATERWAY_RE}"]${a};
  relation["waterway"="riverbank"]${a};
);
out geom;${trees ? `
node["natural"="tree"]${a};
out skel qt;` : ''}
node["highway"~"^(crossing|traffic_signals)$"]${a};
out qt;`;
}

// ---- 取得（ミラーを時間差で並走させ、最初に成功したものを採用） ----
export async function fetchOverpass(query, { endpoints = OVERPASS_ENDPOINTS, stagger = 8000, timeout = 120000, onStatus = () => {}, signal } = {}) {
  const controllers = [];
  const attempt = async (url, i) => {
    if (i > 0) await sleep(i * stagger, signal);
    const ac = new AbortController();
    controllers.push(ac);
    const timer = setTimeout(() => ac.abort(), timeout);
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort);
    const host = new URL(url).host;
    onStatus(`${host} に問い合わせ中…`);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'User-Agent': 'konomichi-prototype/0.1 (feasibility study)' },
        body: new URLSearchParams({ data: query }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`${host}: HTTP ${res.status}`);
      const json = await res.json();
      if (!json.elements) throw new Error(`${host}: 不正なレスポンス`);
      if (json.remark && /error|timed out|out of memory/i.test(json.remark) && json.elements.length === 0) throw new Error(`${host}: ${json.remark}`);
      return { json, endpoint: url };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
  try {
    const result = await Promise.any(endpoints.map((u, i) => attempt(u, i)));
    return result;
  } catch (e) {
    const msgs = e.errors ? e.errors.map(x => x.message).join(' / ') : e.message;
    throw new Error(`Overpass API から取得できませんでした (${msgs})`);
  } finally {
    controllers.forEach(c => c.abort());
  }
}
function sleep(ms, signal) {
  return new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true });
  });
}

// ---- 保存用に不要なタグを落とす ----
const KEEP = ['highway', 'footway', 'crossing', 'crossing:markings', 'name', 'tunnel', 'covered', 'bridge', 'layer', 'leisure', 'landuse', 'natural', 'waterway', 'water', 'intermittent', 'service', 'surface', 'lit', 'foot'];
export function trimElements(elements) {
  return elements.map(el => {
    if (!el.tags) return el;
    const tags = {};
    for (const k of KEEP) if (el.tags[k] !== undefined) tags[k] = el.tags[k];
    const out = { ...el, tags };
    delete out.bounds;
    return out;
  });
}

// ---- 分類 ----
// 横断歩道として扱わないもの（標示のない横断箇所・横断禁止）
const NOT_CROSSWALK = new Set(['no', 'unmarked', 'informal']);
export function isCrosswalk(t) {
  if (NOT_CROSSWALK.has(t.crossing) || t['crossing:markings'] === 'no') return false;
  return t.highway === 'crossing' || t.highway === 'traffic_signals' || t.footway === 'crossing';
}

const NOT_WATER = new Set(['basin', 'wastewater', 'fountain', 'reflecting_pool', 'swimming_pool', 'lock']);
export function classify(t) {
  if (t.highway) return 'road';
  if (t.waterway) {
    if (t.waterway === 'riverbank') return 'water';
    if (t.tunnel && t.tunnel !== 'no') return null;
    if (t.covered === 'yes' || t.intermittent === 'yes') return null;
    return 'water';
  }
  if (t.natural === 'water') return NOT_WATER.has(t.water) ? null : 'water';
  if (t.natural === 'coastline' || t.natural === 'bay') return 'water';
  if (t.natural === 'tree_row') return 'treeline';
  if (t.natural) return 'green'; // wood, scrub, grassland, heath, wetland
  if (t.leisure || t.landuse) return 'green';
  return null;
}

const isClosed = g => g.length > 3 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;

// 相対(multipolygon)のメンバー線分を端点でつなげてリングにする
function assembleRings(lines) {
  const key = p => `${p.lat},${p.lon}`;
  const rings = [], open = [];
  const pool = lines.filter(l => l.length >= 2).map(l => l.slice());
  while (pool.length) {
    let cur = pool.pop();
    let guard = 0;
    while (!(cur.length > 3 && key(cur[0]) === key(cur[cur.length - 1])) && guard++ < 5000) {
      const end = key(cur[cur.length - 1]);
      let idx = pool.findIndex(l => key(l[0]) === end);
      if (idx >= 0) { cur = cur.concat(pool.splice(idx, 1)[0].slice(1)); continue; }
      idx = pool.findIndex(l => key(l[l.length - 1]) === end);
      if (idx >= 0) { cur = cur.concat(pool.splice(idx, 1)[0].reverse().slice(1)); continue; }
      break;
    }
    if (cur.length > 3 && key(cur[0]) === key(cur[cur.length - 1])) rings.push(cur); else open.push(cur);
  }
  return { rings, open };
}

/**
 * Overpass の elements を分類する。
 * 戻り値:
 *  roads : {id, nodes[], pts[{lat,lon}], tags}
 *  greens/waters : {name, rings[[{lat,lon}]], lines[[{lat,lon}]]}   (rings=面, lines=線)
 *  treeLines : {lines}
 *  trees : [{lat,lon}]
 *  crossings : [{lat,lon}]   横断歩道・信号のある地点
 */
export function parseElements(elements) {
  const roads = [], greens = [], waters = [], treeLines = [], trees = [], crossings = [];
  for (const el of elements) {
    if (el.type === 'node') {
      if (!el.tags?.highway) trees.push({ lat: el.lat, lon: el.lon });   // 街路樹は out skel（タグなし）
      else if (isCrosswalk(el.tags)) crossings.push({ lat: el.lat, lon: el.lon });
      continue;
    }
    const tags = el.tags || {};
    const kind = classify(tags);
    if (!kind) continue;
    if (el.type === 'way') {
      const g = el.geometry;
      if (!g || g.length < 2) continue;
      if (kind === 'road') { roads.push({ id: el.id, nodes: el.nodes, pts: g, tags }); continue; }
      if (kind === 'treeline') { treeLines.push({ lines: [g] }); continue; }
      const target = kind === 'green' ? greens : waters;
      const area = isClosed(g) && tags.natural !== 'coastline' && !(tags.waterway && tags.waterway !== 'riverbank');
      target.push({ name: tags.name || '', rings: area ? [g] : [], lines: area ? [] : [g] });
    } else if (el.type === 'relation') {
      if (kind !== 'green' && kind !== 'water') continue;
      const lines = (el.members || []).filter(m => m.type === 'way' && m.geometry).map(m => m.geometry);
      if (!lines.length) continue;
      const { rings, open } = assembleRings(lines);
      (kind === 'green' ? greens : waters).push({ name: tags.name || '', rings, lines: open });
    }
  }
  return { roads, greens, waters, treeLines, trees, crossings };
}
