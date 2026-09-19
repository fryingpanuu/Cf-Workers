import puppeteer from "puppeteer-core";
import fs from "fs";

const CHROME_PATHS = [
  // Windows
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  // Linux (Ubuntu / GitHub Actions Runner)
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
];

const DEFAULT_WORKER_URL = process.env.WORKER_URL || "https://meta.1proxy.workers.dev";
const SYNC_INTERVAL_MINUTES = 20;

function findExecutable() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("No Chrome or Chromium browser executable found on system.");
}

async function performSync(workerUrl = DEFAULT_WORKER_URL) {
  const executablePath = findExecutable();
  const startTime = performance.now();

  console.log(`[1/4] 🚀 Launching Chrome (${executablePath})...`);

  const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1280,800"
    ]
  });

  try {
    const page = await browser.newPage();
    const userAgent =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
    await page.setUserAgent(userAgent);

    console.log("[2/4] 🌐 Navigating to IMDb and evaluating AWS WAF...");
    await page.goto("https://www.imdb.com/title/tt2243973/", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await new Promise((r) => setTimeout(r, 4500));

    const cookies = await page.cookies();
    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const hasWaf = cookies.some((c) => c.name === "aws-waf-token");
    const hasSession = cookies.some((c) => c.name === "session-id");
    console.log(`[3/4] 🍪 Captured ${cookies.length} cookies (WAF Token: ${hasWaf}, Session: ${hasSession})`);

    if (cookieString.length > 0) {
      console.log(`[4/4] 📤 Uploading cookies to Cloudflare Worker KV (${workerUrl})...`);
      const resp = await fetch(`${workerUrl}/cookies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cookieString,
          userAgent
        })
      });

      const resJson = await resp.json();
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
      const timeStr = new Date().toLocaleTimeString();

      if (resJson.success) {
        console.log(`[${timeStr}] ✅ KV Updated Successfully in ${elapsed}s! Total Cookies: ${cookies.length}`);
        return true;
      } else {
        console.error(`[${timeStr}] ❌ Worker error:`, resJson.error);
        return false;
      }
    } else {
      console.warn(`[${new Date().toLocaleTimeString()}] ⚠️ No cookies captured from IMDb.`);
      return false;
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function dispatchNextWorkflow() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    return;
  }

  console.log(`\n🚀 [Self-Chaining] Dispatching next GitHub Actions runner for ${repo}...`);
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/sync-cookies.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "IMDb-Cookie-Sync-Daemon",
        },
        body: JSON.stringify({ ref: "main" }),
      }
    );

    if (resp.status === 204 || resp.status === 200 || resp.status === 201) {
      console.log("✅ Successor cloud runner successfully dispatched! Starting now in cloud.");
    } else {
      const text = await resp.text();
      console.warn(`⚠️ Dispatch returned status ${resp.status}: ${text}`);
    }
  } catch (err) {
    console.error("❌ Failed to dispatch successor workflow:", err.message);
  }
}

async function main() {
  const isDaemon = process.argv.includes("--daemon") || process.argv.includes("-d");
  const autoChain = process.argv.includes("--auto-chain");
  const intervalArg = process.argv.find((arg) => arg.startsWith("--interval="));
  const intervalMinutes = intervalArg
    ? parseInt(intervalArg.split("=")[1], 10) || SYNC_INTERVAL_MINUTES
    : SYNC_INTERVAL_MINUTES;

  const maxHoursArg = process.argv.find((arg) => arg.startsWith("--max-hours="));
  const maxHours = maxHoursArg ? parseFloat(maxHoursArg.split("=")[1]) : 0;
  const stopTimestamp = maxHours > 0 ? Date.now() + maxHours * 3600 * 1000 : 0;

  console.log("==================================================");
  console.log("🎬 IMDb Cookie Sync Service");
  console.log(`🎯 Target Worker: ${DEFAULT_WORKER_URL}`);
  console.log(
    `⚙️  Mode: ${
      isDaemon
        ? `Continuous Loop (every ${intervalMinutes} mins${maxHours > 0 ? `, for ${maxHours}h` : ""}${
            autoChain ? ", self-chaining" : ""
          })`
        : "One-shot Sync"
    }`
  );
  console.log("==================================================\n");

  const success = await performSync();

  if (isDaemon) {
    while (true) {
      if (stopTimestamp > 0 && Date.now() >= stopTimestamp) {
        console.log(`\n🏁 Reached execution window end (${maxHours}h).`);
        if (autoChain) {
          await dispatchNextWorkflow();
          // Give successor 30s to initialize before exiting
          await new Promise((r) => setTimeout(r, 30000));
        }
        break;
      }
      console.log(`\n⏳ Next sync scheduled in ${intervalMinutes} minutes...`);
      await new Promise((r) => setTimeout(r, intervalMinutes * 60 * 1000));
      try {
        await performSync();
      } catch (err) {
        console.error(`[${new Date().toLocaleTimeString()}] Error in sync loop:`, err.message);
      }
    }
  } else {
    if (!success) {
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error during cookie sync:", err);
  process.exit(1);
});
