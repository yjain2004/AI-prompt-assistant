const jwt = require("jsonwebtoken");
const AuthUser = require("../models/AuthUser");
const AnonymousUsage = require("../models/AnonymousUsage");

const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";
const ANON_LIMIT = 5;
const LOGGED_IN_LIMIT = 20;

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

async function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded;
  } catch {
    return null;
  }
}

async function getAnonymousUsage(deviceId) {
  let usage = await AnonymousUsage.findOne({ deviceId });
  if (!usage) {
    usage = await AnonymousUsage.create({ deviceId, totalRequests: 0 });
  }
  const promptsRemaining = Math.max(0, ANON_LIMIT - usage.totalRequests);
  return {
    allowed: usage.totalRequests < ANON_LIMIT,
    promptsRemaining,
    maxPrompts: ANON_LIMIT,
    requiresSignup: true,
    signedUp: false,
    _usageDoc: usage,
  };
}

async function getAuthUserUsage(userId) {
  const user = await AuthUser.findOne({ userId });
  if (!user) return null;

  const today = getToday();
  if (user.lastUsageDate !== today) {
    user.usageCount = 0;
    user.lastUsageDate = today;
    await user.save();
  }

  const promptsRemaining = Math.max(0, LOGGED_IN_LIMIT - user.usageCount);
  return {
    allowed: user.usageCount < LOGGED_IN_LIMIT,
    promptsRemaining,
    maxPrompts: LOGGED_IN_LIMIT,
    requiresSignup: false,
    signedUp: true,
    _userDoc: user,
  };
}

async function incrementAnonymousUsage(deviceId) {
  const usage = await AnonymousUsage.findOneAndUpdate(
    { deviceId },
    { $inc: { totalRequests: 1 } },
    { new: true, upsert: true }
  );
  return usage;
}

async function incrementAuthUserUsage(userId) {
  const today = getToday();
  const user = await AuthUser.findOne({ userId });
  if (!user) return null;
  if (user.lastUsageDate !== today) {
    user.usageCount = 0;
    user.lastUsageDate = today;
  }
  user.usageCount += 1;
  await user.save();
  return user;
}

async function checkUsageLimit(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (token) {
    const decoded = await verifyToken(token);
    if (decoded?.userId) {
      const usage = await getAuthUserUsage(decoded.userId);
      if (usage) {
        req.authUser = { userId: decoded.userId, plan: decoded.plan || "free" };
        req.usageResult = usage;
        return next();
      }
    }
  }

  const deviceId = req.body?.userId || req.query?.userId;
  if (!deviceId || typeof deviceId !== "string") {
    return res.status(400).json({ error: "userId required" });
  }

  const usage = await getAnonymousUsage(deviceId.trim());
  req.usageResult = usage;
  req.authUser = null;
  req.deviceId = deviceId.trim();
  next();
}

module.exports = {
  verifyToken,
  checkUsageLimit,
  incrementAnonymousUsage,
  incrementAuthUserUsage,
};
