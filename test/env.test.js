const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadEnvFile, setEnvValue } = require('../src/utils/env');

test('loads environment values without replacing existing values', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'secure-rdp-env-'));
  const envPath = path.join(directory, '.env');
  const original = process.env.SECURE_RDP_TEST_VALUE;
  try {
    await fs.writeFile(envPath, 'SECURE_RDP_TEST_VALUE=from-file\nSECURE_RDP_TEST_QUOTED="quoted value"\n');
    process.env.SECURE_RDP_TEST_VALUE = 'from-process';
    await loadEnvFile(envPath);
    assert.equal(process.env.SECURE_RDP_TEST_VALUE, 'from-process');
    assert.equal(process.env.SECURE_RDP_TEST_QUOTED, 'quoted value');
  } finally {
    if (original === undefined) delete process.env.SECURE_RDP_TEST_VALUE;
    else process.env.SECURE_RDP_TEST_VALUE = original;
    delete process.env.SECURE_RDP_TEST_QUOTED;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('updates an environment value atomically', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'secure-rdp-env-'));
  const envPath = path.join(directory, '.env');
  try {
    await fs.writeFile(envPath, 'APP_USERNAME=admin\nAPP_PASSWORD=old\n');
    await setEnvValue(envPath, 'APP_PASSWORD', 'new-password');
    assert.equal(await fs.readFile(envPath, 'utf8'), 'APP_USERNAME=admin\nAPP_PASSWORD=new-password\n');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
