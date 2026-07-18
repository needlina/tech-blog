import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const rootDir = process.cwd();
const reportDir = path.join(rootDir, "reports", "ai-content-index");
const args = parseArgs(process.argv.slice(2));
const mode = args.mode ?? process.env.AI_INDEX_MODE ?? "report";
const warnThreshold = numberEnv("AI_INDEX_WARN_THRESHOLD", 61);
const blockThreshold = numberEnv("AI_INDEX_BLOCK_THRESHOLD", 81);
const minExperienceScore = numberEnv("AI_INDEX_MIN_EXPERIENCE_SCORE", 30);
const comparePostCount = numberEnv("AI_INDEX_COMPARE_POSTS", 20);

if (mode === "off") {
  console.log("[AI Content Index] skipped because AI_INDEX_MODE=off");
  process.exit(0);
}

const phraseConfig = await loadPhraseConfig();
const files = await resolveTargetFiles();
const allPosts = await collectMarkdownFiles(["_posts", "posts", "_drafts"]);
const parsedPosts = [];
const errors = [];

for (const file of allPosts) {
  try {
    parsedPosts.push(await parseMarkdownPost(file));
  } catch (error) {
    if (files.includes(file)) {
      errors.push({ file, message: error.message });
    }
  }
}

const reports = [];

for (const file of files) {
  try {
    const post = parsedPosts.find((item) => item.file === file) ?? (await parseMarkdownPost(file));
    const comparePosts = parsedPosts
      .filter((item) => item.file !== file)
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .slice(0, comparePostCount);
    const report = analyzePost(post, comparePosts, phraseConfig);
    reports.push(report);
  } catch (error) {
    reports.push(createErrorReport(file, error));
  }
}

await writeReports(reports, errors);
printConsoleSummary(reports, errors);

if (mode === "block" && reports.some((report) => report.risk.publishDecision === "block")) {
  process.exit(1);
}

process.exit(0);

function parseArgs(argv) {
  const parsed = { files: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--file") {
      parsed.files.push(normalizePath(argv[++index]));
    } else if (arg === "--changed") {
      parsed.changed = true;
    } else if (arg === "--format") {
      parsed.format = argv[++index];
    } else if (arg === "--mode") {
      parsed.mode = argv[++index];
    } else if (arg === "--verbose") {
      parsed.verbose = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

async function loadPhraseConfig() {
  const configPath = path.join(rootDir, "config", "ai-content-phrases.json");
  const defaults = {
    genericPhrases: [
      "이번 글에서는",
      "이번 포스팅에서는",
      "알아보겠습니다",
      "살펴보겠습니다",
      "중요합니다",
      "효율적으로",
      "상황에 따라",
      "적절하게 사용",
      "결론적으로",
      "마무리하면",
      "다양한 방법",
      "장점과 단점",
      "주의해야 합니다",
      "쉽게 이해할 수 있습니다"
    ],
    experienceSignals: [
      "실제로",
      "운영 환경",
      "로컬 환경",
      "테스트 결과",
      "오류가 발생",
      "원인은",
      "수정 후",
      "배포 후",
      "처음에는",
      "로그",
      "측정",
      "확인했다",
      "겪었다"
    ],
    verificationSignals: [
      "공식 문서",
      "공식 안내",
      "출처",
      "참고",
      "검증",
      "테스트",
      "확인 방법",
      "재현",
      "문서 기준",
      "기준일"
    ]
  };

  try {
    return { ...defaults, ...JSON.parse(await fs.readFile(configPath, "utf8")) };
  } catch (error) {
    if (error.code === "ENOENT") {
      return defaults;
    }

    throw error;
  }
}

async function resolveTargetFiles() {
  if (args.files.length > 0) {
    return unique(args.files).filter(isMarkdownPostPath);
  }

  if (args.changed) {
    const changed = await changedMarkdownFiles();

    if (changed.length > 0) {
      return changed;
    }
  }

  return collectMarkdownFiles(["_posts", "posts", "_drafts"]);
}

async function changedMarkdownFiles() {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
      cwd: rootDir,
      encoding: "utf8"
    });

    return unique(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.slice(3).replace(/^"|"$/g, ""))
        .map((file) => normalizePath(file.split(" -> ").pop()))
        .filter(isMarkdownPostPath)
    );
  } catch {
    return [];
  }
}

async function collectMarkdownFiles(dirs) {
  const files = [];

  for (const dir of dirs) {
    await walk(dir, files);
  }

  return unique(files).filter(isMarkdownPostPath);
}

async function walk(relativeDir, files) {
  const absoluteDir = path.join(rootDir, relativeDir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  });

  for (const entry of entries) {
    const relativePath = normalizePath(path.join(relativeDir, entry.name));

    if (entry.isDirectory()) {
      await walk(relativePath, files);
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
}

function isMarkdownPostPath(file) {
  return (
    /^(_posts|posts|_drafts)\//.test(normalizePath(file)) &&
    /\.(md|markdown)$/i.test(file)
  );
}

async function parseMarkdownPost(file) {
  const absolutePath = path.join(rootDir, file);
  const raw = await fs.readFile(absolutePath, "utf8");
  const stat = await fs.stat(absolutePath);
  const frontMatterMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const frontMatterText = frontMatterMatch?.[1] ?? "";
  const body = frontMatterMatch ? raw.slice(frontMatterMatch[0].length) : raw;
  const codeBlocks = [...body.matchAll(/```[\s\S]*?```/g)].map((match) => match[0]);
  const bodyWithoutCode = body.replace(/```[\s\S]*?```/g, " ");
  const headings = [...bodyWithoutCode.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((match) => ({
    level: match[1].length,
    text: stripMarkdown(match[2])
  }));
  const links = [...body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
  const sentences = splitSentences(stripMarkdown(bodyWithoutCode));
  const title = readFrontMatterValue(frontMatterText, "title") ?? headingTitle(headings) ?? path.basename(file);
  const slug = readFrontMatterValue(frontMatterText, "slug") ?? slugFromFilename(file);

  return {
    file,
    slug,
    title,
    raw,
    body,
    bodyWithoutCode,
    frontMatterText,
    codeBlocks,
    headings,
    links,
    sentences,
    modifiedAt: stat.mtimeMs
  };
}

function readFrontMatterValue(frontMatterText, key) {
  const match = frontMatterText.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.+)$`, "m"));

  if (!match) {
    return null;
  }

  return match[1].trim().replace(/^["']|["']$/g, "");
}

function headingTitle(headings) {
  return headings.find((heading) => heading.level === 1)?.text;
}

function slugFromFilename(file) {
  return path
    .basename(file, path.extname(file))
    .replace(/^\d{4}-\d{2}-\d{2}-/, "")
    .toLowerCase();
}

function analyzePost(post, comparePosts, phraseConfig) {
  const metrics = collectMetrics(post, comparePosts, phraseConfig);
  const riskScores = calculateRiskScores(metrics);
  const scores = {
    aiUsage: clamp(
      riskScores.styleRepetition * 0.15 +
        riskScores.genericPhrase * 0.15 +
        riskScores.genericInformation * 0.15 +
        riskScores.lackOfExperience * 0.2 +
        riskScores.lackOfExamples * 0.15 +
        riskScores.lackOfVerification * 0.1 +
        riskScores.massProductionPattern * 0.1
    ),
    experience: clamp(100 - riskScores.lackOfExperience),
    specificity: clamp(
      metrics.codeBlockCount * 8 +
        metrics.commandCount * 6 +
        metrics.versionMentionCount * 8 +
        metrics.filePathMentionCount * 5 +
        metrics.numberWithUnitCount * 4 +
        metrics.errorMessageCount * 8
    ),
    verification: clamp(metrics.linkCount * 10 + metrics.verificationSignalCount * 12),
    originality: clamp(100 - riskScores.styleRepetition)
  };
  const massProduction = decideMassProductionRisk(scores.aiUsage, metrics.maxSimilarity);
  const publishDecision = decidePublishDecision(scores, massProduction);
  const findings = buildFindings(scores, metrics, massProduction);
  const recommendations = buildRecommendations(scores, metrics, massProduction);

  return {
    file: post.file,
    slug: post.slug,
    title: post.title,
    analyzedAt: new Date().toISOString(),
    scores,
    risk: {
      massProduction,
      publishDecision
    },
    metrics,
    findings,
    recommendations
  };
}

function collectMetrics(post, comparePosts, phraseConfig) {
  const plainText = stripMarkdown(post.bodyWithoutCode);
  const words = plainText.match(/[A-Za-z0-9가-힣]+/g) ?? [];
  const genericPhraseCount = countPhrases(plainText, phraseConfig.genericPhrases);
  const experienceSignalCount = countPhrases(plainText, phraseConfig.experienceSignals);
  const verificationSignalCount = countPhrases(plainText, phraseConfig.verificationSignals);
  const similarities = comparePosts.map((other) => ({
    file: other.file,
    slug: other.slug,
    score: similarityScore(plainText, stripMarkdown(other.bodyWithoutCode)),
    headingScore: similarityScore(
      post.headings.map((heading) => heading.text).join(" "),
      other.headings.map((heading) => heading.text).join(" ")
    )
  }));
  const mostSimilar = similarities.sort((a, b) => b.score - a.score)[0];
  const commandCount = countMatches(post.body, /\b(?:npm|pnpm|yarn|git|docker|node|java|mvn|gradle|bundle|jekyll|curl)\s+[^\n`]+/g);
  const versionMentionCount = countMatches(post.body, /\b(?:v)?\d+\.\d+(?:\.\d+)?\b/g);
  const filePathMentionCount = countMatches(post.body, /(?:[\w.-]+\/)+[\w.-]+/g);
  const numberWithUnitCount = countMatches(post.body, /\b\d+(?:\.\d+)?\s?(?:ms|초|분|시간|일|원|만원|GB|MB|%|개|명|회)\b/gi);
  const errorMessageCount = countMatches(post.body, /\b(?:error|exception|failed|warning|오류|실패|경고|에러)\b/gi);

  return {
    wordCount: words.length,
    sentenceCount: post.sentences.length,
    headingCount: post.headings.length,
    codeBlockCount: post.codeBlocks.length,
    linkCount: post.links.length,
    versionMentionCount,
    filePathMentionCount,
    commandCount,
    numberWithUnitCount,
    errorMessageCount,
    genericPhraseCount,
    experienceSignalCount,
    verificationSignalCount,
    maxSimilarity: round(mostSimilar?.score ?? 0, 3),
    maxHeadingSimilarity: round(Math.max(...similarities.map((item) => item.headingScore), 0), 3),
    mostSimilarPost: mostSimilar?.slug ?? null
  };
}

function calculateRiskScores(metrics) {
  const genericPhraseDensity = metrics.sentenceCount === 0 ? 0 : metrics.genericPhraseCount / metrics.sentenceCount;
  const evidenceCount =
    metrics.codeBlockCount +
    metrics.commandCount +
    metrics.versionMentionCount +
    metrics.filePathMentionCount +
    metrics.numberWithUnitCount +
    metrics.errorMessageCount;

  return {
    styleRepetition: clamp(metrics.maxSimilarity * 100),
    genericPhrase: clamp(genericPhraseDensity * 350),
    genericInformation: clamp(80 - evidenceCount * 6),
    lackOfExperience: clamp(85 - metrics.experienceSignalCount * 8 - metrics.errorMessageCount * 6),
    lackOfExamples: clamp(80 - metrics.codeBlockCount * 12 - metrics.commandCount * 8 - metrics.filePathMentionCount * 4),
    lackOfVerification: clamp(80 - metrics.linkCount * 12 - metrics.verificationSignalCount * 8),
    massProductionPattern: clamp(Math.max(metrics.maxSimilarity, metrics.maxHeadingSimilarity) * 100)
  };
}

function decideMassProductionRisk(aiUsageScore, maxSimilarity) {
  if (aiUsageScore >= 81 || maxSimilarity >= 0.82) {
    return "critical";
  }

  if (aiUsageScore >= 66 || maxSimilarity >= 0.68) {
    return "high";
  }

  if (aiUsageScore >= 46 || maxSimilarity >= 0.52) {
    return "medium";
  }

  return "low";
}

function decidePublishDecision(scores, massProduction) {
  if (scores.aiUsage >= blockThreshold || massProduction === "critical") {
    return "block";
  }

  if (scores.aiUsage >= warnThreshold || scores.experience < minExperienceScore) {
    return "warn";
  }

  return "pass";
}

function buildFindings(scores, metrics, massProduction) {
  const findings = [];

  if (scores.aiUsage >= warnThreshold) {
    findings.push("AI-like writing risk is above the warning threshold.");
  }

  if (scores.experience < minExperienceScore) {
    findings.push("Experience evidence is thin: add real environment, trial-and-error, logs, or measured results.");
  }

  if (scores.verification < 45) {
    findings.push("Verification evidence is weak: add official sources, test commands, or confirmation paths.");
  }

  if (scores.specificity < 45) {
    findings.push("Specific details are limited: add versions, commands, file paths, numbers, or concrete examples.");
  }

  if (metrics.maxSimilarity >= 0.6) {
    findings.push(`Structure or wording is similar to a recent post: ${metrics.mostSimilarPost}.`);
  }

  if (massProduction === "high" || massProduction === "critical") {
    findings.push("Mass-production pattern risk is high enough to review before publishing.");
  }

  return findings.length > 0 ? findings : ["No major quality risks were detected by the rule-based checker."];
}

function buildRecommendations(scores, metrics, massProduction) {
  const recommendations = [];

  if (scores.experience < 60) {
    recommendations.push("Add a short first-person review section with the actual environment, what failed first, and what changed after fixing it.");
  }

  if (scores.specificity < 60) {
    recommendations.push("Include concrete versions, commands, file names, dates, amounts, or before/after results.");
  }

  if (scores.verification < 60) {
    recommendations.push("Add official documentation or service pages and describe how the reader can verify the current information.");
  }

  if (metrics.genericPhraseCount >= 5) {
    recommendations.push("Replace generic wrap-up phrases with topic-specific conclusions and next actions.");
  }

  if (massProduction !== "low") {
    recommendations.push("Vary the introduction, heading order, and conclusion so the draft does not mirror recent posts.");
  }

  return recommendations.slice(0, 5);
}

function createErrorReport(file, error) {
  return {
    file,
    slug: slugFromFilename(file),
    title: path.basename(file),
    analyzedAt: new Date().toISOString(),
    scores: {
      aiUsage: 100,
      experience: 0,
      specificity: 0,
      verification: 0,
      originality: 0
    },
    risk: {
      massProduction: "critical",
      publishDecision: "block"
    },
    metrics: {},
    findings: [`Analysis failed: ${error.message}`],
    recommendations: ["Fix the Markdown file so the quality checker can parse it."]
  };
}

async function writeReports(reports, errors) {
  await fs.mkdir(path.join(reportDir, "posts"), { recursive: true });

  for (const report of reports) {
    const safeSlug = report.slug.replace(/[^a-z0-9가-힣._-]+/gi, "-");
    await fs.writeFile(
      path.join(reportDir, "posts", `${safeSlug}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
    await fs.writeFile(path.join(reportDir, "posts", `${safeSlug}.md`), renderPostMarkdown(report), "utf8");
  }

  const summary = summarizeReports(reports, errors);
  await fs.writeFile(path.join(reportDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(reportDir, "summary.md"), renderSummaryMarkdown(summary), "utf8");
  await fs.writeFile(path.join(reportDir, "pr-summary.md"), renderPrSummary(summary), "utf8");
}

function summarizeReports(reports, errors) {
  const counts = {
    pass: reports.filter((report) => report.risk.publishDecision === "pass").length,
    warn: reports.filter((report) => report.risk.publishDecision === "warn").length,
    block: reports.filter((report) => report.risk.publishDecision === "block").length
  };

  return {
    analyzedAt: new Date().toISOString(),
    mode,
    thresholds: {
      warn: warnThreshold,
      block: blockThreshold,
      minExperience: minExperienceScore
    },
    counts,
    errors,
    posts: reports.map((report) => ({
      file: report.file,
      slug: report.slug,
      title: report.title,
      scores: report.scores,
      risk: report.risk,
      findings: report.findings.slice(0, 3),
      recommendations: report.recommendations.slice(0, 3)
    }))
  };
}

function renderPostMarkdown(report) {
  return `# AI Content Index Report

- Post: ${report.title}
- File: \`${report.file}\`
- AI Usage Score: ${report.scores.aiUsage}
- Experience Score: ${report.scores.experience}
- Specificity Score: ${report.scores.specificity}
- Verification Score: ${report.scores.verification}
- Originality Score: ${report.scores.originality}
- Mass Production Risk: ${report.risk.massProduction}
- Publish Decision: ${report.risk.publishDecision}

## Findings

${report.findings.map((item) => `- ${item}`).join("\n")}

## Recommendations

${report.recommendations.map((item) => `- ${item}`).join("\n")}
`;
}

function renderSummaryMarkdown(summary) {
  return `# AI Content Index Summary

- Mode: ${summary.mode}
- Analyzed posts: ${summary.posts.length}
- PASS: ${summary.counts.pass}
- WARN: ${summary.counts.warn}
- BLOCK: ${summary.counts.block}

## Posts

${summary.posts
  .map(
    (post) => `### ${post.risk.publishDecision.toUpperCase()} ${post.title}

- File: \`${post.file}\`
- AI Usage: ${post.scores.aiUsage}
- Experience: ${post.scores.experience}
- Specificity: ${post.scores.specificity}
- Verification: ${post.scores.verification}
- Originality: ${post.scores.originality}

${post.findings.map((item) => `- ${item}`).join("\n")}
`
  )
  .join("\n")}
`;
}

function renderPrSummary(summary) {
  if (summary.posts.length === 0) {
    return "### AI Content Index\n\nNo Markdown draft or post files were analyzed.\n";
  }

  return `### AI Content Index

- Mode: \`${summary.mode}\`
- Result: pass=${summary.counts.pass}, warn=${summary.counts.warn}, block=${summary.counts.block}
- Full report: \`reports/ai-content-index/summary.md\`

${summary.posts
  .map(
    (post) => `#### ${post.risk.publishDecision.toUpperCase()} ${post.title}

| Score | Value |
| --- | ---: |
| AI Usage | ${post.scores.aiUsage} |
| Experience | ${post.scores.experience} |
| Specificity | ${post.scores.specificity} |
| Verification | ${post.scores.verification} |
| Originality | ${post.scores.originality} |

${post.recommendations.slice(0, 3).map((item) => `- ${item}`).join("\n")}
`
  )
  .join("\n")}
`;
}

function printConsoleSummary(reports, errors) {
  console.log(`[AI Content Index] ${reports.length} posts analyzed`);

  for (const report of reports) {
    console.log("");
    console.log(`${report.risk.publishDecision.toUpperCase()} ${report.file}`);
    console.log(`  AI Usage: ${report.scores.aiUsage}`);
    console.log(`  Experience: ${report.scores.experience}`);
    console.log(`  Originality: ${report.scores.originality}`);

    for (const finding of report.findings.slice(0, 3)) {
      console.log(`  - ${finding}`);
    }
  }

  if (errors.length > 0) {
    console.log("");
    console.log(`[AI Content Index] ${errors.length} parser errors`);
  }
}

function stripMarkdown(markdown) {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[[^\]]+\]\([^)]+\)/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/^#{1,6}\s+/gm, " ")
    .replace(/[>*_\-|[\](){}#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?。！？다요죠음함됨임])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function countPhrases(text, phrases) {
  return phrases.reduce((sum, phrase) => sum + countOccurrences(text, phrase), 0);
}

function countOccurrences(text, phrase) {
  if (!phrase) {
    return 0;
  }

  return text.split(phrase).length - 1;
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function similarityScore(a, b) {
  const aSet = ngrams(normalizeForSimilarity(a), 3);
  const bSet = ngrams(normalizeForSimilarity(b), 3);

  if (aSet.size === 0 || bSet.size === 0) {
    return 0;
  }

  let intersection = 0;

  for (const item of aSet) {
    if (bSet.has(item)) {
      intersection += 1;
    }
  }

  return intersection / (aSet.size + bSet.size - intersection);
}

function normalizeForSimilarity(text) {
  return text.toLowerCase().replace(/[^a-z0-9가-힣]+/g, "");
}

function ngrams(text, size) {
  const values = new Set();

  for (let index = 0; index <= text.length - size; index += 1) {
    values.add(text.slice(index, index + size));
  }

  return values;
}

function clamp(score) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizePath(file) {
  return file.replaceAll("\\", "/");
}

function unique(values) {
  return [...new Set(values)];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
