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

Authenticated RPC admission is bounded to 32 simultaneous operations by
default (the daemon setting accepts 1–1024). When capacity is full, a request
that has already passed authentication and scope/revocation checks receives a
generic HTTP 503 `SERVICE_UNAVAILABLE`; it is rejected before gateway dispatch
and is not queued. A client that receives this response can submit the
operation again after capacity becomes available. A disconnected request does
not itself release an admitted slot while its handler is still running.

For browser access, add the exact frontend origin to `OUROBOROS_ALLOWED_ORIGINS`, for example `http://localhost:5173`. The frontend keeps the bearer only in page memory, exchanges it for a five-minute HttpOnly stream cookie, and must reauthenticate after reload. The cookie is bound to its issuing Origin. Do not put bearer values in URLs, command arguments, logs, or screenshots.

## Read-only session RPC projection

`session.get` and `session.list` require `mission.read` and return contract version 1 from `shared/session-rpc-contract.ts`. Each item contains only `id`, `status`, `createdAt`, and `updatedAt`; `contextSnapshot` and arbitrary `metadata` remain internal storage fields. Lists include at most 100 sessions and set `truncated` when more rows are available. For example:

```json
{
  "contractVersion": 1,
  "sessions": [
    {
      "id": "session-id",
      "status": "active",
      "createdAt": "2026-10-08T12:00:00.000Z",
      "updatedAt": "2026-10-08T12:00:00.000Z"
    }
  ],
  "truncated": false
}
```

`session.get` uses the same item shape under `session`. The default gateway and the authenticated HTTP boundary both rebuild these responses from the allowlist, including when an alternate gateway is injected. Invalid session results and gateway errors use the bounded generic RPC error response.

## Capability registry read projection

`capability_registry.list` requires `mission.read` and reads the same
`CapabilityRegistry` instance composed by the headless daemon for Mission
policy and connector dispatch. An empty registry is available and returns
`items: []`; `available: false` means a gateway was composed without a registry.
The V1 projection returns at most 100 descriptors, sets `truncated` when more
are registered, and includes only the public descriptor allowlist. Discovery
does not authorize or invoke a capability. Registry errors are returned as a
bounded generic RPC failure.
