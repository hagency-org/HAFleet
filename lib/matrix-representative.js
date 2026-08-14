/*
 * 代表 — HAFleet's representative on a project side (ADR-016 decision 3).
 *
 * THE SPLIT THIS FILE EXISTS TO MAKE. Until now the representative and the working agent were one
 * thing: the agent itself had to be invited and had to join, so an agent identity had to exist
 * before any project was known — and its MXID was composed on HAFleet's own server, which under
 * ADR-016 decision 2 (servers do not federate) is unusable for a project hosted elsewhere. That is
 * the circular dependency an operator named. The representative is what becomes known first.
 *
 * | | 代表 representative | agent instance |
 * |---|---|---|
 * | purpose | be registered on the project's server; receive requests | do the work |
 * | lifetime | as long as the project side is configured | one engagement |
 * | how many | one per project side | one per engagement |
 * | draws budget | no | yes |
 *
 * WHY THIS IS NOT IN bridge-matrix.js. Every Matrix call here takes its `baseUrl` as an argument.
 * That is ADR-016's third first-pass shape stated as code: the bridge's 44 `HOMESERVER` references
 * are a module constant, and a representative for a foreign homeserver cannot be built out of them.
 * Keeping it separate also makes it testable against an injected `fetch` — the bridge's own tests
 * assert against its SOURCE TEXT because the file cannot be exercised, and that is not a standard
 * worth extending.
 *
 * WHAT THE REPRESENTATIVE IS NOT. It is not HAFleet's home bot. The home bot lives on the
 * contributor's own server, talks to the operator, holds the single crypto store and is the E2EE
 * sender; `MATRIX_HOMESERVER` remains its server. A representative is plaintext-only and does
 * intake — which is sound because ADR-016 settled that intake rooms are plaintext, and HAFleet's
 * agents have never been E2EE participants anyway.
 */

import { randomBytes } from 'crypto';

/** Default localpart for the representative account. Lowercase: the spec requires it of localparts,
 * and `bridge-matrix.js` already lowercases agent localparts for the same reason. */
export const DEFAULT_REPRESENTATIVE_LOCALPART = 'hafleet';

export class RepresentativeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RepresentativeError';
    this.code = code;
  }
}

/**
 * Did the homeserver REJECT us, or fail to answer?
 *
 * Same rule as `bridge-matrix.js`'s `isMatrixAuthFailure`, and restated here rather than imported
 * because that module cannot be loaded without its environment. Only 401 and 403 are a verdict on
 * the credential. Everything else — 5xx, a timeout, DNS, a rate limit — says nothing about it, and
 * reporting an outage as `rejected` sends an operator to ask a project side for a new credential
 * when the one they hold is fine. On this path that means a human doing account work on someone
 * else's homeserver, so the cost of the wrong answer is somebody else's afternoon.
 *
 * Unknown shapes answer `unreachable`, so an unrecognised failure is transient rather than a
 * verdict.
 */
export function classifyMatrixFailure(error) {
  const status = error?.status;
  return status === 401 || status === 403 ? 'rejected' : 'unreachable';
}

function joinUrl(baseUrl, pathSuffix) {
  return `${String(baseUrl).replace(/\/+$/, '')}${pathSuffix}`;
}

/**
 * Parse a Matrix response body defensively, AFTER the status is in hand.
 *
 * `await res.json()` on a 401 whose body is empty or HTML — a proxy, a non-conforming homeserver —
 * throws a SyntaxError carrying no `.status`, which `classifyMatrixFailure` would then read as
 * `unreachable`: an outage verdict on a genuinely dead token. The status is the reliable signal; the
 * body only enriches the message. This is the same defence `getMatrixAccessTokenSession` documents.
 */
async function readBody(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function matrixError(res, data, what) {
  const error = new RepresentativeError(
    'matrix_error',
    `${what} failed with HTTP ${res.status}: ${data?.errcode || data?.error || 'unknown error'}`,
  );
  error.status = res.status;
  error.errcode = typeof data?.errcode === 'string' ? data.errcode : undefined;
  return error;
}

/**
 * Ask a homeserver who a credential belongs to.
 *
 * `asUserId` masquerades, which is how an appservice acts as a user in its namespace: the query
 * parameter names the user and the `as_token` authorises it. For a plain access token it is omitted.
 *
 * THE MXID COMES BACK FROM HERE AND IS NEVER COMPOSED. ADR-014 decision 5: composing
 * `@localpart:server` is simply wrong for an account on a server we do not administer, and the
 * repository has a live example of the damage — the invite poll's owner-derivation filter matches a
 * CONSTRUCTED state_key, so for an agent on any other homeserver it never matches, no ownership
 * binding is written, and every later approval is denied `owner_binding_missing`. A silent
 * authorization failure produced by a string built from an assumption.
 */
export async function whoami({ baseUrl, token, asUserId = null, fetchImpl = fetch }) {
  if (!baseUrl) throw new RepresentativeError('bad_request', 'baseUrl is required');
  if (!token) throw new RepresentativeError('bad_request', 'token is required');
  const url = new URL(joinUrl(baseUrl, '/_matrix/client/v3/account/whoami'));
  if (asUserId) url.searchParams.set('user_id', asUserId);
  const res = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await readBody(res);
  if (!res.ok) throw matrixError(res, data, 'whoami');
  const userId = typeof data?.user_id === 'string' ? data.user_id.trim() : '';
  if (!userId) {
    throw new RepresentativeError('matrix_error', 'whoami did not return a user_id');
  }
  return { userId, deviceId: typeof data?.device_id === 'string' ? data.device_id.trim() : null };
}

/**
 * Register the representative's account using a registration token the project side issued.
 *
 * The password is RANDOM and then DISCARDED. Random rather than derived is ADR-014 decision 3's
 * entire holding: a derived password cannot be rotated (every account's changes at once) and cannot
 * be revoked (it can always be re-derived), so `.env` compromise became permanent control of every
 * identity.
 *
 * Discarded rather than stored is a further choice worth stating, because it costs something. Keeping
 * it would give a login fallback if the access token ever dies. Not keeping it means a dead token
 * makes the project side unreachable until a human acts — which is exactly the state ADR-014
 * decision 6 says a dead credential must be, rather than something a retry loop papers over. The
 * trade is: one fewer long-lived secret at rest, against a recovery path that must go through a
 * person. If that turns out to be the wrong trade, adding the password is additive; removing it
 * later would not be.
 */
export async function registerRepresentative({
  baseUrl,
  registrationToken,
  localpart = DEFAULT_REPRESENTATIVE_LOCALPART,
  fetchImpl = fetch,
}) {
  if (!baseUrl) throw new RepresentativeError('bad_request', 'baseUrl is required');
  const username = String(localpart || '').toLowerCase();
  if (!username) throw new RepresentativeError('bad_request', 'localpart is required');
  const password = randomBytes(32).toString('base64url');
  const url = joinUrl(baseUrl, '/_matrix/client/v3/register');

  // Step 1 — probe for the UIA session and the flows this server offers. Some servers complete
  // registration outright and return a token here.
  const probeRes = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const probe = await readBody(probeRes);
  if (probe?.access_token) {
    return { accessToken: probe.access_token, userId: probe.user_id || null };
  }
  /*
   * A 4xx that is not a UIA challenge is a real refusal and must be raised, not retried. M_USER_IN_USE
   * is the one an operator will actually meet: the localpart is taken, which happens when a
   * representative was registered before and its token was then lost. That needs a person to pick a
   * different localpart or reset the account — precisely the human-visible state above.
   */
  if (!probe?.session) {
    throw matrixError(probeRes, probe, 'representative registration probe');
  }

  // Step 2 — complete UIA with the project side's registration token. No `m.login.dummy` fallback:
  // this path exists because the project side issued us a credential, and silently registering
  // through open registration instead would create an account with a provenance nobody agreed to.
  const authRes = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      auth: { type: 'm.login.registration_token', token: registrationToken, session: probe.session },
    }),
  });
  const auth = await readBody(authRes);
  if (!authRes.ok || !auth?.access_token) {
    throw matrixError(authRes, auth, 'representative registration');
  }
  return { accessToken: auth.access_token, userId: auth.user_id || null };
}

/**
 * Bring a project side's representative into a known state, and say what that state is.
 *
 * Returns `{ accessState, detail, mxid, credentialPatch }`. It NEVER throws for a Matrix-side
 * problem: an unreachable homeserver and a rejected credential are both outcomes an operator needs
 * recorded, and a throw would make the caller choose between crashing a startup sweep and swallowing
 * the reason. It throws only for arguments that cannot be acted on at all.
 *
 * `credentialPatch` carries a newly minted representative token back to the caller for storage.
 * Returned rather than written here because this module holds no store: writing would give a network
 * helper the authority to mutate credentials, and the store's own audit trail should record who
 * changed what.
 */
export async function ensureRepresentative({
  side,
  credential,
  localpart = DEFAULT_REPRESENTATIVE_LOCALPART,
  fetchImpl = fetch,
}) {
  if (!side?.apiBaseUrl || !side?.serverName) {
    throw new RepresentativeError('bad_request', 'side must carry apiBaseUrl and serverName');
  }
  if (!credential) {
    return {
      accessState: 'unverified',
      detail: 'no credential configured for this project side',
      mxid: null,
      credentialPatch: null,
    };
  }
  const baseUrl = side.apiBaseUrl;

  if (credential.kind === 'appservice') {
    /*
     * An appservice representative is not registered — it already exists by virtue of the
     * registration the project side installed, as `sender_localpart`. Validation is a masqueraded
     * whoami: if the `as_token` is good and the namespace claim holds, the server answers with the
     * sender's own MXID.
     *
     * This is also where the agent-side payoff shows: nothing per-agent is created or stored here,
     * because on an appservice side agents have no credential at all.
     *
     * WHY MASQUERADED RATHER THAN A BARE `as_token` WHOAMI. A bare call proves only that the
     * homeserver knows the token. A masqueraded one additionally proves the namespace claim
     * functions, and it exercises the exact call shape every later agent operation uses — so a side
     * that validates here cannot fail on its first real request for a reason validation never
     * touched.
     *
     * Measured against the Palpo 0.4.0 build this deployment runs (a throwaway registration,
     * restarted, then removed): masquerading outside the claimed namespace is refused
     * `403 M_FORBIDDEN`, so the `as_token` is genuinely scoped rather than a superuser credential.
     * That is the property being checked.
     *
     * A CORRECTION KEPT DELIBERATELY. An earlier version of this comment claimed the masquerade was
     * load-bearing for a different reason: that nothing creates the `sender_localpart` account and a
     * bare call therefore fails until a masqueraded one bootstraps it. That was read out of Palpo's
     * source and symbol table, written down as "verified", and **did not reproduce** — on this build
     * a bare `as_token` whoami answers 200 with the sender's own MXID. The reason above is the one
     * that survived being tested. Noted here because the mistake is worth more than the fact: code
     * paths existing is not the same as code paths behaving, and only one of those had been checked.
     */
    const asUserId = `@${String(credential.senderLocalpart).toLowerCase()}:${side.serverName}`;
    try {
      const { userId } = await whoami({ baseUrl, token: credential.asToken, asUserId, fetchImpl });
      return { accessState: 'accepted', detail: null, mxid: userId, credentialPatch: null };
    } catch (error) {
      return {
        accessState: classifyMatrixFailure(error),
        detail: error.message,
        mxid: null,
        credentialPatch: null,
      };
    }
  }

  if (credential.kind !== 'registrationToken') {
    throw new RepresentativeError('bad_request', `unsupported credential kind: ${credential.kind}`);
  }

  // An existing representative token is VALIDATED, never replaced on a failure.
  if (credential.representativeToken) {
    try {
      const { userId } = await whoami({ baseUrl, token: credential.representativeToken, fetchImpl });
      return { accessState: 'accepted', detail: null, mxid: userId, credentialPatch: null };
    } catch (error) {
      /*
       * A 401 must NOT trigger re-registration. Two reasons, and the second is the one that bites:
       * the localpart is already taken so registration would fail anyway, and attempting it would
       * turn a clear "your token was revoked" into a confusing M_USER_IN_USE from a different call.
       * ADR-014 decision 6 wants this surfaced, not healed.
       */
      return {
        accessState: classifyMatrixFailure(error),
        detail: error.message,
        mxid: null,
        credentialPatch: null,
      };
    }
  }

  // No token yet: register, using the project side's registration token.
  if (!credential.registrationToken) {
    return {
      accessState: 'unverified',
      detail: 'no representative token and no registration token to obtain one with',
      mxid: null,
      credentialPatch: null,
    };
  }
  try {
    const { accessToken, userId } = await registerRepresentative({
      baseUrl, registrationToken: credential.registrationToken, localpart, fetchImpl,
    });
    /*
     * Confirm the identity by asking, rather than trusting the register response alone. The register
     * reply usually carries `user_id`, but not every server includes it, and an MXID this side will
     * store must come from an answer rather than a default.
     */
    let mxid = userId || null;
    if (!mxid) {
      const confirmed = await whoami({ baseUrl, token: accessToken, fetchImpl });
      mxid = confirmed.userId;
    }
    return {
      accessState: 'accepted',
      detail: null,
      mxid,
      credentialPatch: { representativeToken: accessToken },
    };
  } catch (error) {
    return {
      accessState: classifyMatrixFailure(error),
      detail: error.message,
      mxid: null,
      credentialPatch: null,
    };
  }
}

/**
 * Mint an agent identity on a project side.
 *
 * ADR-016 decision 4: an agent instance is created when an engagement is accepted, from a durable
 * resource declaration, rather than by hand ahead of demand. This is the identity half — the part that
 * could not exist before a project side did, which is the circular dependency the operator identified.
 *
 * THE TWO KINDS DIVERGE COMPLETELY HERE, and that is the payoff of making appservice mandatory:
 *
 *   - `appservice`: NOTHING IS CREATED AND NOTHING IS STORED. The account exists by virtue of the
 *     namespace the project side installed, so minting is a claim rather than an act — HAFleet will
 *     act as it later by masquerading with the side's one `as_token`. The identity is confirmed the
 *     same way the representative's is: a masqueraded whoami, which is also what makes the homeserver
 *     materialise the account.
 *   - `registrationToken`: a real account is registered and a real per-agent token comes back, which
 *     the caller must store or lose.
 *
 * The MXID is taken from the homeserver's answer in both cases, never composed (ADR-014 decision 5).
 * The localpart is what we ASK for; what we get is what the server says.
 *
 * Returns `{ minted, mxid, accessToken, kind }` and never throws for a Matrix-side outcome — the
 * caller is a provisioning path that must record a reason per agent rather than abort a sweep.
 */
export async function mintAgentIdentity({
  side,
  credential,
  localpart,
  fetchImpl = fetch,
}) {
  if (!side?.apiBaseUrl || !side?.serverName) {
    throw new RepresentativeError('bad_request', 'side must carry apiBaseUrl and serverName');
  }
  if (!credential) {
    throw new RepresentativeError('bad_request', 'a project side credential is required to mint an identity');
  }
  const wanted = String(localpart || '').trim().toLowerCase();
  if (!wanted) throw new RepresentativeError('bad_request', 'localpart is required');
  const baseUrl = side.apiBaseUrl;

  if (credential.kind === 'appservice') {
    /*
     * The namespace is checked BEFORE the call, because the homeserver's refusal for an out-of-namespace
     * masquerade is a 403 that looks identical to a bad `as_token` — and those send an operator to two
     * different places. `namespace` is the regex the registration claimed.
     */
    const claimed = `@${wanted}:${side.serverName}`;
    let pattern;
    try {
      pattern = new RegExp(`^${credential.namespace}$`);
    } catch {
      return {
        minted: false, kind: 'appservice', mxid: null, accessToken: null,
        reason: `this side's claimed namespace is not a usable regex: ${credential.namespace}`,
      };
    }
    if (!pattern.test(claimed)) {
      return {
        minted: false, kind: 'appservice', mxid: null, accessToken: null,
        reason: `${claimed} is outside the namespace this side claimed (${credential.namespace}), `
          + 'so the homeserver would refuse it — rename the agent or widen the registration',
      };
    }
    try {
      const { userId } = await whoami({ baseUrl, token: credential.asToken, asUserId: claimed, fetchImpl });
      /*
       * `accessToken: null` is the point, not an omission. An appservice agent has no per-agent
       * credential — HAFleet acts as it with the side's `as_token` — which is why ADR-014 decision 4's
       * per-agent `{ homeserver, accessToken }` is unrepresentable for such a side.
       */
      return { minted: true, kind: 'appservice', mxid: userId, accessToken: null, reason: null };
    } catch (error) {
      return {
        minted: false, kind: 'appservice', mxid: null, accessToken: null,
        state: classifyMatrixFailure(error), reason: error.message,
      };
    }
  }

  if (credential.kind !== 'registrationToken') {
    throw new RepresentativeError('bad_request', `unsupported credential kind: ${credential.kind}`);
  }
  if (!credential.registrationToken) {
    return {
      minted: false, kind: 'registrationToken', mxid: null, accessToken: null,
      reason: 'this side has no registration token, so no agent account can be created on it',
    };
  }
  try {
    const { accessToken, userId } = await registerRepresentative({
      baseUrl, registrationToken: credential.registrationToken, localpart: wanted, fetchImpl,
    });
    let mxid = userId || null;
    if (!mxid) {
      const confirmed = await whoami({ baseUrl, token: accessToken, fetchImpl });
      mxid = confirmed.userId;
    }
    return { minted: true, kind: 'registrationToken', mxid, accessToken, reason: null };
  } catch (error) {
    /*
     * M_USER_IN_USE is the one a caller must be able to act on: the localpart is taken, which happens
     * when an agent of that name was minted before and its token was lost. Surfaced by errcode rather
     * than by matching the message, which the next reword would break.
     */
    return {
      minted: false, kind: 'registrationToken', mxid: null, accessToken: null,
      state: classifyMatrixFailure(error),
      errcode: error.errcode ?? null,
      reason: error.message,
    };
  }
}
