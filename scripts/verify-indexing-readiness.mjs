const defaultSiteUrl = "https://tech.henjini.com";
const siteUrl = normalizeUrl(process.env.SITE_URL || defaultSiteUrl);
const sitemapUrl = new URL(process.env.SITEMAP_PATH || "/sitemap.xml", siteUrl).href;
const robotsUrl = new URL(process.env.ROBOTS_PATH || "/robots.txt", siteUrl).href;
const feedUrl = new URL(process.env.FEED_PATH || "/feed.xml", siteUrl).href;
const retries = parseIntegerEnv("INDEXING_CHECK_RETRIES", 6);
const delayMs = parseIntegerEnv("INDEXING_CHECK_DELAY_MS", 10000);
const timeoutMs = parseIntegerEnv("INDEXING_CHECK_TIMEOUT_MS", 15000);
const checkMode = (process.env.INDEXING_CHECK_MODE || "smoke").toLowerCase();
const changedDays = parseIntegerEnv("INDEXING_CHECK_CHANGED_DAYS", 14);
const explicitPostLimit = process.env.INDEXING_CHECK_POST_LIMIT
  ? parseIntegerEnv("INDEXING_CHECK_POST_LIMIT", 0)
  : null;
const postLimit = explicitPostLimit ?? defaultPostLimit(checkMode);
const feedPostCrossCheckLimit = parseIntegerEnv("INDEXING_CHECK_FEED_POST_LIMIT", 10);
const maxSummaryItems = parseIntegerEnv("INDEXING_CHECK_MAX_SUMMARY_ITEMS", 12);

const results = [];
const warnings = [];
const failures = [];

async function main() {
  const robots = await fetchTextWithRetry(robotsUrl, "robots.txt");
  assertIncludes(robots.text, "Sitemap:", "robots.txt must expose a Sitemap directive");
  assertIncludes(robots.text, sitemapUrl, `robots.txt must expose ${sitemapUrl}`);

  const sitemap = await fetchTextWithRetry(sitemapUrl, "sitemap.xml");
  const sitemapEntries = extractSitemapEntries(sitemap.text);
  validateSitemapEntries(sitemapEntries);

  const ownSitemapEntries = sitemapEntries.filter((entry) => entry.isSameOrigin);
  const sitemapUrls = ownSitemapEntries.map((entry) => entry.loc);

  if (sitemapUrls.length === 0) {
    failures.push("sitemap.xml does not contain any same-origin <loc> URLs");
  }

  if (!sitemapUrls.some((url) => normalizeUrl(url) === siteUrl)) {
    failures.push(`sitemap.xml does not include the site root: ${siteUrl}`);
  }

  const postEntries = ownSitemapEntries
    .filter((entry) => entry.pathname.includes("/posts/"))
    .sort((a, b) => b.lastmodTime - a.lastmodTime || a.loc.localeCompare(b.loc));

  validatePostSitemapEntries(postEntries);

  const feed = await fetchTextWithRetry(feedUrl, "feed.xml");
  assertIncludes(feed.text, "<feed", "feed.xml must look like an Atom feed");
  assertIncludes(feed.text, siteUrl, `feed.xml must reference ${siteUrl}`);

  const feedPostUrls = extractFeedPostUrls(feed.text);
  validateFeedCoverage(feedPostUrls, postEntries);

  const selectedPostEntries = selectPostEntries(postEntries);
  for (const entry of selectedPostEntries) {
    const post = await fetchTextWithRetry(entry.loc, `post ${entry.loc}`);
    validatePostHtml(post.text, entry.loc);
  }

  results.push(["check mode", checkMode]);
  results.push(["sitemap urls", `${sitemapUrls.length}`]);
  results.push(["sitemap post urls", `${postEntries.length}`]);
  results.push(["feed post urls", `${feedPostUrls.length}`]);
  results.push(["checked post pages", `${selectedPostEntries.length}`]);

  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }

  await writeStepSummary("Indexing readiness check passed");
  printResults("Indexing readiness check passed");
}

function validateSitemapEntries(entries) {
  if (entries.length === 0) {
    failures.push("sitemap.xml does not contain any <url> entries");
    return;
  }

  const seen = new Set();
  const duplicates = new Set();
  const externalUrls = [];
  const invalidUrls = [];

  for (const entry of entries) {
    if (!entry.loc) {
      failures.push("sitemap.xml contains a <url> entry without <loc>");
      continue;
    }

    if (!entry.url) {
      invalidUrls.push(entry.loc);
      continue;
    }

    const normalized = normalizeUrl(entry.loc);
    if (seen.has(normalized)) {
      duplicates.add(normalized);
    }
    seen.add(normalized);

    if (!entry.isSameOrigin) {
      externalUrls.push(entry.loc);
    }
  }

  if (duplicates.size > 0) {
    failures.push(`sitemap.xml contains duplicate URLs: ${formatList([...duplicates])}`);
  }

  if (externalUrls.length > 0) {
    failures.push(`sitemap.xml contains URLs outside ${siteUrl}: ${formatList(externalUrls)}`);
  }

  if (invalidUrls.length > 0) {
    failures.push(`sitemap.xml contains invalid URLs: ${formatList(invalidUrls)}`);
  }
}

function validatePostSitemapEntries(postEntries) {
  if (postEntries.length === 0) {
    failures.push("sitemap.xml does not include any /posts/ URLs");
    return;
  }

  const missingLastmod = postEntries.filter((entry) => !entry.lastmodRaw);
  const invalidLastmod = postEntries.filter((entry) => entry.lastmodRaw && entry.lastmodTime === 0);

  if (missingLastmod.length > 0) {
    warnings.push(`post URLs without <lastmod>: ${formatList(missingLastmod.map((entry) => entry.loc))}`);
  }

  if (invalidLastmod.length > 0) {
    warnings.push(`post URLs with invalid <lastmod>: ${formatList(invalidLastmod.map((entry) => entry.loc))}`);
  }
}

function validateFeedCoverage(feedPostUrls, postEntries) {
  if (feedPostUrls.length === 0) {
    warnings.push("feed.xml does not expose any /posts/ URLs");
    return;
  }

  const feedSet = new Set(feedPostUrls.map(normalizeUrl));
  const latestPostUrls = postEntries.slice(0, feedPostCrossCheckLimit).map((entry) => entry.loc);
  const missingFromFeed = latestPostUrls.filter((url) => !feedSet.has(normalizeUrl(url)));

  if (missingFromFeed.length > 0) {
    warnings.push(`latest sitemap posts missing from feed.xml: ${formatList(missingFromFeed)}`);
  }
}

function validatePostHtml(html, pageUrl) {
  if (hasNoindex(html)) {
    failures.push(`${pageUrl} contains a noindex robots directive`);
  }

  const title = extractTagContent(html, "title");
  if (!title || title.length < 8) {
    warnings.push(`${pageUrl} has a missing or very short <title>`);
  }

  const description = extractMetaContent(html, "description");
  if (!description || description.length < 30) {
    warnings.push(`${pageUrl} has a missing or very short meta description`);
  }

  const canonical = extractLinkHref(html, "canonical");
  if (!canonical) {
    warnings.push(`${pageUrl} does not expose a canonical link`);
  } else if (normalizeUrl(canonical) !== normalizeUrl(pageUrl)) {
    warnings.push(`${pageUrl} canonical points to ${canonical}`);
  }

  const ogUrl = extractMetaProperty(html, "og:url");
  if (ogUrl && normalizeUrl(ogUrl) !== normalizeUrl(pageUrl)) {
    warnings.push(`${pageUrl} og:url points to ${ogUrl}`);
  }

  if (!extractMetaProperty(html, "og:title")) {
    warnings.push(`${pageUrl} does not expose og:title`);
  }

  if (!extractMetaProperty(html, "og:description")) {
    warnings.push(`${pageUrl} does not expose og:description`);
  }
}

function selectPostEntries(postEntries) {
  if (checkMode === "full") {
    return postLimit > 0 ? postEntries.slice(0, postLimit) : postEntries;
  }

  if (checkMode === "changed") {
    const changedSince = Date.now() - changedDays * 24 * 60 * 60 * 1000;
    const changedEntries = postEntries.filter((entry) => entry.lastmodTime >= changedSince);

    if (changedEntries.length > 0) {
      return changedEntries.slice(0, postLimit);
    }

    warnings.push(`no posts changed in the last ${changedDays} days; falling back to latest posts`);
    return postEntries.slice(0, postLimit);
  }

  if (checkMode !== "smoke") {
    warnings.push(`unknown INDEXING_CHECK_MODE "${checkMode}"; falling back to smoke`);
  }

  return postEntries.slice(0, postLimit);
}

async function fetchTextWithRetry(url, label) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        throw new Error(`${label} returned HTTP ${response.status}`);
      }

      const text = await response.text();
      if (text.trim().length === 0) {
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
        "User-Agent": "henjini-tech-indexing-readiness/2.0"
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function extractSitemapEntries(xml) {
  return [...xml.matchAll(/<url>\s*([\s\S]*?)\s*<\/url>/g)].map((match) => {
    const loc = match[1].match(/<loc>\s*([^<]+?)\s*<\/loc>/);
    const lastmod = match[1].match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/);
    const locValue = loc ? decodeXml(loc[1].trim()) : "";
    const lastmodRaw = lastmod ? lastmod[1].trim() : "";
    const parsedUrl = parseUrl(locValue);

    return {
      loc: locValue,
      url: parsedUrl,
      pathname: parsedUrl?.pathname || "",
      isSameOrigin: parsedUrl?.origin === new URL(siteUrl).origin,
      lastmodRaw,
      lastmodTime: lastmodRaw ? Date.parse(lastmodRaw) || 0 : 0
    };
  });
}

function extractFeedPostUrls(xml) {
  const urls = new Set();

  for (const match of xml.matchAll(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/g)) {
    const url = decodeXml(match[1].trim());
    const parsedUrl = parseUrl(url);

    if (parsedUrl?.origin === new URL(siteUrl).origin && parsedUrl.pathname.includes("/posts/")) {
      urls.add(normalizeUrl(parsedUrl.href));
    }
  }

  return [...urls];
}

function assertIncludes(value, expected, message) {
  if (!value.includes(expected)) {
    failures.push(message);
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

function extractTagContent(html, tagName) {
  const match = html.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? stripHtml(match[1]).trim() : "";
}

function extractMetaContent(html, name) {
  return extractMetaByAttribute(html, "name", name);
}

function extractMetaProperty(html, property) {
  return extractMetaByAttribute(html, "property", property);
}

function extractMetaByAttribute(html, attribute, value) {
  const pattern = new RegExp(
    `<meta\\b(?=[^>]*\\b${attribute}=["']${escapeRegExp(value)}["'])(?=[^>]*\\bcontent=["']([^"']*)["'])[^>]*>`,
    "i"
  );
  const reversePattern = new RegExp(
    `<meta\\b(?=[^>]*\\bcontent=["']([^"']*)["'])(?=[^>]*\\b${attribute}=["']${escapeRegExp(value)}["'])[^>]*>`,
    "i"
  );
  const match = html.match(pattern) || html.match(reversePattern);
  return match ? decodeHtmlAttribute(match[1]).trim() : "";
}

function extractLinkHref(html, rel) {
  const pattern = new RegExp(
    `<link\\b(?=[^>]*\\brel=["'][^"']*\\b${escapeRegExp(rel)}\\b[^"']*["'])(?=[^>]*\\bhref=["']([^"']*)["'])[^>]*>`,
    "i"
  );
  const reversePattern = new RegExp(
    `<link\\b(?=[^>]*\\bhref=["']([^"']*)["'])(?=[^>]*\\brel=["'][^"']*\\b${escapeRegExp(rel)}\\b[^"']*["'])[^>]*>`,
    "i"
  );
  const match = html.match(pattern) || html.match(reversePattern);
  return match ? new URL(decodeHtmlAttribute(match[1]).trim(), siteUrl).href : "";
}

function hasNoindex(html) {
  const robots = extractMetaContent(html, "robots").toLowerCase();
  const googlebot = extractMetaContent(html, "googlebot").toLowerCase();
  return [robots, googlebot].some((value) => value.split(",").map((part) => part.trim()).includes("noindex"));
}

function decodeHtmlAttribute(value) {
  return decodeXml(value).replaceAll("&#39;", "'").replaceAll("&nbsp;", " ");
}

function stripHtml(value) {
  return decodeHtmlAttribute(value.replace(/<[^>]*>/g, " "));
}

function normalizeUrl(value) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.href.replace(/\/$/, "");
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function parseIntegerEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || `${fallback}`, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function defaultPostLimit(mode) {
  if (mode === "full") {
    return 0;
  }

  if (mode === "changed") {
    return 25;
  }

  return 10;
}

function formatList(values) {
  const visible = values.slice(0, maxSummaryItems);
  const suffix = values.length > visible.length ? `, ... +${values.length - visible.length} more` : "";
  return `${visible.join(", ")}${suffix}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printResults(title) {
  console.log(`\n${title}`);
  for (const [label, status] of results) {
    console.log(`- ${label}: ${status}`);
  }

  if (warnings.length > 0) {
    console.log("\nWarnings");
    for (const warning of warnings) {
      console.log(`- ${warning}`);
    }
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

  if (warnings.length > 0) {
    lines.push("### Warnings", "", ...warnings.map((warning) => `- ${warning}`), "");
  }

  if (failures.length > 0) {
    lines.push("### Failures", "", ...failures.map((failure) => `- ${failure}`), "");
  }

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
