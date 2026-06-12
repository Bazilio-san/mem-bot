# Sync Local Databases to a Remote Server

This runbook describes the operator intent for replacing remote project databases with local copies. It is destructive
for the remote target and must only be used when the remote data may be fully overwritten.

Project documentation rules are in [../documentation-principles.md](../documentation-principles.md).

## Scope

The project uses a main memory database and a separate logs database. Connection names, database names, hosts, and
credentials are configuration data, not documentation data.

Configuration owners:

- Database defaults and comments: `../../../config/default.yaml`
- Local override example: `../../../config/local.example.yaml`
- Environment variable mapping: `../../../config/custom-environment-variables.yaml`
- Database bootstrap and migrations: `../../../src/migrate.js`

## Operator Flow

1. Confirm the target environment and the exact main/logs databases to overwrite.
2. Stop services that can write to the remote databases.
3. Dump the local main and logs databases.
4. Recreate or clean the remote target databases.
5. Restore the dumps to the remote target.
6. Run migrations against the remote target.
7. Start services and verify application health, user counts, recent messages, notes, and logs.

Keep the exact shell commands in deployment notes or scripts for the environment being operated. Do not commit real
credentials or environment-specific hostnames to documentation.

## Verification References

- Database availability checks: `../../../src/db.js`
- Migration runner: `../../../src/migrate.js`
- Admin health route: `../../../src/server/admin-api.js`
- Server startup checks: `../../../src/server/index.js`
