import { z } from "npm:zod@4.3.6";

/**
 * Shared client, schema, and context types for the `@dougschaefer/cybriq`
 * model.
 *
 * CybrIQ fronts a Sepio asset-visibility / hardware-access-control platform
 * (rogue-device detection, MAC fingerprinting, switch-port risk). Its API
 * lives under `/prime/webui/*` (REST) plus a GraphQL data layer at
 * `/sepio-data`. The published OpenAPI spec declares no security scheme, but
 * the web UI authenticates with a local login that returns a short-lived
 * (~15 minute) JWT:
 *
 *   POST /prime/webui/Auth/LocalLogin {username,password}
 *     -> { token, expiresAt, refreshToken, user, license }
 *
 * Every subsequent call carries `Authorization: Bearer <token>`. Because the
 * token is short-lived, each method logs in fresh — login is cheap and this
 * keeps the model stateless. Credentials live in `globalArguments` and
 * resolve from vault, e.g.:
 *   username: ${{ vault.get(<vault>, cybriq-api-user) }}
 *   password: ${{ vault.get(<vault>, cybriq-api-password) }}
 *
 * Plain `fetch` (HTTPS + JSON) is used, so the bundle has no native deps.
 */

/** Connection + credentials for one CybrIQ/Sepio instance. */
export const CybriqGlobalArgsSchema = z.object({
  baseUrl: z.string().describe(
    "Base URL of the CybrIQ/Sepio instance, e.g. https://<tenant>.sepiopoc.com",
  ),
  username: z.string().describe(
    "Local-auth username. Use: ${{ vault.get(<vault>, cybriq-api-user) }}",
  ),
  password: z.string().meta({ sensitive: true }).describe(
    "Password for the user. Use: ${{ vault.get(<vault>, cybriq-api-password) }}",
  ),
  timeoutMs: z.number().int().default(30000).describe(
    "Per-request timeout in milliseconds",
  ),
});

/** Resolved connection + credentials for one CybrIQ/Sepio instance. */
export type CybriqGlobalArgs = z.infer<typeof CybriqGlobalArgsSchema>;

/** The subset of the LocalLogin response this model relies on. */
export interface LoginResult {
  token: string;
  expiresAt: string;
  refreshToken?: string;
  user?: Record<string, unknown>;
  license?: Record<string, unknown>;
}

/** Trim any trailing slashes from the configured base URL. */
function baseOf(g: CybriqGlobalArgs): string {
  return g.baseUrl.replace(/\/+$/, "");
}

/**
 * Low-level request: resolves the JSON (or text) body and throws on a
 * non-2xx status. `path` may be an absolute https URL or a host-relative
 * path; a bearer token, query params, and a JSON body are all optional.
 */
export async function apiFetch(
  g: CybriqGlobalArgs,
  method: string,
  path: string,
  opts: { token?: string; query?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; data: unknown }> {
  const url = new URL(path.startsWith("http") ? path : baseOf(g) + path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let payload: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(opts.body);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), g.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: payload,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const detail = typeof data === "string"
      ? data.slice(0, 300)
      : JSON.stringify(data).slice(0, 300);
    throw new Error(
      `CybrIQ ${method} ${path} -> HTTP ${res.status}: ${detail}`,
    );
  }
  return { status: res.status, data };
}

/** Authenticate via local login and return the bearer token + profile. */
export async function login(g: CybriqGlobalArgs): Promise<LoginResult> {
  const { data } = await apiFetch(g, "POST", "/prime/webui/Auth/LocalLogin", {
    body: { username: g.username, password: g.password },
  });
  const r = data as Partial<LoginResult> | null;
  if (!r || typeof r.token !== "string") {
    throw new Error(
      "LocalLogin returned no token — check credentials and that local auth is enabled",
    );
  }
  return r as LoginResult;
}

/** POST a GraphQL operation to the `/sepio-data` data layer. */
export async function graphql(
  g: CybriqGlobalArgs,
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<unknown> {
  const { data } = await apiFetch(g, "POST", "/sepio-data", {
    token,
    body: { operationName, query, variables },
  });
  return data;
}

/**
 * GraphQL query backing `listAssets` — discovered assets with risk level,
 * vendor, type, and connection data. Pagination/sort/search are inlined
 * (numbers are validated; strings are JSON-quoted) to match the shape the
 * Sepio UI sends.
 */
export function discoveredAssetsQuery(
  page: number,
  size: number,
  sortBy: string,
  search: string,
): string {
  return `query GetDiscoveredAssets {
  conditionalTable(
    query: {filters: [], systemFilters: [], globalSearch: ${
    JSON.stringify(search)
  }}
    pagination: {pageNumber: ${page}, pageSize: ${size}, sortBy: ${
    JSON.stringify(sortBy)
  }}
  ) {
    data {
      id isOnline icon type key riskLevel approved subType status transport
      version assignedName uuid assetDisplayName iconDescription group vendor
      locationsDisplay
      connectionData { protocol ipAddress domainName snmpLocation versionSNMP }
    }
    recordsFiltered
    recordsTotal
  }
}`;
}

/** Minimal shape of the swamp method context used by this model. */
export interface MethodContext {
  globalArgs: CybriqGlobalArgs;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    instance: string,
    data: Record<string, unknown>,
  ) => Promise<DataHandle>;
}

/** Reference returned by `writeResource`, returned from a method's execute. */
export interface DataHandle {
  name: string;
  specName: string;
}

/** Best-effort: pull the row array out of a list/wrapper response shape. */
export function pickArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (
      const k of [
        "data",
        "items",
        "results",
        "rows",
        "value",
        "events",
        "tags",
        "scopes",
        "policies",
      ]
    ) {
      if (Array.isArray(o[k])) return o[k] as unknown[];
      const inner = o[k];
      if (
        inner && typeof inner === "object" &&
        Array.isArray((inner as Record<string, unknown>).data)
      ) {
        return (inner as Record<string, unknown>).data as unknown[];
      }
    }
  }
  return [];
}

/**
 * Write a generic collection result (used by every list/analysis method) and
 * return its handle. `items` is the extracted row array; `raw` keeps the full
 * response so nothing is lost.
 */
export async function collect(
  context: MethodContext,
  kind: string,
  data: unknown,
  raw?: unknown,
): Promise<{ dataHandles: DataHandle[] }> {
  const items = pickArray(data);
  const handle = await context.writeResource("collection", kind, {
    baseUrl: context.globalArgs.baseUrl,
    kind,
    count: items.length,
    items,
    raw: raw ?? data,
    capturedAt: new Date().toISOString(),
  });
  context.logger.info("{kind}: {n} item(s)", { kind, n: items.length });
  return { dataHandles: [handle] };
}

/** Write a create/update result (used by every mutating method). */
export async function mutate(
  context: MethodContext,
  action: string,
  target: string,
  status: number,
  data: unknown,
): Promise<{ dataHandles: DataHandle[] }> {
  const handle = await context.writeResource("mutationResult", action, {
    baseUrl: context.globalArgs.baseUrl,
    action,
    target,
    status,
    data,
    appliedAt: new Date().toISOString(),
  });
  context.logger.info("{action} {target} -> {status}", {
    action,
    target,
    status,
  });
  return { dataHandles: [handle] };
}

/** Write a single-object drill-down detail result and return its handle. */
export async function detail(
  context: MethodContext,
  kind: string,
  id: string,
  data: unknown,
): Promise<{ dataHandles: DataHandle[] }> {
  const handle = await context.writeResource("detail", `${kind}-${id}`, {
    baseUrl: context.globalArgs.baseUrl,
    kind,
    id,
    data,
    capturedAt: new Date().toISOString(),
  });
  context.logger.info("{kind} {id} fetched", { kind, id });
  return { dataHandles: [handle] };
}

/** GraphQL query backing `getAsset` — full detail for one asset by id. */
export function assetDetailQuery(id: string): string {
  return `query GetAssetDetail {
  conditionalTable(
    query: {filters: [{index: 0, field: "id", expression: "Exact", value: ${
    JSON.stringify(id)
  }, op: "AND", conditionTypeValue: "single"}], systemFilters: [], globalSearch: ""}
    pagination: {pageNumber: 1, pageSize: 1, sortBy: "riskLevel_desc"}
  ) {
    data {
      id uuid key isOnline blocking icon type subType riskLevel approved status
      isRiskAccepted transport version assignedName isMissingInformation
      assetDisplayName iconDescription group vendor locationsDisplay
      allAssetTypeDetail
      connectionData {
        protocol versionSNMP domainName domainId ipAddress pollingGroupId
        snmpLocation
      }
      tagsView { name id }
    }
    recordsFiltered
    recordsTotal
  }
}`;
}
