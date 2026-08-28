# Unipile → Attio remediation rollout

Rolled out on 2026-08-27.

## Active workflows

The existing production entrypoints were updated in place:

- Live webhook: `d6FagRZslhkj5Zyk`
- Nightly/weekly reconciler: `gw3u2a4xBbHltwZJ`
- Slack decision webhook: `o6HZL39NOaOASH2D`

Shared workflows:

- Identity and company resolver: `nq1qLhsAF2LEvRqm`
- Attio mutation saga: `jOsn22Igc1CGJr5x`
- Durable event processor: `GXEe3WPRaPhgoiBC`

The live and action webhook paths, webhook IDs, and both reconciliation schedules are unchanged.

## Data Tables

- Event ledger: `y3BvGIGRQqVrpGM7`
- Case ledger: `MwDh3e70jYQpCgy3`
- Chat/company state: `eizQME9YrnBD2rDB`

The schemas are recorded in `linkedin-attio-data-tables.json` and can be provisioned additively with:

```powershell
node scripts/provision-unipile-attio-tables.mjs
```

## Verification

- 49 Node tests passed.
- 9 Playwright tests passed on an isolated mock port.
- Generated definitions passed structural, Code-node syntax, connection, and secret-pattern validation.
- Inactive shared-workflow fixtures passed for unmatched resolution, mutation dry-run, and ignored processor input.
- One deliberately rejected group-event smoke ran successfully for each allowed LinkedIn account.
- The invalid Slack action smoke returned the expected HTTP 400 without a mutation.
- The rollout verifier confirmed six active workflows, preserved triggers, the three Data Table schemas, and no workflow-static-data dedupe.

Run the verifier again with:

```powershell
node scripts/verify-unipile-attio-rollout.mjs
```

## Rollback

Fresh pre-remediation exports are retained locally under `backups/2026-08-27-before-remediation/`. This directory is intentionally gitignored because production workflow exports can contain operational tokens or legacy signed-link material.

Restore the three original definitions in place with:

```powershell
node scripts/rollback-unipile-attio-remediation.mjs
```
