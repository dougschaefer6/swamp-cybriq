import { z } from "npm:zod@4.3.6";
import {
  apiFetch,
  assetDetailQuery,
  collect,
  CybriqGlobalArgsSchema,
  type DataHandle,
  detail,
  discoveredAssetsQuery,
  graphql,
  login,
  type MethodContext,
  mutate,
} from "./_client.ts";

/**
 * `@dougschaefer/cybriq` model — talks to a CybrIQ (Sepio) asset-visibility
 * / hardware-access-control platform over its REST + GraphQL API.
 *
 * It authenticates with a local login (username/password → short-lived bearer
 * JWT) and then reads or changes platform state. Read methods cover the
 * dashboard (`getStatus`, `assetsOverview`), inventory (`listAssets`,
 * `listDeviceTypes`), risk analysis (`analyzeRisks`), the event log
 * (`listEvents`, `listAlarmDestinations`), and the policy/governance objects
 * (`listPolicies`, `listScopes`, `listTags`, `listUserAttributes`). Mutating
 * methods create tags, user attributes, policies, and scopes. `apiRequest` is
 * a generic authenticated passthrough that reaches any other REST endpoint or
 * the `/sepio-data` GraphQL layer, so the long tail of the API is available
 * without a dedicated method.
 *
 * Connection facts and credentials live in `globalArguments` so one model
 * definition is one CybrIQ instance and secrets resolve from vault.
 */
export const model = {
  type: "@dougschaefer/cybriq",
  version: "2026.05.22.3",
  globalArguments: CybriqGlobalArgsSchema,
  resources: {
    status: {
      description: "Authenticated account + license status",
      schema: z.object({
        baseUrl: z.string(),
        userName: z.string(),
        email: z.string(),
        userProfile: z.number(),
        primeAccountName: z.string(),
        licenseStatus: z.string(),
        tokenExpiresAt: z.string(),
        capturedAt: z.iso.datetime(),
      }),
      lifetime: "1d",
      garbageCollection: 5,
    },
    assetsOverview: {
      description: "Asset dashboard summary: counts and risk breakdown",
      schema: z.object({
        baseUrl: z.string(),
        totalAssets: z.number(),
        newAssets: z.number(),
        totalHosts: z.number(),
        newHosts: z.number(),
        networking: z.number(),
        newNetworking: z.number(),
        riskHigh: z.number(),
        riskMedium: z.number(),
        riskLow: z.number(),
        raw: z.unknown(),
        capturedAt: z.iso.datetime(),
      }),
      lifetime: "7d",
      garbageCollection: 5,
    },
    assets: {
      description: "A page of discovered assets from the GraphQL data layer",
      schema: z.object({
        baseUrl: z.string(),
        recordsTotal: z.number(),
        recordsFiltered: z.number(),
        pageNumber: z.number(),
        pageSize: z.number(),
        count: z.number(),
        assets: z.array(z.unknown()),
        capturedAt: z.iso.datetime(),
      }),
      lifetime: "7d",
      garbageCollection: 5,
    },
    collection: {
      description:
        "Generic list/analysis result (device types, risks, events, alarms, policies, scopes, tags, user attributes)",
      schema: z.object({
        baseUrl: z.string(),
        kind: z.string(),
        count: z.number(),
        items: z.array(z.unknown()),
        raw: z.unknown(),
        capturedAt: z.iso.datetime(),
      }),
      lifetime: "7d",
      garbageCollection: 5,
    },
    mutationResult: {
      description:
        "Result of a create/update operation (tag, user attribute, policy, scope)",
      schema: z.object({
        baseUrl: z.string(),
        action: z.string(),
        target: z.string(),
        status: z.number(),
        data: z.unknown(),
        appliedAt: z.iso.datetime(),
      }),
      lifetime: "30d",
      garbageCollection: 10,
    },
    detail: {
      description:
        "Single-object drill-down detail (switch port, peripheral, agent, asset)",
      schema: z.object({
        baseUrl: z.string(),
        kind: z.string(),
        id: z.string(),
        data: z.unknown(),
        capturedAt: z.iso.datetime(),
      }),
      lifetime: "7d",
      garbageCollection: 5,
    },
    apiResult: {
      description: "Result of a generic authenticated API passthrough call",
      schema: z.object({
        method: z.string(),
        path: z.string(),
        status: z.number(),
        data: z.unknown(),
        requestedAt: z.iso.datetime(),
      }),
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  methods: {
    getStatus: {
      description:
        "Authenticate (local login) and report account + license status. Read-only health check.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        context.logger.info("Logging in to {baseUrl}", { baseUrl: g.baseUrl });
        const r = await login(g);
        const user = (r.user ?? {}) as Record<string, unknown>;
        const lic = (r.license ?? {}) as Record<string, unknown>;
        const handle = await context.writeResource("status", "status", {
          baseUrl: g.baseUrl,
          userName: String(user.userName ?? g.username),
          email: String(user.email ?? ""),
          userProfile: Number(user.userProfile ?? 0),
          primeAccountName: String(lic.primeAccountName ?? ""),
          licenseStatus: String(lic.licenseStatus ?? ""),
          tokenExpiresAt: String(r.expiresAt ?? ""),
          capturedAt: new Date().toISOString(),
        });
        context.logger.info("Authenticated as {user} ({account})", {
          user: String(user.userName ?? g.username),
          account: String(lic.primeAccountName ?? "?"),
        });
        return { dataHandles: [handle] };
      },
    },

    assetsOverview: {
      description:
        "Fetch the asset dashboard summary (counts + risk breakdown) from transformerDataApi/assetsOverview.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const { data } = await apiFetch(
          g,
          "GET",
          "/prime/webui/transformerDataApi/assetsOverview",
          { token },
        );
        const o = (data ?? {}) as Record<string, unknown>;
        const risk = (o.assetsRisk ?? {}) as Record<string, unknown>;
        const handle = await context.writeResource(
          "assetsOverview",
          "overview",
          {
            baseUrl: g.baseUrl,
            totalAssets: Number(o.totalAssets ?? 0),
            newAssets: Number(o.newAssets ?? 0),
            totalHosts: Number(o.totalHosts ?? 0),
            newHosts: Number(o.newHosts ?? 0),
            networking: Number(o.networking ?? 0),
            newNetworking: Number(o.newNetworking ?? 0),
            riskHigh: Number(risk.high ?? 0),
            riskMedium: Number(risk.medium ?? 0),
            riskLow: Number(risk.low ?? 0),
            raw: data,
            capturedAt: new Date().toISOString(),
          },
        );
        context.logger.info(
          "Overview: {total} assets ({low} low/{med} med/{high} high risk)",
          {
            total: Number(o.totalAssets ?? 0),
            low: Number(risk.low ?? 0),
            med: Number(risk.medium ?? 0),
            high: Number(risk.high ?? 0),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    listAssets: {
      description:
        "List discovered assets (risk level, vendor, type, connection data) via the /sepio-data GraphQL layer.",
      arguments: z.object({
        pageSize: z.number().int().min(1).max(1000).default(100).describe(
          "Rows per page",
        ),
        pageNumber: z.number().int().min(1).default(1).describe(
          "1-based page number",
        ),
        sortBy: z.string().default("riskLevel_desc").describe(
          "Sort key, e.g. riskLevel_desc or lastSeen_desc",
        ),
        globalSearch: z.string().default("").describe(
          "Free-text search across assets",
        ),
      }),
      execute: async (
        args: {
          pageSize: number;
          pageNumber: number;
          sortBy: string;
          globalSearch: string;
        },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const data = await graphql(
          g,
          token,
          "GetDiscoveredAssets",
          discoveredAssetsQuery(
            args.pageNumber,
            args.pageSize,
            args.sortBy,
            args.globalSearch,
          ),
        );
        const table = ((data as { data?: { conditionalTable?: unknown } })
          ?.data?.conditionalTable ?? {}) as Record<string, unknown>;
        const assets = Array.isArray(table.data) ? table.data : [];
        const handle = await context.writeResource(
          "assets",
          `page-${args.pageNumber}`,
          {
            baseUrl: g.baseUrl,
            recordsTotal: Number(table.recordsTotal ?? 0),
            recordsFiltered: Number(table.recordsFiltered ?? 0),
            pageNumber: args.pageNumber,
            pageSize: args.pageSize,
            count: assets.length,
            assets,
            capturedAt: new Date().toISOString(),
          },
        );
        context.logger.info("Listed {n} of {total} assets", {
          n: assets.length,
          total: Number(table.recordsTotal ?? 0),
        });
        return { dataHandles: [handle] };
      },
    },

    listDeviceTypes: {
      description:
        "List the device-type distribution (asset categories with asset/risk counts) from transformerDataApi/assetsDistribuition.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const { data } = await apiFetch(
          g,
          "GET",
          "/prime/webui/transformerDataApi/assetsDistribuition",
          { token },
        );
        return collect(context, "deviceTypes", data);
      },
    },

    analyzeRisks: {
      description:
        "Risk-insights rollup: network port anomalies, vulnerable switches, and uncommon + vulnerable peripherals. Per-source detail is in `raw`.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const endpoints: Record<string, string> = {
          portAnomalies: "/prime/webui/Switches/RiskInsights/PortAnomalies",
          vulnerableSwitches:
            "/prime/webui/Switches/RiskInsights/VulnerableSwitch",
          uncommonPeripherals:
            "/prime/webui/agents/RiskInsights/UncommonPeripherals",
          vulnerablePeripherals:
            "/prime/webui/agents/RiskInsights/VulnerablePeripherals",
        };
        const raw: Record<string, unknown> = {};
        for (const [key, path] of Object.entries(endpoints)) {
          try {
            raw[key] = (await apiFetch(g, "GET", path, { token })).data;
          } catch (e) {
            raw[key] = { error: e instanceof Error ? e.message : String(e) };
          }
        }
        return collect(context, "riskInsights", [], raw);
      },
    },

    listEvents: {
      description:
        "List events from the event log (Events/GetEvents), with severity/category/search filters.",
      arguments: z.object({
        pageSize: z.number().int().min(1).max(1000).default(50).describe(
          "Rows per page",
        ),
        pageNumber: z.number().int().min(1).default(1).describe(
          "1-based page number",
        ),
        minimumSeverity: z.number().int().optional().describe(
          "Minimum severity to include",
        ),
        category: z.string().optional().describe("Filter by event category"),
        globalSearch: z.string().optional().describe("Free-text search"),
      }),
      execute: async (
        args: {
          pageSize: number;
          pageNumber: number;
          minimumSeverity?: number;
          category?: string;
          globalSearch?: string;
        },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const query: Record<string, string> = {
          PageSize: String(args.pageSize),
          PageNumber: String(args.pageNumber),
        };
        if (args.minimumSeverity !== undefined) {
          query.MinimumSeverity = String(args.minimumSeverity);
        }
        if (args.category) query.Category = args.category;
        if (args.globalSearch) query.GlobalSearch = args.globalSearch;
        const { data } = await apiFetch(
          g,
          "GET",
          "/prime/webui/Events/GetEvents",
          {
            token,
            query,
          },
        );
        return collect(context, "events", data);
      },
    },

    listAlarmDestinations: {
      description:
        "List configured alarm destinations / SIEM-syslog targets (Events/GetAlarmDests).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const { data } = await apiFetch(
          g,
          "GET",
          "/prime/webui/Events/GetAlarmDests",
          { token },
        );
        return collect(context, "alarmDestinations", data);
      },
    },

    listPolicies: {
      description: "List policy-engine policies (policyEngine/policy).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const { data } = await apiFetch(
          g,
          "GET",
          "/prime/webui/policyEngine/policy",
          { token },
        );
        return collect(context, "policies", data);
      },
    },

    listScopes: {
      description: "List scopes (scopes-api/scopes).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const { data } = await apiFetch(
          g,
          "GET",
          "/prime/webui/scopes-api/scopes",
          {
            token,
          },
        );
        return collect(context, "scopes", data);
      },
    },

    listTags: {
      description: "List all tags (tagsApi/tags).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const { data } = await apiFetch(g, "GET", "/prime/webui/tagsApi/tags", {
          token,
        });
        return collect(context, "tags", data);
      },
    },

    listUserAttributes: {
      description: "List user attributes (UserAttributes), paginated.",
      arguments: z.object({
        pageSize: z.number().int().min(1).max(1000).default(100).describe(
          "Rows per page",
        ),
        pageNumber: z.number().int().min(1).default(1).describe(
          "1-based page number",
        ),
        globalSearch: z.string().optional().describe("Free-text search"),
      }),
      execute: async (
        args: { pageSize: number; pageNumber: number; globalSearch?: string },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const query: Record<string, string> = {
          pageSize: String(args.pageSize),
          pageNumber: String(args.pageNumber),
        };
        if (args.globalSearch) query.globalSearch = args.globalSearch;
        const { data } = await apiFetch(
          g,
          "GET",
          "/prime/webui/UserAttributes",
          {
            token,
            query,
          },
        );
        return collect(context, "userAttributes", data);
      },
    },

    createTag: {
      description:
        "Create a tag by name (tagsApi/tags/add-tag/{tagName}). Mutating.",
      arguments: z.object({
        tagName: z.string().min(1).describe("Tag name to create"),
      }),
      execute: async (
        args: { tagName: string },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const { status, data } = await apiFetch(
          g,
          "POST",
          `/prime/webui/tagsApi/tags/add-tag/${
            encodeURIComponent(args.tagName)
          }`,
          { token },
        );
        return mutate(context, "createTag", args.tagName, status, data);
      },
    },

    addUserAttribute: {
      description:
        "Create a user attribute (UserAttributes/AddUserAttribute). Mutating.",
      arguments: z.object({
        field: z.string().min(1).describe("User-attribute name/field to add"),
      }),
      execute: async (
        args: { field: string },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const { status, data } = await apiFetch(
          g,
          "POST",
          "/prime/webui/UserAttributes/AddUserAttribute",
          { token, body: { field: args.field } },
        );
        return mutate(context, "addUserAttribute", args.field, status, data);
      },
    },

    createPolicy: {
      description:
        "Create a policy (policyEngine/policy). `policy` is a PolicyDto: name, description, ruleList[], matchCriteria[], defaultAction/defaultActionType, isActive, scopes[]. Mutating.",
      arguments: z.object({
        policy: z.record(z.string(), z.unknown()).describe("PolicyDto object"),
      }),
      execute: async (
        args: { policy: Record<string, unknown> },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const { status, data } = await apiFetch(
          g,
          "POST",
          "/prime/webui/policyEngine/policy",
          { token, body: args.policy },
        );
        return mutate(
          context,
          "createPolicy",
          String(args.policy.name ?? ""),
          status,
          data,
        );
      },
    },

    createScope: {
      description:
        "Create a scope (scopes-api/scope). `scope` is a ScopeDto: name, matchCriteria[], agentMode. Mutating.",
      arguments: z.object({
        scope: z.record(z.string(), z.unknown()).describe("ScopeDto object"),
      }),
      execute: async (
        args: { scope: Record<string, unknown> },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const { status, data } = await apiFetch(
          g,
          "POST",
          "/prime/webui/scopes-api/scope",
          { token, body: args.scope },
        );
        return mutate(
          context,
          "createScope",
          String(args.scope.name ?? ""),
          status,
          data,
        );
      },
    },

    listSwitches: {
      description:
        "List switches Sepio sees on the network (Switches/Switches).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const { data } = await apiFetch(
          g,
          "GET",
          "/prime/webui/Switches/Switches",
          {
            token,
          },
        );
        return collect(context, "switches", data);
      },
    },

    getSwitchPort: {
      description:
        "Get detail for one switch port (Switches/Switches/{switchDataId}/{portDataId}).",
      arguments: z.object({
        switchDataId: z.string().describe("Switch data id"),
        portDataId: z.string().describe("Port data id"),
      }),
      execute: async (
        args: { switchDataId: string; portDataId: string },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const { data } = await apiFetch(
          g,
          "GET",
          `/prime/webui/Switches/Switches/${
            encodeURIComponent(args.switchDataId)
          }/${encodeURIComponent(args.portDataId)}`,
          { token },
        );
        return detail(
          context,
          "switchPort",
          `${args.switchDataId}-${args.portDataId}`,
          data,
        );
      },
    },

    listPeripherals: {
      description:
        "List connected peripherals/endpoints with vendor and risk via the transformer view (transformerDataApi/GetPeripherals).",
      arguments: z.object({
        pageSize: z.number().int().min(1).max(1000).default(100).describe(
          "Rows per page",
        ),
        pageNumber: z.number().int().min(1).default(1).describe(
          "1-based page number",
        ),
        globalSearch: z.string().optional().describe("Free-text search"),
        severity: z.string().optional().describe("Filter by severity"),
        sortBy: z.string().default("severity_desc").describe(
          "Sort key (required by this endpoint, e.g. severity_desc)",
        ),
      }),
      execute: async (
        args: {
          pageSize: number;
          pageNumber: number;
          globalSearch?: string;
          severity?: string;
          sortBy: string;
        },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const query: Record<string, string> = {
          PageSize: String(args.pageSize),
          PageNumber: String(args.pageNumber),
          SortBy: args.sortBy,
        };
        if (args.globalSearch) query.GlobalSearch = args.globalSearch;
        if (args.severity) query.Severity = args.severity;
        const { data } = await apiFetch(
          g,
          "GET",
          "/prime/webui/transformerDataApi/GetPeripherals",
          { token, query },
        );
        return collect(context, "peripherals", data);
      },
    },

    getPeripheral: {
      description:
        "Get detail for one peripheral by uuid (peripherals/{uuid}). Requires the agent peripherals API (agent-mode deployments); on agentless instances use getAsset.",
      arguments: z.object({ uuid: z.string().describe("Peripheral uuid") }),
      execute: async (
        args: { uuid: string },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const { data } = await apiFetch(
          g,
          "GET",
          `/prime/webui/peripherals/${encodeURIComponent(args.uuid)}`,
          { token },
        );
        return detail(context, "peripheral", args.uuid, data);
      },
    },

    listAgents: {
      description:
        "List Sepio agents/collectors with status, version, and risk flags (agents).",
      arguments: z.object({
        pageSize: z.number().int().min(1).max(1000).default(100).describe(
          "Rows per page",
        ),
        pageNumber: z.number().int().min(1).default(1).describe(
          "1-based page number",
        ),
        globalSearch: z.string().optional().describe("Free-text search"),
        status: z.string().optional().describe("Filter by agent status"),
      }),
      execute: async (
        args: {
          pageSize: number;
          pageNumber: number;
          globalSearch?: string;
          status?: string;
        },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const query: Record<string, string> = {
          PageSize: String(args.pageSize),
          PageNumber: String(args.pageNumber),
        };
        if (args.globalSearch) query.GlobalSearch = args.globalSearch;
        if (args.status) query.Status = args.status;
        const { data } = await apiFetch(g, "GET", "/prime/webui/agents", {
          token,
          query,
        });
        return collect(context, "agents", data);
      },
    },

    getAgent: {
      description: "Get detail for one agent by id (agents/agent/{agentId}).",
      arguments: z.object({ agentId: z.string().describe("Agent id") }),
      execute: async (
        args: { agentId: string },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const { data } = await apiFetch(
          g,
          "GET",
          `/prime/webui/agents/agent/${encodeURIComponent(args.agentId)}`,
          { token },
        );
        return detail(context, "agent", args.agentId, data);
      },
    },

    getAsset: {
      description:
        "Full detail for one asset by id (fingerprint, connection, risk) via the /sepio-data GraphQL layer.",
      arguments: z.object({
        assetId: z.string().describe(
          "Asset id (the `id` field from listAssets)",
        ),
      }),
      execute: async (
        args: { assetId: string },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const d = await graphql(
          g,
          token,
          "GetAssetDetail",
          assetDetailQuery(args.assetId),
        );
        const rows =
          ((d as { data?: { conditionalTable?: { data?: unknown } } })
            ?.data?.conditionalTable?.data) ?? [];
        const asset = Array.isArray(rows) && rows.length ? rows[0] : null;
        return detail(context, "asset", args.assetId, asset);
      },
    },

    listReports: {
      description:
        "List stored report queries you can run (reportManagerApi/queries).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const { data } = await apiFetch(
          g,
          "GET",
          "/prime/webui/reportManagerApi/queries",
          { token },
        );
        return collect(context, "reports", data);
      },
    },

    listReportDownloads: {
      description:
        "List generated report downloads (reportManagerApi/available-downloads).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const { data } = await apiFetch(
          g,
          "GET",
          "/prime/webui/reportManagerApi/available-downloads",
          { token },
        );
        return collect(context, "reportDownloads", data);
      },
    },

    triggerReport: {
      description:
        "Trigger a stored report query to generate a download (reportManagerApi/trigger). `request` is a TriggerRequestViewRequest body. Mutating.",
      arguments: z.object({
        id: z.string().describe("Stored query id to trigger"),
        request: z.record(z.string(), z.unknown()).optional().describe(
          "TriggerRequestViewRequest body",
        ),
      }),
      execute: async (
        args: { id: string; request?: Record<string, unknown> },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const { status, data } = await apiFetch(
          g,
          "PUT",
          "/prime/webui/reportManagerApi/trigger",
          { token, query: { id: args.id }, body: args.request ?? {} },
        );
        return mutate(context, "triggerReport", args.id, status, data);
      },
    },

    apiRequest: {
      description:
        "Generic authenticated request to any CybrIQ endpoint (all /prime/webui/* REST routes or /sepio-data). Logs in, attaches the bearer token, returns the JSON response.",
      arguments: z.object({
        method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET")
          .describe("HTTP method"),
        path: z.string().describe(
          "Host-relative path (e.g. /prime/webui/Switches/Switches) or an absolute https URL",
        ),
        query: z.record(z.string(), z.string()).optional().describe(
          "Query-string parameters",
        ),
        body: z.unknown().optional().describe(
          "JSON request body for POST/PUT/PATCH (or a {operationName,query,variables} object for /sepio-data)",
        ),
      }),
      execute: async (
        args: {
          method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
          path: string;
          query?: Record<string, string>;
          body?: unknown;
        },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { token } = await login(g);
        const { status, data } = await apiFetch(g, args.method, args.path, {
          token,
          query: args.query,
          body: args.body,
        });
        const handle = await context.writeResource("apiResult", "last", {
          method: args.method,
          path: args.path,
          status,
          data,
          requestedAt: new Date().toISOString(),
        });
        context.logger.info("{method} {path} -> {status}", {
          method: args.method,
          path: args.path,
          status,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
