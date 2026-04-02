import crypto from 'crypto';

const TUNNEL_SESSION_COOKIE_NAME = 'oc_tunnel_session';

const parseCookies = (cookieHeader) => {
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return {};
  }

  return cookieHeader.split(';').reduce((acc, segment) => {
    const [name, ...rest] = segment.split('=');
    if (!name) {
      return acc;
    }
    const key = name.trim();
    if (!key) {
      return acc;
    }
    const value = rest.join('=').trim();
    acc[key] = decodeURIComponent(value || '');
    return acc;
  }, {});
};

const isSecureRequest = (req) => {
  if (req.secure) {
    return true;
  }
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string') {
    const firstProto = forwardedProto.split(',')[0]?.trim().toLowerCase();
    return firstProto === 'https';
  }
  return false;
};

const buildCookie = ({ name, value, maxAge, secure }) => {
  const attributes = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (typeof maxAge === 'number') {
    attributes.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  }

  const expires = maxAge === 0
    ? 'Thu, 01 Jan 1970 00:00:00 GMT'
    : new Date(Date.now() + maxAge * 1000).toUTCString();

  attributes.push(`Expires=${expires}`);

  if (secure) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
};

const nowTs = () => Date.now();

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

const normalizeIpCandidate = (candidate) => {
  if (typeof candidate !== 'string') {
    return null;
  }

  const trimmed = candidate.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const withoutBrackets = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;

  const withoutZone = withoutBrackets.split('%')[0];
  if (!withoutZone) {
    return null;
  }

  if (withoutZone.startsWith('::ffff:')) {
    const mappedIpv4 = withoutZone.slice('::ffff:'.length);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(mappedIpv4)) {
      return mappedIpv4;
    }
  }

  return withoutZone;
};

const getSocketRemoteIp = (req) => {
  const remoteAddress = req?.socket?.remoteAddress || req?.connection?.remoteAddress;
  return normalizeIpCandidate(remoteAddress);
};

const isPrivateOrLoopbackIpv4 = (candidate) => {
  const octets = candidate.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [first, second] = octets;
  if (first === 127) {
    return true;
  }
  if (first === 10) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  if (first === 169 && second === 254) {
    return true;
  }
  return false;
};

const isPrivateOrLoopbackIpv6 = (candidate) => {
  if (candidate === '::1') {
    return true;
  }

  if (candidate.startsWith('fc') || candidate.startsWith('fd')) {
    return true;
  }

  return candidate.startsWith('fe8')
    || candidate.startsWith('fe9')
    || candidate.startsWith('fea')
    || candidate.startsWith('feb');
};

const isPrivateOrLoopbackIp = (candidate) => {
  const normalized = normalizeIpCandidate(candidate);
  if (!normalized) {
    return false;
  }

  if (normalized.includes(':')) {
    return isPrivateOrLoopbackIpv6(normalized);
  }

  return isPrivateOrLoopbackIpv4(normalized);
};

const isLocalHost = (host, req) => {
  if (!host) {
    return false;
  }

  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    return true;
  }

  if (host === 'host.docker.internal') {
    return isPrivateOrLoopbackIp(getSocketRemoteIp(req));
  }

  return false;
};

export const createTunnelAuth = () => {
  let activeTunnelId = null;
  let activeTunnelHost = null;
  let activeTunnelMode = null;
  let activeTunnelPublicUrl = null;

  const tunnelSessions = new Map();

  const clearTunnelSessionCookie = (req, res) => {
    const secure = isSecureRequest(req);
    const header = buildCookie({
      name: TUNNEL_SESSION_COOKIE_NAME,
      value: '',
      maxAge: 0,
      secure,
    });
    res.setHeader('Set-Cookie', header);
  };

  const setTunnelSessionCookie = (req, res, sessionId, ttlMs) => {
    const secure = isSecureRequest(req);
    const maxAge = Math.max(0, Math.floor(ttlMs / 1000));
    const header = buildCookie({
      name: TUNNEL_SESSION_COOKIE_NAME,
      value: encodeURIComponent(sessionId),
      maxAge,
      secure,
    });
    res.setHeader('Set-Cookie', header);
  };

  const classifyRequestScope = (req) => {
    const hostHeader = normalizeHost(typeof req.headers.host === 'string' ? req.headers.host : '');
    const reqHost = normalizeHost(typeof req.hostname === 'string' ? req.hostname : '') || hostHeader;

    if (activeTunnelHost && reqHost === activeTunnelHost) {
      return 'tunnel';
    }

    if (isLocalHost(reqHost, req)) {
      return 'local';
    }

    if (!activeTunnelId) {
      return 'local';
    }

    return 'unknown-public';
  };

  const invalidateTunnelSessions = (tunnelId, reason = 'tunnel-stopped') => {
    const revokedAt = nowTs();
    let count = 0;
    for (const record of tunnelSessions.values()) {
      if (record.tunnelId === tunnelId && !record.revokedAt) {
        record.revokedAt = revokedAt;
        record.revokedReason = reason;
        count += 1;
      }
    }
    return count;
  };

  const revokeTunnelArtifacts = (tunnelId) => {
    const invalidatedSessionCount = invalidateTunnelSessions(tunnelId, 'tunnel-revoked');
    return { invalidatedSessionCount };
  };

  const setActiveTunnel = ({ tunnelId, publicUrl, mode = null }) => {
    activeTunnelId = tunnelId;
    activeTunnelMode = mode;
    activeTunnelPublicUrl = publicUrl || null;
    try {
      activeTunnelHost = normalizeHost(new URL(publicUrl).host);
    } catch {
      activeTunnelHost = null;
    }
  };

  const clearActiveTunnel = () => {
    if (activeTunnelId) {
      revokeTunnelArtifacts(activeTunnelId);
    }
    activeTunnelId = null;
    activeTunnelHost = null;
    activeTunnelMode = null;
    activeTunnelPublicUrl = null;
  };

  const getTunnelSessionFromRequest = (req) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[TUNNEL_SESSION_COOKIE_NAME];
    if (!token) {
      return null;
    }
    const session = tunnelSessions.get(token);
    if (!session) {
      return null;
    }
    if (session.revokedAt) {
      return null;
    }
    if (session.expiresAt <= nowTs()) {
      if (!session.expiredAt) {
        session.expiredAt = nowTs();
      }
      return null;
    }
    if (session.tunnelId !== activeTunnelId) {
      return null;
    }
    session.lastSeenAt = nowTs();
    return session;
  };

  const requireTunnelSession = (req, res, next) => {
    const session = getTunnelSessionFromRequest(req);
    if (session) {
      return next();
    }

    clearTunnelSessionCookie(req, res);
    res.status(401).json({
      error: 'Tunnel authentication required',
      locked: true,
      tunnelLocked: true,
    });
  };

  const listTunnelSessions = () => {
    const now = nowTs();

    const sessions = [];
    for (const record of tunnelSessions.values()) {
      const isExpired = record.expiresAt <= now;
      if (isExpired && !record.expiredAt) {
        record.expiredAt = now;
      }

      const active = !record.revokedAt && !isExpired && record.tunnelId === activeTunnelId;
      const status = active ? 'active' : 'inactive';
      const inactiveReason = record.revokedAt ? (record.revokedReason || 'revoked') : (isExpired ? 'expired' : 'inactive');

      sessions.push({
        sessionId: record.sessionId,
        tunnelId: record.tunnelId,
        mode: record.mode,
        publicUrl: record.publicUrl,
        createdAt: record.createdAt,
        lastSeenAt: record.lastSeenAt,
        expiresAt: record.expiresAt,
        revokedAt: record.revokedAt,
        status,
        inactiveReason: status === 'inactive' ? inactiveReason : null,
      });
    }

    sessions.sort((a, b) => b.createdAt - a.createdAt);
    return sessions;
  };

  return {
    classifyRequestScope,
    setActiveTunnel,
    clearActiveTunnel,
    revokeTunnelArtifacts,
    requireTunnelSession,
    getTunnelSessionFromRequest,
    listTunnelSessions,
    clearTunnelSessionCookie,
    getActiveTunnelId: () => activeTunnelId,
    getActiveTunnelHost: () => activeTunnelHost,
    getActiveTunnelMode: () => activeTunnelMode,
  };
};
