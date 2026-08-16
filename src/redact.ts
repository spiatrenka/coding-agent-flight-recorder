/**
 * Redaction of high-confidence secrets in stored tool output.
 *
 * Transcripts capture whatever a command printed, which regularly includes the
 * contents of a .env, an exported token, or a connection string. The store is a
 * second copy of that data with a longer lifetime than the 30-day transcript, so
 * it gets scrubbed on the way in.
 *
 * Deliberately conservative: only patterns that are almost certainly credentials.
 * Over-redaction destroys the evidence value of the record.
 */

const MASK = "[redacted]";

const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // KEY=value where the key name looks like a credential
  [
    /\b([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET|AUTH)[A-Z0-9_]*)\s*[=:]\s*["']?([^\s"'#,;]{6,})/gi,
    `$1=${MASK}`,
  ],
  [/(authorization\s*:\s*bearer\s+)\S+/gi, `$1${MASK}`],
  // vendor key shapes
  [/\bsk-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bghp_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, MASK],
  // connection strings with inline credentials
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+(@)/gi, `$1${MASK}$2`],
  // PEM blocks
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    `-----BEGIN PRIVATE KEY----- ${MASK} -----END PRIVATE KEY-----`,
  ],
];

export function redact(text: string | null | undefined): string {
  if (!text) return text ?? "";
  let out = String(text);
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function containsSecret(text: string | null | undefined): boolean {
  return Boolean(text) && redact(text) !== String(text);
}
