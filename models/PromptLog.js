const mongoose = require("mongoose");

const promptLogSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  prompt: { type: String, required: true },
  source: { type: String, enum: ["text", "voice"], required: true },
  timestamp: { type: Date, default: Date.now },
});

module.exports = mongoose.model("PromptLog", promptLogSchema);
