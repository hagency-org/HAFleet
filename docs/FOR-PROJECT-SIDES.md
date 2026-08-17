# What a project side has to do

You have a Matrix homeserver and you want HAFleet's agents working in one of your rooms. This is
everything you must do, why each step exists, and what HAFleet will not do for you.

It is written because the third live run of the full chain found a step nobody had written down: a
marketplace entry makes a project **reachable**, and staffing its room needs a permission only the
project can grant. The chain failed there with a bare `M_FORBIDDEN`, which is the least useful thing a
protocol can say.

Nothing here asks you to trust HAFleet with your homeserver's admin. Every step is a grant you can see
in your own room state and withdraw the same way.

## 1. Give HAFleet a credential — one of two kinds

HAFleet needs to be able to act on your homeserver as *itself*, and to give its dispatched agents
accounts there. Pick whichever fits your operational rules.

**An appservice registration** (recommended). You install a registration file and restart your
homeserver once; after that no agent ever registers again, because the namespace covers all of them.

```yaml
id: hafleet
url: http://<hafleet host>:8009
as_token: <you generate this>
hs_token: <you generate this>
sender_localpart: hafleet
namespaces:
  users:
    - exclusive: true
      regex: "@ac_.*"
  aliases: []
  rooms: []
```

**`<hafleet host>` is reachable FROM YOUR HOMESERVER, which is not always where you are typing.** If your
homeserver runs in a container, `127.0.0.1` there is the container itself and HAFleet will never receive a
single event — the appservice looks installed and is deaf. A cold-start rehearsal of this document hit
exactly that, on a Docker Palpo, and the symptom is silence rather than an error: use
`host.docker.internal`, the host's LAN address, or whatever your container network calls the outside.

Verify it before moving on, from *inside* the homeserver:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://<hafleet host>:8009/
# 403 is the right answer — HAFleet refusing an unauthenticated GET means it is listening.
# Connection refused or a timeout means your homeserver cannot see it.
```

Two things learned the hard way against Palpo 0.4.0, both of which cost an afternoon each:

- The registration path in your homeserver config must be a **top-level** key. Nested under another
  section it is silently ignored, and everything then fails as though the token were wrong.
- Palpo (and homeservers like it) **persist registrations in the database, keyed by id**. Replacing the
  file and restarting does *not* update an existing registration. Changing an `as_token` means deleting
  the stored row, not editing the file.

**A registration token** is the alternative: HAFleet registers a representative account and one account
per agent, each with its own access token. More accounts, no appservice, no restart.

Whichever you choose, the credential is **write-only** from HAFleet's console: it can be entered and
replaced, and no endpoint will ever hand it back. To check whether it works you read a verdict
(`accessState`), never the token.

### If HAFleet is not reachable from your homeserver — run the doorway instead

An appservice is INBOUND: your homeserver pushes transactions to the `url` above, so HAFleet has to be
reachable from your server. When it is not — a fleet on a laptop, on an internal network, behind NAT —
there are two ways out, and neither needs anything exposed.

**A registration token instead** (see the alternative below). Purely outbound: HAFleet connects to you.
Nothing to install, nothing to restart.

**Or co-locate the appservice.** You run one small HAFleet process beside your homeserver:

```bash
node bin/hafleet-appservice-edge \
  --registration /path/to/the-registration.yaml \
  --link-token "<a secret you and HAFleet share>" \
  --port 8095
```

and the registration's `url` points at THAT, on your own machine. HAFleet then dials it to collect. Your
homeserver never leaves your host, and HAFleet never accepts a connection.

`--check` reports whether your homeserver has ever called and whether HAFleet has ever collected, which
are different problems with different owners.

**"Co-located" means the same network namespace, not the same computer.** A containerised homeserver's
`127.0.0.1` is the container, not the host — so a doorway running on the host needs the address the
container uses for it (`host.docker.internal` under Docker Desktop or Colima). A walkthrough of this page
got that wrong on the first attempt and saw exactly the documented silence; `--check` said "the homeserver
has never called", which is what it is for.

**What that process is and is not.** It holds no fleet credential, stores nothing, and makes no decision —
which agent, which room, whether to answer at all stays in HAFleet. It authenticates your homeserver with
the `hs_token` from the registration already on your disk, and authenticates HAFleet with a separate link
token. Two secrets, because anyone who can read the registration can read the first one, and draining the
queue is reading your rooms' traffic.

**It answers your homeserver only after HAFleet has processed the events.** Matrix retries on anything but
a 2xx, so acknowledging on receipt would tell your server "handled" about events still in flight. Nothing
is queued or persisted anywhere: unacknowledged work is work your homeserver has not been told about, and
it sends it again.

## 2. Keep the intake room unencrypted

The room where you talk to HAFleet — where you ask for work — must not be encrypted.

This is not a preference. An appservice has **no crypto store**, so an encrypted room is one HAFleet's
intake cannot read at all. It will not fail loudly on your side; it will simply never see your messages.
HAFleet raises an alarm when it detects this, and there is no fix after the fact: **encryption cannot be
removed from an existing Matrix room.** A room that was created encrypted has to be replaced.

What protects the content is not encryption but membership: it is your own request about your own work,
in an invite-only room whose members you control.

## 3. If you publish an alias, expect a knock

The invite object is a room alias plus `knock`:

```
publish  #your-project:your-server
set      join_rule: knock
```

HAFleet's representative knocks. You accept by inviting it. It joins, and from that moment your requests
in that room reach HAFleet.

A knock is a **pull** — HAFleet asks and waits. It is not access, and accepting it is not accepting any
work: every request still goes through the contributor's own approval and their token budget. Joining a
room costs nothing; lending an agent spends someone's tokens.

## 4. Grant the representative power to invite — the step that was missing

**This is the one that surprises people, because Matrix's default hides it.**

When HAFleet enters a room *you* created, it arrives with `users_default` power — normally **0**. A
default Matrix room requires power **50** to invite anyone. So the representative is in your room and
cannot bring a single agent into it. The engagement is approved, the budget is committed, and the agent
is nowhere.

Two ways to fix it, and both are yours:

```jsonc
// Either: let the representative invite (one state event in your room)
{
  "invite": 50,
  "users": { "@you:your-server": 100, "@hafleet:your-server": 50 }
}
```

or invite each agent yourself when HAFleet tells you which one it assigned. The approval response names
it (`roomAdmission.mxid`), so it is not a guess.

If you skip this, HAFleet will not fail silently: the approval answers
`reason: "representative_lacks_invite_power"` and names the power it holds, the power required, and both
remedies. But it cannot raise its own power, and it will not ask you for admin rights so that it could.

## 5. Allocate tokens, or nothing runs

A project side carries one total allocation. **Unallocated is not unlimited** — it refuses all work, and
zero is a deliberate closure that keeps the side configured.

Admission happens at **acceptance**: HAFleet checks your allocation when an engagement is approved, not
when work is done. A refusal names the shortfall and raises an alarm on the contributor's side, because
the person who can raise an allocation is not the person whose request was refused.

One consequence worth knowing: lowering an allocation does **not** retract commitments already granted.
The gate stops new ones. An agent can therefore be past a ceiling you lowered, and HAFleet shows and
pages that state rather than hiding it.

## What HAFleet will not do

- **It will not ask for admin on your homeserver.** Every capability above is a scoped grant visible in
  your own room state.
- **It will not read encrypted rooms.** It says so instead of pretending.
- **It will not treat a link click as consent.** No alias, invite or knock authorises work; only a
  contributor's approval does.
- **It will not delete your rooms.** Rooms HAFleet creates on your server stay yours to remove.

## Two things a rehearsal of this page found

Both cost time in a cold-start walkthrough on a clean homeserver, and neither produces an error message
that points at the cause.

**A repeated invite is not a new event.** If HAFleet's representative was already invited and you invite
it again, most homeservers record nothing new — so nothing is pushed to HAFleet and nothing happens.
Kick it and invite again, or send any message in the room, to produce an event the appservice can see.

**The `hs_token` in your registration file is the one HAFleet must be told.** Getting it wrong is refused
with a fingerprint pair in HAFleet's log (`presented …, configured …`) rather than a hint about which of
the two is stale — and after you fix it, HAFleet's bridge picks the new value up on its next refresh,
about a minute.

## What is still missing, so you are not surprised

- Nothing detects a **federating** homeserver in production yet in a way that has been proven live —
  HAFleet's own deployment has a single homeserver, so the federation path is tested but unwitnessed.
- If your side is removed from HAFleet, its own records are swept, but the **bridge's local room state**
  is not — stale rooms can linger on HAFleet's side, harmless and untidy.
- Nothing re-admits an agent that loses membership while **idle** faster than the hourly sweep.
