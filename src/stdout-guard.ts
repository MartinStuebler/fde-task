// Belt-and-suspenders stdout guard. The stdio MCP protocol OWNS stdout: the
// only bytes allowed there are framed JSON-RPC messages from the transport.
// Anything else — npm banners, a stray console.log, noisy dependency output —
// would corrupt the stream and kill the client. This monkey-patch redirects any
// non-JSON write to stderr. Imported as the FIRST line of the entry file so it
// is installed before the transport (or anything else) can touch stdout.
const realStdoutWrite = process.stdout.write.bind(process.stdout);

(process.stdout.write as unknown) = (chunk: unknown, enc?: unknown, cb?: unknown): boolean => {
  const s =
    typeof chunk === "string"
      ? chunk
      : Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : String(chunk);
  const trimmed = s.trimStart();
  // Transport messages are JSON objects/arrays; let only those through.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return realStdoutWrite(chunk as never, enc as never, cb as never);
  }
  return (process.stderr.write as (...a: unknown[]) => boolean)(chunk, enc, cb);
};

export {};
