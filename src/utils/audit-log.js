const path = require('path');
const { createDailyLogger } = require('./logger');

const LOG_DIRECTORY = path.join(__dirname, '..', '..', 'log');
const auditLogger = createDailyLogger(LOG_DIRECTORY, 'audit_operations');

const findAuditFiles = () => {
  const fs = require('fs');
  try {
    return fs.readdirSync(LOG_DIRECTORY)
      .filter((f) => f.startsWith('audit_operations') && f.endsWith('.log'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
};

const parseAuditLine = (line) => {
  const sep = line.indexOf(' - ');
  if (sep === -1) return null;
  const time = line.substring(0, sep).trim();
  const body = line.substring(sep + 3).trim();
  const fields = {};
  for (const part of body.split(/\s+/)) {
    const eq = part.indexOf('=');
    if (eq > 0) fields[part.substring(0, eq)] = part.substring(eq + 1);
  }
  if (!fields.action) return null;
  return { time, ip: fields.ip || '', user: fields.user || '', action: fields.action, details: Object.fromEntries(Object.entries(fields).filter(([k]) => !['ip', 'user', 'action'].includes(k))) };
};

const getRecentAuditLog = (limit = 100) => {
  const files = findAuditFiles();
  const entries = [];
  for (const file of files) {
    if (entries.length >= limit) break;
    try {
      const fs = require('fs');
      const content = fs.readFileSync(path.join(LOG_DIRECTORY, file), 'utf8');
      const lines = content.split('\n').filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
        const parsed = parseAuditLine(lines[i]);
        if (parsed) entries.push(parsed);
      }
    } catch { continue; }
  }
  return entries;
};

const audit = (req, action, details = {}) => {
  const forwarded = req?.headers?.['x-forwarded-for'];
  const ip = req?.app?.get('trust proxy') && forwarded
    ? forwarded.split(',')[0].trim()
    : (req?.socket?.remoteAddress || '').replace('::ffff:', '') || 'unknown';
  const config = require('./config').getAll();
  const user = config?.USERNAME || 'unknown';
  const fields = Object.entries(details)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  auditLogger(`ip=${ip} user=${user} action=${action}${fields ? ' ' + fields : ''}`);
};

module.exports = { audit, getRecentAuditLog };
