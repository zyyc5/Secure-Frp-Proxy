const fs = require('fs').promises;
const path = require('path');

const MARKER_PREFIX = '# secure-frp-proxy:tunnel=';

const getConfigPath = () => path.join(process.env.CONFIG_DIR || path.join(__dirname, '..', '..', 'config'), 'frpc.toml');

const splitLines = (content) => String(content || '').split(/\r?\n/);

const findTunnelMarker = (lines, tunnelId) => lines.findIndex((line) => line.trim() === `${MARKER_PREFIX}${tunnelId}`);

const findNextMarker = (lines, startIndex) => lines.findIndex((line, index) => index > startIndex && line.trim().startsWith(MARKER_PREFIX));

const read = async () => {
  try { return await fs.readFile(getConfigPath(), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
};

const write = async (content) => {
  const filePath = getConfigPath();
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
};

const replaceAll = async (content) => write(content);

const appendProxyConfig = async (proxyConfig, tunnelId) => {
  const lines = splitLines(await read());
  const existing = findTunnelMarker(lines, tunnelId);
  if (existing !== -1) {
    const next = findNextMarker(lines, existing);
    lines.splice(existing, next === -1 ? lines.length - existing : next - existing);
  }
  while (lines.length && [''].includes(lines[lines.length - 1])) lines.pop();
  if (lines.length) lines.push('');
  lines.push(...splitLines(proxyConfig.trim()));
  lines.push('');
  await write(lines.join('\n'));
};

const removeTunnel = async (tunnelId) => {
  const lines = splitLines(await read());
  const start = findTunnelMarker(lines, tunnelId);
  if (start === -1) return false;
  const end = findNextMarker(lines, start);
  lines.splice(start, end === -1 ? lines.length - start : end - start);
  while (lines.length > 1 && lines[lines.length - 1] === '' && lines[lines.length - 2] === '') lines.pop();
  await write(lines.join('\n'));
  return true;
};

const listTunnels = async () => {
  const lines = splitLines(await read());
  const tunnels = [];
  for (let index = 0; index < lines.length; index += 1) {
    const marker = lines[index].trim().match(/^# secure-frp-proxy:tunnel=(.+)$/);
    if (!marker) continue;
    const values = {};
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (lines[cursor].trim().startsWith(MARKER_PREFIX)) break;
      const match = lines[cursor].match(/^\s*([A-Za-z0-9_.]+)\s*=\s*(.+?)\s*$/);
      if (match) {
        try { values[match[1]] = JSON.parse(match[2]); } catch { values[match[1]] = match[2]; }
      }
    }
    tunnels.push({ tunnelId: marker[1], values });
  }
  return tunnels;
};

module.exports = { appendProxyConfig, getConfigPath, listTunnels, read, removeTunnel, replaceAll, write };
