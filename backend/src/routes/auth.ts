import { Router } from "express";
import rateLimit from "express-rate-limit";
import svgCaptcha from "svg-captcha";
import {
  adminUsername,
  setAdminPassword,
  setAdminUsername,
  usingDefaultPassword,
  verifyAdmin,
} from "../auth/credentials";
import { consumeCaptcha, issueCaptcha } from "../auth/captchaStore";
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

// Issuing challenges is cheap but not free, and an unbounded stream of them is the one way
// to make the store churn. Generous enough that someone reloading a hard-to-read captcha
// never meets it.
const captchaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many captcha requests. Try again later." },
});

// Changing credentials checks the current password, so it is password guessing by another
// name and belongs behind the same kind of brake as the login form.
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again in 15 minutes." },
});

router.get("/captcha", captchaLimiter, (_req, res) => {
  // Characters that read ambiguously in a distorted font are excluded, because a captcha
  // nobody can solve is only a brake on the operator.
  const captcha = svgCaptcha.create({ noise: 2, color: true, size: 5, ignoreChars: "0oO1lI" });
  // The answer stays in this process (see auth/captchaStore); what goes out is an opaque id.
  res.json({ svg: captcha.data, captchaToken: issueCaptcha(captcha.text) });
});

router.post("/login", loginLimiter, async (req, res) => {
  const { username, password, captchaToken, captchaAnswer } = req.body ?? {};
  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "username and password are required" });
    return;
  }

  if (typeof captchaToken !== "string" || typeof captchaAnswer !== "string") {
    res.status(400).json({ error: "Captcha is required" });
    return;
  }

  // Checked before the password, so a wrong captcha costs no argon2 verify and cannot be
  // used to time one. Consuming here means a solved challenge cannot be replayed across a
  // run of guesses.
  if (!consumeCaptcha(captchaToken, captchaAnswer)) {
    res.status(400).json({ error: "Incorrect or expired captcha, please refresh" });
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

router.post("/credentials", requireAuth, credentialLimiter, async (req, res) => {
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
