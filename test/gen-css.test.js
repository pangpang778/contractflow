import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCss } from '../scripts/gen-css.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = path.join(ROOT, 'design-system', 'tokens');

test('gen-css 从 tokens JSON 导出 :root 变量（状态/颜色/字号/间距）', async () => {
  const css = await buildCss(TOKENS);
  assert.match(css, /--color-status-active: #0a7d3e/);
  assert.match(css, /--color-bg-surface: #ffffff/);
  assert.match(css, /--color-status-void: #c62828/);
  assert.match(css, /--type-scale-base: 14px/);
  assert.match(css, /--space-lg: 16px/);
  assert.match(css, /--radius-md: 6px/);
});

test('提交的 client/tokens.css 与 tokens JSON 无漂移（单一事实源）', async () => {
  const css = await buildCss(TOKENS);
  const onDisk = await fs.readFile(path.join(ROOT, 'client', 'tokens.css'), 'utf8');
  assert.equal(onDisk, css);
});