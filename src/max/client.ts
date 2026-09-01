/**
 * Тонкий HTTP-клиент MAX Bot API (мессенджер MAX, platform-api.max.ru).
 * Документация: https://dev.max.ru/docs-api
 *
 * Авторизация: токен бота (из @BotFather внутри MAX) передаётся в заголовке
 * Authorization. Для совместимости дублируем legacy-параметром ?access_token=.
 * Базовый хост настраивается через env MAX_API_URL (на случай миграции на
 * platform-api2.max.ru).
 */

export interface MaxUser {
  user_id: number;
  name?: string;
  username?: string;
  is_bot?: boolean;
}

/** Вложение сообщения MAX (нужны ссылка на файл и тип). */
export interface MaxAttachment {
  type: string; // image | video | audio | file | sticker | contact | share | location | inline_keyboard
  payload?: { url?: string; token?: string; photo_id?: number };
  filename?: string;
  size?: number;
}

export interface MaxMessage {
  sender?: MaxUser;
  recipient?: { chat_id?: number; chat_type?: string; user_id?: number };
  body?: { mid?: string; seq?: number; text?: string; attachments?: MaxAttachment[] };
  timestamp?: number;
}

/** Входящее обновление MAX (webhook или long polling). */
export interface MaxUpdate {
  update_type: string; // message_created | message_callback | bot_started | ...
  timestamp?: number;
  message?: MaxMessage;
  // bot_started
  chat_id?: number;
  user?: MaxUser;
  // message_callback
  callback?: { callback_id: string; payload?: string; user?: MaxUser };
}

/** Кнопка inline-клавиатуры. */
export interface MaxButton {
  type: "callback" | "link" | "open_app";
  text: string;
  payload?: string;  // для callback (и стартовый параметр для open_app)
  url?: string;      // для link
  web_app?: string;  // для open_app: публичное имя или адрес мини-приложения
  contact_id?: number; // для open_app: id бота, к которому привязано мини-приложение
}

const DEFAULT_API = "https://platform-api.max.ru";

export class MaxClient {
  constructor(
    private token: string,
    private apiUrl: string = DEFAULT_API
  ) {}

  private async request<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {}
  ): Promise<T> {
    const url = new URL(this.apiUrl.replace(/\/$/, "") + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    // legacy-совместимость: некоторые окружения ещё принимают токен в query
    url.searchParams.set("access_token", this.token);

    const res = await fetch(url.toString(), {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as T;
    if (!res.ok) {
      throw new Error(`MAX API ${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
    }
    return data;
  }

  /** Информация о боте. */
  getMe(): Promise<MaxUser> {
    return this.request<MaxUser>("GET", "/me");
  }

  private keyboardAttachment(keyboard?: MaxButton[][]) {
    if (!keyboard || !keyboard.length) return undefined;
    return [{ type: "inline_keyboard", payload: { buttons: keyboard } }];
  }

  /** Отправить текстовое сообщение пользователю или в чат. */
  async sendMessage(
    to: { userId?: number; chatId?: number },
    text: string,
    keyboard?: MaxButton[][]
  ): Promise<void> {
    await this.request("POST", "/messages", {
      query: { user_id: to.userId, chat_id: to.chatId },
      body: { text, attachments: this.keyboardAttachment(keyboard) },
    });
  }

  /** Ответить на нажатие callback-кнопки (всплывающее уведомление или замена сообщения). */
  async answerCallback(callbackId: string, opts: { notification?: string } = {}): Promise<void> {
    await this.request("POST", "/answers", {
      query: { callback_id: callbackId },
      body: { notification: opts.notification },
    });
  }

  /** Подписать webhook на обновления. */
  async subscribe(url: string, secret: string, updateTypes: string[]): Promise<void> {
    await this.request("POST", "/subscriptions", {
      body: { url, secret, update_types: updateTypes },
    });
  }

  /** Список активных webhook-подписок. */
  getSubscriptions(): Promise<unknown> {
    return this.request("GET", "/subscriptions");
  }

  /** Отписать webhook. */
  async unsubscribe(url: string): Promise<void> {
    await this.request("DELETE", "/subscriptions", { query: { url } });
  }
}
