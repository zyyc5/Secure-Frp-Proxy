const configManager = require('./config');

// 添加基本认证中间件
const basicAuth = (req, res, next) => {
  try {
    const config = configManager.getAll();
    if (!config) {
      console.error('配置未加载，无法进行认证');
      return res.status(500).send("服务器配置错误");
    }
    
    const { USERNAME, PASSWORD } = config;
    if (!USERNAME || !PASSWORD) {
      return res.status(503).send('Authentication is not configured');
    }

    // 获取请求头中的认证信息
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Restricted Area"');
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
      next(); // 认证通过，继续处理请求
    } else {
      res.setHeader("WWW-Authenticate", 'Basic realm="Restricted Area"');
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
    await configManager.saveConfig();
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
