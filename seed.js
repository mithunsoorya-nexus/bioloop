const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const { db } = require("./db");
const { CATS, SURP, FD } = require("./constants");

const UPLOADS = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");

function wipe() {
  for (const t of ["orders", "compost", "produce", "listings", "producers", "users"]) db.prepare(`DELETE FROM ${t}`).run();
  if (fs.existsSync(UPLOADS)) for (const f of fs.readdirSync(UPLOADS)) if (f !== ".gitkeep") fs.rmSync(path.join(UPLOADS, f), { force: true });
}

function seedDemo() {
  const now = Date.now();
  const hash = bcrypt.hashSync("demo123", 10);
  const run = db.transaction(() => {
    wipe();
    const U = [
      ["R1", "restaurant", "Green Leaf Restaurant", "restaurant"],
      ["R2", "restaurant", "Fresh Bowl Kitchen", "restaurant2"],
      ["R3", "restaurant", "Urban Garden Cafe", "restaurant3"],
      ["P1", "biogas", "Green Energy Plant", "biogas"],
      ["P2", "biogas", "EcoFuel Solutions", "biogas2"],
      ["P3", "compost", "NatureGrow Compost", "compost"],
      ["P4", "compost", "BioRich Organics", "compost2"],
      ["F1", "farmer", "Kumar Organic Farm", "farmer"],
      ["F2", "farmer", "Green Valley Farms", "farmer2"],
      ["F3", "farmer", "FreshHarvest Collective", "farmer3"],
    ];
    const iu = db.prepare("INSERT INTO users(id,email,pw_hash,name,role,phone,demo,created) VALUES(?,?,?,?,?,?,1,?)");
    for (const [id, role, name, e] of U) iu.run(id, e + "@bioloop.demo", hash, name, role, null, now);

    const ip = db.prepare("INSERT INTO producers(id,name,type,dist,cap,cats) VALUES(?,?,?,?,?,?)");
    ip.run("P1", "Green Energy Plant", "biogas", 4, 500, JSON.stringify(CATS.slice(0, 3)));
    ip.run("P2", "EcoFuel Solutions", "biogas", 11, 200, JSON.stringify([CATS[2], CATS[3]]));
    ip.run("P3", "NatureGrow Compost", "compost", 6, 300, JSON.stringify([CATS[0], CATS[1], CATS[3]]));
    ip.run("P4", "BioRich Organics", "compost", 15, 100, JSON.stringify([CATS[0]]));

    const il = db.prepare("INSERT INTO listings(id,rid,rn,type,cat,kg,loc,time_txt,stage,demo,created) VALUES(?,?,?,?,?,?,?,?,0,1,?)");
    il.run("WP-1001", "R1", "Green Leaf Restaurant", "waste", CATS[0], 25, "Adyar, Chennai", "Tomorrow 8 am", now - 3);
    il.run("WP-1002", "R2", "Fresh Bowl Kitchen", "waste", CATS[1], 15, "T Nagar, Chennai", "Today 6 pm", now - 2);
    il.run("SF-2001", "R3", "Urban Garden Cafe", "surplus", SURP[0], 10, "Velachery, Chennai", "Today 9 pm", now - 1);

    const ic = db.prepare("INSERT INTO compost(id,pid,name,kg,price,doc,demo,created) VALUES(?,?,?,?,?,?,1,?)");
    ic.run("C1", "P3", "NatureGrow Compost", 100, 12, 0, now - 1);
    ic.run("C2", "P4", "BioRich Organics", 60, 15, 1, now - 2);

    const ipr = db.prepare("INSERT INTO produce(id,fid,fn,crop,kg,price,harvest,loc,dist,status,demo,created) VALUES(?,?,?,?,?,?,?,?,?,'Available',1,?)");
    ipr.run("A1", "F1", "Kumar Organic Farm", "Tomatoes", 50, 32, "Yesterday", "Chengalpattu", FD.Chengalpattu, now - 1);
    ipr.run("A2", "F2", "Green Valley Farms", "Spinach", 30, 40, "Today", "Kanchipuram", FD.Kanchipuram, now - 2);
    ipr.run("A3", "F3", "FreshHarvest Collective", "Bananas", 80, 28, "2 days ago", "Thiruvallur", FD.Thiruvallur, now - 3);
  });
  run();
}

module.exports = { seedDemo };
