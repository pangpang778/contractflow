// test/mail.test.js — 中文模板渲染（S2，pure）：替换/缺变量容错/HTML 转义/未知类型抛错。
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate, TEMPLATES } from '../shared/mail.js';

test('US-E2-① 四类事件各有中文模板（subject+body 非空）', () => {
  for (const type of ['approval.requested', 'approval.approved', 'approval.rejected', 'reminder.due']) {
    const t = TEMPLATES[type];
    assert.ok(t, `缺少模板 ${type}`);
    assert.ok(typeof t.subject === 'string' && t.subject.length > 0);
    assert.ok(typeof t.body === 'string' && t.body.length > 0);
    // 中文含 CJK 字符
    assert.match(t.subject + t.body, /[一-鿿]/);
  }
});

test('US-E2-② {{var}} 占位被变量替换', () => {
  const { subject, body } = renderTemplate('reminder.due', {
    title: '采购合同', counterparty_id: 'cp_1', due_date: '2026-10-01', days_left: 15,
  });
  assert.match(subject, /采购合同/);
  assert.match(body, /2026-10-01/);
  assert.match(body, /15/);
  assert.ok(subject.includes('{{') === false, '无残留占位');
});

test('US-E2-③ 缺变量容错：模板引用但 vars 缺键 → 补 —，不抛错', () => {
  let out;
  assert.doesNotThrow(() => {
    out = renderTemplate('reminder.due', { title: '合同甲' }); // 缺 days_left/due_date/counterparty_id
  });
  assert.match(out.body, /—/);
  assert.ok(out.body.includes('合同甲'));
});

test('US-E2-④ HTML 转义：值含 <>&" 出正文中已转义', () => {
  const { body } = renderTemplate('reminder.due', {
    title: `a<b&"quote"'`,
    counterparty_id: "contract'&x",
    due_date: '2026-01-01',
    days_left: 1,
  });
  assert.ok(!body.includes('a<b'), '裸 < 不得出现');
  assert.ok(body.includes('&lt;'), '应转义为 &lt;');
  assert.ok(body.includes('&amp;'));
  assert.ok(body.includes('&quot;'));
  assert.ok(body.includes('&#39;'), '单引号应转义');
  assert.ok(!body.includes("contract'"), '裸 \' 不得出现');
});

test('US-E2-⑤ 输出形状稳定 {subject, body}；未知类型抛错（S3 渲染失败路径）', () => {
  const out = renderTemplate('approval.approved', { title: 'x' });
  assert.deepEqual(Object.keys(out).sort(), ['body', 'subject']);
  assert.throws(() => renderTemplate('no.such.type', { title: 'x' }));
});