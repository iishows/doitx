// 纯静态 marketing 站点服务器 + /api/download 兜底层。
// node 标准库实现，无第三方依赖。
//
// 环境变量:
//   PORT                 监听端口 (默认 80)
//   WWW_ROOT             静态产物目录 (默认 ../apps/www/dist)
//   WWW_REDIRECTS        redirects.json 路径 (默认 ./redirects.json)
//   FALLBACK_RELEASE_URL 离线兜底下载链接
//   RAKAZO_GITHUB_API_BASE  设置后 /api/download 在线调 GitHub API 取最新 release
//   DOWNLOADS_WINDOWS / DOWNLOADS_MAC / DOWNLOADS_LINUX  离线按平台写死的兜底链接

import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// server.mjs 烘在 /app/server.mjs，dist 烘在 /app/apps/www/dist：
// 默认 root 相对 here 向上一级再进 apps/www/dist（而非两级）。
// WWW_ROOT 可显式覆盖（宿主调试用）。
const root = process.env.WWW_ROOT
  ? path.resolve(process.env.WWW_ROOT)
  : path.resolve(here, "apps", "www", "dist");
const redirectsPath = process.env.WWW_REDIRECTS
  ? path.resolve(process.env.WWW_REDIRECTS)
  : path.join(here, "redirects.json");
const port = Number(process.env.PORT || 80);
const fallbackReleaseUrl = process.env.FALLBACK_RELEASE_URL || "";
const githubApiBase = process.env.RAKAZO_GITHUB_API_BASE || "";

// 离线按平台兜底（构建时烘入或 env 覆盖）
const DOWNLOADS = {
  windows: process.env.DOWNLOADS_WINDOWS || fallbackReleaseUrl,
  mac: process.env.DOWNLOADS_MAC || fallbackReleaseUrl,
  linux: process.env.DOWNLOADS_LINUX || fallbackReleaseUrl,
};

// 在线模式：从 GitHub API 拉最新 release 的 installer，按平台映射下载链接；
// 任何错误（无 token、API 不可达、仓库改名）都回退到离线兜底。
async function fetchLatestDownloadLinks() {
  try {
    const res = await fetch(
      `${githubApiBase}/repos/iishows/doitx/releases/latest`,
      { headers: { accept: "application/vnd.github+json" } },
    );
    if (!res.ok) throw new Error(`releases/latest -> ${res.status}`);
    const data = await res.json();
    const assets = data.assets ?? [];
    const pick = (needles) =>
      assets.find((a) => needles.some((n) => a.name.includes(n)))?.browser_download_url;
    return {
      windows: pick(["win-x64", ".exe"]),
      mac: pick(["darwin", ".dmg", ".pkg"]),
      linux: pick(["linux", ".AppImage", ".deb"]),
    };
  } catch {
    return null;
  }
}

const redirects = (JSON.parse(await readFile(redirectsPath, "utf8")).redirects ?? [])

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
};

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

async function handleApiDownload(res, reqUrl) {
  const url = new URL(reqUrl, "http://localhost");
  const platform = url.searchParams.get("platform") || "";
  let target = DOWNLOADS[platform] || fallbackReleaseUrl;
  if (githubApiBase) {
    const live = await fetchLatestDownloadLinks();
    if (live && live[platform]) target = live[platform];
    else if (live && !url.searchParams.get("platform")) {
      // 无 platform 参数时取第一个可用链接
      target = live.windows || live.mac || live.linux || fallbackReleaseUrl;
    }
  }
  if (!target) {
    return send(res, 503, { "content-type": "text/plain" }, "download unavailable");
  }
  return send(res, 302, { location: target }, "");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname);

  // /api/download: 302 到平台 installer（在线取最新，离线走兜底）
  if (pathname === "/api/download") {
    return handleApiDownload(res, req.url);
  }

  // /redirects.json: 给 Vercel 式客户端转发保留
  if (pathname === "/redirects.json") {
    return send(res, 200, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({ redirects }));
  }

  // 其余路由全部按静态文件服务
  let filePath = path.join(root, pathname === "/" ? "index.html" : pathname);
  if (!filePath.startsWith(root) || !existsSync(filePath)) {
    const maybeIndex = path.join(root, pathname, "index.html");
    if (existsSync(maybeIndex)) filePath = maybeIndex;
    else return send(res, 404, { "content-type": "text/plain" }, "Not found");
  }
  const st = statSync(filePath);
  // 目录：有 index.html 则服务之，否则 404（_astro/ 等纯资源目录不应崩服务器）
  if (st.isDirectory()) {
    const idx = path.join(filePath, "index.html");
    if (!existsSync(idx)) return send(res, 404, { "content-type": "text/plain" }, "Not found");
    filePath = idx;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "content-length": statSync(filePath).size,
  });
  createReadStream(filePath).pipe(res);
});

server.listen(port, () => {
  console.log(`www serving on :${port} root=${root}`);
});
