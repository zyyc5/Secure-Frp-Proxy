const requiredEnv = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw Object.assign(new Error(`${name} is required`), { code: 'control_plane_not_configured' });
  return value;
};

const request = async (path, { method = 'GET', body } = {}) => {
  const baseUrl = requiredEnv('CONTROL_PLANE_URL').replace(/\/$/, '');
  const apiKey = requiredEnv('CONTROL_PLANE_API_KEY');
  const clientId = requiredEnv('CONTROL_PLANE_CLIENT_ID');
  const response = await fetch(new URL(`/api/v1${path}`, baseUrl), {
    method,
    headers: { 'X-API-Key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.error || `Control plane request failed (${response.status})`), {
      code: data.error || `control_plane_${response.status}`,
      status: response.status
    });
  }
  return { clientId, ...data };
};

const createDedicatedTunnel = ({ protocol, localPort, name }) => {
  const clientId = requiredEnv('CONTROL_PLANE_CLIENT_ID');
  return request(`/clients/${encodeURIComponent(clientId)}/tunnels`, {
    method: 'POST',
    body: { protocol, localPort, localHost: '127.0.0.1', name }
  });
};

const deleteDedicatedTunnel = (tunnelId) => {
  const clientId = requiredEnv('CONTROL_PLANE_CLIENT_ID');
  return request(`/clients/${encodeURIComponent(clientId)}/tunnels/${encodeURIComponent(tunnelId)}`, { method: 'DELETE' });
};

const isConfigured = () => Boolean(process.env.CONTROL_PLANE_URL?.trim() && process.env.CONTROL_PLANE_API_KEY?.trim() && process.env.CONTROL_PLANE_CLIENT_ID?.trim());

module.exports = { createDedicatedTunnel, deleteDedicatedTunnel, isConfigured };
