---
name: cybriq
description: >-
  Work with the CybrIQ (Sepio) asset-visibility and hardware-access-control
  platform through the @dougschaefer/cybriq swamp model — asset/risk inventory,
  switches, external scan engines (Netpollers), events, and policy/governance
  objects. Use when checking CybrIQ/Sepio health, scan-engine connectivity, or
  asset risk. Triggers on "CybrIQ", "Sepio", "scan engine", "Netpoller",
  "asset visibility", "hardware access control", "vulnerable switch",
  "rogue device", "asset risk", "Sepio platform", "scan engine connectivity".
---

# CybrIQ (Sepio)

Operate the CybrIQ / Sepio platform through the `@dougschaefer/cybriq` swamp
model. CybrIQ is an asset-visibility and hardware-access-control platform: it
discovers what is physically on the network (switches, peripherals, rogue
hardware), scores risk, and enforces policy. The model talks to its REST +
GraphQL API over a short-lived local-login bearer token.

One model definition is one CybrIQ instance. Point it at your platform with
`globalArguments` (base URL plus username/password), and resolve the credentials
from a vault rather than hardcoding them. Create an instance per environment and
reference it by name.

## Workflow first

For the repeatable health/connectivity task — "is the platform up, are the scan
engines connected, are switches polling, anything failing to connect" — **run
the workflow, don't hand-assemble the calls**:

```bash
swamp workflow run @dougschaefer/cybriq-connectivity-health --input instance=<your-cybriq-instance>
```

It chains `getStatus → listScanEngines → listSwitches → listEvents (Unable to
Connect) → assetsOverview` sequentially (one instance, so sequential to avoid
the per-model lock). Reach for individual methods below only when you need
something the workflow doesn't cover — and if that need recurs, extend the
workflow rather than leaving it out.

## Method map

| Use | Methods |
| --- | --- |
| Auth / health | `getStatus` |
| Asset & risk | `assetsOverview`, `listAssets`, `getAsset`, `listDeviceTypes`, `analyzeRisks` |
| Network infrastructure | `listSwitches`, `getSwitchPort`, **`listScanEngines`** |
| Peripherals / agents | `listPeripherals`, `getPeripheral`, `listAgents`, `getAgent` |
| Events / alarms | `listEvents`, `listAlarmDestinations` |
| Governance (read) | `listPolicies`, `listScopes`, `listTags`, `listUserAttributes` |
| Governance (mutating) | `createTag`, `addUserAttribute`, `createPolicy`, `createScope` |
| Reports | `listReports`, `listReportDownloads`, `triggerReport` |
| Escape hatch | `apiRequest` — authenticated passthrough to any `/prime/webui/*` route or `/sepio-data` GraphQL |

Everything is read-only except `create*`, `addUserAttribute`, and
`triggerReport`; those are guarded by the `auth-reachable` pre-flight check.

## Operational gotchas (hard-won)

- **Scan engines are not host agents.** External scan engines (Netpollers) do
  **not** appear in `listAgents` — that endpoint is host/collector agents only.
  Use `listScanEngines` (it reads `Switches/NetPollers`), which returns
  `status` (e.g. Connected), `adminStatus` (e.g. Activated),
  `numOfPollersAlive/numOfPollers`, `version`, `cpu`, `utilization`, and
  `errorCount`.

- **A switch can show "disconnected" while its scans succeed.** The switch's
  connection indicator keys off `connectionData.lastSeen` / `swPollingStatus`
  (in `listSwitches`), not off scan completion. If a device's scan duration
  approaches its polling window, `lastSeen` fails to latch, the platform marks
  the connection down, and a `Switch Unable to Connect` event fires — even though
  the inventory uploaded fine. Confirm with the gap between
  `connectionData.lastPolled` and `lastUpdated` (≈ scan duration).

- **Polling classifications gate the cadence, and the labels matter.** A
  "Critical" classification scans on a tight window (on the order of a minute)
  while "Normal" scans far less often (hours). A slow device scan — e.g. a switch
  that requires hundreds of sequential `show` commands and runs close to a minute
  — will flap under a tight window and sit stable under a loose one. The fix for
  flapping is a longer cadence or a shorter scan, not a Netpoller-side setting.

- **The token is a short-lived (~15 min) JWT.** Each model method
  re-authenticates, so this is invisible from the CLI; it only matters if you
  script raw API calls.

- **`apiRequest` is how you find undocumented routes.** The `listScanEngines`
  endpoint (`/prime/webui/Switches/NetPollers`) was discovered by probing with
  `apiRequest`. When you need something the dedicated methods don't expose, probe
  with `apiRequest` first; if it's broadly useful, add it as a real method and
  republish (see the `swamp-extension` and `swamp-extension-publish` skills).

## Related

- `swamp-model` — running methods, inspecting output, CEL.
- `swamp-workflow` — the `cybriq-connectivity-health` workflow.
