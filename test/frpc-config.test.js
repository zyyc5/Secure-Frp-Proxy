const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const proxyConfig = `# secure-frp-proxy:tunnel=tnl-test
# tunnel-name=office
[[proxies]]
name = "tcp-edge-test"
type = "tcp"
localIP = "127.0.0.1"
localPort = 13390
remotePort = 20101
transport.proxyProtocolVersion = "v2"`;

test('appends and removes a dedicated tunnel while preserving the frpc preamble', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'secure-rdp-frpc-'));
  const previous = process.env.CONFIG_DIR;
  process.env.CONFIG_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.CONFIG_DIR;
    else process.env.CONFIG_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const frpcConfig = require('../src/services/frpc-config');
  await frpcConfig.replaceAll('serverAddr = "frps.example.test"\nserverPort = 7000\n');
  await frpcConfig.appendProxyConfig(proxyConfig, 'tnl-test');

  const appended = await fs.readFile(path.join(directory, 'frpc.toml'), 'utf8');
  assert.match(appended, /serverAddr = "frps.example.test"/);
  assert.match(appended, /# secure-frp-proxy:tunnel=tnl-test/);
  assert.match(appended, /remotePort = 20101/);
  assert.equal((await frpcConfig.listTunnels()).at(-1).tunnelId, 'tnl-test');

  await frpcConfig.appendProxyConfig(proxyConfig.replace('20101', '20102'), 'tnl-test');
  const replaced = await frpcConfig.read();
  assert.equal(replaced.match(/\[\[proxies\]\]/g).length, 1);
  assert.match(replaced, /remotePort = 20102/);

  assert.equal(await frpcConfig.removeTunnel('tnl-test'), true);
  assert.doesNotMatch(await frpcConfig.read(), /\[\[proxies\]\]/);
  assert.equal(await frpcConfig.removeTunnel('tnl-test'), false);
});
