// Bounded body reading for agent cache-file uploads. The body is buffered in
// full to write the controller cache, so without a ceiling a compromised node
// credential could stream an unbounded body and exhaust controller memory.

// Cap a single cache-file upload. Configurable; the 4 GiB default comfortably
// exceeds any real recording rendition while bounding the blast radius.
export function recordingCacheUploadMaxBytes(): number {
  const parsed = Number(process.env.RAKKR_RECORDING_CACHE_MAX_BYTES);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : 4 * 1024 * 1024 * 1024;
}

// Read a request body into memory, aborting once it exceeds `maxBytes` — the
// backstop for a chunked upload that carries no (or a lying) Content-Length, so
// the cap holds even when the fast Content-Length pre-check cannot.
export async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | "too_large"> {
  const stream = request.body;

  if (!stream) {
    return new Uint8Array(0);
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (value) {
      total += value.byteLength;

      if (total > maxBytes) {
        await reader.cancel();
        return "too_large";
      }

      chunks.push(value);
    }
  }

  const out = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return out;
}
