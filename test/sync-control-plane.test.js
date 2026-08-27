const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { certificatePaths, startCertificateUpdateScheduler, syncControlPlane } = require('../scripts/sync-control-plane');

const controlPlaneFetch = async (url, options = {}) => {
  const requestPath = new URL(url).pathname;
  if (requestPath.includes('/clients/')) {
    assert.equal(options.method, 'POST');
    return new Response(JSON.stringify({ clientId: 'edge-server-generated-id', frpcConfig: 'serverAddr = "frps.example.test"\n' }), { status: 201 });
  }
  if (requestPath.includes('/domains/') && !requestPath.includes('/certificate')) {
    return new Response(JSON.stringify({ version: 'certificate-v1' }), { status: 200 });
  }
  if (requestPath.includes('/certificate')) {
    return new Response(JSON.stringify({ version: 'certificate-v1', certificate: 'certificate-data', privateKey: 'private-key-data' }), { status: 200 });
  }
  throw new Error(`Unexpected request: ${requestPath}`);
};

const withCleanControlPlaneEnvironment = async (callback) => {
  const keys = ['CONTROL_PLANE_URL', 'CONTROL_PLANE_API_KEY', 'CONTROL_PLANE_CLIENT_ID', 'CONTROL_PLANE_CERT_DOMAIN', 'CONTROL_PLANE_CERTIFICATE_VERSION', 'HTTPS_TERMINATOR_ENABLED'];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => delete process.env[key]);
  try { await callback(); } finally {
    keys.forEach((key) => {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    });
  }
};

test('initializes a missing control-plane client ID and stores certificate files', async () => {
  await withCleanControlPlaneEnvironment(async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'secure-rdp-control-plane-'));
    try {
      await fs.writeFile(path.join(configDir, '.env'), 'CONTROL_PLANE_URL=http://control-plane.test\nCONTROL_PLANE_API_KEY=api-key\nCONTROL_PLANE_CLIENT_ID=\nCONTROL_PLANE_CERT_DOMAIN=proxy.example.test\nHTTPS_TERMINATOR_ENABLED=true\n');
      let certificateDownloads = 0;
      const fetchFn = async (url, options) => {
        if (new URL(url).pathname.endsWith('/certificate')) certificateDownloads += 1;
        return controlPlaneFetch(url, options);
      };
      const result = await syncControlPlane({ configDir, fetchFn });
      const env = await fs.readFile(path.join(configDir, '.env'), 'utf8');
      const files = certificatePaths(configDir);
      assert.equal(result.clientId, 'edge-server-generated-id');
      assert.match(env, /^CONTROL_PLANE_CLIENT_ID=edge-server-generated-id$/m);
      assert.match(env, /^CONTROL_PLANE_CERTIFICATE_VERSION=certificate-v1$/m);
      assert.equal(await fs.readFile(path.join(configDir, 'frpc.toml'), 'utf8'), 'serverAddr = "frps.example.test"\n');
      assert.equal(await fs.readFile(files.certificate, 'utf8'), 'certificate-data');
      assert.equal(await fs.readFile(files.privateKey, 'utf8'), 'private-key-data');
      await syncControlPlane({ configDir, fetchFn });
      assert.equal(certificateDownloads, 1);
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });
});

test('skips certificate requests when HTTPS Terminator is disabled', async () => {
  await withCleanControlPlaneEnvironment(async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'secure-rdp-control-plane-'));
    try {
      await fs.writeFile(path.join(configDir, '.env'), 'CONTROL_PLANE_URL=http://control-plane.test\nCONTROL_PLANE_API_KEY=api-key\nCONTROL_PLANE_CLIENT_ID=edge-a\nCONTROL_PLANE_CERT_DOMAIN=proxy.example.test\nHTTPS_TERMINATOR_ENABLED=false\n');
      let domainRequests = 0;
      const result = await syncControlPlane({ configDir, fetchFn: async (url, options) => {
        if (new URL(url).pathname.includes('/domains/')) domainRequests += 1;
        return controlPlaneFetch(url, options);
      } });
      assert.equal(result.certificate.skipped, 'https_terminator_disabled');
      assert.equal(domainRequests, 0);
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });
});

test('keeps FRPC synchronization successful when certificate lookup fails', async () => {
  await withCleanControlPlaneEnvironment(async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'secure-rdp-control-plane-'));
    try {
      await fs.writeFile(path.join(configDir, '.env'), 'CONTROL_PLANE_URL=http://control-plane.test\nCONTROL_PLANE_API_KEY=api-key\nCONTROL_PLANE_CLIENT_ID=edge-a\nCONTROL_PLANE_CERT_DOMAIN=missing.example.test\nHTTPS_TERMINATOR_ENABLED=true\n');
      const result = await syncControlPlane({ configDir, fetchFn: async (url, options) => {
        if (new URL(url).pathname.includes('/domains/')) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        return controlPlaneFetch(url, options);
      } });
      assert.match(result.certificate.error, /not_found/);
      assert.equal(await fs.readFile(path.join(configDir, 'frpc.toml'), 'utf8'), 'serverAddr = "frps.example.test"\n');
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });
});

test('schedules the next certificate check with setTimeout', () => {
  let callback;
  let delay;
  let cleared = false;
  const stop = startCertificateUpdateScheduler({
    setTimeoutFn: (fn, ms) => { callback = fn; delay = ms; return { unref() {} }; },
    clearTimeoutFn: () => { cleared = true; },
    intervalMs: 123
  });
  assert.equal(typeof callback, 'function');
  assert.equal(delay, 123);
  stop();
  assert.equal(cleared, true);
});
