// index.js — WhatsApp + Web Absensi Bot (dengan notifikasi admin)

// ----------------- DEPENDENCIES -----------------
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

// ----------------- CONFIG -----------------
const AUTH_FOLDER = "./auth_info";
const DATA_FILE = "absensi.json";
const PORT = 3000;
const ABSEN_LAT = -8.6366576;
const ABSEN_LON = 116.1480758;
const MAX_RADIUS = 1000; // meter
const ADMIN_NUMBER = "6287763016516"; // nomor admin, tanpa tanda +, tapi dengan kode negara
// --------------------------------------------

// util: baca/tulis data
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE));
  } catch {
    return {};
  }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// util: hitung jarak (Haversine) -> meter
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// util: ambil IP lokal
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "localhost";
}

// buat folder auth
if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

// ----------------- START BOT -----------------
async function startBot() {
  console.log("🔁 Memulai WhatsApp bot...");

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const sock = makeWASocket({ auth: state });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("📌 Scan QR berikut:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      console.log("✅ Bot sudah terhubung ke WhatsApp!");
    }
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;
      console.log("❌ Koneksi tertutup. Reconnect?", shouldReconnect);
      if (shouldReconnect) startBot();
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // handle pesan
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg.message) return;
      const from = msg.key.remoteJid;
      const senderId = from.endsWith("@g.us") ? msg.key.participant : from;

      console.log(`Pesan dari: ${senderId} — ${msg.pushName}`);

      const data = loadData();
      const today = new Date().toISOString().slice(0, 10);
      if (!data[today]) data[today] = [];

      // lokasi
      if (msg.message.locationMessage) {
        const { degreesLatitude, degreesLongitude } =
          msg.message.locationMessage;
        const distance = Math.round(
          haversineMeters(
            degreesLatitude,
            degreesLongitude,
            ABSEN_LAT,
            ABSEN_LON
          )
        );
        const time = new Date().toLocaleString("id-ID", {
          timeZone: "Asia/Makassar",
        });

        if (distance <= MAX_RADIUS) {
          data[today].push({
            method: "location",
            who: senderId,
            name: msg.pushName || senderId,
            time,
            latitude: degreesLatitude,
            longitude: degreesLongitude,
            distance,
          });
          saveData(data);
          await sock.sendMessage(from, {
            text: `✅ Absensi sukses (${msg.pushName}). Jarak ${distance} m.`,
          });

          // notifikasi admin
          await sock.sendMessage(`${ADMIN_NUMBER}@s.whatsapp.net`, {
            text: `📢 Notifikasi Absensi\nNama: ${msg.pushName}\nWaktu: ${time}\nJarak: ${distance} m\nMetode: Share Location`,
          });
        } else {
          await sock.sendMessage(from, {
            text: `❌ Di luar radius (${distance} m). Absensi dibatalkan.`,
          });
        }
        return;
      }

      // teks
      const text = (
        msg.message.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        ""
      )
        .trim()
        .toLowerCase();

      if (!text) return;

      if (text === "!absen" || text === "!hadir") {
        const already = data[today].some((x) => x.who === senderId);
        const time = new Date().toLocaleString("id-ID", {
          timeZone: "Asia/Makassar",
        });

        if (already) {
          await sock.sendMessage(from, {
            text: "⚠️ Kamu sudah tercatat hadir hari ini.",
          });
        } else {
          data[today].push({
            method: "command",
            who: senderId,
            name: msg.pushName || senderId,
            time,
            latitude: null,
            longitude: null,
            distance: null,
          });
          saveData(data);
          await sock.sendMessage(from, {
            text: `✅ Terima kasih ${msg.pushName}, kehadiranmu dicatat.`,
          });

          // notifikasi admin
          await sock.sendMessage(`${ADMIN_NUMBER}@s.whatsapp.net`, {
            text: `📢 Notifikasi Absensi\nNama: ${msg.pushName}\nWaktu: ${time}\nMetode: Perintah !absen`,
          });
        }
        return;
      }

      if (text === "!listabsen") {
        const list = data[today] || [];
        if (!list.length) {
          await sock.sendMessage(from, {
            text: "📋 Belum ada yang absen hari ini.",
          });
        } else {
          const textList = list
            .map(
              (x, i) =>
                `${i + 1}. ${x.name} — ${x.time} — ${x.method}${
                  x.distance ? ` — ${x.distance} m` : ""
                }`
            )
            .join("\n");
          await sock.sendMessage(from, {
            text: `📋 Daftar hadir ${today}:\n` + textList,
          });
        }
        return;
      }
    } catch (e) {
      console.error("Error saat memproses pesan:", e);
    }
  });
}

// ----------------- WEB SERVER -----------------
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/", (req, res) => {
  const ip = getLocalIP();
  res.send(`
    <html>
    <head>
      <title>Absensi Bot — Realtime</title>
      <style>
        body { font-family: Arial, sans-serif; background: #f4f6f8; color: #333; padding: 20px; }
        h2 { color: #2c3e50; }
        a { color: #3498db; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .card { background: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 2px 6px rgba(0,0,0,0.1); }
        .links { margin-top: 10px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>Absensi Bot — Realtime</h2>
        <p>✅ Bot WhatsApp & Web berjalan.</p>
        <div class="links">
          <p>Lihat data: <a href="/today">📅 Hari Ini</a> | <a href="/all">📜 Semua</a></p>
          <p>Alamat LAN: <strong>http://${ip}:${PORT}</strong></p>
        </div>
      </div>
    </body>
    </html>
  `);
});

app.get("/today", (req, res) => {
  const data = loadData();
  const today = new Date().toISOString().slice(0, 10);
  const list = data[today] || [];
  res.send(`
    <html>
    <head>
      <title>Daftar Hadir ${today}</title>
      <style>
        body { font-family: Arial, sans-serif; background: #f4f6f8; color: #333; padding: 20px; }
        h2 { color: #2c3e50; }
        a { color: #3498db; text-decoration: none; }
        a:hover { text-decoration: underline; }
        table { border-collapse: collapse; width: 100%; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 6px rgba(0,0,0,0.1); }
        th, td { padding: 10px 15px; border-bottom: 1px solid #ddd; text-align: left; }
        th { background: #3498db; color: white; }
        tr:hover { background-color: #f1f1f1; }
      </style>
    </head>
    <body>
      <h2>📅 Daftar Hadir — ${today}</h2>
      <p><a href="/">⬅ Kembali</a></p>
      ${
        list.length
          ? `<table>
              <tr>
                <th>No</th><th>Nama</th><th>Waktu</th><th>Metode</th><th>Lat</th><th>Lon</th><th>Jarak</th>
              </tr>
              ${list
                .map(
                  (x, i) => `<tr>
                    <td>${i + 1}</td>
                    <td>${x.name}</td>
                    <td>${x.time}</td>
                    <td>${x.method}</td>
                    <td>${x.latitude ?? ""}</td>
                    <td>${x.longitude ?? ""}</td>
                    <td>${x.distance ? `${x.distance} m` : ""}</td>
                  </tr>`
                )
                .join("")}
            </table>`
          : "<p>Belum ada yang absen hari ini.</p>"
      }
    </body>
    </html>
  `);
});

app.get("/all", (req, res) => {
  const data = loadData();
  let html = '<h2>Semua Rekap</h2><a href="/">Kembali</a>';
  for (const day of Object.keys(data).sort().reverse()) {
    html += `<h3>${day}</h3><table border="1" cellpadding="6"><tr><th>No</th><th>Nama</th><th>Waktu</th><th>Metode</th><th>Lat</th><th>Lon</th><th>Jarak</th></tr>`;
    html += data[day]
      .map(
        (x, i) => `<tr>
      <td>${i + 1}</td><td>${x.name}</td><td>${x.time}</td><td>${
          x.method
        }</td><td>${x.latitude ?? ""}</td><td>${x.longitude ?? ""}</td><td>${
          x.distance ?? ""
        }</td>
    </tr>`
      )
      .join("");
    html += `</table>`;
  }
  res.send(html);
});

app.post("/api/absen", (req, res) => {
  const { name, latitude, longitude } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const data = loadData();
  const today = new Date().toISOString().slice(0, 10);
  if (!data[today]) data[today] = [];
  const time = new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Makassar",
  });
  let distance = null;
  if (latitude && longitude)
    distance = Math.round(
      haversineMeters(latitude, longitude, ABSEN_LAT, ABSEN_LON)
    );
  data[today].push({
    method: "web",
    who: "web",
    name,
    time,
    latitude,
    longitude,
    distance,
  });
  saveData(data);
  res.json({ ok: true });
});

// start server + bot
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`🌐 Web tersedia di: http://${getLocalIP()}:${PORT}`);
  startBot().catch((e) => console.error("Gagal start bot:", e));
});
