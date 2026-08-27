const net = require('net');
const path = require('path');
const rdpManager = require('./rdp-manager');
const configManager = require('../utils/config');
const { createDailyLogger } = require('../utils/logger');
const { parseProxyProtocolV2 } = require('../utils/proxy-protocol');

// 配置
const CONNECTION_TIMEOUT = 30000;
const LOG_DIRECTORY = path.join(__dirname, '..', '..', 'log');

// 获取当前代理目标地址
const getCurrentProxyTarget = () => {
  try {
    const config = configManager.getAll();
    const currentTargetId = config.CURRENT_PROXY_TARGET || 'default';
    const target = config.PROXY_TARGETS.find(t => t.id === currentTargetId);
    
    if (target) {
      return {
        host: target.host,
        port: target.port
      };
    }
    
    // 如果没有找到目标，使用默认配置
    return {
      host: '127.0.0.1',
      port: '3389'
    };
  } catch (error) {
    console.error('获取代理目标失败:', error);
    return {
      host: '127.0.0.1',
      port: 3389
    };
  }
};

const logger = createDailyLogger(LOG_DIRECTORY, 'proxy_connections');
let nextConnectionSequence = 0;

const createConnectionId = () => {
  nextConnectionSequence = (nextConnectionSequence + 1) % 1_000_000;
  return `tcp-${Date.now().toString(36)}-${nextConnectionSequence}`;
};

// 工具函数：规范化 IP
const normalizeIP = (remote)=>{
  if (!remote) return '';
  if (remote === '::1') return '127.0.0.1';
  return remote.startsWith('::ffff:') ? remote.substring(7) : remote;
}

// 工具函数：HTTP 判定（含 WebSocket 握手），大小写不敏感
const HTTP_METHODS_RE = /^(GET|POST|HEAD|PUT|DELETE|OPTIONS|PATCH)\s/i;
const HTTP_VERSION_RE = /HTTP\/(1\.[01]|2)/i;
const WS_UPGRADE_RE = /\nupgrade:\s*websocket/i;
const CONN_UPGRADE_RE = /\nconnection:\s*upgrade/i;
const isHttpLikeText = (text)=>{
  if (!text) return false;
  return HTTP_METHODS_RE.test(text) ||
    HTTP_VERSION_RE.test(text) ||
    WS_UPGRADE_RE.test(text) ||
    CONN_UPGRADE_RE.test(text);
}

// 工具函数：从数据中解析 Host 子域前缀
const parseHostSubPrefix = (buf)=>{
  try {
    const headStr = buf.toString('utf8');
    // console.log('headStr', headStr);
    if(!headStr) {
      console.log('headStr is empty');
    }
    if (!isHttpLikeText(headStr)) return { isHttp: false, subPrefix: null };
    const hostMatch = headStr.match(/\n[Hh]ost:\s*([^\r\n]+)/);
    if (!hostMatch || !hostMatch[1]) return { isHttp: true, subPrefix: null };
    let hostHeader = hostMatch[1].trim();
    if (hostHeader.includes(':')) hostHeader = hostHeader.split(':')[0];
    const firstDot = hostHeader.indexOf('.');
    const subPrefix = firstDot > 0 ? hostHeader.substring(0, firstDot) : hostHeader;
    return { isHttp: true, subPrefix };
  } catch {
    return { isHttp: false, subPrefix: null };
  }
}

// 选择目标：根据子域匹配 name，未命中回退当前目标
const selectTarget = (subPrefix)=>{
  const config = configManager.getAll();
  if (subPrefix && Array.isArray(config?.PROXY_TARGETS)) {
    const hit = config.PROXY_TARGETS.find(t => String(t?.name || '').toLowerCase() === subPrefix.toLowerCase());
    if (hit) return { host: hit.host, port: hit.port, matched: true };
  }
  const fb = getCurrentProxyTarget();
  return { host: fb.host, port: fb.port, matched: false };
}

// 建立转发并写入首包
const connectAndPipe = (clientSocket, target, firstPacket, log) => {
  const upstream = net.createConnection(
    { host: target.host, port: target.port },
    () => {
      if (firstPacket && firstPacket.length > 0) upstream.write(firstPacket);
      log(`upstream connected target=${target.host}:${target.port}`);
    }
  );

  upstream.setTimeout(CONNECTION_TIMEOUT, () => {
    log(`upstream timeout target=${target.host}:${target.port}`);
    upstream.destroy();
    clientSocket.destroy();
  });

  clientSocket.pipe(upstream);
  upstream.pipe(clientSocket);

  upstream.on('error', (err) => {
    console.error(`Upstream socket error: ${err.message}`);
    log(`upstream error target=${target.host}:${target.port} error=${err.message}`);
    clientSocket.end();
  });
  clientSocket.on('error', (err) => {
    console.error(`Client socket error: ${err.message}`);
    log(`client socket error error=${err.message}`);
    upstream.end();
  });
  upstream.on('end', () => {
    clientSocket.end();
  });
  clientSocket.on('end', () => {
    upstream.end();
  });
}

// 创建 TCP 服务器
const server = net.createServer((clientSocket) => {
  const connectionId = createConnectionId();
  const log = (message) => logger(`connection=${connectionId} ${message}`);
  log(`opened peer=${normalizeIP(clientSocket.remoteAddress || '')}:${clientSocket.remotePort || 'unknown'}`);
  clientSocket.setTimeout(CONNECTION_TIMEOUT, () => {
    log('client connection timeout');
    clientSocket.destroy();
  });
  clientSocket.once('close', (hadError) => log(`closed had_error=${hadError}`));
  let isFirstData = true;
  let received = Buffer.alloc(0);
  const handleData = (data) => {
    try {
      let clientIP = '';
      let appData = data;

      if(isFirstData) {
        received = Buffer.concat([received, data]);
        const proxyHeader = parseProxyProtocolV2(received);
        if (!proxyHeader.complete) {
          clientSocket.once('data', handleData);
          return;
        }
        isFirstData = false;
        if (proxyHeader.present) {
          clientIP = proxyHeader.clientIP;
          log(`accepted ip=${clientIP} proxy_protocol=v2`);
          if(!rdpManager.isAnyWhiteList(clientIP)){
            log(`refused ip=${clientIP} reason=not_whitelisted`);
            clientSocket.end();
            return;
          }
          appData = received.slice(proxyHeader.headerLength);
        } else {
          clientIP = normalizeIP(clientSocket.remoteAddress || '');
          log(`accepted ip=${clientIP} proxy_protocol=absent`);
          if(!rdpManager.isAnyWhiteList(clientIP)){
            log(`refused ip=${clientIP} reason=not_whitelisted`);
            clientSocket.end();
            return;
          }
        }
      }

      // 无数据, 等下次数据
      if(!appData || appData.length === 0) {
        clientSocket.once('data', handleData);
        return;
      }

      // 统一：Host 子域匹配与回退
      const { isHttp, subPrefix } = parseHostSubPrefix(appData);
      const chosen = selectTarget(subPrefix);
      if (isHttp && chosen.matched) {
        log(`route protocol=http host=${subPrefix} target=${chosen.host}:${chosen.port} matched=true`);
      } else if (isHttp) {
        log(`route protocol=http host=${subPrefix || 'unknown'} target=${chosen.host}:${chosen.port} matched=false`);
      } else {
        log(`route protocol=tcp target=${chosen.host}:${chosen.port}`);
      }

      // 建立转发
      connectAndPipe(clientSocket, { host: chosen.host, port: chosen.port }, appData, log);
    } catch (err) {
      log(`processing error error=${err.message}`);
      console.error(`Error processing data: ${err.message}`);
      clientSocket.end();
    }
  };

  clientSocket.once('data', handleData);
});

// 服务器错误处理
server.on('error', (err) => {
  console.error('Server error:', err.message);
  logger(`Server error: ${err.message}`);
});

// 启动服务器
const start = () => {
  const config = configManager.getAll();
  const LISTEN_PORT = config.TCP_PROXY_PORT;
  
  server.listen(LISTEN_PORT, () => {
    console.log(`RDP Proxy listening on port ${LISTEN_PORT}`);
  });
}

const stop = () => {
  server.close(() => {
    console.log('RDP Proxy stopped');
  });
}

module.exports = {
  start,
  stop
} 
