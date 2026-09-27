/**
 * Штампует метку сборки перед деплоем.
 *
 * Зачем: раньше метка была вписана в код руками и не менялась месяцами, поэтому
 * по /version нельзя было понять, доехал деплой или нет — проверка обманывала.
 *
 * Запускается вручную перед коммитом (npm run stamp), а НЕ на стороне сборки.
 * Через wrangler.toml его подключать нельзя: любая ошибка скрипта там валит
 * деплой целиком, а цена вопроса — всего лишь строчка на /version.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";

const date = new Date().toISOString().slice(0, 16).replace("T", " ");
let commit = "";
try {
  commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch {
  // сборка может идти без истории git — тогда обойдёмся датой
}

const stamp = commit ? `${date} · ${commit}` : date;
fs.writeFileSync("src/build.ts", `// Файл создаётся скриптом scripts/stamp-build.mjs при каждой сборке.\nexport const BUILD = ${JSON.stringify(stamp)};\n`);
console.log("метка сборки:", stamp);
