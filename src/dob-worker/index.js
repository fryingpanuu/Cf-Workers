import crypto from "crypto";

const SECRET_B64 = "76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O";

const DEVICES = [
  { model: "23122PCD1I", brand: "POCO" },
  { model: "23078RKD5C", brand: "Redmi" },
  { model: "2201117TY", brand: "Redmi" },
];

const ANDROID = [
  { version: "16", build: "BP2A.250605.031.A3" },
  { version: "15", build: "AP3A.240905.015" },
  { version: "14", build: "UP1A.231105.003" },
];

const VC_LIST = [50020067, 50020068, 50020070];

function hex(n) {
  const chars = "0123456789abcdef";
  let r = "";
  for (let i = 0; i < n; i++) r += chars[Math.floor(Math.random() * 16)];
  return r;
}

function gaid() {
  return [8, 4, 4, 4, 12].map((n) => hex(n)).join("-");
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function signRequest({ method, url, contentType = "application/json; charset=utf-8", body = null, timestampMs = Date.now() }) {
  const u = new URL(url);
  const rawQuery = u.search.slice(1);
  const m = method.toUpperCase();

  const isGet = m === "GET";
  let signedPath = u.pathname;
  if (isGet && rawQuery) {
    const sorted = rawQuery
      .split("&")
      .map((p) => {
        const i = p.indexOf("=");
        const k = i < 0 ? p : p.slice(0, i);
        const v = i < 0 ? "" : p.slice(i + 1);
        return [decodeURIComponent(k), decodeURIComponent(v)];
      })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    signedPath += `?${sorted}`;
  }

  let bodyMd5 = "";
  let contentLength = "";
  if (body && body.length > 0) {
    bodyMd5 = crypto.createHash("md5").update(body, "utf8").digest("hex");
    contentLength = String(Buffer.byteLength(body, "utf8"));
  }

  const toSign = [
    m,
    "*/*", // accept (fetch/curl auto-add */* on the wire, we sign to match)
    body ? contentType : "",
    contentLength,
    String(timestampMs),
    bodyMd5,
    signedPath,
  ].join("\n");

  const key = Buffer.from(SECRET_B64, "base64");
  const sig = crypto.createHmac("md5", key).update(toSign, "utf8").digest("base64");
  return `${timestampMs}|2|${sig}`;
}

function generateClientInfo() {
  const device = pick(DEVICES);
  const av = pick(ANDROID);
  const vc = pick(VC_LIST);
  const g = gaid();
  const did = hex(32);

  return {
    userAgent: `com.community.oneroom/${vc} (Linux; U; Android ${av.version}; en_US; ${device.model}; Build/${av.build}; Cronet/148.0.7778.60)`,
    clientInfo: JSON.stringify({
      package_name: "com.community.oneroom",
      version_name: "3.0.09.1014.03",
      version_code: vc,
      os: "android",
      os_version: av.version,
      install_ch: "google-play",
      device_id: did,
      install_store: "gp",
      gaid: g,
      brand: device.brand,
      model: device.model,
      system_language: "en",
      net: "NETWORK_WIFI",
      region: "US",
      timezone: "Asia/Calcutta",
      sp_code: "405858",
    }),
  };
}

const BASE_URL = "https://apig.inmoviebox.com";

async function makeApiRequest(urlOrPath, options = {}) {
  const {
    method = "GET",
    body = null,
    authorization = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOjI2MDU1NDM3NjM5MzQxNzE5MjgsImV4cCI6MTc4NzY1NDY5MywiaWF0IjoxNzc5ODc4MzkzfQ.dUX9F_JSed-CiWANFqpCfmNNb3BQyQ1NqpfYzpLxvMI",
    useFullUrl = false,
  } = options;

  const fullUrl = useFullUrl || urlOrPath.startsWith("http")
    ? urlOrPath
    : `${BASE_URL}${urlOrPath}`;

  const bodyStr = body ? JSON.stringify(body) : null;
  const contentType = "application/json; charset=utf-8";
  const ts = Date.now();

  const sig = signRequest({ method, url: fullUrl, contentType, body: bodyStr, timestampMs: ts });
  const info = generateClientInfo();

  const headers = {
    Accept: "*/*",
    "Accept-Encoding": "gzip",
    Authorization: authorization,
    Connection: "keep-alive",
    "User-Agent": info.userAgent,
    "X-Client-Info": info.clientInfo,
    "X-Client-Status": "1",
    "X-Play-Mode": "1",
    "X-Family-Mode": "0",
    "x-tr-signature": sig,
  };
  if (bodyStr) {
    headers["Content-Type"] = contentType;
  }

  const resp = await fetch(fullUrl, {
    method: method.toUpperCase(),
    headers,
    body: bodyStr,
  });

  // Handle 407 time sync (GW.4410)
  if (resp.status === 407) {
    try {
      const cloned = resp.clone();
      const errBody = await cloned.text();
      const err = JSON.parse(errBody);
      if (err.metadata?.errorCode === "GW.4410") {
        const timeBeanB64 = err.metadata?.errorMsg;
        if (timeBeanB64) {
          const raw = Buffer.from(timeBeanB64, "base64").toString("utf8");
          const timeBean = JSON.parse(raw);
          const offset = timeBean.time - Date.now();
          const ts2 = Date.now() + offset;
          headers["x-tr-signature"] = signRequest({
            method,
            url: fullUrl,
            contentType,
            body: bodyStr,
            timestampMs: ts2,
          });
          return await fetch(fullUrl, {
            method: method.toUpperCase(),
            headers,
            body: bodyStr,
          });
        }
      }
    } catch { /* pass */ }
  }

  return resp;
}

async function handleRequest(request) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let data;
    if (request.method === "POST") {
      data = await request.json();
    } else {
      const u = new URL(request.url);
      data = {
        url: u.searchParams.get("url"),
        method: u.searchParams.get("method") || "GET",
        body: u.searchParams.get("body") ? JSON.parse(u.searchParams.get("body")) : null,
        auth: u.searchParams.get("auth"),
      };
    }

    if (!data.url) {
      return new Response(JSON.stringify({ error: "url is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const resp = await makeApiRequest(data.url, {
      method: data.method || "GET",
      body: data.body,
      authorization: data.auth,
      useFullUrl: data.url.startsWith("http"),
    });

    const respBody = await resp.text();
    return new Response(respBody, {
      status: resp.status,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
}

export default { fetch: handleRequest };
