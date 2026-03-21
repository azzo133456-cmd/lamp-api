import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 建立 express app
const app = express();
app.use(cors());

// 正確定位 lamps.db（不管 Render 跑在哪裡都能找到）
const db = new Database(path.join(__dirname, "lamps.db"));

// API
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
  lat: lamp.lng,   // ← 緯度（24.xxx）
  lng: lamp.lat,   // ← 經度（121.xxx）
  nav: `https://www.google.com/maps/dir/?api=1&destination=${lamp.lng},${lamp.lat}`
});

});

// Render 需要的 port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
