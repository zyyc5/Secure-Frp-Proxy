const PROXY_PROTOCOL_V2_SIGNATURE = Buffer.from([
  0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x0D, 0x0A, 0x51, 0x55, 0x49, 0x54, 0x0A
]);
const FIXED_HEADER_LENGTH = 16;
const MAX_HEADER_LENGTH = 512;

const normalizeIP = (remote) => {
  if (!remote) return '';
  if (remote === '::1') return '127.0.0.1';
  return remote.startsWith('::ffff:') ? remote.substring(7) : remote;
};

const ipv6FromBuffer = (buffer) => {
  const parts = [];
  for (let offset = 0; offset < 16; offset += 2) {
    parts.push(buffer.readUInt16BE(offset).toString(16));
  }
  return parts.join(':');
};

const parseProxyProtocolV2 = (buffer) => {
  if (buffer.length < PROXY_PROTOCOL_V2_SIGNATURE.length) return { complete: false };
  if (!buffer.subarray(0, 12).equals(PROXY_PROTOCOL_V2_SIGNATURE)) return { present: false, complete: true };
  if (buffer.length < FIXED_HEADER_LENGTH) return { present: true, complete: false };

  const versionAndCommand = buffer[12];
  const familyAndProtocol = buffer[13];
  const payloadLength = buffer.readUInt16BE(14);
  if ((versionAndCommand >> 4) !== 0x2 || (versionAndCommand & 0x0F) !== 0x1) {
    throw new Error('Unsupported Proxy Protocol v2 version or command');
  }
  if (payloadLength > MAX_HEADER_LENGTH) throw new Error('Proxy Protocol v2 header is too large');
  if (buffer.length < FIXED_HEADER_LENGTH + payloadLength) return { present: true, complete: false };

  const family = familyAndProtocol >> 4;
  const protocol = familyAndProtocol & 0x0F;
  if (protocol !== 0x1) throw new Error('Unsupported Proxy Protocol v2 transport');

  let sourceIP;
  if (family === 0x1 && payloadLength >= 12) {
    sourceIP = Array.from(buffer.subarray(16, 20)).join('.');
  } else if (family === 0x2 && payloadLength >= 36) {
    sourceIP = ipv6FromBuffer(buffer.subarray(16, 32));
  } else {
    throw new Error('Unsupported Proxy Protocol v2 address family');
  }

  return {
    present: true,
    complete: true,
    clientIP: normalizeIP(sourceIP),
    headerLength: FIXED_HEADER_LENGTH + payloadLength
  };
};

module.exports = {
  PROXY_PROTOCOL_V2_SIGNATURE,
  normalizeIP,
  parseProxyProtocolV2
};
