const net = require('net');
const fs = require('fs');
const path = require('path');
const rdpManager = require('./rdp-manager');
const configManager = require('../utils/config');

// 配置
const LOG_FILE = path.join(__dirname, '..', '..', 'log', 'proxy_connections.log'); // 日志文件路径

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

// Proxy Protocol v2 签名
const PROXY_PROTOCOL_V2_SIGNATURE = Buffer.from([
  0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x0D, 0x0A, 0x51, 0x55, 0x49, 0x54, 0x0A
]);

const logger = (log)=>{
  const logEntry = `${new Date().toLocaleString()} - ${log} \n`;
  console.log(logEntry);
  fs.appendFile(LOG_FILE, logEntry, {}, ()=>{});
}

// 工具函数：规范化 IP
const normalizeIP = (remote)=>{
  if (!remote) return '';
  if (remote === '::1') return '127.0.0.1';
  return remote.startsWith('::ffff:') ? remote.substring(7) : remote;
}

// 工具函数：HTTP 判定
const isHttpLikeText = (text)=>{
  if (!text) return false;
  return text.startsWith('GET ') ||
    text.startsWith('POST ') ||
    text.startsWith('HEAD ') ||
    text.startsWith('PUT ') ||
    text.startsWith('DELETE ') ||
    text.startsWith('OPTIONS ') ||
    text.startsWith('PATCH ') ||
    text.includes('HTTP/1.1') ||
    text.includes('HTTP/2');
}

// 工具函数：从数据中解析 Host 子域前缀
const parseHostSubPrefix = (buf)=>{
  try {
    const headStr = buf.toString('utf8');
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
const connectAndPipe = (clientSocket, target, firstPacket)=>{
  const upstream = net.createConnection(
    { host: target.host, port: target.port },
    () => {
      if (firstPacket && firstPacket.length > 0) upstream.write(firstPacket);
    }
  );

  clientSocket.pipe(upstream);
  upstream.pipe(clientSocket);

  upstream.on('error', (err) => {
    console.error(`Upstream socket error: ${err.message}`);
    clientSocket.end();
  });
  clientSocket.on('error', (err) => {
    console.error(`Client socket error: ${err.message}`);
    upstream.end();
  });
  upstream.on('end', () => {
    clientSocket.end();
    logger('connection closed');
  });
  clientSocket.on('end', () => {
    upstream.end();
  });
}

// 创建 TCP 服务器
const server = net.createServer((clientSocket) => {
  console.log('New connection received');

  clientSocket.once('data', async (data) => {
    try {
      let clientIP = '';
      let appData = data;
      let isPpv2 = false;

      // 检查 Proxy Protocol v2 签名
      if (data.slice(0, 12).equals(PROXY_PROTOCOL_V2_SIGNATURE)) {
        const familyAndProtocol = data[13];
        const length = data.readUInt16BE(14);
        const addressFamily = familyAndProtocol >> 4;
        const protocol = familyAndProtocol & 0x0F;
        if (protocol !== 0x1) throw new Error('Unsupported protocol (only TCP supported)');
        if (addressFamily === 0x1) {
          clientIP = `${data[16]}.${data[17]}.${data[18]}.${data[19]}`;
        } else if (addressFamily === 0x2) {
          const ipv6Bytes = data.slice(16, 32);
          clientIP = ipv6Bytes.toString('hex').match(/.{1,4}/g).join(':').replace(/(^|:)0+/g, '$1');
        } else {
          throw new Error('Unsupported address family');
        }
        logger(`new connent: ${clientIP}`);
        if(!rdpManager.isAnyWhiteList(clientIP)){
          logger(`refuse connent: ${clientIP}`);
          clientSocket.end();
          return;
        }
        appData = data.slice(16 + length);
        isPpv2 = true;
      } else {
        clientIP = normalizeIP(clientSocket.remoteAddress || '');
        logger(`new connent(no proxy proto): ${clientIP}`);
        if(!rdpManager.isAnyWhiteList(clientIP)){
          logger(`refuse connent: ${clientIP}`);
          clientSocket.end();
          return;
        }
      }

      // 统一：Host 子域匹配与回退
      const { isHttp, subPrefix } = parseHostSubPrefix(appData);
      const chosen = selectTarget(subPrefix);
      if (isHttp && chosen.matched) {
        logger(`${isPpv2 ? 'ppv2 ' : ''}http host matched target by name: ${subPrefix} -> ${chosen.host}:${chosen.port}`);
      } else if (isHttp) {
        logger(`${isPpv2 ? 'ppv2 ' : ''}http host no match by name: ${subPrefix}, fallback to current target`);
      }

      // 建立转发
      connectAndPipe(clientSocket, { host: chosen.host, port: chosen.port }, appData);
      
    } catch (err) {
      logger(`Error processing data: ${err.message}`);
      console.error(`Error processing data: ${err.message}`);
      clientSocket.end();
    }
  });
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