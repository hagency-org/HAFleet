# Agent Operations client V1 threat model

This document explains the security reasoning behind ADR-012. Normative
requirements live in `REQ-AGENT-OPS-CLIENT`; canonical wire details live under
`specs/fixtures/agent-ops-client-v1/`.

## Assets

- Router task, dispatch, session, lease, and workspace state.
- The authority to cancel work, clear an inspected dirty marker, or resolve an
  ambiguous runner outcome.
- Owner identity and private owner-DM metadata.
- Local workspace paths and backend, Matrix, provider, agent, runner, and
  approval credentials.

## Trust boundaries

- Agent-chat and its RouterStore are trusted authorization and mutation
  authorities.
- The Matrix bridge is trusted only to attest evidence it directly observed:
  the original encrypted envelope, exact room and sender, restricted room
  membership, and current Matrix device keys. It authenticates to the backend
  with the existing bridge secret.
- Matrix supplies the encrypted bootstrap control plane. A homeserver can
  delay or suppress traffic; it cannot produce the enrolled device's client
  proof key or data-plane Ed25519 signatures.
- Robrix2 is an untrusted presentation/request client. It may be buggy or
  compromised and cannot widen its server-issued scope or actions.
- Other local processes are hostile. Loopback placement is not authentication;
  proof of possession, server pinning, session expiry, and capabilities remain
  mandatory.

## Principal threats and controls

| Threat | Control |
|---|---|
| Dashboard token copied into Robrix2 | Separate route/auth boundary; Dashboard bearer is never accepted |
| Public/plaintext Matrix bootstrap | Exact encrypted owner-DM envelope and restricted membership required |
| New or compromised Matrix device self-enrolls | Exact operator-enrolled device id and keys; no TOFU |
| Local port squatting or wrong backend | Server key fingerprint delivered over encrypted Matrix and signed responses |
| Session bearer stolen | Every request also needs a fresh Ed25519 proof from the client ephemeral key |
| Proof or grant replay | Persistent single-use grant and nonce records plus short expiry |
| Cross-project/agent confused deputy | Every object binds the same explicit four-part scope and auth fence |
| Stale UI executes a now-invalid action | Entity version, dirty generation, action capability and live CAS |
| HTTP response lost after commit | Request id plus canonical semantic digest returns the stored result |
| Client invents approval or state transition | No approval action; backend-issued action allow-list; existing RouterStore transition only |
| Secret/path leakage | Server-side projection allow-list and privacy rejection before serialization |
| Event gap produces false current state | Events only invalidate; epoch/fence/gap forces a complete snapshot |
| Backend restarts or database is replaced | Persistent auth state and stream epoch; unverifiable sessions fail closed |
| Device/binding is revoked | Persistent auth-fence rotation revokes grants, sessions, and derived actions |

## Residual risks

- A fully compromised enrolled owner device and Robrix2 process can use the
  authority the owner deliberately granted until revocation or expiry.
- A compromised homeserver can deny service and delay revocation delivery.
  Backend fences are authoritative once the bridge records the change.
- V1 is same-host only. It does not claim that plaintext loopback traffic is
  safe across containers, remote hosts, browser origins, or hostile network
  namespaces.
- Privacy filtering is an allow-list plus path/secret rejection, not a general
  data-loss-prevention system. New projected fields require contract review.

