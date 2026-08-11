/*
 * Server-side proxy to the hafleet backend.
 *
 * WHY A PROXY RATHER THAN CALLING THE BACKEND DIRECTLY. Two reasons, and the
 * second is the one that matters.
 *
 * 1. CORS. `CORS_ALLOWED_ORIGIN` (backend-v2.js:131) admits exactly one origin and
 *    defaults to `https://hafleet.example.com`, so a browser on :3100 is refused.
 *    Widening it for a dev port would be a production change made for a prototype.
 *
 * 2. THE TOKEN. `/api` is covered by one shared `API_TOKEN`
 *    (lib/backend/auth-adapter.js) that also authorises `DELETE /api/agents/:name`
 *    and `POST /api/agents/:name/start`. There is no read-only tier. Shipping that
 *    token to the browser would hand every console visitor the ability to delete
 *    an agent. It stays in this process; the browser talks to its own origin.
 *
 * The read allowlist below is the compensating control for the missing scoped
 * credential: this proxy forwards only the reads the console actually renders, so
 * holding the console open is not equivalent to holding the token.
 *
 * A static export (PAGES=1) has no server, so these handlers do not exist there
 * and lib/api.js falls back to the fixture. The published demo is therefore
 * fixture-backed by construction, and the UI says so rather than implying a
 * backend it cannot reach.
 */

const BACKEND = process.env.HAFLEET_BACKEND ?? 'http://127.0.0.1:8090';
const TOKEN = process.env.HAFLEET_API_TOKEN ?? process.env.API_TOKEN ?? '';

/*
 * Default-deny, on the model of TRUSTED_HAFLEET_COORDINATION_TOOLS
 * (lib/codex-permission-hook.js:15): a path not named here is refused, so adding
 * a page cannot silently widen what the proxy exposes.
 */
const READS = [
  /^agents$/,
  /^agents\/[A-Za-z0-9._-]+$/,
  /^agents\/[A-Za-z0-9._-]+\/tasks$/,
  /^agents\/[A-Za-z0-9._-]+\/groups$/,
  /^framework-presets$/,
  /^frameworks$/,
  /^frameworks\/detect$/,
  /^alerts$/,
  /^alerts\/stats$/,
  /^alerts\/[A-Za-z0-9._-]+$/,
  /^tasks$/,
  /^project-board$/,
  /^engagements$/,
  /^engagements\/[A-Za-z0-9._-]+$/,
  /^offers$/,
  /^whitelist$/,
  /^usage$/,
  /^seats$/,
  /^capability$/,
  /*
   * The contribution binding, read by the workforce roster.
   *
   * `GET /api/contributions` is a deliberately narrow projection of the binding
   * store — it omits `ownerDmRoomId`, the owner's private channel — precisely so a
   * console holding the API token can read it. `GET /api/approval-bindings`, which
   * carries that field, is guarded by the bridge secret and is NOT added here: the
   * proxy should expose the projection somebody designed for it, not the record it
   * was projected from.
   */
  /^contributions$/,
  /*
   * Invitations a project has extended that the contributor has not answered (ADR-014).
   *
   * Read-safe for a console holding the API token: the projection carries the room, the
   * derived project server, the inviter and which agent was invited — the facts a human
   * needs to decide — and no credential. The DECISION is a separate write below, because
   * accepting spends the contributor's tokens.
   */
  /^matrix\/pending-invites$/,
];

/*
 * Writes are enumerated separately and deliberately short. Every entry is an
 * action the console has a form for; nothing here can delete an agent, start a
 * process, or change a runtime profile, because the console has no such control
 * and the proxy should not be the place that first allows one.
 */
const WRITES = [
  { method: 'POST', re: /^framework-presets$/ },
  { method: 'PUT', re: /^framework-presets\/[A-Za-z0-9._-]+$/ },
  { method: 'DELETE', re: /^framework-presets\/[A-Za-z0-9._-]+$/ },
  { method: 'POST', re: /^alerts\/[A-Za-z0-9._-]+\/transition$/ },
  { method: 'POST', re: /^alerts\/[A-Za-z0-9._-]+\/notes$/ },
  { method: 'POST', re: /^engagements$/ },
  { method: 'POST', re: /^engagements\/[A-Za-z0-9._-]+\/verdict$/ },
  { method: 'POST', re: /^engagements\/[A-Za-z0-9._-]+\/revoke$/ },
  { method: 'PUT', re: /^offers\/[A-Za-z0-9._-]+$/ },
  { method: 'POST', re: /^whitelist$/ },
  // ONE segment, not `.+`. A room id is a single segment, and `.+` matched
  // `whitelist/a/b` too — harmless against today's backend, which 404s it, but it
  // silently pre-authorises any nested DELETE /api/whitelist/* added later. An
  // allowlist that permits more than the action it represents is not an allowlist.
  { method: 'DELETE', re: /^whitelist\/[^/]+$/ },
  /*
   * Answering an invitation. A write rather than a read because it commits the
   * contributor's capacity, and the one action the console has a form for here — the room
   * and agent travel in the body, so there is no path segment to over-match.
   */
  { method: 'POST', re: /^matrix\/pending-invites\/decide$/ },
];

function allowed(method, joined) {
  if (method === 'GET') return READS.some((re) => re.test(joined));
  return WRITES.some((w) => w.method === method && w.re.test(joined));
}

/*
 * CANONICALIZE BEFORE MATCHING, and rebuild from what was matched.
 *
 * The first version matched the allowlist against the path Next had decoded once,
 * then interpolated that string into a URL — and `new URL()` decodes and normalizes
 * again. So the string that was checked was not the string that was requested:
 *
 *   sent      DELETE /api/hafleet/whitelist/%252e%252e/agents/victim
 *   Next      path = ['whitelist', '%2e%2e', 'agents', 'victim']
 *   matched   /^whitelist\/.+$/  ✓  (it does start with "whitelist/")
 *   requested fetch() resolves %2e%2e to ".."  ->  DELETE /api/agents/victim
 *
 * Verified against a running backend: that request reached the agent-deletion
 * handler carrying the operator token, and only the handler's own soft-delete
 * default kept the agent alive. `?force=true` would have removed it.
 *
 * A tighter regex is the wrong fix — the defect is that two different strings were
 * in play. So: reject any segment that is not already canonical, and build the
 * outgoing path by joining the validated segments, never by interpolating input.
 */
/*
 * `!` and `:` are in the class because a whitelist segment IS a Matrix room id —
 * `!aXbY7pQ2:hq.example` — which the client percent-encodes and Next decodes back
 * before this sees it. Excluding them made the allowlist reject the one write it
 * exists to permit. What must stay out is `/`, `\`, `%` and the path operators.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._~!:@-]+$/;

function canonicalSegments(path) {
  const segments = path ?? [];
  if (segments.length === 0 || segments.length > 6) return null;
  for (const raw of segments) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return null;
    // A percent left after Next's single decode means the client encoded twice.
    // There is no legitimate reason for that here, and it is exactly the vector.
    if (raw.includes('%')) return null;
    if (!SAFE_SEGMENT.test(raw)) return null;
    // `.` and `..` pass SAFE_SEGMENT's character class; they are path operators.
    if (raw === '.' || raw === '..') return null;
  }
  return segments;
}

/*
 * WHO MAY USE THIS PROXY, and where the boundary actually is.
 *
 * It attaches the backend's operator token to whatever it forwards, so anyone who
 * can reach it can approve engagements, whitelist themselves, delete presets and —
 * before the canonicalisation above — delete agents. It authenticated nobody, and
 * `next dev` binds every interface (`*:3100`), so on a shared network the console
 * handed that authority to the LAN.
 *
 * THE CONTROL IS THE BIND, NOT A HEADER. A first attempt checked the `Host` header
 * for a loopback value. That is security theatre: `Host` is client-supplied, so
 * anyone on the LAN sends `Host: 127.0.0.1` and passes. The socket is the only thing
 * that cannot be forged, so the dev and start scripts now bind 127.0.0.1 and the OS
 * refuses a remote connection outright.
 *
 * What remains here is defence in depth, stated honestly as such:
 *
 *  - `HAFLEET_CONSOLE_TOKEN`, when set, is required. That is the supported way to
 *    expose the console beyond loopback: an explicit shared secret rather than an
 *    inference about where the caller sits.
 *  - Otherwise the LAST hop in `x-forwarded-for` must be loopback. The last entry,
 *    not the first: a client can put anything at the front, but each proxy APPENDS
 *    the peer it actually saw, so the tail is the nearest real peer. Next injects
 *    this header itself on every dev request with the socket peer in it — a first
 *    attempt rejected any request that merely HAD the header, which rejected all of
 *    them.
 */
const CONSOLE_TOKEN = process.env.HAFLEET_CONSOLE_TOKEN ?? '';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function callerAllowed(req) {
  if (CONSOLE_TOKEN) {
    const auth = req.headers.get('authorization') ?? '';
    return auth === `Bearer ${CONSOLE_TOKEN}`;
  }
  /*
   * X-Forwarded-For IS NOT A CONTROL, and treating it as one was the Host-header
   * mistake a second time. Next only sets this header when it is absent (`??=`); it
   * does not append the socket peer. So any caller that can reach the listener can
   * send `X-Forwarded-For: 127.0.0.1` and satisfy a check that reads the last hop.
   *
   * The bind is the control. This is kept only to REFUSE an obviously-forwarded
   * request — evidence of remoteness is worth acting on, absence of it proves
   * nothing — and it is never the thing granting access.
   */
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const hops = xff.split(',').map((h) => h.trim()).filter(Boolean);
    if (!hops.every((h) => LOOPBACK.has(h))) return false;
  }
  return true;
}

/*
 * LOOPBACK IS NOT A PRINCIPAL.
 *
 * Binding to 127.0.0.1 keeps the network out; it does nothing about the operator's
 * own browser. Any page they visit can POST to this origin, and a `text/plain` body
 * is a CORS "simple request" — no preflight, so the browser sends it and the proxy
 * happily relabels it `application/json` on the way out, with the operator token
 * attached. One visited page could whitelist a room or approve an engagement.
 *
 * So state-changing requests must prove they came from this app. Sec-Fetch-Site is
 * browser-set and unforgeable by page script; Origin is checked too for clients that
 * predate it. A request with NEITHER header is not from a browser (curl, the test
 * suite, a server-side caller) and is allowed — the bind is what bounds those.
 */
function sameOriginWrite(req) {
  const site = req.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

async function forward(req, ctx, method) {
  const { path } = await ctx.params;
  const rawJoined = (path ?? []).join('/');
  if (rawJoined === STATIC_SENTINEL) {
    return Response.json({
      error: 'this build is a static export: there is no server, so no backend proxy',
      fixture: true,
    }, { status: 501 });
  }

  if (!callerAllowed(req)) {
    return Response.json({
      error: CONSOLE_TOKEN
        ? 'console token required'
        : 'this proxy carries operator authority and is bound to loopback; set HAFLEET_CONSOLE_TOKEN to use it from elsewhere',
    }, { status: 403 });
  }

  const segments = canonicalSegments(path);
  if (!segments) {
    return Response.json({ error: `proxy refuses a non-canonical path: /${rawJoined}` }, { status: 400 });
  }
  // Built from the validated segments, so the string that was checked is the string
  // that is requested. Encoding each segment means a backend router cannot
  // re-split on anything the client smuggled in.
  const joined = segments.join('/');
  const outboundPath = segments.map(encodeURIComponent).join('/');

  if (!allowed(method, joined)) {
    return Response.json({ error: `proxy refuses ${method} /${joined}` }, { status: 403 });
  }

  if (method !== 'GET' && !sameOriginWrite(req)) {
    return Response.json({ error: 'proxy refuses a cross-site write' }, { status: 403 });
  }

  const qs = new URL(req.url).search;
  const headers = { Accept: 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  let body;
  if (method !== 'GET' && method !== 'DELETE') {
    body = await req.text();
    headers['Content-Type'] = 'application/json';
  }

  try {
    /*
     * `outboundPath`, not `joined`. Interpolating the decoded string here is what
     * let `%2e%2e` become `..` inside new URL() and resolve to a different endpoint
     * than the one the allowlist approved.
     */
    const res = await fetch(`${BACKEND}/api/${outboundPath}${qs}`, {
      method, headers, body, cache: 'no-store',
      /*
       * Do not follow redirects. fetch's default would re-issue the request at the
       * Location the backend names — carrying the method and the operator token — to
       * a path the allowlist never approved. Nothing in the backend redirects today,
       * which is exactly why this is cheap to guarantee now.
       */
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    if (res.status >= 300 && res.status < 400) {
      return Response.json(
        { error: 'backend redirected; the proxy does not follow redirects' },
        { status: 502 },
      );
    }
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/json' },
    });
  } catch (e) {
    // 502 with the reason, not an empty 500: the console distinguishes "backend
    // not running" from "backend said no", and shows a different banner for each.
    return Response.json({ error: `backend unreachable: ${e?.message ?? 'unknown'}` }, { status: 502 });
  }
}

/*
 * ONE sentinel route, and no `export const dynamic`.
 *
 * Three constraints meet here and only this shape satisfies all of them:
 *
 *  - `force-dynamic` is what a proxy wants, and `output: export` refuses it.
 *  - The segment config must be a statically parsable literal, so a ternary on an
 *    env var is rejected at compile time.
 *  - `output: export` also refuses an empty `generateStaticParams()`.
 *
 * So: omit the config (with a server, Next infers dynamic from the request use in
 * forward()), and emit a single route that states the situation. On a static host
 * every real path 404s, which lib/api.js reads as a failed slice and falls back to
 * the fixture — the correct outcome, since a static export genuinely has no server
 * and therefore no proxy. The sentinel exists so that outcome is documented at the
 * URL rather than inferred from a 404.
 */
const STATIC_SENTINEL = '__no-server__';

export function generateStaticParams() {
  return [{ path: [STATIC_SENTINEL] }];
}

export const GET = (req, ctx) => forward(req, ctx, 'GET');
export const POST = (req, ctx) => forward(req, ctx, 'POST');
export const PUT = (req, ctx) => forward(req, ctx, 'PUT');
export const DELETE = (req, ctx) => forward(req, ctx, 'DELETE');
