const mongoose = require("mongoose");

const authUserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  plan: { type: String, default: "free", enum: ["free", "pro"] },
  usageCount: { type: Number, default: 0 },
  lastUsageDate: { type: String, default: () => new Date().toISOString().slice(0, 10) },
  userId: { type: String, sparse: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("AuthUser", authUserSchema);
