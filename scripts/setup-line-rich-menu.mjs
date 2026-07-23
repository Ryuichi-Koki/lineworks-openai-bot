import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const imagePath = path.join(projectRoot, "assets", "line-rich-menu.png");
const receiptPath = path.join(projectRoot, ".tools", "line-rich-menu-last.json");
const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const statusOnly = args.has("--status");
const accountWideChangeConfirmed = args.has("--confirm-account-wide-change");

if (apply && !accountWideChangeConfirmed) {
  throw new Error(
    "--apply requires --confirm-account-wide-change because it replaces the account-wide default rich menu",
  );
}

function parseEnvFile(filename) {
  if (!existsSync(filename)) return {};
  const result = {};
  for (const line of readFileSync(filename, "utf8").split(/\r\n|\n|\r/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match || match[2] === "") continue;
    result[match[1]] = match[2].replace(/^(['"])(.*)\1$/u, "$2");
  }
  return result;
}

const env = {
  ...parseEnvFile(path.join(projectRoot, ".env.local")),
  ...process.env,
};

function requireEnv(name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validatePng(filename) {
  if (!existsSync(filename)) {
    throw new Error(`Rich menu image not found: ${filename}`);
  }
  const image = readFileSync(filename);
  const pngSignature = "89504e470d0a1a0a";
  if (image.subarray(0, 8).toString("hex") !== pngSignature) {
    throw new Error("Rich menu image must be PNG");
  }
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  if (width !== 2500 || height !== 843) {
    throw new Error(`Expected 2500x843 PNG, received ${width}x${height}`);
  }
  if (image.byteLength > 1024 * 1024) {
    throw new Error("Rich menu image must not exceed 1 MB");
  }
  return { image, width, height, bytes: image.byteLength };
}

export const richMenuDefinition = {
  size: { width: 2500, height: 843 },
  selected: true,
  name: "ApexBrain 会員メニュー",
  chatBarText: "会員メニュー",
  areas: [
    {
      bounds: { x: 0, y: 0, width: 625, height: 843 },
      action: {
        type: "message",
        label: "有料会員になる",
        text: "料金を教えて",
      },
    },
    {
      bounds: { x: 625, y: 0, width: 625, height: 843 },
      action: {
        type: "postback",
        label: "無料会員で始める",
        data: "action=select_free_membership",
        displayText: "無料会員で始める",
      },
    },
    {
      bounds: { x: 1250, y: 0, width: 625, height: 843 },
      action: {
        type: "postback",
        label: "税理士へ相談",
        data: "action=start_tax_review_intake",
        displayText: "税理士へ相談",
      },
    },
    {
      bounds: { x: 1875, y: 0, width: 625, height: 843 },
      action: {
        type: "message",
        label: "退会・契約管理",
        text: "退会したい",
      },
    },
  ],
};

async function lineRequest(url, options = {}) {
  const token = requireEnv("LINE_CHANNEL_ACCESS_TOKEN");
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `LINE API request failed (${response.status}): ${body.slice(0, 300)}`,
    );
  }
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function verifyTargetAccount() {
  const expectedBasicId = requireEnv("LINE_RICH_MENU_EXPECTED_BASIC_ID");
  const bot = await lineRequest("https://api.line.me/v2/bot/info");
  if (bot.basicId !== expectedBasicId) {
    throw new Error(
      `Target account mismatch: expected ${expectedBasicId}, received ${bot.basicId ?? "unknown"}`,
    );
  }
  return { basicId: bot.basicId, displayName: bot.displayName ?? "unknown" };
}

async function currentDefaultRichMenu() {
  const token = requireEnv("LINE_CHANNEL_ACCESS_TOKEN");
  const response = await fetch(
    "https://api.line.me/v2/bot/user/all/richmenu",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (response.status === 404) return null;
  if (response.status === 403) {
    throw new Error(
      "A default rich menu is managed outside this Messaging API channel. " +
        "Inspect it in LINE Official Account Manager before replacing it.",
    );
  }
  if (!response.ok) {
    throw new Error(`Failed to inspect the default rich menu (${response.status})`);
  }
  const body = await response.json();
  return body.richMenuId ?? null;
}

async function main() {
  const image = validatePng(imagePath);
  if (!apply && !statusOnly) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          valid: true,
          image: {
            path: path.relative(projectRoot, imagePath),
            width: image.width,
            height: image.height,
            bytes: image.bytes,
          },
          selectedByDefault: richMenuDefinition.selected,
          chatBarText: richMenuDefinition.chatBarText,
          actions: richMenuDefinition.areas.map((area) => area.action.label),
          next:
            "Run with --status for a read-only account check. " +
            "Use --apply --confirm-account-wide-change only after explicit approval.",
        },
        null,
        2,
      ),
    );
    return;
  }

  const account = await verifyTargetAccount();
  const previousDefaultRichMenuId = await currentDefaultRichMenu();
  if (statusOnly) {
    console.log(
      JSON.stringify(
        {
          account,
          defaultRichMenuId: previousDefaultRichMenuId,
        },
        null,
        2,
      ),
    );
    return;
  }

  await lineRequest("https://api.line.me/v2/bot/richmenu/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(richMenuDefinition),
  });

  let createdRichMenuId = null;
  let defaultSet = false;
  try {
    const created = await lineRequest("https://api.line.me/v2/bot/richmenu", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(richMenuDefinition),
    });
    createdRichMenuId = created.richMenuId;
    if (!createdRichMenuId) throw new Error("LINE did not return a richMenuId");

    await lineRequest(
      `https://api-data.line.me/v2/bot/richmenu/${encodeURIComponent(createdRichMenuId)}/content`,
      {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: image.image,
      },
    );
    await lineRequest(
      `https://api.line.me/v2/bot/user/all/richmenu/${encodeURIComponent(createdRichMenuId)}`,
      { method: "POST" },
    );
    defaultSet = true;

    const receipt = {
      account,
      richMenuId: createdRichMenuId,
      previousDefaultRichMenuId,
      appliedAt: new Date().toISOString(),
    };
    mkdirSync(path.dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ applied: true, ...receipt }, null, 2));
  } catch (error) {
    if (createdRichMenuId && !defaultSet) {
      await lineRequest(
        `https://api.line.me/v2/bot/richmenu/${encodeURIComponent(createdRichMenuId)}`,
        { method: "DELETE" },
      ).catch(() => undefined);
    }
    throw error;
  }
}

await main();
