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
// 🔥 GitHub RAW lamps.db（Railway 啟動時自動下載）
// ------------------------------------------------------
const DB_URL = "https://raw.githubusercontent.com/azzo133456-cmd/lamp-api/main/data/lamps.db";
const LOCAL_DB = path.join(__dirname, "lamps.db");

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

// 🚀 啟動伺服器前下載資料庫
await downloadDB();

// ------------------------------------------------------
// 建立 express app
// ------------------------------------------------------
const app = express();
app.use(cors());

// 正確定位 lamps.db
const db = new Database(LOCAL_DB);

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
// 啟動伺服器
// ------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
