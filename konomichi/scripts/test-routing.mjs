// 使い方: node scripts/test-routing.mjs [presetId ...]
// 同梱データで「好み × 所要時間」の全組合せを実行し、実現性の指標を表にして出す。
import { readFile } from 'node:fs/promises';
import { PRESETS } from '../js/presets.js';
import { parseElements } from '../js/osm.js';
import { Graph } from '../js/graph.js';
import { generateLoops, buildInstructions, SPEEDS } from '../js/router.js';

// 環境変数 CROSSING=major|residential|all で横断歩道の条件を切り替える（既定: residential）
const crossing = process.env.CROSSING || 'residential';
const only = process.argv.slice(2);
const pct = x => `${Math.round(x * 100)}%`;
for (const p of PRESETS) {
  if (only.length && !only.includes(p.id)) continue;
  const data = JSON.parse(await readFile(new URL(`../data/${p.id}.json`, import.meta.url), 'utf8'));
  const parsed = parseElements(data.elements);
  const g = new Graph(parsed, { lat: p.lat, lon: p.lon });
  const st = g.stats;
  console.log(`\n===== ${p.name} =====`);
  console.log(`グラフ: ノード${st.nodes} エッジ${st.edges} 道路${st.networkKm.toFixed(0)}km | 緑地${st.features.green} 水域${st.features.water} 街路樹${st.features.trees} | 緑に触れる道${pct(st.greenShare)} 水辺に触れる道${pct(st.waterShare)} | 横断歩道・信号${st.features.crossings} | 構築${st.ms.total}ms`);
  const start = g.nearestNode(g.proj.x(p.lon), g.proj.y(p.lat));
  console.log(`出発地スナップ: ${start.dist.toFixed(0)}m`);
  for (const pref of ['green', 'water', 'both']) {
    for (const minutes of [15, 30, 60]) {
      const { routes, diag } = await generateLoops(g, start.node, { pref, minutes, speed: SPEEDS.normal, crossing });
      const line = routes.map(r => `[${Math.round(r.lengthM)}m/${r.minutes.toFixed(0)}分 緑${pct(r.stats.greenShare)} 水${pct(r.stats.waterShare)} 近接${pct(r.stats.near)} 形${r.stats.compact.toFixed(2)} 曲がり${r.turns} 横断${r.crossings.marked}/無${r.crossings.unmarked}]`).join(' ');
      console.log(`${pref.padEnd(5)} ${String(minutes).padStart(2)}分 ${diag.ms}ms 候補${diag.valid}/${diag.candidates} → ${routes.length ? line : '該当なし'}`);
      if (routes[0] && pref === 'both' && minutes === 30) {
        console.log(`   1位: ${routes[0].title}`);
        const ins = buildInstructions(g, routes[0]);
        console.log('   案内: ' + ins.steps.slice(0, 7).map(s => `${s.text}${s.via ? '(' + s.via + ')' : ''} ${Math.round(s.next)}m`).join(' → ') + ' …');
      }
    }
  }
}
