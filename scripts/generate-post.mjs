import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";

const TOPICS_PATH = path.join("prompts", "tech-topics.json");
const TOPIC_BATCH_SIZE = 30;
const TIME_ZONE = "Asia/Seoul";

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
const outputContent = upsertFrontMatterValue(content, "slug", `"${draft.slug}"`);

await fs.mkdir("_drafts", { recursive: true });
await fs.writeFile(draft.filepath, outputContent, "utf8");

console.log(`Selected topic: ${topic}`);
console.log(`English slug: ${draft.slug}`);
console.log(`Created draft: ${draft.filepath}`);
