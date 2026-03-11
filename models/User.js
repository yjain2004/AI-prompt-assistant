const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  signedUp: { type: Boolean, default: false },
  requestsToday: { type: Number, default: 0 },
  lastRequestDate: { type: String, default: () => new Date().toISOString().slice(0, 10) },
  totalRequests: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("User", userSchema);
