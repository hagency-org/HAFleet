const DASHBOARD_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isLoopbackAddress(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return false;
  if (raw === 'localhost' || raw === '::1' || raw === '127.0.0.1') return true;
  if (raw.startsWith('::ffff:')) return raw.slice('::ffff:'.length) === '127.0.0.1';
  return raw.startsWith('127.');
}

export function dashboardBearerToken(req) {
  const raw = String(req?.headers?.authorization || '').trim();
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

export function createDashboardMutationBoundary({
  dashboardApiToken = '',
  getLocalOverride = null,
} = {}) {
  const dashboardToken = typeof dashboardApiToken === 'string' ? dashboardApiToken.trim() : '';

  function localOverride() {
    if (typeof getLocalOverride !== 'function') return null;
    const override = getLocalOverride();
    return typeof override === 'function' ? override : null;
  }

  function isDashboardLocalRequest(req) {
    const override = localOverride();
    if (override) return override(req) === true;
    const candidates = [
      req?.socket?.remoteAddress,
      req?.connection?.remoteAddress,
      req?.ip,
    ];
    return candidates.some(isLoopbackAddress);
  }

  function hasDashboardMutationAccess(req) {
    if (isDashboardLocalRequest(req)) return true;
    if (!dashboardToken) return false;
    return dashboardBearerToken(req) === dashboardToken;
  }

  function requireDashboardMutationBoundary(req, res, next) {
    if (DASHBOARD_READ_METHODS.has(req.method)) return next();
    if (hasDashboardMutationAccess(req)) return next();
    return res.status(403).json({
      ok: false,
      error: 'dashboard mutation requires a local client or dashboard bearer token',
    });
  }

  return {
    hasDashboardMutationAccess,
    isDashboardLocalRequest,
    requireDashboardMutationBoundary,
  };
}
