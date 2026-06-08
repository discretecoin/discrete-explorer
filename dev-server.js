const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = __dirname;
const port = Number(process.argv[2] || process.env.PORT || 8080);
const host = process.env.HOST || "127.0.0.1";

const mimeTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml; charset=utf-8",
    ".txt": "text/plain; charset=utf-8"
};

const spaRoutePatterns = [
    /^\/(?:block|transaction|payment-id|address|account|account-number)\/[^/]+\/?$/i,
    /^\/(?:nodes|charts|alt-blocks|tools|broadcast-transaction|check-funds|check-payment|validate-address|verify-message|amount-converter|payment-id-tools|paper-wallet|settings)\/?$/i
];

function isSpaRoute(pathname) {
    if (pathname === "/" || pathname === "/index.html") return true;
    return spaRoutePatterns.some(function (pattern) {
        return pattern.test(pathname);
    });
}

function resolveLocalPath(pathname) {
    const normalizedPath = decodeURIComponent(pathname).replace(/^\/+/, "");
    const absolutePath = path.resolve(rootDir, normalizedPath);
    const relativePath = path.relative(rootDir, absolutePath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        return null;
    }

    return absolutePath;
}

function sendFile(request, response, filePath, statusCode) {
    fs.stat(filePath, function (statError, stats) {
        if (statError || !stats.isFile()) {
            response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            response.end("Not found");
            return;
        }

        const extension = path.extname(filePath).toLowerCase();
        const contentType = mimeTypes[extension] || "application/octet-stream";

        response.writeHead(statusCode || 200, {
            "Content-Length": stats.size,
            "Content-Type": contentType,
            "Cache-Control": "no-store"
        });

        if (request.method === "HEAD") {
            response.end();
            return;
        }

        const stream = fs.createReadStream(filePath);
        stream.on("error", function () {
            response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            response.end("Could not read file");
        });
        stream.pipe(response);
    });
}

function isLoopbackTarget(targetUrl) {
    try {
        const parsed = new URL(targetUrl);
        return (parsed.protocol === "http:" || parsed.protocol === "https:")
            && /^(localhost|127\.0\.0\.1)$/i.test(parsed.hostname || "");
    } catch (error) {
        return false;
    }
}

function proxyToTarget(request, response, targetUrl) {
    if (!isLoopbackTarget(targetUrl)) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Invalid proxy target");
        return;
    }

    const parsedTarget = new URL(targetUrl);
    const transport = parsedTarget.protocol === "https:" ? https : http;
    const headers = {};

    ["accept", "content-type", "content-length"].forEach(function (headerName) {
        if (request.headers[headerName]) headers[headerName] = request.headers[headerName];
    });

    const upstreamRequest = transport.request(parsedTarget, {
        method: request.method,
        headers: headers
    }, function (upstreamResponse) {
        response.writeHead(upstreamResponse.statusCode || 502, {
            "Content-Type": upstreamResponse.headers["content-type"] || "application/octet-stream",
            "Cache-Control": "no-store"
        });

        if (request.method === "HEAD") {
            response.end();
            upstreamResponse.resume();
            return;
        }

        upstreamResponse.pipe(response);
    });

    upstreamRequest.on("error", function (error) {
        response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Proxy request failed: " + error.message);
    });

    if (request.method === "GET" || request.method === "HEAD") {
        upstreamRequest.end();
        return;
    }

    request.pipe(upstreamRequest);
}

const server = http.createServer(function (request, response) {
    const requestUrl = new URL(request.url || "/", "http://" + (request.headers.host || "localhost"));
    const pathname = requestUrl.pathname || "/";

    if (pathname === "/__proxy__") {
        const target = requestUrl.searchParams.get("target");
        if (!target) {
            response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            response.end("Missing proxy target");
            return;
        }
        proxyToTarget(request, response, target);
        return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Method not allowed");
        return;
    }

    if (isSpaRoute(pathname)) {
        sendFile(request, response, path.join(rootDir, "index.html"), 200);
        return;
    }

    const resolvedPath = resolveLocalPath(pathname);
    if (!resolvedPath) {
        response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Forbidden");
        return;
    }

    fs.stat(resolvedPath, function (statError, stats) {
        if (!statError && stats.isDirectory()) {
            sendFile(request, response, path.join(resolvedPath, "index.html"), 200);
            return;
        }

        if (!statError && stats.isFile()) {
            sendFile(request, response, resolvedPath, 200);
            return;
        }

        const fallback404 = path.join(rootDir, "404.html");
        fs.stat(fallback404, function (fallbackError, fallbackStats) {
            if (!fallbackError && fallbackStats.isFile()) {
                sendFile(request, response, fallback404, 404);
                return;
            }

            response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            response.end("Not found");
        });
    });
});

server.listen(port, host, function () {
    console.log("Karbo explorer dev server running at http://" + host + ":" + port);
});
