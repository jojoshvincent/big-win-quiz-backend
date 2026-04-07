import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";

import { db } from "./db.js";
import {
  authMiddleware,
  hashPassword,
  normalizeEmail,
  signAccessToken,
  validateEmail,
  validatePassword,
  verifyPassword
} from "./auth.js";

import { generateOTP } from "./otp.js";
import { sendOTPEmail } from "./mailer.js";

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "64kb" }));

/* ---------------- HEALTH ---------------- */

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/* ---------------- REGISTER (SEND OTP) ---------------- */

app.post("/register", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? "");

    const emailErr = validateEmail(email);
    if (emailErr) return res.status(400).json({ error: emailErr });

    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const existing = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(email);

    if (existing)
      return res.status(409).json({ error: "Email already registered" });

    // generate OTP
    const otp = generateOTP();

    // expires in 5 minutes
    const expiresAt = new Date(
      Date.now() + 5 * 60 * 1000
    ).toISOString();

    db.prepare(`
      INSERT INTO email_otps (email, otp, expires_at)
      VALUES (?, ?, ?)
    `).run(email, otp, expiresAt);

    // send email
    await sendOTPEmail(email, otp);

    return res.json({
      message: "OTP sent to email"
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to send OTP" });
  }
});

/* ---------------- VERIFY EMAIL ---------------- */

app.post("/verify-email", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const otp = String(req.body?.otp ?? "");
    const password = String(req.body?.password ?? "");

    const record = db.prepare(`
      SELECT * FROM email_otps
      WHERE email = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(email);

    if (!record)
      return res.status(400).json({ error: "OTP not found" });

    if (record.otp !== otp)
      return res.status(400).json({ error: "Invalid OTP" });

    if (new Date(record.expires_at) < new Date())
      return res.status(400).json({ error: "OTP expired" });

    const passwordHash = await hashPassword(password);

    const info = db.prepare(`
      INSERT INTO users (email, password_hash)
      VALUES (?, ?)
    `).run(email, passwordHash);

    // cleanup OTP
    db.prepare("DELETE FROM email_otps WHERE email = ?").run(email);

    const token = signAccessToken({
      sub: String(info.lastInsertRowid),
      email
    });

    return res.json({
      message: "Email verified successfully",
      token
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Verification failed" });
  }
});

/* ---------------- LOGIN ---------------- */

app.post("/login", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password ?? "");

  const emailErr = validateEmail(email);
  if (emailErr) return res.status(400).json({ error: emailErr });

  if (!password)
    return res.status(400).json({ error: "Password is required" });

  const user = db
    .prepare("SELECT id, email, password_hash FROM users WHERE email = ?")
    .get(email);

  if (!user)
    return res.status(401).json({ error: "Invalid email or password" });

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok)
    return res.status(401).json({ error: "Invalid email or password" });

  const token = signAccessToken({
    sub: String(user.id),
    email: user.email
  });

  return res.json({ token });
});

/* ---------------- CURRENT USER ---------------- */

app.get("/me", authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

/* ---------------- SERVER ---------------- */

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Auth API listening on http://localhost:${port}`);
});