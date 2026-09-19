import puppeteer from "@cloudflare/puppeteer";

const IMDB_URL = "https://www.imdb.com/";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function htmlResponse(html, status = 200, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function buildCookieString(cookies = []) {
  const map = new Map();
  for (const c of cookies) {
    if (c && c.name && c.value !== undefined && !map.has(c.name)) {
      map.set(c.name, c.value);
    }
  }
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function formatCookiePayload(cookies = [], requestHeaders = {}, userAgent = DEFAULT_USER_AGENT) {
  return {
    scrapedAt: new Date().toISOString(),
    timestamp: Date.now(),
    userAgent,
    requestHeaders,
    count: cookies.length,
    cookieString: buildCookieString(cookies),
    cookies: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    })),
  };
}

async function applyStealthToPage(page) {
  await page.setUserAgent(DEFAULT_USER_AGENT);
  await page.setViewport({ width: 1280, height: 800 });
}

async function acquireBrowser(env) {
  if (!env.MYBROWSER) {
    throw new Error("Browser binding 'MYBROWSER' is not configured in wrangler.toml.");
  }

  try {
    const sessions = await puppeteer.sessions(env.MYBROWSER);
    if (Array.isArray(sessions) && sessions.length > 0) {
      for (const s of sessions) {
        try {
          return await puppeteer.connect(env.MYBROWSER, s.sessionId);
        } catch {}
      }
    }
  } catch {}

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await puppeteer.launch(env.MYBROWSER);
    } catch (err) {
      if (err.message?.includes("429") || err.message?.includes("quota") || err.message?.includes("Rate limit")) {
        throw new Error(
          "Cloudflare Browser Rendering daily quota exceeded (429). Standard requests continue to work using Suggestions API or manually injected cookies."
        );
      }
      if (attempt < 3) {
        await new Promise((res) => setTimeout(res, 2000 * attempt));
        continue;
      }
      throw err;
    }
  }
}

async function getAllCookies(page) {
  const cookieMap = new Map();

  try {
    const pageCookies = await page.cookies();
    if (Array.isArray(pageCookies)) {
      for (const c of pageCookies) {
        if (c && c.name) cookieMap.set(c.name, c);
      }
    }
  } catch {}

  try {
    const imdbCookies = await page.cookies("https://www.imdb.com/", "https://imdb.com/");
    if (Array.isArray(imdbCookies)) {
      for (const c of imdbCookies) {
        if (c && c.name && !cookieMap.has(c.name)) cookieMap.set(c.name, c);
      }
    }
  } catch {}

  try {
    const client = await page.target().createCDPSession();
    const { cookies } = await client.send("Network.getAllCookies");
    if (Array.isArray(cookies)) {
      for (const c of cookies) {
        if (c && c.name && !cookieMap.has(c.name)) cookieMap.set(c.name, c);
      }
    }
    await client.detach().catch(() => {});
  } catch {}

  return Array.from(cookieMap.values());
}

async function waitForCookies(page, maxWaitMs = 12000) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const cookies = await getAllCookies(page);
    const hasSessionCookies = cookies.some(
      (c) => c.name === "session-id" || c.name === "ubid-main"
    );
    if (hasSessionCookies && cookies.length >= 2) {
      return cookies;
    }
    const hasWafToken = cookies.some((c) => c.name === "aws-waf-token");
    if (hasWafToken) {
      await new Promise((r) => setTimeout(r, 800));
      const postWafCookies = await getAllCookies(page);
      if (
        postWafCookies.some((c) => c.name === "session-id" || c.name === "ubid-main") ||
        postWafCookies.length >= 2
      ) {
        return postWafCookies;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return await getAllCookies(page);
}

async function scrapeImdbCookies(env) {
  const browserStartTime = performance.now();
  const browser = await acquireBrowser(env);
  let browserNavigationMs = 0;

  try {
    const page = await browser.newPage();
    let capturedHeaders = {};
    let finalStatusCode = 200;

    page.on("request", (req) => {
      const url = req.url();
      if (
        (req.isNavigationRequest && req.isNavigationRequest()) ||
        url.startsWith(IMDB_URL) ||
        url.includes("imdb.com")
      ) {
        if (Object.keys(capturedHeaders).length === 0) {
          capturedHeaders = req.headers();
        }
      }
    });

    page.on("response", (res) => {
      const url = res.url();
      if (
        (url.startsWith(IMDB_URL) || url === "https://www.imdb.com" || url === "https://imdb.com/") &&
        res.request().resourceType() === "document"
      ) {
        finalStatusCode = res.status();
      }
    });

    await applyStealthToPage(page);

    await page.goto(IMDB_URL, {
      waitUntil: "networkidle2",
      timeout: 25000,
    }).catch(() => {});

    await new Promise((resolve) => setTimeout(resolve, 2000));

    try {
      await page.mouse.move(120, 180);
      await page.evaluate(() => window.scrollBy(0, 150));
    } catch {}

    const cookies = await waitForCookies(page, 12000);

    const resolvedUserAgent =
      capturedHeaders["user-agent"] ||
      (await page.evaluate(() => navigator.userAgent).catch(() => DEFAULT_USER_AGENT));
    const pageTitle = await page.title().catch(() => "");
    const currentUrl = page.url();

    browserNavigationMs = Math.round(performance.now() - browserStartTime);

    if (!capturedHeaders["user-agent"]) {
      capturedHeaders["user-agent"] = resolvedUserAgent;
    }

    const payload = formatCookiePayload(cookies, capturedHeaders, resolvedUserAgent);
    const html = await page.content().catch(() => "");
    payload.pageDetails = {
      title: pageTitle,
      url: currentUrl,
      status: finalStatusCode,
      navigationTimeMs: browserNavigationMs,
      htmlSnippet: html.slice(0, 800),
    };

    return payload;
  } finally {
    await browser.close().catch(() => {});
  }
}

function getKV(env) {
  return env.COOKIE_KV || env.IMDB_COOKIE_KV || null;
}

async function saveCookiesToKV(env, payload) {
  const kv = getKV(env);
  if (!kv) {
    return {
      saved: false,
      reason: "KV binding ('COOKIE_KV' / 'IMDB_COOKIE_KV') is not configured in env.",
    };
  }

  if (payload.count === 0 || payload.pageDetails?.status === 403) {
    return {
      saved: false,
      reason: "Scrape resulted in 0 cookies or 403 Forbidden. Preserving existing KV cookies.",
    };
  }

  await kv.put("imdb_cookies", JSON.stringify(payload));
  await kv.put("imdb_cookie_string", payload.cookieString);
  await kv.put("imdb_request_headers", JSON.stringify(payload.requestHeaders));
  await kv.put("imdb_cookies_last_updated", String(payload.timestamp));

  return { saved: true };
}

async function getCookiesFromKV(env) {
  const kv = getKV(env);
  if (!kv) {
    return null;
  }

  const raw = await kv.get("imdb_cookies");
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function handleRefresh(env) {
  const requestStartTime = performance.now();
  try {
    const payload = await scrapeImdbCookies(env);
    const totalRequestMs = Math.round(performance.now() - requestStartTime);
    const browserBilledMs = payload.pageDetails?.navigationTimeMs ? totalRequestMs - 50 : totalRequestMs;

    payload.billingAndTiming = {
      browserBilledDurationMs: browserBilledMs,
      browserBilledSeconds: Number((browserBilledMs / 1000).toFixed(3)),
      browserBilledMinutes: Number((browserBilledMs / 60000).toFixed(4)),
      totalWorkerRequestMs: totalRequestMs,
      totalWorkerRequestSeconds: Number((totalRequestMs / 1000).toFixed(3)),
      billingInfo: {
        billedResource: "Cloudflare Workers Browser Rendering (Browser Time)",
        billedMetric: "Active browser session duration (from launch to close)",
        workerExecutionMetric: "Worker request wall-clock time",
      },
    };

    const kvStatus = await saveCookiesToKV(env, payload);

    return jsonResponse({
      success: true,
      message: "IMDb cookies scraped and saved successfully via browser.",
      timing: payload.billingAndTiming,
      kvStatus,
      data: payload,
    });
  } catch (err) {
    return jsonResponse(
      {
        success: false,
        error: err.message,
        suggestion:
          "If daily browser quota is exhausted, you can manually upload cookies via POST /cookies or visit /cookies UI.",
      },
      err.message?.includes("quota") || err.message?.includes("429") ? 429 : 500
    );
  }
}

function normalizeTargetUrl(inputUrl) {
  if (!inputUrl) return null;
  const trimmed = inputUrl.trim();
  if (trimmed.startsWith("tt")) {
    return `https://www.imdb.com/title/${trimmed}/`;
  }
  if (trimmed.startsWith("/title/")) {
    return `https://www.imdb.com${trimmed}`;
  }
  if (trimmed.startsWith("title/")) {
    return `https://www.imdb.com/${trimmed}`;
  }
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

function extractTconst(targetUrl) {
  const match = targetUrl.match(/tt\d{6,10}/);
  return match ? match[0] : null;
}

function extractNextData(html) {
  if (!html) return null;
  const match =
    html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">([\s\S]*?)<\/script>/i) ||
    html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);

  if (match && match[1]) {
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }
  return null;
}

function cleanGraphQL(val) {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) return val.map(cleanGraphQL);
  if (typeof val === "object") {
    if (Array.isArray(val.edges)) {
      const flattened = val.edges.map((e) => cleanGraphQL(e?.node !== undefined ? e.node : e));
      if (flattened.every((item) => typeof item === "string")) {
        return flattened;
      }
      if (
        flattened.every(
          (item) => typeof item === "object" && item && Object.keys(item).length === 1 && "text" in item
        )
      ) {
        return flattened.map((item) => item.text);
      }
      return flattened;
    }

    if (typeof val.plainText === "string" && Object.keys(val).filter((k) => k !== "__typename").length === 1) {
      return val.plainText;
    }

    if (
      typeof val.text === "string" &&
      Object.keys(val).filter((k) => k !== "__typename").length === 1 &&
      !("id" in val) &&
      !("year" in val)
    ) {
      return val.text;
    }

    const cleaned = {};
    for (const [key, value] of Object.entries(val)) {
      if (key === "__typename") continue;
      cleaned[key] = cleanGraphQL(value);
    }
    return cleaned;
  }
  return val;
}

function formatCredits(principalCreditsV2 = []) {
  const result = {};
  for (const group of principalCreditsV2) {
    const groupName = (group.grouping?.text || "other").toLowerCase().replace(/[^a-z0-9]/g, "_");
    result[groupName] = (group.credits || [])
      .map((c) => ({
        id: c.name?.id || null,
        name: c.name?.nameText?.text || null,
      }))
      .filter((c) => c.name);
  }
  return result;
}

function formatCast(castV2 = []) {
  const list = [];
  for (const castGroup of castV2) {
    for (const c of castGroup.credits || []) {
      if (c.name?.nameText?.text) {
        list.push({
          id: c.name?.id || null,
          name: c.name?.nameText?.text,
          characters: (c.characters || []).map((ch) => ch.name || ch).filter(Boolean),
        });
      }
    }
  }
  return list;
}

function formatRuntime(seconds) {
  if (!seconds || typeof seconds !== "number") return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatImdbApiResponse(nextData, targetUrl) {
  const atf = nextData.props?.pageProps?.aboveTheFoldData;
  const pageProps = nextData.props?.pageProps;

  if (atf) {
    const genres = (atf.genres?.genres || atf.titleGenres?.genres || [])
      .map((g) => g.text || g.id || g.genre?.text)
      .filter(Boolean);

    const keywords = (atf.keywords?.edges || [])
      .map((e) => (typeof e?.node?.text === "string" ? e.node.text : e?.node || e?.text))
      .filter(Boolean);

    return {
      success: true,
      id: atf.id || pageProps?.tconst || null,
      title: atf.titleText?.text || atf.originalTitleText?.text || null,
      originalTitle: atf.originalTitleText?.text || atf.titleText?.text || null,
      type: atf.titleType?.id || atf.titleType?.text || null,
      isSeries: Boolean(atf.titleType?.isSeries),
      year: atf.releaseYear?.year || null,
      endYear: atf.releaseYear?.endYear || null,
      releaseDate: atf.releaseDate
        ? `${atf.releaseDate.year}-${String(atf.releaseDate.month || 1).padStart(2, "0")}-${String(
            atf.releaseDate.day || 1
          ).padStart(2, "0")}`
        : null,
      runtime: formatRuntime(atf.runtime?.seconds),
      runtimeSeconds: atf.runtime?.seconds || null,
      rating: atf.ratingsSummary?.aggregateRating || null,
      voteCount: atf.ratingsSummary?.voteCount || null,
      metascore: atf.metacritic?.metascore?.score || null,
      certificate: atf.certificate?.rating || null,
      genres,
      keywords,
      plot: atf.plot?.plotText?.plainText || null,
      poster: atf.primaryImage
        ? {
            id: atf.primaryImage.id,
            url: atf.primaryImage.url,
            width: atf.primaryImage.width,
            height: atf.primaryImage.height,
            caption: atf.primaryImage.caption?.plainText || null,
          }
        : null,
      credits: formatCredits(atf.principalCreditsV2),
      cast: formatCast(atf.castV2).slice(0, 30),
      raw: cleanGraphQL(pageProps || {}),
    };
  }

  return {
    success: true,
    targetUrl,
    page: nextData.page,
    query: nextData.query,
    data: cleanGraphQL(pageProps || nextData.props || nextData),
  };
}

const CACHE_REVALIDATE_AFTER_MS = 1 * 24 * 60 * 60 * 1000; // 1 day (24 hours)
const KV_CACHE_EXPIRATION_SECONDS = 7 * 24 * 60 * 60; // 7 days
const activeRevalidations = new Set();

function getPageCacheKey(targetUrl, format) {
  return `imdb_page:${format}:${targetUrl}`;
}

async function getCachedPage(env, targetUrl, format) {
  const kv = getKV(env);
  if (!kv) return null;
  const key = getPageCacheKey(targetUrl, format);
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveCachedPage(env, targetUrl, format, data, isJson = true) {
  const kv = getKV(env);
  if (!kv || !data) return;

  // Strictly forbid caching 403 Forbidden, Human Verification, suggestion, or incomplete/error data
  if (
    typeof data === "string" &&
    (data.includes("403 Forbidden") ||
      data.includes("<title>403") ||
      data.includes("Human Verification") ||
      data.includes("AwsWafIntegration"))
  ) {
    return;
  }
  if (
    typeof data === "object" &&
    (data.success === false ||
      data.source === "imdb_suggestion_api" ||
      !data.title ||
      data.html?.includes("403 Forbidden") ||
      data.html?.includes("Human Verification") ||
      (data.warning && !data.id && !data.title))
  ) {
    return;
  }

  const key = getPageCacheKey(targetUrl, format);
  const entry = {
    timestamp: Date.now(),
    targetUrl,
    format,
    isJson,
    data,
  };
  await kv.put(key, JSON.stringify(entry), {
    expirationTtl: KV_CACHE_EXPIRATION_SECONDS,
  });
}

function buildCachedResponse(data, isJson, extraHeaders = {}) {
  if (isJson) {
    return new Response(typeof data === "string" ? data : JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...CORS_HEADERS,
        ...extraHeaders,
      },
    });
  }
  return new Response(data, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

async function scrapePageWithBrowser(targetUrl, env, format = "json") {
  const browser = await acquireBrowser(env);
  try {
    const page = await browser.newPage();
    let capturedHeaders = {};

    // Block images, fonts, stylesheets, and media to make browser scrape 10x faster & save quota
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      const url = req.url();
      if (type === "image" || type === "font" || type === "stylesheet" || type === "media") {
        req.abort();
      } else {
        if (url.includes("imdb.com") && Object.keys(capturedHeaders).length === 0) {
          capturedHeaders = req.headers();
        }
        req.continue();
      }
    });

    await applyStealthToPage(page);

    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    }).catch(() => {});

    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Capture fresh cookies acquired during page load and save to KV
    const pageCookies = await getAllCookies(page);
    if (pageCookies.length >= 2) {
      const resolvedUserAgent = capturedHeaders["user-agent"] || DEFAULT_USER_AGENT;
      const cookiePayload = formatCookiePayload(pageCookies, capturedHeaders, resolvedUserAgent);
      cookiePayload.pageDetails = {
        title: await page.title().catch(() => ""),
        url: page.url(),
        status: 200,
      };
      await saveCookiesToKV(env, cookiePayload).catch(() => {});
    }

    if (format === "html") {
      const html = await page.content();
      return {
        success: true,
        isJson: false,
        data: html,
      };
    }

    const nextDataJsonString = await page.evaluate(() => {
      const el = document.getElementById("__NEXT_DATA__");
      return el ? el.textContent : null;
    }).catch(() => null);

    if (nextDataJsonString) {
      try {
        const parsed = JSON.parse(nextDataJsonString);
        if (format === "raw_json") {
          return {
            success: true,
            isJson: true,
            data: parsed,
          };
        }
        return {
          success: true,
          isJson: true,
          data: formatImdbApiResponse(parsed, targetUrl),
        };
      } catch {}
    }

    const html = await page.content();
    const nextData = extractNextData(html);
    if (nextData) {
      if (format === "raw_json") {
        return {
          success: true,
          isJson: true,
          data: nextData,
        };
      }
      return {
        success: true,
        isJson: true,
        data: formatImdbApiResponse(nextData, targetUrl),
      };
    }

    return {
      success: false,
      response: jsonResponse(
        {
          success: false,
          error: "Could not extract __NEXT_DATA__ from IMDb page.",
          targetUrl,
        },
        500
      ),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function fetchAndFormatPage(targetUrl, env, ctx, format = "json") {
  const cached = await getCookiesFromKV(env);

  // 1. Try fast HTTP fetch using KV cookies
  if (cached && cached.cookieString && cached.count > 0) {
    const reqHeaders = {
      "User-Agent": cached.userAgent || DEFAULT_USER_AGENT,
      Cookie: cached.cookieString,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": cached.requestHeaders?.["accept-language"] || "en-US,en;q=0.9",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
    };

    try {
      const response = await fetch(targetUrl, {
        method: "GET",
        headers: reqHeaders,
        redirect: "follow",
      });

      if (response.status === 200) {
        const responseText = await response.text();

        if (
          !responseText.includes("<title>403 Forbidden</title>") &&
          !responseText.includes("<h1>403 Forbidden</h1>") &&
          !responseText.includes("AwsWafIntegration") &&
          !responseText.includes("<title>Human Verification</title>")
        ) {
          if (format === "html") {
            return {
              success: true,
              isJson: false,
              data: responseText,
            };
          }

          const nextData = extractNextData(responseText);
          if (nextData) {
            if (format === "raw_json") {
              return {
                success: true,
                isJson: true,
                data: nextData,
              };
            }
            return {
              success: true,
              isJson: true,
              data: formatImdbApiResponse(nextData, targetUrl),
            };
          }
        }
      }
    } catch {}
  }

  // 2. HTTP fetch failed or cookies expired -> Launch browser to scrape full metadata & refresh KV cookies
  if (env.MYBROWSER) {
    try {
      const browserResult = await scrapePageWithBrowser(targetUrl, env, format);
      if (browserResult && browserResult.success) {
        return browserResult;
      }
    } catch (browserError) {
      console.warn("Browser scraping failed or quota reached:", browserError.message);
    }
  }

  return {
    success: false,
    response: jsonResponse(
      {
        success: false,
        error:
          "IMDb access restricted by AWS WAF and cookies need refresh. GitHub Actions is syncing cookies automatically, or you can run 'npm run sync:cookies' / paste at /cookies.",
        targetUrl,
      },
      503
    ),
  };
}

async function revalidatePageInBackground(targetUrl, env, ctx, format) {
  const key = getPageCacheKey(targetUrl, format);
  if (activeRevalidations.has(key)) return;
  activeRevalidations.add(key);

  try {
    const result = await fetchAndFormatPage(targetUrl, env, ctx, format, false);
    if (result && result.success && result.data) {
      await saveCachedPage(env, targetUrl, format, result.data, result.isJson);
    }
  } catch (err) {
    console.error(`Background revalidation failed for ${targetUrl}:`, err);
  } finally {
    activeRevalidations.delete(key);
  }
}

async function handleProxyRequest(rawTargetUrl, env, ctx, format = "json", allowBrowser = false) {
  const targetUrl = normalizeTargetUrl(rawTargetUrl);
  if (!targetUrl) {
    return jsonResponse({ error: "A valid 'url' parameter is required (e.g. ?url=tt2243973)." }, 400);
  }

  // 1. Check if we have a valid cached response in KV
  let cachedPage = await getCachedPage(env, targetUrl, format);

  if (
    cachedPage &&
    cachedPage.data &&
    (typeof cachedPage.data === "string"
      ? cachedPage.data.includes("403 Forbidden")
      : cachedPage.data?.html?.includes("403 Forbidden") ||
        cachedPage.data?.source === "imdb_suggestion_api" ||
        (cachedPage.data?.warning && !cachedPage.data?.id && !cachedPage.data?.title))
  ) {
    const kv = getKV(env);
    if (kv) {
      await kv.delete(getPageCacheKey(targetUrl, format)).catch(() => {});
    }
    cachedPage = null;
  }

  if (cachedPage && cachedPage.data) {
    const ageMs = Date.now() - (cachedPage.timestamp || 0);

    // If cache is older than 1 day, revalidate in background and return early with old cache
    if (ageMs > CACHE_REVALIDATE_AFTER_MS) {
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(revalidatePageInBackground(targetUrl, env, ctx, format));
      } else {
        revalidatePageInBackground(targetUrl, env, ctx, format);
      }

      return buildCachedResponse(cachedPage.data, cachedPage.isJson, {
        "X-Cache": "STALE-REVALIDATING",
        "X-Cache-Age-Seconds": String(Math.round(ageMs / 1000)),
      });
    }

    // Cache is fresh (< 1 day old) -> Return immediately
    return buildCachedResponse(cachedPage.data, cachedPage.isJson, {
      "X-Cache": "HIT",
      "X-Cache-Age-Seconds": String(Math.round(ageMs / 1000)),
    });
  }

  // 2. Cache miss -> Fetch and format page, cache result, and return
  const result = await fetchAndFormatPage(targetUrl, env, ctx, format);
  if (!result.success) {
    return (
      result.response ||
      jsonResponse({ success: false, error: "Failed to load page content", targetUrl }, 500)
    );
  }

  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(saveCachedPage(env, targetUrl, format, result.data, result.isJson));
  } else {
    await saveCachedPage(env, targetUrl, format, result.data, result.isJson);
  }

  return buildCachedResponse(result.data, result.isJson, {
    "X-Cache": "MISS",
  });
}

function renderCookieAdminHtml(existingData) {
  const hasCookies = existingData && existingData.count > 0;
  const cookieCount = existingData?.count || 0;
  const lastUpdated = existingData?.scrapedAt ? new Date(existingData.scrapedAt).toLocaleString() : "Never";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IMDb Worker Cookie Manager</title>
  <style>
    :root {
      --bg: #0d1117;
      --card: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --heading: #f0f6fc;
      --accent: #f5c518;
      --accent-hover: #e2b616;
      --success: #238636;
      --danger: #da3633;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 30px 15px;
      display: flex;
      justify-content: center;
    }
    .container {
      width: 100%;
      max-width: 680px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    }
    h1 {
      color: var(--accent);
      margin-top: 0;
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 24px;
    }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: bold;
      background: ${hasCookies ? "#23863633" : "#da363333"};
      color: ${hasCookies ? "#3fb950" : "#f85149"};
      border: 1px solid ${hasCookies ? "#238636" : "#da3633"};
    }
    .info-box {
      background: #0d1117;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
      margin: 16px 0;
      font-size: 14px;
    }
    label {
      display: block;
      margin-bottom: 8px;
      font-weight: 600;
      color: var(--heading);
    }
    textarea {
      width: 100%;
      height: 120px;
      box-sizing: border-box;
      background: #0d1117;
      border: 1px solid var(--border);
      border-radius: 6px;
      color: #fff;
      padding: 10px;
      font-family: monospace;
      font-size: 13px;
      resize: vertical;
    }
    textarea:focus {
      outline: none;
      border-color: var(--accent);
    }
    button {
      background: var(--accent);
      color: #000;
      border: none;
      font-weight: bold;
      padding: 10px 20px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      margin-top: 12px;
      transition: background 0.2s;
    }
    button:hover {
      background: var(--accent-hover);
    }
    .code-block {
      background: #0d1117;
      padding: 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      font-family: monospace;
      font-size: 12px;
      overflow-x: auto;
      margin: 8px 0;
      user-select: all;
    }
    #statusMessage {
      margin-top: 14px;
      padding: 10px;
      border-radius: 6px;
      display: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎬 IMDb Worker Cookie Hub</h1>
    <div style="margin-bottom: 15px;">
      Status: <span class="badge">${hasCookies ? "Active (" + cookieCount + " cookies)" : "No Cookies Saved"}</span>
      <span style="font-size: 13px; margin-left: 10px; color: #8b949e;">Last Updated: ${lastUpdated}</span>
    </div>

    <div class="info-box">
      <strong>💡 How to get IMDb Cookies in 5 seconds (Zero Browser Quota Burn):</strong>
      <ol style="margin: 8px 0 0 20px; padding: 0;">
        <li>Open <a href="https://www.imdb.com" target="_blank" style="color: var(--accent);">imdb.com</a> in your browser.</li>
        <li>Open Developer Tools (F12) &rarr; Console, paste and copy:</li>
      </ol>
      <div class="code-block">copy(document.cookie)</div>
      <p style="margin: 6px 0 0 0; font-size: 13px; color: #8b949e;">Note: The <code>aws-waf-token</code> cookie lasts for <strong>4 days</strong> once saved!</p>
    </div>

    <form id="cookieForm">
      <label for="cookieInput">Paste Cookie String Here:</label>
      <textarea id="cookieInput" placeholder="session-id=...; aws-waf-token=...; ubid-main=..."></textarea>
      <button type="submit">💾 Save Cookies to KV</button>
    </form>

    <div id="statusMessage"></div>

    <hr style="border: 0; border-top: 1px solid var(--border); margin: 24px 0;">

    <div style="font-size: 14px;">
      <strong>🚀 Test Proxy Endpoint:</strong>
      <div class="code-block">curl "https://meta.1proxy.workers.dev/?url=tt2243973"</div>
    </div>
  </div>

  <script>
    document.getElementById("cookieForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const val = document.getElementById("cookieInput").value.trim();
      const msg = document.getElementById("statusMessage");
      if (!val) {
        msg.style.display = "block";
        msg.style.background = "#da363333";
        msg.style.color = "#f85149";
        msg.innerText = "Please paste a cookie string first.";
        return;
      }

      msg.style.display = "block";
      msg.style.background = "#0d1117";
      msg.style.color = "#c9d1d9";
      msg.innerText = "Saving cookies to Cloudflare KV...";

      try {
        const resp = await fetch("/cookies", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cookieString: val })
        });
        const res = await resp.json();
        if (resp.ok && res.success) {
          msg.style.background = "#23863633";
          msg.style.color = "#3fb950";
          msg.innerText = "✅ Successfully saved " + res.data.count + " cookies to KV! Valid for 4 days.";
          setTimeout(() => location.reload(), 1500);
        } else {
          msg.style.background = "#da363333";
          msg.style.color = "#f85149";
          msg.innerText = "❌ Error: " + (res.error || "Failed to save");
        }
      } catch (err) {
        msg.style.background = "#da363333";
        msg.style.color = "#f85149";
        msg.innerText = "❌ Network error: " + err.message;
      }
    });
  </script>
</body>
</html>`;
}

async function handleGetCookies(request, env) {
  const cached = await getCookiesFromKV(env);
  const acceptHeader = request.headers.get("accept") || "";

  if (acceptHeader.includes("text/html")) {
    return htmlResponse(renderCookieAdminHtml(cached));
  }

  if (cached) {
    return jsonResponse({
      success: true,
      source: "kv_cache",
      data: cached,
    });
  }

  return jsonResponse(
    {
      success: false,
      source: "kv_cache",
      message: "No IMDb cookies found in KV. Visit /cookies in browser or send POST /cookies.",
    },
    404
  );
}

async function handleSaveCookies(request, env, parsedBody = null) {
  try {
    let body = parsedBody;
    if (!body) {
      try {
        body = await request.json();
      } catch {
        body = {};
      }
    }
    let cookieString = body.cookieString || body.cookies || "";
    let userAgent = body.userAgent || DEFAULT_USER_AGENT;

    if (Array.isArray(body.cookies)) {
      cookieString = buildCookieString(body.cookies);
    }

    if (!cookieString || typeof cookieString !== "string" || cookieString.trim() === "") {
      return jsonResponse(
        {
          success: false,
          error: "Invalid payload. Provide JSON with 'cookieString' (e.g. 'session-id=...; aws-waf-token=...').",
        },
        400
      );
    }

    const payload = {
      scrapedAt: new Date().toISOString(),
      timestamp: Date.now(),
      userAgent,
      requestHeaders: { "user-agent": userAgent, "accept-language": "en-US,en;q=0.9" },
      count: cookieString.split(";").filter((x) => x.trim()).length,
      cookieString: cookieString.trim(),
      cookies: [],
      source: "manual_upload",
    };

    const kvStatus = await saveCookiesToKV(env, payload);

    return jsonResponse({
      success: true,
      message: "IMDb cookies saved to KV successfully.",
      kvStatus,
      data: payload,
    });
  } catch (err) {
    return jsonResponse({ success: false, error: `Failed to save cookies: ${err.message}` }, 400);
  }
}

async function triggerGitHubSync(env) {
  const token = env.GH_TOKEN;
  const repo = env.GH_REPO || "fryingpanuu/Cf-Workers";
  if (!token) {
    console.warn("GH_TOKEN is not configured in worker environment.");
    return { success: false, error: "GH_TOKEN secret is not set." };
  }

  try {
    const resp = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/sync-cookies.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Cloudflare-Worker-IMDb",
        },
        body: JSON.stringify({ ref: "main" }),
      }
    );

    if (resp.status === 204 || resp.status === 200 || resp.status === 201) {
      return { success: true, message: "GitHub Actions cookie sync runner triggered successfully." };
    } else {
      const errorText = await resp.text();
      return { success: false, status: resp.status, error: errorText };
    }
  } catch (err) {
    console.error("Failed to trigger GitHub Actions sync:", err);
    return { success: false, error: err.message };
  }
}

async function handleRequest(request, env, ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  let bodyData = {};
  if (request.method === "POST" && request.headers.get("content-type")?.includes("application/json")) {
    try {
      bodyData = await request.json();
    } catch {}
  }

  const targetUrl = url.searchParams.get("url") || bodyData.url;
  const format = url.searchParams.get("format") || bodyData.format || "json";

  try {
    if (path === "/health") {
      return jsonResponse({
        status: "ok",
        browserBinding: Boolean(env.MYBROWSER),
        kvBinding: Boolean(getKV(env)),
        githubSyncConfigured: Boolean(env.GH_TOKEN),
      });
    }

    if (path === "/sync") {
      const syncResult = await triggerGitHubSync(env);
      return jsonResponse(syncResult, syncResult.success ? 200 : 500);
    }

    if (path === "/refresh" || (path === "/scrape" && (request.method === "POST" || request.method === "GET"))) {
      return await handleRefresh(env);
    }

    if (path === "/cookies") {
      if (request.method === "POST" || request.method === "PUT") {
        return await handleSaveCookies(request, env, bodyData);
      }
      return await handleGetCookies(request, env);
    }

    if (path === "/headers") {
      const cached = await getCookiesFromKV(env);
      if (cached) {
        return jsonResponse({
          success: true,
          userAgent: cached.userAgent,
          requestHeaders: cached.requestHeaders,
        });
      }
      return jsonResponse(
        { success: false, message: "No headers found in KV. Upload cookies at /cookies first." },
        404
      );
    }

    if (targetUrl) {
      return await handleProxyRequest(targetUrl, env, ctx, format);
    }

    if (path === "/") {
      return new Response(null, { status: 200, headers: CORS_HEADERS });
    }

    return jsonResponse(
      {
        error: "Not Found",
        availableRoutes: ["/", "/cookies", "/headers", "/sync", "/refresh", "/health"],
        proxyUsage: "GET /?url=https://www.imdb.com/title/tt2243973 or GET /?url=tt2243973",
      },
      404
    );
  } catch (error) {
    return jsonResponse(
      {
        success: false,
        error: error.message || "An unexpected error occurred",
        stack: error.stack,
      },
      500
    );
  }
}

export default {
  fetch: handleRequest,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(triggerGitHubSync(env));
  },
};
