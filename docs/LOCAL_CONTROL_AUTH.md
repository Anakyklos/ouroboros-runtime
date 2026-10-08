# Local control credentials

The daemon binds to `127.0.0.1` and refuses to start until its credential registry contains an active client. Provision credentials while the daemon is stopped, using the same `OUROBOROS_DATA_DIR` for the CLI and daemon:

```bash
OUROBOROS_DATA_DIR=.ouroboros bun run ouroboros auth provision operator-cli mission.read,mission.control,daemon.admin
```

The command writes the bearer value to `$XDG_CONFIG_HOME/ouroboros/local-control/operator-cli.json` (or `~/.config/...`) with mode `0600`, and prints only the file path, grants, and expiry. Set `OUROBOROS_CLIENT_CREDENTIAL_FILE` when using a different path. Choose only the scopes the client needs: `mission.read` reads projections, `mission.control` pauses/resumes/cancels Missions, and `daemon.admin` controls daemon mode, emergency brake, and shutdown.

Rotate with the same command and an explicit client id and scope list. Rotation invalidates the previous value immediately:

```bash
OUROBOROS_DATA_DIR=.ouroboros bun run ouroboros auth rotate operator-cli mission.read,mission.control,daemon.admin 90
```

Revoke a client without needing its local credential file:

```bash
OUROBOROS_DATA_DIR=.ouroboros bun run ouroboros auth revoke operator-cli
```

The registry stores a SHA-256 hash of each secret, grants, expiry, and revocation state in `local-control-auth.db` under the private data directory. The bearer secret is generated with a cryptographic random source and is never printed by the provisioning command. Protect backups and access to the same operating-system user accordingly.

For browser access, add the exact frontend origin to `OUROBOROS_ALLOWED_ORIGINS`, for example `http://localhost:5173`. The frontend keeps the bearer only in page memory, exchanges it for a five-minute HttpOnly stream cookie, and must reauthenticate after reload. The cookie is bound to its issuing Origin. Do not put bearer values in URLs, command arguments, logs, or screenshots.
