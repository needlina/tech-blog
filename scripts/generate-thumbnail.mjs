import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const DEFAULT_INPUT_PATH = "thumbnail-input.json";
const DEFAULT_TEMPLATE_PATH = path.join("_templates", "tech-blog-thumbnail.pptx");
const DEFAULT_OUTPUT_NAME = "preview.png";
const TOPICS_PATH = path.join("prompts", "tech-topics.json");
const POST_IMAGE_ROOT = path.join("assets", "img", "posts", "blog");
const PUBLIC_POST_IMAGE_ROOT = "/assets/img/posts/blog";
const SOFFICE_CANDIDATES =
  process.platform === "win32"
    ? [
        "soffice.com",
        "soffice",
        "C:\\Program Files\\LibreOffice\\program\\soffice.com",
        "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
        "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com",
        "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe"
      ]
    : ["soffice"];
const TOKEN_MAP = {
  "{제목}": "title",
  "{부제목}": "subtitle"
};

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input ?? DEFAULT_INPUT_PATH;
const topicSlug = args.slug;
const templatePath = args.template ?? DEFAULT_TEMPLATE_PATH;
const outputName = args.outputName ?? DEFAULT_OUTPUT_NAME;
const keepPptx = Boolean(args.keepPptx);
const skipRender = Boolean(args.skipRender);

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

    if (["keepPptx", "skipRender"].includes(key)) {
      parsed[key] = true;
      continue;
    }

    const value = inlineValue ?? argv[index + 1];

    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawKey}`);
    }

    parsed[key] = value;

    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return parsed;
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      shell: false,
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

function powershellExe() {
  return process.platform === "win32" ? "powershell.exe" : "pwsh";
}

function psString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function runPowerShell(script) {
  return run(powershellExe(), [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script
  ]);
}

async function pathExists(filepath) {
  return fs
    .stat(filepath)
    .then(() => true)
    .catch(() => false);
}

function sanitizeSlug(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/['`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeItems(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload.posts)) {
    return payload.posts;
  }

  if (payload && typeof payload === "object") {
    return [payload];
  }

  throw new Error("Input JSON must be an object, an array, or an object with a posts array.");
}

async function readJson(filepath) {
  const raw = await fs.readFile(filepath, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

async function readItems() {
  if (args.input) {
    return normalizeItems(await readJson(inputPath));
  }

  if (!topicSlug && (await pathExists(inputPath))) {
    return normalizeItems(await readJson(inputPath));
  }

  if (topicSlug) {
    const topicPool = await readJson(TOPICS_PATH);

    if (!Array.isArray(topicPool.topics)) {
      throw new Error(`${TOPICS_PATH} must contain a topics array.`);
    }

    const topic = topicPool.topics.find((item) => item.slug === topicSlug);

    if (!topic) {
      throw new Error(`Topic slug not found in ${TOPICS_PATH}: ${topicSlug}`);
    }

    return [
      {
        slug: topic.slug,
        title: topic.thumbnail?.title ?? topic.title,
        subtitle: topic.thumbnail?.subtitle ?? topic.subtitle
      }
    ];
  }

  throw new Error(
    `Input file not found: ${inputPath}. Provide --input <json-path> or --slug <topic-slug>.`
  );
}

function validateItem(item, index) {
  const slug = sanitizeSlug(item.slug);
  const title = String(item.title ?? "").trim();
  const subtitle = String(item.subtitle ?? item.subTitle ?? "").trim();

  if (!slug) {
    throw new Error(`Item ${index + 1} is missing slug.`);
  }

  if (!title) {
    throw new Error(`Item ${index + 1} is missing title.`);
  }

  if (!subtitle) {
    throw new Error(`Item ${index + 1} is missing subtitle.`);
  }

  return { slug, title, subtitle };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeXmlText(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function findTextNodes(xml) {
  const nodes = [];
  const pattern = /<a:t>([\s\S]*?)<\/a:t>/g;
  let match;

  while ((match = pattern.exec(xml))) {
    nodes.push({
      start: match.index,
      end: pattern.lastIndex,
      textStart: match.index + "<a:t>".length,
      textEnd: pattern.lastIndex - "</a:t>".length,
      text: unescapeXmlText(match[1])
    });
  }

  return nodes;
}

function replaceTokenInXml(xml, token, value) {
  let nextXml = xml;
  let replacements = 0;

  while (true) {
    const nodes = findTextNodes(nextXml);
    const fullText = nodes.map((node) => node.text).join("");
    const tokenStart = fullText.indexOf(token);

    if (tokenStart < 0) {
      break;
    }

    const tokenEnd = tokenStart + token.length;
    let cursor = 0;
    const updates = [];

    for (const node of nodes) {
      const nodeStart = cursor;
      const nodeEnd = cursor + node.text.length;
      cursor = nodeEnd;

      if (nodeEnd <= tokenStart || nodeStart >= tokenEnd) {
        continue;
      }

      const overlapStart = Math.max(tokenStart, nodeStart);
      const overlapEnd = Math.min(tokenEnd, nodeEnd);
      const before = node.text.slice(0, overlapStart - nodeStart);
      const after = node.text.slice(overlapEnd - nodeStart);

      updates.push({ node, before, after });
    }

    if (!updates.length) {
      break;
    }

    let replacementApplied = false;
    let rebuilt = "";
    let lastIndex = 0;

    for (const update of updates) {
      rebuilt += nextXml.slice(lastIndex, update.node.textStart);

      if (!replacementApplied) {
        rebuilt += escapeXml(`${update.before}${value}${update.after}`);
        replacementApplied = true;
      } else {
        rebuilt += escapeXml(update.before + update.after);
      }

      lastIndex = update.node.textEnd;
    }

    rebuilt += nextXml.slice(lastIndex);
    nextXml = rebuilt;
    replacements += 1;
  }

  return { xml: nextXml, replacements };
}

async function extractPptx(pptxPath, outputDir) {
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  if (process.platform === "win32") {
    const input = psString(path.resolve(pptxPath));
    const output = psString(path.resolve(outputDir));
    await runPowerShell(
      [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -AssemblyName System.IO.Compression",
        "Add-Type -AssemblyName System.IO.Compression.FileSystem",
        `[System.IO.Compression.ZipFile]::ExtractToDirectory(${input}, ${output})`
      ].join("; ")
    );
    return;
  }

  await run("unzip", ["-q", path.resolve(pptxPath), "-d", path.resolve(outputDir)]);
}

async function zipPptx(sourceDir, pptxPath) {
  await fs.rm(pptxPath, { force: true });
  await fs.mkdir(path.dirname(pptxPath), { recursive: true });

  if (process.platform === "win32") {
    const input = psString(path.resolve(sourceDir));
    const output = psString(path.resolve(pptxPath));
    await runPowerShell(
      [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -AssemblyName System.IO.Compression",
        "Add-Type -AssemblyName System.IO.Compression.FileSystem",
        `$source = ${input}`,
        `$destination = ${output}`,
        "$zip = [System.IO.Compression.ZipFile]::Open($destination, [System.IO.Compression.ZipArchiveMode]::Create)",
        "try {",
        "  Get-ChildItem -LiteralPath $source -Recurse -Force -File | ForEach-Object {",
        "    $relative = ($_.FullName.Substring($source.Length) -replace '^[\\\\/]+', '') -replace '\\\\', '/'",
        "    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $relative) | Out-Null",
        "  }",
        "} finally {",
        "  $zip.Dispose()",
        "}"
      ].join("; ")
    );
    return;
  }

  await run("zip", ["-qr", path.resolve(pptxPath), "."], { cwd: sourceDir });
}

async function fillTemplate({ item, workspaceDir }) {
  const unzipDir = path.join(workspaceDir, "template");
  const outputPptx = path.join(workspaceDir, `${item.slug}.pptx`);

  await extractPptx(templatePath, unzipDir);

  const slidesDir = path.join(unzipDir, "ppt", "slides");
  const slideFiles = (await fs.readdir(slidesDir))
    .filter((filename) => /^slide\d+\.xml$/.test(filename))
    .map((filename) => path.join(slidesDir, filename));

  const replacementCounts = Object.fromEntries(
    Object.keys(TOKEN_MAP).map((token) => [token, 0])
  );

  for (const slideFile of slideFiles) {
    let xml = await fs.readFile(slideFile, "utf8");

    for (const [token, field] of Object.entries(TOKEN_MAP)) {
      const result = replaceTokenInXml(xml, token, item[field]);
      xml = result.xml;
      replacementCounts[token] += result.replacements;
    }

    await fs.writeFile(slideFile, xml, "utf8");
  }

  const missingTokens = Object.entries(replacementCounts)
    .filter(([, count]) => count === 0)
    .map(([token]) => token);

  if (missingTokens.length) {
    throw new Error(`Template placeholders were not found: ${missingTokens.join(", ")}`);
  }

  await zipPptx(unzipDir, outputPptx);

  return outputPptx;
}

async function commandExists(command) {
  const lookupCommand = process.platform === "win32" ? "where.exe" : "which";
  const lookupArgs = [command];

  return run(lookupCommand, lookupArgs)
    .then(() => true)
    .catch(() => false);
}

async function resolveSofficeCommand() {
  for (const candidate of SOFFICE_CANDIDATES) {
    if (candidate.includes("\\") || candidate.includes("/")) {
      if (await pathExists(candidate)) {
        return candidate;
      }

      continue;
    }

    if (await commandExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function renderWithPowerPoint(pptxPath, outputPath) {
  if (process.platform !== "win32") {
    throw new Error("PowerPoint export is only available on Windows.");
  }

  const input = psString(path.resolve(pptxPath));
  const output = psString(path.resolve(outputPath));

  await runPowerShell(
    [
      "$ErrorActionPreference = 'Stop'",
      `$pptx = ${input}`,
      `$output = ${output}`,
      "$powerPoint = New-Object -ComObject PowerPoint.Application",
      "$presentation = $null",
      "try {",
      "  $presentation = $powerPoint.Presentations.Open($pptx, $true, $true, $false)",
      "  $presentation.Slides.Item(1).Export($output, 'PNG')",
      "} finally {",
      "  if ($presentation -ne $null) { $presentation.Close() }",
      "  $powerPoint.Quit()",
      "}"
    ].join("; ")
  );
}

async function renderWithLibreOffice(sofficeCommand, pptxPath, outputPath, workspaceDir) {
  const renderDir = path.join(workspaceDir, "rendered");
  const profileDir = path.join(workspaceDir, "lo-profile");
  await fs.rm(renderDir, { recursive: true, force: true });
  await fs.rm(profileDir, { recursive: true, force: true });
  await fs.mkdir(renderDir, { recursive: true });
  await fs.mkdir(profileDir, { recursive: true });

  await run(sofficeCommand, [
    "--headless",
    "--invisible",
    "--nodefault",
    "--nolockcheck",
    "--nologo",
    "--nofirststartwizard",
    `-env:UserInstallation=${pathToFileUrl(profileDir)}`,
    "--convert-to",
    "png",
    "--outdir",
    renderDir,
    path.resolve(pptxPath)
  ]);

  const pngFiles = (await fs.readdir(renderDir))
    .filter((filename) => filename.toLowerCase().endsWith(".png"))
    .sort();

  if (!pngFiles.length) {
    throw new Error("LibreOffice did not create a PNG file.");
  }

  await fs.copyFile(path.join(renderDir, pngFiles[0]), outputPath);
}

function pathToFileUrl(filepath) {
  const normalized = path.resolve(filepath).replace(/\\/g, "/");
  const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;

  return `file://${prefixed.replace(/ /g, "%20")}`;
}

async function renderFirstSlide(pptxPath, outputPath, workspaceDir) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const attempts = [];

  if (process.platform === "win32") {
    try {
      await renderWithPowerPoint(pptxPath, outputPath);
      return "powerpoint";
    } catch (error) {
      attempts.push(`PowerPoint COM: ${error.message}`);
    }
  }

  const sofficeCommand = await resolveSofficeCommand();

  if (sofficeCommand) {
    try {
      await renderWithLibreOffice(sofficeCommand, pptxPath, outputPath, workspaceDir);
      return "libreoffice";
    } catch (error) {
      attempts.push(`LibreOffice: ${error.message}`);
    }
  } else {
    attempts.push("LibreOffice: soffice was not found in PATH or the default install paths.");
  }

  throw new Error(
    [
      "Could not render the thumbnail PNG.",
      "Install Microsoft PowerPoint on Windows or LibreOffice with soffice in PATH.",
      ...attempts
    ].join("\n")
  );
}

async function main() {
  if (!(await pathExists(templatePath))) {
    throw new Error(`Template file not found: ${templatePath}`);
  }

  const items = (await readItems()).map(validateItem);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tech-blog-thumbnail-"));
  const generated = [];

  try {
    for (const item of items) {
      const workspaceDir = path.join(tempRoot, item.slug);
      const outputDir = path.join(POST_IMAGE_ROOT, item.slug);
      const outputPath = path.join(outputDir, outputName);
      const publicPath = `${PUBLIC_POST_IMAGE_ROOT}/${item.slug}/${outputName}`;

      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(outputDir, { recursive: true });
      const pptxPath = await fillTemplate({ item, workspaceDir });

      let renderer = "skipped";

      if (!skipRender) {
        renderer = await renderFirstSlide(pptxPath, outputPath, workspaceDir);
      }

      if (keepPptx) {
        await fs.copyFile(pptxPath, path.join(outputDir, `${path.parse(outputName).name}.pptx`));
      }

      generated.push({ slug: item.slug, path: publicPath, renderer });
    }
  } finally {
    if (!keepPptx) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }

  for (const item of generated) {
    console.log(`${item.slug}: ${item.path} (${item.renderer})`);
  }
}

await main();
