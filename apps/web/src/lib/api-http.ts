// Small pure HTTP helpers shared by the API client. Extracted from api.ts to
// keep that module within the LOC budget.

export function withQuery(path: string, filters: object) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters) as Array<
    [string, number | string | undefined]
  >) {
    if (value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  }

  const query = params.toString();

  return query ? `${path}?${query}` : path;
}

export function fileNameFromDisposition(disposition: string | null) {
  const match = /filename="([^"]+)"/.exec(disposition ?? "");

  return match?.[1] ?? "recording.mp3";
}
