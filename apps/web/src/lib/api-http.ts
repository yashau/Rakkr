// Small pure HTTP helpers shared by the API client. Extracted from api.ts to
// keep that module within the LOC budget.

import { ApiError } from "./api-error";

export const apiBase = import.meta.env.VITE_API_BASE ?? "";
const authTokenKey = "rakkr.authToken";

export interface RecordingFileBlob {
  blob: Blob;
  fileName: string;
}

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

export function getAuthToken() {
  return window.localStorage.getItem(authTokenKey);
}

export function consumeOidcCallbackToken() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = params.get("rakkr_token");

  if (!token) {
    return undefined;
  }

  setAuthToken(token);
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);

  return token;
}

export function setAuthToken(token: string) {
  window.localStorage.setItem(authTokenKey, token);
}

export function clearAuthToken() {
  window.localStorage.removeItem(authTokenKey);
}

export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getAuthToken();

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    throw new ApiError(response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export async function fetchBlob(path: string, init?: RequestInit): Promise<RecordingFileBlob> {
  const headers = new Headers(init?.headers);
  const token = getAuthToken();

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    throw new ApiError(response.status);
  }

  return {
    blob: await response.blob(),
    fileName: fileNameFromDisposition(response.headers.get("Content-Disposition")),
  };
}
