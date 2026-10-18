# Backup and restore

A dump of this database contains live credentials — `webhooks.secret` (HMAC
signing keys) and `api_keys` rows — and must never land anywhere
world-readable. GitHub Actions artifacts on this public repo are
world-readable, so the workflow only uploads an `age`-encrypted file.

Nightly `pg_dump` of each network's Postgres. Lens stores price history in
**one database per network** even though every row now carries a `network`
discriminator (#114); restoring a mainnet dump into the testnet instance would
still mix networks in the same tables. See [DUAL_NETWORK.md](DUAL_NETWORK.md).

Neon also has branching and point-in-time restore. Use that for short-window
accidents. The encrypted dump is the copy that survives a project delete or
a missed PITR window.

The workflow is [`.github/workflows/db-backup.yml`](../.github/workflows/db-backup.yml):
cron `0 3 * * *` UTC plus `workflow_dispatch`. Encrypted artifacts are kept
**14 days**.

## Secrets

Add these on the GitHub repo (Settings → Secrets and variables → Actions).
Use the **direct** connection string, not the pooler:

| Secret | What |
|--------|------|
| `DATABASE_URL_MAINNET` | mainnet Postgres (direct URI) |
| `DATABASE_URL_TESTNET` | testnet Postgres (direct URI) |
| `AGE_RECIPIENT` | `age` public key (`age1…`) |

On Neon that means the host **without** `-pooler`, port **5432** (not 6543),
and `sslmode=require`. Prisma's pooled `DATABASE_URL` is the runtime URL;
`pg_dump` / `pg_restore` need the same class of URI as `DIRECT_DATABASE_URL`.

Generate the keypair on a machine that is not the runner:

```bash
age-keygen -o lens-backup.agekey
# public key line: age1…
```

Put only the public key in `AGE_RECIPIENT`. The identity file stays offline
(password manager / disk not in this repo). GitHub never sees it.

A missing database URL skips that network (`SKIP <network>: secret not
configured`). A missing `AGE_RECIPIENT` fails the job — it will not upload
plaintext.

Do not put these URIs, the identity file, or a plaintext dump in the repo,
`.env.example`, or workflow YAML.

## Download a dump

1. Actions → **Nightly DB backup** → the run you want.
2. Artifacts: `lens-mainnet-<run_id>` / `lens-testnet-<run_id>`.
3. File inside: `lens-<network>-YYYYMMDD.dump.gz.age`.

`workflow_dispatch` is the way to take a dump on demand (and to verify the
job once secrets are in place).

## Restore into a fresh instance

Do not `pg_restore` onto the live URL. Spin up an empty database, restore
there, then swap the deployment env.

1. Create a new Neon project (or local Postgres). Match the dump's major
   version; if `pg_restore` complains, install a client ≥ the server
   (`postgresql-client-16` / `17` as needed).
2. Copy the **direct** URI for the new instance (`sslmode=require` on Neon).
3. Decrypt with the offline identity, then restore **one network per
   instance**:

```bash
age -d -i lens-backup.agekey \
  -o lens-mainnet-YYYYMMDD.dump.gz \
  lens-mainnet-YYYYMMDD.dump.gz.age

gzip -dc lens-mainnet-YYYYMMDD.dump.gz \
  | pg_restore --no-owner --no-acl --dbname="$NEW_DIRECT_URL"
```

`pg_restore -l` on the gunzipped file lists the TOC if you want to inspect
before loading. Delete the decrypted `.dump.gz` when you are done.

4. Point the matching Lens deployment at the new instance:
   - `DATABASE_URL` — pooled URL is fine for the app
   - `DIRECT_DATABASE_URL` — direct URL (Prisma migrations / `db push`)
5. Check `/status`, then one `/prices/history` (or GraphQL equivalent) for a
   watched pair.
6. Rollback is swapping those two env vars back to the previous instance.

Repeat independently for testnet with the testnet artifact and testnet
deployment. Never restore a mainnet dump into testnet, or the reverse.

## Client notes

Compose uses Postgres 15. Managed Neon may be 16/17. `pg_dump` / `pg_restore`
must be the same major as the server or newer. The workflow installs Ubuntu's
`postgresql-client` and `age`; bump the client package if dumps start failing
with a version error.
