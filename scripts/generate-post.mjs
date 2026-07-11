import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";

const TOPICS_PATH = path.join("prompts", "tech-topics.json");
const TOPIC_BATCH_SIZE = 30;
const TIME_ZONE = "Asia/Seoul";
const POST_IMAGE_ROOT = path.join("assets", "img", "posts", "blog");
const PUBLIC_POST_IMAGE_ROOT = "/assets/img/posts/blog";
const REQUIRED_IMAGE_COUNT = 2;
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1-mini";
const IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE ?? "1024x1024";
const IMAGE_OUTPUT_FORMAT = process.env.OPENAI_IMAGE_FORMAT ?? "webp";
const IMAGE_OUTPUT_COMPRESSION = Number(process.env.OPENAI_IMAGE_COMPRESSION ?? "70");
const IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY ?? "low";
const IMAGE_MARKER_PATTERN = /<!--\s*AI_IMAGE_(\d)\s*-->/g;
const IMAGE_ALT_PATTERN = /<!--\s*AI_IMAGE_(\d)_ALT:\s*([\s\S]*?)\s*-->/g;

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

function imageMarkers(markdown) {
  return [...markdown.matchAll(IMAGE_MARKER_PATTERN)]
    .map((match) => Number(match[1]))
    .sort((left, right) => left - right);
}

function imageAltTexts(markdown) {
  const altTexts = new Map();

  for (const match of markdown.matchAll(IMAGE_ALT_PATTERN)) {
    altTexts.set(Number(match[1]), match[2].trim());
  }

  return altTexts;
}

function withoutImageAltComments(markdown) {
  return markdown.replace(IMAGE_ALT_PATTERN, "").replace(/\n{3,}/g, "\n\n");
}

function imagePrompt({ index, title, alt }) {
  return [
    "Create a simple, lightweight technical blog illustration.",
    `Blog topic: ${topic}`,
    `Blog title: ${title || topic}`,
    `Image ${index} purpose: ${alt}`,
    "Style: minimal flat editorial illustration, few objects, simple shapes, limited colors, clean background.",
    "Prefer an abstract technical concept over a detailed workstation scene.",
    "Avoid photorealism, dense details, gradients, tiny UI, fake code, logos, brand names, watermarks, and text.",
    "Optimize for small web image size and fast loading."
  ].join("\n");
}

async function generateImage({ index, title, alt, filepath }) {
  const imageOptions = {
    model: IMAGE_MODEL,
    prompt: imagePrompt({ index, title, alt }),
    size: IMAGE_SIZE,
    quality: IMAGE_QUALITY,
    output_format: IMAGE_OUTPUT_FORMAT,
    n: 1
  };

  if (IMAGE_OUTPUT_FORMAT !== "png") {
    imageOptions.output_compression = IMAGE_OUTPUT_COMPRESSION;
  }

  const imageResponse = await client.images.generate(imageOptions);
  const image = imageResponse.data?.[0];

  if (!image?.b64_json) {
    throw new Error(`Image ${index} generation did not return b64_json data.`);
  }

  await fs.writeFile(filepath, Buffer.from(image.b64_json, "base64"));
}

function imageExtension() {
  return IMAGE_OUTPUT_FORMAT === "jpeg" ? "jpg" : IMAGE_OUTPUT_FORMAT;
}

async function generatePostImages(markdown, slug) {
  const markers = imageMarkers(markdown);

  if (
    markers.length !== REQUIRED_IMAGE_COUNT ||
    markers.some((marker, index) => marker !== index + 1)
  ) {
    throw new Error(
      `The generated post must include exactly these markers: <!-- AI_IMAGE_1 --> and <!-- AI_IMAGE_2 -->.`
    );
  }

  const title = frontMatterValue(markdown, "title");
  const altTexts = imageAltTexts(markdown);
  const imageDir = path.join(POST_IMAGE_ROOT, slug);
  await fs.mkdir(imageDir, { recursive: true });

  let output = withoutImageAltComments(markdown);
  const generatedImages = [];

  for (const index of markers) {
    const alt = altTexts.get(index) || `${topic} 관련 기술 블로그 이미지 ${index}`;
    const filename = `image-${index}.${imageExtension()}`;
    const filepath = path.join(imageDir, filename);
    const publicPath = `${PUBLIC_POST_IMAGE_ROOT}/${slug}/${filename}`;

    await generateImage({ index, title, alt, filepath });

    output = output.replace(`<!-- AI_IMAGE_${index} -->`, `![${alt}](${publicPath})`);
    generatedImages.push({ alt, path: publicPath });
  }

  return {
    markdown: output,
    images: generatedImages
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
const generatedImages = await generatePostImages(outputContent, draft.slug);
outputContent = upsertFrontMatterBlock(generatedImages.markdown, "image", [
  "image:",
  `  path: ${generatedImages.images[0].path}`,
  `  alt: ${yamlDoubleQuoted(generatedImages.images[0].alt)}`
]);

await fs.mkdir("_drafts", { recursive: true });
await fs.writeFile(draft.filepath, outputContent, "utf8");

console.log(`Selected topic: ${topic}`);
console.log(`English slug: ${draft.slug}`);
console.log(`Generated images: ${generatedImages.images.length}`);
console.log(`Created draft: ${draft.filepath}`);
