import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const app = express();
app.use(cors());

const db = await open({
  filename: "./lamps.db",
  driver: sqlite3.Database
});

app.get("/lamp/:id", async (req, res) => {
  const id = req.params.id;

  const lamp = await db.get("SELECT * FROM lamps WHERE id = ?", [id]);

  if (!lamp) return res.status(404).json({ error: "查無此路燈編號" });

  res.json({
    id: lamp.id,
    address: lamp.address,
    lat: lamp.lat,
    lng: lamp.lng,
    nav: `https://www.google.com/maps/dir/?api=1&destination=${lamp.lat},${lamp.lng}`
  });
});

app.listen(process.env.PORT || 3000, () => console.log("API running"));
