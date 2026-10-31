// Static server for web/. Web Serial needs a secure context, and 127.0.0.1 counts as one.
//   bun serve.ts            -> http://127.0.0.1:8000
//   PORT=9000 bun serve.ts
import { resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "web");
const port = Number(process.env.PORT ?? 8000);

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    let path = decodeURIComponent(new URL(req.url).pathname);
    if (path.endsWith("/")) path += "index.html";
    const full = resolve(root, "." + path);
    if (full !== root && !full.startsWith(root + sep)) {
      return new Response("Forbidden", { status: 403 });
    }
    const file = Bun.file(full);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file, { headers: { "Cache-Control": "no-store" } });
  },
});

console.log(`E-ink uploader: http://127.0.0.1:${port}  (open in Chrome or Edge)`);
