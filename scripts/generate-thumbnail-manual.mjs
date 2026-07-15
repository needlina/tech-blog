import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const thumbnailScript = path.join(scriptDir, "generate-thumbnail.mjs");

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const parsed = { passthrough: [] };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

    if (["keepPptx", "skipRender"].includes(key)) {
      parsed.passthrough.push(arg);
      continue;
    }

    const value = inlineValue ?? argv[index + 1];

    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawKey}`);
    }

    if (["template", "outputName"].includes(key)) {
      parsed.passthrough.push(`--${rawKey}`, value);
    } else if (["title", "subtitle", "slug"].includes(key)) {
      parsed[key] = value;
    } else {
      throw new Error(`Unknown option: --${rawKey}`);
    }

    if (inlineValue === undefined) {
      index += 1;
    }
  }

  parsed.title ??= positionals[0];
  parsed.subtitle ??= positionals[1];

  if (positionals.length > 2) {
    throw new Error(`Unknown arguments: ${positionals.slice(2).join(" ")}`);
  }

  return parsed;
}

function usage() {
  return [
    "Usage:",
    '  node scripts/generate-thumbnail-manual.mjs --title "Title" --subtitle "Subtitle"',
    '  node scripts/generate-thumbnail-manual.mjs "Title" "Subtitle"',
    "",
    "Options:",
    "  --slug <slug>              Output folder name. Defaults to manual-thumbnail-YYYYMMDD-HHMMSS.",
    "  --template <pptx-path>     Forwarded to generate-thumbnail.mjs.",
    "  --output-name <filename>   Forwarded to generate-thumbnail.mjs.",
    "  --keep-pptx                Forwarded to generate-thumbnail.mjs.",
    "  --skip-render              Forwarded to generate-thumbnail.mjs."
  ].join("\n");
}

function timestampSlug() {
  const now = new Date();
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0")
  ];

  return `manual-thumbnail-${parts.join("")}`;
}

function validateText(value, field) {
  const text = String(value ?? "").trim();

  if (!text) {
    throw new Error(`${field} is required.\n\n${usage()}`);
  }

  return text;
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      shell: false,
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${commandArgs.join(" ")} failed with exit code ${code}`));
    });
  });
}

async function main() {
  const title = validateText(args.title, "title");
  const subtitle = validateText(args.subtitle, "subtitle");
  const slug = args.slug ?? timestampSlug();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tech-blog-thumbnail-manual-"));
  const inputPath = path.join(tempDir, "thumbnail-input.json");

  try {
    await fs.writeFile(
      inputPath,
      `${JSON.stringify({ slug, title, subtitle }, null, 2)}\n`,
      "utf8"
    );

    await run(
      process.execPath,
      [thumbnailScript, "--input", inputPath, ...args.passthrough],
      { cwd: repoRoot }
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

await main();
