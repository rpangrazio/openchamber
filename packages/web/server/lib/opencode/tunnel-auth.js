const normalizeHost = (candidate) => {
  if (typeof candidate !== 'string') {
    return null;
  }
  const trimmed = candidate.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/:\d+$/, '');
};

export const createTunnelAuth = () => {
  let activeTunnelId = null;
  let activeTunnelHost = null;
  let activeTunnelMode = null;

  const setActiveTunnel = ({ tunnelId, publicUrl, mode = null }) => {
    activeTunnelId = tunnelId;
    activeTunnelMode = mode;
    try {
      activeTunnelHost = normalizeHost(new URL(publicUrl).host);
    } catch {
      activeTunnelHost = null;
    }
  };

  const clearActiveTunnel = () => {
    activeTunnelId = null;
    activeTunnelHost = null;
    activeTunnelMode = null;
  };

  return {
    setActiveTunnel,
    clearActiveTunnel,
    getActiveTunnelId: () => activeTunnelId,
    getActiveTunnelHost: () => activeTunnelHost,
    getActiveTunnelMode: () => activeTunnelMode,
  };
};
