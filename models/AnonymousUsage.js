const mongoose = require("mongoose");

const anonymousUsageSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true },
  totalRequests: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("AnonymousUsage", anonymousUsageSchema);
