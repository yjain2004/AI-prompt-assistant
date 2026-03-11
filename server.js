const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const fs = require("fs");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const fetch = globalThis.fetch || require("node-fetch");
const FormData = require("form-data");
require("dotenv").config();

const PromptLog = require("./models/PromptLog");
const authRoutes = require("./routes/auth");
const { checkUsageLimit, incrementAnonymousUsage, incrementAuthUserUsage } = require("./middleware/auth");

const app = express();
const upload = multer({ dest: "uploads/" });

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads", { recursive: true });

// ============ Security ============
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "10mb" }));

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const allowed = [
        FRONTEND_URL,
        "http://localhost:5173",
        "https://localhost:5173",
      ];
      if (allowed.some((o) => origin === o || origin.startsWith(o))) return cb(null, true);
      if (origin.endsWith(".vercel.app") || origin.includes("vercel.app")) return cb(null, true);
      cb(null, false);
    },
    methods: ["POST", "GET"],
    credentials: true,
  })
);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(apiLimiter);

// ============ Config ============
const EXTENSION_SECRET = process.env.EXTENSION_SECRET || "your-secret-key-change-in-production";
const ANON_VOICE_SEC = 60;
const LOGGED_IN_VOICE_SEC = 120;

// ============ Middleware ============
function validateExtensionKey(req, res, next) {
  const key = req.headers["x-extension-key"];
  if (!key || key !== EXTENSION_SECRET) {
    return res.status(401).json({ error: "Invalid or missing extension key" });
  }
  next();
}

// Auth routes (used by frontend - no extension key)
app.use("/api/auth", authRoutes);

// ============ AI Proxy Route ============
app.post(
  "/ai-proxy",
  validateExtensionKey,
  checkUsageLimit,
  upload.single("voiceFile"),
  async (req, res) => {
    try {
      const { usageResult, authUser, deviceId } = req;
      const { userId, prompt, source, recordingDurationSeconds } = req.body || {};
      const type = req.body?.type;

      if (!usageResult.allowed) {
        return res.status(429).json({
          structuredPrompt: "",
          limitReached: true,
          requiresSignup: usageResult.requiresSignup || false,
          signedUp: usageResult.signedUp,
          promptsRemaining: 0,
          maxPrompts: usageResult.maxPrompts,
        });
      }

      let inputText = "";
      const sourceType = source === "voice" ? "voice" : "text";
      const isLoggedIn = !!authUser;
      const maxVoiceSec = isLoggedIn ? LOGGED_IN_VOICE_SEC : ANON_VOICE_SEC;

      if (type === "voice" && req.file) {
        const durationSec = recordingDurationSeconds ? Math.round(parseFloat(recordingDurationSeconds)) : 0;
        if (durationSec > maxVoiceSec) {
          fs.unlinkSync(req.file.path);
          return res.status(400).json({
            audioLimitExceeded: true,
            limitReached: false,
            promptsRemaining: usageResult.promptsRemaining,
            maxPrompts: usageResult.maxPrompts,
            signedUp: usageResult.signedUp,
          });
        }

        const formData = new FormData();
        formData.append("file", fs.createReadStream(req.file.path));
        formData.append("model", "whisper-1");

        const whisperResp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: formData,
        });

        const whisperData = await whisperResp.json();
        inputText = whisperData.text || "";
        fs.unlinkSync(req.file.path);
      } else {
        inputText = req.body.prompt || req.body.input || "";
      }

      if (!inputText || typeof inputText !== "string") {
        return res.status(400).json({ error: "Text input missing" });
      }

      if (sourceType === "voice" && recordingDurationSeconds) {
        const durationSec = Math.round(parseFloat(recordingDurationSeconds));
        if (durationSec > maxVoiceSec) {
          return res.status(400).json({
            audioLimitExceeded: true,
            limitReached: false,
            promptsRemaining: usageResult.promptsRemaining,
            maxPrompts: usageResult.maxPrompts,
            signedUp: usageResult.signedUp,
          });
        }
      }

      const effectiveUserId = authUser?.userId || deviceId || userId;

      if (authUser) {
        await incrementAuthUserUsage(authUser.userId);
      } else {
        await incrementAnonymousUsage(deviceId);
      }

      await PromptLog.create({
        userId: effectiveUserId,
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

      const newRemaining = usageResult.promptsRemaining - 1;

      res.json({
        structuredPrompt,
        limitReached: false,
        promptsRemaining: Math.max(0, newRemaining),
        maxPrompts: usageResult.maxPrompts,
        signedUp: usageResult.signedUp,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to process input" });
    }
  }
);

// ============ Usage Route ============
app.get("/usage", validateExtensionKey, checkUsageLimit, async (req, res) => {
  try {
    const { usageResult } = req;
    res.json({
      promptsRemaining: usageResult.promptsRemaining,
      maxPrompts: usageResult.maxPrompts,
      signedUp: usageResult.signedUp,
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
