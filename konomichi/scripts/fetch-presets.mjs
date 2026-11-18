// 使い方: node scripts/fetch-presets.mjs [presetId ...]
import { writeFile, mkdir } from 'node:fs/promises';
import { PRESETS, DATA_RADIUS } from '../js/presets.js';
import { buildQuery, fetchOverpass, trimElements } from '../js/osm.js';

const only = process.argv.slice(2);
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
for (const p of PRESETS) {
  if (only.length && !only.includes(p.id)) continue;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const t0 = Date.now();
    try {
      console.log(`[${p.id}] 取得開始 (試行${attempt})`);
      const { json, endpoint } = await fetchOverpass(buildQuery(p.lat, p.lon, DATA_RADIUS), { stagger: 15000, onStatus: s => console.log('  ', s) });
      const data = { id: p.id, name: p.name, center: { lat: p.lat, lon: p.lon }, radius: DATA_RADIUS, fetchedAt: new Date().toISOString(), source: endpoint, elements: trimElements(json.elements) };
      const text = JSON.stringify(data);
      await writeFile(new URL(`../data/${p.id}.json`, import.meta.url), text);
      console.log(`[${p.id}] OK ${json.elements.length}要素 ${(text.length / 1e6).toFixed(2)}MB ${((Date.now() - t0) / 1000).toFixed(1)}s via ${endpoint}`);
      break;
    } catch (e) {
      console.log(`[${p.id}] 失敗: ${e.message} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      await new Promise(r => setTimeout(r, 5000 * attempt));
    }
  }
}
