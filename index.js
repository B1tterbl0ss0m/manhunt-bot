import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import admin from "firebase-admin";

// ---------------------------------------------------------
// FIREBASE INITIALIZATION
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

// Memory store:
// runnerId: { chatId, eventId, lat, lng, timestamp, hasPushedOnce, liveMode }
// hunterId: { chatId, eventId, lat, lng, timestamp }
const runners = {};
const hunters = {};


// ---------------------------------------------------------
// TELEGRAM WEBHOOK HANDLER
// ---------------------------------------------------------
app.post("/webhook", async (req, res) => {
  const update = req.body;

  console.log("Incoming update:", update.update_id);

  // -----------------------------------------------------
  // /start <id>?event=<eventId>
  // -----------------------------------------------------
  if (update.message?.text?.startsWith("/start")) {
    const chatId = update.message.chat.id;
    const parts = update.message.text.split(" ");

    if (parts.length < 2) {
      await sendMessage(chatId, "Usage: /start <id>?event=<eventId>");
      return res.sendStatus(200);
    }

    const param = parts[1];
    const [id, eventId] = param.split("?event=");

    if (id.startsWith("runner")) {
      runners[id] = {
        chatId,
        eventId,
        lat: null,
        lng: null,
        timestamp: null,
        hasPushedOnce: false,
        liveMode: false
      };

      await sendMessage(chatId, `Runner registered: ${id}\nEvent: ${eventId}`);
      return res.sendStatus(200);
    }

    if (id.startsWith("hunter")) {
      hunters[id] = {
        chatId,
        eventId,
        lat: null,
        lng: null,
        timestamp: null
      };

      await sendMessage(chatId, `Hunter registered: ${id}\nEvent: ${eventId}`);
      return res.sendStatus(200);
    }

    await sendMessage(chatId, "ID must start with runnerX or hunterX.");
    return res.sendStatus(200);
  }

  // -----------------------------------------------------
  // /live and /end apply ONLY to runners
  // -----------------------------------------------------
  if (update.message?.text === "/live") {
    const chatId = update.message.chat.id;

    const runnerId = Object.keys(runners).find(
      id => runners[id].chatId === chatId
    );

    if (!runnerId) {
      await sendMessage(chatId, "Only runners can use /live.");
      return res.sendStatus(200);
    }

    runners[runnerId].liveMode = true;

    await db.ref(`events/${runners[runnerId].eventId}/runners/${runnerId}`)
      .update({ liveMode: true });

    await sendMessage(chatId, "Live mode enabled.");
    return res.sendStatus(200);
  }

  if (update.message?.text === "/end") {
    const chatId = update.message.chat.id;

    const runnerId = Object.keys(runners).find(
      id => runners[id].chatId === chatId
    );

    if (!runnerId) {
      await sendMessage(chatId, "Only runners can use /end.");
      return res.sendStatus(200);
    }

    runners[runnerId].liveMode = false;

    await db.ref(`events/${runners[runnerId].eventId}/runners/${runnerId}`)
      .update({ liveMode: false });

    await sendMessage(chatId, "Live mode disabled.");
    return res.sendStatus(200);
  }

  // -----------------------------------------------------
  // Handle live location updates
  // -----------------------------------------------------
  const loc =
    update.message?.location ||
    update.edited_message?.location;

  if (loc) {
    const chatId =
      update.message?.chat?.id ||
      update.edited_message?.chat?.id;

    // ---------------------------
    // Is this a hunter?
    // ---------------------------
    const hunterId = Object.keys(hunters).find(
      id => hunters[id].chatId === chatId
    );

    if (hunterId) {
      const h = hunters[hunterId];
      h.lat = loc.latitude;
      h.lng = loc.longitude;
      h.timestamp = Date.now();

      console.log(`Real-time hunter update: ${hunterId}`);

      await writeHunterLatest(hunterId, h);
      return res.sendStatus(200);
    }

    // ---------------------------
    // Is this a runner?
    // ---------------------------
    const runnerId = Object.keys(runners).find(
      id => runners[id].chatId === chatId
    );

    if (!runnerId) {
      console.log("Location received but no runner/hunter matched.");
      return res.sendStatus(200);
    }

    const r = runners[runnerId];
    r.lat = loc.latitude;
    r.lng = loc.longitude;
    r.timestamp = Date.now();

    // First write
    if (!r.hasPushedOnce) {
      await writeRunnerLatestAndHistory(runnerId, r);
      r.hasPushedOnce = true;
      return res.sendStatus(200);
    }

    // Live mode → latest only
    if (r.liveMode) {
      await writeRunnerLatestOnly(runnerId, r);
      return res.sendStatus(200);
    }

    // Normal mode → store only
    return res.sendStatus(200);
  }

  res.sendStatus(200);
});


// ---------------------------------------------------------
// TELEGRAM SEND MESSAGE
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
    console.error("Telegram error:", err);
  }
}


// ---------------------------------------------------------
// FIREBASE WRITE HELPERS
// ---------------------------------------------------------
function payload(data) {
  return {
    lat: data.lat,
    lng: data.lng,
    timestamp: Date.now() + Math.random()
  };
}

// ------------------ RUNNERS ------------------
async function writeRunnerLatestOnly(id, data) {
  const eventId = data.eventId;
  await db.ref(`events/${eventId}/runners/${id}/latest`).set(payload(data));
}

async function writeRunnerLatestAndHistory(id, data) {
  const eventId = data.eventId;
  const p = payload(data);
  await db.ref(`events/${eventId}/runners/${id}/latest`).set(p);
  await db.ref(`events/${eventId}/runners/${id}/history`).push(p);
}

// ------------------ HUNTERS ------------------
async function writeHunterLatest(id, data) {
  const eventId = data.eventId;
  await db.ref(`events/${eventId}/hunters/${id}/latest`).set(payload(data));
}


// ---------------------------------------------------------
// INTERVAL PUSH (RUNNERS ONLY)
// ---------------------------------------------------------
function scheduleInterval() {
  const now = new Date();
  const msUntil = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();

  setTimeout(() => {
    setInterval(pushInterval, 60000);
    pushInterval();
  }, msUntil);
}

async function pushInterval() {
  console.log("Interval push…");

  for (const id in runners) {
    const r = runners[id];
    if (!r.lat || !r.lng) continue;

    console.log(`Interval write for ${id}`);
    await writeRunnerLatestAndHistory(id, r);
  }
}

scheduleInterval();


// ---------------------------------------------------------
// START SERVER
// ---------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Backend running on", PORT));
