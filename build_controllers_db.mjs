// 從「智控總表」Markdown 表格重建 data/controllers.db
// 用法： node build_controllers_db.mjs "<總表.md 路徑>"
// 省略路徑時，使用下方 DEFAULT_SRC。
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const DEFAULT_SRC = 'C:\\Users\\azzo1\\OneDrive\\GeminiCLI\\智控總表_20240408.md';
const SRC = process.argv[2] || DEFAULT_SRC;
const OUT = path.join(process.cwd(), 'data', 'controllers.db');

if (!fs.existsSync(SRC)) {
  console.error('找不到來源檔：', SRC);
  process.exit(1);
}

// 重建前先刪舊檔（含 WAL/SHM）
for (const f of [OUT, OUT + '-wal', OUT + '-shm']) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

const db = new Database(OUT);
db.pragma('journal_mode = WAL');
db.prepare(`
  CREATE TABLE controllers (
    "ID" TEXT,
    "controller_id" TEXT,
    "controller_imei" TEXT,
    "imsi" TEXT,
    "重複" TEXT
  )
`).run();

const insert = db.prepare(`INSERT INTO controllers ("ID","controller_id","controller_imei","imsi","重複") VALUES (?,?,?,?,?)`);
const insertMany = db.transaction((rows) => { for (const r of rows) insert.run(r.id, r.cid, r.imei, r.imsi, r.dup); });

const rl = readline.createInterface({ input: fs.createReadStream(SRC, 'utf8'), crlfDelay: Infinity });

let batch = [], count = 0, skipped = 0;
for await (const line of rl) {
  const t = line.trim();
  if (!t.startsWith('|')) continue;
  if (t.includes('controller_id') || /^\|[\s-]*\|/.test(t)) { skipped++; continue; } // 標題/分隔列
  const cells = t.split('|').slice(1, -1).map(c => c.trim());
  if (cells.length < 5) continue;
  const [id, cid, imei, imsi, dup] = cells;
  if (!cid) continue;
  batch.push({ id, cid, imei, imsi, dup });
  count++;
  if (batch.length >= 5000) { insertMany(batch); batch = []; }
}
if (batch.length) insertMany(batch);

db.prepare('CREATE INDEX idx_controllers_id ON controllers("ID")').run();
db.prepare('CREATE INDEX idx_controllers_cid ON controllers("controller_id")').run();

// 收尾：合併 WAL、關閉，留下單一 .db 檔
db.pragma('wal_checkpoint(TRUNCATE)');
db.pragma('journal_mode = DELETE');
const total = db.prepare('SELECT COUNT(*) c FROM controllers').get().c;
db.close();
for (const f of [OUT + '-wal', OUT + '-shm']) { if (fs.existsSync(f)) fs.unlinkSync(f); }

console.log(`完成：匯入 ${count} 筆（略過標題/分隔列 ${skipped}），資料庫共 ${total} 筆 → ${OUT}`);
