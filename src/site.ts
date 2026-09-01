/**
 * Правки сайта в GitHub‑репозитории по запросу (текст/голос).
 * Поток: Сара выбирает нужный файл, ИИ переписывает его целиком, изменение коммитится
 * ПРЯМО в ветку деплоя — автодеплой публикует правку сразу. Прежнее содержимое файла
 * сохраняется в settings (`site_undo`), поэтому последнюю правку можно откатить одной
 * командой («откати сайт» / /site_undo). Глубина отката — одна правка.
 *
 * Требуются секреты: GITHUB_TOKEN (PAT с доступом к репо), SITE_REPO = "owner/name",
 * а также ключ YandexGPT (YANDEX_API_KEY + YANDEX_FOLDER_ID).
 * Необязательно: SITE_BRANCH (по умолчанию — ветка по умолчанию репозитория).
 */
import { aiConfig, askAI } from "./ai";
import { DB } from "./db";
import { Env } from "./types";

const GH = "https://api.github.com";
const TEXT_EXT = /\.(html?|css|js|jsx|ts|tsx|json|md|txt|vue|svelte|astro|xml|svg)$/i;

function b64encode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decode(b64: string): string {
  const bin = atob((b64 || "").replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function gh(env: Env, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${GH}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "assistant-sara",
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).message || `GitHub ${res.status}`);
  return data;
}

export function siteConfigured(env: Env): boolean {
  return !!(env.GITHUB_TOKEN && env.SITE_REPO && env.YANDEX_API_KEY && env.YANDEX_FOLDER_ID);
}

/**
 * Вносит правку по запросу: выбирает файл, генерирует новое содержимое и коммитит его
 * в ветку деплоя (правка публикуется автодеплоем сразу). Прежнее содержимое кладём в
 * `site_undo` — для отката через revertLastSiteEdit(). Возвращает ссылку на коммит и путь файла.
 */
export async function editSite(env: Env, db: DB, request: string): Promise<{ commitUrl: string; file: string; branch: string }> {
  if (!siteConfigured(env)) throw new Error("Сайт не подключён (нужны GITHUB_TOKEN и SITE_REPO)");
  const repo = env.SITE_REPO!;
  const ai = aiConfig(env)!;

  const repoInfo = await gh(env, `/repos/${repo}`);
  const base = env.SITE_BRANCH || repoInfo.default_branch || "main";

  // 1) дерево файлов
  const ref = await gh(env, `/repos/${repo}/git/ref/heads/${base}`);
  const baseSha = ref.object.sha;
  const tree = await gh(env, `/repos/${repo}/git/trees/${baseSha}?recursive=1`);
  const files: string[] = (tree.tree || [])
    .filter((t: any) => t.type === "blob" && TEXT_EXT.test(t.path) && t.size < 200000)
    .map((t: any) => t.path)
    .slice(0, 300);
  if (!files.length) throw new Error("В репозитории не найдено текстовых файлов для правки");

  // 2) выбор файла
  let file = files[0];
  if (files.length > 1) {
    const pick = await askAI(
      ai,
      `Файлы сайта:\n${files.join("\n")}\n\nЗапрос: "${request}"\nВыбери ОДИН файл, который нужно изменить. Ответь ТОЛЬКО путём из списка, без пояснений.`
    );
    const cand = pick.trim().split(/\s|\n/)[0].replace(/[`"']/g, "");
    if (files.includes(cand)) file = cand;
    else file = files.find((f) => /index\.html?$/i.test(f)) || files.find((f) => /\.html?$/i.test(f)) || files[0];
  }

  // 3) текущее содержимое
  const cur = await gh(env, `/repos/${repo}/contents/${encodeURIComponent(file).replace(/%2F/g, "/")}?ref=${base}`);
  const content = b64decode(cur.content);
  if (content.length > 60000) throw new Error(`Файл ${file} слишком большой для авто‑правки`);

  // 4) новое содержимое
  const raw = await askAI(
    ai,
    `Ты редактируешь файл сайта \`${file}\`. Текущее содержимое:\n\n${content}\n\n---\nЗадача: ${request}\n\nВерни ПОЛНОЕ новое содержимое файла целиком (только код файла), сохрани стиль и структуру, не добавляй пояснений и markdown-ограждений.`
  );
  let next = raw.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/i, "").trim();
  if (!next || next === content.trim()) throw new Error("ИИ не внёс изменений — переформулируй запрос");

  // 5) коммит прямо в ветку деплоя → автодеплой опубликует. Старое содержимое сохраняем для отката.
  const put = await gh(env, `/repos/${repo}/contents/${encodeURIComponent(file).replace(/%2F/g, "/")}`, {
    method: "PUT",
    body: JSON.stringify({ message: `Sara: ${request.slice(0, 64)}`, content: b64encode(next), branch: base, sha: cur.sha }),
  });
  await db.setSetting("site_undo", JSON.stringify({ file, content, ts: put.commit?.sha || "" }));
  return { commitUrl: put.commit?.html_url || `https://github.com/${repo}/commits/${base}`, file, branch: base };
}

/** Откатить последнюю правку сайта (вернуть прежнее содержимое файла) — тоже через автодеплой. */
export async function revertLastSiteEdit(env: Env, db: DB): Promise<{ file: string; commitUrl: string }> {
  if (!siteConfigured(env)) throw new Error("Сайт не подключён");
  const repo = env.SITE_REPO!;
  const raw = await db.getSetting("site_undo");
  if (!raw) throw new Error("Нет правок для отката");
  const undo = JSON.parse(raw) as { file: string; content: string };
  const repoInfo = await gh(env, `/repos/${repo}`);
  const base = env.SITE_BRANCH || repoInfo.default_branch || "main";
  const cur = await gh(env, `/repos/${repo}/contents/${encodeURIComponent(undo.file).replace(/%2F/g, "/")}?ref=${base}`);
  const put = await gh(env, `/repos/${repo}/contents/${encodeURIComponent(undo.file).replace(/%2F/g, "/")}`, {
    method: "PUT",
    body: JSON.stringify({ message: `Sara: откат правки ${undo.file}`, content: b64encode(undo.content), branch: base, sha: cur.sha }),
  });
  await db.setSetting("site_undo", "");
  return { file: undo.file, commitUrl: put.commit?.html_url || `https://github.com/${repo}/commits/${base}` };
}
