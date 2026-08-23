const test = require('node:test');
const assert = require('node:assert/strict');
const { PROXY_PROTOCOL_V2_SIGNATURE, parseProxyProtocolV2 } = require('../src/utils/proxy-protocol');

const ipv4Header = (ip) => Buffer.concat([
  PROXY_PROTOCOL_V2_SIGNATURE,
  Buffer.from([0x21, 0x11, 0x00, 0x0C]),
  Buffer.from(ip.split('.').map(Number)),
  Buffer.from([192, 0, 2, 1, 0x1F, 0x90, 0x01, 0xBB])
]);

test('parses a complete IPv4 Proxy Protocol v2 header', () => {
  const result = parseProxyProtocolV2(Buffer.concat([ipv4Header('203.0.113.42'), Buffer.from('hello')]));
  assert.equal(result.complete, true);
  assert.equal(result.present, true);
  assert.equal(result.clientIP, '203.0.113.42');
  assert.equal(result.headerLength, 28);
});

test('waits for a fragmented Proxy Protocol v2 header', () => {
  const header = ipv4Header('198.51.100.8');
  assert.deepEqual(parseProxyProtocolV2(header.subarray(0, 10)), { complete: false });
  assert.deepEqual(parseProxyProtocolV2(header.subarray(0, 20)), { present: true, complete: false });
});

test('recognizes non-Proxy Protocol traffic without consuming it', () => {
  assert.deepEqual(parseProxyProtocolV2(Buffer.from('GET / HTTP/1.1\r\n')), { present: false, complete: true });
});

test('rejects an unsupported Proxy Protocol command', () => {
  const header = ipv4Header('203.0.113.42');
  header[12] = 0x20;
  assert.throws(() => parseProxyProtocolV2(header), /version or command/);
});
