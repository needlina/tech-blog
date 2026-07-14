import fs from "node:fs/promises";
import path from "node:path";

const TOPICS_PATH = path.join("prompts", "tech-topics.json");
const CANDIDATE_DIR = "candidate-topics";
const DEFAULT_COUNT = 10;
const TIME_ZONE = "Asia/Seoul";

function argValue(name) {
  const index = process.argv.indexOf(name);

  if (index < 0) {
    return "";
  }

  return process.argv[index + 1] ?? "";
}

function topicTitle(item) {
  if (typeof item === "string") {
    return item;
  }

  return String(item?.title ?? "").trim();
}

function nowParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  })
    .formatToParts(new Date())
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    stamp: `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`
  };
}

async function readTopicPool() {
  const raw = await fs.readFile(TOPICS_PATH, "utf8");
  const pool = JSON.parse(raw.replace(/^\uFEFF/, ""));

  if (!Array.isArray(pool.topics)) {
    throw new Error(`${TOPICS_PATH} must contain a topics array.`);
  }

  return pool;
}

function candidateFromTopic(item, index) {
  return {
    index,
    title: topicTitle(item),
    slug: String(item?.slug ?? "").trim(),
    thumbnail: {
      title: String(item?.thumbnail?.title ?? "").trim(),
      subtitle: String(item?.thumbnail?.subtitle ?? "").trim()
    },
    reason: "기존 기술 블로그 주제 큐의 미사용 후보입니다.",
    source: "prompts/tech-topics.json"
  };
}

function markdownBody(candidateFile, candidates) {
  const checklist = candidates
    .map((item) => `- [ ] ${item.index}. ${item.title}`)
    .join("\n");
  const details = candidates
    .map(
      (item) =>
        `### ${item.index}. ${item.title}\n\n- slug: \`${item.slug || "auto"}\`\n- 추천 이유: ${item.reason}\n- 썸네일: ${item.thumbnail.title || item.title} / ${item.thumbnail.subtitle || "자동 생성"}`
    )
    .join("\n\n");

  return [
    "# AI 주제 후보",
    "",
    "마음에 드는 주제를 댓글로 선택하면 선택한 주제만 초안 PR을 생성합니다.",
    "",
    "예시:",
    "",
    "```text",
    "pick 2,3",
    "```",
    "",
    `후보 파일: \`${candidateFile}\``,
    "",
    "## 선택할 주제",
    "",
    checklist,
    "",
    "## 후보 상세",
    "",
    details,
    ""
  ].join("\n");
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

const count = Number.parseInt(argValue("--count"), 10) || DEFAULT_COUNT;
const pool = await readTopicPool();
const candidates = pool.topics
  .filter((item) => !item.usedAt)
  .slice(0, count)
  .map((item, index) => candidateFromTopic(item, index + 1));

if (!candidates.length) {
  throw new Error("No unused topic candidates are available.");
}

const { stamp } = nowParts();
const candidateFile = path.join(CANDIDATE_DIR, `${stamp}-tech-blog.json`);
const bodyFile = path.join(CANDIDATE_DIR, `${stamp}-tech-blog.md`);
const payload = {
  generatedAt: new Date().toISOString(),
  blog: "tech-blog",
  source: TOPICS_PATH,
  candidates
};

await fs.mkdir(CANDIDATE_DIR, { recursive: true });
await fs.writeFile(candidateFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
await fs.writeFile(bodyFile, markdownBody(candidateFile.replaceAll("\\", "/"), candidates), "utf8");

console.log(`Created candidate file: ${candidateFile}`);
console.log(`Created candidate PR body: ${bodyFile}`);

await writeGitHubOutputs({
  candidate_file: candidateFile.replaceAll("\\", "/"),
  body_file: bodyFile.replaceAll("\\", "/"),
  title: `AI tech blog topic candidates ${stamp}`
});
