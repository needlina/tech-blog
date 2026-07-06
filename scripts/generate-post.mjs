import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  throw new Error("OPENAI_API_KEY is required.");
}

const client = new OpenAI({ apiKey });

const today = new Date();
const date = today.toISOString().slice(0, 10);

const topics = [
  "React에서 useEffect를 잘못 쓰는 대표적인 패턴과 개선 방법",
  "TypeScript에서 any를 줄이는 실무적인 방법",
  "React Query와 Zustand를 함께 사용할 때의 역할 분리",
  "프론트엔드에서 API 에러 처리를 일관되게 설계하는 방법",
  "Vite 기반 React 프로젝트의 폴더 구조 설계"
];

const topic = topics[Math.floor(Math.random() * topics.length)];

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

console.log(`Created draft: ${filepath}`);
