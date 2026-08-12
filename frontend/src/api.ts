import type {
  ApiErrorBody,
  ChatRequest,
  ChatResponse,
  CompareResponse,
  HealthResponse,
  NpuDetail,
  NpuListResponse,
} from "./types";

/** Thrown for any non-2xx response or transport failure. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { detail?: unknown }).detail === "string"
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (cause) {
    throw new ApiError(`Network request to ${path} failed`, 0);
  }

  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const detail = isErrorBody(body) ? body.detail : res.statusText;
    throw new ApiError(detail || `Request to ${path} failed`, res.status);
  }

  return (await res.json()) as T;
}

/** GET /api/npus — summary row for all 25 NPUs. */
export function fetchNpus(): Promise<NpuListResponse> {
  return request<NpuListResponse>("/api/npus");
}

/** GET /api/npus/{npu} — cached report card for one NPU. */
export function fetchNpuDetail(npu: string): Promise<NpuDetail> {
  return request<NpuDetail>(`/api/npus/${encodeURIComponent(npu)}`);
}

/** GET /api/compare?a=&b= — two detail blocks plus computed gaps. */
export function fetchCompare(a: string, b: string): Promise<CompareResponse> {
  const query = new URLSearchParams({ a, b });
  return request<CompareResponse>(`/api/compare?${query.toString()}`);
}

/** POST /api/chat — grounded Q&A about one NPU. */
export function postChat(body: ChatRequest): Promise<ChatResponse> {
  return request<ChatResponse>("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** GET /api/health — ingest freshness probe. */
export function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/api/health");
}
