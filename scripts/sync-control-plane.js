const fs = require('node:fs/promises');
const path = require('node:path');

const loadEnvFile = async () => {
  const envPath = path.join(__dirname, '..', '.env');
  let content;
  try { content = await fs.readFile(envPath, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
};

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const writeFile = async (filePath, content) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, content, { mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
};

const request = async (baseUrl, apiKey, requestPath, options = {}) => {
  const response = await fetch(new URL(`/api/v1${requestPath}`, baseUrl), { ...options, headers: { 'X-API-Key': apiKey, ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${requestPath}: ${body.message || body.error || response.status}`);
  return body;
};

(async () => {
  await loadEnvFile();
  const baseUrl = required('CONTROL_PLANE_URL');
  const apiKey = required('CONTROL_PLANE_API_KEY');
  const clientId = required('CONTROL_PLANE_CLIENT_ID');
  const tcpLocalPort = Number(process.env.CONTROL_PLANE_TCP_LOCAL_PORT || 13389);
  const httpsLocalPort = Number(process.env.CONTROL_PLANE_HTTPS_LOCAL_PORT || 9443);
  const configDir = path.resolve(process.env.CONFIG_DIR || path.join(__dirname, '..', 'config'));
  const frpcPath = path.resolve(process.env.CONTROL_PLANE_FRPC_PATH || path.join(configDir, 'frpc.control-plane.toml'));
  const initialization = await request(baseUrl, apiKey, `/clients/${encodeURIComponent(clientId)}/initialize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tcpLocalPort, httpsLocalPort })
  });
  await writeFile(frpcPath, initialization.frpcConfig);

  const certificateDomain = process.env.CONTROL_PLANE_CERT_DOMAIN?.trim();
  if (certificateDomain) {
    const certificate = await request(baseUrl, apiKey, `/domains/${encodeURIComponent(certificateDomain)}/certificate`);
    const certificateDir = path.join(configDir, 'certs');
    await writeFile(path.join(certificateDir, 'fullchain.cer'), certificate.certificate);
    await writeFile(path.join(certificateDir, 'privkey.key'), certificate.privateKey);
    console.log(`Certificate ${certificateDomain} version ${certificate.version || 'current'} saved to ${certificateDir}`);
  }
  console.log(`FRPC configuration for ${clientId} saved to ${frpcPath}`);
})().catch((error) => { console.error(`Control-plane sync failed: ${error.message}`); process.exit(1); });
