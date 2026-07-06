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
      "한국어 React/TypeScript 기술 블로그 주제 30개를 JSON 배열로만 작성해라.",
      "각 항목은 문자열이어야 하고, 마크다운이나 설명 문장은 넣지 마라.",
      "주제는 실무 중심이어야 하며 React, TypeScript, Frontend Architecture, Node.js, DevOps, Blogging 범위를 벗어나지 마라.",
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

const slug = topic
  .toLowerCase()
  .replace(/[^\w가-힣\s-]/g, "")
  .trim()
  .replace(/\s+/g, "-")
  .slice(0, 80);

const filename = `${date}-${slug}.md`;
const filepath = path.join("_drafts", filename);

await fs.mkdir("_drafts", { recursive: true });
await fs.writeFile(filepath, content, "utf8");

console.log(`Selected topic: ${topic}`);
console.log(`Created draft: ${filepath}`);
