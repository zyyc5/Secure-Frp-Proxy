const net = require('net');
const configManager = require('../utils/config');
const frpc = require('./frpc-manager');
const frpcConfig = require('./frpc-config');
const proxyInstances = require('./dedicated-proxy-instances');
const controlPlane = require('./control-plane-client');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const reservedPorts = () => {
  const config = configManager.getAll();
  return new Set([
    Number(config.PORT),
    Number(config.TCP_PROXY_PORT),
    Number(config.HTTPS_TERMINATOR?.port),
    ...(config.TUNNELS || []).map((tunnel) => Number(tunnel.localPort))
  ].filter(Number.isFinite));
};

const isPortBindable = (port) => new Promise((resolve) => {
  const server = net.createServer();
  const fail = (result) => { server.removeAllListeners('error'); server.close(() => resolve(result)); };
  server.once('error', () => resolve(false));
  server.listen(port, '127.0.0.1', () => fail(true));
});

const nextCursor = () => {
  const config = configManager.getAll();
  const dedicatedPorts = (config.TUNNELS || []).filter((tunnel) => tunnel.role === 'dedicated').map((tunnel) => Number(tunnel.localPort));
  return Math.max(Number(config.TCP_PROXY_PORT || 13389) + 1, ...dedicatedPorts.map((port) => port + 1), 1);
};

const syncFromControlPlane = async (initialization) => {
  const config = configManager.getAll();
  const previous = new Map((config.TUNNELS || []).map((tunnel) => [tunnel.id, tunnel]));
  const tunnels = (initialization?.tunnels || []).map((row) => {
    const old = previous.get(row.tunnelId);
    const id = row.role === 'builtin'
      ? (row.protocol === 'https' ? 'common-https' : 'common-tcp')
      : row.tunnelId;
    return {
      id,
      role: row.role || (String(row.tunnelId).startsWith('builtin-') ? 'builtin' : 'dedicated'),
      protocol: row.protocol,
      name: old?.name || row.name || (row.protocol === 'https' ? '通用 HTTPS' : '通用 TCP'),
      localHost: row.localHost || '127.0.0.1',
      localPort: Number(row.localPort),
      remotePort: Number(row.remotePort),
      proxyName: row.proxyName,
      targetId: old?.targetId || null,
      status: old?.status || 'stopped'
    };
  });
  if (!tunnels.length) return false;
  const tunnelIdSet = new Set(tunnels.map((tunnel) => tunnel.id));
  (config.PROXY_TARGETS || []).forEach((target) => {
    if (!['common', 'common-tcp', 'common-https'].includes(target.tunnelId || 'common') && !tunnelIdSet.has(target.tunnelId)) target.tunnelId = 'common';
  });
  if (config.CURRENT_PROXY_TARGET) {
    const currentTarget = (config.PROXY_TARGETS || []).find((target) => target.id === config.CURRENT_PROXY_TARGET);
    if (currentTarget && currentTarget.tunnelId !== 'common' && currentTarget.tunnelId !== 'common-tcp' && currentTarget.tunnelId !== 'common-https') {
      config.CURRENT_PROXY_TARGET = ((config.PROXY_TARGETS || []).find((target) => ['common', 'common-tcp'].includes(target.tunnelId || 'common')))?.id || (config.PROXY_TARGETS || [])[0]?.id;
    }
  }
  config.TUNNELS = tunnels;
  config.TUNNEL_LOCAL_PORT_CURSOR = Math.max(nextCursor(), Number(config.TUNNEL_LOCAL_PORT_CURSOR || 0));
  await configManager.saveConfig();
  return true;
};

const allocateLocalPort = async (requestedPort) => {
  const reserved = reservedPorts();
  let port = Number(requestedPort);
  if (!Number.isFinite(port)) {
    const config = configManager.getAll();
    port = Math.max(Number(config.TUNNEL_LOCAL_PORT_CURSOR || 0), nextCursor());
  }
  while (port <= 65535) {
    if (!reserved.has(port) && await isPortBindable(port)) {
      configManager.set('TUNNEL_LOCAL_PORT_CURSOR', port + 1);
      return port;
    }
    port += 1;
  }
  throw Object.assign(new Error('没有可用本地端口'), { code: 'no_local_ports_available' });
};

const serialize = (tunnel) => ({
  ...tunnel,
  builtin: tunnel.role === 'builtin',
  running: tunnel.role === 'builtin' ? undefined : proxyInstances.isRunning(tunnel.id)
});

const list = () => (configManager.getAll().TUNNELS || []).map(serialize);

const get = (tunnelId) => (configManager.getAll().TUNNELS || []).find((tunnel) => tunnel.id === tunnelId);

const setStatus = async (tunnelId, status) => {
  const config = configManager.getAll();
  const tunnel = (config.TUNNELS || []).find((entry) => entry.id === tunnelId);
  if (tunnel) {
    tunnel.status = status;
    await configManager.saveConfig();
  }
};

let operationQueue = Promise.resolve();

const withTunnelLock = (operation) => {
  operationQueue = operationQueue.catch(() => {}).then(operation);
  return operationQueue;
};

const create = (options) => withTunnelLock(() => createLocked(options));

const createLocked = async ({ name, protocol = 'tcp', localPort, targetId = null }) => {
  if (!controlPlane.isConfigured()) throw Object.assign(new Error('控制面未配置'), { code: 'control_plane_not_configured' });
  const normalizedProtocol = protocol === 'https' ? 'https' : 'tcp';
  const allocatedPort = await allocateLocalPort(localPort);
  let remote;
  try {
    remote = await controlPlane.createDedicatedTunnel({
      protocol: normalizedProtocol,
      localPort: allocatedPort,
      name: name || `${normalizedProtocol} dedicated tunnel`
    });
  } catch (error) {
    throw error;
  }

  const config = configManager.getAll();
  const tunnel = {
    id: remote.tunnel.tunnelId,
    role: 'dedicated',
    protocol: normalizedProtocol,
    name: name || remote.tunnel.name || `专用 ${normalizedProtocol.toUpperCase()} 隧道`,
    localHost: remote.tunnel.localHost || '127.0.0.1',
    localPort: Number(remote.tunnel.localPort),
    remotePort: Number(remote.tunnel.remotePort),
    proxyName: remote.tunnel.proxyName,
    targetId: targetId || null,
    status: 'created'
  };
  config.TUNNELS = [...(config.TUNNELS || []), tunnel];
  config.TUNNEL_LOCAL_PORT_CURSOR = Math.max(Number(config.TUNNEL_LOCAL_PORT_CURSOR || 0), tunnel.localPort + 1);
  try {
    await frpcConfig.appendProxyConfig(remote.proxyConfig, tunnel.id);
    await configManager.saveConfig();
    const started = await proxyInstances.start(tunnel);
    tunnel.status = started ? 'restarting' : 'proxy_error';
    await configManager.saveConfig();
    if (started) scheduleFrpcRestart(tunnel.id);
    return serialize(tunnel);
  } catch (error) {
    tunnel.status = 'error';
    await configManager.saveConfig();
    try { await controlPlane.deleteDedicatedTunnel(tunnel.id); } catch (_) {}
    await frpcConfig.removeTunnel(tunnel.id);
    await proxyInstances.stop(tunnel.id);
    await configManager.saveConfig();
    throw error;
  }
};

const remove = (tunnelId) => withTunnelLock(() => removeLocked(tunnelId));

const removeLocked = async (tunnelId) => {
  const tunnel = get(tunnelId);
  if (!tunnel) throw Object.assign(new Error('隧道不存在'), { code: 'tunnel_not_found' });
  if (tunnel.role !== 'dedicated') throw Object.assign(new Error('内置隧道不可删除'), { code: 'builtin_tunnel_not_removable' });
  if (tunnel.targetId) throw Object.assign(new Error('请先解绑目标'), { code: 'tunnel_target_bound' });
  await proxyInstances.stop(tunnelId);
  await controlPlane.deleteDedicatedTunnel(tunnelId);
  await frpcConfig.removeTunnel(tunnelId);
  const config = configManager.getAll();
  config.TUNNELS = (config.TUNNELS || []).filter((entry) => entry.id !== tunnelId);
  await configManager.saveConfig();
  scheduleFrpcRestart(tunnelId);
};

const startDedicated = async () => {
  const tunnels = (configManager.getAll().TUNNELS || []).filter((tunnel) => tunnel.role === 'dedicated');
  for (const tunnel of tunnels) {
    const started = await proxyInstances.start(tunnel);
    await setStatus(tunnel.id, started ? 'running' : 'proxy_error');
  }
};

const stopDedicated = () => proxyInstances.stopAll();

module.exports = {
  allocateLocalPort,
  create,
  get,
  list,
  remove,
  startDedicated,
  stopDedicated,
  syncFromControlPlane
};
