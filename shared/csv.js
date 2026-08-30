// shared/csv.js - RFC 4180 CSV 解析纯函数（S4，T4）：零依赖，无 IO。
// parseCsv：逐字符三态状态机（IN_FIELD / IN_QUOTE / AFTER_QUOTE）。
// 兼容 CRLF / 裸 LF / 裸 CR 作记录分隔；引号字段内逗号与换行是字面数据，"" 转义为 "。
// 右引号后仅允许逗号或记录结束；未闭合引号 -> 抛 {code:'BAD_CSV', message}。
// 全空记录（空行）跳过。空输入 -> { header: [''], rows: [] }（约定：视作仅一条空 header）。

/**
 * 解析 CSV 文本为 header + 数据行。
 * @param {string} text CSV 原文
 * @returns {{header:string[], rows:string[][]}} 第一条记录作 header，其余作 rows
 * @throws {{code:'BAD_CSV'}} 未闭合引号 / 右引号后越界字符
 */
export function parseCsv(text) {
  const records = [];
  let field = '';
  let record = [];
  let state = 'IN_FIELD'; // IN_FIELD | IN_QUOTE | AFTER_QUOTE

  const endField = () => {
    record.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    if (record.length > 1 || record[0] !== '') records.push(record); // 空行跳过
    record = [];
  };
  const badCsv = (msg) => {
    const err = new Error(msg);
    err.code = 'BAD_CSV';
    return err;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (state === 'IN_QUOTE') {
      if (ch === '"') state = 'AFTER_QUOTE';
      else field += ch; // 引号内逗号/CR/LF 均为字面数据
      continue;
    }
    if (state === 'AFTER_QUOTE') {
      if (ch === '"') { // "" 转义
        field += '"';
        state = 'IN_QUOTE';
      } else if (ch === ',') {
        endField();
        state = 'IN_FIELD';
      } else if (ch === '\r') {
        endRecord();
        if (text[i + 1] === '\n') i++; // CRLF
      } else if (ch === '\n') {
        endRecord();
      } else {
        throw badCsv(`CSV 解析失败：右引号后出现非法字符 "${ch}"（位置 ${i}）`);
      }
      continue;
    }
    // IN_FIELD
    if (ch === '"') state = 'IN_QUOTE';
    else if (ch === ',') endField();
    else if (ch === '\r') {
      endRecord();
      if (text[i + 1] === '\n') i++; // CRLF
    } else if (ch === '\n') endRecord();
    else field += ch; // 空格是数据，原样保留
  }

  if (state === 'IN_QUOTE') throw badCsv('CSV 解析失败：引号字段未闭合');
  endRecord(); // 收尾：无尾换行时提交最后一条记录；尾换行后此条为空行被跳过

  const [header = [''], ...rows] = records; // 空输入约定：header=[''], rows=[]
  return { header, rows };
}
