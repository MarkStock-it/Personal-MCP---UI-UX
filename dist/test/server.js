import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
const MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
    ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".avif": "image/avif", ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain", ".ico": "image/x-icon",
};
/** Tiny static server for a built dist folder. Missing files with an extension are real 404s so broken assets get caught. */
export function serveDir(dir) {
    const root = path.resolve(dir);
    const server = http.createServer(async (req, res) => {
        try {
            const u = new URL(req.url ?? "/", "http://local");
            let p = decodeURIComponent(u.pathname);
            if (p.endsWith("/"))
                p += "index.html";
            let file = path.resolve(root, "." + p);
            if (file !== root && !file.startsWith(root + path.sep)) {
                res.writeHead(403).end();
                return;
            }
            let data;
            try {
                data = await fs.readFile(file);
            }
            catch {
                if (path.extname(p)) {
                    res.writeHead(404).end();
                    return;
                }
                file = path.join(root, "index.html");
                data = await fs.readFile(file);
            }
            res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
            res.end(data);
        }
        catch {
            res.writeHead(404).end();
        }
    });
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const port = server.address().port;
            resolve({
                url: `http://127.0.0.1:${port}`,
                close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
            });
        });
    });
}
