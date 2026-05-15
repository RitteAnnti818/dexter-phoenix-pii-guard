// Phoenix project-level metric fetcher (GraphQL).
// Powers the /phoenix toggle panel: traceCount, total cost, latency P50/P99,
// and per-evaluator mean scores — same numbers the Phoenix UI shows above the
// trace table. Two round trips (names → per-name summaries) so we can render
// any evaluator the user adds without code changes.

export interface PhoenixEvaluatorScore {
  name: string;
  meanScore: number | null;
  scoreCount: number;
}

export interface PhoenixStats {
  projectName: string;
  endpoint: string;
  traceCount: number;
  costUsd: number;
  p50Ms: number;
  p99Ms: number;
  evaluators: PhoenixEvaluatorScore[];
}

export type PhoenixStatsResult =
  | { kind: 'ok'; stats: PhoenixStats }
  | { kind: 'offline'; endpoint: string; reason: string };

function graphqlBaseUrl(): string {
  if (process.env.PHOENIX_BASE_URL) return process.env.PHOENIX_BASE_URL.replace(/\/$/, '');
  const endpoint = process.env.PHOENIX_COLLECTOR_ENDPOINT ?? 'http://localhost:6006/v1/traces';
  return endpoint.replace(/\/v1\/traces\/?$/, '').replace(/\/$/, '');
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.PHOENIX_API_KEY) headers.authorization = `Bearer ${process.env.PHOENIX_API_KEY}`;
  return headers;
}

async function gql<T>(url: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ query, variables }),
    // Hard cap so a hung Phoenix doesn't freeze the TUI.
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join('; '));
  }
  if (!body.data) throw new Error('empty response');
  return body.data;
}

const SUMMARY_QUERY = `query Stats($name: String!) {
  getProjectByName(name: $name) {
    name
    traceCount
    costSummary { total { cost } }
    p50: latencyMsQuantile(probability: 0.5)
    p99: latencyMsQuantile(probability: 0.99)
    spanAnnotationNames
  }
}`;

function aliasFor(name: string, idx: number): string {
  // GraphQL aliases must match /[_A-Za-z][_0-9A-Za-z]*/. Coerce, suffix with idx
  // to guarantee uniqueness even if two names sanitize to the same string.
  const safe = name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z_]/, '_');
  return `e${idx}_${safe}`;
}

function buildDetailQuery(names: string[]): string {
  const fields = names
    .map(
      (n, i) =>
        `${aliasFor(n, i)}: spanAnnotationSummary(annotationName: ${JSON.stringify(n)}) { meanScore scoreCount }`,
    )
    .join('\n    ');
  return `query Detail($name: String!) {
  getProjectByName(name: $name) {
    ${fields}
  }
}`;
}

interface SummaryShape {
  getProjectByName: {
    name: string;
    traceCount: number;
    costSummary: { total: { cost: number | null } };
    p50: number | null;
    p99: number | null;
    spanAnnotationNames: string[];
  } | null;
}

interface DetailShape {
  getProjectByName: Record<string, { meanScore: number | null; scoreCount: number } | null> | null;
}

export async function fetchPhoenixStats(projectName?: string): Promise<PhoenixStatsResult> {
  const base = graphqlBaseUrl();
  const url = `${base}/graphql`;
  const name = projectName ?? process.env.PHOENIX_PROJECT_NAME ?? 'dexter';

  let summary: SummaryShape;
  try {
    summary = await gql<SummaryShape>(url, SUMMARY_QUERY, { name });
  } catch (err) {
    return {
      kind: 'offline',
      endpoint: base,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const project = summary.getProjectByName;
  if (!project) {
    return { kind: 'offline', endpoint: base, reason: `project "${name}" not found` };
  }

  const evaluators: PhoenixEvaluatorScore[] = [];
  if (project.spanAnnotationNames.length > 0) {
    try {
      const detail = await gql<DetailShape>(url, buildDetailQuery(project.spanAnnotationNames), {
        name,
      });
      const node = detail.getProjectByName ?? {};
      project.spanAnnotationNames.forEach((n, i) => {
        const summaryRow = node[aliasFor(n, i)];
        evaluators.push({
          name: n,
          meanScore: summaryRow?.meanScore ?? null,
          scoreCount: summaryRow?.scoreCount ?? 0,
        });
      });
    } catch {
      // Names list succeeded but per-name lookup failed — still return what we
      // have so the panel can show traffic/cost/latency.
    }
  }

  return {
    kind: 'ok',
    stats: {
      projectName: project.name,
      endpoint: base,
      traceCount: project.traceCount,
      costUsd: project.costSummary.total.cost ?? 0,
      p50Ms: project.p50 ?? 0,
      p99Ms: project.p99 ?? 0,
      evaluators,
    },
  };
}
