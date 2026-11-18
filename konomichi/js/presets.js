// デモ用の出発地。data/<id>.json に事前取得した OSM データを同梱している
// （公開 Overpass サーバーが遅い/不安定なため。実測は README 参照）。
export const DATA_RADIUS = 1800;
export const PRESETS = [
  { id: 'kyoto-kamogawa', name: '京都・四条大橋（鴨川）', lat: 35.00391, lon: 135.77175, note: '川沿い' },
  { id: 'tokyo-ueno', name: '東京・上野（不忍池）', lat: 35.71170, lon: 139.77130, note: '公園と池' },
  { id: 'osaka-nakanoshima', name: '大阪・中之島', lat: 34.69300, lon: 135.50050, note: '川に挟まれた中洲' },
  { id: 'yokohama-yamashita', name: '横浜・山下公園', lat: 35.44690, lon: 139.65030, note: '海と公園' },
  { id: 'tokyo-shinjuku', name: '東京・新宿駅', lat: 35.68960, lon: 139.70050, note: '緑が少ない難所' },
];
