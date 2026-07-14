import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";

const TOPICS_PATH = path.join("prompts", "tech-topics.json");
const CANDIDATE_DIR = "candidate-topics";
const DEFAULT_COUNT = 10;
const TIME_ZONE = "Asia/Seoul";
const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  throw new Error("OPENAI_API_KEY is required.");
}

const client = new OpenAI({ apiKey });
const candidateKind = argValue("--kind") === "new-trend" ? "new-trend" : "topic";

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

function parseJsonArray(text) {
  const withoutFence = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  return JSON.parse(withoutFence);
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

function normalizeCandidate(item, index) {
  return {
    index,
    title: topicTitle(item),
    slug: String(item?.slug ?? "").trim(),
    thumbnail: {
      title: String(item?.thumbnail?.title ?? "").trim(),
      subtitle: String(item?.thumbnail?.subtitle ?? "").trim()
    },
    reason: String(item?.reason ?? "").trim(),
    searchIntent: String(item?.searchIntent ?? "").trim(),
    practicalValue: String(item?.practicalValue ?? "").trim(),
    freshnessReason: String(item?.freshnessReason ?? "").trim(),
    sourceHint: String(item?.sourceHint ?? "").trim(),
    source: candidateKind === "new-trend" ? "openai-new-trend-candidates" : "openai-topic-candidates"
  };
}

async function requestFreshCandidates(count, previousTopics) {
  const topicPrompt = [
    `한국어 실무 기술 블로그용 일반 주제 후보 ${count}개를 JSON 배열로만 작성해라.`,
    "각 항목은 반드시 객체이며 title, slug, thumbnail, reason, searchIntent, practicalValue, freshnessReason, sourceHint 키를 포함해라.",
    "thumbnail은 title과 subtitle 키를 가진 객체여야 한다.",
    "slug는 lowercase ASCII kebab-case, 80자 이하로 작성해라.",
    "마크다운, 코드펜스, 설명 문장은 절대 넣지 마라.",
    "주제는 실무 개발자가 바로 검색하거나 적용할 만한 구체적인 문제 해결형 제목이어야 한다.",
    "Backend, Database, PostgreSQL, Docker, Linux, DevOps, Cloud, Security, Testing, Observability, Frontend, Architecture, Blogging을 고르게 섞어라.",
    "news, trend, 뉴스, 트렌드라는 카테고리나 태그가 필요한 주제는 만들지 마라.",
    "reason은 추천 이유, searchIntent는 검색자가 알고 싶은 핵심, practicalValue는 실무 적용 가치, freshnessReason은 현재 기준 확인이 필요한 이유를 한 문장으로 작성하라.",
    "sourceHint에는 확인하면 좋은 공식 문서, 릴리즈 노트, 표준 문서, 벤더 문서 종류를 적어라.",
    "아래 기존 주제와 의미가 겹치지 않게 작성하라.",
    JSON.stringify(previousTopics, null, 2)
  ];
  const newTrendPrompt = [
    `한국어 실무 기술 블로그용 신규 뉴스/트렌드 후보 ${count}개를 JSON 배열로만 작성해라.`,
    "각 항목은 반드시 객체이며 title, slug, thumbnail, reason, searchIntent, practicalValue, freshnessReason, sourceHint 키를 포함해라.",
    "thumbnail은 title과 subtitle 키를 가진 객체여야 한다.",
    "slug는 lowercase ASCII kebab-case, 80자 이하로 작성해라.",
    "마크다운, 코드펜스, 설명 문장은 절대 넣지 마라.",
    "주제는 최근 릴리즈, 보안 권고, 주요 라이브러리/런타임 변경, 클라우드/DevOps 도구 변경, 개발 생태계 트렌드처럼 최신성 때문에 확인 가치가 있는 내용이어야 한다.",
    "단순 evergreen 튜토리얼이 아니라 현재 시점의 변화나 새 이슈를 따라잡는 글감이어야 한다.",
    "reason은 추천 이유, searchIntent는 검색자가 알고 싶은 핵심, practicalValue는 실무 적용 가치, freshnessReason은 지금 확인해야 하는 이유를 한 문장으로 작성하라.",
    "sourceHint에는 공식 문서, 릴리즈 노트, 보안 권고, 벤더 블로그, 표준 문서 같은 확인 출처를 적어라.",
    "아래 기존 일반 주제와 의미가 겹치지 않게 작성하라.",
    JSON.stringify(previousTopics, null, 2)
  ];
  const response = await client.responses.create({
    model: "gpt-5-mini",
    input: (candidateKind === "new-trend" ? newTrendPrompt : topicPrompt).join("\n\n")
  });

  const candidates = parseJsonArray(response.output_text);

  if (!Array.isArray(candidates) || candidates.length < count) {
    throw new Error(`The candidate response must be a JSON array with at least ${count} items.`);
  }

  return candidates.slice(0, count).map((item, index) => normalizeCandidate(item, index + 1));
}

function markdownBody(candidateFile, candidates) {
  const heading = candidateKind === "new-trend" ? "AI 신규 트렌드 후보" : "AI 주제 후보";
  const description =
    candidateKind === "new-trend"
      ? "마음에 드는 신규 뉴스/트렌드 주제를 댓글로 선택하면 선택한 주제만 news/trend 태그가 붙은 초안 PR을 생성합니다."
      : "마음에 드는 주제를 댓글로 선택하면 선택한 주제만 일반 초안 PR을 생성합니다.";
  const checklist = candidates
    .map((item) => `- [ ] ${item.index}. ${item.title}`)
    .join("\n");
  const details = candidates
    .map(
      (item) =>
        `### ${item.index}. ${item.title}\n\n- slug: \`${item.slug || "auto"}\`\n- 추천 이유: ${item.reason}\n- 검색 의도: ${item.searchIntent}\n- 실무 가치: ${item.practicalValue}\n- 최신성 포인트: ${item.freshnessReason}\n- 확인 권장 출처: ${item.sourceHint}\n- 썸네일: ${item.thumbnail.title || item.title} / ${item.thumbnail.subtitle || "자동 생성"}`
    )
    .join("\n\n");

  return [
    `# ${heading}`,
    "",
    description,
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
const previousTopics = pool.topics.map(topicTitle).filter(Boolean);
const candidates = await requestFreshCandidates(count, previousTopics);

if (!candidates.length) {
  throw new Error("No unused topic candidates are available.");
}

const { stamp } = nowParts();
const candidateFile = path.join(CANDIDATE_DIR, `${stamp}-tech-blog-${candidateKind}.json`);
const bodyFile = path.join(CANDIDATE_DIR, `${stamp}-tech-blog-${candidateKind}.md`);
const payload = {
  generatedAt: new Date().toISOString(),
  blog: "tech-blog",
  kind: candidateKind,
  source: candidateKind === "new-trend" ? "openai-new-trend-candidates" : "openai-topic-candidates",
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
  title:
    candidateKind === "new-trend"
      ? `AI tech blog new trend candidates ${stamp}`
      : `AI tech blog topic candidates ${stamp}`
});
