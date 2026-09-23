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
