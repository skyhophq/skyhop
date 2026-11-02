// Finds likely secrets. Findings hold a masked preview and never the secret itself.
import path from 'node:path';

const TOKEN_RULES = [
  ['private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ['GitHub token', /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g],
  ['OpenAI API key', /\bsk-(?:proj-|svcacct-)?(?!ant-)[A-Za-z0-9_-]{32,}\b/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/g],
  ['Stripe live key', /\b[sr]k_live_[A-Za-z0-9]{20,}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/g],
];

const ASSIGNMENT_RULE = /(?:api[_-]?key|secret|token|passw(?:or)?d)["']?\s*[:=]\s*["']([^"'\s]{16,})["']/gi;
const PLACEHOLDER = /\$\{|<[^>]+>|\.\.\.|x{4,}|example|changeme|placeholder|your[_-]|process\.env|dummy|test/i;

const SENSITIVE_NAMES = new Set([
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.npmrc', '.pypirc', '.netrc',
  '.git-credentials', 'credentials.json', 'secrets.json', 'service-account.json',
]);

export function isSensitivePath(file) {
  const base = path.posix.basename(file).toLowerCase();
  if (/^\.env(\..+)?$/.test(base)) return !/\.(example|sample|template|dist|defaults?)$/.test(base);
  return SENSITIVE_NAMES.has(base) || /\.(pem|key|p12|pfx|jks|keystore|tfvars)$/.test(base);
}

function mask(value) {
  return `${value.slice(0, 4)}… (${value.length} characters)`;
}

// Signed download links carry an AWS access key ID, which is the public half of a
// key. It sits right after one of these names, so those matches aren't findings.
const PUBLIC_KEY_ID_FIELD = /(?:X-Amz-Credential|AWSAccessKeyId)(?:=|%3[Dd])$/;

function matchesIn(text, strict) {
  const found = [];
  for (const [rule, pattern] of TOKEN_RULES) {
    for (const match of text.matchAll(pattern)) {
      const isPublicKeyId = rule === 'AWS access key' && PUBLIC_KEY_ID_FIELD.test(text.slice(Math.max(0, match.index - 20), match.index));
      if (!isPublicKeyId) found.push({ rule, index: match.index, value: match[0] });
    }
  }
  if (!strict) {
    for (const match of text.matchAll(ASSIGNMENT_RULE)) {
      if (!PLACEHOLDER.test(match[1])) found.push({ rule: 'hardcoded credential', index: match.index, value: match[1] });
    }
  }
  return found;
}

// strict skips the broad assignment rule, for text full of code and quoted docs.
export function scanText(text, { source, strict = false }) {
  return matchesIn(text, strict).map(({ rule, index, value }) => ({
    rule,
    source,
    line: text.slice(0, index).split('\n').length,
    preview: mask(value),
  }));
}

// Reads `git log -p --unified=0 --format=commit:%H` and checks only added lines.
export function scanDiff(diff) {
  const findings = [];
  let commit = null;
  let file = null;
  let line = 0;
  for (const text of diff.split('\n')) {
    if (text.startsWith('commit:')) {
      commit = text.slice('commit:'.length, 'commit:'.length + 8);
      file = null;
    } else if (text.startsWith('+++ ')) {
      const target = text.slice(4).replace(/^"|"$/g, '');
      file = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (file && isSensitivePath(file)) findings.push({ rule: 'sensitive file', source: file, commit, line: null, preview: 'file is in an unpushed commit' });
    } else if (text.startsWith('@@ ')) {
      line = Number(text.match(/\+(\d+)/)?.[1] ?? 1);
    } else if (text.startsWith('+') && file) {
      for (const match of matchesIn(text.slice(1), false)) {
        findings.push({ rule: match.rule, source: file, commit, line, preview: mask(match.value) });
      }
      line += 1;
    }
  }
  return findings;
}

export function formatFinding({ rule, source, line, commit, preview }) {
  const where = [source, line].filter(value => value !== null && value !== undefined).join(':');
  return `${where}${commit ? ` (commit ${commit})` : ''}: ${rule}, ${preview}`;
}
