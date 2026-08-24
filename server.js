const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const SAMPLER_ROOT = path.join(ROOT, "sampler");
const SAMPLER_PORT = 8877;
const ASSISTED_EXTRACT_ENABLED = process.env.ALLOW_ASSISTED_EXTRACT !== "false";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

let playwrightPromise = null;
const extractCache = new Map();
const assistSessions = new Map();
const EXTRACT_CACHE_TTL_MS = 5 * 60 * 1000;
let samplerProcess = null;
let samplerReadyPromise = null;

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function waitForSamplerReady() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${SAMPLER_PORT}/index.html`);
      if (response.ok) return true;
    } catch {}
    await sleep(250);
  }
  throw new Error("抽样服务启动超时");
}

async function ensureSamplerService() {
  if (!fs.existsSync(path.join(SAMPLER_ROOT, "app.py"))) {
    throw new Error("未找到抽样工具服务文件 `sampler/app.py`");
  }

  if (samplerReadyPromise) {
    return samplerReadyPromise;
  }

  samplerReadyPromise = (async () => {
    if (!samplerProcess || samplerProcess.killed) {
      samplerProcess = spawn("python3", ["app.py"], {
        cwd: SAMPLER_ROOT,
        env: { ...process.env, PORT: String(SAMPLER_PORT) },
        stdio: ["ignore", "pipe", "pipe"],
      });

      samplerProcess.stdout.on("data", (chunk) => {
        const text = String(chunk || "").trim();
        if (text) {
          console.log(`[sampler] ${text}`);
        }
      });

      samplerProcess.stderr.on("data", (chunk) => {
        const text = String(chunk || "").trim();
        if (text) {
          console.error(`[sampler] ${text}`);
        }
      });

      samplerProcess.on("exit", (code) => {
        console.log(`[sampler] exited with code ${code}`);
        samplerProcess = null;
        samplerReadyPromise = null;
      });
    }

    await waitForSamplerReady();
    return true;
  })();

  return samplerReadyPromise;
}

async function proxyToSampler(req, res, reqUrl) {
  await ensureSamplerService();

  const body =
    req.method && !["GET", "HEAD"].includes(req.method.toUpperCase()) ? await readRequestBody(req) : undefined;

  const upstream = await fetch(`http://127.0.0.1:${SAMPLER_PORT}${reqUrl.pathname}${reqUrl.search}`, {
    method: req.method || "GET",
    headers: {
      "Content-Type": req.headers["content-type"] || "application/json",
    },
    body,
  });

  const responseBuffer = Buffer.from(await upstream.arrayBuffer());
  const headers = {};
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() === "connection") return;
    headers[key] = value;
  });
  headers["Access-Control-Allow-Origin"] = "*";

  res.writeHead(upstream.status, headers);
  res.end(responseBuffer);
}

function getCachedExtract(key) {
  const cached = extractCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > EXTRACT_CACHE_TTL_MS) {
    extractCache.delete(key);
    return null;
  }
  return cached.payload;
}

function setCachedExtract(key, payload) {
  extractCache.set(key, {
    createdAt: Date.now(),
    payload,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDesktopHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
}

function getMobileHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
}

function isTikTokHost(hostname = "") {
  return hostname.toLowerCase().includes("tiktok.com");
}

function decodePossiblyEscapedUrl(value) {
  return String(value || "")
    .replaceAll("\\u002F", "/")
    .replaceAll("\\/", "/")
    .replaceAll("&amp;", "&")
    .replace(/^&quot;|&quot;$/g, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function normalizeImageUrl(baseUrl, value) {
  if (!value) return null;
  const cleaned = decodePossiblyEscapedUrl(value);
  if (!cleaned) return null;
  if (cleaned.startsWith("data:")) return null;
  if (cleaned.startsWith("javascript:")) return null;
  try {
    return new URL(cleaned, baseUrl).toString();
  } catch {
    return null;
  }
}

function getImageIdentity(url) {
  try {
    const parsed = new URL(url);
    const cleanPath = parsed.pathname
      .replace(/~tplv-[^/.?]+/gi, "")
      .replace(/\/+$/g, "")
      .toLowerCase();
    return `${parsed.hostname.toLowerCase()}${cleanPath}`;
  } catch {
    return String(url || "").toLowerCase();
  }
}

function uniqueByUrl(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.url) return false;
    const key = getImageIdentity(item.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractSrcsetUrls(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function scoreImageUrl(url, source = "") {
  const value = String(url).toLowerCase();
  const sourceValue = String(source).toLowerCase();
  let score = 0;

  if (/\.(png|jpg|jpeg|webp|avif)(\?|$)/.test(value)) score += 3;
  if (value.includes("og:image")) score += 2;
  if (value.includes("large")) score += 1;
  if (value.includes("cover")) score += 1;
  if (value.includes("banner")) score += 1;
  if (value.includes("hero")) score += 1;
  if (value.includes("tiktokcdn") || value.includes("byteimg") || value.includes("muscdn")) score += 4;
  if (value.includes("photomode")) score += 8;
  if (value.includes("tplv-photomode-image")) score += 10;
  if (value.includes("image") || value.includes("photo")) score += 1;
  if (sourceValue.includes("network")) score += 2;
  if (sourceValue.includes("script")) score += 2;
  if (sourceValue.includes("browser")) score += 1;
  if (sourceValue.includes("visible-large")) score += 9;
  if (sourceValue.includes("visible")) score += 5;
  if (sourceValue.includes("large")) score += 3;
  if (sourceValue.includes("background")) score -= 2;

  if (value.includes("icon")) score -= 4;
  if (value.includes("logo")) score -= 4;
  if (value.includes("sprite")) score -= 5;
  if (value.includes("avatar")) score -= 5;
  if (value.includes("emoji")) score -= 3;
  if (value.includes("ads")) score -= 3;
  if (value.includes("music-cover")) score -= 3;
  if (value.includes("thumbnail")) score -= 4;
  if (value.includes("thumb")) score -= 3;
  if (value.includes("cover")) score -= 2;

  return score;
}

function toScoredImages(items) {
  return uniqueByUrl(items)
    .map((item) => ({
      ...item,
      score: scoreImageUrl(item.url, item.source),
    }))
    .filter((item) => item.score > -3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 36);
}

function filterTikTokImages(items) {
  const cleaned = items.filter((item) => {
    const value = String(item.url || "").toLowerCase();
    return (
      value &&
      !value.includes("avatar") &&
      !value.includes("logo") &&
      !value.includes("icon") &&
      !value.includes("music-cover")
    );
  });

  const visiblePrimary = cleaned.filter((item) => {
    const source = String(item.source || "").toLowerCase();
    const value = String(item.url || "").toLowerCase();
    return source.includes("visible-large") || value.includes("photomode");
  });

  const preferred = visiblePrimary.length ? visiblePrimary : cleaned;
  return toScoredImages(preferred).slice(0, 8);
}

function getHostHint(hostname) {
  const host = hostname.toLowerCase();
  if (host.includes("tiktok.com")) {
    return "TikTok 页面常为动态渲染，并且可能受地区、登录态或反爬限制。现在会优先尝试静态解析、脚本数据解析和浏览器渲染三种方式。";
  }
  if (host.includes("instagram.com") || host.includes("xiaohongshu.com")) {
    return "这个站点常依赖前端动态渲染或登录态，普通抓取可能拿不到完整图片。";
  }
  return "这个网页可能使用了动态渲染、登录态或反爬策略，导致普通抓取不一定能拿到完整图片。";
}

function extractImagesFromHtml(html, pageUrl) {
  const results = [];
  const imgRegex = /<img[\s\S]*?(?:src|data-src|data-original|data-lazy-src|data-lazy)=["']([^"']+)["'][\s\S]*?>/gi;
  const sourceSrcsetRegex = /<(?:img|source)[\s\S]*?(?:srcset|data-srcset)=["']([^"']+)["'][\s\S]*?>/gi;
  const posterRegex = /<video[\s\S]*?poster=["']([^"']+)["'][\s\S]*?>/gi;
  const dataImageRegex =
    /<(?:img|div|a)[\s\S]*?(?:data-image|data-cover|data-bg|data-background|data-thumb|data-src-large)=["']([^"']+)["'][\s\S]*?>/gi;
  const metaRegex = /<meta[\s\S]*?(?:property|name)=["'](?:og:image|twitter:image|twitter:image:src)["'][\s\S]*?content=["']([^"']+)["'][\s\S]*?>/gi;
  const linkRegex = /<link[\s\S]*?rel=["']image_src["'][\s\S]*?href=["']([^"']+)["'][\s\S]*?>/gi;
  const bgRegex = /background-image\s*:\s*url\(([^)]+)\)/gi;

  let match;
  while ((match = imgRegex.exec(html))) {
    const url = normalizeImageUrl(pageUrl, match[1]);
    if (url) results.push({ url, source: "img" });
  }
  while ((match = sourceSrcsetRegex.exec(html))) {
    extractSrcsetUrls(match[1]).forEach((value) => {
      const url = normalizeImageUrl(pageUrl, value);
      if (url) results.push({ url, source: "srcset" });
    });
  }
  while ((match = posterRegex.exec(html))) {
    const url = normalizeImageUrl(pageUrl, match[1]);
    if (url) results.push({ url, source: "poster" });
  }
  while ((match = dataImageRegex.exec(html))) {
    const url = normalizeImageUrl(pageUrl, match[1]);
    if (url) results.push({ url, source: "data-attr" });
  }
  while ((match = metaRegex.exec(html))) {
    const url = normalizeImageUrl(pageUrl, match[1]);
    if (url) results.push({ url, source: "meta" });
  }
  while ((match = linkRegex.exec(html))) {
    const url = normalizeImageUrl(pageUrl, match[1]);
    if (url) results.push({ url, source: "link" });
  }
  while ((match = bgRegex.exec(html))) {
    const url = normalizeImageUrl(pageUrl, match[1]);
    if (url) results.push({ url, source: "background" });
  }

  return toScoredImages(results);
}

function extractTikTokImagesFromScripts(html, pageUrl) {
  const results = [];
  const urlListBlockRegex = /"urlList"\s*:\s*\[([\s\S]*?)\]/gi;
  const plainImageUrlRegex =
    /(https?:\\\/\\\/[^"'\\\s<>{}]+(?:jpe?g|png|webp|avif)[^"'\\\s<>{}]*)/gi;
  const tiktokCdnRegex =
    /(https?:\\\/\\\/[^"'\\\s<>{}]*(?:tiktokcdn|byteimg|muscdn|ibyteimg|ibytedtos)[^"'\\\s<>{}]*)/gi;

  let match;
  while ((match = urlListBlockRegex.exec(html))) {
    const urlCandidates = match[1].match(/"([^"]+)"/g) || [];
    urlCandidates.forEach((raw) => {
      const url = normalizeImageUrl(pageUrl, raw);
      if (url) results.push({ url, source: "script:urlList" });
    });
  }
  while ((match = plainImageUrlRegex.exec(html))) {
    const url = normalizeImageUrl(pageUrl, match[1]);
    if (url) results.push({ url, source: "script:image-url" });
  }
  while ((match = tiktokCdnRegex.exec(html))) {
    const url = normalizeImageUrl(pageUrl, match[1]);
    if (url) results.push({ url, source: "script:tiktok-cdn" });
  }

  return toScoredImages(results);
}

async function getPlaywright() {
  if (!playwrightPromise) {
    playwrightPromise = import("playwright");
  }
  return playwrightPromise;
}

async function collectImagesFromExistingPage(page) {
  await dismissCommonDialogs(page);
  await sleep(900);
  await page.mouse.wheel(0, 900);
  await sleep(300);
  await page.mouse.wheel(0, -350);
  await sleep(500);

  const domData = await page.evaluate(() => {
    const items = [];
    const push = (url, source) => {
      if (!url || typeof url !== "string") return;
      items.push({ url, source });
    };

    document.querySelectorAll("img").forEach((img) => {
      const rect = img.getBoundingClientRect();
      const visible = rect.width > 24 && rect.height > 24 && rect.bottom > 0 && rect.right > 0;
      const large = rect.width >= 180 && rect.height >= 180;
      const source = large
        ? "browser-dom:visible-large-img"
        : visible
          ? "browser-dom:visible-img"
          : "browser-dom:img";
      push(img.currentSrc || img.src, source);
      if (img.srcset) {
        img.srcset.split(",").forEach((part) =>
          push(part.trim().split(/\s+/)[0], large ? "browser-dom:visible-large-srcset" : "browser-dom:img-srcset")
        );
      }
    });

    document.querySelectorAll("source").forEach((sourceEl) => {
      if (sourceEl.srcset) {
        sourceEl.srcset.split(",").forEach((part) => push(part.trim().split(/\s+/)[0], "browser-dom:source-srcset"));
      }
    });

    document.querySelectorAll("video[poster]").forEach((video) => {
      push(video.getAttribute("poster"), "browser-dom:poster");
    });

    document.querySelectorAll("*").forEach((node) => {
      const rect = node.getBoundingClientRect();
      const large = rect.width >= 180 && rect.height >= 180;
      const style = window.getComputedStyle(node);
      const bg = style.backgroundImage || "";
      if (bg.includes("url(")) {
        const matches = [...bg.matchAll(/url\(([^)]+)\)/g)];
        matches.forEach((match) =>
          push(match[1].replace(/^["']|["']$/g, ""), large ? "browser-dom:background-large" : "browser-dom:background")
        );
      }
    });

    return {
      images: items,
      title: document.title || "",
      bodyText: (document.body?.innerText || "").slice(0, 600),
    };
  });

  const html = await page.content();
  const scriptImages = extractTikTokImagesFromScripts(html, page.url());
  const domImages = (domData.images || [])
    .map((item) => ({
      url: normalizeImageUrl(page.url(), item.url),
      source: item.source,
    }))
    .filter((item) => item.url);

  const visibleDomImages = domImages.filter((item) =>
    String(item.source || "").toLowerCase().includes("visible")
  );

  return {
    images: toScoredImages([...(visibleDomImages.length ? visibleDomImages : domImages), ...scriptImages]),
    title: domData.title,
    bodyText: domData.bodyText,
    pageUrl: page.url(),
  };
}

async function dismissCommonDialogs(page) {
  const texts = [
    "Accept all",
    "Accept",
    "I agree",
    "同意",
    "接受",
    "仅允许必要",
    "Only allow essential",
    "Continue as guest",
  ];
  for (const text of texts) {
    try {
      await page.getByRole("button", { name: text, exact: false }).click({ timeout: 1200 });
      await sleep(300);
    } catch {}
  }
}

async function extractImagesWithBrowser(targetUrl, options = {}) {
  const {
    allowMedia = false,
    extraWaitMs = 0,
    postScrollWaitMs = 500,
    waitForNetworkIdle = true,
  } = options;
  const { chromium } = await getPlaywright();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  const networkImages = [];

  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "font" || (!allowMedia && type === "media")) {
      route.abort();
      return;
    }
    route.continue();
  });

  page.on("response", async (response) => {
    try {
      const url = response.url();
      const contentType = response.headers()["content-type"] || "";
      if (
        response.ok() &&
        (contentType.includes("image/") || /\.(png|jpg|jpeg|webp|avif)(\?|$)/i.test(url))
      ) {
        networkImages.push({ url, source: "browser-network" });
      }
    } catch {}
  });

  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (waitForNetworkIdle) {
      await page.waitForLoadState("networkidle", { timeout: 3500 }).catch(() => {});
    }
    await dismissCommonDialogs(page);
    await page.waitForSelector("img, video[poster], [style*='background-image']", { timeout: 2500 }).catch(() => {});
    await sleep(900);
    await page.mouse.wheel(0, 900);
    await sleep(300);
    await page.mouse.wheel(0, -350);
    await sleep(postScrollWaitMs + extraWaitMs);

    const domData = await page.evaluate(() => {
      const items = [];
      const push = (url, source) => {
        if (!url || typeof url !== "string") return;
        items.push({ url, source });
      };

      document.querySelectorAll("img").forEach((img) => {
        const rect = img.getBoundingClientRect();
        const visible = rect.width > 24 && rect.height > 24 && rect.bottom > 0 && rect.right > 0;
        const large = rect.width >= 180 && rect.height >= 180;
        const source = large
          ? "browser-dom:visible-large-img"
          : visible
            ? "browser-dom:visible-img"
            : "browser-dom:img";
        push(img.currentSrc || img.src, source);
        if (img.srcset) {
          img.srcset.split(",").forEach((part) =>
            push(part.trim().split(/\s+/)[0], large ? "browser-dom:visible-large-srcset" : "browser-dom:img-srcset")
          );
        }
      });

      document.querySelectorAll("source").forEach((sourceEl) => {
        if (sourceEl.srcset) {
          sourceEl.srcset
            .split(",")
            .forEach((part) => push(part.trim().split(/\s+/)[0], "browser-dom:source-srcset"));
        }
      });

      document.querySelectorAll("video[poster]").forEach((video) => {
        push(video.getAttribute("poster"), "browser-dom:poster");
      });

      document.querySelectorAll("*").forEach((node) => {
        const rect = node.getBoundingClientRect();
        const large = rect.width >= 180 && rect.height >= 180;
        const style = window.getComputedStyle(node);
        const bg = style.backgroundImage || "";
        if (bg.includes("url(")) {
          const matches = [...bg.matchAll(/url\(([^)]+)\)/g)];
          matches.forEach((match) =>
            push(match[1].replace(/^["']|["']$/g, ""), large ? "browser-dom:background-large" : "browser-dom:background")
          );
        }
      });

      return {
        images: items,
        title: document.title || "",
        bodyText: (document.body?.innerText || "").slice(0, 600),
      };
    });

    const html = await page.content();
    const scriptImages = extractTikTokImagesFromScripts(html, page.url());
    const domImages = (domData.images || [])
      .map((item) => ({
        url: normalizeImageUrl(page.url(), item.url),
        source: item.source,
      }))
      .filter((item) => item.url);

    const visibleDomImages = domImages.filter((item) =>
      String(item.source || "").toLowerCase().includes("visible")
    );

    const networkFallback = networkImages.filter((item) => {
      const value = String(item.url || "").toLowerCase();
      return value.includes("photomode") || value.includes("tplv-photomode-image");
    });

    const combined = toScoredImages([
      ...(visibleDomImages.length ? visibleDomImages : domImages),
      ...scriptImages,
      ...(!visibleDomImages.length && !scriptImages.length ? networkFallback : []),
    ]);

    return {
      images: combined,
      title: domData.title,
      bodyText: domData.bodyText,
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function fetchHtml(targetUrl, headers = getDesktopHeaders()) {
  const response = await fetch(targetUrl, {
    headers,
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`抓取页面失败：${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) {
    throw new Error("目标链接不是标准 HTML 页面");
  }

  const html = await response.text();
  return {
    html,
    finalUrl: response.url || targetUrl,
  };
}

async function fetchHtmlWithFallbacks(targetUrl, hostname) {
  const attempts = [];
  const profiles = isTikTokHost(hostname)
    ? [
        { name: "static-desktop", headers: getDesktopHeaders() },
        { name: "static-mobile", headers: getMobileHeaders() },
      ]
    : [{ name: "static", headers: getDesktopHeaders() }];

  let lastError = null;
  for (const profile of profiles) {
    try {
      const result = await fetchHtml(targetUrl, profile.headers);
      return {
        ...result,
        method: profile.name,
        attempts,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      attempts.push(`${profile.name}:${detail}`);
      lastError = error;
    }
  }
  throw new Error(attempts.join("；") || (lastError instanceof Error ? lastError.message : "抓取页面失败"));
}

function buildFailureHint(parsed, baseHint, browserDetail, browserBodyText) {
  let hint = baseHint;
  if (browserBodyText && /can't watch|unable to watch|not available|目前无法观看|不可用/i.test(browserBodyText)) {
    hint += " 当前环境里，TikTok 页面本身返回了“无法观看/不可用”之类的限制提示，这通常是地区或权限限制，不是程序没抓到 DOM。";
  }
  if (browserDetail) {
    hint += ` 浏览器渲染阶段反馈：${browserDetail}`;
  }
  if (isTikTokHost(parsed.hostname)) {
    hint += " 你仍然可以继续尝试别的 TikTok 帖子链接，程序会自动走动态提图链路。";
  }
  return hint;
}

async function handleExtract(reqUrl, res) {
  const target = reqUrl.searchParams.get("url");
  if (!target) {
    sendJson(res, 400, { error: "缺少 url 参数" });
    return;
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    sendJson(res, 400, { error: "链接格式不正确" });
    return;
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    sendJson(res, 400, { error: "仅支持 http 或 https 链接" });
    return;
  }

  const cacheKey = parsed.toString();
  const cached = getCachedExtract(cacheKey);
  if (cached) {
    sendJson(res, 200, { ...cached, cached: true });
    return;
  }

  const hostHint = getHostHint(parsed.hostname);
  let finalUrl = parsed.toString();
  let htmlImages = [];
  let scriptImages = [];
  let browserImages = [];
  let browserBodyText = "";
  let browserError = "";
  const methods = [];

  try {
    const { html, finalUrl: fetchedFinalUrl, method } = await fetchHtmlWithFallbacks(parsed.toString(), parsed.hostname);
    finalUrl = fetchedFinalUrl;
    htmlImages = extractImagesFromHtml(html, finalUrl);
    if (htmlImages.length) methods.push(method || "static");

    if (isTikTokHost(parsed.hostname)) {
      scriptImages = extractTikTokImagesFromScripts(html, finalUrl);
      if (scriptImages.length) methods.push("script");
    }
  } catch (error) {
    browserError = error instanceof Error ? error.message : String(error);
  }

  const shouldUseBrowser =
    (isTikTokHost(parsed.hostname) && htmlImages.length + scriptImages.length < 4) ||
    (!htmlImages.length && !scriptImages.length);

  if (shouldUseBrowser) {
    try {
      let browserResult = await extractImagesWithBrowser(parsed.toString(), {
        allowMedia: false,
        extraWaitMs: isTikTokHost(parsed.hostname) ? 1200 : 0,
        postScrollWaitMs: isTikTokHost(parsed.hostname) ? 900 : 500,
      });

      if (isTikTokHost(parsed.hostname) && (!browserResult.images || browserResult.images.length < 2)) {
        await sleep(700);
        browserResult = await extractImagesWithBrowser(parsed.toString(), {
          allowMedia: true,
          extraWaitMs: 2200,
          postScrollWaitMs: 1300,
          waitForNetworkIdle: false,
        });
        methods.push("browser-retry");
      }

      browserImages = browserResult.images;
      browserBodyText = browserResult.bodyText || "";
      if (browserImages.length) methods.push("browser");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      browserError = browserError ? `${browserError}；${detail}` : detail;
    }
  }

  const mergedImages = [...htmlImages, ...scriptImages, ...browserImages];
  const images = isTikTokHost(parsed.hostname)
    ? filterTikTokImages(mergedImages)
    : toScoredImages(mergedImages);
  if (!images.length) {
    sendJson(res, 422, {
      error: "没有提取到可用图片",
      hint: buildFailureHint(parsed, hostHint, browserError, browserBodyText),
      methodsTried: methods.length ? methods : ["static", "script", "browser"],
    });
    return;
  }

  const payload = {
    pageUrl: finalUrl,
    count: images.length,
    images,
    hint: isTikTokHost(parsed.hostname)
      ? shouldUseBrowser
        ? "已启用 TikTok 增强提图：优先静态解析，必要时再走浏览器渲染。"
        : "已启用 TikTok 快速提图：本次静态解析已足够，已跳过浏览器渲染。"
      : hostHint,
    methodsUsed: methods,
  };
  setCachedExtract(cacheKey, payload);
  sendJson(res, 200, payload);
}

async function handleProxyImage(reqUrl, res) {
  const target = reqUrl.searchParams.get("url");
  if (!target) {
    res.writeHead(400, {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.end("缺少 url 参数");
    return;
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    res.writeHead(400, {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.end("链接格式不正确");
    return;
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    res.writeHead(400, {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.end("仅支持 http 或 https 链接");
    return;
  }

  const referer = isTikTokHost(parsed.hostname) ||
    /(tiktokcdn|byteimg|muscdn|ibytedtos|ibyteimg)/i.test(parsed.hostname)
    ? "https://www.tiktok.com/"
    : `${parsed.protocol}//${parsed.host}/`;

  try {
    const response = await fetch(parsed.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        Referer: referer,
        Origin: referer.replace(/\/$/, ""),
      },
      redirect: "follow",
    });

    if (!response.ok) {
      res.writeHead(502, {
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(`图片加载失败：${response.status}`);
      return;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(buffer);
  } catch (error) {
    res.writeHead(500, {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(error instanceof Error ? error.message : String(error));
  }
}

async function closeAssistSession(sessionId) {
  const session = assistSessions.get(sessionId);
  if (!session) return;
  assistSessions.delete(sessionId);
  await session.context?.close().catch(() => {});
  await session.browser?.close().catch(() => {});
}

async function handleAssistStart(reqUrl, res) {
  if (!ASSISTED_EXTRACT_ENABLED) {
    sendJson(res, 501, {
      error: "当前线上部署环境暂不支持辅助提图",
      hint: "辅助提图需要打开本地可见浏览器窗口，云端服务器没有桌面界面。你可以继续使用普通提图，或在本地运行项目时使用辅助提图。",
    });
    return;
  }

  const target = reqUrl.searchParams.get("url");
  if (!target) {
    sendJson(res, 400, { error: "缺少 url 参数" });
    return;
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    sendJson(res, 400, { error: "链接格式不正确" });
    return;
  }

  const { chromium } = await getPlaywright();
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  await page.goto(parsed.toString(), { waitUntil: "domcontentloaded", timeout: 45000 });
  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  assistSessions.set(sessionId, {
    browser,
    context,
    page,
    createdAt: Date.now(),
    targetUrl: parsed.toString(),
  });
  sendJson(res, 200, { ok: true, sessionId });
}

async function handleAssistFinish(reqUrl, res) {
  const sessionId = reqUrl.searchParams.get("sessionId");
  if (!sessionId || !assistSessions.has(sessionId)) {
    sendJson(res, 404, { error: "辅助会话不存在或已失效" });
    return;
  }
  const session = assistSessions.get(sessionId);
  try {
    const result = await collectImagesFromExistingPage(session.page);
    const images = isTikTokHost(new URL(result.pageUrl).hostname)
      ? filterTikTokImages(result.images)
      : toScoredImages(result.images);
    if (!images.length) {
      sendJson(res, 422, {
        error: "没有识别到可用图片",
        hint: "请先在打开的浏览器窗口里完成登录、验证，确认页面上的图片已经真正显示出来，再回来点继续识别。",
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      pageUrl: result.pageUrl,
      images,
      hint: "已通过辅助浏览器识别当前页面图片",
    });
  } catch (error) {
    sendJson(res, 422, {
      error: "辅助识别失败",
      hint:
        "辅助浏览器窗口可能已经被关闭，或者页面还没真正加载出图片。请重新点一次“辅助提图”，在打开的窗口里确认图片可见后，再点“继续识别”。",
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await closeAssistSession(sessionId);
  }
}

async function handleAssistCancel(reqUrl, res) {
  const sessionId = reqUrl.searchParams.get("sessionId");
  if (sessionId) {
    await closeAssistSession(sessionId);
  }
  sendJson(res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (reqUrl.pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (reqUrl.pathname.startsWith("/api/")) {
    try {
      await proxyToSampler(req, res, reqUrl);
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (reqUrl.pathname === "/extract") {
    await handleExtract(reqUrl, res);
    return;
  }

  if (reqUrl.pathname === "/extract-assisted/start") {
    await handleAssistStart(reqUrl, res);
    return;
  }

  if (reqUrl.pathname === "/extract-assisted/finish") {
    await handleAssistFinish(reqUrl, res);
    return;
  }

  if (reqUrl.pathname === "/extract-assisted/cancel") {
    await handleAssistCancel(reqUrl, res);
    return;
  }

  if (reqUrl.pathname === "/proxy-image") {
    await handleProxyImage(reqUrl, res);
    return;
  }

  const safePath = reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname;
  const filePath = path.join(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  sendFile(res, filePath);
});

server.listen(PORT, () => {
  console.log(`Image collage web app running at http://localhost:${PORT}`);
});

function shutdownSampler() {
  if (samplerProcess && !samplerProcess.killed) {
    samplerProcess.kill("SIGTERM");
  }
}

process.on("exit", shutdownSampler);
process.on("SIGINT", () => {
  shutdownSampler();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdownSampler();
  process.exit(0);
});
