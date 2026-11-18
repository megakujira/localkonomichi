// 歩行者ネットワークのグラフ化と、道ごとの「緑・水辺に近い度合い」の算出。
// 企画書の「道ごとに緑・水辺に近い割合を数えられる」を実装している中核部分。
import { Projector, distPointSeg, pointInRings, falloff } from './geo.js';
import { isCrosswalk } from './osm.js';

const CELL = 50;                 // 空間インデックスのセル(m)
const MAX_QUERY = 45;            // セル±1で漏れなく拾える最大探索半径(m)
const SAMPLE_STEP = 10;          // 道を何mごとにサンプリングして判定するか
const OFF = 20000;
const ck = (cx, cy) => (cx + OFF) * 65536 + (cy + OFF);

// 緑・水辺の判定パラメータ（m）: [満点になる距離, 0点になる距離]
export const PARAMS = {
  greenEdge: [8, 35],   // 公園などの縁からの距離
  treeLine: [6, 20],    // 並木
  waterEdge: [15, 45],  // 水際からの距離
  treeRadius: 18,       // 街路樹を数える半径
  treeFull: 3,          // この本数で満点
  treeWeight: 0.7,      // 街路樹だけの緑の上限
};

class FeatureIndex {
  constructor(proj, parsed) {
    this.feats = [];          // {cat:0緑|1水, name, rings:[Float64Array], bbox}
    this.segGrid = new Map(); // cell -> [segIdx]
    this.polyGrid = new Map();// cell -> [featIdx]
    this.treeGrid = new Map();// cell -> [x,y,x,y...]
    this.segs = [];           // Float64Array用に後で変換
    this.segFeat = [];
    this.segCat = [];         // 0緑 1水 2並木
    const sx1 = [], sy1 = [], sx2 = [], sy2 = [];
    const addSeg = (x1, y1, x2, y2, fi, cat) => {
      const si = sx1.length;
      sx1.push(x1); sy1.push(y1); sx2.push(x2); sy2.push(y2);
      this.segFeat.push(fi); this.segCat.push(cat);
      const len = Math.hypot(x2 - x1, y2 - y1);
      const n = Math.max(1, Math.ceil(len / (SAMPLE_STEP)));
      let last = -1;
      for (let i = 0; i <= n; i++) {
        const t = i / n, k = ck(Math.floor((x1 + (x2 - x1) * t) / CELL), Math.floor((y1 + (y2 - y1) * t) / CELL));
        if (k === last) continue;
        last = k;
        let a = this.segGrid.get(k); if (!a) this.segGrid.set(k, a = []);
        if (a[a.length - 1] !== si) a.push(si);
      }
    };
    const toXY = pts => { const a = new Float64Array(pts.length * 2); pts.forEach((p, i) => { a[2 * i] = proj.x(p.lon); a[2 * i + 1] = proj.y(p.lat); }); return a; };
    const addLines = (xy, fi, cat) => { for (let i = 0; i + 1 < xy.length / 2; i++) addSeg(xy[2 * i], xy[2 * i + 1], xy[2 * i + 2], xy[2 * i + 3], fi, cat); };

    for (const [cat, list] of [[0, parsed.greens], [1, parsed.waters]]) {
      for (const f of list) {
        const rings = f.rings.map(toXY), lines = f.lines.map(toXY);
        const fi = this.feats.length;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const r of rings.concat(lines)) for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]); }
        if (!isFinite(x0)) continue;
        this.feats.push({ cat, name: f.name, rings, bbox: [x0, y0, x1, y1] });
        for (const r of rings) addLines(r, fi, cat);
        for (const l of lines) addLines(l, fi, cat);
        if (rings.length) {
          for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
            for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
              const k = ck(cx, cy); let a = this.polyGrid.get(k); if (!a) this.polyGrid.set(k, a = []); a.push(fi);
            }
        }
      }
    }
    for (const t of parsed.treeLines) for (const l of t.lines) addLines(toXY(l), -1, 2);
    for (const t of parsed.trees) {
      const x = proj.x(t.lon), y = proj.y(t.lat), k = ck(Math.floor(x / CELL), Math.floor(y / CELL));
      let a = this.treeGrid.get(k); if (!a) this.treeGrid.set(k, a = []); a.push(x, y);
    }
    this.sx1 = Float64Array.from(sx1); this.sy1 = Float64Array.from(sy1);
    this.sx2 = Float64Array.from(sx2); this.sy2 = Float64Array.from(sy2);
    this.segFeat = Int32Array.from(this.segFeat); this.segCat = Uint8Array.from(this.segCat);
    this.counts = { green: parsed.greens.length, water: parsed.waters.length, treeLines: parsed.treeLines.length, trees: parsed.trees.length, segments: sx1.length };
  }

  // (x,y) 地点の緑度 g, 水辺度 w (0..1) と、最寄りの名前付き地物
  score(x, y, out) {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    let dG = Infinity, dW = Infinity, dT = Infinity, fG = -1, fW = -1;
    for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iy = cy - 1; iy <= cy + 1; iy++) {
      const segs = this.segGrid.get(ck(ix, iy));
      if (!segs) continue;
      for (let j = 0; j < segs.length; j++) {
        const s = segs[j], d = distPointSeg(x, y, this.sx1[s], this.sy1[s], this.sx2[s], this.sy2[s]);
        const c = this.segCat[s];
        if (c === 0) { if (d < dG) { dG = d; fG = this.segFeat[s]; } }
        else if (c === 1) { if (d < dW) { dW = d; fW = this.segFeat[s]; } }
        else if (d < dT) dT = d;
      }
    }
    let nTree = 0;
    for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iy = cy - 1; iy <= cy + 1; iy++) {
      const ts = this.treeGrid.get(ck(ix, iy));
      if (!ts) continue;
      for (let j = 0; j < ts.length; j += 2) if (Math.hypot(ts[j] - x, ts[j + 1] - y) <= PARAMS.treeRadius) nTree++;
    }
    // 面の内側か
    let inG = -1, inW = -1;
    const polys = this.polyGrid.get(ck(cx, cy));
    if (polys) for (const fi of polys) {
      const f = this.feats[fi], b = f.bbox;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if (pointInRings(x, y, f.rings)) { if (f.cat === 0) inG = fi; else inW = fi; }
    }
    let g = 0, w = 0;
    if (inG >= 0) { g = 1; fG = inG; }
    else if (dG <= MAX_QUERY) g = falloff(dG, ...PARAMS.greenEdge);
    g = Math.max(g, falloff(dT, ...PARAMS.treeLine) * PARAMS.treeWeight, Math.min(1, nTree / PARAMS.treeFull) * PARAMS.treeWeight);
    if (inW >= 0) { w = 1; fW = inW; }
    else if (dW <= MAX_QUERY) w = falloff(dW, ...PARAMS.waterEdge);
    out.g = g; out.w = w;
    out.gf = g > 0.3 ? fG : -1; out.wf = w > 0.3 ? fW : -1;
    return out;
  }
}

// 横断の判定: この種類の車道を横切るときは横断歩道・信号を通す（通れない所では横断させない）
// service(敷地内通路・路地) / living_street(歩行者優先道路) / track は車道として扱わない
const MAJOR_ROADS = new Set(['residential', 'unclassified', 'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link']);
const CROSSWALK_SNAP = 20;   // 横断歩道・信号ノードからこの距離(m)以内の交差点は「横断歩道あり」とみなす
export const CROSS_NONE = 0, CROSS_MARKED = 1, CROSS_UNMARKED = 2;

// 道の種類ごとの歩きやすさ係数（大きいほど避ける）
function roadFactor(tags) {
  switch (tags.highway) {
    case 'pedestrian': case 'footway': case 'path': case 'cycleway': case 'living_street': return 0.9;
    case 'steps': return 2.5;
    case 'track': return 1.1;
    case 'residential': case 'unclassified': case 'service': return 1.0;
    case 'tertiary': case 'tertiary_link': return 1.15;
    case 'secondary': case 'secondary_link': return 1.5;
    case 'primary': case 'primary_link': return 2.0;
    default: return 1.2;
  }
}

export class Graph {
  constructor(parsed, center) {
    const t0 = performance.now();
    const proj = this.proj = new Projector(center.lat, center.lon);
    const fi = this.featureIndex = new FeatureIndex(proj, parsed);
    const t1 = performance.now();

    // --- ノードとエッジ ---
    const idToIdx = new Map(), nx = [], ny = [];
    const nodeOf = (id, p) => {
      let i = idToIdx.get(id);
      if (i === undefined) { i = nx.length; idToIdx.set(id, i); nx.push(proj.x(p.lon)); ny.push(proj.y(p.lat)); }
      return i;
    };
    const ea = [], eb = [], elen = [], erf = [], eway = [], eunder = [], emajor = [], ecross = [];
    parsed.roads.forEach((r, wi) => {
      const rf = roadFactor(r.tags);
      const major = MAJOR_ROADS.has(r.tags.highway) ? 1 : 0, cross = isCrosswalk(r.tags) ? 1 : 0;
      const under = (r.tags.tunnel && r.tags.tunnel !== 'no' && r.tags.tunnel !== 'building_passage') || r.tags.covered === 'yes' || (r.tags.layer && Number(r.tags.layer) < 0);
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const a = nodeOf(r.nodes[i], r.pts[i]), b = nodeOf(r.nodes[i + 1], r.pts[i + 1]);
        if (a === b) continue;
        const len = Math.hypot(nx[a] - nx[b], ny[a] - ny[b]);
        if (len < 0.5) continue;
        ea.push(a); eb.push(b); elen.push(len); erf.push(rf); eway.push(wi); eunder.push(under ? 1 : 0); emajor.push(major); ecross.push(cross);
      }
    });
    const N = nx.length, E = ea.length;
    this.n = N; this.m = E;
    this.nx = Float64Array.from(nx); this.ny = Float64Array.from(ny);
    this.ea = Int32Array.from(ea); this.eb = Int32Array.from(eb);
    this.elen = Float32Array.from(elen); this.erf = Float32Array.from(erf);
    this.eway = Int32Array.from(eway);
    this.emajor = Uint8Array.from(emajor);   // 車道（横断に横断歩道が必要な道）
    this.ecross = Uint8Array.from(ecross);   // footway=crossing（横断歩道そのものの線）
    this.roads = parsed.roads;

    // --- 隣接リスト(CSR) ---
    const deg = new Int32Array(N + 1);
    for (let e = 0; e < E; e++) { deg[ea[e] + 1]++; deg[eb[e] + 1]++; }
    for (let i = 0; i < N; i++) deg[i + 1] += deg[i];
    this.adjStart = deg;
    this.adjNode = new Int32Array(2 * E); this.adjEdge = new Int32Array(2 * E);
    const fill = deg.slice(0, N);
    for (let e = 0; e < E; e++) {
      let p = fill[ea[e]]++; this.adjNode[p] = eb[e]; this.adjEdge[p] = e;
      p = fill[eb[e]]++; this.adjNode[p] = ea[e]; this.adjEdge[p] = e;
    }
    // 各スロットの向き(ラジアン)と、同じエッジを逆向きにたどるスロット
    this.adjAng = new Float32Array(2 * E); this.adjRev = new Int32Array(2 * E);
    const firstSlot = new Int32Array(E).fill(-1);
    for (let u = 0; u < N; u++) for (let k = deg[u]; k < deg[u + 1]; k++) {
      const v = this.adjNode[k], e = this.adjEdge[k];
      this.adjAng[k] = Math.atan2(this.ny[v] - this.ny[u], this.nx[v] - this.nx[u]);
      if (firstSlot[e] < 0) firstSlot[e] = k; else { this.adjRev[k] = firstSlot[e]; this.adjRev[firstSlot[e]] = k; }
    }
    // 幹線車道が2本以上つながるノード（ここでだけ横断が起こりうる）と、横断歩道の有無
    this.majorDeg = new Uint8Array(N);
    for (let u = 0; u < N; u++) { let c = 0; for (let k = deg[u]; k < deg[u + 1]; k++) c += emajor[this.adjEdge[k]]; this.majorDeg[u] = Math.min(c, 255); }
    this.crosswalkNode = new Uint8Array(N);
    const cw = (parsed.crossings || []).map(c => [proj.x(c.lon), proj.y(c.lat)]);
    if (cw.length) {
      const cg = new Map(), cs = CROSSWALK_SNAP;
      for (const [x, y] of cw) { const k = ck(Math.floor(x / cs), Math.floor(y / cs)); let a = cg.get(k); if (!a) cg.set(k, a = []); a.push(x, y); }
      for (let u = 0; u < N; u++) {
        if (this.majorDeg[u] < 2) continue;
        const cx = Math.floor(this.nx[u] / cs), cy = Math.floor(this.ny[u] / cs);
        search: for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iy = cy - 1; iy <= cy + 1; iy++) {
          const a = cg.get(ck(ix, iy)); if (!a) continue;
          for (let j = 0; j < a.length; j += 2) if (Math.hypot(a[j] - this.nx[u], a[j + 1] - this.ny[u]) <= cs) { this.crosswalkNode[u] = 1; break search; }
        }
      }
    }

    // --- 連結成分 ---
    this.comp = new Int32Array(N).fill(-1);
    this.compSize = [];
    const stack = [];
    for (let s = 0; s < N; s++) {
      if (this.comp[s] >= 0) continue;
      const c = this.compSize.length; let size = 0;
      stack.push(s); this.comp[s] = c;
      while (stack.length) {
        const u = stack.pop(); size++;
        for (let k = this.adjStart[u]; k < this.adjStart[u + 1]; k++) { const v = this.adjNode[k]; if (this.comp[v] < 0) { this.comp[v] = c; stack.push(v); } }
      }
      this.compSize.push(size);
    }

    // --- ノード用グリッド ---
    this.nodeGrid = new Map();
    for (let i = 0; i < N; i++) {
      const k = ck(Math.floor(this.nx[i] / 100), Math.floor(this.ny[i] / 100));
      let a = this.nodeGrid.get(k); if (!a) this.nodeGrid.set(k, a = []); a.push(i);
    }
    const t2 = performance.now();

    // --- 道ごとの緑・水辺スコア ---
    this.eg = new Float32Array(E); this.ew = new Float32Array(E);
    this.egName = new Int32Array(E).fill(-1); this.ewName = new Int32Array(E).fill(-1);
    this.names = []; const nameId = new Map();
    const nid = fidx => {
      const nm = fidx >= 0 ? fi.feats[fidx].name : '';
      if (!nm) return -1;
      let i = nameId.get(nm); if (i === undefined) { i = this.names.length; this.names.push(nm); nameId.set(nm, i); }
      return i;
    };
    const tmp = { g: 0, w: 0, gf: -1, wf: -1 };
    for (let e = 0; e < E; e++) {
      if (eunder[e]) continue;
      const a = this.ea[e], b = this.eb[e], len = this.elen[e];
      const n = Math.max(1, Math.ceil(len / SAMPLE_STEP));
      let sg = 0, sw = 0; const cg = new Map(), cw = new Map();
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        fi.score(this.nx[a] + (this.nx[b] - this.nx[a]) * t, this.ny[a] + (this.ny[b] - this.ny[a]) * t, tmp);
        sg += tmp.g; sw += tmp.w;
        if (tmp.gf >= 0) cg.set(tmp.gf, (cg.get(tmp.gf) || 0) + 1);
        if (tmp.wf >= 0) cw.set(tmp.wf, (cw.get(tmp.wf) || 0) + 1);
      }
      this.eg[e] = sg / n; this.ew[e] = sw / n;
      const top = m => { let best = -1, bc = 0; for (const [k, c] of m) if (c > bc) { bc = c; best = k; } return best; };
      if (cg.size) this.egName[e] = nid(top(cg));
      if (cw.size) this.ewName[e] = nid(top(cw));
    }
    const t3 = performance.now();

    // --- 診断情報（実現性の評価用） ---
    let total = 0, gLen = 0, wLen = 0, anyLen = 0;
    for (let e = 0; e < E; e++) {
      const l = this.elen[e]; total += l;
      if (this.eg[e] >= 0.5) gLen += l;
      if (this.ew[e] >= 0.5) wLen += l;
      if (this.eg[e] >= 0.5 || this.ew[e] >= 0.5) anyLen += l;
    }
    this.stats = {
      nodes: N, edges: E, networkKm: total / 1000,
      greenShare: total ? gLen / total : 0, waterShare: total ? wLen / total : 0, anyShare: total ? anyLen / total : 0,
      features: fi.counts, crossings: (parsed.crossings || []).length,
      ms: { index: Math.round(t1 - t0), graph: Math.round(t2 - t1), score: Math.round(t3 - t2), total: Math.round(t3 - t0) },
    };
  }

  // 最寄りの（十分大きな連結成分に属する）ノード
  nearestNode(x, y, minComp = 100) {
    let best = -1, bd = Infinity;
    const cx = Math.floor(x / 100), cy = Math.floor(y / 100);
    for (let r = 0; r <= 12 && best < 0; r++) {
      for (let ix = cx - r; ix <= cx + r; ix++) for (let iy = cy - r; iy <= cy + r; iy++) {
        if (r > 0 && Math.abs(ix - cx) !== r && Math.abs(iy - cy) !== r) continue;
        const a = this.nodeGrid.get(ck(ix, iy)); if (!a) continue;
        for (const i of a) {
          if (this.compSize[this.comp[i]] < minComp) continue;
          const d = Math.hypot(this.nx[i] - x, this.ny[i] - y);
          if (d < bd) { bd = d; best = i; }
        }
      }
    }
    return best < 0 ? null : { node: best, dist: bd };
  }

  // 半径 r(m) 以内のノード（細かいグリッドで高速に探す）
  nodesWithin(x, y, r) {
    if (!this.fineGrid) {
      this.fineGrid = new Map();
      for (let i = 0; i < this.n; i++) {
        const k = ck(Math.floor(this.nx[i] / 25), Math.floor(this.ny[i] / 25));
        let a = this.fineGrid.get(k); if (!a) this.fineGrid.set(k, a = []); a.push(i);
      }
    }
    const out = [], c = Math.ceil(r / 25), cx = Math.floor(x / 25), cy = Math.floor(y / 25);
    for (let ix = cx - c; ix <= cx + c; ix++) for (let iy = cy - c; iy <= cy + c; iy++) {
      const a = this.fineGrid.get(ck(ix, iy)); if (!a) continue;
      for (const i of a) if (Math.hypot(this.nx[i] - x, this.ny[i] - y) <= r) out.push(i);
    }
    return out;
  }

  /**
   * ノード v で、スロット kIn の方向から来て kOut の方向へ出るとき、幹線車道を横切るか。
   * kIn/kOut はどちらも v から見たスロット（kIn は来た道を逆にたどる向き）。
   * 来た道・出る道以外の幹線車道が左右の両側にあれば、その車道を横切っている。
   * 車道の上を歩いて(=その道の歩道を歩いて)脇道へ入るだけなら横断とはみなさない。
   */
  crossingAt(v, kIn, kOut) {
    if (this.majorDeg[v] < 2 || kIn === kOut) return CROSS_NONE;
    const TAU = 2 * Math.PI, a0 = this.adjAng[kIn];
    const span = ((this.adjAng[kOut] - a0) % TAU + TAU) % TAU;
    let left = 0, right = 0;
    for (let k = this.adjStart[v]; k < this.adjStart[v + 1]; k++) {
      if (k === kIn || k === kOut || !this.emajor[this.adjEdge[k]]) continue;
      const r = ((this.adjAng[k] - a0) % TAU + TAU) % TAU;
      if (r > 0 && r < span) left++; else if (r > span) right++;
    }
    if (!left || !right) return CROSS_NONE;
    return this.crosswalkNode[v] || this.ecross[this.adjEdge[kIn]] || this.ecross[this.adjEdge[kOut]] ? CROSS_MARKED : CROSS_UNMARKED;
  }

  // ノード v で、エッジ e の反対端から来る（または e で出ていく）向きのスロット
  slotOf(v, e) {
    for (let k = this.adjStart[v]; k < this.adjStart[v + 1]; k++) if (this.adjEdge[k] === e) return k;
    return -1;
  }

  // 好みごとの「景観スコア」(0..1)。両方=どちらか高い方
  scenic(pref) {
    const s = new Float32Array(this.m);
    for (let e = 0; e < this.m; e++) s[e] = pref === 'green' ? this.eg[e] : pref === 'water' ? this.ew[e] : Math.max(this.eg[e], this.ew[e]);
    return s;
  }
}
