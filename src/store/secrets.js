/**
 * Detects credentials that should never be written to shared memory.
 *
 * Memory is plain text, shared by every agent and copied into prompts, so a
 * leaked key spreads quickly. Patterns are deliberately specific (known
 * prefixes and formats) to avoid rejecting ordinary prose.
 */

const PATTERNS = [
  ["private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["Anthropic/OpenAI API key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Stripe secret key", /\b[sr]k_live_[0-9A-Za-z]{20,}\b/],
  ["JSON Web Token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  // user:password@host — placeholders like ${DB_PASS}, <password> or *** are allowed
  ["connection string with password", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/$<{*][^\s@/]{2,}@[^\s]+/i],
];

/**
 * @param {string} text
 * @returns {string|null} name of the first credential type found, or null
 */
export function findSecret(text) {
  for (const [name, re] of PATTERNS) {
    if (re.test(text)) return name;
  }
  return null;
}
