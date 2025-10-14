const express = require('express');
const path = require('path');
const configManager = require('./utils/config');
const tcpProxy = require('./services/tcp-proxy');
const httpsTerminator = require('./services/https-terminator');
const frpc = require('./services/frpc-manager');
const { basicAuth } = require('./utils/auth');
const fs = require('fs').promises;
const { exec } = require('child_process');
const util = require('util');

// 路由
const indexRouter = require('./routes/index');
const apiRouter = require('./routes/api');

class App {
  constructor() {
    this.app = express();
    this.server = null;
  }

  async setupPermissions() {
    try {
      console.log('Setting up application permissions...');
      
      // 确保配置文件目录存在
      const configDir = process.env.CONFIG_DIR || path.join(__dirname, '..', '..', 'config');
      const logDir = path.join(__dirname, '..', '..', 'log');
      const frpcDir = path.join(__dirname, '..', '..', 'frpc');
      
      // 创建必要的目录
      await fs.mkdir(configDir, { recursive: true });
      await fs.mkdir(logDir, { recursive: true });
      await fs.mkdir(frpcDir, { recursive: true });
      
      // 确保production.json存在
      const productionConfig = path.join(configDir, 'production.json');
      const defaultConfig = path.join(configDir, 'default.json');
      
      try {
        await fs.access(productionConfig);
      } catch (err) {
        console.log('Creating production.json from default.json...');
        const defaultContent = await fs.readFile(defaultConfig, 'utf8');
        await fs.writeFile(productionConfig, defaultContent, 'utf8');
      }
      
      // 设置文件权限（如果以root用户运行）
      if (process.getuid && process.getuid() === 0) {
        console.log('Running as root, setting file permissions...');
        
        const execAsync = util.promisify(exec);
        
        try {
          // 设置文件所有权
          await execAsync(`chown -R 1001:1001 "${configDir}" "${logDir}" "${frpcDir}"`);
          
          // 设置文件权限
          await execAsync(`chmod -R 664 "${configDir}"/*.json`);
          await execAsync(`chmod 775 "${configDir}" "${logDir}" "${frpcDir}"`);
          
          console.log('File permissions set successfully');
        } catch (permErr) {
          console.warn('Warning: Could not set file permissions:', permErr.message);
        }
      }
      
      console.log('Permission setup completed');
    } catch (err) {
      console.error('Error setting up permissions:', err);
      // 不阻止应用启动，只记录错误
    }
  }

  setupMiddleware() {
    // 基本认证
    this.app.use(basicAuth);
    // 静态文件服务
    this.app.use(express.static(path.join(__dirname, '..', 'public')));
    // JSON解析
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
  }

  setupRoutes() {
    // API路由
    this.app.use('/api', apiRouter);
    // 主页路由
    this.app.use('/', indexRouter);
  }

  async startServices() {
    const config = configManager.getAll();
    // 启动TCP代理服务
    tcpProxy.start();
    console.log(`TCP代理服务已启动，监听端口: ${config.TCP_PROXY_PORT}`);
    // 启动HTTPS终止服务（可选）
    httpsTerminator.start();
    // 启动frpc服务
    if (await frpc.isInstalled()) {
      frpc.start();
      console.log('frpc 已启动，正在运行...');
    } else {
      console.log('frpc 未安装，无法暴露rdp到公网, 只能局域网连接, 请先安装和配置frpc');
    }
  }

  async stopServices() {
    // 停止TCP代理服务
    tcpProxy.stop();
    console.log('TCP代理服务已停止');
    // 停止frpc服务
    await frpc.stop();
    console.log('frpc 已停止');
  }

  async start() {
    // 1. 设置权限
    await this.setupPermissions();
    
    // 2. 启动前强制加载配置
    const env = process.env.NODE_ENV || 'default';
    await configManager.loadConfig(env);
    
    // 3. 初始化中间件和路由
    this.setupMiddleware();
    this.setupRoutes();
    
    // 4. 启动服务
    await this.startServices();
    
    // 5. 启动Web服务
    const config = configManager.getAll();
    const port = config.PORT || 9108;
    this.server = this.app.listen(port, () => {
      console.log(`服务器已启动，监听端口: ${port}`);
      console.log(`访问地址: http://localhost:${port}`);
    });
    
    // 优雅关闭
    process.on('SIGINT', async () => {
      console.log('正在关闭服务器...');
      await this.stopServices();
      if (this.server) {
        this.server.close(() => {
          console.log('服务器已关闭');
          process.exit(0);
        });
      } else {
        process.exit(0);
      }
    });
    process.on('SIGTERM', async () => {
      console.log('正在关闭服务器...');
      await this.stopServices();
      if (this.server) {
        this.server.close(() => {
          console.log('服务器已关闭');
          process.exit(0);
        });
      } else {
        process.exit(0);
      }
    });
  }
}

// 启动应用（保证配置优先加载）
(async () => {
  const app = new App();
  try {
    await app.start();
  } catch (error) {
    console.error('启动应用失败:', error);
    process.exit(1);
  }
})();

module.exports = App; 