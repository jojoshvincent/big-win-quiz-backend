import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

export function validateEmail(email) {
  if (!email) return "Email is required";
  if (email.length > 254) return "Email is too long";
  // lightweight sanity check (not full RFC)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Invalid email";
  return null;
}

export function validatePassword(password) {
  if (!password) return "Password is required";
  if (password.length < 8) return "Password must be at least 8 characters";
  if (password.length > 128) return "Password is too long";
  return null;
}

export async function hashPassword(password) {
  const saltRounds = 12;
  return await bcrypt.hash(password, saltRounds);
}

export async function verifyPassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

export function signAccessToken(payload) {
  const secret = requiredEnv("JWT_SECRET");
  return jwt.sign(payload, secret, { expiresIn: "7d" });
}

export function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({ error: "Missing Bearer token" });
    }
    const secret = requiredEnv("JWT_SECRET");
    const decoded = jwt.verify(token, secret);
    req.user = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

