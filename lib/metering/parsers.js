/*
 * Read the token accounting the coding CLIs already write, per framework.
 *
 * ADR-013 contract 1 is TOKEN metering — a count, not a cost (see the ADR's 2026-08-10
 * amendment). These parsers turn a session transcript into normalized token records and
 * nothing else.
 *
 * WHY READ FILES RATHER THAN PROXY THE PROVIDER. HAFleet launches a CLI that talks to
 * its provider directly, so no API response passes through HAFleet to read a figure
 * from. The alternative to reading transcripts is standing a proxy in front of every
 * agent, which only works in api-key mode, puts prompts and completions through HAFleet
 * in plaintext, and makes every agent depend on that proxy being up. Transcripts are
 * already on disk, cost nothing to read, and work on a subscription.
 *
 * THE NUMBERS ARE TRANSCRIBED, NOT COUNTED. Both CLIs record what the provider reported
 * in its API response. There is no tokenizer estimate here, which is why these figures
 * agree with a bill. Verified on real sessions: a 9,696-message Claude transcript's
 * per-message `iterations` sums matched its own `output_tokens` in every single record,
 * and Codex's cumulative `total_tokens` differed from `last_token_usage` by exactly the
 * per-turn delta.
 *
 * CACHE READS ARE KEPT SEPARATE, ALWAYS. On one real session: 4,800,089,833 cache reads
 * against 19,765 fresh input tokens. Folding them into one "input" figure is a
 * five-order-of-magnitude error, not a rounding one, and both CLIs report them apart
 * because they bill apart.
 *
 * `cwd` is read from inside the transcript rather than inferred from the directory name.
 * Claude's `~/.claude/projects/<dir>` encodes the path by replacing `/` with `-`, which
 * is fine forwards and ambiguous backwards — a path already containing `-` cannot be
 * recovered. The transcript states the real path, so attribution uses that.
 */

/** The kinds every framework is normalized to. Named for what they bill as. */
export const KINDS = ['input', 'output', 'cacheWrite', 'cacheRead'];

const zero = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const int = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);

/** Add `b` into `a` in place. */
function accumulate(a, b) {
  for (const k of KINDS) a[k] += int(b[k]);
  return a;
}

/**
 * Claude Code: one `usage` object per assistant message.
 *
 * Deduplicated by the record's `uuid`. A transcript can legitimately contain the same
 * message twice — a resumed session replays context, and `--continue` appends to the
 * same file — so summing blindly double-counts. The uuid is the CLI's own identity for
 * the record and is the only key that does not guess.
 */
export function parseClaudeSession(text) {
  const totals = zero();
  const seen = new Set();
  let cwd = null;
  let messages = 0;
  const models = new Set();

  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!cwd && typeof rec.cwd === 'string' && rec.cwd) cwd = rec.cwd;

    const usage = rec?.message?.usage;
    if (!usage) continue;
    const id = typeof rec.uuid === 'string' ? rec.uuid : null;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    if (typeof rec.message?.model === 'string') models.add(rec.message.model);
    accumulate(totals, {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
      cacheRead: usage.cache_read_input_tokens,
    });
    messages += 1;
  }

  return {
    framework: 'claude',
    cwd,
    totals,
    messages,
    models: [...models].sort(),
    // Records without a uuid cannot be deduplicated, so say how many there were rather
    // than let a silent double-count look like heavier usage.
    undedupable: messages - seen.size,
  };
}

/**
 * Codex: `token_count` payloads carrying a cumulative running total.
 *
 * Two things here were wrong in the first implementation and both were caught by
 * checking the parse against the CLI's own arithmetic rather than by reading fields.
 *
 * REASONING TOKENS ARE A BREAKDOWN OF OUTPUT, NOT AN ADDITION. Codex's own total
 * satisfies `total_tokens = input_tokens + output_tokens` exactly — on a real session
 * 28,072,373 + 98,537 = 28,170,910 — and `reasoning_output_tokens` (42,624) is smaller
 * than `output_tokens`, so it is contained in it. Adding it again overstated output by
 * 43%, and the error was visible only because the sum was compared to the total the CLI
 * had already computed.
 *
 * INPUT INCLUDES THE CACHED PORTION, so fresh input is the difference. Reporting both as
 * given would count the cache twice, once at the fresh-input rate.
 */
export function parseCodexSession(text) {
  let cwd = null;
  let last = null;
  let turns = 0;
  let nonMonotonic = 0;
  let prevTotal = -1;

  const asKinds = (t) => {
    const cached = int(t.cached_input_tokens);
    return {
      // Codex's `input_tokens` INCLUDES the cached portion, so fresh input is the
      // difference. Adding both as reported would count the cache twice, once at the
      // input rate — the same error as folding cache reads into input, from the other
      // direction.
      input: Math.max(0, int(t.input_tokens) - cached),
      cacheRead: cached,
      cacheWrite: 0,
      // NOT `+ reasoning_output_tokens`: it is already inside output_tokens. See above.
      output: int(t.output_tokens),
    };
  };

  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const p = rec?.payload ?? {};
    if (!cwd && typeof p.cwd === 'string' && p.cwd) cwd = p.cwd;

    const total = p?.info?.total_token_usage;
    if (!total || typeof total !== 'object') continue;
    const t = int(total.total_tokens);
    // A turn is a change in the running total. The count of token_count records is not
    // the count of turns.
    if (t !== prevTotal) turns += 1;
    if (t < prevTotal) nonMonotonic += 1;
    prevTotal = t;
    last = total;
  }

  /*
   * THE SESSION TOTAL IS THE CLI'S OWN RUNNING TOTAL, NOT A SUM OF PER-TURN DELTAS.
   *
   * Summing `last_token_usage` was the first implementation and it double-counted:
   * `token_count` records repeat the same delta more than once per turn, so a real
   * session's summed cache reads came to 52,909,824 against the CLI's own cumulative
   * 26,522,496 — roughly double, and the output figure nearly triple. The single delta
   * at the end of the file matched, which is exactly why checking only that was not
   * enough.
   *
   * `total_token_usage` is monotonic and authoritative, so the final record IS the
   * session total. Per-turn figures, if ever needed, come from differences of
   * consecutive totals rather than from the delta field.
   */
  return {
    framework: 'codex',
    cwd,
    totals: last ? asKinds(last) : zero(),
    turns,
    reasoningOutput: last ? int(last.reasoning_output_tokens) : 0,
    // Reported so a caller can tell a truncated or rewritten transcript from a clean
    // one; the total would be understated rather than merely imprecise.
    nonMonotonic,
    cumulativeTotal: last ? int(last.total_tokens) : 0,
    /*
     * The CLI's own arithmetic, restated so a caller can check the parse rather than
     * trust it. `input + cacheRead + output` must equal `total_tokens`; a mismatch means
     * this parser has drifted from the format, which is exactly how the reasoning
     * double-count was found.
     */
    agreesWithCli: last
      ? (int(last.input_tokens) + int(last.output_tokens)) === int(last.total_tokens)
      : null,
  };
}

/**
 * Frameworks with a parser, and why the others have none.
 *
 * REQ-CONTRIBUTION-CONSOLE-METERING-SCOPE requires availability reported per framework.
 * Octos is absent on evidence, not on suspicion: its session files under `~/.octos`
 * carry `content`, `role`, `session_key` and timestamps, with no usage object and no
 * `cwd` — so neither the count nor the attribution exists to read. An earlier probe
 * appeared to find usage there and was a false positive: a tool result whose text
 * happened to contain the word "token".
 */
export const PARSERS = {
  claude: parseClaudeSession,
  codex: parseCodexSession,
};

export const UNSUPPORTED = {
  octos: 'octos session files record no usage object and no cwd, so consumption can be '
    + 'neither counted nor attributed from them',
  'codex-acp': 'no transcript location verified for this adapter',
  hermes: 'no transcript location verified for this adapter',
};

/**
 * What can be metered for a framework, and why not when it cannot.
 *
 * Never a bare boolean: "unavailable" without a reason sends an operator looking at
 * credentials or permissions when the answer is that the CLI does not write the number.
 */
export function meteringSupport(frameworkId) {
  const id = String(frameworkId ?? '').toLowerCase();
  if (PARSERS[id]) return { framework: id, available: true, reason: null };
  return {
    framework: id,
    available: false,
    reason: UNSUPPORTED[id] ?? 'no metering adapter exists for this framework',
  };
}
