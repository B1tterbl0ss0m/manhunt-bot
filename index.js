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
// Structure: { runnerId: { chatId, eventId, lat, lng, timestamp, hasPushedOnce, liveMode } }
const latestLocations = {};


// ---------------------------------------------------------
// TELEGRAM WEBHOOK HANDLER
// ---------------------------------------------------------
app.post("/webhook", async (req, res) => {
  const update = req.body;

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
      timestamp: null,
      hasPushedOnce: false,
      liveMode: false
    };

    console.log(`Registered runner ${runnerId} for event ${eventId}`);

    await sendMessage(
      chatId,
      `Runner registered: ${runnerId}\nEvent: ${eventId}\nNow share your LIVE location.`
    );

    return res.sendStatus(200);
  }

  // -----------------------------------------------------
  // 2. Handle /live (enable real-time mode)
  // -----------------------------------------------------
  if (update.message?.text === "/live") {
    const chatId = update.message.chat.id;

    const runnerId = Object.keys(latestLocations).find(
      id => latestLocations[id].chatId === chatId
    );

    if (!runnerId) {
      await sendMessage(chatId, "You are not registered. Use /start first.");
      return res.sendStatus(200);
    }

    latestLocations[runnerId].liveMode = true;

    await db.ref(`events/${latestLocations[runnerId].eventId}/runners/${runnerId}`)
      .update({ liveMode: true });

    await sendMessage(chatId, "Live mode enabled — your location will update in real time.");

    return res.sendStatus(200);
  }

  // -----------------------------------------------------
  // 3. Handle /end (disable real-time mode)
  // -----------------------------------------------------
  if (update.message?.text === "/end") {
    const chatId = update.message.chat.id;

    const runnerId = Object.keys(latestLocations).find(
      id => latestLocations[id].chatId === chatId
    );

    if (!runnerId) {
      await sendMessage(chatId, "You are not registered. Use /start first.");
      return res.sendStatus(200);
    }

    latestLocations[runnerId].liveMode = false;

    await db.ref(`events/${latestLocations[runnerId].eventId}/runners/${runnerId}`)
      .update({ liveMode: false });

    await sendMessage(chatId, "Live mode disabled — returning to normal update intervals.");

    return res.sendStatus(200);
  }

  // -----------------------------------------------------
  // 4. Handle live location updates (message or edited_message)
  // -----------------------------------------------------
  const loc =
    update.message?.location ||
    update.edited_message?.location;

  if (loc) {
    const chatId =
      update.message?.chat?.id ||
      update.edited_message?.chat?.id;

    const runnerId = Object.keys(latestLocations).find(
      id => latestLocations[id].chatId === chatId
    );

    if (!runnerId) {
      console.log("Received location but no runner matched this chatId:", chatId);
      return res.sendStatus(200);
    }

    const runner = latestLocations[runnerId];

    runner.lat = loc.latitude;
    runner.lng = loc.longitude;
    runner.timestamp = Date.now();

    console.log(`Updated location for ${runnerId}:`, runner);

    // -------------------------------------------------
    // IMMEDIATE FIRST WRITE
    // -------------------------------------------------
    if (!runner.hasPushedOnce) {
      console.log(`Immediate first push for ${runnerId}`);
      await writeToFirebase(runnerId, runner);
      runner.hasPushedOnce = true;
      return res.sendStatus(200);
    }

    // -------------------------------------------------
    // REAL-TIME MODE: write every update
    // -------------------------------------------------
    if (runner.liveMode) {
      console.log(`Real-time push for ${runnerId}`);
      await writeToFirebase(runnerId, runner);
      return res.sendStatus(200);
    }

    // Normal mode → store in memory only
    return res.sendStatus(200);
  }

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
// FIREBASE WRITE HELPER
// ---------------------------------------------------------
async function writeToFirebase(runnerId, data) {
  const eventId = data.eventId || "defaultEvent";

  const payload = {
    lat: data.lat,
    lng: data.lng,
    timestamp: Date.now()
  };

  try {
    await db.ref(`events/${eventId}/runners/${runnerId}/latest`).set(payload);
    await db.ref(`events/${eventId}/runners/${runnerId}/history`).push(payload);
  } catch (err) {
    console.error("Firebase write error:", err);
  }
}


// ---------------------------------------------------------
// SYNCED PUSH LOOP — EVERY 1 MINUTE
// ---------------------------------------------------------
function scheduleSyncedPush() {
  const now = new Date();
  const s = now.getSeconds();
  const ms = now.getMilliseconds();

  const msUntil = (60 - s) * 1000 - ms;

  console.log("Next sync in", msUntil / 1000, "seconds");

  setTimeout(() => {
    pushAllLocations();
    setInterval(pushAllLocations, 60 * 1000);
  }, msUntil);
}

async function pushAllLocations() {
  console.log("Pushing synced locations…");

  for (const runnerId in latestLocations) {
    const data = latestLocations[runnerId];

    if (!data.lat || !data.lng) continue;
    if (data.liveMode) continue; // real-time mode handles itself

    console.log(`Interval push for ${runnerId}`);
    await writeToFirebase(runnerId, data);
  }
}

scheduleSyncedPush();


// ---------------------------------------------------------
// START SERVER
// ---------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Bot backend running on port", PORT));
