const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const frontendPort = Number(process.env.FRONTEND_PORT || 5173);
const backendPort = process.env.PORT || "5050";
const frontendOnly = process.argv.includes("--frontend-only");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf"
};

function safePathFromUrl(url) {
  const parsed = new URL(url, `http://localhost:${frontendPort}`);
  const decodedPath = decodeURIComponent(parsed.pathname);
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const filePath = path.resolve(rootDir, relativePath);

  if (!filePath.startsWith(rootDir + path.sep) && filePath !== rootDir) {
    return null;
  }

  return filePath;
}

function startFrontend() {
  const server = http.createServer((req, res) => {
    const filePath = safePathFromUrl(req.url || "/");
    if (!filePath) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.stat(filePath, (statError, stats) => {
      const resolvedPath = !statError && stats.isDirectory()
        ? path.join(filePath, "index.html")
        : filePath;

      fs.readFile(resolvedPath, (readError, data) => {
        if (readError) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
          return;
        }

        const ext = path.extname(resolvedPath).toLowerCase();
        res.writeHead(200, {
          "Content-Type": mimeTypes[ext] || "application/octet-stream",
          "Cache-Control": "no-store"
        });
        res.end(data);
      });
    });
  });

  server.listen(frontendPort, () => {
    console.log(`Frontend: http://localhost:${frontendPort}`);
    console.log(`Admin:    http://localhost:${frontendPort}/frontend/admin/adminlogin.html`);
  });

  server.on("error", (error) => {
    console.error(`Frontend server failed: ${error.message}`);
    process.exitCode = 1;
  });

  return server;
}

function startBackend() {
  const child = spawn("npm", ["start"], {
    cwd: path.join(rootDir, "server"),
    env: { ...process.env, PORT: backendPort },
    shell: true,
    stdio: "inherit"
  });

  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`Backend exited with code ${code}`);
      process.exitCode = code;
    }
  });

  return child;
}

const frontend = startFrontend();
const backend = frontendOnly ? null : startBackend();

function shutdown() {
  frontend.close();
  if (backend) backend.kill();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
