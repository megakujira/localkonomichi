// 全都市・全条件で、案内に「引き返す」が含まれる1位ルートの数を数える
import { readFile } from 'node:fs/promises';
import { PRESETS } from '../js/presets.js';
import { parseElements } from '../js/osm.js';
import { Graph } from '../js/graph.js';
import { generateLoops, buildInstructions, SPEEDS } from '../js/router.js';
let total = 0, withU = 0, maxMs = 0;
for (const p of PRESETS) {
  const data = JSON.parse(await readFile(new URL(`../data/${p.id}.json`, import.meta.url), 'utf8'));
  const g = new Graph(parseElements(data.elements), { lat: p.lat, lon: p.lon });
  const start = g.nearestNode(g.proj.x(p.lon), g.proj.y(p.lat));
  for (const pref of ['green', 'water', 'both']) for (const minutes of [15, 30, 60]) {
    const { routes, diag } = await generateLoops(g, start.node, { pref, minutes, speed: SPEEDS.normal });
    maxMs = Math.max(maxMs, diag.ms); if (process.env.VERBOSE) console.error(p.id, pref, minutes, diag.ms + "ms");
    for (const r of routes) { total++; if (buildInstructions(g, r).steps.some(s => s.turn === 'uturn')) withU++; }
  }
}
console.log(`ルート${total}本中、「引き返す」を含むもの: ${withU}本 / 最大生成時間 ${maxMs}ms`);
