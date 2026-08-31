import { Router } from "express";
import { getPanelSettings, savePanelSettings } from "../db/panelSettings";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.use(requireAuth);

router.get("/", (_req, res) => {
  res.json(getPanelSettings());
});

/** Partial update: only the supplied fields are written, the rest keep their stored value. */
router.put("/", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  res.json(
    savePanelSettings({
      pollDurationMinutes:
        typeof body.pollDurationMinutes === "number" ? body.pollDurationMinutes : undefined,
      pollIntervalSeconds:
        typeof body.pollIntervalSeconds === "number" ? body.pollIntervalSeconds : undefined,
      leaseMinutes: typeof body.leaseMinutes === "number" ? body.leaseMinutes : undefined,
      usageMode:
        body.usageMode === "copy" || body.usageMode === "mail" ? body.usageMode : undefined,
      showClientId: typeof body.showClientId === "boolean" ? body.showClientId : undefined,
      showRefreshToken:
        typeof body.showRefreshToken === "boolean" ? body.showRefreshToken : undefined,
      oauthClientId: typeof body.oauthClientId === "string" ? body.oauthClientId : undefined,
      oauthRedirectUri:
        typeof body.oauthRedirectUri === "string" ? body.oauthRedirectUri : undefined,
    }),
  );
});

export default router;
