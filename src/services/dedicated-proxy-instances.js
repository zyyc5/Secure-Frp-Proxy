const fs = require('fs');
const net = require('net');
const tls = require('tls');
const path = require('path');
const configManager = require('../utils/config');
const rdpManager = require('./rdp-manager');
const { normalizeIP, parseProxyProtocolV2 } = require('../utils/proxy-protocol');
const { ForwardedForTransform } = require('../utils/http-forwarded-for');

const CONNECTION_TIMEOUT = 30000;
const servers = new Map();

const getConfigDir = () => process.env.CONFIG_DIR || path.join(__dirname, '..', '..', 'config');
const findTunnel = (tunnelId) => configManager.getAll()?.TUNNELS?.find((tunnel) => tunnel.id === tunnelId);
const findTarget = (tunnel) => configManager.getAll()?.PROXY_TARGETS?.find((target) => target.id === tunnel?.targetId);

const pipe = (client, upstream) => {
  upstream.setTimeout(CONNECTION_TIMEOUT, () => { upstream.destroy(); client.destroy(); });
  client.setTimeout(CONNECTION_TIMEOUT, () => { client.destroy(); upstream.destroy(); });
  client.pipe(upstream);
  upstream.pipe(client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.on('end', () => upstream.end());
  upstream.on('end', () => client.end());
};

const authorize = (tunnel, clientIP) => {
  const target = findTarget(tunnel);
  if (!target) return { error: 'target_not_bound' };
  if (target.access !== 'public' && !rdpManager.isAnyWhiteList(clientIP)) return { error: 'not_whitelisted' };
  return { target };
};

const connectTarget = (socket, target, firstPacket, clientIP, transform = null) => {
  const upstream = net.createConnection({ host: target.host, port: target.port }, () => {
    if (transform) {
      transform.pipe(upstream);
      if (firstPacket?.length) transform.write(firstPacket);
      socket.pipe(transform);
    } else {
      if (firstPacket?.length) upstream.write(firstPacket);
      socket.pipe(upstream);
    }
    pipe(socket, upstream);
  });
  upstream.on('error', () => socket.destroy());
  transform?.on('error', () => { upstream.destroy(); socket.destroy(); });
};

const readProxyHeader = (socket, onReady) => {
  let received = Buffer.alloc(0);
  const onData = (data) => {
    try {
      received = Buffer.concat([received, data]);
      const header = parseProxyProtocolV2(received);
      if (!header.complete) return;
      socket.off('data', onData);
      if (!header.present) {
        socket.clientIP = normalizeIP(socket.remoteAddress || '');
        socket.proxied = false;
      } else {
        socket.clientIP = header.clientIP;
        socket.proxied = true;
      }
      const appData = header.present ? received.subarray(header.headerLength) : received;
      onReady(socket, appData);
    } catch (error) {
      socket.off('data', onData);
      socket.destroy();
    }
  };
  socket.setTimeout(CONNECTION_TIMEOUT, () => socket.destroy());
  socket.on('data', onData);
  socket.on('error', () => {});
};

const readHttpHeader = (socket, onReady) => {
  let received = Buffer.alloc(0);
  const onData = (data) => {
    received = Buffer.concat([received, data]);
    if (received.length > 64 * 1024) { socket.off('data', onData); socket.destroy(); return; }
    if (!received.includes('\r\n\r\n')) return;
    socket.off('data', onData);
    onReady(socket, received);
  };
  socket.setTimeout(CONNECTION_TIMEOUT, () => socket.destroy());
  socket.on('data', onData);
  socket.on('error', () => {});
};

const startTcpInstance = (tunnel) => new Promise((resolve, reject) => {
  const server = net.createServer((socket) => {
    readProxyHeader(socket, (client, firstPacket) => {
      const decision = authorize(tunnel, client.clientIP);
      if (decision.error) { client.destroy(); return; }
      connectTarget(client, decision.target, firstPacket, client.clientIP);
    });
  });
  server.once('error', reject);
  server.listen(tunnel.localPort, tunnel.localHost || '127.0.0.1', () => resolve(server));
});

const startHttpsInstance = (tunnel) => {
  const certificateDir = path.join(getConfigDir(), 'certs');
  const tlsServer = tls.createServer({
    key: fs.readFileSync(path.join(certificateDir, 'privkey.key')),
    cert: fs.readFileSync(path.join(certificateDir, 'fullchain.cer')),
    minVersion: 'TLSv1.2',
    ALPNProtocols: ['http/1.1']
  }, (tlsSocket) => {
    readHttpHeader(tlsSocket, (socket, firstPacket) => {
      const { parseHostSubPrefix } = require('./https-terminator');
      const parsed = parseHostSubPrefix(firstPacket);
      const decision = authorize(tunnel, socket.clientIP || socket._parent?.clientIP);
      if (!parsed.isHttp || decision.error) { socket.destroy(); return; }
      connectTarget(socket, decision.target, firstPacket, socket.clientIP || socket._parent?.clientIP, new ForwardedForTransform(socket.clientIP || socket._parent?.clientIP));
    });
  });

  const server = net.createServer((socket) => {
    readProxyHeader(socket, (client, tlsData) => {
      client.pause();
      client.setTimeout(0);
      client.clientIP = client.clientIP;
      if (tlsData.length) client.unshift(tlsData);
      tlsServer.emit('connection', client);
    });
  });
  return new Promise((resolve, reject) => {
    tlsServer.once('error', reject);
    server.once('error', reject);
    server.listen(tunnel.localPort, tunnel.localHost || '127.0.0.1', () => resolve({ server, tlsServer }));
  });
};

const start = async (tunnel) => {
  if (!tunnel || tunnel.role === 'builtin' || servers.has(tunnel.id)) return true;
  try {
    const instance = tunnel.protocol === 'https' ? await startHttpsInstance(tunnel) : await startTcpInstance(tunnel);
    const sockets = new Set();
    const rawServer = instance.server;
    rawServer.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    servers.set(tunnel.id, { ...instance, sockets });
    return true;
  } catch (error) {
    console.error(`Failed to start dedicated proxy ${tunnel.id} on port ${tunnel.localPort}: ${error.message}`);
    return false;
  }
};

const stop = (tunnelId) => new Promise((resolve) => {
  const instance = servers.get(tunnelId);
  if (!instance) return resolve();
  servers.delete(tunnelId);
  for (const socket of instance.sockets || []) socket.destroy();
  instance.tlsServer?.close();
  instance.server.close(() => resolve());
});

const stopAll = () => Promise.all([...servers.keys()].map(stop));
const isRunning = (tunnelId) => servers.has(tunnelId);
const runningIds = () => [...servers.keys()];

process.on('SIGTERM', () => { stopAll(); });
process.on('SIGINT', () => { stopAll(); });

module.exports = { isRunning, runningIds, start, stop, stopAll };
