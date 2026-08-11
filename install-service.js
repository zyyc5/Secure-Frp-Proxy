const { Service } = require("node-windows");
const path = require("path");
const exec = require("child_process").exec;
const configManager = require("./src/utils/config");

// 创建Windows服务
const appSvc = new Service({
  name: "SecureFrp-ProxyService",
  description: "Secure Expose RDP service",
  runAsAdmin: true,
  script: path.join(__dirname, "src", "production.js"),
});

appSvc.on("install", () => {
  appSvc.start();
  console.log("Windows服务已安装并启动");
});
appSvc.on("start", async () => {
  console.log("Windows服务已启动");
  try {
    await configManager.loadConfig("production");
    const config = configManager.getAll();
    const port = config.PORT || 9108;
    exec(`start http://127.0.0.1:${port}`);
  } catch (error) {
    console.error("启动浏览器失败:", error);
  }
});

appSvc.on("error", (err) => {
  console.error("Windows服务错误:", err);
});
appSvc.on("alreadyinstalled", () => {
  console.log("Windows服务已安装");
});
if (!appSvc.exists) {
  console.log("正在安装Windows服务...");
  appSvc.install();
} else {
  console.log("Windows服务已存在");
  (async () => {
    try {
      await configManager.loadConfig("production");
      const config = configManager.getAll();
      const port = config.PORT || 9108;
      exec(`start http://127.0.0.1:${port}`);
    } catch (error) {
      console.error("启动浏览器失败:", error);
    }
  })();
}


