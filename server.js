import express from "express";
import cors from "cors";
import fs from "fs";

const app = express();
app.use(cors());

// 讀取 JSON 檔案
const lamps = JSON.parse(fs.readFileSync("./lamps.json", "utf8"));

app.get("/lamp/:id", (req, res) => {
  const id = req.params.id;
  const lamp = lamps.find(l => l["路燈編號"] === id);

  if (!lamp) return res.status(404).json({ error: "查無此路燈編號" });

  res.json({
    id: lamp["路燈編號"],
    address: lamp["詳細位置"],
    lat: lamp["緯度"],
    lng: lamp["經度"],
    nav: `https://www.google.com/maps/dir/?api=1&destination=${lamp["緯度"]},${lamp["經度"]}`
  });
});

// Render 會提供 PORT，不能寫死 3000
app.listen(process.env.PORT || 3000, () =>
  console.log("API running")
);
