const tls = require('tls');
const net = require('net');
const fs = require('fs');
const path = require('path');
const configManager = require('../utils/config');
const rdpManager = require('./rdp-manager');

// 日志
const LOG_FILE = path.join(__dirname, '..', '..', 'log', 'https_terminator.log');
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
    const key = fs.readFileSync(httpsCfg.keyPath);
    const cert = fs.readFileSync(httpsCfg.certPath);

    server = tls.createServer({
      key,
      cert,
      ALPNProtocols: ['h2', 'http/1.1']
    }, (tlsSocket) => {
      const ip = normalizeIP(tlsSocket.remoteAddress || '');
      if(!rdpManager.isAnyWhiteList(ip)){
        logger(`refuse https connent: ${ip}`);
        tlsSocket.end();
        return;
      }

      tlsSocket.once('data', (data) => {
        const { isHttp, subPrefix } = parseHostSubPrefix(data);
        const chosen = selectTarget(subPrefix);
        if (isHttp && chosen.matched) {
          logger(`https http host matched: ${subPrefix} -> ${chosen.host}:${chosen.port}`);
        } else if (isHttp) {
          logger(`https http host no match: ${subPrefix}, fallback`);
        } else {
          logger('https non-http traffic, fallback to current');
        }
        connectAndPipe(tlsSocket, { host: chosen.host, port: chosen.port }, data);
      });
    });

    const port = httpsCfg.port || 443;
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
    });
  }
}

module.exports = { start, stop };


