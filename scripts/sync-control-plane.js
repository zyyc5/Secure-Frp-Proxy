const fs = require('node:fs/promises');
const path = require('node:path');
const { loadEnvFile, setEnvValue } = require('../src/utils/env');

const DAY = 24 * 60 * 60 * 1000;
const isHttpsTerminatorEnabled = () => process.env.HTTPS_TERMINATOR_ENABLED?.trim().toLowerCase() === 'true';

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

const request = async (baseUrl, apiKey, requestPath, options = {}, fetchFn = fetch) => {
  const response = await fetchFn(new URL(`/api/v1${requestPath}`, baseUrl), {
    ...options,
    headers: { 'X-API-Key': apiKey, ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${requestPath}: ${body.message || body.error || response.status}`);
  return body;
};

const getConfigDir = (configDir) => path.resolve(configDir || process.env.CONFIG_DIR || path.join(__dirname, '..', 'config'));

const loadControlPlaneEnvironment = async (configDir) => {
  const resolvedConfigDir = getConfigDir(configDir);
  const envPath = path.join(resolvedConfigDir, '.env');
  await loadEnvFile(envPath);
  return { configDir: resolvedConfigDir, envPath };
};

const certificatePaths = (configDir) => ({
  certificate: path.join(configDir, 'certs', 'fullchain.cer'),
  privateKey: path.join(configDir, 'certs', 'privkey.key')
});

const certificateFilesExist = async (configDir) => {
  const files = certificatePaths(configDir);
  try {
    await Promise.all([fs.access(files.certificate), fs.access(files.privateKey)]);
    return true;
  } catch (_) {
    return false;
  }
};

const syncCertificate = async ({ configDir, envPath, baseUrl, apiKey, fetchFn, setEnvValueFn = setEnvValue, writeFileFn = writeFile }) => {
  if (!isHttpsTerminatorEnabled()) return { checked: false, updated: false, skipped: 'https_terminator_disabled' };
  const domain = process.env.CONTROL_PLANE_CERT_DOMAIN?.trim();
  if (!domain) return { checked: false, updated: false };

  const domainPath = `/domains/${encodeURIComponent(domain)}`;
  const metadata = await request(baseUrl, apiKey, domainPath, {}, fetchFn);
  const currentVersion = process.env.CONTROL_PLANE_CERTIFICATE_VERSION?.trim();
  const hasFiles = await certificateFilesExist(configDir);
  if (metadata.version && metadata.version === currentVersion && hasFiles) {
    return { checked: true, updated: false, version: metadata.version };
  }

  const certificate = await request(baseUrl, apiKey, `${domainPath}/certificate`, {}, fetchFn);
  if (!certificate.certificate || !certificate.privateKey) throw new Error('Certificate response is incomplete');
  const files = certificatePaths(configDir);
  await writeFileFn(files.certificate, certificate.certificate);
  await writeFileFn(files.privateKey, certificate.privateKey);
  const version = certificate.version || metadata.version;
  if (version) {
    await setEnvValueFn(envPath, 'CONTROL_PLANE_CERTIFICATE_VERSION', version);
    process.env.CONTROL_PLANE_CERTIFICATE_VERSION = version;
  }
  console.log(`Certificate ${domain} version ${version || 'current'} saved to ${path.dirname(files.certificate)}`);
  return { checked: true, updated: true, version };
};

const syncControlPlane = async ({ configDir, fetchFn, setEnvValueFn = setEnvValue, writeFileFn = writeFile } = {}) => {
  const environment = await loadControlPlaneEnvironment(configDir);
  const baseUrl = required('CONTROL_PLANE_URL');
  const apiKey = required('CONTROL_PLANE_API_KEY');
  let clientId = process.env.CONTROL_PLANE_CLIENT_ID?.trim();
  const needsClientId = !clientId;

  const tcpLocalPort = Number(process.env.CONTROL_PLANE_TCP_LOCAL_PORT || process.env.TCP_PROXY_PORT || 13389);
  const httpsLocalPort = Number(process.env.CONTROL_PLANE_HTTPS_LOCAL_PORT || process.env.HTTPS_TERMINATOR_PORT || 9443);
  const frpcPath = path.resolve(process.env.CONTROL_PLANE_FRPC_PATH || path.join(environment.configDir, 'frpc.toml'));
  const initializationPath = needsClientId ? '/clients/initialize' : `/clients/${encodeURIComponent(clientId)}/initialize`;
  const initialization = await request(baseUrl, apiKey, initializationPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tcpLocalPort, httpsLocalPort })
  }, fetchFn);

  if (needsClientId) {
    clientId = initialization.clientId?.trim();
    if (!clientId) throw new Error('Control plane did not return a clientId');
    await setEnvValueFn(environment.envPath, 'CONTROL_PLANE_CLIENT_ID', clientId);
    process.env.CONTROL_PLANE_CLIENT_ID = clientId;
  }
  await writeFileFn(frpcPath, initialization.frpcConfig);
  if (Array.isArray(initialization.tunnels)) {
    const tunnelsPath = path.join(environment.configDir, 'control-plane-tunnels.json');
    await writeFileFn(tunnelsPath, JSON.stringify({
      clientId,
      version: initialization.version || null,
      tunnels: initialization.tunnels,
      syncedAt: new Date().toISOString()
    }, null, 2) + '\n');
  }
  let certificate;
  try {
    certificate = await syncCertificate({ ...environment, baseUrl, apiKey, fetchFn, setEnvValueFn, writeFileFn });
  } catch (error) {
    certificate = { checked: true, updated: false, error: error.message };
    console.warn(`Certificate sync skipped: ${error.message}`);
  }
  console.log(`FRPC configuration for ${clientId} saved to ${frpcPath}`);
  return { clientId, frpcPath, tunnels: initialization.tunnels || [], certificate };
};

const checkCertificateUpdate = async ({ configDir, fetchFn, setEnvValueFn, writeFileFn } = {}) => {
  const environment = await loadControlPlaneEnvironment(configDir);
  if (!isHttpsTerminatorEnabled()) return { checked: false, updated: false, skipped: 'https_terminator_disabled' };
  return syncCertificate({ ...environment, baseUrl: required('CONTROL_PLANE_URL'), apiKey: required('CONTROL_PLANE_API_KEY'), fetchFn, setEnvValueFn, writeFileFn });
};

const startCertificateUpdateScheduler = ({ onUpdated, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, intervalMs = DAY, ...options } = {}) => {
  let stopped = false;
  let timer;
  const schedule = () => {
    timer = setTimeoutFn(async () => {
      try {
        const result = await checkCertificateUpdate(options);
        if (result.updated) await onUpdated?.(result);
      } catch (error) {
        console.error(`Certificate update check failed: ${error.message}`);
      } finally {
        if (!stopped) schedule();
      }
    }, intervalMs);
    timer.unref?.();
  };
  schedule();
  return () => { stopped = true; if (timer) clearTimeoutFn(timer); };
};

if (require.main === module) {
  syncControlPlane().catch((error) => { console.error(`Control-plane sync failed: ${error.message}`); process.exitCode = 1; });
}

module.exports = { DAY, certificatePaths, checkCertificateUpdate, startCertificateUpdateScheduler, syncControlPlane };
