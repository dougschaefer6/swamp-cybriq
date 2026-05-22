# @dougschaefer/cybriq

A swamp model for a **CybrIQ (Sepio)** asset-visibility / hardware-access-control
platform — rogue-device detection, MAC fingerprinting, and switch-port risk. It
authenticates with the platform's local login, then reads inventory and risk
state or creates governance objects over the REST + GraphQL API.

## Authentication

The platform's published OpenAPI spec declares no security scheme, but the web
UI authenticates with a local login that returns a short-lived (~15 minute)
bearer JWT:

```
POST /prime/webui/Auth/LocalLogin {username, password}
  -> { token, expiresAt, refreshToken, user, license }
```

Every call then carries `Authorization: Bearer <token>`. The model is stateless
— it logs in fresh on each method call (login is cheap), so there is no token to
cache or refresh. Credentials live in `globalArguments` and resolve from a vault.

## Methods

| Method | Description |
| --- | --- |
| `getStatus` | Log in and report account + license status (health check) |
| `assetsOverview` | Asset dashboard summary: counts and risk breakdown |
| `listAssets` | Page discovered assets (risk, vendor, type, connection) via GraphQL |
| `listDeviceTypes` | Device-type distribution (asset categories with counts) |
| `analyzeRisks` | Risk-insights rollup: port anomalies, vulnerable switches, uncommon + vulnerable peripherals |
| `listEvents` | Event log, with severity/category/search filters |
| `listAlarmDestinations` | Configured alarm / SIEM-syslog destinations |
| `listPolicies` | Policy-engine policies |
| `listScopes` | Scopes |
| `listTags` | Tags |
| `listUserAttributes` | User attributes |
| `createTag` | Create a tag by name *(mutating)* |
| `addUserAttribute` | Create a user attribute *(mutating)* |
| `createPolicy` | Create a policy from a `PolicyDto` body *(mutating)* |
| `createScope` | Create a scope from a `ScopeDto` body *(mutating)* |
| `apiRequest` | Generic authenticated request to any REST endpoint or the GraphQL layer |

Read methods write a generic `collection` resource (`kind`, `count`, `items`,
`raw`); mutating methods write a `mutationResult`. `apiRequest` lets you reach
any endpoint the dedicated methods don't cover — it is the escape hatch for the
full API surface.

## Global arguments

| Field | Required | Description |
| --- | --- | --- |
| `baseUrl` | yes | Base URL of the instance, e.g. `https://<tenant>.sepiopoc.com` |
| `username` | yes | Local-auth username (vault-resolved) |
| `password` | yes | Password (marked sensitive; vault-resolved) |
| `timeoutMs` | no | Per-request timeout, default `30000` |

### Example definition

```yaml
type: "@dougschaefer/cybriq"
name: cybriq
globalArguments:
  baseUrl: https://<tenant>.sepiopoc.com
  username: ${{ vault.get(<vault>, cybriq-api-user) }}
  password: ${{ vault.get(<vault>, cybriq-api-password) }}
  timeoutMs: 30000
```

## Usage

```bash
# Health check + account/license
swamp model method run cybriq getStatus --json

# Dashboard summary and inventory
swamp model method run cybriq assetsOverview --json
swamp model method run cybriq listAssets --input '{"pageSize":50,"sortBy":"riskLevel_desc"}' --json

# Risk + governance
swamp model method run cybriq analyzeRisks --json
swamp model method run cybriq listPolicies --json
swamp model method run cybriq createTag --input '{"tagName":"my-tag"}' --json

# Anything else — generic passthrough
swamp model method run cybriq apiRequest --input '{"method":"GET","path":"/prime/webui/Switches/Switches"}' --json
```

## Security

- Credentials resolve from a vault; `password` is marked sensitive and the bearer
  token is never written to a resource.
- All traffic is HTTPS. The model uses plain `fetch`, so the bundle has no native
  dependencies.
- `listAssets`, `apiRequest`, and the other read methods persist the API response
  to swamp's local data store so you can inspect it. Treat that data directory as
  you would any cache of platform output; it is not published or transmitted.

## License

MIT — see [LICENSE.txt](LICENSE.txt).
