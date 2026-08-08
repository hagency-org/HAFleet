# HAFleet contribution console — clickable prototype

A Next.js app implementing the design in
[`../docs/design/hafleet-as-contribution-console.md`](../docs/design/hafleet-as-contribution-console.md).
Mock data only: it talks to no backend and cannot affect a fleet.

```bash
cd mockup
npm install
npm run build && npm start   # http://localhost:3100
```

## Who this is for

The **resource provider** — 带资入组的开源贡献者. Somebody who contributes to a project not
by writing code but by **lending agent capacity**, and who needs to control exactly what they
lend, in which configuration, and how much it may cost them.

Every earlier version of this console assumed the opposite persona: a house dispatching workers
to projects. Nothing about scheduling survives that change. The previous design is preserved at
tag `mockup/pdu-two-lens`.

Two consequences:

- **Dispatch is not ours.** Which task an agent does is decided on the project side. There is
  no scheduler, no role×tier grid, no lease table.
- **The console faces inward.** It answers *what am I offering, on what terms, and what is it
  costing me* — not *who is working on what*.

## Four layers

```
L4  用量   /usage         what my agents did, for whom, and what it cost
L3  接洽   /engagements   standing offer + whitelist → auto-join · else approve
L2  能力   /capability    role templates: which (agent × model) combinations qualify
                          ↑ THIS is what projects see — roles, never raw agents
L1  资源   /resources     my agents, their model configuration, their token ceiling
```

The boundary that matters: **a project asks for a System Architect, never for
`octos-agent running kimi-k3`.** The mapping between the two is private to the contributor,
which is what makes this a resource market rather than a directory of remote shells.

## Routes

| route | what it answers |
|---|---|
| `/resources` | What I lend, on what terms, how much is already promised. `/` serves it |
| `/resources/new` | The wizard: framework → model → reasoning → budget |
| `/capability` | The six roles, who can fill each, and what I publish |
| `/engagements` | Inbound requests, the routing that decided them, and the whitelist |
| `/usage` | What ran, for whom, and the metering gap |
| `/agents/[name]` | One agent: what it contributes, its ceiling, who it serves |
| `/onboard` | What this host can employ, and bringing one up with a preset |
| `/alerts`, `/config` | Incidents; fleet-wide policy and the destructive things |

## Decisions you can see working

- **The role mapping is imported, not copied.** `lib/mock-data.js` imports
  `../../lib/role-capacity.json` — the file the product ships — so the prototype cannot
  advertise a role the product does not define. An assertion compares the two byte for byte.
- **The role vocabulary is the system's own.** Six roles, three tiers, per-role default tier
  and subsumption, all from `lib/matrix-agent.js:11-35`. A contributor may narrow the catalogue
  by withholding an offer; they may not invent a role, because the project side has to
  recognise the name.
- **Reasoning is part of the match.** `gpt-5.6-sol` appears at all three tiers and only the
  thinking level tells them apart. Matching on (framework, model) alone silently promoted a
  medium-thinking Codex agent to `strong` — which would have advertised an architect the
  contributor never configured. Caught by probing the fixture before any UI existed.
- **Subsumption is shown, never prevented.** A `strong` agent fills every role and pays Opus
  rates to write documentation. That trade is the contributor's, so the card names it — once
  per card, not once per agent, because eight identical warnings buried the one fact worth
  reading.
- **Cross-family review is a definition, not a warning.** `matrix-agent.js:26` says a reviewer
  should come from a different model family than the author, so a contributor lending one
  family cannot staff both sides however many agents run it.
- **An unconfigured agent contributes nothing, and says so.** Registered, running, and useless
  because nobody chose a model. That is not an edge case — it is what every agent looks like
  today, since no onboarding path writes a preset.
- **The ceiling is per agent.** An engagement draws on one agent's ceiling, so two projects
  wanting an architect served by the same Opus agent share that 5M. The approval row names the
  agent *before* the decision, and refuses an allocation that would over-commit.
- **A whitelisted project over its cap falls back to approval, never rejection.** Asking for
  more than is left is not a fault. That rule is what keeps the standing offer and the approval
  queue coherent.
- **The whitelist is keyed on the Matrix room id.** A display name can be changed to match a
  project you trust; the room id cannot. `ROOM_ID_RE` at `lib/approval-store.js:19` already
  validates it, and an assertion checks a spoofed name buys nothing.
- **Auto-joined engagements are listed, never hidden.** An auto-approval you cannot see
  afterwards is indistinguishable from a compromise.
- **De-trusting cannot cancel work.** Removing a project affects future requests only;
  revoking a running engagement is a separate, confirmed act.
- **A blank is never a zero.** Nothing in HAFleet meters tokens, so every consumption figure is
  a dash with a reason. `0` would claim a measurement nobody takes.
- **An unenforced ceiling says so beside the number**, or a reader treats a declaration of
  intent as a guard rail.
- **"Agent" stays in Latin script in Chinese.** 代理 means *proxy* in Chinese technical usage,
  and an earlier dictionary used it for both senses in adjacent keys — `ACP 代理没有终端窗格`
  (agent) beside `原型不会代理真实的终端窗格` (proxy), with `代理令牌` reading as "proxy token".
  Both the term and CJK/Latin spacing are asserted.

## What is drawn as a contract

Never as data a backend would return. In dependency order:

1. **Token accounting.** The largest gap: nothing meters tokens at any granularity — every
   `usage`/`budget` match in `lib/` and `backend-v2.js` is a CLI help string. Without it,
   ceilings are decoration and `/usage` is empty.
2. **A token ceiling on a preset** — `{ tokens, period, rateCapPerDay }`.
3. **`GET /api/frameworks/detect`**, which `/onboard` is drawn against.
4. **Inbound engagement requests**, plus approve/reject writing a per-agent allocation.
   `lib/approval-store.js` is the pattern: durable, audited, terminal states, TTL.
5. **The standing offer** and **the whitelist**, both with an audit trail.

What already exists and is used as-is: the agent registry, framework manifests and their flag
guards, `runtimeProfile` (`{ framework, provider, model, reasoning, … }` at
`backend-v2.js:713`), `framework-presets.json` with its API, the approval store's
`(agent, project, room, owner)` binding, `lib/task-store.js`, and `lib/alert-store.js`.

## Checks

```
npm run check            # static assertions against the served HTML
npm run check:switches   # assertions that need a real browser
npm run verify           # both
```

**90 static** and **29 in-browser**. `check-invariants.mjs` needs the server running
(`npm start`); `check-switches.mjs` also needs Chrome — it drives the system install through
`puppeteer-core` and downloads nothing (`CHROME=/path/to/chrome` to override).

Two classes of check live in the browser pass **because they cannot work anywhere else**, and
each was first written in the static pass, where it passed while the bug was in:

- **a doubled em dash** — `.why-inline::before` draws one, so a component that also emits a
  `.mk-dash` renders `— — reason`. Generated content is not in the HTML and not in `innerText`.
- **a welded cell** — `claude-agent1.1M left` and `5.0Mnot enforced` are adjacent inline spans.
  The markup is identical whether they read correctly or not; only the computed `display`
  distinguishes them.

Every assertion added here was **mutation-tested**: the bug was reintroduced and the check
confirmed to fail. Mutation testing shows an assertion is load-bearing, not that it measures
the right thing — two checks earlier in this prototype's history passed while sharing a broken
oracle with the code they claimed to constrain.

## Known limits

A prototype: no backend, no persistence, no live pane proxying, and the numbers are
illustrative rather than measured.

- The fixture has five agents and four presets. Layout at 1 / 20 / 100 is untested and needs
  fixture variants rather than layout changes.
- Model strings for Octos and Hermes are the provider families named by the operator, not
  strings read off an installed CLI. `lib/role-capacity.json` marks which are verified.
- `docs/design/shots/` is generated by `node scripts/shots.mjs`, which fails if a shot's page
  is not actually in the locale and theme it claims.
