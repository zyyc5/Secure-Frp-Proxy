const crypto = require('crypto');
const configManager = require('./config');
const { audit } = require('./audit-log');

const SESSION_COOKIE = 'srp_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

const buildSessionToken = (username, password) =>
  crypto.createHmac('sha256', password).update(`session:${username}`).digest('hex');

const parseCookies = (req) => {
  const header = req.headers.cookie;
  if (!header) return {};
  const cookies = {};
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq > 0) cookies[pair.substring(0, eq).trim()] = pair.substring(eq + 1).trim();
  }
  return cookies;
};

const setSessionCookie = (res, token, secure) => {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
};

// 添加基本认证中间件
const basicAuth = (req, res, next) => {
  try {
    // 临时访问链接路径跳过 Basic Auth（链接本身就是凭据）
    if (req.path.startsWith('/access/')) return next();

    const config = configManager.getAll();
    if (!config) {
      console.error('配置未加载，无法进行认证');
      return res.status(500).send("服务器配置错误");
    }
    
    const { USERNAME, PASSWORD } = config;
    if (!USERNAME || !PASSWORD) {
      return res.status(503).send('Authentication is not configured');
    }

    // 检查 session cookie，有效则跳过 Basic Auth
    const expectedToken = buildSessionToken(USERNAME, PASSWORD);
    const cookies = parseCookies(req);
    if (cookies[SESSION_COOKIE] === expectedToken) {
      return next();
    }

    // 获取请求头中的认证信息
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Restricted Area"');
      audit(req, 'auth_challenge');
      return res.status(401).send("认证失败：需要提供用户名和密码");
    }

    // 解析 Basic Auth 头
    const [scheme, encoded] = authHeader.split(/\s+/, 2);
    if (!encoded || scheme.toLowerCase() !== 'basic') {
      res.setHeader('WWW-Authenticate', 'Basic realm="Restricted Area"');
      return res.status(401).send('Invalid authorization');
    }
    const auth = Buffer.from(encoded, 'base64').toString('utf8');
    const separator = auth.indexOf(':');
    const username = separator >= 0 ? auth.slice(0, separator) : '';
    const password = separator >= 0 ? auth.slice(separator + 1) : '';

    // 验证用户名和密码
    if (username === USERNAME && password === PASSWORD) {
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      setSessionCookie(res, expectedToken, secure);
      audit(req, 'login', { result: 'success' });
      next();
    } else {
      res.setHeader("WWW-Authenticate", 'Basic realm="Restricted Area"');
      audit(req, 'login', { result: 'failed' });
      res.status(401).send("认证失败：用户名或密码错误");
    }
  } catch (error) {
    console.error('认证过程中发生错误:', error);
    res.status(500).send("服务器内部错误");
  }
};

const changePassword = async ({ userName, password }) => {
  if (!userName || !password || password.length < 12) return false;
  try {
    configManager.set('USERNAME', userName);
    configManager.set('PASSWORD', password);
    await configManager.saveEnvironmentValue('APP_USERNAME', userName);
    await configManager.saveEnvironmentValue('APP_PASSWORD', password);
    return true;
  } catch (error) {
    console.log(error);
  }
  return false;
};

const getUserName = () => {
  const config = configManager.getAll();
  return config ? config.USERNAME : 'admin';
};

module.exports = { basicAuth, changePassword, getUserName }; 
