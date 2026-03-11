const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const fs = require("fs");
const fetch = globalThis.fetch || require("node-fetch");
const FormData = require("form-data");
require("dotenv").config();

const User = require("./models/User");
const PromptLog = require("./models/PromptLog");

const app = express();
const upload = multer({ dest: "uploads/" });

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads", { recursive: true });

app.use(express.json({ limit: "10mb" }));

const cors = require("cors");
app.use(cors({ origin: ["*"], methods: ["POST", "GET"] }));

// ============ Config ============
const EXTENSION_SECRET = process.env.EXTENSION_SECRET || "your-secret-key-change-in-production";
const ANON_LIMIT = 5;
const SIGNED_UP_LIMIT = 10;
const ANON_VOICE_SEC = 60;
const SIGNED_UP_VOICE_SEC = 120;
function getToday() {
  return new Date().toISOString().slice(0, 10);
}

// ============ Database helpers ============
async function getOrCreateUser(userId) {
  let user = await User.findOne({ userId });
  if (!user) {
    user = await User.create({
      userId,
      signedUp: false,
      requestsToday: 0,
      lastRequestDate: getToday(),
      totalRequests: 0,
    });
  }
  return user;
}

async function checkAndIncrementUsage(userId) {
  const user = await getOrCreateUser(userId);
  const today = getToday();

  if (user.lastRequestDate !== today) {
    user.lastRequestDate = today;
    user.requestsToday = 0;
  }

  const maxPrompts = user.signedUp ? SIGNED_UP_LIMIT : ANON_LIMIT;

  if (user.requestsToday >= maxPrompts) {
    return {
      allowed: false,
      promptsRemaining: 0,
      maxPrompts,
      requiresSignup: !user.signedUp,
      signedUp: user.signedUp,
    };
  }

  user.requestsToday += 1;
  user.totalRequests += 1;
  await user.save();

  return {
    allowed: true,
    promptsRemaining: maxPrompts - user.requestsToday,
    maxPrompts,
    signedUp: user.signedUp,
  };
}

async function applySignupReward(userId) {
  const user = await getOrCreateUser(userId);
  user.signedUp = true;

  const today = getToday();
  if (user.lastRequestDate !== today) {
    user.lastRequestDate = today;
    user.requestsToday = 0;
  }
  await user.save();

  const maxPrompts = SIGNED_UP_LIMIT;
  return {
    promptsRemaining: maxPrompts - user.requestsToday,
    maxPrompts,
    signedUp: true,
  };
}

// ============ Middleware ============
function validateExtensionKey(req, res, next) {
  const key = req.headers["x-extension-key"];
  if (!key || key !== EXTENSION_SECRET) {
    return res.status(401).json({ error: "Invalid or missing extension key" });
  }
  next();
}

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 30;

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const now = Date.now();
  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 0, resetAt: now + RATE_LIMIT_WINDOW });
  }
  const entry = rateLimitMap.get(ip);
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "Too many requests" });
  }
  next();
}

// ============ Routes ============

app.post("/ai-proxy", validateExtensionKey, rateLimit, upload.single("voiceFile"), async (req, res) => {
  try {
    const { userId, prompt, source, recordingDurationSeconds } = req.body || {};
    const type = req.body?.type;

    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ error: "userId required" });
    }

    let inputText = "";
    const sourceType = source === "voice" ? "voice" : "text";

    if (type === "voice" && req.file) {
      const filePath = req.file.path;
      const durationSec = recordingDurationSeconds ? Math.round(parseFloat(recordingDurationSeconds)) : 0;
      const user = await getOrCreateUser(userId);
      const maxVoiceSec = user.signedUp ? SIGNED_UP_VOICE_SEC : ANON_VOICE_SEC;

      if (durationSec > maxVoiceSec) {
        fs.unlinkSync(filePath);
        return res.status(400).json({
          audioLimitExceeded: true,
          limitReached: false,
          promptsRemaining: 0,
          maxPrompts: user.signedUp ? SIGNED_UP_LIMIT : ANON_LIMIT,
          signedUp: user.signedUp,
        });
      }

      const formData = new FormData();
      formData.append("file", fs.createReadStream(filePath));
      formData.append("model", "whisper-1");

      const whisperResp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: formData,
      });

      const whisperData = await whisperResp.json();
      inputText = whisperData.text || "";
      fs.unlinkSync(filePath);
    } else {
      inputText = req.body.prompt || req.body.input || "";
    }

    if (!inputText || typeof inputText !== "string") {
      return res.status(400).json({ error: "Text input missing" });
    }

    const user = await getOrCreateUser(userId);
    if (sourceType === "voice" && recordingDurationSeconds) {
      const maxVoiceSec = user.signedUp ? SIGNED_UP_VOICE_SEC : ANON_VOICE_SEC;
      const durationSec = Math.round(parseFloat(recordingDurationSeconds));
      if (durationSec > maxVoiceSec) {
        return res.status(400).json({
          audioLimitExceeded: true,
          limitReached: false,
          promptsRemaining: 0,
          maxPrompts: user.signedUp ? SIGNED_UP_LIMIT : ANON_LIMIT,
          signedUp: user.signedUp,
        });
      }
    }

    const usage = await checkAndIncrementUsage(userId);

    if (!usage.allowed) {
      return res.status(429).json({
        structuredPrompt: "",
        limitReached: true,
        requiresSignup: usage.requiresSignup || false,
        signedUp: usage.signedUp,
        promptsRemaining: 0,
        maxPrompts: usage.maxPrompts,
      });
    }

    await PromptLog.create({
      userId,
      prompt: inputText.slice(0, 500),
      source: sourceType,
    });

    const refinePrompt = `Refine this into a detailed AI prompt:\n${inputText}`;
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: "gpt-4.1-mini", input: refinePrompt }),
    });

    const data = await response.json();
    const structuredPrompt =
      data.output_text || data.output?.[0]?.content?.[0]?.text || inputText;

    res.json({
      structuredPrompt,
      limitReached: false,
      promptsRemaining: usage.promptsRemaining,
      maxPrompts: usage.maxPrompts,
      signedUp: usage.signedUp,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to process input" });
  }
});

app.post("/signup", validateExtensionKey, rateLimit, async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId required" });

    const result = await applySignupReward(userId);
    res.json({
      success: true,
      signedUp: true,
      promptsRemaining: result.promptsRemaining,
      maxPrompts: result.maxPrompts,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Signup failed" });
  }
});

app.get("/usage", validateExtensionKey, async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: "userId required" });

    const user = await getOrCreateUser(userId);
    const today = getToday();

    if (user.lastRequestDate !== today) {
      user.lastRequestDate = today;
      user.requestsToday = 0;
      await user.save();
    }

    const maxPrompts = user.signedUp ? SIGNED_UP_LIMIT : ANON_LIMIT;
    const promptsRemaining = maxPrompts - user.requestsToday;

    res.json({
      promptsRemaining,
      maxPrompts,
      signedUp: user.signedUp,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch usage" });
  }
});

// ============ Start server ============
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/voice-prompt";

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("Connected to MongoDB");
    app.listen(PORT, () => console.log(`AI Proxy running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });
