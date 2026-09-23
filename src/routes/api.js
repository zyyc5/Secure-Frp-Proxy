const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const rdpManager = require('../services/rdp-manager');
const frpc = require('../services/frpc-manager');
const { changePassword, getUserName } = require('../utils/auth');
const configManager = require('../utils/config');
const { getRecentConnections, getIpSummary, getIpDetail } = require('../services/connection-log');
const accessLink = require('../services/access-link');
const { audit } = require('../utils/audit-log');
const { getRecentAuditLog } = require('../utils/audit-log');
const tunnelManager = require('../services/tunnel-manager');
const controlPlane = require('../services/control-plane-client');

const normalizeTargetInput = ({ name, host, port, description, access, tunnelId }) => {
  const numericPort = Number(port);
  const normalizedName = String(name || '').trim();
  const normalizedHost = String(host || '').trim();
  if (!normalizedName || !normalizedHost || !Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) return null;
  if (access !== undefined && access !== 'public' && access !== 'protected') return null;
  return { name: normalizedName, host: normalizedHost, port: numericPort, description: String(description || '').trim(), access: access || 'protected', tunnelId: tunnelId || 'common' };
};

const findTunnel = (config, tunnelId) => (config?.TUNNELS || []).find((tunnel) => tunnel.id === tunnelId);

const validateTunnelBinding = (config, tunnelId, targetId, previousTargetId = null) => {
  if (!tunnelId || tunnelId === 'common' || tunnelId === 'common-tcp' || tunnelId === 'common-https') return tunnelId;
  const tunnel = findTunnel(config, tunnelId);
  if (!tunnel || tunnel.role !== 'dedicated') throw Object.assign(new Error('指定隧道不存在'), { code: 'tunnel_not_found', status: 400 });
  if (tunnel.targetId && tunnel.targetId !== targetId && tunnel.targetId !== previousTargetId) throw Object.assign(new Error('隧道已被其他目标绑定'), { code: 'tunnel_target_bound', status: 409 });
  return tunnelId;
};

const isDuplicateName = (values, name, excludeId = null) => {
  const normalized = String(name || '').trim().toLowerCase();
  return values.some((item) => item && item.id !== excludeId && String(item.name || '').trim().toLowerCase() === normalized);
};

const bindTunnel = (config, target) => {
  const generic = ['common', 'common-tcp', 'common-https'];
  (config.TUNNELS || []).forEach((tunnel) => {
    if (tunnel.role === 'dedicated' && tunnel.targetId === target.id) tunnel.targetId = null;
  });
  if (!generic.includes(target.tunnelId)) {
    const tunnel = findTunnel(config, target.tunnelId);
    if (tunnel) tunnel.targetId = target.id;
  }
};

const readPublicPorts = () => {
  const configDir = process.env.CONFIG_DIR || path.join(__dirname, '..', '..', 'config');
  try {
    const content = fs.readFileSync(path.join(configDir, 'frpc.toml'), 'utf8');
    const ports = [];
    let currentName = 'frpc.toml';
    for (const line of content.split(/\r?\n/)) {
      const name = line.match(/^\s*name\s*=\s*["']([^"']+)["']/);
      if (name) currentName = name[1];
      const port = line.match(/^\s*remotePort\s*=\s*(\d+)/);
      if (port) ports.push({ name: currentName, port: Number(port[1]), channel: 'FRP' });
    }
    return ports;
  } catch (_) {
    return [];
  }
};

// 获取客户端IP地址
const getIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = req.app.get('trust proxy') && forwarded
    ? forwarded.split(',')[0].trim()
    : req.socket.remoteAddress;
  return (ip || '').replace('::ffff:', '');
};

// 统一错误响应格式
const sendError = (res, status, message, code) => {
  res.status(status).json({ error: message, code: code || `http_${status}` });
};

// 获取代理目标地址列表
router.get('/proxy-targets', (req, res) => {
  const config = configManager.getAll();
  if (!config) {
    return sendError(res, 500, '读取配置失败');
  }

  res.json({
    targets: config.PROXY_TARGETS || [],
    currentTarget: config.CURRENT_PROXY_TARGET || 'default'
  });
});

// 隧道管理
router.get('/tunnels', (req, res) => {
  const config = configManager.getAll();
  res.json({
    tunnels: tunnelManager.list(),
    nextLocalPort: config.TUNNEL_LOCAL_PORT_CURSOR || (config.TCP_PROXY_PORT || 13389) + 1,
    controlPlaneConfigured: controlPlane.isConfigured()
  });
});

const restartAfterResponse = (res, tunnelId) => {
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => tunnelManager.restart(tunnelId), 1000);
  };
  res.once('finish', schedule);
  res.once('close', schedule);
};

router.post('/tunnels', async (req, res) => {
  try {
    const config = configManager.getAll();
    if (isDuplicateName(config?.TUNNELS || [], req.body?.name)) {
      return sendError(res, 409, '隧道名称已存在', 'tunnel_name_duplicate');
    }
    const tunnel = await tunnelManager.create(req.body || {});
    audit(req, 'create_tunnel', { id: tunnel.id, protocol: tunnel.protocol, remote_port: tunnel.remotePort, local_port: tunnel.localPort });
    res.json({ success: true, tunnel });
    restartAfterResponse(res, tunnel.id);
  } catch (error) {
    console.error('创建隧道失败:', error);
    const code = error.code || 'create_tunnel_failed';
    const status = { control_plane_not_configured: 503, no_local_ports_available: 509, no_remote_ports_available: 503, local_port_in_use: 409, tunnel_name_duplicate: 409 }[code] || 500;
    sendError(res, status, error.message || '创建隧道失败', code);
  }
});

router.delete('/tunnels/:id', async (req, res) => {
  try {
    await tunnelManager.remove(req.params.id);
    audit(req, 'delete_tunnel', { id: req.params.id });
    res.json({ success: true });
    restartAfterResponse(res, req.params.id);
  } catch (error) {
    console.error('删除隧道失败:', error);
    const code = error.code || 'delete_tunnel_failed';
    const status = { tunnel_not_found: 404, builtin_tunnel_not_removable: 400, tunnel_target_bound: 409, control_plane_not_configured: 503 }[code] || 500;
    sendError(res, status, error.message || '删除隧道失败', code);
  }
});

// 添加代理目标地址
router.post('/proxy-targets', async (req, res) => {
  const targetInput = normalizeTargetInput(req.body);
  if (!targetInput) {
    return sendError(res, 400, '名称、主机地址和端口为必填项');
  }

  try {
    const config = configManager.getAll();
    if (!config) {
      return sendError(res, 500, '读取配置失败');
    }

    const newId = Date.now().toString();
    if (isDuplicateName(config.PROXY_TARGETS || [], targetInput.name)) {
      return sendError(res, 409, '目标名称已存在', 'target_name_duplicate');
    }
    targetInput.tunnelId = validateTunnelBinding(config, targetInput.tunnelId, newId);
    const newTarget = {
      id: newId,
      ...targetInput
    };
    config.PROXY_TARGETS = config.PROXY_TARGETS || [];
    config.PROXY_TARGETS.push(newTarget);
    bindTunnel(config, newTarget);
    configManager.set('PROXY_TARGETS', config.PROXY_TARGETS);
    configManager.set('TUNNELS', config.TUNNELS);
    await configManager.saveConfig();

    audit(req, 'add_target', { name: newTarget.name, host: newTarget.host, port: newTarget.port, access: newTarget.access });
    res.json({ success: true, target: newTarget });
  } catch (error) {
    console.error('保存配置失败:', error);
    sendError(res, 500, '保存配置失败');
  }
});

router.put('/proxy-targets/:id', async (req, res) => {
  const targetInput = normalizeTargetInput(req.body);
  if (!targetInput) return sendError(res, 400, '目标配置无效');
  try {
    const config = configManager.getAll();
    const targetIndex = config?.PROXY_TARGETS?.findIndex((target) => target.id === req.params.id) ?? -1;
    if (targetIndex < 0) return sendError(res, 404, '目标地址不存在');
    if (isDuplicateName(config.PROXY_TARGETS || [], targetInput.name, req.params.id)) {
      return sendError(res, 409, '目标名称已存在', 'target_name_duplicate');
    }
    targetInput.tunnelId = validateTunnelBinding(config, targetInput.tunnelId, req.params.id, (config.PROXY_TARGETS[targetIndex] || {}).tunnelId);
    const previousTarget = config.PROXY_TARGETS[targetIndex];
    const updatedTarget = { ...previousTarget, id: req.params.id, ...targetInput };
    config.PROXY_TARGETS[targetIndex] = updatedTarget;
    bindTunnel(config, updatedTarget);
    configManager.set('TUNNELS', config.TUNNELS);
    await configManager.saveConfig();
    audit(req, 'update_target', { id: updatedTarget.id, name: updatedTarget.name, host: updatedTarget.host, port: updatedTarget.port });
    res.json({ success: true, target: updatedTarget });
  } catch (error) {
    console.error('更新代理目标失败:', error);
    sendError(res, 500, '更新代理目标失败');
  }
});

// 保存代理目标排序
router.post('/proxy-targets/reorder', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return sendError(res, 400, '排序数据格式错误');
  try {
    const config = configManager.getAll();
    const targets = Array.isArray(config?.PROXY_TARGETS) ? config.PROXY_TARGETS : [];
    if (ids.length !== targets.length || new Set(ids).size !== targets.length || targets.some((target) => !ids.includes(target.id))) {
      return sendError(res, 400, '排序数据与目标列表不一致');
    }
    configManager.set('PROXY_TARGETS', ids.map((id) => targets.find((target) => target.id === id)));
    await configManager.saveConfig();
    audit(req, 'reorder_targets', { count: ids.length });
    res.json({ success: true });
  } catch (error) {
    console.error('保存目标排序失败:', error);
    sendError(res, 500, '保存目标排序失败');
  }
});

// 删除代理目标地址
router.delete('/proxy-targets/:id', async (req, res) => {
  if (req.params.id === 'self') return sendError(res, 400, '内置 self 目标不可删除');
  const { id } = req.params;

  try {
    const config = configManager.getAll();
    if (!config) {
      return sendError(res, 500, '读取配置失败');
    }

    (config.TUNNELS || []).forEach((tunnel) => {
      if (tunnel.targetId === id) tunnel.targetId = null;
    });

    config.PROXY_TARGETS = config.PROXY_TARGETS.filter(target => target.id !== id);

    // 如果删除的是当前目标，重置为默认目标
    if (config.CURRENT_PROXY_TARGET === id) {
      config.CURRENT_PROXY_TARGET = config.PROXY_TARGETS.length > 0 ? config.PROXY_TARGETS[0].id : 'default';
    }

    configManager.set('PROXY_TARGETS', config.PROXY_TARGETS);
    configManager.set('CURRENT_PROXY_TARGET', config.CURRENT_PROXY_TARGET);
    await configManager.saveConfig();

    audit(req, 'delete_target', { id, wasCurrent: config.CURRENT_PROXY_TARGET !== id });
    res.json({ success: true });
  } catch (error) {
    console.error('保存配置失败:', error);
    sendError(res, 500, '保存配置失败');
  }
});

// 设置当前代理目标
router.post('/proxy-targets/:id/set-current', async (req, res) => {
  const { id } = req.params;

  try {
    const config = configManager.getAll();
    if (!config) {
      return sendError(res, 500, '读取配置失败');
    }

    const targetExists = config.PROXY_TARGETS.some(target => target.id === id);
    const currentTarget = config.PROXY_TARGETS.find(target => target.id === id);
    if (currentTarget?.tunnelId && !['common', 'common-tcp', 'common-https'].includes(currentTarget.tunnelId)) {
      return sendError(res, 400, '专用隧道目标不能设为通用回退目标');
    }
    if (!targetExists) {
      return sendError(res, 400, '目标地址不存在');
    }

    configManager.set('CURRENT_PROXY_TARGET', id);
    await configManager.saveConfig();

    audit(req, 'switch_target', { id });
    res.json({ success: true });
  } catch (error) {
    console.error('保存配置失败:', error);
    sendError(res, 500, '保存配置失败');
  }
});

// RDP服务控制
router.post('/enable', (req, res) => {
  try {
    rdpManager.enableRDP();
    rdpManager.reSet();
    audit(req, 'rdp_enable');
    res.json({ success: true, message: 'RDP服务开启成功' });
  } catch (error) {
    console.error('开启RDP服务失败:', error);
    sendError(res, 500, '开启RDP服务失败');
  }
});

router.post('/disable', (req, res) => {
  try {
    rdpManager.disableRDP();
    audit(req, 'rdp_disable');
    res.json({ success: true, message: 'RDP服务关闭成功' });
  } catch (error) {
    console.error('关闭RDP服务失败:', error);
    sendError(res, 500, '关闭RDP服务失败');
  }
});

// 白名单管理
router.post('/joinwhitelist', (req, res) => {
  try {
    const ip = getIp(req);
    rdpManager.addWhiteList(ip);
    audit(req, 'whitelist_add', { target_ip: ip });
    res.json({ success: true, message: '已加入白名单' });
  } catch (error) {
    console.error('加入白名单失败:', error);
    sendError(res, 500, '加入白名单失败');
  }
});

router.post('/removewhitelist', (req, res) => {
  try {
    const ip = getIp(req);
    rdpManager.removeWhiteList(ip);
    audit(req, 'whitelist_remove', { target_ip: ip });
    res.json({ success: true, message: '已移出白名单' });
  } catch (error) {
    console.error('移出白名单失败:', error);
    sendError(res, 500, '移出白名单失败');
  }
});

// 代理控制
router.post('/openproxy', async (req, res) => {
  try {
    frpc.toggleProxyComment('remote2', false);
    await frpc.reStart();
    audit(req, 'proxy_open');
    res.json({ success: true, message: '代理开启成功' });
  } catch (error) {
    console.error('开启代理失败:', error);
    sendError(res, 500, '开启代理失败');
  }
});

router.post('/closeproxy', async (req, res) => {
  try {
    frpc.toggleProxyComment('remote2', true);
    await frpc.reStart();
    audit(req, 'proxy_close');
    res.json({ success: true, message: '代理关闭成功' });
  } catch (error) {
    console.error('关闭代理失败:', error);
    sendError(res, 500, '关闭代理失败');
  }
});

// 密码修改
router.post('/change-password', async (req, res) => {
  const { userName, newPassword, confirmPassword } = req.body;

  if (newPassword !== confirmPassword) {
  return sendError(res, 400, '两次输入的密码不一致');
  }

  if (!newPassword || newPassword.length < 12) {
  return sendError(res, 400, '密码长度必须至少 12 位');
  }

  try {
    const changed = await changePassword({ userName, password: newPassword });
    if (!changed) return sendError(res, 400, '密码不符合要求或保存失败');
    audit(req, 'change_password', { result: 'success' });
    res.json({ success: true, message: '密码修改成功，请使用新密码重新登录！' });
  } catch (error) {
    console.error('密码修改失败:', error);
    sendError(res, 500, '密码修改失败');
  }
});

// 获取页面数据的API
router.get('/page-data', async (req, res) => {
  try {
    const isWindows = process.platform === 'win32';
    const [appStatus, isFrpcInstalled, proxyStatus] = await Promise.all([
      isWindows ? rdpManager.getRDPStatus() : Promise.resolve(false),
      frpc.isInstalled(),
      frpc.isProxyCommented('remote2'),
    ]);

    const ip = getIp(req);
    rdpManager.addTempWhiteList(ip);
    const isInWhiteList = rdpManager.isWhiteList(ip);

    // 如果不在白名单中，则提示临时白名单,并出一个连接的截止时间(两分钟后)
    const whiteListStatus = isInWhiteList
      ? '已加入白名单'
      : `连接有效期至: ${new Date(Date.now() + 120000).toLocaleString()}`;

    // 检测操作系统

    const pageData = {
      isWindows: isWindows,
      rdpStatus: appStatus ? '已启用' : '已关闭',
      rdpEnableDisabled: appStatus ? 'none' : 'block',
      rdpDisableDisabled: appStatus ? 'block' : 'none',
      proxyStatus: isFrpcInstalled ? (proxyStatus ? '关闭' : '开启') : '未安装',
      proxyOpenDisabled: !isFrpcInstalled || !proxyStatus ? 'none' : 'block',
      proxyCloseDisabled: isFrpcInstalled && !proxyStatus ? 'block' : 'none',
      whiteListRemoveDisabled: isInWhiteList ? 'block' : 'none',
      whiteListJoinDisabled: !isInWhiteList ? 'block' : 'none',
      userName: getUserName() || '未登录',
      IP: ip,
      publicPorts: readPublicPorts(),
      whiteListStatus: whiteListStatus
    };

    res.json(pageData);
  } catch (error) {
    console.error('获取页面数据失败:', error);
    sendError(res, 500, '获取页面数据失败');
  }
});

// 最近连接记录
router.get('/connections', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const type = req.query.type === 'https' ? 'https' : 'tcp';
  res.json(getRecentConnections(limit, type));
});

// IP 聚合汇总（全量日志按 IP 去重）
router.get('/connections/summary', (req, res) => {
  const type = req.query.type === 'https' ? 'https' : 'tcp';
  res.json(getIpSummary(type));
});

// 单个 IP 的连接详情
router.get('/connections/detail', (req, res) => {
  const ip = String(req.query.ip || '').trim();
  if (!ip) return sendError(res, 400, '缺少 ip 参数');
  const type = req.query.type === 'https' ? 'https' : 'tcp';
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  res.json(getIpDetail(ip, type, limit));
});

// 生成临时访问链接
router.post('/access-link', (req, res) => {
  const ttlMinutes = Math.min(Math.max(Number(req.body?.ttlMinutes) || 15, 1), 60);
  const { token, expiresAt } = accessLink.createLink(ttlMinutes * 60 * 1000);
  const config = configManager.getAll();
  const forwardedProto = req.app.get('trust proxy') ? req.headers['x-forwarded-proto'] : null;
  const protocol = forwardedProto || (config?.HTTPS_TERMINATOR?.enabled ? 'https' : 'http');
  audit(req, 'create_access_link', { ttl_minutes: ttlMinutes });
  res.json({ success: true, url: `${protocol}://${req.get('host')}/access/${token}`, expiresAt: new Date(expiresAt).toISOString(), ttlMinutes });
});

// 操作审计日志
router.get('/audit-log', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  res.json({ entries: getRecentAuditLog(limit) });
});

module.exports = router;
