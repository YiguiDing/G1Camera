// 检查 xlsx 中旋转相关参数行的原始单元格
const XLSX = require('xlsx');
const wb = XLSX.readFile('doc/G1控制协议ID.xlsx');
const ws = wb.Sheets[wb.SheetNames[0]];
for (const [addr, cell] of Object.entries(ws)) {
    if (addr[0] === '!') continue;
    const v = typeof cell.v === 'string' ? cell.v : String(cell.v ?? '');
    if (/rotation|旋转|0x3F|0X3F/i.test(v)) {
        console.log(addr, '|', cell.t, '|', JSON.stringify(cell.v));
    }
}
console.log('\n---- full rows around Rotation ----');
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
rows.forEach((row, i) => {
    const first = String(row[0] ?? '');
    const second = String(row[1] ?? '');
    const third = String(row[2] ?? '');
    if (/rotation/i.test(second) || /0x3F|0X3F/i.test(first) || /0x11|0X11/i.test(first)) {
        console.log(`row ${i + 1}: [${row.map((c) => String(c).slice(0, 40)).join(' | ')}]`);
    }
});
