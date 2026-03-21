import express from "express";
import cors from "cors";
import Database from "better-sqlite3";

const db = new Database("./lamps.db");

app.get("/lamp/:id", (req, res) => {
  const id = req.params.id;

  const lamp = db.prepare("SELECT * FROM lamps WHERE id = ?").get(id);

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
