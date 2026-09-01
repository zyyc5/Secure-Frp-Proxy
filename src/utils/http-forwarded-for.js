const { Transform } = require('stream');

const injectForwardedFor = (packet, clientIP) => {
  const headerEnd = packet.indexOf('\r\n\r\n');
  if (headerEnd === -1) return packet;

  const headerLines = packet.subarray(0, headerEnd).toString('latin1').split('\r\n');
  const filteredHeaders = headerLines.filter((line) => !/^x-forwarded-for\s*:/i.test(line));
  filteredHeaders.push(`X-Forwarded-For: ${clientIP}`);
  const headers = `${filteredHeaders.join('\r\n')}\r\n\r\n`;
  return Buffer.concat([Buffer.from(headers, 'latin1'), packet.subarray(headerEnd + 4)]);
};

class ForwardedForTransform extends Transform {
  constructor(clientIP) {
    super();
    this.clientIP = clientIP;
    this.buffer = Buffer.alloc(0);
    this.mode = 'headers';
    this.remaining = 0;
  }

  _transform(chunk, encoding, callback) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      this.processBuffer();
      callback();
    } catch (error) {
      callback(error);
    }
  }

  processBuffer() {
    while (this.buffer.length > 0) {
      if (this.mode === 'raw') {
        this.push(this.buffer);
        this.buffer = Buffer.alloc(0);
        return;
      }

      if (this.mode === 'headers') {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const request = this.buffer.subarray(0, headerEnd + 4);
        this.buffer = this.buffer.subarray(headerEnd + 4);
        const headers = request.toString('latin1');
        this.push(injectForwardedFor(request, this.clientIP));

        if (/\r\nupgrade:\s*websocket\s*\r?$/im.test(headers)) {
          this.mode = 'raw';
          continue;
        }
        const transferEncoding = headers.match(/\r\ntransfer-encoding:\s*([^\r\n]+)/i)?.[1] || '';
        if (/\bchunked\b/i.test(transferEncoding)) {
          this.mode = 'chunk-size';
          continue;
        }
        const contentLength = headers.match(/\r\ncontent-length:\s*(\d+)\s*$/im)?.[1];
        if (contentLength !== undefined) {
          this.remaining = Number(contentLength);
          this.mode = this.remaining === 0 ? 'headers' : 'fixed-body';
        }
        continue;
      }

      if (this.mode === 'fixed-body') {
        const length = Math.min(this.remaining, this.buffer.length);
        this.push(this.buffer.subarray(0, length));
        this.buffer = this.buffer.subarray(length);
        this.remaining -= length;
        if (this.remaining > 0) return;
        this.mode = 'headers';
        continue;
      }

      if (this.mode === 'chunk-size') {
        const lineEnd = this.buffer.indexOf('\r\n');
        if (lineEnd === -1) return;
        const size = Number.parseInt(this.buffer.subarray(0, lineEnd).toString('ascii').split(';')[0], 16);
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid HTTP chunk size');
        this.push(this.buffer.subarray(0, lineEnd + 2));
        this.buffer = this.buffer.subarray(lineEnd + 2);
        this.remaining = size;
        this.mode = size === 0 ? 'chunk-trailers' : 'chunk-data';
        continue;
      }

      if (this.mode === 'chunk-data') {
        if (this.buffer.length < this.remaining + 2) return;
        this.push(this.buffer.subarray(0, this.remaining + 2));
        this.buffer = this.buffer.subarray(this.remaining + 2);
        this.mode = 'chunk-size';
        continue;
      }

      if (this.buffer.subarray(0, 2).equals(Buffer.from('\r\n'))) {
        this.push(this.buffer.subarray(0, 2));
        this.buffer = this.buffer.subarray(2);
        this.mode = 'headers';
        continue;
      }
      const trailerEnd = this.buffer.indexOf('\r\n\r\n');
      if (trailerEnd === -1) return;
      this.push(this.buffer.subarray(0, trailerEnd + 4));
      this.buffer = this.buffer.subarray(trailerEnd + 4);
      this.mode = 'headers';
    }
  }
}

module.exports = { injectForwardedFor, ForwardedForTransform };
