# Live Service Spec Validation

## Background
`tests/openapi.test.ts` ensures that all registered routes are present in [`openapi.yaml`](../openapi.yaml). However, static routing coverage alone does not guarantee that the live deployed service actually responds with payloads that match the schemas published in the specification.

This scheduled validation job queries every documented endpoint on the live service and validates the response payloads against their respective OpenAPI 3.0 schemas.

---

## Acceptance Criteria & Architecture

1. **Every documented route is validated against the live response**
   - The validator parses `openapi.yaml` and executes test requests for each documented path and operation.
   - Dynamic path templates (`{assetA}`, `{assetB}`, `{asset}`, `{id}`, `{keyId}`) and query parameters are populated with standard valid test arguments.
   - Responses are validated against the declared JSON schemas in `components.schemas` using Ajv.

2. **Failures are reported in one place that updates rather than multiplying**
   - Instead of opening a new issue on every nightly run (which creates notification fatigue and leads teams to ignore alerts), the check:
     - Searches for an existing issue labeled `live-spec-report`.
     - Appends the latest run report as a timestamped comment and updates the main issue body with the current health banner.
     - Creates the single tracking issue only if one does not already exist.
     - Also publishes the report to `$GITHUB_STEP_SUMMARY` for direct visibility in the Actions UI.

3. **A deliberate schema mismatch is detected by the check**
   - Verified by automated tests in [`src/__tests__/liveSpecValidation.test.ts`](../src/__tests__/liveSpecValidation.test.ts).
   - If a response field has the wrong type (e.g. `string` instead of `number`), is missing a required property, or provides an invalid enum value, the validator flags the route, identifies the invalid JSON path, and details the exact schema violation.

4. **The job's schedule and its cost are documented**
   - See [Schedule and Cost Analysis](#schedule-and-cost-analysis) below.

5. **Reports rather than fails the build**
   - Because live network conditions, temporary provider downtime, or third-party outages are outside CI's control, the scheduled job logs drift and posts reports while exiting cleanly with status `0`.

---

## Schedule and Cost Analysis

### Execution Schedule
- **Trigger:** Cron schedule at **`05:00 UTC daily`** (`0 5 * * *`) and on-demand via `workflow_dispatch`.
- **Timing Rationale:** 
  - `03:00 UTC`: Nightly database backups ([`.github/workflows/db-backup.yml`](../.github/workflows/db-backup.yml)).
  - `04:00 UTC`: Automated price load test ([`.github/workflows/load.yml`](../.github/workflows/load.yml)).
  - `05:00 UTC`: Off-peak live spec validation runs once previous nightly jobs have completed, preventing any overlapping resource contention.

### Resource & Financial Cost
- **GitHub Actions Compute:**
  - Runtime: **~20 to 45 seconds** per run.
  - Monthly compute: ~30 runs × 1 minute = **~30 runner minutes per month**.
  - Cost: Free (public open-source repositories receive unlimited free Actions minutes; private accounts have a 2,000 minute/month free tier).
- **Live Service Ingestion & Network Load:**
  - Total HTTP requests per run: **~25 requests** (one per documented endpoint).
  - Bandwidth: < 150 KB total per run.
  - Server Impact: Less than 0.001% of daily capacity; completely negligible overhead.

---

## Running Locally

To validate a local or remote deployment against the spec:

```bash
# Validate local server (defaults to http://localhost:3002)
npm run spec:validate-live

# Validate a specific remote environment
LIVE_API_URL=https://lens.stellar.org npm run spec:validate-live
```
