const siteUrl = normalizeUrl(process.env.SITE_URL || "https://tech.henjini.com");
const sitemapUrl = new URL(process.env.SITEMAP_PATH || "/sitemap.xml", siteUrl).href;
const robotsUrl = new URL(process.env.ROBOTS_PATH || "/robots.txt", siteUrl).href;
const feedUrl = new URL(process.env.FEED_PATH || "/feed.xml", siteUrl).href;
const retries = Number.parseInt(process.env.INDEXING_CHECK_RETRIES || "6", 10);
const delayMs = Number.parseInt(process.env.INDEXING_CHECK_DELAY_MS || "10000", 10);
const timeoutMs = Number.parseInt(process.env.INDEXING_CHECK_TIMEOUT_MS || "15000", 10);
const latestPostLimit = Number.parseInt(process.env.INDEXING_CHECK_POST_LIMIT || "5", 10);

const results = [];

async function main() {
  const robots = await fetchTextWithRetry(robotsUrl, "robots.txt");
  assertIncludes(robots.text, "Sitemap:", "robots.txt must expose a Sitemap directive");
  assertIncludes(robots.text, sitemapUrl, `robots.txt must expose ${sitemapUrl}`);

  const sitemap = await fetchTextWithRetry(sitemapUrl, "sitemap.xml");
  const sitemapEntries = extractSitemapEntries(sitemap.text);
  const sitemapUrls = sitemapEntries.map((entry) => entry.loc);

  if (sitemapUrls.length === 0) {
    throw new Error("sitemap.xml does not contain any <loc> URLs");
  }

  if (!sitemapUrls.some((url) => normalizeUrl(url) === siteUrl)) {
    throw new Error(`sitemap.xml does not include the site root: ${siteUrl}`);
  }

  const feed = await fetchTextWithRetry(feedUrl, "feed.xml");
  assertIncludes(feed.text, "<feed", "feed.xml must look like an Atom feed");
  assertIncludes(feed.text, siteUrl, `feed.xml must reference ${siteUrl}`);

  const latestPostUrls = sitemapEntries
    .filter((entry) => new URL(entry.loc).pathname.includes("/posts/"))
    .sort((a, b) => b.lastmodTime - a.lastmodTime)
    .map((entry) => entry.loc)
    .slice(0, latestPostLimit);

  for (const postUrl of latestPostUrls) {
    await fetchTextWithRetry(postUrl, `post ${postUrl}`, { expectText: false });
  }

  results.push(["sitemap urls", `${sitemapUrls.length}`]);
  results.push(["checked latest posts", `${latestPostUrls.length}`]);

  await writeStepSummary("Indexing readiness check passed");
  printResults("Indexing readiness check passed");
}

async function fetchTextWithRetry(url, label, options = {}) {
  const expectText = options.expectText ?? true;
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        throw new Error(`${label} returned HTTP ${response.status}`);
      }

      const text = expectText ? await response.text() : "";

      if (expectText && text.trim().length === 0) {
        throw new Error(`${label} returned an empty response`);
      }

      results.push([label, `ok (${response.status})`]);
      return { response, text };
    } catch (error) {
      lastError = error;

      if (attempt < retries) {
        console.log(`${label} is not ready yet: ${error.message}. Retry ${attempt}/${retries}...`);
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      headers: {
        "Cache-Control": "no-cache",
        "User-Agent": "henjini-tech-indexing-readiness/1.0"
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function extractSitemapEntries(xml) {
  return [...xml.matchAll(/<url>\s*([\s\S]*?)\s*<\/url>/g)]
    .map((match) => {
      const loc = match[1].match(/<loc>\s*([^<]+?)\s*<\/loc>/);
      const lastmod = match[1].match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/);

      return {
        loc: loc ? decodeXml(loc[1].trim()) : "",
        lastmodTime: lastmod ? Date.parse(lastmod[1].trim()) || 0 : 0
      };
    })
    .filter((entry) => {
      try {
        return new URL(entry.loc).origin === new URL(siteUrl).origin;
      } catch {
        return false;
      }
    });
}

function assertIncludes(value, expected, message) {
  if (!value.includes(expected)) {
    throw new Error(message);
  }
}

function decodeXml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function normalizeUrl(value) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.href.replace(/\/$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printResults(title) {
  console.log(`\n${title}`);
  for (const [label, status] of results) {
    console.log(`- ${label}: ${status}`);
  }
}

async function writeStepSummary(title) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }

  const { appendFile } = await import("node:fs/promises");
  const lines = [
    `## ${title}`,
    "",
    "| Check | Result |",
    "| --- | --- |",
    ...results.map(([label, status]) => `| ${label} | ${status} |`),
    ""
  ];

  await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"));
}

main().catch(async (error) => {
  console.error(error.message);

  try {
    await writeStepSummary("Indexing readiness check failed");
  } catch {
    // Ignore summary write failures so the original error remains clear.
  }

  process.exit(1);
});
