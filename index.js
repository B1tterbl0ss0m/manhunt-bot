import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import admin from "firebase-admin";

// ---------------------------------------------------------
// CONFIG
// ---------------------------------------------------------
const TEST_MODE = false;

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

// Memory store
const runners = {};
const hunters = {};

// ---------------------------------------------------------
// VALIDATION HELPERS
// ---------------------------------------------------------
function isValidId(id) {
  return typeof id === "string" && id.length > 0 && id !== "null" && id !== "undefined";
}

// ---------------------------------------------------------
// SPEEDHUNT LISTENER
// ---------------------------------------------------------
function attachSpeedhuntListener(eventId, runnerId) {
  if (!isValidId(runnerId)) return;

  const refPath = `events/${eventId}/runners/${runnerId}/speedhuntPing`;

  db.ref(refPath).on("value", async snapshot => {
    const val = snapshot.val();
    if (!val) return;

    console.log(`Instant Speedhunt Ping for ${runnerId}`);

    const r = runners[runnerId];

    if (r && r.lat && r.lng) {
      await writeRunnerLatestAndHistory_Speedhunt(runnerId, r);
    }

    await db.ref(refPath).remove();
  });
}

// ---------------------------------------------------------
// TELEGRAM WEBHOOK
// ---------------------------------------------------------
app.post("/webhook", async (req, res) => {
  const update = req.body;

  console.log("Incoming update:", update.update_id);

  // -----------------------------------------------------
  // /start
  // -----------------------------------------------------
  if (update.message?.text?.startsWith("/start")) {
    const chatId = update.message.chat.id;
    const parts = update.message.text.split(" ");

    if (!parts[1] || parts[1] === "null" || parts[1] === "undefined") {
      await sendMessage(chatId, "Usage: /start runner1?event=<eventId>");
      return res.sendStatus(200);
    }

    let param = parts[1];
    let id = param;
    let eventId = "testEvent";

    if (param.includes("?event=")) {
      const split = param.split("?event=");
      id = split[0];
      eventId = split[1] || "testEvent";
    }

    if (!isValidId(id)) {
      await sendMessage(chatId, "Invalid ID. Must start with runnerX or hunterX.");
      return res.sendStatus(200);
    }

    // ---------------------------
    // RUNNER
    // ---------------------------
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

      attachSpeedhuntListener(eventId, id);

      await sendMessage(
        chatId,
        `Runner registered: ${id}\nEvent: ${eventId}\n\nYour map:\nhttps://manhunt-e6f98.web.app/runner.html?event=${eventId}\nNow share your LIVE location.`
      );

      return res.sendStatus(200);
    }

    // ---------------------------
    // HUNTER
    // ---------------------------
    if (id.startsWith("hunter")) {
      hunters[id] = {
        chatId,
        eventId,
        lat: null,
        lng: null,
        timestamp: null
      };

      await sendMessage(
        chatId,
        `Hunter registered: ${id}\nEvent: ${eventId}\n\nYour map:\nhttps://manhunt-e6f98.web.app/hunter.html?event=${eventId}&me=${id}\nNow share your LIVE location.`
      );

      return res.sendStatus(200);
    }

    await sendMessage(chatId, "ID must start with runnerX or hunterX.");
    return res.sendStatus(200);
  }

  // -----------------------------------------------------
  // /stop
  // -----------------------------------------------------
  if (update.message?.text === "/stop tracking") {
    const chatId = update.message.chat.id;

    const runnerId = Object.keys(runners).find(id => runners[id].chatId === chatId);

    if (runnerId) {
      const eventId = runners[runnerId].eventId;

      await db.ref(`events/${eventId}/runners/${runnerId}`).remove();
      delete runners[runnerId];

      await sendMessage(chatId, `Runner ${runnerId} removed from event ${eventId}.`);
      return res.sendStatus(200);
    }

    const hunterId = Object.keys(hunters).find(id => hunters[id].chatId === chatId);

    if (hunterId) {
      const eventId = hunters[hunterId].eventId;

      await db.ref(`events/${eventId}/hunters/${hunterId}`).remove();
      delete hunters[hunterId];

      await sendMessage(chatId, `Hunter ${hunterId} removed from event ${eventId}.`);
      return res.sendStatus(200);
    }

    await sendMessage(chatId, "You are not registered as a runner or hunter.");
    return res.sendStatus(200);
  }

  // -----------------------------------------------------
  // /live
  // -----------------------------------------------------
  if (update.message?.text === "/live") {
    const chatId = update.message.chat.id;

    const runnerId = Object.keys(runners).find(id => runners[id].chatId === chatId);

    if (!isValidId(runnerId)) {
      await sendMessage(chatId, "Only runners can use /live.");
      return res.sendStatus(200);
    }

    runners[runnerId].liveMode = true;

    await db.ref(`events/${runners[runnerId].eventId}/runners/${runnerId}`)
      .update({ liveMode: true });

    await sendMessage(chatId, "Live mode enabled.");
    return res.sendStatus(200);
  }

  // -----------------------------------------------------
  // /end
  // -----------------------------------------------------
  if (update.message?.text === "/end") {
    const chatId = update.message.chat.id;

    const runnerId = Object.keys(runners).find(id => runners[id].chatId === chatId);

    if (!isValidId(runnerId)) {
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
  // LOCATION UPDATES
  // -----------------------------------------------------
  const loc = update.message?.location || update.edited_message?.location;

  if (loc) {
    const chatId =
      update.message?.chat?.id ||
      update.edited_message?.chat?.id;

    // ---------------------------
    // HUNTER LOCATION
    // ---------------------------
    const hunterId = Object.keys(hunters).find(id => hunters[id].chatId === chatId);

    if (isValidId(hunterId)) {
      const h = hunters[hunterId];
      h.lat = loc.latitude;
      h.lng = loc.longitude;
      h.timestamp = Date.now();

      console.log(`Real-time hunter update: ${hunterId}`);

      await writeHunterLatest(hunterId, h);
      return res.sendStatus(200);
    }

    // ---------------------------
    // RUNNER LOCATION
    // ---------------------------
    const runnerId = Object.keys(runners).find(id => runners[id].chatId === chatId);

    if (!isValidId(runnerId)) {
      console.log("Location received but no valid runner/hunter matched.");
      return res.sendStatus(200);
    }

    const r = runners[runnerId];
    r.lat = loc.latitude;
    r.lng = loc.longitude;
    r.timestamp = Date.now();

    await db.ref(`events/${r.eventId}/runners/${runnerId}/memory`).set(payload(r));

    if (!r.hasPushedOnce) {
      await writeRunnerLatestAndHistory(runnerId, r);
      r.hasPushedOnce = true;
      return res.sendStatus(200);
    }

    if (r.liveMode) {
      await writeRunnerLatestOnly(runnerId, r);
      return res.sendStatus(200);
    }

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

async function writeRunnerLatestOnly(id, data) {
  if (!isValidId(id)) return console.error("Invalid runnerId:", id);
  const eventId = data.eventId;
  await db.ref(`events/${eventId}/runners/${id}/latest`).set(payload(data));
}

async function writeRunnerLatestAndHistory(id, data) {
  if (!isValidId(id)) return console.error("Invalid runnerId:", id);
  const eventId = data.eventId;
  const p = payload(data);
  await db.ref(`events/${eventId}/runners/${id}/latest`).set(p);
  await db.ref(`events/${eventId}/runners/${id}/history`).push(p);
}

async function writeRunnerLatestAndHistory_Speedhunt(id, data) {
  if (!isValidId(id)) return console.error("Invalid runnerId:", id);
  const eventId = data.eventId;

  const p = payload(data);
  p.speedhunt = true;

  await db.ref(`events/${eventId}/runners/${id}/latest`).set(payload(data));
  await db.ref(`events/${eventId}/runners/${id}/history`).push(p);
}

async function writeHunterLatest(id, data) {
  if (!isValidId(id)) return console.error("Invalid hunterId:", id);
  const eventId = data.eventId;
  await db.ref(`events/${eventId}/hunters/${id}/latest`).set(payload(data));
}

// ---------------------------------------------------------
// SYNCHRONIZED INTERVAL SYSTEM
// ---------------------------------------------------------
function runIntervalPush() {
  console.log("Synchronized interval push triggered.");

  for (const runnerId in runners) {
    if (!isValidId(runnerId)) continue;

    const r = runners[runnerId];

    if (r.lat && r.lng && !r.liveMode) {
      console.log(`Interval push for ${runnerId}`);
      writeRunnerLatestAndHistory(runnerId, r);
    }
  }
}

function scheduleNextTick() {
  const now = new Date();

  let msUntilNext;

  if (TEST_MODE) {
    msUntilNext =
      60000 - (now.getSeconds() * 1000 + now.getMilliseconds());
  } else {
    const minute = now.getMinutes();
    const second = now.getSeconds();
    const ms = now.getMilliseconds();

    let nextTarget;

    if (minute < 20) nextTarget = 20;
    else if (minute < 40) nextTarget = 40;
    else nextTarget = 60;

    const minutesUntil = nextTarget - minute;
    msUntilNext =
      minutesUntil * 60000 -
      (second * 1000 + ms);
  }

  console.log(`Next synchronized push in ${msUntilNext} ms`);

  setTimeout(() => {
    runIntervalPush();
    scheduleNextTick();
  }, msUntilNext);
}

scheduleNextTick();

// ---------------------------------------------------------
// START SERVER
// ---------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Manhunt backend running on port ${PORT}`);
});
