// 地理計算ユーティリティ。全ての距離計算は「出発地中心のローカル平面(m)」で行う。
export const R_EARTH = 6371008.8;
const DEG = Math.PI / 180;

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG, dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

// 簡易正距円筒投影（数km圏なら誤差は無視できる）
export class Projector {
  constructor(lat0, lon0) {
    this.lat0 = lat0; this.lon0 = lon0;
    this.kx = Math.cos(lat0 * DEG) * R_EARTH * DEG;
    this.ky = R_EARTH * DEG;
  }
  x(lon) { return (lon - this.lon0) * this.kx; }
  y(lat) { return (lat - this.lat0) * this.ky; }
  lon(x) { return this.lon0 + x / this.kx; }
  lat(y) { return this.lat0 + y / this.ky; }
}

// 点(px,py)から線分(ax,ay)-(bx,by)までの距離
export function distPointSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// 方位角(度, 北=0 時計回り) ローカル平面上
export function bearing(x1, y1, x2, y2) {
  return (Math.atan2(x2 - x1, y2 - y1) / DEG + 360) % 360;
}

// 角度差を -180..180 に正規化（正=右折）
export function angleDiff(a, b) {
  let d = ((b - a + 540) % 360) - 180;
  return d;
}

// 偶奇規則による内外判定。rings = [Float64Array(x0,y0,x1,y1,...), ...]
export function pointInRings(px, py, rings) {
  let inside = false;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

export const falloff = (d, d1, d2) => (d <= d1 ? 1 : d >= d2 ? 0 : (d2 - d) / (d2 - d1));
