import { existsSync, readFileSync } from "node:fs";

if (!existsSync(".env.local")) {
  throw new Error(".env.local が見つかりません");
}

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r\n|\n|\r/u)) {
  if (!line || line.startsWith("#") || !line.includes("=")) continue;
  const [key, ...parts] = line.split("=");
  env[key.replace(/^\uFEFF/, "")] = parts.join("=").replace(/^['"]|['"]$/g, "");
}

function required(name) {
  if (!env[name]) throw new Error(`${name} が未設定です`);
  return env[name];
}

const lineResponse = await fetch("https://api.line.me/v2/bot/info", {
  headers: {
    Authorization: `Bearer ${required("LINE_CHANNEL_ACCESS_TOKEN")}`,
  },
});

console.log(`line.ok=${lineResponse.ok} status=${lineResponse.status}`);

const redisUrl = required("UPSTASH_REDIS_REST_URL");
const redisToken = required("UPSTASH_REDIS_REST_TOKEN");
const testKey = `codex:connection-test:${Date.now()}`;
const redisHeaders = {
  Authorization: `Bearer ${redisToken}`,
  "Content-Type": "application/json",
};

const setResponse = await fetch(redisUrl, {
  method: "POST",
  headers: redisHeaders,
  body: JSON.stringify(["SET", testKey, "ok", "EX", "60"]),
});
const getResponse = await fetch(redisUrl, {
  method: "POST",
  headers: redisHeaders,
  body: JSON.stringify(["GET", testKey]),
});
const getBody = getResponse.ok ? await getResponse.json() : {};
await fetch(redisUrl, {
  method: "POST",
  headers: redisHeaders,
  body: JSON.stringify(["DEL", testKey]),
});

console.log(
  `upstash.ok=${setResponse.ok && getResponse.ok && getBody.result === "ok"} set=${setResponse.status} get=${getResponse.status}`,
);

if (!lineResponse.ok || !setResponse.ok || !getResponse.ok || getBody.result !== "ok") {
  process.exitCode = 1;
}
