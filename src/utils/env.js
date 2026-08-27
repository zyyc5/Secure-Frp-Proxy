const fs = require('node:fs/promises');

const ENV_LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

const parseEnvValue = (value) => {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
};

const loadEnvFile = async (envPath) => {
  let content;
  try {
    content = await fs.readFile(envPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(ENV_LINE);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = parseEnvValue(match[2]);
  }
  return true;
};

const setEnvValue = async (envPath, key, value) => {
  let content = '';
  try {
    content = await fs.readFile(envPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const line = `${key}=${value}`;
  const pattern = new RegExp(`^(\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*=).*?$`, 'm');
  const nextContent = pattern.test(content)
    ? content.replace(pattern, line)
    : `${content}${content && !content.endsWith('\n') ? '\n' : ''}${line}\n`;
  const temporaryPath = `${envPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, nextContent, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, envPath);
};

module.exports = { loadEnvFile, setEnvValue };
