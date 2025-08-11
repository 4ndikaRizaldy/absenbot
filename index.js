// index.js (CommonJS single-file WhatsApp+Web attendance bot)
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const qrcode = require('qrcode-terminal')
const express = require('express')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

// ---------- CONFIG ----------
const AUTH_FOLDER = './auth_info'          // folder sesi WA
const DATA_FILE = 'absensi.json'           // file penyimpanan
const PORT = 3000                          // port web server
const ABSEN_LAT = -8.591758                // titik absensi (ganti)
const ABSEN_LON = 116.248384
const MAX_RADIUS = 100                     // radius (meter), ganti sesuai kebutuhan
// ----------------------------

// util: baca/tulis data
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return {}
  try { return JSON.parse(fs.readFileSync(DATA_FILE)) } catch (e) { return {} }
}
function saveData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)) }

// util: hitung jarak (Haversine) -> meter
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000
  const toRad = v => v * Math.PI / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
  return R * c
}

// local IP (untuk menampilkan link LAN)
function getLocalIP() {
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address
    }
  }
  return 'localhost'
}

// buat folder auth jika belum
if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true })

// ----- START BOT -----
async function startBot() {
  console.log('🔁 Memulai WhatsApp bot...')

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)

  const sock = makeWASocket({
    auth: state,
    // jangan gunakan printQRInTerminal karena deprecated; kita handle qr event
  })

  // show QR when available
  sock.ev.on('connection.update', update => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      console.log('📌 Scan QR berikut lewat WhatsApp (Perangkat tertaut):')
      qrcode.generate(qr, { small: true })
    }
    if (connection === 'open') {
      console.log('✅ Bot sudah terhubung ke WhatsApp!')
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      console.log('❌ Koneksi tertutup. Reconnect?', shouldReconnect)
      if (shouldReconnect) {
        startBot().catch(e => console.error('Gagal restart bot:', e))
      } else {
        console.log('🚫 Sudah logout. Hapus folder auth_info untuk login ulang jika perlu.')
      }
    }
  })

  // simpan cred updates
  sock.ev.on('creds.update', saveCreds)

  // handle messages
  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages[0]
      if (!msg.message) return
      const from = msg.key.remoteJid
      const isGroup = from.endsWith('@g.us')
      // sender id (personal or group)
      const senderId = msg.key.participant ? msg.key.participant : msg.key.remoteJid

      // load data
      const data = loadData()
      const today = new Date().toISOString().slice(0,10) // YYYY-MM-DD
      if (!data[today]) data[today] = []

      // 1) kalau message berupa locationMessage (share location)
      if (msg.message.locationMessage) {
        const { degreesLatitude, degreesLongitude, jpegThumbnail } = msg.message.locationMessage
        const distance = Math.round(haversineMeters(degreesLatitude, degreesLongitude, ABSEN_LAT, ABSEN_LON))
        const time = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Makassar' })

        if (distance <= MAX_RADIUS) {
          // simpan
          data[today].push({
            method: 'location',
            who: senderId,
            name: msg.pushName || senderId,
            time,
            latitude: degreesLatitude,
            longitude: degreesLongitude,
            distance
          })
          saveData(data)
          await sock.sendMessage(from, { text: `✅ Absensi sukses (${msg.pushName || senderId}). Jarak ${distance} m.` })
        } else {
          await sock.sendMessage(from, { text: `❌ Di luar radius (${distance} m). Absensi dibatalkan.` })
        }
        return
      }

      // 2) kalau message teks: handle commands
      const text = (
        msg.message.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        ''
      ).trim()

      if (!text) return

      const cmd = text.toLowerCase()
      // !absen or !hadir => mark hadir tanpa lokasi
      if (cmd === '!absen' || cmd === '!hadir') {
        // cek apakah sudah absen hari ini (cek by who)
        const already = data[today].some(x => x.who === senderId)
        const time = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Makassar' })
        if (already) {
          await sock.sendMessage(from, { text: '⚠️ Kamu sudah tercatat hadir hari ini.' })
        } else {
          data[today].push({
            method: 'command',
            who: senderId,
            name: msg.pushName || senderId,
            time,
            latitude: null,
            longitude: null,
            distance: null
          })
          saveData(data)
          await sock.sendMessage(from, { text: `✅ Terima kasih ${msg.pushName || senderId}, kehadiranmu dicatat (${time}).` })
        }
        return
      }

      // !listabsen -> hanya kirim daftar hari ini (boleh dibatasi agar hanya admin)
      if (cmd === '!listabsen') {
        const list = data[today] || []
        if (list.length === 0) {
          await sock.sendMessage(from, { text: '📋 Belum ada yang absen hari ini.' })
        } else {
          const textList = list.map((x,i)=> `${i+1}. ${x.name || x.who} — ${x.time} — ${x.method}${x.distance ? ` — ${x.distance} m` : ''}`).join('\n')
          await sock.sendMessage(from, { text: `📋 Daftar hadir ${today}:\n` + textList })
        }
        return
      }

      // fallback: ignore
    } catch (e) {
      console.error('Error saat memproses pesan:', e)
    }
  })
}

// ----- WEB (Express) -----
const app = express()
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

// serve static simple UI
app.get('/', (req, res) => {
  const ip = getLocalIP()
  res.send(`
    <h2>Absensi Bot — Realtime</h2>
    <p>Bot WhatsApp & Web berjalan. Akses data di <a href="/today">/today</a> atau <a href="/all">/all</a></p>
    <p>Alamat LAN: http://${ip}:${PORT}</p>
    <hr>
    <p>Petunjuk singkat:</p>
    <ol>
      <li>Di WhatsApp kirim <b>Share Location</b> ke bot, atau ketik <b>!absen</b></li>
      <li>Untuk melihat rekap hari ini buka <a href="/today">/today</a></li>
    </ol>
  `)
})

// page: today
app.get('/today', (req, res) => {
  const data = loadData()
  const today = new Date().toISOString().slice(0,10)
  const list = data[today] || []
  res.send(`
    <h2>Daftar Hadir — ${today}</h2>
    <a href="/">Back</a>
    <table border="1" cellpadding="6">
      <tr><th>No</th><th>Nama</th><th>Waktu</th><th>Metode</th><th>Lat</th><th>Lon</th><th>Jarak(m)</th></tr>
      ${list.map((x,i) => `<tr>
        <td>${i+1}</td>
        <td>${x.name}</td>
        <td>${x.time}</td>
        <td>${x.method}</td>
        <td>${x.latitude ?? ''}</td>
        <td>${x.longitude ?? ''}</td>
        <td>${x.distance ?? ''}</td>
      </tr>`).join('')}
    </table>
  `)
})

// page: all days
app.get('/all', (req, res) => {
  const data = loadData()
  let html = '<h2>Semua Rekap</h2><a href="/">Back</a>'
  for (const day of Object.keys(data).sort().reverse()) {
    html += `<h3>${day}</h3><table border="1" cellpadding="6"><tr><th>No</th><th>Nama</th><th>Waktu</th><th>Metode</th><th>Lat</th><th>Lon</th><th>Jarak</th></tr>`
    html += data[day].map((x,i) => `<tr>
      <td>${i+1}</td><td>${x.name}</td><td>${x.time}</td><td>${x.method}</td><td>${x.latitude ?? ''}</td><td>${x.longitude ?? ''}</td><td>${x.distance ?? ''}</td>
    </tr>`).join('')
    html += `</table>`
  }
  res.send(html)
})

// optional: endpoint untuk trigger absen via web (untuk perangkat yg tidak pakai WA)
app.post('/api/absen', (req, res) => {
  const { name, latitude, longitude } = req.body
  if (!name) return res.status(400).json({ error: 'name required' })
  const data = loadData()
  const today = new Date().toISOString().slice(0,10)
  if (!data[today]) data[today] = []
  const time = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Makassar' })
  let distance = null
  if (latitude && longitude) distance = Math.round(haversineMeters(latitude, longitude, ABSEN_LAT, ABSEN_LON))
  data[today].push({ method: 'web', who: 'web', name, time, latitude, longitude, distance})
  saveData(data)
  res.json({ ok: true })
})

// start server + bot
const server = http.createServer(app)
server.listen(PORT, () => {
  console.log(`🌐 Web tersedia di: http://${getLocalIP()}:${PORT}`)
  // start WA bot after server ready
  startBot().catch(e => console.error('Gagal start bot:', e))
})
