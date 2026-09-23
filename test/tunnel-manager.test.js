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
    TUNNEL_LOCAL_PORT_CURSOR: null
  };
  t.after(() => { configManager.config = previousConfig; });

  const automatic = await allocateLocalPort();
  assert.equal(automatic, 13390);
  assert.equal(configManager.get('TUNNEL_LOCAL_PORT_CURSOR'), 13391);

  const explicit = await allocateLocalPort(13395);
  assert.equal(explicit, 13395);
  assert.equal(configManager.get('TUNNEL_LOCAL_PORT_CURSOR'), 13396);
});
