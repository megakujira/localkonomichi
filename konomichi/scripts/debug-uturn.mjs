// 「引き返す」案内が出るルートの前後を表示する開発用スクリプト
import { readFile } from 'node:fs/promises';
import { PRESETS } from '../js/presets.js';
import { parseElements } from '../js/osm.js';
import { Graph } from '../js/graph.js';
import { generateLoops, buildInstructions, SPEEDS } from '../js/router.js';
let shown = 0;
for (const p of PRESETS) {
  const data = JSON.parse(await readFile(new URL(`../data/${p.id}.json`, import.meta.url), 'utf8'));
  const g = new Graph(parseElements(data.elements), { lat: p.lat, lon: p.lon });
  const start = g.nearestNode(g.proj.x(p.lon), g.proj.y(p.lat));
  for (const pref of ['green', 'water', 'both']) for (const minutes of [15, 30, 60]) {
    const { routes } = await generateLoops(g, start.node, { pref, minutes, speed: SPEEDS.normal });
    routes.forEach((r, ri) => {
      const ins = buildInstructions(g, r);
      const k = ins.steps.findIndex(s => s.turn === 'uturn');
      if (k < 0 || shown >= 5) return;
      shown++;
      const st = ins.steps[k], i = r.nodes.indexOf(st.node);
      console.log(`--- ${p.id} ${pref} ${minutes}分 #${ri}: Uターン ${Math.round(st.at)}m地点 (node ${i}/${r.nodes.length})`);
      for (let j = Math.max(0, i - 5); j <= Math.min(r.nodes.length - 1, i + 5); j++) {
        const u = r.nodes[j], e = r.edges[j], t = e !== undefined ? g.roads[g.eway[e]].tags : {};
        console.log(`  [${j}] (${g.nx[u].toFixed(0)},${g.ny[u].toFixed(0)}) deg=${g.adjStart[u + 1] - g.adjStart[u]} → len=${e !== undefined ? g.elen[e].toFixed(1) : ''} ${t.highway || ''} ${t.name || ''}`);
      }
    });
  }
}
