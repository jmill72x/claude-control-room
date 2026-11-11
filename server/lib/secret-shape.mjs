// A small check for text that looks like it carries a credential, for the chat
// (the lead's replies, jarvis-os-chat-spec.md and the channel review's point 5).
// Pattern names only ever leave this file: never the match.
const PATTERNS = [
  ['an Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['an OpenAI-style key', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['a GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['a private key block', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['a Discord webhook', /discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/],
  ['a bearer token', /\bBearer\s+[A-Za-z0-9._-]{30,}/],
  ['a Tailscale key', /\btskey-[a-z]+-[A-Za-z0-9]{10,}/]
];

export function secretShapes(text) {
  const s = String(text ?? '');
  return PATTERNS.filter(([, re]) => re.test(s)).map(([name]) => name);
}
