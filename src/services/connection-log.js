const fs = require('fs');
const path = require('path');

const LOG_DIRECTORY = path.join(__dirname, '..', '..', 'log');

const LOG_SOURCES = {
  tcp: { prefix: 'proxy_connections', label: 'TCP 代理' },
  https: { prefix: 'https_terminator', label: 'HTTPS 终止' },
};

const formatLogDate = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const parseLogTime = (str) => {
  const m = str && str.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
};

const findLogFiles = (prefix) => {
  try {
    return fs.readdirSync(LOG_DIRECTORY)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.log') && f !== `${prefix}.log`)
      .sort()
      .reverse();
  } catch {
    return [];
  }
};

const parseLine = (line) => {
  const sep = line.indexOf(' - ');
  if (sep === -1) return null;
  const timestamp = line.substring(0, sep);
  const body = line.substring(sep + 3).trim();
  if (!body.startsWith('connection=')) return null;

  const parts = body.split(/\s+/);
  const connectionId = parts[0].replace('connection=', '');
  // tls client error 是三词事件名，识别为统一事件 tls_error
  let event = parts[1];
  let fieldStart = 2;
  if (event === 'tls' && parts[2] === 'client' && parts[3] === 'error') {
    event = 'tls_error';
    fieldStart = 4;
  }
  const fields = {};
  for (let i = fieldStart; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq > 0) fields[parts[i].substring(0, eq)] = parts[i].substring(eq + 1);
  }
  return { timestamp, connectionId, event, fields };
};

const buildConnections = (entries) => {
  const map = new Map();
  for (const { timestamp, connectionId, event, fields } of entries) {
    if (!map.has(connectionId)) {
      map.set(connectionId, {
        id: connectionId,
        time: timestamp,
        ip: '',
        target: '',
        protocol: 'tcp',
        host: '',
        matched: null,
        refused: false,
        routed: false,
        reason: '',
        proxyProtocol: '',
        domain: '',
      });
    }
    const conn = map.get(connectionId);
    if (!conn.time || timestamp > conn.time) conn.time = timestamp;

    switch (event) {
      case 'accepted':
        conn.ip = fields.ip || conn.ip;
        conn.proxyProtocol = fields.proxy_protocol || '';
        if (fields.domain) conn.domain = fields.domain;
        break;
      case 'refused':
        conn.refused = true;
        conn.reason = fields.reason || '';
        if (fields.ip) conn.ip = fields.ip;
        if (fields.target) conn.target = fields.target;
        break;
      case 'route':
        conn.routed = true;
        conn.protocol = fields.protocol || conn.protocol;
        conn.host = fields.host || '';
        conn.matched = fields.matched === 'true';
        if (fields.target) conn.target = fields.target;
        break;
      case 'tls_error':
        conn.refused = true;
        conn.reason = `tls: ${(fields.error || '').substring(0, 80)}`;
        if (fields.ip) conn.ip = fields.ip;
        if (fields.domain) conn.domain = fields.domain;
        break;
      default:
        if (fields.target) conn.target = fields.target;
        break;
    }
  }
  return [...map.values()].sort((a, b) => parseLogTime(b.time) - parseLogTime(a.time));
};

const getRecentConnections = (limit = 50, type = 'tcp') => {
  const source = LOG_SOURCES[type] || LOG_SOURCES.tcp;
  const files = findLogFiles(source.prefix);
  const entries = [];

  for (const file of files) {
    if (entries.length >= limit * 8) break;
    try {
      const content = fs.readFileSync(path.join(LOG_DIRECTORY, file), 'utf8');
      const lines = content.split('\n').filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0 && entries.length < limit * 8; i--) {
        const parsed = parseLine(lines[i]);
        if (parsed) entries.push(parsed);
      }
    } catch {
      continue;
    }
  }

  const connections = buildConnections(entries).slice(0, limit);
  const refusedCount = connections.filter((c) => c.refused).length;

  return {
    type,
    label: source.label,
    connections,
    summary: {
      total: connections.length,
      refused: refusedCount,
      allowed: connections.length - refusedCount,
    },
  };
};

const readAllConnections = (type) => {
  const source = LOG_SOURCES[type] || LOG_SOURCES.tcp;
  const files = findLogFiles(source.prefix);
  const entries = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(LOG_DIRECTORY, file), 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        const parsed = parseLine(line);
        if (parsed) entries.push(parsed);
      }
    } catch { continue; }
  }
  return buildConnections(entries);
};

const getIpSummary = (type = 'tcp') => {
  const source = LOG_SOURCES[type] || LOG_SOURCES.tcp;
  const connections = readAllConnections(type);
  const groups = {};
  for (const conn of connections) {
    const ip = conn.ip || '未知';
    if (!groups[ip]) groups[ip] = { ip, total: 0, refused: 0, lastTime: '', firstTime: '' };
    groups[ip].total++;
    if (conn.refused) groups[ip].refused++;
    if (!groups[ip].firstTime || parseLogTime(conn.time) < parseLogTime(groups[ip].firstTime)) groups[ip].firstTime = conn.time;
    if (!groups[ip].lastTime || parseLogTime(conn.time) > parseLogTime(groups[ip].lastTime)) groups[ip].lastTime = conn.time;
  }
  const ips = Object.values(groups).sort((a, b) => parseLogTime(b.lastTime) - parseLogTime(a.lastTime));
  const totalRefused = connections.filter((c) => c.refused).length;
  return {
    type,
    label: source.label,
    summary: {
      totalConnections: connections.length,
      uniqueIps: ips.length,
      refused: totalRefused,
      allowed: connections.length - totalRefused,
    },
    ips,
  };
};

const getIpDetail = (ip, type = 'tcp', limit = 100) => {
  const source = LOG_SOURCES[type] || LOG_SOURCES.tcp;
  const connections = readAllConnections(type);
  const filtered = connections.filter((c) => c.ip === ip).slice(0, limit);
  const refusedCount = filtered.filter((c) => c.refused).length;
  return {
    type,
    label: source.label,
    ip,
    summary: {
      total: filtered.length,
      refused: refusedCount,
      allowed: filtered.length - refusedCount,
    },
    connections: filtered,
  };
};

module.exports = { getRecentConnections, getIpSummary, getIpDetail, parseLine, buildConnections };
