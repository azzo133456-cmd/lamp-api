import express from "express";
import cors from "cors";
import lamps from "./lamps.json" assert { type: "json" };

const app = express();
app.use(cors());

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

app.listen(3000, () => console.log("API running on port 3000"));
