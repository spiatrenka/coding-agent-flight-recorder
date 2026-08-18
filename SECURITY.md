# Security Policy

This tool reads your coding-agent transcripts. Those contain your source code,
your branch names, your shell history, and whatever your agent happened to
print — which is occasionally a credential. The threat model below is specific
to that, and worth reading before you file anything.

## Supported versions

| Version | Supported |
|---|---|
| 0.2.x | yes |
| 0.1.x | yes |
| < 0.1 | no |

Pre-1.0, fixes land on `main` and ship in the next release.

## Reporting a vulnerability

Use GitHub's **[private vulnerability reporting](https://github.com/spiatrenka/coding-agent-flight-recorder/security/advisories/new)**.
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

There are two removal paths. Prefer the first — until 0.2.0 only the second
existed, which meant a credential surviving into one run cost you the whole
archive, usually including runs whose transcripts Claude Code had already purged.

**Remove specific runs:**

```bash
flightrec rm <run-id>              # one run, named explicitly
flightrec rm --project /path/to/repo --yes
flightrec rm --before 2026-07-01 --yes
flightrec rm --synthetic --yes     # runs seeded by `flightrec demo`
```

`--dry-run` lists what would go and changes nothing; anything matching more than
one run requires `--yes`. Deleting a run also deletes its findings.

Demo runs stored before 0.2.0 carry no synthetic flag. Re-running `flightrec demo`
marks them in place — it derives run ids from the fixture session, so it updates
rather than duplicates — after which `--synthetic` selects them.

Two limits worth knowing. The original transcript is never touched, so
`flightrec ingest --force` will restore a deleted run if its transcript still
exists — delete the transcript too if you need it gone for good. And SQLite
leaves freed pages in the file, so the bytes may persist on disk until the
database is rewritten; `sqlite3 ~/.flightrec/flightrec.db VACUUM;` forces that,
or use the full removal below.

**Remove everything** — nowhere else does state live:

```bash
rm ~/.flightrec/flightrec.db
```
