import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";

const TOPICS_PATH = path.join("prompts", "tech-topics.json");
const TOPIC_BATCH_SIZE = 30;
const TIME_ZONE = "Asia/Seoul";
const POST_IMAGE_ROOT = path.join("assets", "img", "posts", "blog");
const PUBLIC_POST_IMAGE_ROOT = "/assets/img/posts/blog";
const REQUIRED_IMAGE_COUNT = 2;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 30000;

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  throw new Error("OPENAI_API_KEY is required.");
}

const client = new OpenAI({ apiKey });

const today = new Date();
const date = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(today);

async function readTopicPool() {
  const raw = await fs.readFile(TOPICS_PATH, "utf8");
  const pool = JSON.parse(raw);

  if (!Array.isArray(pool.topics)) {
    throw new Error(`${TOPICS_PATH} must contain a topics array.`);
  }

  return pool;
}

function parseJsonArray(text) {
  const withoutFence = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  return JSON.parse(withoutFence);
}

async function requestNewTopics(previousTopics) {
  const response = await client.responses.create({
    model: "gpt-5-mini",
    input: [
      "한국어 실무 IT 기술 블로그 주제 30개를 JSON 배열로만 작성해라.",
      "각 항목은 문자열이어야 하고, 마크다운이나 설명 문장은 넣지 마라.",
      "주제는 실무 중심이어야 하며 특정 프레임워크에 치우치지 않게 다양하게 구성해라.",
      "반드시 Backend, Database, PostgreSQL, Docker, Linux, DevOps, Cloud, Security, Testing, Observability, Frontend, Architecture, Blogging 주제를 고르게 섞어라.",
      "초보자도 따라갈 수 있는 기초 주제와 실무자가 바로 적용할 수 있는 운영 주제를 함께 포함해라.",
      "최근에 사용한 아래 주제와 의미가 겹치지 않게 작성해라.",
      JSON.stringify(previousTopics, null, 2)
    ].join("\n\n")
  });

  const topics = parseJsonArray(response.output_text);

  if (!Array.isArray(topics) || topics.length < TOPIC_BATCH_SIZE) {
    throw new Error("The topic refresh response must be a JSON array with at least 30 items.");
  }

  return topics.slice(0, TOPIC_BATCH_SIZE).map((title) => ({ title }));
}

async function pickTopic() {
  const pool = await readTopicPool();
  let topic = pool.topics.find((item) => !item.usedAt);

  if (!topic) {
    const previousTopics = pool.topics.map((item) => item.title);
    pool.generatedAt = new Date().toISOString();
    pool.topics = await requestNewTopics(previousTopics);
    topic = pool.topics[0];
  }

  topic.usedAt = new Date().toISOString();

  await fs.writeFile(`${TOPICS_PATH}`, `${JSON.stringify(pool, null, 2)}\n`, "utf8");

  return topic.title;
}

const topic = await pickTopic();

const promptTemplate = await fs.readFile(
  path.join("prompts", "tech-post.prompt.md"),
  "utf8"
);

const prompt = promptTemplate.replace("{{TOPIC}}", topic);

const response = await client.responses.create({
  model: "gpt-5-mini",
  input: prompt
});

const content = response.output_text;

function sanitizeEnglishSlug(value) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/['`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

function frontMatterValue(markdown, key) {
  const frontMatter = markdown.match(/^---\s*\n([\s\S]*?)\n---/);

  if (!frontMatter) {
    return "";
  }

  const line = frontMatter[1]
    .split("\n")
    .find((item) => item.startsWith(`${key}:`));

  if (!line) {
    return "";
  }

  return line
    .slice(key.length + 1)
    .trim()
    .replace(/^["']|["']$/g, "");
}

function upsertFrontMatterValue(markdown, key, value) {
  const frontMatter = markdown.match(/^---\s*\n([\s\S]*?)\n---/);

  if (!frontMatter) {
    return markdown;
  }

  const lines = frontMatter[1].split("\n");
  const line = `${key}: ${value}`;
  const currentIndex = lines.findIndex((item) => item.startsWith(`${key}:`));

  if (currentIndex >= 0) {
    lines[currentIndex] = line;
  } else {
    const titleIndex = lines.findIndex((item) => item.startsWith("title:"));
    lines.splice(titleIndex >= 0 ? titleIndex + 1 : 0, 0, line);
  }

  return `---\n${lines.join("\n")}\n---${markdown.slice(frontMatter[0].length)}`;
}

function yamlDoubleQuoted(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function upsertFrontMatterBlock(markdown, key, blockLines) {
  const frontMatter = markdown.match(/^---\s*\n([\s\S]*?)\n---/);

  if (!frontMatter) {
    return markdown;
  }

  const lines = frontMatter[1].split("\n");
  const nextLines = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith(`${key}:`)) {
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
        index += 1;
      }
      continue;
    }

    nextLines.push(lines[index]);
  }

  const insertAfterKeys = ["tags:", "categories:", "date:", "slug:", "title:"];
  const insertIndex = nextLines.findLastIndex((line) =>
    insertAfterKeys.some((prefix) => line.startsWith(prefix))
  );

  nextLines.splice(insertIndex >= 0 ? insertIndex + 1 : 0, 0, ...blockLines);

  return `---\n${nextLines.join("\n")}\n---${markdown.slice(frontMatter[0].length)}`;
}

function markdownRemoteImages(markdown) {
  const images = [];
  const seenUrls = new Set();
  const pattern = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g;

  for (const match of markdown.matchAll(pattern)) {
    const url = match[2];

    if (seenUrls.has(url)) {
      continue;
    }

    seenUrls.add(url);
    images.push({
      full: match[0],
      alt: match[1].trim(),
      url
    });
  }

  return images;
}

function imageExtensionFromContentType(contentType) {
  const type = contentType.toLowerCase().split(";")[0].trim();
  const extensions = new Map([
    ["image/jpeg", ".jpg"],
    ["image/jpg", ".jpg"],
    ["image/png", ".png"],
    ["image/webp", ".webp"],
    ["image/avif", ".avif"],
    ["image/gif", ".gif"]
  ]);

  return extensions.get(type) ?? "";
}

function imageExtensionFromUrl(value) {
  try {
    const pathname = new URL(value).pathname;
    const extension = pathname.match(/\.(avif|gif|jpe?g|png|webp)$/i)?.[0];
    return extension ? extension.toLowerCase().replace(".jpeg", ".jpg") : "";
  } catch {
    return "";
  }
}

async function downloadImage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; henjini-tech-blog-generator/1.0)"
      },
      redirect: "follow",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";

    if (!contentType.toLowerCase().startsWith("image/")) {
      throw new Error(`not an image content-type: ${contentType || "unknown"}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.byteLength < 1024) {
      throw new Error("downloaded image is unexpectedly small");
    }

    return { buffer, contentType };
  } finally {
    clearTimeout(timeout);
  }
}

async function localizePostImages(markdown, slug) {
  const remoteImages = markdownRemoteImages(markdown);

  if (remoteImages.length !== REQUIRED_IMAGE_COUNT) {
    throw new Error(
      `The generated post must include exactly ${REQUIRED_IMAGE_COUNT} remote Markdown image URLs.`
    );
  }

  const imageDir = path.join(POST_IMAGE_ROOT, slug);
  await fs.mkdir(imageDir, { recursive: true });

  let output = markdown;
  const localizedImages = [];

  for (const [index, image] of remoteImages.entries()) {
    const downloadedImage = await downloadImage(image.url);
    const contentType = downloadedImage.contentType;
    const extension =
      imageExtensionFromContentType(contentType) || imageExtensionFromUrl(image.url) || ".jpg";
    const filename = `image-${index + 1}${extension}`;
    const filepath = path.join(imageDir, filename);
    const publicPath = `${PUBLIC_POST_IMAGE_ROOT}/${slug}/${filename}`;

    await fs.writeFile(filepath, downloadedImage.buffer);

    const alt = image.alt || `${topic} 관련 이미지 ${index + 1}`;
    output = output.replace(image.full, `![${alt}](${publicPath})`);
    localizedImages.push({ alt, path: publicPath });
  }

  return {
    markdown: output,
    images: localizedImages
  };
}

async function requestEnglishSlug(markdown) {
  const title = frontMatterValue(markdown, "title");
  const slugResponse = await client.responses.create({
    model: "gpt-5-mini",
    input: [
      "Create one SEO-friendly English URL slug for a Korean technical blog post.",
      "Return only lowercase ASCII kebab-case, with no markdown or explanation.",
      "Keep it under 80 characters.",
      `Topic: ${topic}`,
      `Title: ${title}`
    ].join("\n")
  });

  return sanitizeEnglishSlug(slugResponse.output_text);
}

async function uniqueDraftPath(baseSlug) {
  let suffix = 1;

  while (true) {
    const slug = suffix === 1 ? baseSlug : `${baseSlug}-${suffix}`;
    const filepath = path.join("_drafts", `${date}-${slug}.md`);
    const exists = await fs
      .stat(filepath)
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      return { filepath, slug };
    }

    suffix += 1;
  }
}

let slug = sanitizeEnglishSlug(frontMatterValue(content, "slug"));

if (!slug) {
  slug = await requestEnglishSlug(content);
}

if (!slug) {
  throw new Error("The generated post must have a non-empty English slug.");
}

const draft = await uniqueDraftPath(slug);
let outputContent = upsertFrontMatterValue(content, "slug", `"${draft.slug}"`);
const localizedImages = await localizePostImages(outputContent, draft.slug);
outputContent = upsertFrontMatterBlock(localizedImages.markdown, "image", [
  "image:",
  `  path: ${localizedImages.images[0].path}`,
  `  alt: ${yamlDoubleQuoted(localizedImages.images[0].alt)}`
]);

await fs.mkdir("_drafts", { recursive: true });
await fs.writeFile(draft.filepath, outputContent, "utf8");

console.log(`Selected topic: ${topic}`);
console.log(`English slug: ${draft.slug}`);
console.log(`Downloaded images: ${localizedImages.images.length}`);
console.log(`Created draft: ${draft.filepath}`);
