const mongoose = require("mongoose");

const promptCacheSchema = new mongoose.Schema({
  inputHash: { type: String, required: true, unique: true },
  refinedText: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

promptCacheSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.model("PromptCache", promptCacheSchema);
