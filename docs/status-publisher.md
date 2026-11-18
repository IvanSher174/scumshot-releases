# Five-minute status publication

## Diagnosis (2026-11-18)

The workflow is active on the default branch. Its expression `3-58/5 * * * *`
means minutes 03, 08, ..., 58, including a five-minute interval across the hour.
This is not an hours-versus-minutes cron error.

The repository API returned 32 runs: 30 scheduled and two manual, all successful.
Adjacent scheduled runs were 3.35 to 9.85 hours apart; each run completed in
7 to 18 seconds, and `run_started_at` equalled `created_at` for every run.
For example, the last two scheduled runs were created at 2026-11-18 02:28:19 UTC
and 10:32:05 UTC (8 hours, 3 minutes, 46 seconds apart).

- [Run history](https://github.com/IvanSher174/scumshot-releases/actions/workflows/warden-status.yml)
- [Last inspected successful run and logs](https://github.com/IvanSher174/scumshot-releases/actions/runs/44286311751)
- [Inspected workflow revision](https://github.com/IvanSher174/scumshot-releases/blob/20d9ebab81e069833f9366e6f0835408098bbefa/.github/workflows/warden-status.yml)

The logs confirm a signed status was published. The resulting `checkedAt` was
2026-11-18T10:32:11.552Z, matching that run. The publisher has no cache or polling
interval, and its only caller in the repository is the workflow. Its concurrency
group cannot account for hours of waiting when all recorded runs start immediately
and finish in seconds.

The observed gap is before workflow-run creation, not in collection or publishing.
The API does not expose a reason for missing schedule events; it cannot establish
GitHub's internal cause. [GitHub documents delayed and dropped scheduled runs under
load](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
Changing this valid cron expression would not establish a reliable five-minute
publication interval.

## Proposed fix

Run the existing publisher directly with a systemd timer on a separate, trusted,
always-on Linux host with systemd 247+ and Node.js 22 or later at `/usr/bin/node`. This host does
not need SCUM installed. No game-server configuration changes are required.
The timer targets minutes 00, 05, ..., 55 UTC with one-second coalescing accuracy.
Missed events during downtime produce one catch-up run, not a backlog. The oneshot
service is limited to three minutes and systemd does not start overlapping instances.

The JSON envelope, signing key, allowlisted fields and public `status` branch stay
compatible with the packaged GitHub status verifier (see the scope below).
The current GitHub publisher workflow is deliberately unchanged: merging this PR
does not install the timer or switch the active publisher.

This removes dependence on GitHub Actions scheduling, not dependence on the host,
network, WardenCore or GitHub's contents API. A failed request leaves the previous
signed snapshot unchanged; consumers must use `checkedAt` to identify stale data.

## Launcher compatibility and scope

Static inspection of the [published v0.4.61 installer](https://github.com/IvanSher174/scumshot-releases/releases/tag/v0.4.61)
found that `app.asar/main.cjs:154` uses `warden-status.cjs`, calling
`https://scumshotserver.ru/v1/status` with a two-minute freshness limit.
It does not call `github-status.cjs`. Therefore this PR fixes GitHub snapshot
publication; it is not a demonstrated fix for the current launcher's online display
or the separate live status service. Do not point that two-minute consumer at a
five-minute publisher.

The same installer contains `github-status.cjs`, whose `verifyStatus` accepts the
existing signed envelope, requires the configured `host:gamePort`, rejects snapshots
older than 20 minutes or more than one minute in the future, and verifies Ed25519
against `status-public.pem`. The published snapshot's signature was verified against
that bundled public key. The publisher CLI now checks its private key against this
pinned public key before any requests or publication, preventing a copied wrong
key from replacing the public snapshot with an unverifiable signature.

The tests include the exact consumer verification function, with generated test
keys, to cover five-minute snapshots, zero/null counts, altered data, wrong server
identity and freshness boundaries. This validates the packaged GitHub contract;
it does not claim that module is the active status source in v0.4.61.

Inspected installer SHA-256 (matches the release asset digest):
`8305174c9c32db8349042d189b6711c2f9077d113da2bb3535c74e4f44f1d2ee`.
Bundled `github-status.cjs` SHA-256:
`3b70e4f1e78ba80a4ea90170a8d23d0a91dce1a09f026ac3c32b2651c744e0cf`.
The installer was unpacked for inspection, not executed.

## Offline review checks

On Node.js 22+:

```sh
node --test .github/scripts/publish-status.test.cjs
```

On the intended Linux host, without starting the publisher:

```sh
test -x /usr/bin/node
systemd-analyze verify deploy/scumshot-status.service deploy/scumshot-status.timer
systemd-analyze calendar --iterations=4 '*-*-* *:00/5:00 UTC'
```

The PR workflow validates the actual timer's `OnCalendar` expression across a UTC
midnight boundary (00:00, 00:05, 00:10, 00:15), rather than a separately copied cron.
It also performs the service syntax checks on Ubuntu. The Node tests use generated test
keys and mocked HTTP responses, never production credentials or API writes.

## Operator activation after review (not performed by this PR)

1. Choose the publisher host and an approved commit of this repository. Do not run
   an automatic `git pull` with credentials loaded. Install only the reviewed script
   as root-owned `/opt/scumshot-status/publish-status.cjs` (mode 0644), and copy
   `deploy/scumshot-status.service` and `.timer` to `/etc/systemd/system/` (mode 0644).
   The dynamic service user must be able to traverse `/opt/scumshot-status`.
2. Create `/etc/scumshot-status.env`, owned by root, outside the checkout. It must
   contain only these non-secret values:

   ```text
   GITHUB_REPOSITORY=IvanSher174/scumshot-releases
   STATUS_SERVER=185.135.83.35:7002
   ```

   Privately provision three root-owned files (mode 0600) inside a root-owned
   `/etc/scumshot-status/` directory (mode 0700), without overwriting existing files:

   | File | Contents |
   | --- | --- |
   | `warden-api-key` | Current valid WardenCore credential |
   | `status-signing-key` | Existing PEM private key, with real newlines and no shell quotes |
   | `github-token` | Fine-grained token limited to this repository, Contents read/write |

   `LoadCredential` gives the dynamic service user read-only credential files;
   the secrets are not passed as environment values or command-line arguments.
   Systemd supplies only their directory path as `CREDENTIALS_DIRECTORY`. Missing
   files fail closed without falling back to environment secrets. The original
   GitHub Actions caller retains its environment-based interface when this
   directory is absent. [Systemd documents why service environments are unsuitable
   for secrets](https://www.freedesktop.org/software/systemd/man/255/systemd.exec.html#Environment=).

   Preserve the existing signing key. A new key requires a matching update of
   GitHub consumers and the publisher's public-key pin. Do not extract secrets from
   Actions logs or put them in shell history. A GitHub Actions `GITHUB_TOKEN` is
   temporary and cannot be reused here. The publisher token does not need Actions
   or workflow write access. Restrict host/backups to trusted administrators; these
   root-owned source files are plaintext at rest. The service disables core dumps.
3. Run `sudo systemctl daemon-reload`. Before any manual start or timer activation,
   disable **Publish WardenCore server status** in GitHub Actions and wait until any
   queued or running instances have finished. Do not run two publishers: they can
   race over the same file SHA or publish snapshots out of order.
4. Run `sudo systemctl start scumshot-status.service` once and inspect
   `sudo journalctl -u scumshot-status.service --since '5 minutes ago'`.
   Confirm the public snapshot has the intended server, a valid signature with the
   packaged GitHub verifier's public key, and a newly advanced `checkedAt`. The host
   clock must be synchronized: that verifier rejects times over one minute ahead.
5. Enable the timer with `sudo systemctl enable --now scumshot-status.timer`.
   Inspect `systemctl list-timers scumshot-status.timer` and observe at least three
   successive publications about five minutes apart, allowing API request time.
   Compare decoded `checkedAt` values, not just the timer's next-run display.
   The publisher only writes `server-status.json` on `status`; it does not modify
   SCUM, mods, server settings, release assets or the `main` branch.

If step 4 or 5 fails, use the rollback below. Diagnose the host journal and API
availability; never replace an unknown or old player count with a fresh zero.

## Rollback

Disable and stop the timer, then stop any in-flight publication:

```sh
sudo systemctl disable --now scumshot-status.timer
sudo systemctl stop scumshot-status.service
```

Then re-enable the original GitHub Actions workflow. The existing signed snapshot
and signing key remain valid; the old scheduling limitations will return.
