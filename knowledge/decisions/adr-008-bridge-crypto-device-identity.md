---
kind: decision
id: ADR-008
title: "Bind bridge crypto storage to the access-token device"
status: Accepted
liveness: auto
tags: [matrix, e2ee, approval, device]
---

## Context

A Matrix access token is issued to one device, while matrix-bot-sdk persists an
independent `deviceId` beside the Rust crypto database. Replacing a cached token
without replacing that crypto database can split the bridge identity: `/whoami`
reports the new token device, but the crypto machine continues with the old
device's private keys. The homeserver then routes Olm-encrypted Megolm room keys
to a device the running crypto machine cannot decrypt. Approval verdict events
arrive on time but remain undecryptable until the backend TTL expires.

## Decision

Before constructing the encrypted bridge client, hafleet queries `/whoami`
with the active bot token and compares its `device_id` with the crypto store's
persisted device ID.

- Matching identities reuse the store.
- A non-empty store without a readable identity fails closed.
- A mismatched store is atomically renamed to a timestamped archive and retained
  for rollback or forensic recovery.
- The replacement store is initialized by matrix-bot-sdk for the token device.
- After crypto initialization, startup asserts that the crypto client device ID
  still matches `/whoami`.

Logs may include device IDs and the local archive path, but never access tokens,
private keys, ciphertext, or key material.

## Consequences

Positive: room-key delivery and decryption use one Matrix device identity,
and token rotation cannot silently convert timely approvals into expirations.

Positive: stale private keys remain recoverable instead of being deleted.

Negative: previously queued events encrypted for the old broken session may
remain undecryptable; they retain fail-closed semantics and expire normally.

## Alternatives Considered

- Reuse the old crypto database after token rotation: rejected because the
  token and private keys represent different devices.
- Rewrite only `bot-sdk.json`: rejected because it would relabel old private
  keys as another device and corrupt the cryptographic identity.
- Delete the old store: rejected because archival is equally effective and
  preserves rollback and incident evidence.
