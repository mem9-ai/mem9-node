export interface ApiErrorResponse {
  code: string;
  message: string;
  requestId: string;
  details?: Record<string, unknown>;
}
