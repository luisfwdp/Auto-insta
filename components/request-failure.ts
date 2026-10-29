export type RequestFailure =
  | "api"
  | "external"
  | "permission"
  | "refused"
  | "session";

export function classifyRequestFailure(status: number): RequestFailure {
  if (status === 401) return "session";
  if (status === 403) return "permission";
  if ([400, 409, 422].includes(status)) return "refused";
  if ([502, 503, 504].includes(status)) return "external";
  return "api";
}
