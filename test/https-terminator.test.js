const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const configManager = require('../src/utils/config');
const { injectForwardedFor, ForwardedForTransform, parseHostSubPrefix, selectTarget } = require('../src/services/https-terminator');

test('routes HTTPS only to a target matching the Host subdomain', () => {
  const previousConfig = configManager.config;
  configManager.config = {
    CURRENT_PROXY_TARGET: 'default',
    PROXY_TARGETS: [
      { id: 'default', name: 'default', host: '127.0.0.1', port: 3389, access: 'protected' },
      { id: 'self', name: 'self', host: '127.0.0.1', port: 9108, access: 'public' }
    ]
  };

  try {
    const matched = parseHostSubPrefix(Buffer.from('GET / HTTP/1.1\r\nHost: self.example.test\r\n\r\n'));
    const unknown = parseHostSubPrefix(Buffer.from('GET / HTTP/1.1\r\nHost: unknown.example.test\r\n\r\n'));
    const missing = parseHostSubPrefix(Buffer.from('GET / HTTP/1.1\r\n\r\n'));

    assert.deepEqual(selectTarget(matched.subPrefix), { host: '127.0.0.1', port: 9108, access: 'public', matched: true });
    assert.equal(selectTarget(unknown.subPrefix), null);
    assert.equal(selectTarget(missing.subPrefix), null);
  } finally {
    configManager.config = previousConfig;
  }
});

test('adds the verified client IP and replaces a supplied X-Forwarded-For header', () => {
  const packet = Buffer.from(
    'GET /api/page-data HTTP/1.1\r\nHost: manager.example.test\r\nX-Forwarded-For: 198.51.100.99\r\nX-Forwarded-For: 198.51.100.100\r\nAccept: application/json\r\n\r\nbody',
    'latin1'
  );

  const result = injectForwardedFor(packet, '203.0.113.42').toString('latin1');

  assert.equal(
    result,
    'GET /api/page-data HTTP/1.1\r\nHost: manager.example.test\r\nAccept: application/json\r\nX-Forwarded-For: 203.0.113.42\r\n\r\nbody'
  );
});

test('does not alter an incomplete HTTP header', () => {
  const packet = Buffer.from('GET / HTTP/1.1\r\nHost: manager.example.test\r\n', 'latin1');
  assert.strictEqual(injectForwardedFor(packet, '203.0.113.42'), packet);
});

test('injects the verified IP into every keep-alive request', async () => {
  const transform = new ForwardedForTransform('203.0.113.42');
  const chunks = [];
  transform.on('data', (chunk) => chunks.push(chunk));
  const completed = once(transform, 'end');
  transform.end(Buffer.from(
    'GET /api/page-data HTTP/1.1\r\nHost: manager.example.test\r\n\r\nGET /api/proxy-targets HTTP/1.1\r\nHost: manager.example.test\r\n\r\n',
    'latin1'
  ));
  await completed;

  const result = Buffer.concat(chunks).toString('latin1');
  assert.equal((result.match(/X-Forwarded-For: 203\.0\.113\.42/g) || []).length, 2);
  assert.match(result, /GET \/api\/page-data/);
  assert.match(result, /GET \/api\/proxy-targets/);
});

test('preserves a fixed-length request body before rewriting the next request', async () => {
  const body = 'value\r\n\r\nnot-an-http-header';
  const transform = new ForwardedForTransform('203.0.113.42');
  const chunks = [];
  transform.on('data', (chunk) => chunks.push(chunk));
  const completed = once(transform, 'end');
  transform.end(Buffer.from(
    `POST /api/proxy-targets HTTP/1.1\r\nHost: manager.example.test\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}GET /api/page-data HTTP/1.1\r\nHost: manager.example.test\r\n\r\n`,
    'latin1'
  ));
  await completed;

  const result = Buffer.concat(chunks).toString('latin1');
  assert.match(result, new RegExp(`\\r\\n\\r\\n${body}GET /api/page-data`));
  assert.equal((result.match(/X-Forwarded-For: 203\.0\.113\.42/g) || []).length, 2);
});

test('injects the handshake header and leaves WebSocket frames unchanged', async () => {
  const transform = new ForwardedForTransform('203.0.113.42');
  const chunks = [];
  transform.on('data', (chunk) => chunks.push(chunk));
  const completed = once(transform, 'end');
  const frame = Buffer.from([0x81, 0x02, 0x6f, 0x6b]);
  transform.end(Buffer.concat([
    Buffer.from('GET /socket HTTP/1.1\r\nHost: manager.example.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n', 'latin1'),
    frame
  ]));
  await completed;

  const result = Buffer.concat(chunks);
  assert.match(result.toString('latin1'), /X-Forwarded-For: 203\.0\.113\.42/);
  assert.deepEqual(result.subarray(-frame.length), frame);
});
