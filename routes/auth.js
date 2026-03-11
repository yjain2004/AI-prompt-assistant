const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const AuthUser = require("../models/AuthUser");

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";
const SALT_ROUNDS = 10;
const JWT_EXPIRY = "7d";

function sanitizeEmail(email) {
  if (typeof email !== "string") return null;
  const trimmed = email.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(trimmed) ? trimmed : null;
}

function validatePassword(password) {
  if (typeof password !== "string") return false;
  return password.length >= 8 && password.length <= 128;
}

function generateUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// POST /api/auth/signup
router.post("/signup", async (req, res) => {
  try {
    const { email, password, userId } = req.body || {};
    const sanitizedEmail = sanitizeEmail(email);

    if (!sanitizedEmail) {
      return res.status(400).json({ error: "Valid email required" });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({ error: "Password must be 8-128 characters" });
    }

    const existing = await AuthUser.findOne({ email: sanitizedEmail });
    if (existing) {
      return res.status(409).json({ error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const extensionUserId =
      typeof userId === "string" && userId.trim() ? userId.trim().slice(0, 64) : generateUUID();

    await AuthUser.create({
      email: sanitizedEmail,
      passwordHash,
      plan: "free",
      usageCount: 0,
      userId: extensionUserId,
    });

    const token = jwt.sign(
      { userId: extensionUserId, email: sanitizedEmail, plan: "free" },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    res.json({ token });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Signup failed" });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const sanitizedEmail = sanitizeEmail(email);

    if (!sanitizedEmail) {
      return res.status(400).json({ error: "Valid email required" });
    }
    if (!password || typeof password !== "string") {
      return res.status(400).json({ error: "Password required" });
    }

    const authUser = await AuthUser.findOne({ email: sanitizedEmail });
    if (!authUser) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const match = await bcrypt.compare(password, authUser.passwordHash);
    if (!match) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const extensionUserId = authUser.userId || generateUUID();
    if (!authUser.userId) {
      authUser.userId = extensionUserId;
      await authUser.save();
    }

    const token = jwt.sign(
      { userId: extensionUserId, email: sanitizedEmail, plan: authUser.plan || "free" },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    res.json({ token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

module.exports = router;
