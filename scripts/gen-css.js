// scripts/gen-css.js — 从 design-system/tokens/*.json 生成 :root{} CSS 变量。
// JSON 为单一事实源（design-system README）；本脚本把 `--kebab-path` 导出为 CSS var。
// CLI：`node scripts/gen-css.js [outFile]`，默认写 client/tokens.css。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}-${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key));
    else out[key] = v;
  }
  return out;
}

export async function buildCss(tokensDir) {
  const files = (await fs.readdir(tokensDir)).filter((f) => f.endsWith('.json'));
  let vars = {};
  for (const f of files) {
    const json = JSON.parse(await fs.readFile(path.join(tokensDir, f), 'utf8'));
    Object.assign(vars, flatten(json));
  }
  let css = ':root {\n';
  for (const [k, v] of Object.entries(vars)) css += `  --${k}: ${v};\n`;
  css += '}\n';
  return css;
}

export async function writeCss(tokensDir, outFile) {
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, await buildCss(tokensDir));
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (import.meta.main) {
  const tokensDir = path.join(REPO_ROOT, 'design-system', 'tokens');
  const out = process.argv[2] || path.join(REPO_ROOT, 'client', 'tokens.css');
  await writeCss(tokensDir, out);
  console.log(`tokens → ${out}`);
}