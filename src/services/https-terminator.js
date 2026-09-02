const tls = require('tls');
const net = require('net');
const fs = require('fs');
const path = require('path');
const configManager = require('../utils/config');
const rdpManager = require('./rdp-manager');
const { normalizeIP, parseProxyProtocolV2 } = require('../utils/proxy-protocol');
const { injectForwardedFor, ForwardedForTransform } = require('../utils/http-forwarded-for');
const { createDailyLogger } = require('../utils/logger');

const LOG_DIRECTORY = path.join(__dirname, '..', '..', 'log');
const CONNECTION_TIMEOUT = 30000;
const MAX_HTTP_HEADER_SIZE = 64 * 1024;
const CERTIFICATE_DIR = 'certs';
const CERTIFICATE_FILE = 'fullchain.cer';
const PRIVATE_KEY_FILE = 'privkey.key';
const getConfigDir = () => process.env.CONFIG_DIR || path.join(__dirname, '..', '..', 'config');
const logger = createDailyLogger(LOG_DIRECTORY, 'https_terminator');
let nextConnectionSequence = 0;

const createConnectionId = () => {
  nextConnectionSequence = (nextConnectionSequence + 1) % 1_000_000;
  return `https-${Date.now().toString(36)}-${nextConnectionSequence}`;
};

const HTTP_METHODS_RE = /^(GET|POST|HEAD|PUT|DELETE|OPTIONS|PATCH)\s/i;
const HTTP_VERSION_RE = /HTTP\/(1\.[01]|2)/i;
const WS_UPGRADE_RE = /\nupgrade:\s*websocket/i;
const CONN_UPGRADE_RE = /\nconnection:\s*upgrade/i;
const isHttpLikeText = (text) => HTTP_METHODS_RE.test(text) || HTTP_VERSION_RE.test(text) ||
  WS_UPGRADE_RE.test(text) || CONN_UPGRADE_RE.test(text);

const parseTlsServerName = (buffer) => {
  if (buffer.length < 5) return { complete: false };
  if (buffer[0] !== 0x16) return { complete: true, serverName: 'unknown' };
  const recordLength = buffer.readUInt16BE(3);
  if (buffer.length < 5 + recordLength) return { complete: false };
  const record = buffer.subarray(5, 5 + recordLength);
  if (record[0] !== 0x01 || record.length < 4) return { complete: true, serverName: 'unknown' };
  const helloLength = record.readUIntBE(1, 3);
  if (record.length < 4 + helloLength) return { complete: false };
  try {
    let offset = 4 + 2 + 32;
    offset += 1 + record[offset];
    offset += 2 + record.readUInt16BE(offset);
    offset += 1 + record[offset];
    const extensionsEnd = offset + 2 + record.readUInt16BE(offset);
    offset += 2;
    while (offset + 4 <= extensionsEnd) {
      const type = record.readUInt16BE(offset);
      const length = record.readUInt16BE(offset + 2);
      offset += 4;
      if (offset + length > extensionsEnd) break;
      if (type === 0x0000 && length >= 5) {
        const nameLength = record.readUInt16BE(offset + 3);
        if (offset + 5 + nameLength <= extensionsEnd) {
          return { complete: true, serverName: record.toString('utf8', offset + 5, offset + 5 + nameLength).toLowerCase() || 'unknown' };
        }
      }
      offset += length;
    }
  } catch (_) {
    // The TLS server will emit the protocol error after logging the available metadata.
  }
  return { complete: true, serverName: 'unknown' };
};

const parseHostSubPrefix = (buf) => {
  try {
    const headStr = buf.toString('utf8');
    if (!isHttpLikeText(headStr)) return { isHttp: false, subPrefix: null, host: 'unknown' };
    const hostMatch = headStr.match(/\n[Hh]ost:\s*([^\r\n]+)/);
    if (!hostMatch || !hostMatch[1]) return { isHttp: true, subPrefix: null, host: 'unknown' };
    let hostHeader = hostMatch[1].trim();
    if (hostHeader.includes(':')) hostHeader = hostHeader.split(':')[0];
    const firstDot = hostHeader.indexOf('.');
    return { isHttp: true, subPrefix: firstDot > 0 ? hostHeader.substring(0, firstDot) : hostHeader, host: hostHeader.toLowerCase() };
  } catch (_) {
    return { isHttp: false, subPrefix: null, host: 'unknown' };
  }
};

const selectTarget = (subPrefix) => {
  const config = configManager.getAll();
  if (subPrefix && Array.isArray(config?.PROXY_TARGETS)) {
    const hit = config.PROXY_TARGETS.find((target) => String(target?.name || '').toLowerCase() === subPrefix.toLowerCase());
    if (hit) return { host: hit.host, port: hit.port, access: hit.access, matched: true };
  }
  return null;
};

const connectionSource = (socket) => socket._parent || socket;

const connectionLabel = (socket) => {
  const source = connectionSource(socket);
  return `ip=${source.clientIP || 'unknown'} domain=${source.domain || 'unknown'}`;
};

const connectionLogger = (socket) => connectionSource(socket).connectionLogger || logger;

const connectAndPipe = (clientSocket, target, firstPacket, requestTransform = null) => {
  const log = connectionLogger(clientSocket);
  const upstream = net.createConnection({ host: target.host, port: target.port }, () => {
    if (requestTransform) {
      requestTransform.pipe(upstream);
      if (firstPacket.length > 0) requestTransform.write(firstPacket);
      clientSocket.pipe(requestTransform);
      return;
    }
    if (firstPacket.length > 0) upstream.write(firstPacket);
    clientSocket.pipe(upstream);
  });
  upstream.setTimeout(CONNECTION_TIMEOUT, () => {
    log(`upstream timeout ${connectionLabel(clientSocket)} target=${target.host}:${target.port}`);
    upstream.destroy();
    clientSocket.destroy();
  });
  upstream.pipe(clientSocket);
  upstream.on('error', (error) => {
    log(`upstream error ${connectionLabel(clientSocket)} target=${target.host}:${target.port} error=${error.message}`);
    clientSocket.end();
  });
  requestTransform?.on('error', (error) => {
    log(`request transform error ${connectionLabel(clientSocket)} target=${target.host}:${target.port} error=${error.message}`);
    upstream.destroy();
    clientSocket.destroy();
  });
  clientSocket.on('error', () => upstream.end());
  upstream.on('end', () => clientSocket.end());
  clientSocket.on('end', () => upstream.end());
};

let server = null;
let tlsServer = null;

const handOffToTls = (clientSocket, initialData, clientIP, domain) => {
  clientSocket.pause();
  clientSocket.setTimeout(0);
  clientSocket.clientIP = clientIP;
  clientSocket.domain = domain;
  if (initialData.length > 0) clientSocket.unshift(initialData);
  tlsServer.emit('connection', clientSocket);
};

const handleConnection = (clientSocket) => {
  const connectionId = createConnectionId();
  const log = (message) => logger(`connection=${connectionId} ${message}`);
  clientSocket.connectionLogger = log;
  log(`opened peer=${normalizeIP(clientSocket.remoteAddress || '')}:${clientSocket.remotePort || 'unknown'}`);
  clientSocket.once('close', (hadError) => log(`closed had_error=${hadError}`));
  let received = Buffer.alloc(0);
  let proxyHeader = null;
  let domain = 'unknown';
  clientSocket.setTimeout(CONNECTION_TIMEOUT, () => {
    log(`refused ip=${proxyHeader?.clientIP || normalizeIP(clientSocket.remoteAddress || '') || 'unknown'} domain=${domain} reason=connection_timeout`);
    clientSocket.destroy();
  });
  clientSocket.on('error', (error) => log(`socket error ip=${proxyHeader?.clientIP || normalizeIP(clientSocket.remoteAddress || '') || 'unknown'} domain=${domain} error=${error.message}`));
  clientSocket.on('data', function readProxyProtocol(data) {
    received = Buffer.concat([received, data]);
    try {
      if (received.length > MAX_HTTP_HEADER_SIZE) throw new Error('Proxy Protocol v2 or TLS ClientHello is too large');
      if (!proxyHeader || !proxyHeader.complete) proxyHeader = parseProxyProtocolV2(received);
      if (!proxyHeader.complete) return;
      if (!proxyHeader.present) {
        log(`refused ip=${normalizeIP(clientSocket.remoteAddress || '') || 'unknown'} domain=unknown reason=missing_proxy_protocol`);
        clientSocket.destroy();
        return;
      }
      const tlsData = received.subarray(proxyHeader.headerLength);
      const sni = parseTlsServerName(tlsData);
      if (!sni.complete) return;
      domain = sni.serverName;
      clientSocket.clientIP = proxyHeader.clientIP;
      clientSocket.domain = sni.serverName;
      clientSocket.off('data', readProxyProtocol);
      log(`accepted ip=${proxyHeader.clientIP} domain=${sni.serverName} proxy_protocol=v2`);
      handOffToTls(clientSocket, tlsData, proxyHeader.clientIP, sni.serverName);
    } catch (error) {
      log(`refused ip=${normalizeIP(clientSocket.remoteAddress || '') || 'unknown'} domain=unknown reason=invalid_connection error=${error.message}`);
      clientSocket.destroy();
    }
  });
};

const handleTlsConnection = (tlsSocket) => {
  const log = connectionLogger(tlsSocket);
  let firstPacket = Buffer.alloc(0);
  const onData = (data) => {
    firstPacket = Buffer.concat([firstPacket, data]);
    if (firstPacket.length > MAX_HTTP_HEADER_SIZE) {
      log(`refused ${connectionLabel(tlsSocket)} reason=http_header_too_large`);
      tlsSocket.destroy();
      return;
    }
    if (!firstPacket.includes('\r\n\r\n')) return;
    tlsSocket.off('data', onData);
    const { isHttp, subPrefix, host } = parseHostSubPrefix(firstPacket);
    const chosen = selectTarget(subPrefix);
    tlsSocket.domain = host === 'unknown' ? tlsSocket.servername || tlsSocket._parent?.domain || 'unknown' : host;
    const clientIP = tlsSocket._parent?.clientIP || tlsSocket.clientIP || 'unknown';
    if (!isHttp || !chosen) {
      log(`refused ${connectionLabel(tlsSocket)} host=${host} reason=${isHttp ? 'target_not_matched' : 'invalid_http_request'}`);
      tlsSocket.destroy();
      return;
    }
    if (chosen.access !== 'public' && !rdpManager.isAnyWhiteList(clientIP)) {
      log(`refused ${connectionLabel(tlsSocket)} target=${chosen.host}:${chosen.port} reason=not_whitelisted`);
      tlsSocket.destroy();
      return;
    }
    log(`route protocol=https host=${host} target=${chosen.host}:${chosen.port} matched=true`);
    connectAndPipe(
      tlsSocket,
      chosen,
      firstPacket,
      isHttp ? new ForwardedForTransform(clientIP) : null
    );
  };
  tlsSocket.on('data', onData);
};

const start = () => {
  const config = configManager.getAll();
  const httpsCfg = config?.HTTPS_TERMINATOR;
  if (!httpsCfg || httpsCfg.enabled !== true) {
    console.log('HTTPS Terminator disabled or not configured');
    return;
  }
  try {
    const certificateDir = path.join(getConfigDir(), CERTIFICATE_DIR);
    const key = fs.readFileSync(path.join(certificateDir, PRIVATE_KEY_FILE));
    const cert = fs.readFileSync(path.join(certificateDir, CERTIFICATE_FILE));
    tlsServer = tls.createServer({ key, cert, minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'] }, handleTlsConnection);
    tlsServer.on('tlsClientError', (error, socket) => connectionLogger(socket)(`tls client error ${connectionLabel(socket)} error=${error.message}`));
    const host = httpsCfg.host || '127.0.0.1';
    const port = httpsCfg.port || 443;
    server = net.createServer(handleConnection);
    server.on('error', (error) => console.error('HTTPS Terminator error:', error.message));
    server.listen(port, host, () => console.log(`HTTPS Terminator listening on ${host}:${port}`));
  } catch (error) {
    console.error('Failed to start HTTPS Terminator:', error.message);
  }
};

const reloadCertificates = () => {
  if (!tlsServer) return false;
  try {
    const certificateDir = path.join(getConfigDir(), CERTIFICATE_DIR);
    tlsServer.setSecureContext({
      key: fs.readFileSync(path.join(certificateDir, PRIVATE_KEY_FILE)),
      cert: fs.readFileSync(path.join(certificateDir, CERTIFICATE_FILE)),
      minVersion: 'TLSv1.2',
      ALPNProtocols: ['http/1.1']
    });
    console.log('HTTPS Terminator certificate reloaded');
    return true;
  } catch (error) {
    console.error('Failed to reload HTTPS Terminator certificate:', error.message);
    return false;
  }
};

const stop = () => {
  if (server) {
    server.close(() => {
      console.log('HTTPS Terminator stopped');
      server = null;
      tlsServer = null;
    });
  }
};

module.exports = { start, stop, reloadCertificates, injectForwardedFor, ForwardedForTransform, parseHostSubPrefix, selectTarget };
