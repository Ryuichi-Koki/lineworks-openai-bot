import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = process.cwd();
const imagePath = path.join(projectRoot, "assets", "line-rich-menu.png");
const receiptPath = path.join(projectRoot, ".tools", "line-rich-menu-last.json");
const argv = process.argv.slice(2);
const args = new Set(argv);
const apply = args.has("--apply");
const statusOnly = args.has("--status");
const accountWideChangeConfirmed = args.has("--confirm-account-wide-change");

// どの環境の認証情報を使うかは常に明示させる。
// 既定の .env.local は開発用アカウントを指していることがあるため、
// 本番へ適用する場合は --env=.env.production.local のように指定する。
const envFileArg = argv.find((value) => value.startsWith("--env="));
const envFile = envFileArg ? envFileArg.slice("--env=".length).trim() : ".env.local";
if (!envFile || envFile.includes("..") || path.isAbsolute(envFile)) {
  throw new Error("--env must be a project-relative env filename");
}

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
  ...parseEnvFile(path.join(projectRoot, envFile)),
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
  const { width: expectedWidth, height: expectedHeight } = richMenuDefinition.size;
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(
      `Expected ${expectedWidth}x${expectedHeight} PNG, received ${width}x${height}`,
    );
  }
  if (image.byteLength > 1024 * 1024) {
    throw new Error("Rich menu image must not exceed 1 MB");
  }
  return { image, width, height, bytes: image.byteLength };
}

// 上部130pxは個人情報の注意表示。タップ領域は割り当てない。
const MENU_TOP = 130;
const ROW_HEIGHT = 778;
const COLUMN_X = [0, 833, 1666];
const COLUMN_WIDTH = [833, 833, 834];

function cell(column, row) {
  return {
    x: COLUMN_X[column],
    y: MENU_TOP + row * ROW_HEIGHT,
    width: COLUMN_WIDTH[column],
    height: ROW_HEIGHT,
  };
}

export const richMenuDefinition = {
  size: { width: 2500, height: 1686 },
  selected: true,
  name: "スグ税 会員メニュー",
  chatBarText: "メニュー",
  // すべてpostback。message actionは利用者の発言として残るため使わない
  // （「契約管理」を押しただけで「退会したい」と発言した扱いになるのを防ぐ）。
  areas: [
    {
      bounds: cell(0, 0),
      action: {
        type: "postback",
        label: "質問する",
        data: "action=start_question",
        displayText: "質問のしかたを確認します",
      },
    },
    {
      bounds: cell(1, 0),
      // 料金の確認と申し込みを分離する。ここでは決済ページを作らない。
      action: {
        type: "postback",
        label: "料金プラン",
        data: "action=show_pricing",
        displayText: "料金プランを見ます",
      },
    },
    {
      bounds: cell(2, 0),
      action: {
        type: "postback",
        label: "税理士に相談",
        data: "action=start_tax_review_intake",
        displayText: "税理士に相談します",
      },
    },
    {
      bounds: cell(0, 1),
      action: {
        type: "postback",
        label: "マイページ",
        data: "action=show_status",
        displayText: "現在の会員状態を確認します",
      },
    },
    {
      bounds: cell(1, 1),
      action: {
        type: "postback",
        label: "契約管理",
        data: "action=open_billing_portal",
        displayText: "契約管理を開きます",
      },
    },
    {
      bounds: cell(2, 1),
      action: {
        type: "postback",
        label: "規約・ヘルプ",
        data: "action=show_legal",
        displayText: "規約・各種情報を見ます",
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
          envFile,
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
            `Credentials are read from ${envFile}. ` +
            "Run with --status for a read-only account check and confirm the displayName " +
            "before using --apply --confirm-account-wide-change.",
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
          envFile,
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
      envFile,
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

// richMenuDefinition をテストから読み込めるように、
// 直接実行されたときだけ処理を走らせる。
const executedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (executedDirectly) {
  await main();
}
