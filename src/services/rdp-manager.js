const { exec } = require("child_process");
const fs = require("fs").promises;
const path = require("path");
const whiteListPath = path.join(process.env.CONFIG_DIR || path.join(__dirname, "..", "..", "config"), "whitelist.ini");

// 配置
const CHECK_INTERVAL = 60000; // 检查间隔：1分钟
const TIMEOUT = 5 * 60000; // 5分钟超时

// 存储最后一次检查时间
let lastCheckTime = null;

class RDPManager {
  constructor() {
    this.isRunning = false;
    // 临时白名单
    this.tempWhiteList = []; // {  ip: string, time: number }
    // 白名单
    this.whiteList = []; // ['127.0.0.1']
    this.ready = this.initWhiteList();
  }

  /**
   * 添加临时白名单(如果已存在的话,进行续期-有效期延长120秒)
   * @param {*} ip
   */
  addTempWhiteList(ip) {
    const dip = this.tempWhiteList.find((item) => item.ip === ip);
    if (dip) {
      dip.time = Date.now() + 120 * 1000;
    } else {
      this.tempWhiteList.push({ ip, time: Date.now() + 120 * 1000 });
    }
  }

  /**
   *  判断临时白名单
   * @param {*} ip
   * @returns
   */
  isTempWhiteList(ip) {
    return !!this.tempWhiteList.find(
      (item) => item.ip === ip && item.time > Date.now()
    );
  }

  /**
   * 初始化白名单
   */
  async initWhiteList() {
    try {
      await fs.access(whiteListPath);
    } catch (err) {
      await fs.appendFile(whiteListPath, "127.0.0.1\n0.0.0.0");
    }
    const content = await fs.readFile(whiteListPath, "utf8");
    this.whiteList = content.split("\n").filter((line) => line.trim());
  }

  addWhiteList(ip) {
    if (!ip || this.whiteList.includes(ip)) return;
    this.whiteList.push(ip);
    return fs.appendFile(whiteListPath, "\n" + ip);
  }

  removeWhiteList(ip) {
    this.whiteList = this.whiteList.filter((item) => item !== ip);
    return fs.writeFile(whiteListPath, this.whiteList.join("\n") + "\n");
  }

  /**
   * 是否在任何白名单中
   * @param {*} ip
   * @returns
   */
  isWhiteList(ip) {
    return this.whiteList.includes(ip);
  }

  /**
   * 检查ip是否在白名单中
   * @param {*} ip
   * @returns 0-不在白名单中, 1-在白名单中, 2-在临时白名单中
   */
  isAnyWhiteList(ip) {
    if (this.isWhiteList(ip)) {
      return 1;
    }
    if (this.isTempWhiteList(ip)) {
      return 2;
    }
    return 0;
  }

  // 获取远程桌面服务状态
  getRDPStatus() {
    return new Promise((resolve, reject) => {
      exec(
        'reg query "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" /v fDenyTSConnections',
        (error, stdout, stderr) => {
          if (error) {
            console.error(`获取远程桌面服务状态失败：${error.message}`);
            resolve(false);
            return;
          }
          resolve(stdout.includes("0x0"));
        }
      );
    });
  }

  // 启用远程桌面服务
  enableRDP() {
    return new Promise((resolve, reject) => {
      exec(
        'reg add "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f',
        (error, stdout, stderr) => {
          if (error) {
            console.error(`启用远程桌面服务失败：${error.message}`);
            resolve(false);
            return;
          }
          resolve(true);
          console.log("远程桌面服务已启用");
        }
      );
    });
  }

  // 关闭远程桌面服务
  disableRDP() {
    return new Promise((resolve) => {
      exec(
        'reg add "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 1 /f',
        (error, stdout, stderr) => {
          if (error) {
            console.error(`关闭远程桌面服务失败：${error.message}`);
            resolve(false);
            return;
          }
          resolve(true);
          console.log("远程桌面服务已关闭");
        }
      );
    });
  }

  async monitor() {
    if (this.isRunning) {
      try {
        // 检查服务是否运行
        const isRunService = await this.getRDPStatus();

        if (isRunService) {
          if (lastCheckTime === null) {
            lastCheckTime = Date.now();
          }

          // 检查是否超过超时时间
          const currentTime = Date.now();
          if (currentTime - lastCheckTime > TIMEOUT) {
            console.log("超过5分钟, 关闭远程桌面服务, 不影响已经登录的用户");
            await this.disableRDP();
          }
        }
      } catch (error) {
        console.error("监控过程中发生错误:", error);
      }
    }
    setTimeout(() => {
      this.monitor();
    }, CHECK_INTERVAL);
  }

  reSet() {
    lastCheckTime = null;
  }

  startMonitor() {
    this.isRunning = true;
    this.monitor();
  }

  stopMonitor() {
    this.isRunning = false;
  }
}

module.exports = new RDPManager(); 
