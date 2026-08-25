import express from "express";
import cors from "cors";
import compression from "compression";
import Database from "better-sqlite3";
import fs from "fs";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";
import webpush from "web-push";
import cron from "node-cron";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------------------------------------------------
// 主資料庫（Railway Volume 掛在 /app/data）
// lamps.db 現只存放 tasks / site_visits / push_subscriptions；
// 路燈資料已合併至 lamps_full。啟動時會移除殘留的舊 lamps 表以回收 Volume 空間。
// （不再從 GitHub 下載 lamps.db；Volume 沒有時 better-sqlite3 會建立空檔並自動建表）
// ------------------------------------------------------
const LOCAL_DB = "/app/data/lamps.db";

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
// 路燈開關箱資料庫（switchboxes）：開關箱編號 / 位置 / 座標 等 10 欄
// 獨立檔案、獨立連線，比照 lamps_full；首次部署自 GitHub 下載，之後用 Volume 版本
// ------------------------------------------------------
const SB_DB_URL = "https://raw.githubusercontent.com/azzo133456-cmd/lamp-api/main/data/switchboxes.db";
const LOCAL_SB_DB = "/app/data/switchboxes.db";

function downloadSbDB() {
  return new Promise((resolve) => {
    console.log("Downloading switchboxes.db from GitHub...");
    const file = fs.createWriteStream(LOCAL_SB_DB);
    https.get(SB_DB_URL, (res) => {
      res.pipe(file);
      file.on("finish", () => file.close(() => { console.log("switchboxes.db downloaded."); resolve(); }));
    });
  });
}

if (!fs.existsSync(LOCAL_SB_DB)) {
  await downloadSbDB();
} else {
  console.log("switchboxes.db found in volume.");
}

let dbSb = null;
try {
  dbSb = new Database(LOCAL_SB_DB, { readonly: true });
  console.log("switchboxes.db connected. rows =", dbSb.prepare("SELECT COUNT(*) c FROM switchboxes").get().c);
} catch (e) {
  console.error("switchboxes.db 連線失敗（不影響其他既有功能）：", e.message);
  dbSb = null;
}

let dbSbWrite = null;
try {
  dbSbWrite = new Database(LOCAL_SB_DB);
} catch (e) {
  console.error("switchboxes.db 可寫連線失敗（匯入功能將無法使用）：", e.message);
  dbSbWrite = null;
}

// ------------------------------------------------------
// 台北市路燈（taipei_lamps）：燈牌號碼尚未完整建置，主要以「點位系統編號」查詢
// 與 lamps_full 共用同一個 db 檔案（同檔不同表），沿用 dbFull / dbFullWrite 連線，
// 不另外開新檔案/新連線；隨 lamps_full.db 一起下載，不需要額外的下載步驟
// ------------------------------------------------------

// 台北市路燈：因「燈牌號碼」尚未完整建置，查詢時同時比對「點位系統編號」與「燈牌號碼」
// 兩者都可能重複（燈牌號碼常見：舊點位刪除後號碼被新燈桿沿用、或各公園自行編號造成撞號），
// 所以一次撈出所有符合的列，回傳陣列，交給呼叫端決定「唯一→直接顯示」或「多筆→列出讓使用者選」
function getTaipeiLampCandidates(key) {
  if (!dbFull) return [];
  let rows;
  try {
    rows = dbFull.prepare(
      'SELECT * FROM taipei_lamps WHERE "點位系統編號" = ? OR "燈牌號碼" = ?'
    ).all(key, key);
  } catch (e) {
    return []; // taipei_lamps 尚未匯入
  }
  return rows.map(row => ({
    id: row["燈牌號碼"] || row["點位系統編號"],
    point_id: row["點位系統編號"],
    tag_id: row["燈牌號碼"] || null,
    address: row["地點"],
    lat: row["緯度"],
    lng: row["經度"],
    district: row["行政區"],
    village: row["里"],
    squad: row["分隊"],
    zone_code: row["管區代碼"],
    loc_type: row["位置屬性"],
    pole_height: row["材料名稱"],
  }));
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

// site_visits 資料表（會勘排程：日期+時間+地點+備註，與路燈無關）
db.prepare(`
  CREATE TABLE IF NOT EXISTS site_visits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    area        TEXT NOT NULL,
    label       TEXT NOT NULL,
    visit_date  TEXT NOT NULL,
    visit_time  TEXT,
    note        TEXT,
    lat         TEXT,
    lng         TEXT,
    notified    INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  )
`).run();

// migration：舊版 site_visits 補座標欄位（定位一次後寫回，之後不必重打 Geocoding）
const visitCols = db.prepare("PRAGMA table_info(site_visits)").all().map(c => c.name);
if (!visitCols.includes("lat")) db.prepare("ALTER TABLE site_visits ADD COLUMN lat TEXT").run();
if (!visitCols.includes("lng")) db.prepare("ALTER TABLE site_visits ADD COLUMN lng TEXT").run();

// push_subscriptions 資料表（Web Push 訂閱資訊）
db.prepare(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    area         TEXT NOT NULL,
    endpoint     TEXT NOT NULL UNIQUE,
    p256dh       TEXT NOT NULL,
    auth         TEXT NOT NULL,
    created_at   TEXT DEFAULT (datetime('now','localtime'))
  )
`).run();

// 一次性清理：路燈資料已合併至 lamps_full，移除殘留的舊 lamps 表並回收空間
// （tasks / site_visits / push_subscriptions 不受影響）
try {
  const hasLamps = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lamps'").get();
  if (hasLamps) {
    db.exec("DROP TABLE lamps");
    db.exec("VACUUM");
    console.log("[cleanup] 已移除舊 lamps 表並 VACUUM 回收 Volume 空間");
  }
} catch (e) {
  console.error("[cleanup] 移除 lamps 表失敗（不影響其他功能）：", e.message);
}

// ------------------------------------------------------
// 取得單一路燈
// ------------------------------------------------------
// 從合併後的 lamps_full 讀單筆，對應回地圖 app 慣用的英文欄位
// （中文欄 緯度/經度/瓦特數/色溫/詳細位置 → lat/lng/watt/col/address）
// dbFull 未就緒或查無時，退回舊 lamps 表，確保地圖 app 不受影響
// districts 有帶時，只在該縣市的行政區內找，避免路燈/開關箱編號跨縣市撞號查錯筆
function getLampBasic(id, districts) {
  if (!dbFull) return null;
  if (districts && districts.length) {
    const ph = districts.map(() => "?").join(",");
    return dbFull.prepare(
      `SELECT "路燈編號" AS id, "詳細位置" AS address, "緯度" AS lat, "經度" AS lng, "瓦特數" AS watt, "色溫" AS col FROM lamps_full WHERE "路燈編號" = ? AND "行政區" IN (${ph})`
    ).get(id, ...districts);
  }
  return dbFull.prepare(
    'SELECT "路燈編號" AS id, "詳細位置" AS address, "緯度" AS lat, "經度" AS lng, "瓦特數" AS watt, "色溫" AS col FROM lamps_full WHERE "路燈編號" = ?'
  ).get(id);
}

// 桃園/楊梅/蘆竹 vs 新北 部分行政區編號會重複（例如開關箱編號），
// 依地圖頁面的 mode 限定查詢範圍，避免撞號查到另一個縣市的資料
const MODE_DISTRICTS = {
  luzhu:   ["桃園區", "楊梅區", "蘆竹區", "觀音區"],
  yangmei: ["桃園區", "楊梅區", "蘆竹區", "觀音區"],
  paiwai:  ["桃園區", "楊梅區", "蘆竹區", "觀音區"],
  xinbei:  ["三重區", "五股區", "汐止區", "深坑區", "石碇區"],
};

app.get("/lamp/:id", (req, res) => {
  let id = req.params.id.trim();
  id = decodeURIComponent(id);

  // 台北市：獨立資料庫，欄位與桃園/新北不同（點位系統編號 / 燈牌號碼 查詢）
  // 燈牌號碼可能重複（沿用舊號碼／不同公園各自編號撞號），有多筆符合時列出候選讓前端顯示選單
  if (req.query.area === "taipei") {
    const candidates = getTaipeiLampCandidates(id);
    if (candidates.length === 0) return res.status(404).json({ error: "查無此路燈編號" });
    if (candidates.length > 1) return res.json({ candidates });
    const lamp = candidates[0];
    return res.json({
      ...lamp,
      nav: `https://www.google.com/maps/dir/?api=1&destination=${lamp.lat},${lamp.lng}`
    });
  }

  const lamp = getLampBasic(id, MODE_DISTRICTS[req.query.mode]);

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

  if (!dbFull) return res.status(503).json({ error: "資料庫尚未就緒，請稍後再試" });
  const lamps = dbFull.prepare('SELECT "路燈編號" AS id, "緯度" AS lat, "經度" AS lng FROM lamps_full').all();

  let nearest = null;
  let minDist = Infinity;

  for (const lamp of lamps) {
    const lampLat = Number(lamp.lat); // 緯度
    const lampLng = Number(lamp.lng); // 經度
    if (!lampLat || !lampLng || isNaN(lampLat) || isNaN(lampLng)) continue; // 略過無座標的點

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
  const isTaipei = req.params.area === "taipei";

  const tasks = db.prepare(`
    SELECT task_id AS id, is_custom, label, added_at, priority, color, lat, lng
    FROM tasks
    WHERE area = ?
    ORDER BY priority DESC, added_at DESC
  `).all(req.params.area);

  const lampIds = tasks.filter(t => !t.is_custom).map(t => t.id);
  const lampMap = {};

  if (isTaipei) {
    // 台北市：task_id 一律是「點位系統編號」（新增時已解析過，見 POST /tasks/:area），
    // 只用點位系統編號比對，不再比對燈牌號碼——避免燈牌號碼重複時（見下方新增邏輯的說明）
    // 兩筆不同地點的路燈互相蓋掉彼此的座標
    if (lampIds.length && dbFull) {
      const ph = lampIds.map(() => "?").join(",");
      let list = [];
      try {
        list = dbFull.prepare(
          `SELECT * FROM taipei_lamps WHERE "點位系統編號" IN (${ph})`
        ).all(...lampIds);
      } catch (e) { list = []; } // taipei_lamps 尚未匯入
      for (const r of list) {
        lampMap[r["點位系統編號"]] = {
          address: r["地點"], lat: r["緯度"], lng: r["經度"],
          district: r["行政區"], village: r["里"], squad: r["分隊"],
          zone_code: r["管區代碼"], loc_type: r["位置屬性"], pole_height: r["材料名稱"],
          tag_id: r["燈牌號碼"] || null,
        };
      }
    }
  } else if (lampIds.length && dbFull) {
    // 非自訂點：批次向合併庫（lamps_full，退回舊 lamps）查座標/地址/瓦數/色溫，程式端 join
    const ph = lampIds.map(() => "?").join(",");
    const list = dbFull.prepare(`SELECT "路燈編號" AS id, "詳細位置" AS address, "緯度" AS lat, "經度" AS lng, "瓦特數" AS watt, "色溫" AS col FROM lamps_full WHERE "路燈編號" IN (${ph})`).all(...lampIds);
    for (const r of list) lampMap[r.id] = r;
  }

  const rows = tasks.map(t => {
    const l = t.is_custom ? null : lampMap[t.id];
    const base = {
      id: t.id, is_custom: t.is_custom, label: t.label,
      added_at: t.added_at, priority: t.priority, color: t.color,
      lat: t.lat ?? (l ? l.lat : null),
      lng: t.lng ?? (l ? l.lng : null),
      address: t.label ?? (l ? l.address : null),
    };
    if (isTaipei) {
      return {
        ...base,
        point_id: t.id,               // task_id 一律是點位系統編號
        tag_id: l ? l.tag_id : null,  // 燈牌號碼（可能還沒建置）
        district: l ? l.district : null,
        village: l ? l.village : null,
        squad: l ? l.squad : null,
        zone_code: l ? l.zone_code : null,
        loc_type: l ? l.loc_type : null,
        pole_height: l ? l.pole_height : null,
      };
    }
    return { ...base, watt: l ? l.watt : null, col: l ? l.col : null };
  });
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

  const isTaipei = req.params.area === "taipei";
  const insert = db.prepare("INSERT OR IGNORE INTO tasks (area, task_id) VALUES (?, ?)");
  const results = { ok: 0, notFound: [] };

  if (isTaipei) {
    if (!dbFull) return res.status(503).json({ error: "資料庫尚未就緒，請稍後再試" });
    // task_id 一律存「點位系統編號」（唯一），輸入可以是點位系統編號或燈牌號碼；
    // 燈牌號碼偶爾重複（舊點位刪除後號碼被沿用、不同公園各自編號撞號），
    // 撞到多筆就不自動選，回報在 ambiguous 讓使用者改用搜尋框挑選要加的那一筆
    const ambiguous = []; // [{ key, count }]
    const run = db.transaction(() => {
      for (const lampId of list) {
        const key = String(lampId).trim();
        const candidates = getTaipeiLampCandidates(key);
        if (candidates.length === 0) { results.notFound.push(lampId); continue; }
        if (candidates.length > 1) { ambiguous.push({ key: lampId, count: candidates.length }); continue; }
        insert.run(req.params.area, candidates[0].point_id);
        results.ok++;
      }
    });
    run();
    return res.json({ ok: true, added: results.ok, notFound: results.notFound, ambiguous });
  }

  if (!dbFull) return res.status(503).json({ error: "資料庫尚未就緒，請稍後再試" });
  const existsInFull = dbFull.prepare('SELECT 1 FROM lamps_full WHERE "路燈編號" = ?');
  const run = db.transaction(() => {
    for (const lampId of list) {
      const key = lampId.trim();
      const found = existsInFull.get(key);
      if (!found) { results.notFound.push(lampId); continue; }
      insert.run(req.params.area, key);
      results.ok++;
    }
  });
  run();
  res.json({ ok: true, added: results.ok, notFound: results.notFound });
});

// 地址定位（Google Maps Geocoding API）
// Google Geocoding：主要來源（需 GOOGLE_MAPS_KEY 且該專案已開通計費）
function geocodeGoogle(address) {
  return new Promise((resolve) => {
    const key = process.env.GOOGLE_MAPS_KEY;
    if (!key) return resolve({ _error: "NO_KEY", _msg: "未設定 GOOGLE_MAPS_KEY" });
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

// OpenStreetMap Nominatim：備援來源（免金鑰）
// Google 金鑰失效／未開通計費時仍能定位中文地址，避免「地址定位也失敗」
function geocodeNominatim(address) {
  return new Promise((resolve) => {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=tw&accept-language=zh-TW&q=${encodeURIComponent(address)}`;
    https.get(url, { headers: { "User-Agent": "lamp-api/1.0 (azzo133456@gmail.com)" } }, (r) => {
      let data = "";
      r.on("data", c => data += c);
      r.on("end", () => {
        try {
          const arr = JSON.parse(data);
          if (Array.isArray(arr) && arr[0]) {
            resolve({ lat: Number(arr[0].lat), lng: Number(arr[0].lon), source: "osm" });
          } else {
            resolve(null);
          }
        } catch (e) { console.error("[geocode] nominatim parse error", e); resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

// 先問 Google，失敗（含 REQUEST_DENIED／OVER_QUERY_LIMIT）再退回 Nominatim
async function geocode(address) {
  const g = await geocodeGoogle(address);
  if (g && g.lat != null) return g;
  const n = await geocodeNominatim(address);
  if (n) return n;
  return g;
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
  if (coords.lat == null) return res.status(502).json({ error: `地址定位失敗（Google：${coords._error}，備援 OSM 也查無結果）`, detail: coords._msg });
  res.json(coords);
});

// ------------------------------------------------------
// 📷 截圖文字辨識（Google Cloud Vision OCR，後端轉發避免 key 外露）
// body: { image: "<base64>" }（不含 data:image/...;base64, 前綴）
// ------------------------------------------------------
app.post("/ocr", (req, res) => {
  const image = req.body?.image;
  if (!image) return res.status(400).json({ error: "缺少 image（base64）" });

  const key = process.env.GOOGLE_MAPS_KEY;
  const payload = JSON.stringify({
    requests: [{
      image: { content: image },
      features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
      imageContext: { languageHints: ["zh-TW"] }
    }]
  });

  const reqVision = https.request(
    `https://vision.googleapis.com/v1/images:annotate?key=${key}`,
    { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
    (r) => {
      let data = "";
      r.on("data", c => data += c);
      r.on("end", () => {
        try {
          const json = JSON.parse(data);
          const result = json.responses?.[0];
          if (result?.error) return res.status(502).json({ error: result.error.message || "Vision API 錯誤" });
          const text = result?.fullTextAnnotation?.text || "";
          res.json({ text });
        } catch (e) {
          res.status(500).json({ error: "解析失敗" });
        }
      });
    }
  );
  reqVision.on("error", () => res.status(500).json({ error: "連線失敗" }));
  reqVision.write(payload);
  reqVision.end();
});

// 新增自訂地點（無路燈編號）；lat/lng 可省略，自動用地址定位
app.post("/tasks/:area/custom", async (req, res) => {
  let { label, lat, lng } = req.body;
  if (!label) return res.status(400).json({ error: "請輸入名稱或地址" });

  // 沒有經緯度 → 用地址定位
  if (!lat || !lng) {
    const coords = await geocode(label);
    if (!coords || coords.lat == null) return res.status(400).json({ error: "地址定位失敗，請手動輸入經緯度" });
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
  const { address, lat, lng, watt, col } = req.body;

  // 主庫為合併後的 lamps_full，編輯寫入中文欄位（只覆蓋有帶值的欄位）
  if (!dbFullWrite) return res.status(503).json({ error: "資料庫尚未就緒，請稍後再試" });
  const cur = dbFullWrite.prepare('SELECT * FROM lamps_full WHERE "路燈編號" = ?').get(id);
  if (!cur) return res.status(404).json({ error: "查無此路燈編號" });
  dbFullWrite.prepare(
    'UPDATE lamps_full SET "詳細位置"=@address, "緯度"=@lat, "經度"=@lng, "瓦特數"=@watt, "色溫"=@col WHERE "路燈編號"=@id'
  ).run({
    id,
    address: address !== undefined ? address    : cur["詳細位置"],
    lat:     lat     !== undefined ? String(lat) : cur["緯度"],
    lng:     lng     !== undefined ? String(lng) : cur["經度"],
    watt:    watt    !== undefined ? String(watt): cur["瓦特數"],
    col:     col     !== undefined ? String(col) : cur["色溫"],
  });
  console.log(`[edit] ${id} updated (lamps_full)`);
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

  const writer = dbFullWrite;
  if (!writer) return res.status(503).json({ error: "資料庫尚未就緒，請稍後再試" });

  try {
    // 英文欄 → 合併庫（lamps_full）中文欄；UPSERT 保留既有詳細欄位，只覆蓋有帶值的基本欄
    const select = writer.prepare('SELECT * FROM lamps_full WHERE "路燈編號" = ?');
    const del    = writer.prepare('DELETE FROM lamps_full WHERE "路燈編號" = @路燈編號');
    const cols   = FULL_COLUMNS.map(c => `"${c}"`).join(", ");
    const ph     = FULL_COLUMNS.map(c => `@${c}`).join(", ");
    const insert = writer.prepare(`INSERT INTO lamps_full (${cols}) VALUES (${ph})`);
    const basicMap = { address: "詳細位置", lat: "緯度", lng: "經度", watt: "瓦特數", col: "色溫" };

    // 同編號但行政區不同 → 判定為跨縣市/跨區撞號，直接跳過不覆蓋
    // （避免像楊梅/蘆竹的開關箱編號被新北市同號資料蓋掉的狀況再發生）
    const conflicts = [];
    const importAll = writer.transaction((rows) => {
      for (const r of rows) {
        const id = String(r.id).trim();
        const existing = select.get(id);
        if (existing && existing["行政區"] && r._area && existing["行政區"] !== r._area) {
          conflicts.push({ id, existing_area: existing["行政區"], incoming_area: r._area });
          continue;
        }
        const final = { 路燈編號: id };
        for (const c of FULL_COLUMNS) {
          if (c === "路燈編號") continue;
          final[c] = existing ? (existing[c] ?? "") : "";
        }
        if (r._area) final["行政區"] = r._area;   // 有解析到行政區就更新
        for (const [eng, zh] of Object.entries(basicMap)) {
          const v = r[eng];
          if (v !== undefined && v !== null && String(v).trim() !== "") final[zh] = String(v).trim();
        }
        del.run(final);
        insert.run(final);
      }
    });

    importAll(mapped);
    const imported = mapped.length - conflicts.length;
    console.log(`[import] upsert ${imported} 筆、跳過撞號 ${conflicts.length} 筆 (lamps_full)`);
    res.json({ ok: true, count: imported, conflicts });
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
// 📥 台北市路燈清冊整批匯入（taipei_lamps，與 lamps_full 共用同一個 db 檔案）
// POST body: { rows: [...], reset: true/false }
// reset=true（每次匯入的第一批）：清空重建；之後幾批 reset=false 只 append
// 前端一次送太多筆容易逾時，可分批呼叫（例如每批 5000 筆）
// ------------------------------------------------------
const TAIPEI_COLUMNS = ["點位系統編號","緯度","經度","行政區","里","分隊","管區代碼","位置屬性","地點","材料名稱","attachedDate","燈牌號碼","標案別"];

app.post("/taipei/import", (req, res) => {
  if (!dbFullWrite) return res.status(503).json({ error: "資料庫尚未就緒，請稍後再試" });

  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const reset = !!req.body?.reset;
  if (rows.length === 0 && !reset) return res.status(400).json({ error: "請提供 rows 陣列" });

  try {
    const colDefs = TAIPEI_COLUMNS.map(c => `"${c}" TEXT`).join(", ");
    dbFullWrite.prepare(`CREATE TABLE IF NOT EXISTS taipei_lamps (${colDefs})`).run();

    if (reset) {
      dbFullWrite.exec("DELETE FROM taipei_lamps");
    }

    if (rows.length) {
      const cols = TAIPEI_COLUMNS.map(c => `"${c}"`).join(", ");
      const placeholders = TAIPEI_COLUMNS.map(c => `@${c}`).join(", ");
      const insert = dbFullWrite.prepare(`INSERT INTO taipei_lamps (${cols}) VALUES (${placeholders})`);
      const insertAll = dbFullWrite.transaction((list) => {
        for (const raw of list) {
          const row = {};
          for (const col of TAIPEI_COLUMNS) {
            const v = raw[col];
            row[col] = (v === undefined || v === null) ? "" : String(v);
          }
          insert.run(row);
        }
      });
      insertAll(rows);
    }

    dbFullWrite.prepare('CREATE INDEX IF NOT EXISTS idx_taipei_point ON taipei_lamps("點位系統編號")').run();
    dbFullWrite.prepare('CREATE INDEX IF NOT EXISTS idx_taipei_tag ON taipei_lamps("燈牌號碼")').run();

    const total = dbFullWrite.prepare("SELECT COUNT(*) c FROM taipei_lamps").get().c;
    console.log(`[taipei/import] ${reset ? "重建並" : ""}匯入 ${rows.length} 筆，目前總筆數 ${total}`);
    res.json({ ok: true, imported: rows.length, total });
  } catch (e) {
    console.error("[taipei/import] 錯誤：", e);
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------------
// 🔌 路燈開關箱查詢（switchboxes，依「開關箱編號」批次查詢）
// POST body: { ids: [...] }
// ------------------------------------------------------
const SB_COLUMNS = ["開關箱編號","行政區","詳細位置","經度","緯度","計畫類別","計畫名稱","主要廠商","開關箱型式","是否啟用"];

app.post("/switchboxes/batch", (req, res) => {
  if (!dbSb) return res.status(503).json({ error: "開關箱資料庫尚未就緒，請稍後再試" });

  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).map(s => s.trim()).filter(Boolean) : [];
  if (ids.length === 0) return res.status(400).json({ error: "請提供 ids 陣列" });

  const placeholders = ids.map(() => "?").join(",");
  const rows = dbSb.prepare(`SELECT * FROM switchboxes WHERE "開關箱編號" IN (${placeholders})`).all(...ids);

  const found = new Set(rows.map(r => r["開關箱編號"]));
  const not_found = ids.filter(id => !found.has(id));

  res.json({ count: rows.length, results: rows, not_found });
});

// ------------------------------------------------------
// 📥 匯入 Excel 更新開關箱清冊（UPSERT，依「開關箱編號」新增或更新）
// POST body: { rows: [ { 開關箱編號, 行政區, ... }, ... ] }
// 規則：Excel 中有填值的欄位才覆蓋，留白欄位保留原值（新增者留白存為空字串）
// 註：Render 磁碟可能非永久，此匯入為即時更新；長久保存請重建 db 並 commit 至 GitHub
// ------------------------------------------------------
app.post("/switchboxes/import", (req, res) => {
  if (!dbSbWrite) return res.status(503).json({ error: "開關箱資料庫尚未就緒，請稍後再試" });

  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (rows.length === 0) return res.status(400).json({ error: "請提供 rows 陣列" });

  dbSbWrite.prepare(`CREATE TABLE IF NOT EXISTS switchboxes (${SB_COLUMNS.map(c => `"${c}" TEXT`).join(", ")})`).run();

  const mapped = [];
  const skipped = [];
  for (const raw of rows) {
    const id = raw?.["開關箱編號"] != null ? String(raw["開關箱編號"]).trim() : "";
    if (!id) { skipped.push(raw); continue; }
    const row = { 開關箱編號: id };
    for (const col of SB_COLUMNS) {
      if (col === "開關箱編號") continue;
      const v = raw[col];
      const s = (v === undefined || v === null) ? "" : String(v).trim();
      if (s !== "") row[col] = s;
    }
    mapped.push(row);
  }

  if (mapped.length === 0) {
    return res.status(400).json({ error: "資料中找不到「開關箱編號」欄位，請確認 Excel 標題列" });
  }

  try {
    const select = dbSbWrite.prepare('SELECT * FROM switchboxes WHERE "開關箱編號" = ?');
    const del    = dbSbWrite.prepare('DELETE FROM switchboxes WHERE "開關箱編號" = @開關箱編號');
    const cols = SB_COLUMNS.map(c => `"${c}"`).join(", ");
    const placeholders = SB_COLUMNS.map(c => `@${c}`).join(", ");
    const insert = dbSbWrite.prepare(`INSERT INTO switchboxes (${cols}) VALUES (${placeholders})`);

    let added = 0, updated = 0;
    const importAll = dbSbWrite.transaction((list) => {
      for (const r of list) {
        const existing = select.get(r.開關箱編號);
        const final = { 開關箱編號: r.開關箱編號 };
        for (const col of SB_COLUMNS) {
          if (col === "開關箱編號") continue;
          if (col in r) final[col] = r[col];
          else final[col] = existing ? (existing[col] ?? "") : "";
        }
        del.run(final);
        insert.run(final);
        if (existing) updated++; else added++;
      }
    });
    importAll(mapped);

    console.log(`[switchboxes/import] 新增 ${added} 筆、更新 ${updated} 筆，略過 ${skipped.length} 筆`);
    res.json({ ok: true, added, updated, skipped: skipped.length, total: mapped.length });
  } catch (e) {
    console.error("[switchboxes/import] 錯誤：", e);
    res.status(500).json({ error: e.message });
  }
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
// 支援兩種常見的智控總表 MD 表格樣式：
//   1) 標準 Markdown pipe 表格： | ID | controller_id |
//   2) tableConvert.com 的無 pipe 純文字表格（欄名/資料各佔一行，中間用 --- 分隔）
// 兩者都可能只有 controller_id 單一欄（此時 ID 直接沿用 controller_id）。
function parseControllersMd(text) {
  const lines = String(text).split(/\r?\n/);
  const hasPipe = lines.some(l => l.trim().startsWith("|"));
  const rows = [];

  const pickIdCid = (headerCols, cells) => {
    const idIdx = headerCols.indexOf("id");
    const cidIdx = headerCols.findIndex(c => c.includes("controller_id"));
    if (cidIdx === -1) return null;
    const cid = (cells[cidIdx] || "").trim();
    if (!cid) return null;
    const id = idIdx !== -1 ? (cells[idIdx] || "").trim() : cid;
    return { id, cid };
  };

  if (hasPipe) {
    let headerCols = null;
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("|")) continue;
      if (/^\|[\s-]*\|/.test(t)) continue; // 分隔列 |---|---|
      const cells = t.split("|").slice(1, -1).map(c => c.trim());
      if (!headerCols) {
        if (!cells.some(c => /controller_id/i.test(c))) continue; // 還沒找到標題列
        headerCols = cells.map(c => c.toLowerCase());
        continue;
      }
      const r = pickIdCid(headerCols, cells);
      if (r) rows.push(r);
    }
  } else {
    let headerCols = null;
    for (const raw of lines) {
      const t = raw.trim();
      if (!t) continue;
      if (/^-{3,}$/.test(t)) continue; // 分隔列 ---
      if (!headerCols) {
        headerCols = t.split(/\s{2,}|\t/).map(c => c.trim().toLowerCase()).filter(Boolean);
        continue;
      }
      if (headerCols.length <= 1) {
        if (headerCols[0] && !headerCols[0].includes("controller_id")) continue;
        if (!t) continue;
        rows.push({ id: t, cid: t });
        continue;
      }
      const cells = t.split(/\s{2,}|\t/).map(c => c.trim()).filter(Boolean);
      const r = pickIdCid(headerCols, cells);
      if (r) rows.push(r);
    }
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
// 📅 會勘排程 API（site_visits：日期+時間+地點+備註，與路燈無關）
// ------------------------------------------------------

// 取得台灣當地日期/時間（伺服器可能跑在 UTC，需轉換避免跨日誤判）
function taiwanDateTime(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

// 取得某區會勘排程清單
app.get("/visits/:area", (req, res) => {
  // 只清除「昨天以前」的排程；今天的（不管幾點）保留到隔天才刪
  const { date: today } = taiwanDateTime();
  db.prepare(`
    DELETE FROM site_visits
    WHERE area = ? AND visit_date < ?
  `).run(req.params.area, today);

  const rows = db.prepare(`
    SELECT id, area, label, visit_date, visit_time, note, lat, lng, notified, created_at
    FROM site_visits
    WHERE area = ?
    ORDER BY visit_date ASC, visit_time ASC
  `).all(req.params.area);
  res.json(rows);
});

// 新增會勘排程
app.post("/visits/:area", (req, res) => {
  const { label, visit_date, visit_time, note } = req.body ?? {};
  if (!label || !visit_date) return res.status(400).json({ error: "請輸入地點/標籤與日期" });

  const result = db.prepare(`
    INSERT INTO site_visits (area, label, visit_date, visit_time, note)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.params.area, label, visit_date, visit_time || null, note || null);

  res.json({ ok: true, id: result.lastInsertRowid });
});

// 記住會勘地點的座標（前端定位成功後寫回，避免每次都重打 Geocoding API）
app.patch("/visits/:area/:id/coords", (req, res) => {
  const { lat, lng } = req.body ?? {};
  if (lat == null || lng == null) return res.status(400).json({ error: "缺少 lat / lng" });
  db.prepare("UPDATE site_visits SET lat = ?, lng = ? WHERE area = ? AND id = ?")
    .run(String(lat), String(lng), req.params.area, req.params.id);
  res.json({ ok: true });
});

// 刪除會勘排程
app.delete("/visits/:area/:id", (req, res) => {
  db.prepare("DELETE FROM site_visits WHERE area = ? AND id = ?")
    .run(req.params.area, req.params.id);
  res.json({ ok: true });
});

// ------------------------------------------------------
// 🔔 Web Push 推播
// ------------------------------------------------------
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails("mailto:azzo133456@gmail.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn("[push] 未設定 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY，推播功能將無法使用");
}

// 取得 VAPID 公鑰（前端訂閱用）
app.get("/push/vapid-public-key", (req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(503).json({ error: "伺服器尚未設定推播金鑰" });
  res.json({ key: VAPID_PUBLIC_KEY });
});

// 註冊推播訂閱
app.post("/push/subscribe", (req, res) => {
  const { area, subscription } = req.body ?? {};
  if (!area || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: "缺少 area 或 subscription 資料" });
  }
  db.prepare(`
    INSERT OR REPLACE INTO push_subscriptions (area, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?)
  `).run(area, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth);
  res.json({ ok: true });
});

// 取消推播訂閱
app.post("/push/unsubscribe", (req, res) => {
  const { endpoint } = req.body ?? {};
  if (!endpoint) return res.status(400).json({ error: "缺少 endpoint" });
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  res.json({ ok: true });
});

// 發送推播給某區所有訂閱者
async function sendPushToArea(area, payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return 0;
  const subs = db.prepare("SELECT * FROM push_subscriptions WHERE area = ?").all(area);
  let sent = 0;
  for (const sub of subs) {
    const pushSub = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth }
    };
    try {
      await webpush.sendNotification(pushSub, JSON.stringify(payload));
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(sub.endpoint);
      } else {
        console.error("[push] 發送失敗：", e.message);
      }
    }
  }
  return sent;
}

// ------------------------------------------------------
// ⏰ 排程任務：每 4 小時檢查「未來 24 小時內」的會勘並推播
// ------------------------------------------------------
async function checkAndNotifyVisits() {
  const now  = new Date();
  const { date: today, time: nowTime } = taiwanDateTime(now);
  const { date: tomorrow } = taiwanDateTime(new Date(now.getTime() + 24 * 60 * 60 * 1000));

  // 24 小時的視窗最多只會跨到明天，所以只撈這兩天
  const rows = db.prepare(`
    SELECT * FROM site_visits
    WHERE notified = 0 AND visit_date IN (?, ?)
  `).all(today, tomorrow);

  let notified = 0;
  for (const v of rows) {
    // 沒填時間的當作當天上午 9 點，才能判斷是否落在 24 小時內
    const t = v.visit_time || "09:00";
    const startMin = (v.visit_date === today ? 0 : 24 * 60)
      + Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const nowMin = Number(nowTime.slice(0, 2)) * 60 + Number(nowTime.slice(3, 5));
    const diff = startMin - nowMin;

    if (diff < 0 || diff > 24 * 60) continue;   // 已經過了、或還太遠

    const when = v.visit_date === today ? "今天" : "明天";
    const sent = await sendPushToArea(v.area, {
      title: `${when}有會勘排程`,
      body: `${v.label}${v.visit_time ? `　${v.visit_time}` : ""}${v.note ? `
${v.note}` : ""}`,
      tag: `visit-${v.id}`
    });

    // 一筆都沒推成功就不標記，留待下一輪重試（VAPID 沒設、訂閱暫時失效等）
    if (sent > 0) {
      db.prepare("UPDATE site_visits SET notified = 1 WHERE id = ?").run(v.id);
      notified++;
    } else {
      console.warn(`[visits] id=${v.id} 無成功推播，保留 notified=0 下輪重試`);
    }
  }
  if (notified) console.log(`[visits] 推播 ${notified} 筆 24 小時內的會勘`);
}

// 每 4 小時檢查一次（0、4、8、12、16、20 點，台灣時間）
// 原本只在 16:00 跑且只查「明天」，下午才新增的隔日會勘會整筆漏推
cron.schedule("0 */4 * * *", () => {
  checkAndNotifyVisits().catch(e => console.error("[visits] 推播檢查失敗：", e.message));
}, { timezone: "Asia/Taipei" });

// ------------------------------------------------------
// 啟動伺服器
// ------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
