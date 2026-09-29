const fs = require('fs');
const net = require('net');
const tls = require('tls');
const path = require('path');
const configManager = require('../utils/config');
const rdpManager = require('./rdp-manager');
const { normalizeIP, parseProxyProtocolV2 } = require('../utils/proxy-protocol');
const { ForwardedForTransform } = require('../utils/http-forwarded-for');

// Only guard slow target connects / PROXY protocol headers.
// Long-lived RDP and other TCP sessions must not be killed by an inactivity timer.
const CONNECTION_TIMEOUT = 30000;
const servers = new Map();

const getConfigDir = () => process.env.CONFIG_DIR || path.join(__dirname, '..', '..', 'config');
const findTunnel = (tunnelId) => configManager.getAll()?.TUNNELS?.find((tunnel) => tunnel.id === tunnelId);
const findTarget = (tunnel) => configManager.getAll()?.PROXY_TARGETS?.find((target) => target.id === tunnel?.targetId);

const tag = (tunnel) => `[dedicated ${tunnel.name || tunnel.id}]`;

const pipe = (client, upstream, logTag) => {
  // Once both sides are connected, forwarding is an established TCP session.
  // RDP may legitimately stay idle while waiting for user interaction.
  upstream.setTimeout(0);
  client.setTimeout(0);
  // Only the upstream -> client direction is wired here. The client -> upstream
  // direction is already wired by connectTarget; piping it a second time would
  // write every client byte to the target twice and corrupt TLS/CredSSP streams.
  upstream.pipe(client);
  client.on('error', (error) => { console.warn(`${logTag} client error: ${error.message}`); upstream.destroy(); });
  upstream.on('error', (error) => { console.warn(`${logTag} upstream error: ${error.message}`); client.destroy(); });
  client.on('end', () => { console.log(`${logTag} client closed its side`); upstream.end(); });
  upstream.on('end', () => { console.log(`${logTag} upstream closed its side`); client.end(); });
  client.on('close', (hadError) => console.log(`${logTag} client socket closed (hadError=${hadError})`));
  upstream.on('close', (hadError) => console.log(`${logTag} upstream socket closed (hadError=${hadError})`));
};

const authorize = (tunnel, clientIP) => {
  const target = findTarget(tunnel);
  if (!target) return { error: 'target_not_bound' };
  if (target.access !== 'public' && !rdpManager.isAnyWhiteList(clientIP)) return { error: 'not_whitelisted' };
  return { target };
};

const connectTarget = (socket, target, firstPacket, clientIP, logTag, transform = null) => {
  const upstream = net.createConnection({ host: target.host, port: target.port }, () => {
    console.log(`${logTag} upstream connected ${target.host}:${target.port} for client ${clientIP} (first packet ${firstPacket?.length || 0}B)`);
    if (transform) {
      transform.pipe(upstream);
      if (firstPacket?.length) transform.write(firstPacket);
      socket.pipe(transform);
    } else {
      if (firstPacket?.length) upstream.write(firstPacket);
      socket.pipe(upstream);
    }
    pipe(socket, upstream, logTag);
  });
  upstream.on('error', (error) => { console.warn(`${logTag} upstream connect failed ${target.host}:${target.port}: ${error.message}`); socket.destroy(); });
  transform?.on('error', (error) => { console.warn(`${logTag} transform error: ${error.message}`); upstream.destroy(); socket.destroy(); });
};

const readProxyHeader = (socket, onReady, logTag) => {
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
      console.log(`${logTag} proxy header resolved proxied=${Boolean(header.present)} clientIP=${socket.clientIP} headerBytes=${received.length - appData.length} appData=${appData.length}B`);

      // FRP may deliver the PROXY protocol header before the application's first
      // byte. Wait for that first byte so target connect behavior matches the
      // generic TCP proxy and the real application packet can be written.
      if (!appData.length) {
        console.log(`${logTag} waiting for first application byte`);
        socket.once('data', onData);
        return;
      }

      onReady(socket, appData);
    } catch (error) {
      console.warn(`${logTag} proxy header rejected: ${error.message}`);
      socket.off('data', onData);
      socket.destroy();
    }
  };
  socket.setTimeout(CONNECTION_TIMEOUT, () => { console.warn(`${logTag} no data within ${CONNECTION_TIMEOUT}ms, dropping client`); socket.destroy(); });
  socket.on('data', onData);
  socket.on('error', (error) => console.warn(`${logTag} client socket error: ${error.message}`));
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
  const logTag = tag(tunnel);
  const server = net.createServer((socket) => {
    console.log(`${logTag} client accepted from ${socket.remoteAddress}:${socket.remotePort}`);
    readProxyHeader(socket, (client, firstPacket) => {
      const decision = authorize(tunnel, client.clientIP);
      if (decision.error) {
        console.warn(`${logTag} rejected client ${client.clientIP}: ${decision.error}`);
        client.destroy();
        return;
      }
      console.log(`${logTag} authorized client ${client.clientIP} -> ${decision.target.host}:${decision.target.port}`);
      connectTarget(client, decision.target, firstPacket, client.clientIP, logTag);
    }, logTag);
  });
  server.once('error', reject);
  server.listen(tunnel.localPort, tunnel.localHost || '127.0.0.1', () => resolve({ server }));
});

const startHttpsInstance = (tunnel) => {
  const logTag = tag(tunnel);
  const certificateDir = path.join(getConfigDir(), 'certs');
  const tlsServer = tls.createServer({
    key: fs.readFileSync(path.join(certificateDir, 'privkey.key')),
    cert: fs.readFileSync(path.join(certificateDir, 'fullchain.cer')),
    minVersion: 'TLSv1.2',
    ALPNProtocols: ['http/1.1']
  }, (tlsSocket) => {
    tlsSocket.on('error', () => {});
    readHttpHeader(tlsSocket, (socket, firstPacket) => {
      const { parseHostSubPrefix } = require('./https-terminator');
      const parsed = parseHostSubPrefix(firstPacket);
      const decision = authorize(tunnel, socket.clientIP || socket._parent?.clientIP);
      if (!parsed.isHttp || decision.error) {
        console.warn(`${logTag} rejected HTTPS client ${socket.clientIP}: ${decision.error || 'not_http'}`);
        socket.destroy();
        return;
      }
      connectTarget(socket, decision.target, firstPacket, socket.clientIP || socket._parent?.clientIP, logTag, new ForwardedForTransform(socket.clientIP || socket._parent?.clientIP));
    });
  });

  const server = net.createServer((socket) => {
    readProxyHeader(socket, (client, tlsData) => {
      client.pause();
      client.setTimeout(0);
      client.clientIP = client.clientIP;
      if (tlsData.length) client.unshift(tlsData);
      tlsServer.emit('connection', client);
    }, logTag);
  });
  return new Promise((resolve, reject) => {
    tlsServer.on('error', (error) => console.error('Dedicated HTTPS TLS error:', error.message));
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
