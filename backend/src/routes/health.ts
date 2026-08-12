import { Router } from "express";
import { encryptionEnabled } from "../db/crypto";
import { aiConfig } from "../services/ai";

const router = Router();

/**
 * Unauthenticated on purpose, because the container healthcheck calls it. It reports only
 * whether optional features are configured, never their values.
 */
router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: Math.round(process.uptime()),
    encryptionAtRest: encryptionEnabled(),
    aiConfigured: aiConfig() !== null,
  });
});

export default router;
