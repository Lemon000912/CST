import initSqlJs from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SQL = await initSqlJs();
const dbPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'app.sqlite');
const data = fs.readFileSync(dbPath);
const db = new SQL.Database(data);

// 分析论文标题关键词分布
const allTitles = db.exec('SELECT title FROM papers');
const titles = allTitles[0]?.values.map(v => v[0]) || [];

// 统计包含材料科学相关关键词的论文
const materialKeywords = [
  'battery', 'lithium', 'cathode', 'anode', 'electrolyte',
  'solar', 'perovskite', 'photovoltaic', 'cell',
  'catalyst', 'catalysis', 'electrocatal',
  'nanostructure', 'nanoparticle', 'graphene', 'carbon nanotube',
  'oxide', 'TiO2', 'ZnO', 'silicon', 'semiconductor',
  'polymer', 'composite', 'ceramic', 'metal',
  'energy', 'storage', 'supercapacitor',
  'material', 'coating', 'film', 'surface'
];

const nonMaterialKeywords = [
  'fuzz testing', 'software', 'gravitational wave', 'neutrino',
  'pulsar', 'galaxy', 'cosmology', 'astrophysics',
  'machine learning', 'deep learning', 'neural network',
  'insect', 'coleoptera', 'species', 'taxonomy',
  'clinical', 'medical', 'patient', 'disease',
  'injection molding', 'plastic', 'machining',
  'bearing', 'heat treatment'
];

let materialCount = 0;
let nonMaterialCount = 0;
let uncertainCount = 0;

for (const title of titles) {
  const lowerTitle = title.toLowerCase();
  const hasMaterial = materialKeywords.some(k => lowerTitle.includes(k.toLowerCase()));
  const hasNonMaterial = nonMaterialKeywords.some(k => lowerTitle.includes(k.toLowerCase()));

  if (hasMaterial && !hasNonMaterial) {
    materialCount++;
  } else if (hasNonMaterial && !hasMaterial) {
    nonMaterialCount++;
  } else {
    uncertainCount++;
  }
}

console.log('=== 论文分类统计 ===');
console.log(`材料科学相关: ${materialCount}篇`);
console.log(`非材料科学: ${nonMaterialCount}篇`);
console.log(`不确定/混合: ${uncertainCount}篇`);
console.log(`总计: ${titles.length}篇`);

// 列出一些非材料科学的论文
console.log('\n=== 非材料科学论文示例 ===');
let count = 0;
for (const title of titles) {
  const lowerTitle = title.toLowerCase();
  const hasNonMaterial = nonMaterialKeywords.some(k => lowerTitle.includes(k.toLowerCase()));
  if (hasNonMaterial) {
    console.log(`- ${title.slice(0, 80)}`);
    count++;
    if (count >= 10) break;
  }
}

db.close();
