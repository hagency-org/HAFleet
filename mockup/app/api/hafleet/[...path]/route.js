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
  /*
   * The agent's live pane. A read, and the reason it is admitted: the console could describe an
   * agent's runtime but never show what it was actually doing, so "is it stuck?" had no answer
   * short of attaching to tmux on the host — which risks killing the pane on a wrong detach.
   */
  /^agents\/[A-Za-z0-9._-]+\/pane$/,
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
  /*
   * 项目方 — the project sides HAFleet is registered with (ADR-016 decision 1).
   *
   * Read-safe for a console holding the API token, and that is a property of the STORE rather than
   * a judgement made here: `publicSide` is an allow-list projection with no credential field, so
   * there is no shape of this response that carries an `as_token`. What it does carry is what an
   * operator needs — the server, the credential KIND, the access verdict with its age, and the
   * representative's MXID.
   *
   * One segment for the id, which IS the server name: `palpo.test` and `127.0.0.1:8008` both pass
   * SAFE_SEGMENT (dots and colons are in the class), and `[^/]+` would additionally admit the
   * percent-encoded traversal that class exists to reject.
   */
  /^project-sides$/,
  /*
   * The id segment must contain a DOT or a COLON, because it is a Matrix server name —
   * `palpo.test`, `127.0.0.1:8008`. Written this way to exclude one specific sibling:
   * `GET /api/project-sides/inbound-credentials` is bridge-secret guarded and returns an `hs_token`,
   * and a plain `[A-Za-z0-9._:-]+` matched it. The backend would have refused the proxy's operator
   * token, so nothing leaked — but an allowlist that admits a credential endpoint is an allowlist
   * permitting more than the action it represents, and the guard it relies on is somebody else's code.
   *
   * The cost is that a single-label server name (`localhost`) would not be proxied. Matrix server names
   * in any real deployment carry a dot or a port, and the exchange is a console read for a rule that
   * cannot reach a credential route.
   */
  /^project-sides\/[A-Za-z0-9._:-]*[.:][A-Za-z0-9._:-]*$/,
  /*
   * The side's budget: `{ allocated, committed, remaining }` and nothing else. Added as its own entry
   * rather than by loosening the rule above, because the rule above is deliberately one segment — a
   * `[^/]*` tail there would have admitted `inbound-credentials` again through the back door.
   *
   * DERIVED FIGURES ARE FETCHED, NOT RECOMPUTED. The console could sum active engagements per side
   * itself; it already holds them. It must not: `committed` is defined by the backend's
   * `committedForProjectSide`, and a second implementation is how "two answers for the same question"
   * gets shipped — the exact drift the capability layer's comment above refuses for role eligibility.
   * The same argument applies here, so the same choice is made.
   */
  /^project-sides\/[A-Za-z0-9._:-]*[.:][A-Za-z0-9._:-]*\/budget$/,
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
  /*
   * WRITING a project side's credential is admitted; READING one still is not, and the asymmetry is
   * deliberate. `PUT .../credential` answers with `publicSide`, which is an allow-list projection with
   * no credential field, so admitting it discloses nothing — while the two credential-RETURNING
   * endpoints stay outside the read allow-list. A side id contains dots or colons (it IS a server
   * name), so the character class here is wider than the others on purpose.
   */
  { method: 'PUT', re: /^project-sides\/[A-Za-z0-9._:-]+\/credential$/ },
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
  /*
   * Attaching a preset to an agent — the act that gives the agent a CEILING, and therefore the
   * act without which no engagement can be approved (`decide()` refuses an agent whose remaining
   * is null). One segment for the name, and no agent route beyond this one: the shared token also
   * authorises DELETE /api/agents/:name, so the allowlist admits the binding and nothing else.
   */
  { method: 'PUT', re: /^agents\/[A-Za-z0-9._-]+\/preset$/ },
  /*
   * Creating and launching an agent. Both are local-only on the backend (`isLocalRequest`), because
   * they spawn a process on the machine the backend runs on — a console served from another host
   * cannot provision on a contributor's machine, and the page says so rather than failing obscurely.
   * Admitted here and nothing wider: the shared token also authorises DELETE /api/agents/:name, so
   * the allowlist names these two exact actions.
   */
  { method: 'POST', re: /^agents\/[A-Za-z0-9._-]+\/provision$/ },
  { method: 'POST', re: /^agents\/[A-Za-z0-9._-]+\/start$/ },
  /*
   * Removing an agent. The console's own Remove button used to be a toast and nothing else — it
   * said "removed" and made no request, which is why an operator reported "remove agent ui worked
   * but agent is not removed". Admitted here so the button can do what it claims. One segment for
   * the name; `?force=true` rides in the query string, which the forwarder preserves.
   */
  { method: 'DELETE', re: /^agents\/[A-Za-z0-9._-]+$/ },
  /*
   * Project-side CRUD — the operator's 「增加一个项目方的 section，里面可以 CRUD」.
   *
   * The credential travels in the BODY of the upsert and the credential write, so no path segment
   * carries a secret and nothing here can be read back: the backend answers every one of these with
   * the same credential-free projection the reads use.
   *
   * `verify` is a write rather than a read even though it changes no configuration, because it makes
   * an authenticated call to a foreign homeserver and records a verdict. A GET that reaches out to
   * someone else's server on every console refresh is the wrong default.
   *
   * DELETE is admitted, and it is the one entry here that can destroy something. The backend refuses
   * an ACTIVE side with a 409 and requires `?force=true`, which the forwarder preserves in the query
   * string — the same shape as the agent delete above.
   */
  /*
   * DELIBERATELY ABSENT: `POST /api/project-sides/:id/registration`.
   *
   * Not an oversight, so do not "fix" it. That endpoint answers with the registration YAML, which
   * carries an `as_token` and an `hs_token` in plaintext — the only time either is readable. Proxying it
   * would put a credential that authorises a whole namespace on somebody else's homeserver into a
   * browser: its memory, its devtools, its history, and whatever extension is watching.
   *
   * Generating a registration is an install-time act performed once per project side, and from a
   * terminal the YAML goes straight into a 0600 file. The exchange is one convenience for the property
   * that this particular token never enters a browser at all — the same reasoning `cf.ownSecrets` gives
   * for HAFleet's own secrets living only in `.env`.
   *
   * Also absent, for a different reason: `GET /api/project-sides/inbound-credentials`, which is
   * bridge-secret guarded. See the note on the read pattern above for why the read entry is written to
   * exclude it rather than merely failing to include it.
   */
  { method: 'POST', re: /^project-sides$/ },
  { method: 'PUT', re: /^project-sides\/[A-Za-z0-9._:-]+\/credential$/ },
  { method: 'POST', re: /^project-sides\/[A-Za-z0-9._:-]+\/verify$/ },
  { method: 'POST', re: /^project-sides\/[A-Za-z0-9._:-]+\/deactivate$/ },
  { method: 'POST', re: /^project-sides\/[A-Za-z0-9._:-]+\/reactivate$/ },
  /*
   * 项目 under a 项目方 — a NAME and a ROOM, neither of which is a secret and both of which the operator
   * currently keeps in a notebook, because nothing in this product stores a project name.
   *
   * `/archive` and not a DELETE, and there is no DELETE to allow: 「项目方暂时不可以删除,可以 archive 掉」.
   * A project's room carries the engagements served through it, so forgetting the project would leave
   * that history attributable to nothing.
   */
  { method: 'POST', re: /^project-sides\/[A-Za-z0-9._:-]+\/projects$/ },
  { method: 'POST', re: /^project-sides\/[A-Za-z0-9._:-]+\/projects\/[^/]+\/archive$/ },
  { method: 'DELETE', re: /^project-sides\/[A-Za-z0-9._:-]+$/ },
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
