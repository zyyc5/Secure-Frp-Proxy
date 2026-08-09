const tls = require('tls');
const net = require('net');
const fs = require('fs');
const path = require('path');
const configManager = require('../utils/config');
const rdpManager = require('./rdp-manager');

// 日志
const LOG_FILE = path.join(__dirname, '..', '..', 'log', 'https_terminator.log');
const CONNECTION_TIMEOUT = 30000;
const MAX_HTTP_HEADER_SIZE = 64 * 1024;
const CERTIFICATE_DIR = 'certs';
const CERTIFICATE_FILE = 'fullchain.cer';
const PRIVATE_KEY_FILE = 'privkey.key';
const getConfigDir = () => process.env.CONFIG_DIR || path.join(__dirname, '..', '..', 'config');
const logger = (log)=>{
  const logEntry = `${new Date().toLocaleString()} - ${log} \n`;
  console.log(logEntry);
  fs.appendFile(LOG_FILE, logEntry, {}, ()=>{});
}

// 工具：IP 规范化
const normalizeIP = (remote)=>{
  if (!remote) return '';
  if (remote === '::1') return '127.0.0.1';
  return remote.startsWith('::ffff:') ? remote.substring(7) : remote;
}

// 工具：HTTP/WS 判定（与 tcp-proxy 保持一致）
const HTTP_METHODS_RE = /^(GET|POST|HEAD|PUT|DELETE|OPTIONS|PATCH)\s/i;
const HTTP_VERSION_RE = /HTTP\/(1\.[01]|2)/i;
const WS_UPGRADE_RE = /\nupgrade:\s*websocket/i;
const CONN_UPGRADE_RE = /\nconnection:\s*upgrade/i;
const isHttpLikeText = (text)=>{
  if (!text) return false;
  return HTTP_METHODS_RE.test(text) ||
    HTTP_VERSION_RE.test(text) ||
    WS_UPGRADE_RE.test(text) ||
    CONN_UPGRADE_RE.test(text);
}

// 工具：解析 Host 子域前缀
const parseHostSubPrefix = (buf)=>{
  try {
    const headStr = buf.toString('utf8');
    if (!isHttpLikeText(headStr)) return { isHttp: false, subPrefix: null };
    const hostMatch = headStr.match(/\n[Hh]ost:\s*([^\r\n]+)/);
    if (!hostMatch || !hostMatch[1]) return { isHttp: true, subPrefix: null };
    let hostHeader = hostMatch[1].trim();
    if (hostHeader.includes(':')) hostHeader = hostHeader.split(':')[0];
    const firstDot = hostHeader.indexOf('.');
    const subPrefix = firstDot > 0 ? hostHeader.substring(0, firstDot) : hostHeader;
    return { isHttp: true, subPrefix };
  } catch {
    return { isHttp: false, subPrefix: null };
  }
}

// 选择目标
const selectTarget = (subPrefix)=>{
  const config = configManager.getAll();
  if (subPrefix && Array.isArray(config?.PROXY_TARGETS)) {
    const hit = config.PROXY_TARGETS.find(t => String(t?.name || '').toLowerCase() === subPrefix.toLowerCase());
    if (hit) return { host: hit.host, port: hit.port, matched: true };
  }
  const currentId = (config?.CURRENT_PROXY_TARGET) || 'default';
  const fb = (config?.PROXY_TARGETS || []).find(t => t.id === currentId) || { host: '127.0.0.1', port: 80 };
  return { host: fb.host, port: fb.port, matched: false };
}

// 建立转发
const connectAndPipe = (clientSocket, target, firstPacket)=>{
  const upstream = net.createConnection(
    { host: target.host, port: target.port },
    () => {
      if (firstPacket && firstPacket.length > 0) upstream.write(firstPacket);
    }
  );

  upstream.setTimeout(CONNECTION_TIMEOUT, () => {
    logger(`upstream timeout: ${target.host}:${target.port}`);
    upstream.destroy();
    clientSocket.destroy();
  });

  clientSocket.pipe(upstream);
  upstream.pipe(clientSocket);

  upstream.on('error', (err) => {
    console.error(`Upstream socket error: ${err.message}`);
    clientSocket.end();
  });
  clientSocket.on('error', (err) => {
    console.error(`Client socket error: ${err.message}`);
    upstream.end();
  });
  upstream.on('end', () => {
    clientSocket.end();
    logger('connection closed');
  });
  clientSocket.on('end', () => {
    upstream.end();
  });
}

let server = null;

const start = () => {
  const config = configManager.getAll();
  const httpsCfg = config?.HTTPS_TERMINATOR;
  if (!httpsCfg || httpsCfg.enabled !== true) {
    console.log('HTTPS Terminator disabled or not configured');
    return;
  }

  try {
    const certificateDir = path.join(getConfigDir(), CERTIFICATE_DIR);
    const keyPath = path.join(certificateDir, PRIVATE_KEY_FILE);
    const certPath = path.join(certificateDir, CERTIFICATE_FILE);
    const key = fs.readFileSync(keyPath);
    const cert = fs.readFileSync(certPath);

    server = tls.createServer({
      key,
      cert,
      minVersion: 'TLSv1.2',
      ALPNProtocols: ['http/1.1']
    }, (tlsSocket) => {
      tlsSocket.setTimeout(CONNECTION_TIMEOUT, () => tlsSocket.destroy());
      const ip = normalizeIP(tlsSocket.remoteAddress || '');
      if(!rdpManager.isAnyWhiteList(ip)){
        logger(`refuse https connent: ${ip}`);
        tlsSocket.end();
        return;
      }

      let firstPacket = Buffer.alloc(0);
      const onData = (data) => {
        firstPacket = Buffer.concat([firstPacket, data]);
        if (firstPacket.length > MAX_HTTP_HEADER_SIZE) {
          logger(`https request header too large: ${ip}`);
          tlsSocket.destroy();
          return;
        }
        if (!firstPacket.includes('\r\n\r\n')) return;
        tlsSocket.off('data', onData);
        const { isHttp, subPrefix } = parseHostSubPrefix(firstPacket);
        const chosen = selectTarget(subPrefix);
        if (isHttp && chosen.matched) {
          logger(`https http host matched: ${subPrefix} -> ${chosen.host}:${chosen.port}`);
        } else if (isHttp) {
          logger(`https http host no match: ${subPrefix}, fallback`);
        } else {
          logger('https non-http traffic, fallback to current');
        }
        connectAndPipe(tlsSocket, { host: chosen.host, port: chosen.port }, firstPacket);
      };
      tlsSocket.on('data', onData);
    });

    const port = httpsCfg.port || 443;
    server.on('error', (error) => {
      console.error('HTTPS Terminator error:', error.message);
    });
    server.listen(port, () => {
      console.log(`HTTPS Terminator listening on port ${port}`);
    });
  } catch (e) {
    console.error('Failed to start HTTPS Terminator:', e.message);
  }
}

const stop = () => {
  if (server) {
    server.close(() => {
      console.log('HTTPS Terminator stopped');
      server = null;
    });
  }
}

module.exports = { start, stop };


