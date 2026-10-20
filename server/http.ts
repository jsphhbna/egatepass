const JSON_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
};

export function jsonResponse(status: number, body: Record<string, unknown>, extraHeaders?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

export function readBearerToken(request: Request): string | null {
  const match = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/);
  return match?.[1] ?? null;
}
