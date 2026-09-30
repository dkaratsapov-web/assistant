/**
 * Связь с YouGile по MCP.
 *
 * MCP — протокол, которым ИИ-клиенты ходят во внешние системы. Для бота он
 * избыточен (ему хватило бы одного REST-запроса), но у YouGile он включается
 * в кабинете одним переключателем и выдаёт токен — а значит, не требует
 * возиться с выпуском ключа компании.
 *
 * Разговор идёт по JSON-RPC поверх HTTP. Ответ приходит либо обычным JSON,
 * либо потоком событий — по спецификации клиент обязан понимать оба, поэтому
 * оба и разбираем.
 *
 * Имена инструментов заранее неизвестны: их отдаёт сам сервер в tools/list.
 * Это единственное, в чём MCP здесь действительно помогает — не надо гадать.
 */
import { Env } from "./types";

const DEFAULT_URL = "https://ru.yougile.com/data/ai/mcp";
const PROTOCOL = "2025-06-18";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

export function yougileUrl(env: Env): string {
  return env.YOUGILE_MCP_URL || DEFAULT_URL;
}

export function yougileConfigured(env: Env): boolean {
  return !!env.YOUGILE_TOKEN;
}

/**
 * Достаёт ответ JSON-RPC из тела. Поток событий приходит строками «data: {…}»,
 * и нужный ответ — последний с нашим id: до него могут идти служебные события.
 */
export function parseRpcBody(body: string, id: number): any | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try { return JSON.parse(trimmed); } catch { return null; }
  }
  let found: any = null;
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    try {
      const obj = JSON.parse(raw);
      if (obj && obj.id === id) found = obj;
      else if (!found && obj && obj.result !== undefined) found = obj;
    } catch {
      // служебная строка потока — пропускаем
    }
  }
  return found;
}

/** Подходит ли инструмент под то, что нам нужно: все слова должны быть в имени. */
export function pickTool(tools: McpTool[], words: string[]): McpTool | null {
  const need = words.map((w) => w.toLowerCase());
  let best: McpTool | null = null;
  for (const t of tools) {
    const name = String(t.name ?? "").toLowerCase();
    if (!need.every((w) => name.includes(w))) continue;
    // Из подходящих берём с самым коротким именем: оно обычно и есть основное
    if (!best || name.length < best.name.length) best = t;
  }
  return best;
}

interface Session {
  id: string;
  server: string;
}

async function rpc(env: Env, method: string, params: unknown, id: number, sessionId?: string): Promise<{ body: string; status: number; session: string | null }> {
  const res = await fetch(yougileUrl(env), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // По спецификации клиент обязан объявить оба формата ответа
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${env.YOUGILE_TOKEN}`,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { body: await res.text(), status: res.status, session: res.headers.get("mcp-session-id") };
}

/** Рукопожатие. Возвращает идентификатор сессии — его требуют следующие вызовы. */
export async function mcpConnect(env: Env): Promise<Session> {
  if (!yougileConfigured(env)) throw new Error("YouGile не подключён: нужен секрет YOUGILE_TOKEN.");
  const r = await rpc(env, "initialize", {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: "sara-assistant", version: "1.0" },
  }, 1);
  if (r.status >= 400) throw new Error(`YouGile ответил ${r.status}: ${r.body.slice(0, 200)}`);
  const obj = parseRpcBody(r.body, 1);
  if (obj?.error) throw new Error(`YouGile отказал: ${JSON.stringify(obj.error).slice(0, 200)}`);
  const sessionId = r.session ?? "";
  // Сервер ждёт уведомление о готовности; ответа на него нет и быть не должно
  try { await rpc(env, "notifications/initialized", {}, 2, sessionId); } catch { /* не критично */ }
  return { id: sessionId, server: obj?.result?.serverInfo?.name ?? "неизвестно" };
}

export async function mcpTools(env: Env, session: Session): Promise<McpTool[]> {
  const r = await rpc(env, "tools/list", {}, 3, session.id);
  if (r.status >= 400) throw new Error(`tools/list ответил ${r.status}: ${r.body.slice(0, 200)}`);
  const obj = parseRpcBody(r.body, 3);
  if (obj?.error) throw new Error(`tools/list отказал: ${JSON.stringify(obj.error).slice(0, 200)}`);
  const list = obj?.result?.tools;
  return Array.isArray(list) ? list : [];
}

export async function mcpCall(env: Env, session: Session, name: string, args: Record<string, unknown>): Promise<string> {
  const r = await rpc(env, "tools/call", { name, arguments: args }, 4, session.id);
  if (r.status >= 400) throw new Error(`Вызов ${name} ответил ${r.status}: ${r.body.slice(0, 200)}`);
  const obj = parseRpcBody(r.body, 4);
  if (obj?.error) throw new Error(`Вызов ${name} отказал: ${JSON.stringify(obj.error).slice(0, 200)}`);
  const content = obj?.result?.content;
  if (Array.isArray(content)) {
    return content.map((c: { text?: string }) => c?.text ?? "").filter(Boolean).join("\n").slice(0, 600);
  }
  return JSON.stringify(obj?.result ?? {}).slice(0, 600);
}

/**
 * Подбирает аргументы под схему инструмента: у разных серверов поля зовутся
 * по-разному («title» или «name», «deadline» или «dueDate»). Берём первое имя,
 * которое сервер действительно объявил.
 */
export function fitArgs(tool: McpTool, wanted: Record<string, string[]>, values: Record<string, unknown>): Record<string, unknown> {
  const props = Object.keys(tool.inputSchema?.properties ?? {});
  const out: Record<string, unknown> = {};
  for (const [key, aliases] of Object.entries(wanted)) {
    const value = values[key];
    if (value === undefined || value === null || value === "") continue;
    const hit = aliases.find((a) => props.includes(a));
    if (hit) out[hit] = value;
  }
  return out;
}
