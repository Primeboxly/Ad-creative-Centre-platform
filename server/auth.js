import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';

const SESSION_DAYS = 14;

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return salt.toString('hex') + ':' + scryptSync(pw, salt, 64).toString('hex');
}

export function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const a = scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return timingSafeEqual(a, Buffer.from(hash, 'hex'));
}

export function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`)
    .run(token, userId, `+${SESSION_DAYS} days`);
  return token;
}

export function cookieOpts(remember = true) {
  const o = { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' };
  if (remember) o.maxAge = SESSION_DAYS * 864e5;
  return o;
}

function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

// Attaches req.user (or 401). Disabled users are logged out immediately.
export function requireAuth(req, res, next) {
  const token = readCookie(req, 'sid');
  const row = token && db.prepare(`
    SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > datetime('now') AND u.active = 1`).get(token);
  if (!row) return res.status(401).json({ error: 'Not signed in' });
  req.user = row;
  req.token = token;
  next();
}

export const requireAdmin = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' });
