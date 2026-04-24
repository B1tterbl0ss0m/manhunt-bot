import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import admin from "firebase-admin";

// ---------------------------------------------------------
// FIREBASE INITIALIZATION (Render-compatible)
// ---------------------------------------------------------
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://manhunt-e6f98-default-rtdb.europe-west1.firebasedatabase.app"
});

const db = admin.database();

// ---------------------------------------------------------
// EXPRESS SETUP
// ---------------------------------------------------------
const app = express();
app.use(bodyParser.json());

// Store latest locations in memory
// Structure: { runnerId: { chatId, eventId, lat, lng, timestamp } }
const latestLocations = {};


// ---------------------------------------------------------
// TELEGRAM WEBHOOK HANDLER
// ---------------------------------------------------------
app.post("/webhook", async (req, res) => {
  const update = req.body;

  // Log only update_id to avoid spam
  console.log("Incoming update:", update.update_id);

  // -----------------------------------------------------
  // 1. Handle /start <runnerId>?event=<eventId>
  // -----------------------------------------------------
  if (update.message?.text?.startsWith("/start")) {
    const chatId = update.message.chat.id;
    const parts = update.message.text.split(" ");

    if (parts.length < 2) {
      await sendMessage(chatId, "Usage: /start <runnerId>?event=<eventId>");
      return res.sendStatus(200);
    }

    const runnerParam = parts[1];
    const [runnerId, eventId] = runnerParam.split("?event=");

    latestLocations[runnerId] = {
      chatId,
      eventId,
      lat: null,
      lng: null,
      timestamp: null
    };

    console.log(`Registered runner ${runnerId} for event ${eventId}`);

    await sendMessage(
      chatId,
      `Runner registered: ${runnerId}\nEvent: ${eventId}\nNow share your LIVE location.`
    );

    return res.sendStatus(200);
  }

  // -----------------------------------------------------
  // 2. Handle live location updates (message or edited_message)
  // -----------------------------------------------------
  const loc =
    update.message?.location ||
    update.edited_message?.location;

  if (loc) {
    const chatId =
      update.message?.chat?.id ||
      update.edited_message?.chat?.id;

    // Find runner by chatId
    const runnerId = Object.keys(latestLocations).find(
      id => latestLocations[id].chatId === chatId
    );

    if (!runnerId) {
      console.log("Received location but no runner matched this chatId:", chatId);
      return res.sendStatus(200);
    }

    latestLocations[runnerId].lat = loc.latitude;
    latestLocations[runnerId].lng = loc.longitude;
    latestLocations[runnerId].timestamp = Date.now();

    console.log(`Updated location for ${runnerId}:`, latestLocations[runnerId]);

    return res.sendStatus(200);
  }

  // Default response
  res.sendStatus(200);
});


// ---------------------------------------------------------
// TELEGRAM SEND MESSAGE HELPER
// ---------------------------------------------------------
async function sendMessage(chatId, text) {
  const token = process.env.BOT_TOKEN;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text })
    });
  } catch (err) {
    console.error("Error sending Telegram message:", err);
  }
}


// ---------------------------------------------------------
// SYNCED PUSH LOOP — NOW EVERY 1 MINUTE
// ---------------------------------------------------------
function scheduleSyncedPush() {
  const now = new Date();
  const s = now.getSeconds();
  const ms = now.getMilliseconds();

  // Next minute boundary
  const msUntil = (60 - s) * 1000 - ms;

  console.log("Next sync in", msUntil / 1000, "seconds");

  setTimeout(() => {
    pushAllLocations();
    setInterval(pushAllLocations, 60 * 1000); // every 1 minute
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

    console.log(`Writing to Firebase for ${runnerId}:`, payload);

    try {
      await db.ref(`events/${eventId}/runners/${runnerId}/latest`).set(payload);
      await db.ref(`events/${eventId}/runners/${runnerId}/history`).push(payload);
    } catch (err) {
      console.error("Firebase write error:", err);
    }
  }
}


// Start the synced scheduler
scheduleSyncedPush();


// ---------------------------------------------------------
// START SERVER (Render-compatible)
// ---------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Bot backend running on port", PORT));
