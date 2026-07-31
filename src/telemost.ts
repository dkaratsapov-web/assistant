/**
 * Интеграция с Яндекс Телемост (создание видеовстреч).
 * Docs: https://yandex.ru/dev/telemost/doc/ru/
 *
 * Поток: одноразовый OAuth-вход владельца (scope telemost-api:conferences.create),
 * токены (access/refresh) хранятся в settings D1; access обновляется по refresh.
 */
import { DB } from "./db";
import { Env } from "./types";

const AUTH_URL = "https://oauth.yandex.ru/authorize";
const TOKEN_URL = "https://oauth.yandex.ru/token";
const API_URL = "https://cloud-api.yandex.net/v1/telemost-api/conferences";
const SCOPE = "telemost-api:conferences.create";
const VERIF_URI = "https://oauth.yandex.ru/verification_code";

/** URL для одноразового входа владельца. Если redirectUri не задан — Яндекс покажет код подтверждения. */
export function telemostAuthUrl(clientId: string, redirectUri?: string): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: SCOPE,
    redirect_uri: redirectUri || VERIF_URI,
  });
  return `${AUTH_URL}?${p.toString()}`;
}

interface TokenResp {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResp> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const data = (await res.json()) as TokenResp;
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `token ${res.status}`);
  }
  return data;
}

/** Обменять authorization code (или код подтверждения) на токены и сохранить их. */
export async function telemostExchangeCode(env: Env, db: DB, code: string, redirectUri?: string): Promise<void> {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code: code.trim(),
    client_id: env.TELEMOST_CLIENT_ID ?? "",
    client_secret: env.TELEMOST_CLIENT_SECRET ?? "",
  };
  if (redirectUri) body.redirect_uri = redirectUri;
  const t = await tokenRequest(body);
  await saveTokens(db, t);
}

async function saveTokens(db: DB, t: TokenResp): Promise<void> {
  if (t.access_token) await db.setSetting("telemost_access", t.access_token);
  if (t.refresh_token) await db.setSetting("telemost_refresh", t.refresh_token);
  const exp = Date.now() + (t.expires_in ?? 3600) * 1000;
  await db.setSetting("telemost_exp", String(exp));
}

/** Возвращает валидный access-токен (обновляет по refresh при необходимости). */
async function validToken(env: Env, db: DB): Promise<string> {
  const access = await db.getSetting("telemost_access");
  const refresh = await db.getSetting("telemost_refresh");
  const exp = parseInt((await db.getSetting("telemost_exp")) ?? "0", 10);
  if (!access) throw new Error("Телемост не подключён");
  if (Date.now() > exp - 60_000 && refresh && env.TELEMOST_CLIENT_ID && env.TELEMOST_CLIENT_SECRET) {
    const t = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: env.TELEMOST_CLIENT_ID,
      client_secret: env.TELEMOST_CLIENT_SECRET,
    });
    await saveTokens(db, t);
    return t.access_token!;
  }
  return access;
}

/** Создаёт видеовстречу в Телемосте, возвращает ссылку для подключения. */
export async function telemostCreate(env: Env, db: DB): Promise<string> {
  const token = await validToken(env, db);
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `OAuth ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ access_level: "PUBLIC" }),
  });
  const data = (await res.json().catch(() => ({}))) as { join_url?: string; error?: string; message?: string };
  if (!res.ok || !data.join_url) {
    throw new Error(data.message || data.error || `telemost ${res.status}`);
  }
  return data.join_url;
}

/** Подключён ли Телемост (есть сохранённый токен). */
export async function telemostConnected(db: DB): Promise<boolean> {
  return !!(await db.getSetting("telemost_access"));
}
