import { Router } from "express";
import { requireApiAccess } from "../middleware/auth";
import { aiConfig, streamCompletion } from "../services/ai";
import type { ChatMessage } from "../services/ai";

const router = Router();

router.post("/ai", requireApiAccess, async (req, res) => {
  const config = aiConfig();
  if (!config) {
    res
      .status(500)
      .json({ error: "AI is not configured. Set AI_API_KEY, AI_API_URL and AI_MODEL." });
    return;
  }

  const { messages } = req.body ?? {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "Missing messages parameter" });
    return;
  }

  // Propagate a client disconnect so the upstream request is torn down with it rather than
  // billing out a completion nobody is reading.
  const controller = new AbortController();
  req.on("close", () => controller.abort());

  await streamCompletion(config, messages as ChatMessage[], res, controller.signal);
});

export default router;
