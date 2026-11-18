// 周遊ルートの自動生成（企画書 機能1「緑・水辺ルート検索」＋機能2「所要時間の指定」）と、ターン案内の生成。
import { bearing, angleDiff, distPointSeg } from './geo.js';
import { CROSS_MARKED, CROSS_UNMARKED, CROSS_LEVELS } from './graph.js';

export const SPEEDS = { slow: 60, normal: 80, fast: 100 }; // m/分（80m/分 = 4.8km/h）
const SCENIC_K = 3;      // 景観の乏しい道に掛ける割増（コスト = 長さ × (1 + K × (1 - 景観スコア)) × 道種係数）
const REUSE_MULT = 4;    // すでに通った道を再度通るときの割増（往復を避ける）
const NEAR_MULT = 1.8;   // すでに通った道のすぐ近く(並行する歩道など)を通るときの割増
const NEAR_R = 30;
// 車道を横切るときの追加コスト（長さ換算）。横断歩道・信号のない所では横断させない
const CROSS_COST = { [CROSS_MARKED]: 15, [CROSS_UNMARKED]: Infinity };

// ---------------- 二分ヒープ ----------------
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, topV = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return topV;
  }
}

// ---------------- A* ----------------
// 状態は「どのスロット(向き付きエッジ)で着いたか」。道から道への乗り換え(=車道の横断)にコストを掛けるため。
// inSlot: 前の区間から src に着いた向き（src から見て来た道を逆にたどるスロット）。つなぎ目での横断も判定する
// level: 横断歩道を必ず使う車道の段階（CROSS_LEVELS）
function astar(g, src, dst, base, used, inSlot = -1, level = CROSS_LEVELS.residential) {
  if (src === dst) return { nodes: [src], edges: [] };
  const S = g.adjNode.length;
  const ws = g._ws || (g._ws = { dist: new Float64Array(S), prev: new Int32Array(S), closed: new Uint8Array(S) });
  const { dist, prev, closed } = ws;
  dist.fill(Infinity); closed.fill(0);
  const tx = g.nx[dst], ty = g.ny[dst], HMIN = 0.9;
  const h = u => Math.hypot(g.nx[u] - tx, g.ny[u] - ty) * HMIN;
  const cost = e => base[e] * (used && used[e] ? (used[e] === 1 ? REUSE_MULT : NEAR_MULT) : 1);
  const heap = new Heap();
  for (let k = g.adjStart[src]; k < g.adjStart[src + 1]; k++) {
    let c = cost(g.adjEdge[k]);
    if (inSlot >= 0) { const x = g.crossingAt(src, inSlot, k, level); if (x) c += CROSS_COST[x]; }
    if (c < dist[k]) { dist[k] = c; prev[k] = -1; heap.push(c + h(g.adjNode[k]), k); }
  }
  let goal = -1;
  while (heap.size) {
    const k = heap.pop();
    if (closed[k]) continue;
    closed[k] = 1;
    const v = g.adjNode[k];
    if (v === dst) { goal = k; break; }
    const back = g.adjRev[k];
    for (let q = g.adjStart[v]; q < g.adjStart[v + 1]; q++) {
      if (q === back || closed[q]) continue;     // その場で引き返さない
      let nd = dist[k] + cost(g.adjEdge[q]);
      const x = g.crossingAt(v, back, q, level);
      if (x) nd += CROSS_COST[x];
      if (nd === Infinity) continue;
      if (nd < dist[q]) { dist[q] = nd; prev[q] = k; heap.push(nd + h(g.adjNode[q]), q); }
    }
  }
  if (goal < 0) return null;
  const nodes = [], edges = [];
  for (let k = goal; k >= 0; k = prev[k]) { nodes.push(g.adjNode[k]); edges.push(g.adjEdge[k]); }
  nodes.push(src);
  return { nodes: nodes.reverse(), edges: edges.reverse() };
}

// ルート中で幹線車道を横切る回数（横断歩道あり / なし）
export function countCrossings(g, nodes, edges, level = CROSS_LEVELS.residential) {
  let marked = 0, unmarked = 0;
  const at = [];
  for (let i = 1; i < edges.length; i++) {
    const v = nodes[i], x = g.crossingAt(v, g.slotOf(v, edges[i - 1]), g.slotOf(v, edges[i]), level);
    if (x === CROSS_MARKED) marked++;
    else if (x === CROSS_UNMARKED) { unmarked++; at.push(i); }
  }
  return { marked, unmarked, at };
}

// 行き止まりの枝道に入って同じ道で戻る部分(A→B→A)を取り除く
function pruneSpurs(nodes, edges) {
  const sn = [nodes[0]], se = [];
  for (let i = 0; i < edges.length; i++) {
    if (se.length && se[se.length - 1] === edges[i]) { se.pop(); sn.pop(); }
    else { se.push(edges[i]); sn.push(nodes[i + 1]); }
  }
  return { nodes: sn, edges: se };
}

// 通った道を used=1、そのすぐ近くの道を used=2 として記録する
function markUsed(g, used, nodes, edges) {
  let lx = Infinity, ly = Infinity;
  for (const u of nodes) {
    if (Math.hypot(g.nx[u] - lx, g.ny[u] - ly) < 12) continue;   // 間引き
    lx = g.nx[u]; ly = g.ny[u];
    for (const v of g.nodesWithin(lx, ly, NEAR_R)) {
      for (let k = g.adjStart[v]; k < g.adjStart[v + 1]; k++) if (!used[g.adjEdge[k]]) used[g.adjEdge[k]] = 2;
    }
  }
  for (const e of edges) used[e] = 1;
}

// 短い寄り道(歩道を進んで並行する道で戻る等)を、出発点と戻り点を直接つなぐ道に置き換える
const EXC_MAX = 250, EXC_NEAR = 25;
function shortcutExcursions(g, nodes, edges, base, level) {
  let N = nodes.slice(), E = edges.slice();
  for (let guard = 0; guard < 50; guard++) {
    const cum = [0]; for (let i = 0; i < E.length; i++) cum.push(cum[i] + g.elen[E[i]]);
    let done = true;
    for (let i = 0; i < N.length - 1 && done; i++) {
      let bestJ = -1;
      for (let j = i + 2; j < N.length && cum[j] - cum[i] <= EXC_MAX; j++) {
        if (cum[j] - cum[i] < 4 * Math.hypot(g.nx[N[i]] - g.nx[N[j]], g.ny[N[i]] - g.ny[N[j]]) + 30) continue;
        if (Math.hypot(g.nx[N[i]] - g.nx[N[j]], g.ny[N[i]] - g.ny[N[j]]) <= EXC_NEAR) bestJ = j;
      }
      if (bestJ < 0) continue;
      const j = bestJ;
      if (i === 0 && j === N.length - 1) continue;   // 出発地に戻る周回そのものは潰さない
      let seg = { nodes: [N[i]], edges: [] };
      if (N[i] !== N[j]) { seg = astar(g, N[i], N[j], base, null, i > 0 ? g.slotOf(N[i], E[i - 1]) : -1, level); if (!seg) continue; }
      const segLen = seg.edges.reduce((a, e) => a + g.elen[e], 0);
      if (segLen >= (cum[j] - cum[i]) * 0.6) continue;
      N = N.slice(0, i).concat(seg.nodes, N.slice(j + 1));
      E = E.slice(0, i).concat(seg.edges, E.slice(j));
      done = false;
    }
    if (done) break;
  }
  return { nodes: N, edges: E };
}

// ---------------- ルート評価 ----------------
function evaluate(g, edges, nodes, L) {
  let len = 0, gLen = 0, wLen = 0, anyLen = 0, gSum = 0, wSum = 0, overlap = 0;
  const seen = new Set();
  for (const e of edges) {
    const l = g.elen[e]; len += l;
    gSum += l * g.eg[e]; wSum += l * g.ew[e];
    if (g.eg[e] >= 0.5) gLen += l;
    if (g.ew[e] >= 0.5) wLen += l;
    if (g.eg[e] >= 0.5 || g.ew[e] >= 0.5) anyLen += l;
    if (seen.has(e)) overlap += l; else seen.add(e);
  }
  const share = x => (len ? x / len : 0);
  const { near, compact } = shapeMetrics(g, nodes, edges);
  return {
    len, gShare: share(gLen), wShare: share(wLen), anyShare: share(anyLen),
    gMean: share(gSum), wMean: share(wSum), overlap: share(overlap), near, compact, edgeSet: seen, L,
  };
}

// 形の良さ: ① 行きと帰りが近接している区間の割合(細長い往復になっていないか) ② 囲む面積の大きさ(円=1)
const NEAR_DIST = 45, NEAR_ALONG = 150;
function shapeMetrics(g, nodes, edges) {
  const pts = [];                       // 15mごとのサンプル点 [x, y, along]
  let along = 0, carry = 0;
  for (let i = 0; i < edges.length; i++) {
    const a = nodes[i], b = nodes[i + 1], l = g.elen[edges[i]];
    for (let d = carry; d < l; d += 15) pts.push([g.nx[a] + (g.nx[b] - g.nx[a]) * d / l, g.ny[a] + (g.ny[b] - g.ny[a]) * d / l, along + d]);
    carry = ((carry - l) % 15 + 15) % 15 === 0 ? 0 : 15 - ((l - carry) % 15);
    along += l;
  }
  const grid = new Map(), key = (x, y) => Math.floor(x / NEAR_DIST) * 100003 + Math.floor(y / NEAR_DIST);
  for (const p of pts) { const k = key(p[0], p[1]); (grid.get(k) || grid.set(k, []).get(k)).push(p); }
  let flagged = 0;
  for (const p of pts) {
    const cx = Math.floor(p[0] / NEAR_DIST), cy = Math.floor(p[1] / NEAR_DIST);
    let hit = false;
    for (let ix = cx - 1; ix <= cx + 1 && !hit; ix++) for (let iy = cy - 1; iy <= cy + 1 && !hit; iy++) {
      const c = grid.get(ix * 100003 + iy); if (!c) continue;
      for (const q of c) if (Math.abs(q[2] - p[2]) > NEAR_ALONG && Math.hypot(q[0] - p[0], q[1] - p[1]) < NEAR_DIST) { hit = true; break; }
    }
    if (hit) flagged++;
  }
  let area = 0, perim = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; area += p[0] * q[1] - q[0] * p[1]; perim += Math.hypot(q[0] - p[0], q[1] - p[1]); }
  area = Math.abs(area) / 2;
  return { near: pts.length ? flagged / pts.length : 0, compact: perim ? (4 * Math.PI * area) / (perim * perim) : 0 };
}

function objective(pref, m, { turns, uturns }, L, cross) {
  const sat = pref === 'green' ? m.gShare : pref === 'water' ? m.wShare
    : 0.7 * m.anyShare + 0.3 * Math.min(1, 2 * Math.min(m.gShare, m.wShare));
  const lr = m.len / L;
  const lenPen = lr > 1.02 ? (lr - 1.02) * 3 : lr < 0.8 ? (0.8 - lr) * 1.5 : 0;
  const shapePen = m.near * 1.0 + Math.max(0, 0.3 - m.compact) * 1.5;   // 細長い往復型を避ける
  return sat - lenPen - m.overlap * 0.8 - shapePen - uturns * 0.12 - (turns / Math.max(m.len / 1000, 0.3)) * 0.01 - cross.unmarked * 0.1;
}

const jaccard = (a, b) => { let inter = 0; for (const x of a) if (b.has(x)) inter++; return inter / (a.size + b.size - inter || 1); };

// ---------------- 周遊ルート生成 ----------------
// crossing: 横断歩道を必ず使う道 'major'(幹線道路のみ) / 'residential'(住宅街の道まで) / 'all'(すべて)
export async function generateLoops(g, startNode, { pref = 'both', minutes = 30, speed = SPEEDS.normal, crossing = 'residential', onProgress } = {}) {
  const t0 = performance.now();
  const level = CROSS_LEVELS[crossing] ?? CROSS_LEVELS.residential;
  const L = minutes * speed;
  const s = g.scenic(pref);
  const base = new Float32Array(g.m);
  for (let e = 0; e < g.m; e++) base[e] = g.elen[e] * g.erf[e] * (1 + SCENIC_K * (1 - s[e]));

  // ノードごとの景観スコア
  const ns = new Float32Array(g.n);
  for (let u = 0; u < g.n; u++) {
    let sl = 0, sw = 0;
    for (let k = g.adjStart[u]; k < g.adjStart[u + 1]; k++) { const e = g.adjEdge[k]; sl += s[e] * g.elen[e]; sw += g.elen[e]; }
    ns[u] = sw ? sl / sw : 0;
  }
  const sx = g.nx[startNode], sy = g.ny[startNode], comp = g.comp[startNode];

  const nodesNear = (px, py, r) => {
    const out = [], c = Math.ceil(r / 100), cx = Math.floor(px / 100), cy = Math.floor(py / 100);
    for (let ix = cx - c; ix <= cx + c; ix++) for (let iy = cy - c; iy <= cy + c; iy++) {
      const a = g.nodeGrid.get((ix + 20000) * 65536 + (iy + 20000)); if (!a) continue;
      for (const i of a) if (g.comp[i] === comp) { const d = Math.hypot(g.nx[i] - px, g.ny[i] - py); if (d <= r) out.push([i, d]); }
    }
    return out;
  };
  const snap = (px, py) => {
    for (const r of [250, 500]) {
      const c = nodesNear(px, py, r);
      if (c.length) { let best = -1, bs = -Infinity; for (const [i, d] of c) { const sc = ns[i] - 0.5 * d / r; if (sc > bs) { bs = sc; best = i; } } return best; }
    }
    return -1;
  };

  // 景観の良い方角（扇形ごとに最良ノードの方位）を探索シードに加える
  const seeds = [];
  for (let i = 0; i < 12; i++) seeds.push(i * 30);
  const sector = new Map();
  for (let u = 0; u < g.n; u++) {
    if (g.comp[u] !== comp) continue;
    const d = Math.hypot(g.nx[u] - sx, g.ny[u] - sy);
    if (d < L * 0.12 || d > L * 0.4) continue;
    const b = bearing(sx, sy, g.nx[u], g.ny[u]), key = Math.floor(b / 60);
    const cur = sector.get(key);
    if (!cur || ns[u] > cur.sc) sector.set(key, { sc: ns[u], b });
  }
  for (const v of sector.values()) if (v.sc > 0.3) seeds.push(v.b);

  const shapes = [{ turn: 1, delta: 75 }, { turn: -1, delta: 75 }, { turn: 1, delta: 105 }, { turn: -1, delta: 105 }];
  const cands = [];
  let done = 0;
  const total = seeds.length * shapes.length;

  for (const th of seeds) {
    for (const sh of shapes) {
      done++;
      if (done % 4 === 0) { onProgress?.(done / total); await new Promise(r => setTimeout(r)); }
      let rho = L / 4.3, best = null;
      for (let iter = 0; iter < 4; iter++) {
        const pt = (ang, d) => [sx + Math.sin(ang * Math.PI / 180) * d, sy + Math.cos(ang * Math.PI / 180) * d];
        const A = snap(...pt(th, rho)), B = snap(...pt(th + sh.turn * sh.delta, rho));
        if (A < 0 || B < 0 || A === B || A === startNode || B === startNode) break;
        const used = new Uint8Array(g.m);
        let nodes = [startNode], edges = [];
        let ok = true;
        for (const [from, to] of [[startNode, A], [A, B], [B, startNode]]) {
          const r = astar(g, from, to, base, used, edges.length ? g.slotOf(from, edges[edges.length - 1]) : -1, level);
          if (!r) { ok = false; break; }
          markUsed(g, used, r.nodes, r.edges);
          nodes.push(...r.nodes.slice(1)); edges.push(...r.edges);
        }
        if (!ok) break;
        ({ nodes, edges } = pruneSpurs(nodes, edges));
        ({ nodes, edges } = shortcutExcursions(g, nodes, edges, base, level));
        ({ nodes, edges } = pruneSpurs(nodes, edges));
        let len = 0; for (const e of edges) len += g.elen[e];
        if (len < L * 0.2) break;                      // 潰れた経路は捨てる
        best = { nodes, edges, len };
        if (Math.abs(len / L - 1) < 0.07) break;
        rho *= Math.pow(L / len, 0.85);
      }
      if (best) cands.push(best);
    }
  }

  // 評価・選抜
  const scored = [];
  for (const c of cands) {
    const m = evaluate(g, c.edges, c.nodes, L);
    if (m.len > L * 1.08 || m.len < L * 0.6) continue;           // 指定時間に収まらない
    const tc = countTurns(g, c.nodes), cross = countCrossings(g, c.nodes, c.edges, level);
    if (cross.unmarked) continue;                                  // 横断歩道のない所で車道を渡るルートは出さない
    scored.push({ ...c, m, turns: tc.turns, crossings: cross, obj: objective(pref, m, tc, L, cross) });
  }
  scored.sort((a, b) => b.obj - a.obj);
  const picked = [];
  for (const c of scored) {
    if (picked.every(p => jaccard(p.m.edgeSet, c.m.edgeSet) < 0.55)) picked.push(c);
    if (picked.length === 3) break;
  }
  const routes = picked.map((c, i) => finalize(g, c, pref, speed, i));
  return {
    routes,
    diag: { candidates: cands.length, valid: scored.length, targetM: Math.round(L), ms: Math.round(performance.now() - t0) },
  };
}

function countTurns(g, nodes) {
  let t = 0, u = 0;
  for (let i = 1; i + 1 < nodes.length; i++) {
    const a = nodes[i - 1], b = nodes[i], c = nodes[i + 1];
    const d = Math.abs(angleDiff(bearing(g.nx[a], g.ny[a], g.nx[b], g.ny[b]), bearing(g.nx[b], g.ny[b], g.nx[c], g.ny[c])));
    if (d > 40) t++;
    if (d > 165) u++;       // 並行する歩道と車道を行き来するなど、実質Uターン
  }
  return { turns: t, uturns: u };
}

const rate = x => (x >= 0.6 ? '◎' : x >= 0.3 ? '○' : x >= 0.1 ? '△' : '－');

function finalize(g, c, pref, speed, rank) {
  const { m } = c;
  // 名前付きの緑地・水辺を、触れる距離順に集計
  const gn = new Map(), wn = new Map();
  for (const e of c.edges) {
    const l = g.elen[e];
    if (g.eg[e] >= 0.5 && g.egName[e] >= 0) gn.set(g.egName[e], (gn.get(g.egName[e]) || 0) + l);
    if (g.ew[e] >= 0.5 && g.ewName[e] >= 0) wn.set(g.ewName[e], (wn.get(g.ewName[e]) || 0) + l);
  }
  const top = (mp, n) => [...mp.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([i, l]) => ({ name: g.names[i], meters: Math.round(l) }));
  const greens = top(gn, 3), waters = top(wn, 3);
  const minutes = c.len / speed;
  const picks = pref === 'green' ? greens.slice(0, 2) : pref === 'water' ? waters.slice(0, 2) : [...waters.slice(0, 1), ...greens.slice(0, 1)];
  const title = picks.length ? `${picks.map(p => p.name).join('・')}を巡るコース` : (pref === 'water' ? '水辺に寄り道するコース' : pref === 'green' ? '緑の多いコース' : '緑と水辺を巡るコース');
  return {
    rank, pref, nodes: c.nodes, edges: c.edges, lengthM: c.len, minutes, title, greens, waters, turns: c.turns,
    crossings: { marked: c.crossings.marked, unmarked: c.crossings.unmarked },
    stats: { greenShare: m.gShare, waterShare: m.wShare, anyShare: m.anyShare, overlap: m.overlap, near: m.near, compact: m.compact, greenRate: rate(m.gShare), waterRate: rate(m.wShare) },
    obj: c.obj,
  };
}

// ---------------- 描画用: 緑/水辺/その他 で色分けした区間 ----------------
export function routeSegments(g, route) {
  const segs = [];
  let cur = null;
  route.edges.forEach((e, i) => {
    const type = g.ew[e] >= 0.5 && g.ew[e] >= g.eg[e] ? 'water' : g.eg[e] >= 0.5 ? 'green' : 'plain';
    const a = route.nodes[i], b = route.nodes[i + 1];
    const pa = [g.proj.lat(g.ny[a]), g.proj.lon(g.nx[a])], pb = [g.proj.lat(g.ny[b]), g.proj.lon(g.nx[b])];
    if (!cur || cur.type !== type) { cur = { type, pts: [pa] }; segs.push(cur); }
    cur.pts.push(pb);
  });
  return segs;
}

export function routeLatLngs(g, route) {
  return route.nodes.map(u => [g.proj.lat(g.ny[u]), g.proj.lon(g.nx[u])]);
}

// ---------------- ターン案内 ----------------
const HIGHWAY_JA = { footway: '歩道', path: '小道', pedestrian: '歩行者道', cycleway: '自転車道', steps: '階段', track: '農道', living_street: '生活道路' };

export function buildInstructions(g, route) {
  const nodes = route.nodes, n = nodes.length;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + g.elen[route.edges[i - 1]];
  const total = cum[n - 1];
  const WIN = 20;
  const dir = (i, back) => {
    let j = i;
    if (back) { while (j > 0 && cum[i] - cum[j] < WIN) j--; return j === i ? null : bearing(g.nx[nodes[j]], g.ny[nodes[j]], g.nx[nodes[i]], g.ny[nodes[i]]); }
    while (j < n - 1 && cum[j] - cum[i] < WIN) j++;
    return j === i ? null : bearing(g.nx[nodes[i]], g.ny[nodes[i]], g.nx[nodes[j]], g.ny[nodes[j]]);
  };
  const viaOf = e => {
    const t = g.roads[g.eway[e]].tags;
    return t.name || HIGHWAY_JA[t.highway] || '';
  };
  const sceneOf = e => (g.ew[e] >= 0.5 && g.ew[e] >= g.eg[e] ? (g.ewName[e] >= 0 ? g.names[g.ewName[e]] : '水辺') : g.eg[e] >= 0.5 ? (g.egName[e] >= 0 ? g.names[g.egName[e]] : '緑') : '');
  const sceneType = e => (g.ew[e] >= 0.5 && g.ew[e] >= g.eg[e] ? 'water' : g.eg[e] >= 0.5 ? 'green' : '');

  const raw = [];
  for (let i = 1; i < n - 1; i++) {
    const bi = dir(i, true), bo = dir(i, false);
    if (bi === null || bo === null) continue;
    const d = angleDiff(bi, bo), ad = Math.abs(d);
    const junction = g.adjStart[nodes[i] + 1] - g.adjStart[nodes[i]] >= 3;
    if (ad >= 35 && (junction || ad >= 60)) raw.push({ i, d, ad });
  }
  // 近接する曲がりは大きい方を採用
  const picked = [];
  for (const r of raw) {
    const last = picked[picked.length - 1];
    if (last && cum[r.i] - cum[last.i] < 25) { if (r.ad > last.ad) picked[picked.length - 1] = r; } else picked.push(r);
  }

  const turnText = d => {
    const ad = Math.abs(d), side = d > 0 ? '右' : '左';
    if (ad >= 170) return { turn: 'uturn', text: '引き返す' };
    if (ad >= 120) return { turn: d > 0 ? 'sharp-right' : 'sharp-left', text: `${side}へ急カーブ` };
    if (ad >= 65) return { turn: d > 0 ? 'right' : 'left', text: `${side}へ` };
    return { turn: d > 0 ? 'slight-right' : 'slight-left', text: `やや${side}へ` };
  };

  const steps = [];
  const mk = (i, extra) => ({ at: cum[i], node: nodes[i], lat: g.proj.lat(g.ny[nodes[i]]), lon: g.proj.lon(g.nx[nodes[i]]), ...extra });
  steps.push(mk(0, { turn: 'start', text: '出発', via: viaOf(route.edges[0]), scene: sceneOf(route.edges[0]), sceneType: sceneType(route.edges[0]) }));
  for (const p of picked) {
    const eNext = route.edges[p.i];
    const t = turnText(p.d);
    steps.push(mk(p.i, { ...t, via: viaOf(eNext), scene: sceneOf(eNext), sceneType: sceneType(eNext) }));
  }
  steps.push(mk(n - 1, { turn: 'goal', text: 'ゴール（出発地に戻ります）', via: '', scene: '', sceneType: '' }));
  steps.forEach((st, k) => { st.next = k + 1 < steps.length ? steps[k + 1].at - st.at : 0; });
  return { steps, total, cum };
}

// ---------------- 現在地をルート上に射影 ----------------
export function locateOnRoute(g, route, cum, x, y) {
  const nodes = route.nodes;
  let best = { off: Infinity, along: 0 };
  for (let i = 0; i + 1 < nodes.length; i++) {
    const a = nodes[i], b = nodes[i + 1];
    const ax = g.nx[a], ay = g.ny[a], bx = g.nx[b], by = g.ny[b];
    const d = distPointSeg(x, y, ax, ay, bx, by);
    if (d < best.off) {
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      best = { off: d, along: cum[i] + t * (cum[i + 1] - cum[i]), seg: i };
    }
  }
  return best;
}
