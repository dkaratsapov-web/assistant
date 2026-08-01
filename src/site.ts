/**
 * Правки сайта в GitHub‑репозитории по запросу (текст/голос).
 * Безопасный поток: Сара находит нужный файл, ИИ вносит изменение, создаётся ветка + Pull Request
 * (превью с diff). Публикация — только после подтверждения (merge), которое запускает авто‑деплой.
 *
 * Требуются секреты: GITHUB_TOKEN (PAT с доступом к репо), SITE_REPO = "owner/name".
 * Необязательно: SITE_BRANCH (по умолчанию — ветка по умолчанию репозитория).
 */
import { askAI, DEFAULT_MODEL } from "./ai";
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
  return !!(env.GITHUB_TOKEN && env.SITE_REPO && env.ANTHROPIC_API_KEY);
}

/**
 * Вносит правку по запросу: выбирает файл, генерирует новое содержимое, создаёт ветку + PR.
 * Возвращает ссылку на PR и путь файла. Ничего не публикует до merge.
 */
export async function editSite(env: Env, db: DB, request: string): Promise<{ prUrl: string; prNumber: number; file: string }> {
  if (!siteConfigured(env)) throw new Error("Сайт не подключён (нужны GITHUB_TOKEN и SITE_REPO)");
  const repo = env.SITE_REPO!;
  const model = env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;

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
      env.ANTHROPIC_API_KEY!,
      `Файлы сайта:\n${files.join("\n")}\n\nЗапрос: "${request}"\nВыбери ОДИН файл, который нужно изменить. Ответь ТОЛЬКО путём из списка, без пояснений.`,
      model
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
    env.ANTHROPIC_API_KEY!,
    `Ты редактируешь файл сайта \`${file}\`. Текущее содержимое:\n\n${content}\n\n---\nЗадача: ${request}\n\nВерни ПОЛНОЕ новое содержимое файла целиком (только код файла), сохрани стиль и структуру, не добавляй пояснений и markdown-ограждений.`,
    model
  );
  let next = raw.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/i, "").trim();
  if (!next || next === content.trim()) throw new Error("ИИ не внёс изменений — переформулируй запрос");

  // 5) ветка + коммит + PR
  const branch = `sara/edit-${baseSha.slice(0, 6)}-${Math.abs(hash(request + file)) % 100000}`;
  try {
    await gh(env, `/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }) });
  } catch (e) {
    // ветка могла существовать — продолжаем
  }
  await gh(env, `/repos/${repo}/contents/${encodeURIComponent(file).replace(/%2F/g, "/")}`, {
    method: "PUT",
    body: JSON.stringify({ message: `Sara: правка ${file} — ${request.slice(0, 60)}`, content: b64encode(next), branch, sha: cur.sha }),
  });
  const pr = await gh(env, `/repos/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title: `Sara: ${request.slice(0, 70)}`, head: branch, base, body: `Автоправка по запросу: «${request}».\nФайл: \`${file}\`.\n\nПроверь diff и нажми Merge, чтобы опубликовать.` }),
  });
  await db.setSetting("site_last_pr", String(pr.number));
  return { prUrl: pr.html_url, prNumber: pr.number, file };
}

/** Слить последний PR (опубликовать). */
export async function applyLastSiteEdit(env: Env, db: DB): Promise<{ merged: boolean; prNumber: number }> {
  if (!siteConfigured(env)) throw new Error("Сайт не подключён");
  const repo = env.SITE_REPO!;
  const n = parseInt((await db.getSetting("site_last_pr")) ?? "", 10);
  if (!n) throw new Error("Нет ожидающих правок для публикации");
  await gh(env, `/repos/${repo}/pulls/${n}/merge`, { method: "PUT", body: JSON.stringify({ merge_method: "squash" }) });
  await db.setSetting("site_last_pr", "");
  return { merged: true, prNumber: n };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
