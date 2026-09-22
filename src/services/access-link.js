const crypto = require('crypto');

const DEFAULT_TTL_MS = 15 * 60 * 1000;

const store = new Map();

const generateToken = () => crypto.randomBytes(24).toString('base64url');

const createLink = (ttlMs = DEFAULT_TTL_MS) => {
  const token = generateToken();
  const expiresAt = Date.now() + ttlMs;
  store.set(token, { expiresAt, used: false });
  return { token, expiresAt };
};

const consumeToken = (token) => {
  const entry = store.get(token);
  if (!entry || entry.used || entry.expiresAt < Date.now()) return null;
  entry.used = true;
  return entry;
};

const cleanup = () => {
  const now = Date.now();
  for (const [token, entry] of store) {
    if (entry.expiresAt < now) store.delete(token);
  }
};

setInterval(cleanup, 60 * 1000).unref();

module.exports = { createLink, consumeToken, cleanup };
