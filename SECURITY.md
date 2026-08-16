# Security Policy

This tool reads your coding-agent transcripts. Those contain your source code,
your branch names, your shell history, and whatever your agent happened to
print — which is occasionally a credential. The threat model below is specific
to that, and worth reading before you file anything.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | yes |
| < 0.1 | no |

Pre-1.0, fixes land on `main` and ship in the next release.

## Reporting a vulnerability

Use GitHub's **[private vulnerability reporting](https://github.com/spiatrenka/agent-flight-recorder/security/advisories/new)**.
If that is unavailable, email **siarhei.piatrenka@gmail.com** with `flightrec
security` in the subject.

Expect an acknowledgement within a week. Coordinated disclosure at 90 days or
on fix availability, whichever comes first. There is no bounty programme.

**Do not include real data in a report.** See [Reporting without leaking](#reporting-without-leaking).

---

## What the tool actually touches

Stated plainly, because this *is* the reassurance:

- **Reads, read-only.** `CLAUDE_CONFIG_DIR` (default `~/.claude`) and
  `OPENCODE_STORAGE_DIR` (default `~/.local/share/opencode/storage`). Original
  transcripts are never modified, moved, or deleted.
- **Writes exactly one file.** `~/.flightrec/flightrec.db`, relocatable with
  `FLIGHTREC_HOME`. Nothing else on your disk is touched.
- **Zero outbound network.** There are no HTTP clients, no telemetry, no
  update checks, no analytics. The only network code in the project is a
  *server*, and it refuses to bind anything outside `127.0.0.1`, `localhost`
  and `::1` — it throws before a socket exists rather than falling back.
- **Zero runtime dependencies.** `dependencies` is empty. The supply chain is
  Node itself, plus two dev tools that never reach a user's machine.

---

## In scope

1. **Any bypass of the loopback bind guard** — anything that gets this server
   listening on a non-loopback interface.
2. **Path traversal in the static handler** — any request that reads a file
   outside the bundled web directory.
3. **Redaction bypass in `src/redact.ts`** — a credential shape that reaches
   the database unmasked.

   State this one carefully, because the honest version matters: **the redactor
   is deliberately conservative.** Over-redaction destroys the evidence value of
   the record — a postmortem that has scrubbed the thing it is trying to show
   you is worthless. So redaction is a *mitigation, not a guarantee*. Treat
   `~/.flightrec/flightrec.db` as exactly as sensitive as `~/.claude` itself,
   and back it up or delete it accordingly. A missed pattern is still worth
   reporting; just don't rely on the redactor as a boundary.
4. **Injection or arbitrary write via a crafted transcript.** Transcript
   content is untrusted input: tool output inside it is attacker-influenced
   whenever your agent ran attacker-controlled code. A transcript that can make
   this tool write outside its database, execute anything, or inject script into
   the dashboard is a vulnerability.

## Out of scope

Said honestly rather than papered over:

- **The loopback API has no authentication, by design.** It is a single-user
  local tool. A machine where another local user can reach `127.0.0.1:8787` or
  read `~/.flightrec` is already outside this model.
- **A crash, a hang, or a wrong verdict is a bug**, not a vulnerability — file
  it as a normal issue. "Detectors never throw" is a correctness property we
  hold ourselves to, not a security boundary.
- Vulnerabilities in Claude Code or OpenCode themselves.

---

## Reporting without leaking

The input to this tool is your private work. When filing an issue or a security
report:

- **Never paste a real transcript, a real database, or real `flightrec report`
  output.** Check any snippet for absolute paths, session titles, branch names
  and credentials before it leaves your machine.
- **Reproduce with `flightrec demo`.** It seeds synthetic runs covering every
  verdict and reproduces most UI, rendering and analysis bugs. If it does not,
  add a synthetic fixture that does — that is a better bug report anyway,
  because it becomes the regression test.

## A note on retention

Ingesting is an **archival act**. Claude Code purges its transcripts after
about thirty days; once you have ingested them, `~/.flightrec/flightrec.db`
outlives that purge and may become the only remaining copy of a run. That is
the point of the tool, but it means the database accumulates history you may
have assumed was already gone.

Deleting it is the complete removal path — there is nowhere else state lives:

```bash
rm ~/.flightrec/flightrec.db
```
