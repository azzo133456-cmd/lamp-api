import express from "express";
import cors from "cors";
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
// 建立 express app
// ------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// 正確定位 lamps.db
const db = new Database(LOCAL_DB);

// tasks 資料表（任務清單，多人共用）
db.prepare(`
  CREATE TABLE IF NOT EXISTS tasks (
    area    TEXT NOT NULL,
    lamp_id TEXT NOT NULL,
    added_at TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (area, lamp_id)
  )
`).run();

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

// 取得某區任務清單（含路燈資料）
app.get("/tasks/:area", (req, res) => {
  const tasks = db.prepare(`
    SELECT t.lamp_id AS id, t.added_at,
           l.address, l.lat, l.lng, l.watt, l.col
    FROM tasks t
    LEFT JOIN lamps l ON l.id = t.lamp_id
    WHERE t.area = ?
    ORDER BY t.added_at DESC
  `).all(req.params.area);
  res.json(tasks);
});

// 新增路燈到任務清單
app.post("/tasks/:area", (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: "缺少 id" });
  const lamp = db.prepare("SELECT id FROM lamps WHERE id = ?").get(id);
  if (!lamp) return res.status(404).json({ error: "查無此路燈編號" });
  db.prepare("INSERT OR IGNORE INTO tasks (area, lamp_id) VALUES (?, ?)").run(req.params.area, id);
  res.json({ ok: true });
});

// 從任務清單移除
app.delete("/tasks/:area/:id", (req, res) => {
  db.prepare("DELETE FROM tasks WHERE area = ? AND lamp_id = ?")
    .run(req.params.area, decodeURIComponent(req.params.id));
  res.json({ ok: true });
});

// ------------------------------------------------------
// ✏️ 單筆修改
// ------------------------------------------------------
app.patch("/lamp/:id", (req, res) => {
  let id = decodeURIComponent(req.params.id.trim());
  const lamp = db.prepare("SELECT * FROM lamps WHERE id = ?").get(id);
  if (!lamp) return res.status(404).json({ error: "查無此路燈編號" });

  const { address, watt, col } = req.body;
  db.prepare(`UPDATE lamps SET address=@address, watt=@watt, col=@col WHERE id=@id`).run({
    id,
    address: address !== undefined ? address : lamp.address,
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
// 啟動伺服器
// ------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
