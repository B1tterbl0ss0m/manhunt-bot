import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import admin from "firebase-admin";

// --- FIREBASE INIT ---
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://manhunt-e6f98-default-rtdb.europe-west1.firebasedatabase.app"
});

const db = admin.database();

// --- EXPRESS SETUP ---
const app = express();
app.use(bodyParser.json());

// Store latest locations in memory
const latestLocations = {}; 
// Structure: { runnerId: { lat, lng, timestamp, eventId } }

// --- TELEGRAM WEBHOOK ---
app.post("/webhook", async (req, res) => {
  const update = req.body;

  // 1. Handle /start <runnerId>
  if (update.message?.text?.startsWith("/start")) {
    const chatId = update.message.chat.id;
    const parts = update.message.text.split(" ");

    if (parts.length < 2) {
      await sendMessage(chatId, "Usage: /start <runnerId>?event=<eventId>");
      return res.sendStatus(200);
    }

    const runnerParam = parts[1];
    const [runnerId, eventId] = runnerParam.split("?event=");

    latestLocations[runnerId] = { eventId, lat: null, lng: null, timestamp: null };

    await sendMessage(chatId, `Runner registered: ${runnerId}\nEvent: ${eventId}\nNow share your LIVE location.`);
    return res.sendStatus(200);
  }

  // 2. Handle live location updates
  const loc = update.message?.location;
  if (loc) {
    const chatId = update.message.chat.id;

    // We need to know which runner this chat belongs to
    const runnerId = Object.keys(latestLocations).find(
      id => latestLocations[id].chatId === chatId
    );

    // If first time seeing this chat, assign it
    if (!runnerId) {
      // Not ideal, but fallback: treat chatId as runnerId
      latestLocations[chatId] = {
        chatId,
        eventId: "defaultEvent",
        lat: loc.latitude,
        lng: loc.longitude,
        timestamp: Date.now()
      };
    } else {
      latestLocations[runnerId].lat = loc.latitude;
      latestLocations[runnerId].lng = loc.longitude;
      latestLocations[runnerId].timestamp = Date.now();
    }

    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

// --- SEND MESSAGE HELPER ---
async function sendMessage(chatId, text) {
  const token = process.env.BOT_TOKEN;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

// --- SYNCED PUSH LOOP ---
function scheduleSyncedPush() {
  const now = new Date();
  const m = now.getMinutes();
  const s = now.getSeconds();
  const ms = now.getMilliseconds();

  let nextMinute;
  if (m < 20) nextMinute = 20;
  else if (m < 40) nextMinute = 40;
  else nextMinute = 60;

  const msUntil =
    (nextMinute - m) * 60000 -
    s * 1000 -
    ms;

  console.log("Next sync in", msUntil / 1000, "seconds");

  setTimeout(() => {
    pushAllLocations();
    setInterval(pushAllLocations, 20 * 60 * 1000);
  }, msUntil);
}

async function pushAllLocations() {
  console.log("Pushing synced locations…");

  for (const runnerId in latestLocations) {
    const data = latestLocations[runnerId];
    if (!data.lat || !data.lng) continue;

    const eventId = data.eventId || "defaultEvent";

    const payload = {
      lat: data.lat,
      lng: data.lng,
      timestamp: Date.now()
    };

    // Write latest
    await db.ref(`events/${eventId}/runners/${runnerId}/latest`).set(payload);

    // Append to history
    await db.ref(`events/${eventId}/runners/${runnerId}/history`).push(payload);
  }
}

// Start the synced scheduler
scheduleSyncedPush();

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Bot backend running on port", PORT));

