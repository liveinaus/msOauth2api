import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  adminUsername,
  setAdminPassword,
  setAdminUsername,
  usingDefaultPassword,
  verifyAdmin,
} from "../auth/credentials";
import { requireAuth, signSession } from "../middleware/auth";

const router = Router();

// Brute force is the whole threat model for a single-admin login, so the limiter is the
// primary control rather than a nicety. Keyed on IP, which needs TRUST_PROXY set correctly
// behind a reverse proxy or every request appears to come from the proxy itself.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again in 15 minutes." },
});

router.post("/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "username and password are required" });
    return;
  }

  if (!(await verifyAdmin(username, password))) {
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }

  const requirePasswordChange = usingDefaultPassword();
  res.json({
    token: signSession({ sub: username, requirePasswordChange }),
    requirePasswordChange,
  });
});

router.get("/me", requireAuth, (_req, res) => {
  res.json({ username: adminUsername(), requirePasswordChange: usingDefaultPassword() });
});

router.post("/credentials", requireAuth, async (req, res) => {
  const { currentPassword, newPassword, newUsername } = req.body ?? {};

  if (
    typeof currentPassword !== "string" ||
    !(await verifyAdmin(adminUsername(), currentPassword))
  ) {
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }

  if (typeof newPassword === "string" && newPassword) {
    if (newPassword.length < 8) {
      res.status(400).json({ error: "New password must be at least 8 characters" });
      return;
    }
    await setAdminPassword(newPassword);
  }

  if (typeof newUsername === "string" && newUsername.trim()) {
    setAdminUsername(newUsername.trim());
  }

  // Changing either credential advanced the token epoch, so the caller's current token is
  // now void and it needs a fresh one to stay signed in.
  res.json({ token: signSession({ sub: adminUsername(), requirePasswordChange: false }) });
});

export default router;
