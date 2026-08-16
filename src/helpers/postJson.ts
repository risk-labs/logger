// Minimal JSON POST helper over the global fetch, which node has provided since 18. The transports only ever POST a
// JSON body to a webhook and inspect the status (plus the rate limit hints that come with it), so an HTTP client
// dependency does not earn its keep here.

// Thrown when the server responds with a non-2xx status. Carries what the transports need to decide whether the
// failure is worth retrying: Slack sends its back off in a `Retry-After` header, Discord in a `retry_after` body field.
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly headers: Headers,
    readonly data: unknown,
  ) {
    super(`Request failed with status code ${status}`);
    this.name = "HttpError";
  }
}

// POSTs body as JSON. Resolves on any 2xx, throws HttpError otherwise, and propagates whatever fetch throws (DNS
// failure, connection reset, and -- once a signal is passed -- abort) untouched.
export async function postJson(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  // Always drain the body, even when it is not needed: an unread body holds the connection open.
  const text = await response.text().catch(() => "");

  if (!response.ok) throw new HttpError(response.status, response.headers, parseJson(text));
}

// Webhook errors are usually JSON but are not guaranteed to be (proxies and gateways return HTML), so fall back to the
// raw text rather than losing the response.
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
