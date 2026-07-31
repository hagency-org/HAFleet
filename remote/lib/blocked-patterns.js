export const BLOCK_TIER_TRANSIENT = 0;
export const BLOCK_TIER_SOFT = 1;
export const BLOCK_TIER_HARD = 2;

export const BLOCK_PATTERNS = [
  { reason: 'select-mode', tier: BLOCK_TIER_TRANSIENT, re: /(?:^|\n)\s*(?:select mode|choose (?:an?\s+)?mode)\s*(?:\n|$)/i },
  { reason: 'plan-mode', tier: BLOCK_TIER_TRANSIENT, re: /(?:^|\n)\s*(?:[0-9]+[.)]\s*)?plan mode\s*(?:\n|$)/i },
  { reason: 'approval-mode-toggle', tier: BLOCK_TIER_TRANSIENT, re: /bypass permissions on \(shift\+tab to cycle\)/i },
  { reason: 'update-required', tier: BLOCK_TIER_HARD, re: /updates?\s+available:|update available.*hafleet-update|run ['"`]?hafleet-update/i },
  { reason: 'interactive-confirm', tier: BLOCK_TIER_SOFT, re: /choose (an )?option|press (enter|return) to continue|confirm .*continue/i },
  { reason: 'api-image-error', tier: BLOCK_TIER_HARD, re: /API Error:.*Could not process image/i },
  { reason: 'api-invalid-request-loop', tier: BLOCK_TIER_SOFT, re: /API Error:\s*400\b.*invalid_request_error/i },
];
