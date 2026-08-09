const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

const getConfigDir = () => process.env.CONFIG_DIR || path.join(__dirname, '..', '..', 'config');
const getFrpcPath = () => os.platform() === 'win32'
  ? path.join(__dirname, '..', '..', 'frpc', 'frpc.exe')
  : path.join(__dirname, '..', '..', 'frpc', 'frpc');

class HttpsFrpcManager {
  constructor() {
    this.process = null;
  }

  get configPath() {
    return process.env.FRPC_HTTPS_CONFIG || path.join(getConfigDir(), 'frpc-https.toml');
  }

  async isInstalled() {
    try {
      await Promise.all([fs.access(getFrpcPath()), fs.access(this.configPath)]);
      return true;
    } catch (_) {
      return false;
    }
  }

  start() {
    if (this.process) return;
    if (os.platform() !== 'win32') {
      try { require('fs').chmodSync(getFrpcPath(), 0o755); } catch (error) {
        console.warn('Unable to set HTTPS frpc permission:', error.message);
      }
    }
    this.process = spawn(getFrpcPath(), ['-c', this.configPath], { stdio: 'inherit' });
    this.process.on('close', (code) => {
      console.log(`HTTPS frpc exited with code: ${code}`);
      this.process = null;
    });
    this.process.on('error', (error) => {
      console.error('HTTPS frpc failed to start:', error.message);
      this.process = null;
    });
  }

  async stop() {
    if (!this.process) return;
    this.process.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (this.process) this.process.kill('SIGKILL');
    this.process = null;
  }
}

module.exports = new HttpsFrpcManager();
