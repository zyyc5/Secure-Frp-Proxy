const test = require('node:test');
const assert = require('node:assert/strict');
const configManager = require('../src/utils/config');
const { allocateLocalPort } = require('../src/services/tunnel-manager');

test('allocates an available dedicated local port and honours explicit requests', async (t) => {
  const previousConfig = configManager.config;
  configManager.config = {
    PORT: 9108,
    TCP_PROXY_PORT: 13389,
    TUNNELS: [{ id: 'common-tcp', role: 'builtin', localPort: 13389 }],
    TUNNEL_LOCAL_PORT_CURSOR: 23456
  };
  t.after(() => { configManager.config = previousConfig; });

  const automatic = await allocateLocalPort();
  assert.equal(automatic, 23456);
  assert.equal(configManager.get('TUNNEL_LOCAL_PORT_CURSOR'), 23457);

  const explicit = await allocateLocalPort(23460);
  assert.equal(explicit, 23460);
  assert.equal(configManager.get('TUNNEL_LOCAL_PORT_CURSOR'), 23461);
});

test('starts and stops a dedicated local proxy instance', async (t) => {
  const proxyInstances = require('../src/services/dedicated-proxy-instances');
  const previousConfig = configManager.config;
  const tunnel = { id: 'tnl-test-instance', role: 'dedicated', protocol: 'tcp', localHost: '127.0.0.1', localPort: 0 };
  const server = require('node:net').createServer();
  const actualPort = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  await new Promise((resolve) => server.close(resolve));
  tunnel.localPort = actualPort;
  configManager.config = { PORT: 9108, TCP_PROXY_PORT: 13389, TUNNELS: [tunnel], PROXY_TARGETS: [] };
  t.after(async () => {
    configManager.config = previousConfig;
    await proxyInstances.stop(tunnel.id);
  });

  assert.equal(await proxyInstances.start(tunnel), true);
  assert.equal(proxyInstances.isRunning(tunnel.id), true);
  assert.equal(await proxyInstances.start(tunnel), true);
  await proxyInstances.stop(tunnel.id);
  assert.equal(proxyInstances.isRunning(tunnel.id), false);
});

test('dedicated TCP proxy forwards post-handshake bytes exactly once', async (t) => {
  const net = require('node:net');
  const proxyInstances = require('../src/services/dedicated-proxy-instances');
  const { PROXY_PROTOCOL_V2_SIGNATURE } = require('../src/utils/proxy-protocol');
  const previousConfig = configManager.config;

  const received = [];
  const target = net.createServer((socket) => {
    socket.on('data', (data) => {
      received.push(data.toString());
      if (received.join('').length >= 'FIRST-SECOND'.length) socket.end('TARGET-ACK');
    });
  });
  const targetPort = await new Promise((resolve, reject) => {
    target.once('error', reject);
    target.listen(0, '127.0.0.1', () => resolve(target.address().port));
  });

  const tunnel = {
    id: 'tnl-single-forward',
    role: 'dedicated',
    protocol: 'tcp',
    localHost: '127.0.0.1',
    localPort: 0,
    targetId: 'target'
  };
  const localPort = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
  tunnel.localPort = localPort;
  configManager.config = {
    PORT: 9108,
    TCP_PROXY_PORT: 13389,
    TUNNELS: [tunnel],
    PROXY_TARGETS: [{ id: 'target', host: '127.0.0.1', port: targetPort, access: 'public' }]
  };
  t.after(async () => {
    configManager.config = previousConfig;
    await proxyInstances.stop(tunnel.id);
    target.close();
  });

  assert.equal(await proxyInstances.start(tunnel), true);
  const proxyHeader = Buffer.concat([
    PROXY_PROTOCOL_V2_SIGNATURE,
    Buffer.from([0x21, 0x11, 0x00, 0x0c]),
    Buffer.from([203, 0, 113, 42]),
    Buffer.from([192, 0, 2, 1, 0x1f, 0x90, 0x01, 0xbb])
  ]);

  const client = net.connect(localPort, '127.0.0.1');
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error('dedicated proxy did not forward the post-handshake payload once'));
    }, 2000);
    client.once('data', (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
    client.once('error', reject);
    client.write(proxyHeader);
    client.write('FIRST-');
    // Everything written after the forwarding pipe is established must reach the
    // target once - a duplicate pipe corrupts TLS/CredSSP, which fails RDP.
    setTimeout(() => client.write('SECOND'), 100);
  });

  assert.equal(response, 'TARGET-ACK');
  assert.equal(received.join(''), 'FIRST-SECOND');
  client.destroy();
});

test('removes a stale dedicated tunnel when the server record is already gone', async (t) => {
  const controlPlane = require('../src/services/control-plane-client');
  const proxyInstances = require('../src/services/dedicated-proxy-instances');
  const frpcConfig = require('../src/services/frpc-config');
  const frpc = require('../src/services/frpc-manager');
  const previousConfig = configManager.config;
  const previousSave = configManager.saveConfig.bind(configManager);
  configManager.saveConfig = async () => {};
  const stale = { id: 'tnl-stale', role: 'dedicated', protocol: 'tcp', localPort: 23470, targetId: null };
  configManager.config = { TUNNELS: [stale] };
  const originals = {
    deleteTunnel: controlPlane.deleteDedicatedTunnel,
    stop: proxyInstances.stop,
    removeTunnel: frpcConfig.removeTunnel,
    restart: frpc.reStart
  };
  const removedTunnelIds = [];
  controlPlane.deleteDedicatedTunnel = async () => { const error = new Error('not_found'); error.status = 404; error.code = 'not_found'; throw error; };
  proxyInstances.stop = async () => {};
  frpcConfig.removeTunnel = async (tunnelId) => { removedTunnelIds.push(tunnelId); return true; };
  frpc.reStart = async () => {};
  t.after(() => {
    configManager.config = previousConfig;
    configManager.saveConfig = previousSave;
    controlPlane.deleteDedicatedTunnel = originals.deleteTunnel;
    proxyInstances.stop = originals.stop;
    frpcConfig.removeTunnel = originals.removeTunnel;
    frpc.reStart = originals.restart;
  });

  await require('../src/services/tunnel-manager').remove(stale.id);
  assert.deepEqual(configManager.get('TUNNELS'), []);
  assert.deepEqual(removedTunnelIds, [stale.id]);
});

test('dedicated TCP proxy waits for application data after PROXY protocol v2', async (t) => {
  const net = require('node:net');
  const proxyInstances = require('../src/services/dedicated-proxy-instances');
  const { PROXY_PROTOCOL_V2_SIGNATURE } = require('../src/utils/proxy-protocol');
  const previousConfig = configManager.config;

  const target = net.createServer((socket) => {
    socket.once('data', (data) => {
      assert.equal(data.toString(), 'RDP-PACKET');
      socket.end('TARGET-ACK');
    });
  });
  const targetPort = await new Promise((resolve, reject) => {
    target.once('error', reject);
    target.listen(0, '127.0.0.1', () => resolve(target.address().port));
  });

  const tunnel = {
    id: 'tnl-header-first',
    role: 'dedicated',
    protocol: 'tcp',
    localHost: '127.0.0.1',
    localPort: 0,
    targetId: 'target'
  };
  const localPort = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
  tunnel.localPort = localPort;
  configManager.config = {
    PORT: 9108,
    TCP_PROXY_PORT: 13389,
    TUNNELS: [tunnel],
    PROXY_TARGETS: [{ id: 'target', host: '127.0.0.1', port: targetPort, access: 'public' }]
  };
  t.after(async () => {
    configManager.config = previousConfig;
    await proxyInstances.stop(tunnel.id);
    target.close();
  });

  assert.equal(await proxyInstances.start(tunnel), true);
  const proxyHeader = Buffer.concat([
    PROXY_PROTOCOL_V2_SIGNATURE,
    Buffer.from([0x21, 0x11, 0x00, 0x0c]),
    Buffer.from([203, 0, 113, 42]),
    Buffer.from([192, 0, 2, 1, 0x1f, 0x90, 0x01, 0xbb])
  ]);
  const client = net.connect(localPort, '127.0.0.1');
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error('dedicated proxy did not wait for and forward the first application packet'));
    }, 1000);
    client.once('data', (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
    client.once('error', reject);
    client.write(proxyHeader);
    setTimeout(() => client.write('RDP-PACKET'), 20);
  });
  assert.equal(response, 'TARGET-ACK');
  client.destroy();
});
