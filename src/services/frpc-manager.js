const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs").promises;
const os = require("os");

// 根据操作系统确定frpc可执行文件路径
const getFrpcPath = () => {
  const platform = os.platform();
  if (platform === "win32") {
    return path.join(__dirname, "..", "..", "frpc", "frpc.exe");
  } else {
    return path.join(__dirname, "..", "..", "frpc", "frpc");
  }
};

// frpc 可执行文件路径
const frpcPath = getFrpcPath();
// frpc 配置文件路径
const configPath = path.join(
  process.env.CONFIG_DIR || path.join(__dirname, "..", "..", "config"),
  "frpc.toml"
);

class FrpcManager {
  constructor() {
    this.frpcProcess = null;
  }

  /**
   * 检查frpc是否安装(frpc可执行文件和frpc.toml是否存在)
   * @returns
   */
  isInstalled() {
    return Promise.all([fs.access(frpcPath), fs.access(configPath)])
      .then(() => {
        return true;
      })
      .catch(() => {
        return false;
      });
  }

  start() {
    if (this.frpcProcess) {
      return;
    }
    console.log("正在启动 frpc...");
    
    // 在Linux下确保frpc文件有执行权限
    if (os.platform() !== "win32") {
      try {
        const fsSync = require("fs");
        fsSync.chmodSync(frpcPath, 0o755);
      } catch (err) {
        console.warn("设置frpc执行权限失败:", err.message);
      }
    }
    
    this.frpcProcess = spawn(frpcPath, ["-c", configPath], {
      stdio: "inherit", // 将 frpc 的输出重定向到 Node.js 的控制台
    });
    // 监听 frpc 进程的退出事件
    this.frpcProcess.on("close", (code) => {
      console.log(`frpc 进程退出，退出码: ${code}`);
      this.frpcProcess = null;
    });

    // 监听错误事件
    this.frpcProcess.on("error", (err) => {
      console.error("启动 frpc 失败:", err);
      this.frpcProcess = null;
    });
    console.log("frpc 已启动，正在运行...");
  }

  stop() {
    return new Promise((resolve) => {
      try {
        if (!this.frpcProcess) {
          return resolve();
        }
        // 尝试使用 SIGTERM 优雅地关闭 frpc 进程
        this.frpcProcess.kill("SIGTERM");
        setTimeout(() => {
          if (this.frpcProcess) {
            this.frpcProcess.kill("SIGKILL"); // 强制杀死
            console.log("frpc 进程强制终止");
          }
          resolve();
        }, 1500); // 1.5 秒后强制杀死
      } catch (error) {
        resolve();
      }
    });
  }

  reStart() {
    console.log("尝试重启 frpc...");
    return new Promise((resolve) => {
      this.stop();
      setTimeout(() => {
        this.start();
        resolve();
      }, 2000);
    });
  }

  /**
   * 对指定代理配置进行注释或反注释
   * @param {string} proxyName - 代理名称
   * @param {boolean} comment - true 表示注释，false 表示反注释
   */
  async toggleProxyComment(proxyName, comment) {
    try {
      // 读取 TOML 文件内容
      const content = await fs.readFile(configPath, "utf8");
      const lines = content.split("\n");

      // 用于标记是否在目标代理块内
      let inTargetSection = false;
      // 代理块的起始和结束索引
      let startIdx = -1;
      let endIdx = -1;

      // 遍历每一行，找到目标代理块
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // 匹配代理块的开头 "[[proxies]]"
        if (line === "[[proxies]]" || line === "# [[proxies]]") {
          if (inTargetSection) {
            // 如果已经在目标块内，遇到新的 [[proxies]] 表示块结束
            endIdx = i - 1;
            break;
          } else {
            startIdx = i; // 记录潜在的起始位置
          }
        }

        // 检查 name 是否匹配
        if (
          startIdx !== -1 &&
          (line.startsWith(`name = "${proxyName}`) ||
            line.startsWith(`# name = "${proxyName}`))
        ) {
          inTargetSection = true;
        }

        // 如果到达文件末尾，结束当前块
        if (inTargetSection && i === lines.length - 1) {
          endIdx = i;
        }
      }

      if (startIdx === -1 || endIdx === -1) {
        console.error(`未找到代理配置 name = "${proxyName}"`);
        return;
      }

      // 修改目标块的每一行
      for (let i = startIdx; i <= endIdx; i++) {
        let line = lines[i].trim();
        if (!line) continue; // 跳过空行

        if (comment) {
          // 注释：如果未注释，则添加 "# "
          if (!line.startsWith("#")) {
            lines[i] = `# ${lines[i]}`;
          }
        } else {
          // 反注释：如果已注释，则移除 "# "
          if (line.startsWith("#")) {
            lines[i] = lines[i].replace(/^#\s?/, "");
          }
        }
      }

      // 将修改后的内容写回文件
      const newContent = lines.join("\n");
      await fs.writeFile(configPath, newContent, "utf8");
      console.log(
        `已${comment ? "注释" : "反注释"}代理配置 name = "${proxyName}"`
      );
    } catch (err) {
      console.error("操作失败:", err);
    }
  }

  /**
   * 检查代理配置是否已注释
   * @param {*} proxyName
   * @returns
   */
  async isProxyCommented(proxyName) {
    try {
      if(!proxyName || !await this.isInstalled()) {
        return false;
      }
      const content = await fs.readFile(configPath, "utf8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith(`# name = "${proxyName}`)) {
          return true;
        }
      }
      return false;
    } catch (err) {
      console.error("操作失败:", err);
      return false;
    }
  }
}

const frpcManager = new FrpcManager();

module.exports = frpcManager;
