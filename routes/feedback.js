const express = require("express");
const Feedback = require("../models/Feedback");
const nodemailer = require("nodemailer");

const router = express.Router();

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "yashkumarjain15@gmail.com";

function sanitize(str, maxLen = 2000) {
  if (typeof str !== "string") return "";
  return str.replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, maxLen);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function createTransporter() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: false,
    auth: { user, pass },
  });
}

router.post("/", async (req, res) => {
  try {
    const { email, message } = req.body || {};
    const sanitizedEmail = sanitize(email, 254).toLowerCase();
    const sanitizedMessage = sanitize(message, 2000);

    if (!sanitizedEmail) {
      return res.status(400).json({ error: "Email is required" });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(sanitizedEmail)) {
      return res.status(400).json({ error: "Please enter a valid email" });
    }
    if (!sanitizedMessage) {
      return res.status(400).json({ error: "Message is required" });
    }

    const feedback = await Feedback.create({
      email: sanitizedEmail,
      message: sanitizedMessage,
    });

    const transporter = createTransporter();
    if (transporter) {
      await transporter.sendMail({
        from: process.env.SMTP_USER || SUPPORT_EMAIL,
        to: SUPPORT_EMAIL,
        subject: `[Voice to AI Prompt] New feedback from ${sanitizedEmail}`,
        text: `New feedback received:\n\nFrom: ${sanitizedEmail}\n\nMessage:\n${sanitizedMessage}`,
        html: `
          <p><strong>From:</strong> ${escapeHtml(sanitizedEmail)}</p>
          <p><strong>Message:</strong></p>
          <p>${escapeHtml(sanitizedMessage).replace(/\n/g, "<br>")}</p>
        `,
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Feedback error:", err);
    res.status(500).json({ error: "Failed to submit feedback" });
  }
});

module.exports = router;
