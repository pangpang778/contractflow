// test/csv.test.js - RFC4180 CSV 纯函数解析（S4，T4）：状态机边界全覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../shared/csv.js';

test('基本两行：header + rows 切分', () => {
  assert.deepEqual(parseCsv('a,b\nc,d'), { header: ['a', 'b'], rows: [['c', 'd']] });
});

test('尾部换行：不产生幻影空行', () => {
  assert.deepEqual(parseCsv('a,b\nc,d\n'), { header: ['a', 'b'], rows: [['c', 'd']] });
});

test('尾部 CRLF：同样不产生空行', () => {
  assert.deepEqual(parseCsv('a,b\r\nc,d\r\n'), { header: ['a', 'b'], rows: [['c', 'd']] });
});

test('引号字段内逗号保留为字面数据', () => {
  assert.deepEqual(parseCsv('id,title\n1,"Smith, John"'), {
    header: ['id', 'title'],
    rows: [['1', 'Smith, John']],
  });
});

test('引号转义："" -> 字面 "', () => {
  assert.deepEqual(parseCsv('a\n"he said ""hi"""'), {
    header: ['a'],
    rows: [['he said "hi"']],
  });
});

test('引号字段内嵌换行：跨行仍是一个字段', () => {
  assert.deepEqual(parseCsv('note\n"line1\nline2"'), {
    header: ['note'],
    rows: [['line1\nline2']],
  });
});

test('引号字段内嵌 CRLF 保留为 \\r\\n', () => {
  assert.deepEqual(parseCsv('note\n"l1\r\nl2"'), {
    header: ['note'],
    rows: [['l1\r\nl2']],
  });
});

test('CRLF 记录分隔', () => {
  assert.deepEqual(parseCsv('a,b\r\nc,d\r\ne,f'), {
    header: ['a', 'b'],
    rows: [['c', 'd'], ['e', 'f']],
  });
});

test('裸 CR 记录分隔（lenient）', () => {
  assert.deepEqual(parseCsv('a,b\rc,d'), { header: ['a', 'b'], rows: [['c', 'd']] });
});

test('末位空字段保留', () => {
  assert.deepEqual(parseCsv('a,b,\n1,2,'), {
    header: ['a', 'b', ''],
    rows: [['1', '2', '']],
  });
});

test('中间空字段保留', () => {
  assert.deepEqual(parseCsv('a,,c\n1,,3'), {
    header: ['a', '', 'c'],
    rows: [['1', '', '3']],
  });
});

test('引号字段内前后空格保留', () => {
  assert.deepEqual(parseCsv('a\n"  x  "'), { header: ['a'], rows: [['  x  ']] });
});

test('未引号字段两侧空格保留（空格是数据）', () => {
  assert.deepEqual(parseCsv('a, b , c\n1, 2 , 3'), {
    header: ['a', ' b ', ' c'],
    rows: [['1', ' 2 ', ' 3']],
  });
});

test('全空行跳过（含夹在中间的空行）', () => {
  assert.deepEqual(parseCsv('a,b\n\n\nc,d'), { header: ['a', 'b'], rows: [['c', 'd']] });
  assert.deepEqual(parseCsv('\na,b\n'), { header: ['a', 'b'], rows: [] });
});

test('仅一条空字段行（单个逗号）不是空行，保留为两空字段', () => {
  assert.deepEqual(parseCsv('h1,h2\n,\n'), {
    header: ['h1', 'h2'],
    rows: [['', '']],
  });
});

test('未闭合引号抛 BAD_CSV', () => {
  assert.throws(() => parseCsv('a,b\n"unclosed'), (err) => {
    assert.equal(err.code, 'BAD_CSV');
    assert.ok(err.message.length > 0);
    return true;
  });
});

test('右引号后越界字符抛 BAD_CSV', () => {
  assert.throws(() => parseCsv('a,b\n"ok"x'), (err) => {
    assert.equal(err.code, 'BAD_CSV');
    return true;
  });
  assert.throws(() => parseCsv('"a"b,c'), (err) => err.code === 'BAD_CSV');
});

test('空输入 -> { header: [\'\'], rows: [] }（约定：视作仅一条空 header）', () => {
  assert.deepEqual(parseCsv(''), { header: [''], rows: [] });
});

test('纯换行输入 -> 同空输入形状（空行被跳过）', () => {
  assert.deepEqual(parseCsv('\n'), { header: [''], rows: [] });
});
