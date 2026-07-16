import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const TOPICS_PATH = path.join("prompts", "tech-topics.json");
const TOPIC_MANIFEST_DIR = path.join("_drafts", ".topic-manifest");
const TOPIC_BATCH_SIZE = 30;
const TIME_ZONE = "Asia/Seoul";
const PUBLIC_POST_IMAGE_ROOT = "/assets/img/posts/blog";
const THUMBNAIL_OUTPUT_NAME = "preview.png";

function argValue(name) {
  const index = process.argv.indexOf(name);

  if (index < 0) {
    return "";
  }

  return process.argv[index + 1] ?? "";
}

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
  const pool = JSON.parse(raw.replace(/^\uFEFF/, ""));

  if (!Array.isArray(pool.topics)) {
    throw new Error(`${TOPICS_PATH} must contain a topics array.`);
  }

  return pool;
}

function topicTitle(item) {
  if (typeof item === "string") {
    return item;
  }

  return String(item?.title ?? "").trim();
}

function topicIdentifiers(item) {
  const slug = String(item?.slug ?? "").trim();
  const title = topicTitle(item);

  return [
    slug ? `slug:${slug}` : "",
    title ? `title:${title}` : ""
  ].filter(Boolean);
}

async function listJsonFiles(dir) {
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch((error) => {
      if (error.code === "ENOENT") {
        return [];
      }

      throw error;
    });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listJsonFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    }
  }

  return files;
}

async function readUsedTopicIdentifiers() {
  const files = await listJsonFiles(TOPIC_MANIFEST_DIR);
  const used = new Set();

  for (const file of files) {
    const raw = await fs.readFile(file, "utf8");
    const manifest = JSON.parse(raw.replace(/^\uFEFF/, ""));
    const identifiers = Array.isArray(manifest.topicIdentifiers)
      ? manifest.topicIdentifiers
      : topicIdentifiers({
          slug: manifest.topicSlug,
          title: manifest.topicTitle
        });

    for (const identifier of identifiers) {
      if (identifier) {
        used.add(identifier);
      }
    }
  }

  return used;
}

function wasTopicUsed(item, usedIdentifiers) {
  return topicIdentifiers(item).some((identifier) => usedIdentifiers.has(identifier));
}

function pickStableCandidate(candidates) {
  if (!candidates.length) {
    return null;
  }

  const seed = `${process.env.GITHUB_RUN_ID ?? ""}:${process.env.GITHUB_RUN_ATTEMPT ?? ""}`;
  let hash = 0;

  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return candidates[hash % candidates.length];
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
      "각 항목은 반드시 객체여야 하며, title, slug, thumbnail 키를 포함해라.",
      "thumbnail은 title과 subtitle 키를 가진 객체여야 한다.",
      "slug는 lowercase ASCII kebab-case로 작성하고 80자 이하로 유지해라.",
      "thumbnail.title은 썸네일에 들어갈 짧은 한국어 제목, thumbnail.subtitle은 썸네일에 들어갈 짧은 한국어 부제목으로 작성해라.",
      "마크다운이나 설명 문장은 넣지 마라.",
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

  return topics.slice(0, TOPIC_BATCH_SIZE).map((item) => {
    if (typeof item === "string") {
      return { title: item };
    }

    return {
      title: String(item.title ?? item.topic ?? "").trim(),
      slug: String(item.slug ?? "").trim(),
      thumbnail: {
        title: String(item.thumbnail?.title ?? item.thumbnailTitle ?? "").trim(),
        subtitle: String(item.thumbnail?.subtitle ?? item.subtitle ?? "").trim()
      }
    };
  });
}

async function pickTopic() {
  const pool = await readTopicPool();
  const usedIdentifiers = await readUsedTopicIdentifiers();
  let topic = pickStableCandidate(
    pool.topics.filter((item) => !item.usedAt && !wasTopicUsed(item, usedIdentifiers))
  );

  if (!topic) {
    const previousTopics = pool.topics.map(topicTitle);
    const refreshedTopics = await requestNewTopics(previousTopics);
    topic = pickStableCandidate(refreshedTopics);
  }

  return topic;
}

async function pickTopicFromCandidateFile() {
  const topicFile = argValue("--topic-file");
  const topicIndex = Number.parseInt(argValue("--topic-index"), 10);

  if (!topicFile && !topicIndex) {
    return null;
  }

  if (!topicFile || !Number.isInteger(topicIndex) || topicIndex < 1) {
    throw new Error("--topic-file and a 1-based --topic-index are required together.");
  }

  const raw = await fs.readFile(topicFile, "utf8");
  const topicSet = JSON.parse(raw.replace(/^\uFEFF/, ""));
  const candidates = Array.isArray(topicSet.candidates) ? topicSet.candidates : [];
  const candidate = candidates.find((item) => Number(item.index) === topicIndex);

  if (!candidate) {
    throw new Error(`${topicFile} does not contain candidate index ${topicIndex}.`);
  }

  return {
    ...candidate,
    title: String(candidate.title ?? "").trim(),
    candidateKind: String(topicSet.kind ?? "topic").trim() || "topic"
  };
}

const selectedTopic = (await pickTopicFromCandidateFile()) ?? (await pickTopic());
const topic = topicTitle(selectedTopic);
const candidateKind = String(selectedTopic.candidateKind ?? "topic").trim() || "topic";
const isNewTrend = candidateKind === "new-trend";

const promptTemplate = await fs.readFile(
  path.join("prompts", "tech-post.prompt.md"),
  "utf8"
);

let prompt = promptTemplate.replace("{{TOPIC}}", topic);
prompt += isNewTrend
  ? "\n\n## 추가 분류 규칙\n\n- 이 글은 신규 뉴스/트렌드 초안이다.\n- front matter tags에는 반드시 news와 trend를 포함해라.\n"
  : "\n\n## 추가 분류 규칙\n\n- 이 글은 일반 topic 초안이다.\n- front matter categories와 tags에는 news 또는 trend를 절대 사용하지 마라.\n";

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
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlInlineListItems(value) {
  const match = value.match(/^\s*\[(.*)\]\s*$/);

  if (!match) {
    return [];
  }

  return match[1]
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function yamlStringList(items) {
  return `[${items.map(yamlDoubleQuoted).join(", ")}]`;
}

function upsertFrontMatterStringList(markdown, key, items) {
  const frontMatter = markdown.match(/^---\s*\n([\s\S]*?)\n---/);

  if (!frontMatter) {
    return markdown;
  }

  const lines = frontMatter[1].split("\n");
  const line = `${key}: ${yamlStringList(items)}`;
  const lineIndex = lines.findIndex((item) => item.startsWith(`${key}:`));

  if (lineIndex >= 0) {
    lines[lineIndex] = line;
  } else {
    const insertAfterKeys = key === "tags" ? ["categories:", "date:", "slug:", "title:"] : ["date:", "slug:", "title:"];
    const insertIndex = lines.findLastIndex((item) =>
      insertAfterKeys.some((prefix) => item.startsWith(prefix))
    );
    lines.splice(insertIndex >= 0 ? insertIndex + 1 : 0, 0, line);
  }

  return `---\n${lines.join("\n")}\n---${markdown.slice(frontMatter[0].length)}`;
}

function normalizeFrontMatterStringList(markdown, key) {
  const items = yamlInlineListItems(frontMatterValue(markdown, key));

  if (!items.length) {
    return markdown;
  }

  return upsertFrontMatterStringList(markdown, key, items);
}

function enforceCandidateKindFrontMatter(markdown) {
  const reserved = new Set(["news", "trend"]);
  const originalCategories = yamlInlineListItems(frontMatterValue(markdown, "categories"));
  const categories = originalCategories.filter(
    (item) => !reserved.has(item.toLowerCase())
  );
  const tags = yamlInlineListItems(frontMatterValue(markdown, "tags")).filter(
    (item) => !reserved.has(item.toLowerCase())
  );

  if (isNewTrend) {
    for (const requiredTag of ["news", "trend"]) {
      if (!tags.some((item) => item.toLowerCase() === requiredTag)) {
        tags.push(requiredTag);
      }
    }
  } else if (!tags.length) {
    tags.push("development");
  }

  if (!categories.length && originalCategories.length) {
    categories.push("Architecture");
  }

  let nextMarkdown = markdown;

  if (categories.length) {
    nextMarkdown = upsertFrontMatterStringList(nextMarkdown, "categories", categories);
  }

  return upsertFrontMatterStringList(nextMarkdown, "tags", tags);
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

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `${command} ${commandArgs.join(" ")} failed with exit code ${code}\n${stderr || stdout}`
        )
      );
    });
  });
}

async function generateThumbnail({ slug, title, subtitle }) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tech-blog-thumbnail-input-"));
  const inputPath = path.join(tempDir, "thumbnail-input.json");

  try {
    await fs.writeFile(
      inputPath,
      `${JSON.stringify({ slug, title, subtitle }, null, 2)}\n`,
      "utf8"
    );

    await run(process.execPath, [
      path.join("scripts", "generate-thumbnail.mjs"),
      "--input",
      inputPath,
      "--output-name",
      THUMBNAIL_OUTPUT_NAME
    ]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  return `${PUBLIC_POST_IMAGE_ROOT}/${slug}/${THUMBNAIL_OUTPUT_NAME}`;
}

async function generatePostThumbnail({ markdown, slug }) {
  const thumbnail = selectedTopic.thumbnail ?? {};
  const subtitle = String(thumbnail.subtitle ?? selectedTopic.subtitle ?? "").trim();

  if (!subtitle) {
    return null;
  }

  const title = String(thumbnail.title ?? frontMatterValue(markdown, "title") ?? topic).trim();
  const path = await generateThumbnail({ slug, title, subtitle });

  return {
    path,
    alt: `${title} 썸네일`
  };
}

function plainTextSummary(markdown) {
  const body = markdown.replace(/^---\s*\n[\s\S]*?\n---/, "").trim();
  const firstParagraph = body
    .split(/\n{2,}/)
    .map((paragraph) =>
      paragraph
        .replace(/```[\s\S]*?```/g, "")
        .replace(/^#+\s+/gm, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[*_`>#-]/g, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .find(Boolean);

  return (firstParagraph || topic).slice(0, 280);
}

function normalizeInlinePostImages(markdown, slug) {
  const lines = markdown.split("\n");
  const nextLines = [];
  let imageCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const imageMatch = lines[index].match(/^\s*(?:[-*]\s*)?!\[([^\]]+)\]\([^)]+\)\s*$/);

    if (!imageMatch) {
      nextLines.push(lines[index]);
      continue;
    }

    imageCount += 1;

    if (imageCount > 2) {
      nextLines.push(lines[index]);
      continue;
    }

    const alt = imageMatch[1].trim();

    if (!alt) {
      nextLines.push(lines[index]);
      continue;
    }

    nextLines.push(`![${alt}](${PUBLIC_POST_IMAGE_ROOT}/${slug}/image-${imageCount}.webp)`);

    if (/^\s*이미지 출처:\s*AI 생성 이미지\s*$/.test(lines[index + 1] ?? "")) {
      index += 1;
    }

    nextLines.push("이미지 출처: AI 생성 이미지");
  }

  return nextLines.join("\n");
}

async function writeGitHubOutputs(outputs) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  const lines = [];

  for (const [key, value] of Object.entries(outputs)) {
    const text = String(value ?? "");
    const delimiter = `EOF_${key.toUpperCase()}`;

    if (text.includes("\n")) {
      lines.push(`${key}<<${delimiter}`, text, delimiter);
    } else {
      lines.push(`${key}=${text}`);
    }
  }

  await fs.appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`, "utf8");
}

async function writeTopicManifest({ draftPath, slug, markdown, thumbnailPath }) {
  await fs.mkdir(TOPIC_MANIFEST_DIR, { recursive: true });

  const manifestPath = path.join(TOPIC_MANIFEST_DIR, `${date}-${slug}.json`);
  const manifest = {
    generatedAt: new Date().toISOString(),
    source: {
      workflow: process.env.GITHUB_WORKFLOW ?? "",
      runId: process.env.GITHUB_RUN_ID ?? "",
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? ""
    },
    candidateKind,
    topic,
    topicTitle: topic,
    topicSlug: String(selectedTopic.slug ?? "").trim(),
    topicIdentifiers: topicIdentifiers(selectedTopic),
    post: {
      title: frontMatterValue(markdown, "title"),
      slug,
      draftPath: draftPath.replaceAll("\\", "/"),
      thumbnailPath
    }
  };

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return manifestPath;
}

let slug = sanitizeEnglishSlug(selectedTopic.slug || frontMatterValue(content, "slug"));

if (!slug) {
  slug = await requestEnglishSlug(content);
}

if (!slug) {
  throw new Error("The generated post must have a non-empty English slug.");
}

const draft = await uniqueDraftPath(slug);
let outputContent = upsertFrontMatterValue(content, "slug", `"${draft.slug}"`);
outputContent = normalizeFrontMatterStringList(outputContent, "categories");
outputContent = normalizeFrontMatterStringList(outputContent, "tags");
outputContent = enforceCandidateKindFrontMatter(outputContent);
outputContent = normalizeInlinePostImages(outputContent, draft.slug);
const generatedThumbnail = await generatePostThumbnail({
  markdown: outputContent,
  slug: draft.slug
});

if (generatedThumbnail) {
  outputContent = upsertFrontMatterBlock(outputContent, "image", [
    "image:",
    `  path: ${generatedThumbnail.path}`,
    `  alt: ${yamlDoubleQuoted(generatedThumbnail.alt)}`
  ]);
}

await fs.mkdir("_drafts", { recursive: true });
await fs.writeFile(draft.filepath, outputContent, "utf8");
const manifestPath = await writeTopicManifest({
  draftPath: draft.filepath,
  slug: draft.slug,
  markdown: outputContent,
  thumbnailPath: generatedThumbnail?.path ?? ""
});

console.log(`Selected topic: ${topic}`);
console.log(`English slug: ${draft.slug}`);
console.log(`Generated thumbnail: ${generatedThumbnail ? generatedThumbnail.path : "skipped"}`);
console.log(`Created draft: ${draft.filepath}`);
console.log(`Created topic manifest: ${manifestPath}`);

await writeGitHubOutputs({
  topic,
  title: frontMatterValue(outputContent, "title"),
  slug: draft.slug,
  draft_path: draft.filepath.replaceAll("\\", "/"),
  manifest_path: manifestPath.replaceAll("\\", "/"),
  candidate_kind: candidateKind,
  summary: plainTextSummary(outputContent)
});
