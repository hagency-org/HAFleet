import { readFileSync } from 'fs';

const VALID_STATUS = new Set(['FOCUSED', 'DRIFTING', 'LOST', 'STUCK']);
const VALID_DOMAIN = new Set(['core', 'adjacent', 'outside']);
const VALID_PATTERN = new Set(['rabbit_hole', 'worry_driven', 'while_im_here', 'perfectionism', 'stuck_loop']);

function fillTemplate(template, values) {
  return template
    .replaceAll('{current_task}', values.currentTask || '(missing)')
    .replaceAll('{role_and_boundaries}', values.roleAndBoundaries || '(missing)')
    .replaceAll('{pane_content}', values.paneContent || '(empty)');
}

function normalizeJsonText(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.startsWith('{') && text.endsWith('}')) return text;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) return fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}

function parseJudgment(raw) {
  const cleaned = normalizeJsonText(raw);
  if (!cleaned) throw new Error('empty llm response');
  const parsed = JSON.parse(cleaned);

  const statusRaw = String(parsed.status || '').trim().toUpperCase();
  const status = VALID_STATUS.has(statusRaw) ? statusRaw : 'STUCK';

  const domainRaw = String(parsed.domain || '').trim().toLowerCase();
  const domain = VALID_DOMAIN.has(domainRaw) ? domainRaw : 'outside';

  const reason = String(parsed.reason || '').trim() || 'No reason provided.';

  const patternRaw = String(parsed.pattern || '').trim().toLowerCase();
  const pattern = (patternRaw && patternRaw !== 'null' && VALID_PATTERN.has(patternRaw)) ? patternRaw : null;

  const suggestionRaw = String(parsed.suggestion || '').trim();
  const suggestion = (!suggestionRaw || suggestionRaw.toLowerCase() === 'null') ? null : suggestionRaw;

  return { status, domain, reason, pattern, suggestion };
}

function endpointFor(config) {
  return config.llm.endpoint;
}

async function callOpenAICompatible(config, prompt) {
  const body = {
    model: config.llm.model,
    temperature: config.llm.temperature,
    max_tokens: config.llm.maxTokens,
    messages: [
      { role: 'system', content: 'You are a strict JSON generator. Output only valid JSON.' },
      { role: 'user', content: prompt },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llm.timeoutMs);
  try {
    const resp = await fetch(endpointFor(config), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`llm http ${resp.status}: ${errText.slice(0, 220)}`);
    }
    const json = await resp.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) throw new Error('llm response missing choices[0].message.content');
    const usage = json?.usage || null;
    return { content, usage };
  } finally {
    clearTimeout(timer);
  }
}

export class LLMJudge {
  constructor(config) {
    this.config = config;
    this.promptTemplate = readFileSync(config.promptPath, 'utf-8');
  }

  async evaluate(context) {
    const roleAndBoundaries = [
      context.docs.roleText || '(missing role section)',
      context.docs.boundariesText || '(missing boundaries section)',
    ].join('\n\n');

    const prompt = fillTemplate(this.promptTemplate, {
      currentTask: context.docs.currentTask,
      roleAndBoundaries,
      paneContent: context.pane.text,
    });

    const started = Date.now();
    const { content, usage } = await callOpenAICompatible(this.config, prompt);
    const judgment = parseJudgment(content);

    return {
      ...judgment,
      raw: content,
      provider: this.config.llm.provider,
      model: this.config.llm.model,
      usage,
      latencyMs: Date.now() - started,
    };
  }
}
