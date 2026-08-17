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

export const MASK = "[redacted]";

/**
 * `[label, pattern, replacement]` — the label is what an audit reports.
 *
 * **Order matters: specific before generic.** The generic credential-named
 * variable rule used to run first, and on `Authorization: Bearer <token>` it
 * matched the key `Authorization` with the *word* `Bearer` as its six-character
 * value — rewriting the line to `Authorization=[redacted] <token>` and leaving
 * the token in the clear. The dedicated bearer rule then could not match,
 * because the prefix it needs had already been destroyed. Keep the catch-all
 * last so a precise rule always gets first refusal.
 */
const PATTERNS: ReadonlyArray<[string, RegExp, string]> = [
  ["bearer token", /(authorization\s*:\s*bearer\s+)\S+/gi, `$1${MASK}`],
  // vendor key shapes
  ["sk- key", /\bsk-[A-Za-z0-9_-]{16,}/g, MASK],
  ["github token", /\bghp_[A-Za-z0-9]{20,}/g, MASK],
  ["github PAT", /\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g, MASK],
  ["slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, MASK],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, MASK],
  // connection strings with inline credentials
  ["connection string", /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+(@)/gi, `$1${MASK}$2`],
  // PEM blocks
  [
    "private key block",
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    `-----BEGIN PRIVATE KEY----- ${MASK} -----END PRIVATE KEY-----`,
  ],
  // Catch-all, last: KEY=value where the key name looks like a credential. The
  // negative lookahead skips auth scheme words — `Bearer` is never itself the
  // secret, and treating it as one both hid the real token and made an audit of
  // an already-scrubbed store report a false survivor.
  [
    "credential-named variable",
    /\b([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET|AUTH)[A-Z0-9_]*)\s*[=:]\s*["']?(?!(?:Bearer|Basic|Digest|Token)\b)([^\s"'#,;]{6,})/gi,
    `$1=${MASK}`,
  ],
];

export function redact(text: string | null | undefined): string {
  if (!text) return text ?? "";
  let out = String(text);
  for (const [, pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function containsSecret(text: string | null | undefined): boolean {
  return Boolean(text) && redact(text) !== String(text);
}

/**
 * Redact every string inside an arbitrary JSON-ish value, preserving shape.
 *
 * Needed for tool *input*, not just tool output. When an agent writes a
 * credential into a file, the credential is in the Edit call's `new_string` or
 * the Write call's `content` — so scrubbing only the result text stores the
 * secret verbatim in the field that matters most. That is the exact case
 * `risk.secret_file_write` exists to flag, which made it the worst possible
 * place to leave a gap.
 *
 * Structure is preserved because the dashboard and the analyzers read known
 * keys (`file_path`, `command`) out of this object.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Could this matched text plausibly be real credential material?
 *
 * The audit below is a *secondary* check — redaction at ingest is the actual
 * defence — so precision matters more than recall here. An audit that reports
 * 163 findings, every one of them documentation, is an audit nobody reads twice.
 *
 * Measured against a real corpus, the false positives were all of three kinds:
 * elided examples (`ANTHROPIC_API_KEY=sk-ant-...`), prose where a
 * credential-named word is followed by an ordinary one (`AUTH: required`), and
 * artifacts of file-read formatting (a line-number gutter like `\n00069| `).
 */
function plausiblyReal(matched: string): boolean {
  if (matched.includes("...") || matched.includes("…")) return false; // elided example
  if (matched.includes(MASK)) return false; // already scrubbed
  return true;
}

/** Extra bar for the fuzzy catch-all: a lowercase English word is not a secret. */
function plausibleValue(value: string): boolean {
  if (value.length < 8) return false;
  if (/^[<{$(]/.test(value)) return false; // ${VAR}, <your-key>, $(cmd)
  if (/^\\[nrt]/.test(value)) return false; // escape artifact, not content
  if (/^[a-z]+$/.test(value)) return false; // a plain English word
  return /[A-Za-z]/.test(value) && /[0-9_-]/.test(value);
}

/**
 * Which credential shapes are *still present* in already-stored text.
 *
 * Everything here should have been masked on the way in, so a non-empty result
 * means redaction was bypassed and is worth investigating. Returns pattern
 * labels only, never the matched value — an audit that prints the secret it
 * found has defeated its own purpose.
 *
 * Pass individual string fields, not a serialised document: in JSON, `\n` and
 * `\"` become literal characters that satisfy the value pattern, and scanning a
 * whole `JSON.stringify` output reports those escapes as credentials.
 */
export function survivingSecretKinds(text: string | null | undefined): string[] {
  if (!text) return [];
  const subject = String(text);
  const kinds = new Set<string>();
  const isCatchAll = (label: string): boolean => label === "credential-named variable";

  for (const [label, pattern] of PATTERNS) {
    // Module-level /g regexes are reused across calls, so reset before and after.
    pattern.lastIndex = 0;
    for (const m of subject.matchAll(pattern)) {
      const whole = m[0] ?? "";
      if (!plausiblyReal(whole)) continue;
      if (isCatchAll(label) && !plausibleValue(m[2] ?? "")) continue;
      kinds.add(label);
      break;
    }
    pattern.lastIndex = 0;
  }
  return [...kinds].sort();
}
