import express from "express";
import cors from "cors";
import compression from "compression";
import Database from "better-sqlite3";
import fs from "fs";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------------------------------------------------
// 資料庫路徑（Railway Volume 掛在 /app/data）
// ------------------------------------------------------
const DB_URL = "https://raw.githubusercontent.com/azzo133456-cmd/lamp-api/main/data/lamps.db";
const LOCAL_DB = "/app/data/lamps.db";

// 下載資料庫
function downloadDB() {
  return new Promise((resolve) => {
    console.log("Downloading lamps.db from GitHub...");
    const file = fs.createWriteStream(LOCAL_DB);
    https.get(DB_URL, (res) => {
      res.pipe(file);
      file.on("finish", () => {
        file.close(() => {
          console.log("lamps.db downloaded.");
          resolve();
        });
      });
    });
  });
}

// Volume 上沒有 db 才下載（首次部署）；之後直接用 Volume 上的版本
if (!fs.existsSync(LOCAL_DB)) {
  await downloadDB();
} else {
  console.log("lamps.db found in volume.");
}

// ------------------------------------------------------
// 23 欄完整路燈清冊資料庫（lamps_full）
// 獨立檔案、獨立連線、唯讀，完全不影響上面的 lamps.db / lamps 資料表
// ------------------------------------------------------
const FULL_DB_URL = "https://raw.githubusercontent.com/azzo133456-cmd/lamp-api/main/data/lamps_full.db";
const LOCAL_FULL_DB = "/app/data/lamps_full.db";

function downloadFullDB() {
  return new Promise((resolve) => {
    console.log("Downloading lamps_full.db from GitHub...");
    const file = fs.createWriteStream(LOCAL_FULL_DB);
    https.get(FULL_DB_URL, (res) => {
      res.pipe(file);
      file.on("finish", () => {
        file.close(() => {
          console.log("lamps_full.db downloaded.");
          resolve();
        });
      });
    });
  });
}

if (!fs.existsSync(LOCAL_FULL_DB)) {
  await downloadFullDB();
} else {
  console.log("lamps_full.db found in volume.");
}

// 用獨立連線開啟（readonly），即使這裡出錯也不會影響原本的 db
let dbFull = null;
try {
  dbFull = new Database(LOCAL_FULL_DB, { readonly: true });
  console.log("lamps_full.db connected. rows =", dbFull.prepare("SELECT COUNT(*) c FROM lamps_full").get().c);
} catch (e) {
  console.error("lamps_full.db 連線失敗（不影響其他既有功能）：", e.message);
  dbFull = null;
}

// 另開一條可寫連線，僅供「匯入回填」端點使用（與上面唯讀連線互不影響）
let dbFullWrite = null;
try {
  dbFullWrite = new Database(LOCAL_FULL_DB);
} catch (e) {
  console.error("lamps_full.db 可寫連線失敗（匯入功能將無法使用）：", e.message);
  dbFullWrite = null;
}

// ------------------------------------------------------
// 智控器總表（controllers）：controller_id / IMEI / IMSI 訊號資料
// 因含敏感識別碼，不放公開 GitHub；改由 Railway Volume 持有，
// 透過受 token 保護的 /admin/upload-controllers 端點一次性上傳。
// 獨立檔案、獨立連線、唯讀，不影響其他資料表。
// ------------------------------------------------------
const LOCAL_CONTROLLERS_DB = "/app/data/controllers.db";

let dbControllers = null;
function openControllersDB() {
  try {
    if (dbControllers) { dbControllers.close(); dbControllers = null; }
    if (!fs.existsSync(LOCAL_CONTROLLERS_DB)) {
      console.log("controllers.db 尚未上傳至 Volume（查詢端點將回 503，請用 /admin/upload-controllers 上傳）");
      return;
    }
    dbControllers = new Database(LOCAL_CONTROLLERS_DB, { readonly: true });
    console.log("controllers.db connected. rows =", dbControllers.prepare("SELECT COUNT(*) c FROM controllers").get().c);
  } catch (e) {
    console.error("controllers.db 連線失敗（不影響其他既有功能）：", e.message);
    dbControllers = null;
  }
}
openControllersDB();

// ------------------------------------------------------
// 建立 express app
// ------------------------------------------------------
const app = express();
app.use(compression());   // gzip 壓縮回應（對 /tasks 大量 JSON 效果最明顯）
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// 正確定位 lamps.db
const db = new Database(LOCAL_DB);

// tasks 資料表（任務清單，多人共用）
db.prepare(`
  CREATE TABLE IF NOT EXISTS tasks (
    area      TEXT NOT NULL,
    task_id   TEXT NOT NULL,
    is_custom INTEGER DEFAULT 0,
    label     TEXT,
    lat       TEXT,
    lng       TEXT,
    added_at  TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (area, task_id)
  )
`).run();

// migration：舊版 tasks 資料表補欄位
const taskCols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
if (!taskCols.includes("is_custom")) db.prepare("ALTER TABLE tasks ADD COLUMN is_custom INTEGER DEFAULT 0").run();
if (!taskCols.includes("label"))     db.prepare("ALTER TABLE tasks ADD COLUMN label TEXT").run();
if (!taskCols.includes("lat"))       db.prepare("ALTER TABLE tasks ADD COLUMN lat TEXT").run();
if (!taskCols.includes("lng"))       db.prepare("ALTER TABLE tasks ADD COLUMN lng TEXT").run();
if (!taskCols.includes("priority"))  db.prepare("ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 0").run();
if (!taskCols.includes("color"))     db.prepare("ALTER TABLE tasks ADD COLUMN color TEXT").run();
// 舊欄位 lamp_id 改名為 task_id（透過 RENAME 處理）
if (taskCols.includes("lamp_id") && !taskCols.includes("task_id")) {
  db.prepare("ALTER TABLE tasks RENAME COLUMN lamp_id TO task_id").run();
}

// ------------------------------------------------------
// 取得單一路燈
// ------------------------------------------------------
app.get("/lamp/:id", (req, res) => {
  let id = req.params.id.trim();
  id = decodeURIComponent(id);

  const lamp = db.prepare("SELECT * FROM lamps WHERE id = ?").get(id);

  if (!lamp) {
    return res.status(404).json({ error: "查無此路燈編號" });
  }

  res.json({
    id: lamp.id,
    address: lamp.address,
    lat: lamp.lat,
    lng: lamp.lng,
    watt: lamp.watt,
    col: lamp.col,
    nav: `https://www.google.com/maps/dir/?api=1&destination=${lamp.lat},${lamp.lng}`
  });
});

// ------------------------------------------------------
// 🔥 最近路燈 API（依照你的資料庫格式）
// ------------------------------------------------------

// 計算距離（Haversine）
function distance(lat1, lng1, lat2, lng2) {
  const R = 6371; // km
  const toRad = (v) => (v * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

app.get("/nearest", (req, res) => {
  const userLat = Number(req.query.lat); // 緯度
  const userLng = Number(req.query.lng); // 經度

  if (!userLat || !userLng) {
    return res.json({ error: "缺少經緯度參數" });
  }

  const lamps = db.prepare("SELECT id, lat, lng FROM lamps").all();

  let nearest = null;
  let minDist = Infinity;

  for (const lamp of lamps) {
    // ⚠ 依照你的資料庫格式：
    // lamp.lat = 經度
    // lamp.lng = 緯度
    const lampLat = Number(lamp.lat); // 緯度
    const lampLng = Number(lamp.lng); // 經度

    const d = distance(userLat, userLng, lampLat, lampLng);

    if (d < minDist) {
      minDist = d;
      nearest = lamp.id;
    }
  }

  res.json({
    id: nearest,
    distance: minDist
  });
});

// ------------------------------------------------------
// 📋 任務清單 API
// ------------------------------------------------------

// 取得某區任務清單（優先置頂）
app.get("/tasks/:area", (req, res) => {
  const rows = db.prepare(`
    SELECT t.task_id AS id, t.is_custom, t.label, t.added_at, t.priority, t.color,
           COALESCE(t.lat, l.lat) AS lat,
           COALESCE(t.lng, l.lng) AS lng,
           COALESCE(t.label, l.address) AS address,
           l.watt, l.col
    FROM tasks t
    LEFT JOIN lamps l ON l.id = t.task_id AND t.is_custom = 0
    WHERE t.area = ?
    ORDER BY t.priority DESC, t.added_at DESC
  `).all(req.params.area);
  res.json(rows);
});

// 設定顏色
app.patch("/tasks/:area/:id/color", (req, res) => {
  const { area } = req.params;
  const id = decodeURIComponent(req.params.id);
  const { color } = req.body;           // "#e53e3e" 或 null（重置預設）
  db.prepare("UPDATE tasks SET color = ? WHERE area = ? AND task_id = ?").run(color || null, area, id);
  res.json({ ok: true, color: color || null });
});

// 切換優先
app.patch("/tasks/:area/:id/priority", (req, res) => {
  const { area } = req.params;
  const id = decodeURIComponent(req.params.id);
  const task = db.prepare("SELECT priority FROM tasks WHERE area = ? AND task_id = ?").get(area, id);
  if (!task) return res.status(404).json({ error: "找不到此任務" });
  const newPriority = task.priority ? 0 : 1;
  db.prepare("UPDATE tasks SET priority = ? WHERE area = ? AND task_id = ?").run(newPriority, area, id);
  res.json({ ok: true, priority: newPriority });
});

// 新增路燈（支援單筆 { id } 或批次 { ids: [...] }）
app.post("/tasks/:area", (req, res) => {
  const { id, ids } = req.body;
  const list = ids ?? (id ? [id] : []);
  if (!list.length) return res.status(400).json({ error: "缺少 id 或 ids" });

  const insert = db.prepare("INSERT OR IGNORE INTO tasks (area, task_id) VALUES (?, ?)");
  const results = { ok: 0, notFound: [] };

  const run = db.transaction(() => {
    for (const lampId of list) {
      const lamp = db.prepare("SELECT id FROM lamps WHERE id = ?").get(lampId.trim());
      if (!lamp) { results.notFound.push(lampId); continue; }
      insert.run(req.params.area, lampId.trim());
      results.ok++;
    }
  });
  run();
  res.json({ ok: true, added: results.ok, notFound: results.notFound });
});

// 地址定位（Google Maps Geocoding API）
function geocode(address) {
  return new Promise((resolve) => {
    const key = process.env.GOOGLE_MAPS_KEY;
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&language=zh-TW&region=TW&key=${key}`;
    https.get(url, (r) => {
      let data = "";
      r.on("data", c => data += c);
      r.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.status === "OK" && json.results[0]) {
            const loc = json.results[0].geometry.location;
            resolve({ lat: loc.lat, lng: loc.lng });
          } else {
            console.error("[geocode] Google status:", json.status, json.error_message || "");
            resolve({ _error: json.status, _msg: json.error_message || "" });
          }
        } catch (e) { console.error("[geocode] parse error", e); resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

// 行車路線（Google Directions API，後端轉發避免 key 外露）
app.get("/directions", (req, res) => {
  const { origin, destination, waypoints } = req.query;
  if (!origin || !destination) return res.status(400).json({ error: "缺少起點或終點" });

  const key = process.env.GOOGLE_MAPS_KEY;
  let url = `https://maps.googleapis.com/maps/api/directions/json`
    + `?origin=${encodeURIComponent(origin)}`
    + `&destination=${encodeURIComponent(destination)}`
    + `&language=zh-TW&region=TW&key=${key}`;
  if (waypoints) url += `&waypoints=${encodeURIComponent(waypoints)}`;

  https.get(url, (r) => {
    let data = "";
    r.on("data", c => data += c);
    r.on("end", () => {
      try { res.json(JSON.parse(data)); }
      catch { res.status(500).json({ error: "解析失敗" }); }
    });
  }).on("error", () => res.status(500).json({ error: "連線失敗" }));
});

// 純地址定位（不寫入 db）
app.get("/geocode", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "缺少 q 參數" });
  const coords = await geocode(q);
  if (!coords) return res.status(404).json({ error: "找不到此地址" });
  if (coords._error) return res.status(502).json({ error: `Google Maps 錯誤：${coords._error}`, detail: coords._msg });
  res.json(coords);
});

// 新增自訂地點（無路燈編號）；lat/lng 可省略，自動用地址定位
app.post("/tasks/:area/custom", async (req, res) => {
  let { label, lat, lng } = req.body;
  if (!label) return res.status(400).json({ error: "請輸入名稱或地址" });

  // 沒有經緯度 → 用地址定位
  if (!lat || !lng) {
    const coords = await geocode(label);
    if (!coords) return res.status(400).json({ error: "地址定位失敗，請手動輸入經緯度" });
    lat = coords.lat;
    lng = coords.lng;
  }

  const task_id = `custom_${Date.now()}`;
  db.prepare(`
    INSERT INTO tasks (area, task_id, is_custom, label, lat, lng)
    VALUES (?, ?, 1, ?, ?, ?)
  `).run(req.params.area, task_id, label, String(lat), String(lng));
  res.json({ ok: true, task_id });
});

// 從任務清單移除（單筆）
app.delete("/tasks/:area/:id", (req, res) => {
  db.prepare("DELETE FROM tasks WHERE area = ? AND task_id = ?")
    .run(req.params.area, decodeURIComponent(req.params.id));
  res.json({ ok: true });
});

// 清空整個區域的任務清單
app.delete("/tasks/:area", (req, res) => {
  db.prepare("DELETE FROM tasks WHERE area = ?").run(req.params.area);
  res.json({ ok: true });
});

// ------------------------------------------------------
// ✏️ 單筆修改
// ------------------------------------------------------
app.patch("/lamp/:id", (req, res) => {
  let id = decodeURIComponent(req.params.id.trim());
  const lamp = db.prepare("SELECT * FROM lamps WHERE id = ?").get(id);
  if (!lamp) return res.status(404).json({ error: "查無此路燈編號" });

  const { address, lat, lng, watt, col } = req.body;
  db.prepare(`UPDATE lamps SET address=@address, lat=@lat, lng=@lng, watt=@watt, col=@col WHERE id=@id`).run({
    id,
    address: address !== undefined ? address : lamp.address,
    lat:     lat     !== undefined ? lat     : lamp.lat,
    lng:     lng     !== undefined ? lng     : lamp.lng,
    watt:    watt    !== undefined ? watt    : lamp.watt,
    col:     col     !== undefined ? col     : lamp.col,
  });

  console.log(`[edit] ${id} updated`);
  res.json({ ok: true });
});

// ------------------------------------------------------
// 📥 匯入工具函式
// ------------------------------------------------------

// 去掉 ="value" 格式
function stripCell(v) {
  if (typeof v !== "string") return v;
  const m = v.match(/^="(.*)"$/s);
  return m ? m[1] : v.trim();
}

// TWD97 TM2 (EPSG:3826) → WGS84
function twd97ToWgs84(x, y) {
  const a  = 6378137.0;
  const f  = 1 / 298.257222101;
  const b  = a * (1 - f);
  const e2 = 1 - (b / a) ** 2;
  const k0 = 0.9999;
  const x0 = 250000;
  const lon0 = 121 * Math.PI / 180;

  const xp = x - x0;
  const M  = y / k0;
  const e  = Math.sqrt(e2);
  const mu = M / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));

  const phi1 = mu
    + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
    + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);
  const N1 = a / Math.sqrt(1 - e2 * sinPhi1 ** 2);
  const T1 = tanPhi1 ** 2;
  const C1 = e2 * cosPhi1 ** 2 / (1 - e2);
  const R1 = a * (1 - e2) / (1 - e2 * sinPhi1 ** 2) ** 1.5;
  const D  = xp / (N1 * k0);

  const lat = phi1 - (N1 * tanPhi1 / R1) * (
    D ** 2 / 2
    - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * e2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * e2 - 3 * C1 ** 2) * D ** 6 / 720
  );
  const lon = lon0 + (
    D
    - (1 + 2 * T1 + C1) * D ** 3 / 6
    + (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * e2 + 24 * T1 ** 2) * D ** 5 / 120
  ) / cosPhi1;

  return { lat: lat * 180 / Math.PI, lng: lon * 180 / Math.PI };
}

// 欄位對照表（中文 → db 欄位）
const COL_MAP = {
  // 編號
  "路燈編號":   "id",      "開關箱編號": "id",      "id": "id",
  // 地址
  "地址":       "address", "詳細位置":   "address", "address": "address",
  // 緯度
  "緯度":       "lat",     "lat": "lat",
  // 經度
  "經度":       "lng",     "lng": "lng",
  // 瓦數
  "燈泡瓦數":   "watt",    "瓦特數":     "watt",    "watt": "watt",
  // 色溫
  "色溫":       "col",     "col": "col",
  // TWD97 座標
  "X":          "_x",
  "Y":          "_y",
  // 行政區篩選
  "區域":       "_area",   "行政區":     "_area",
};

function processRow(raw) {
  const r = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = COL_MAP[k.trim()];
    if (key) r[key] = stripCell(v);
  }

  // TWD97 自動轉換：X 值 > 1000 代表是座標系統數值
  if (r._x && r._y && Number(r._x) > 1000) {
    const { lat, lng } = twd97ToWgs84(Number(r._x), Number(r._y));
    r.lat = lat.toFixed(6);
    r.lng = lng.toFixed(6);
  }

  return r;
}

// ------------------------------------------------------
// 📥 匯入 Excel 資料（UPSERT，保留其他來源資料）
// POST body: { data: [...rows], areas: ["汐止區","五股區"] }
// areas 可省略（不篩選）
// ------------------------------------------------------
app.post("/import", (req, res) => {
  const { data, areas } = req.body ?? {};

  if (!Array.isArray(data) || data.length === 0) {
    return res.status(400).json({ error: "資料格式錯誤或無資料（需要 { data: [...] }）" });
  }

  const areaFilter = Array.isArray(areas) && areas.length > 0
    ? new Set(areas.map(a => a.trim()))
    : null;

  const mapped = data
    .map(processRow)
    .filter(r => {
      if (!r.id) return false;
      if (areaFilter && r._area && !areaFilter.has(r._area)) return false;
      return true;
    });

  if (mapped.length === 0) {
    return res.status(400).json({ error: "篩選後無符合資料，請確認欄位名稱或行政區設定" });
  }

  try {
    const del    = db.prepare("DELETE FROM lamps WHERE id = @id");
    const insert = db.prepare(`
      INSERT INTO lamps (id, address, lat, lng, watt, col)
      VALUES (@id, @address, @lat, @lng, @watt, @col)
    `);

    const importAll = db.transaction((rows) => {
      for (const r of rows) {
        const row = {
          id:      r.id      ?? null,
          address: r.address ?? null,
          lat:     r.lat     ?? null,
          lng:     r.lng     ?? null,
          watt:    r.watt    ?? null,
          col:     r.col     ?? null,
        };
        del.run({ id: row.id });
        insert.run(row);
      }
    });

    importAll(mapped);
    console.log(`[import] upsert ${mapped.length} 筆`);
    res.json({ ok: true, count: mapped.length });
  } catch (e) {
    console.error("[import] 錯誤：", e);
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------------
// 23 欄完整資料查詢（新增 endpoint，純附加，不更動原有路由）
// ------------------------------------------------------
app.get("/lamp-full/:id", (req, res) => {
  if (!dbFull) return res.status(503).json({ error: "完整資料庫尚未就緒，請稍後再試" });
  let id = req.params.id.trim();
  id = decodeURIComponent(id);

  const row = dbFull.prepare('SELECT * FROM lamps_full WHERE "路燈編號" = ?').get(id);
  if (!row) return res.status(404).json({ error: "查無此路燈編號" });

  res.json(row);
});

// ------------------------------------------------------
// 📥 匯入 Excel 回填完整路燈清冊（lamps_full，UPSERT，依「路燈編號」新增或更新）
// POST body: { rows: [ { 路燈編號, 行政區, ... 24 欄 }, ... ] }
// 規則：Excel 中有填值的欄位才會覆蓋資料庫，留白欄位保留資料庫原值（新增的路燈則留白欄位存為空字串）
// row 中沒有「路燈編號」者會被忽略
// ------------------------------------------------------
const FULL_COLUMNS = ['路燈編號','行政區','里','詳細位置','經度','緯度','燈桿類型','燈桿型式','燈桿廠牌','燈具編號',
                      '燈具種類','瓦特數','色溫','新裝絕緣值','新裝接地值','路燈性質','控制器編號',
                      '計劃類別','計劃名稱','主要廠商','更新時間','是否啟用','是否廢止','是否自主審核通過'];

app.post("/lamps-full/import", (req, res) => {
  if (!dbFullWrite) return res.status(503).json({ error: "完整資料庫尚未就緒，請稍後再試" });

  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (rows.length === 0) return res.status(400).json({ error: "請提供 rows 陣列" });

  const mapped = [];
  const skipped = [];
  for (const raw of rows) {
    const id = raw?.['路燈編號'] != null ? String(raw['路燈編號']).trim() : '';
    if (!id) { skipped.push(raw); continue; }
    const row = { 路燈編號: id };
    for (const col of FULL_COLUMNS) {
      if (col === '路燈編號') continue;
      const v = raw[col];
      const s = (v === undefined || v === null) ? '' : String(v).trim();
      if (s !== '') row[col] = s;
    }
    mapped.push(row);
  }

  if (mapped.length === 0) {
    return res.status(400).json({ error: "資料中找不到「路燈編號」欄位，請確認 Excel 標題列" });
  }

  try {
    const select = dbFullWrite.prepare('SELECT * FROM lamps_full WHERE "路燈編號" = ?');
    const del    = dbFullWrite.prepare('DELETE FROM lamps_full WHERE "路燈編號" = @路燈編號');
    const placeholders = FULL_COLUMNS.map(c => `@${c}`).join(", ");
    const cols = FULL_COLUMNS.map(c => `"${c}"`).join(", ");
    const insert = dbFullWrite.prepare(`INSERT INTO lamps_full (${cols}) VALUES (${placeholders})`);

    let added = 0, updated = 0;
    const importAll = dbFullWrite.transaction((list) => {
      for (const r of list) {
        const existing = select.get(r.路燈編號);
        const final = { 路燈編號: r.路燈編號 };
        for (const col of FULL_COLUMNS) {
          if (col === '路燈編號') continue;
          if (col in r) final[col] = r[col];
          else final[col] = existing ? (existing[col] ?? '') : '';
        }
        del.run(final);
        insert.run(final);
        if (existing) updated++; else added++;
      }
    });
    importAll(mapped);

    console.log(`[lamps-full/import] 新增 ${added} 筆、更新 ${updated} 筆，略過 ${skipped.length} 筆`);
    res.json({ ok: true, added, updated, skipped: skipped.length, total: mapped.length });
  } catch (e) {
    console.error("[lamps-full/import] 錯誤：", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/lamps-full/batch", (req, res) => {
  if (!dbFull) return res.status(503).json({ error: "完整資料庫尚未就緒，請稍後再試" });

  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).map(s => s.trim()).filter(Boolean) : [];
  if (ids.length === 0) return res.status(400).json({ error: "請提供 ids 陣列" });

  const placeholders = ids.map(() => "?").join(",");
  const rows = dbFull.prepare(`SELECT * FROM lamps_full WHERE "路燈編號" IN (${placeholders})`).all(...ids);

  const found = new Set(rows.map(r => r["路燈編號"]));
  const not_found = ids.filter(id => !found.has(id));

  res.json({ count: rows.length, results: rows, not_found });
});

// ------------------------------------------------------
// 📡 智控器訊號查詢（controllers：controller_id / IMEI / IMSI）
// 支援用「ID」或「controller_id」查詢，批次比對
// POST body: { ids: [...] }
// ------------------------------------------------------
app.post("/controllers/batch", (req, res) => {
  if (!dbControllers) return res.status(503).json({ error: "智控器資料庫尚未就緒，請稍後再試" });

  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).map(s => s.trim()).filter(Boolean) : [];
  if (ids.length === 0) return res.status(400).json({ error: "請提供 ids 陣列" });

  const placeholders = ids.map(() => "?").join(",");
  const rows = dbControllers.prepare(
    `SELECT * FROM controllers WHERE "ID" IN (${placeholders}) OR "controller_id" IN (${placeholders})`
  ).all(...ids, ...ids);

  const found = new Set();
  for (const r of rows) {
    found.add(r["ID"]);
    found.add(r["controller_id"]);
  }
  const not_found = ids.filter(id => !found.has(id));

  res.json({ count: rows.length, results: rows, not_found });
});

// ------------------------------------------------------
// 📥 匯入智控總表 MD，整批重建 controllers 表（ID + controller_id）
// 前端直接上傳 .md 原始文字；以總表為準，全量取代
// body：text/plain（Markdown 表格內容）
// ------------------------------------------------------
function parseControllersMd(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    if (t.includes("controller_id") || /^\|[\s-]*\|/.test(t)) continue; // 標題/分隔列
    const cells = t.split("|").slice(1, -1).map(c => c.trim());
    if (cells.length < 2) continue;
    const [id, cid] = cells;
    if (!cid) continue;
    rows.push({ id, cid });
  }
  return rows;
}

app.post("/controllers/import-md",
  express.text({ type: "*/*", limit: "50mb" }),
  (req, res) => {
    const text = typeof req.body === "string" ? req.body : "";
    if (!text.trim()) return res.status(400).json({ error: "無內容（請上傳智控總表 MD）" });

    const parsed = parseControllersMd(text);
    if (parsed.length === 0) {
      return res.status(400).json({ error: "解析不到任何資料列，請確認 MD 表格含 ID 與 controller_id 欄" });
    }

    let w = null;
    try {
      // 先關閉唯讀連線，改用可寫連線整批重建
      if (dbControllers) { dbControllers.close(); dbControllers = null; }
      w = new Database(LOCAL_CONTROLLERS_DB);
      w.pragma("journal_mode = WAL");
      w.prepare(`CREATE TABLE IF NOT EXISTS controllers ("ID" TEXT, "controller_id" TEXT)`).run();

      const insert = w.prepare(`INSERT INTO controllers ("ID","controller_id") VALUES (?,?)`);
      const rebuild = w.transaction((list) => {
        w.prepare("DELETE FROM controllers").run();
        for (const r of list) insert.run(r.id, r.cid);
      });
      rebuild(parsed);

      w.prepare(`CREATE INDEX IF NOT EXISTS idx_controllers_id ON controllers("ID")`).run();
      w.prepare(`CREATE INDEX IF NOT EXISTS idx_controllers_cid ON controllers("controller_id")`).run();
      w.pragma("wal_checkpoint(TRUNCATE)");
      w.close(); w = null;

      openControllersDB(); // 重新以唯讀連線開啟
      console.log(`[controllers/import-md] 整批重建 ${parsed.length} 筆`);
      res.json({ ok: true, rows: parsed.length });
    } catch (e) {
      console.error("[controllers/import-md] 失敗：", e.message);
      try { if (w) w.close(); } catch {}
      openControllersDB(); // 盡量恢復唯讀連線
      res.status(500).json({ error: e.message });
    }
  }
);

// ------------------------------------------------------
// 📡 智控器模糊查詢（輸入部分碼 → 找出完整 ID）
// 對 ID / controller_id 做 LIKE %term% 比對
// POST body: { terms: [...] }；每個 term 至少 3 碼
// ------------------------------------------------------
const CTRL_SEARCH_FIELDS = ["ID", "controller_id"];
const CTRL_PER_TERM_LIMIT = 100;

app.post("/controllers/search", (req, res) => {
  if (!dbControllers) return res.status(503).json({ error: "智控器資料庫尚未就緒，請稍後再試" });

  const raw = Array.isArray(req.body?.terms) ? req.body.terms
            : Array.isArray(req.body?.ids)   ? req.body.ids   // 相容舊參數名
            : [];
  const terms = raw.map(String).map(s => s.trim()).filter(Boolean);
  if (terms.length === 0) return res.status(400).json({ error: "請提供 terms 陣列" });

  const where = CTRL_SEARCH_FIELDS.map(f => `"${f}" LIKE ?`).join(" OR ");
  const stmt = dbControllers.prepare(
    `SELECT * FROM controllers WHERE ${where} LIMIT ${CTRL_PER_TERM_LIMIT + 1}`
  );

  const seen = new Set();          // 以 controller_id 去重
  const results = [];
  const not_found = [];            // 查無資料的 term
  const too_short = [];            // 少於 3 碼，未查詢
  const truncated = [];            // 命中超過上限、僅回傳前 100 筆的 term

  for (const t of terms) {
    if (t.length < 3) { too_short.push(t); continue; }
    const like = `%${t}%`;
    const rows = stmt.all(...CTRL_SEARCH_FIELDS.map(() => like));
    if (rows.length === 0) { not_found.push(t); continue; }
    if (rows.length > CTRL_PER_TERM_LIMIT) truncated.push(t);
    for (const r of rows.slice(0, CTRL_PER_TERM_LIMIT)) {
      const key = r.controller_id || JSON.stringify(r);
      if (!seen.has(key)) { seen.add(key); results.push(r); }
    }
  }

  res.json({ count: results.length, results, not_found, too_short, truncated });
});

// ------------------------------------------------------
// 🔐 一次性上傳 controllers.db 至 Railway Volume
// 需設定環境變數 ADMIN_TOKEN，並於 header 帶 X-Admin-Token
// 用法： curl -X POST <API>/admin/upload-controllers \
//          -H "X-Admin-Token: <token>" \
//          --data-binary @data/controllers.db
// ------------------------------------------------------
app.post("/admin/upload-controllers",
  express.raw({ type: "*/*", limit: "300mb" }),
  (req, res) => {
    if (!process.env.ADMIN_TOKEN) {
      return res.status(503).json({ error: "伺服器未設定 ADMIN_TOKEN，無法上傳" });
    }
    if (req.headers["x-admin-token"] !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ error: "未授權（X-Admin-Token 不正確）" });
    }
    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: "無檔案內容（請用 --data-binary 上傳）" });
    }
    try {
      // 先寫到暫存檔再改名，避免上傳中斷造成半個檔案
      const tmp = LOCAL_CONTROLLERS_DB + ".uploading";
      fs.writeFileSync(tmp, req.body);
      // 驗證確實是含 controllers 資料表的 sqlite
      const test = new Database(tmp, { readonly: true });
      const rows = test.prepare("SELECT COUNT(*) c FROM controllers").get().c;
      test.close();
      if (dbControllers) { dbControllers.close(); dbControllers = null; }
      fs.renameSync(tmp, LOCAL_CONTROLLERS_DB);
      openControllersDB();
      console.log(`[admin] controllers.db 上傳完成，rows = ${rows}`);
      res.json({ ok: true, rows });
    } catch (e) {
      console.error("[admin] controllers.db 上傳失敗：", e.message);
      res.status(500).json({ error: e.message });
    }
  }
);

// ------------------------------------------------------
// 啟動伺服器
// ------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
