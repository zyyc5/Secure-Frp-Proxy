const fs = require('fs').promises;
const path = require('path');

class ConfigManager {
  constructor() {
    this.config = null;
    this.configPath = null;
  }

  /**
   * 加载配置文件
   * @param {string} env - 环境名称 (default, production)
   */
  async loadConfig(env = 'default') {
    try {
      // 尝试从环境变量获取配置文件路径
      const configDir = process.env.CONFIG_DIR || path.join(__dirname, '..', '..', 'config');
      const configFile = path.join(configDir, `${env}.json`);
      
      // 检查配置文件是否存在
      try {
        await fs.access(configFile);
        this.configPath = configFile;
      } catch (err) {
        // 如果指定环境配置文件不存在，使用默认配置
        const defaultConfigFile = path.join(configDir, 'default.json');
        try {
          await fs.access(defaultConfigFile);
          this.configPath = defaultConfigFile;
          console.log(`[WARNING] ${env}.json 不存在，使用 default.json`);
        } catch (defaultErr) {
          throw new Error(`配置文件不存在: ${configFile} 或 ${defaultConfigFile}`);
        }
      }

      // 检查文件权限
      try {
        await fs.access(this.configPath, fs.constants.R_OK | fs.constants.W_OK);
      } catch (permErr) {
        console.error(`[ERROR] 配置文件权限不足: ${this.configPath}`);
        console.error(`[ERROR] 请确保应用有读写权限，错误详情: ${permErr.message}`);
        throw new Error(`配置文件权限不足: ${this.configPath}`);
      }

      // 读取配置文件
      const configData = await fs.readFile(this.configPath, 'utf8');
      this.config = JSON.parse(configData);

      // 应用环境变量覆盖
      this.applyEnvironmentOverrides();
      this.validate();

      console.log(`配置文件已加载: ${this.configPath}`);
      return this.config;
    } catch (err) {
      console.error('加载配置文件失败:', err);
      throw err;
    }
  }

  /**
   * 应用环境变量覆盖
   */
  applyEnvironmentOverrides() {
    if (process.env.PORT) {
      this.config.PORT = Number(process.env.PORT);
    }
    if (process.env.TCP_PROXY_PORT) {
      this.config.TCP_PROXY_PORT = Number(process.env.TCP_PROXY_PORT);
    }
    if (process.env.APP_USERNAME) {
      this.config.USERNAME = process.env.APP_USERNAME;
    }
    if (process.env.APP_PASSWORD) {
      this.config.PASSWORD = process.env.APP_PASSWORD;
    }
  }

  validate() {
    const c = this.config;
    if (!c || !c.USERNAME || !c.PASSWORD) throw new Error('USERNAME and PASSWORD are required');
    for (const key of ['PORT', 'TCP_PROXY_PORT']) {
      if (!Number.isInteger(c[key]) || c[key] < 1 || c[key] > 65535) {
        throw new Error(`${key} must be an integer between 1 and 65535`);
      }
    }
    if (!Array.isArray(c.PROXY_TARGETS)) c.PROXY_TARGETS = [];
    for (const target of c.PROXY_TARGETS) {
      if (!target || !target.name || !target.host || !Number.isInteger(Number(target.port)) || Number(target.port) < 1 || Number(target.port) > 65535) {
        throw new Error('Invalid proxy target');
      }
      target.port = Number(target.port);
    }
  }

  /**
   * 获取配置值
   * @param {string} key - 配置键
   * @param {*} defaultValue - 默认值
   */
  get(key, defaultValue = null) {
    return this.config ? this.config[key] : defaultValue;
  }

  /**
   * 设置配置值
   * @param {string} key - 配置键
   * @param {*} value - 配置值
   */
  set(key, value) {
    if (this.config) {
      this.config[key] = value;
    }
  }

  /**
   * 保存配置到文件
   */
  async saveConfig() {
    if (!this.configPath || !this.config) {
      throw new Error('配置未加载');
    }

    try {
      // 检查写权限
      await fs.access(path.dirname(this.configPath), fs.constants.W_OK);
      
      // 尝试写入文件
      const tempPath = `${this.configPath}.${process.pid}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(this.config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tempPath, this.configPath);
      console.log(`配置已保存到: ${this.configPath}`);
    } catch (err) {
      console.error('保存配置文件失败:', err);
      console.error(`[ERROR] 无法写入文件: ${this.configPath}`);
      console.error(`[ERROR] 请检查文件权限和磁盘空间`);
      console.error(`[ERROR] 错误详情: ${err.message}`);
      
      // 提供解决方案建议
      if (err.code === 'EACCES') {
        console.error(`[SOLUTION] 权限问题解决方案:`);
        console.error(`1. 在Linux/macOS上运行: chmod 664 ${this.configPath}`);
        console.error(`2. 在Windows上以管理员身份运行: icacls "${this.configPath}" /grant Everyone:F`);
        console.error(`3. 重新构建Docker镜像: docker-compose down && docker-compose up -d --build`);
      }
      
      throw err;
    }
  }

  /**
   * 获取所有配置
   */
  getAll() {
    return this.config;
  }
}

// 创建单例实例
const configManager = new ConfigManager();

module.exports = configManager; 
