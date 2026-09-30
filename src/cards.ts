/**
 * Правки внутри карточек: клиента и задачи.
 *
 * Разбор отдельный от создания, потому что путаница между «завести» и
 * «поправить» стоит дорого. Боевой случай: «добавь клиенту Таллер в карточке
 * ведение 30000» заводило НОВОГО клиента с названием «таллер в карточке
 * ведение 30000» вместо того, чтобы вписать сумму существующему.
 *
 * Разделяет их не формулировка, а факт: если названный клиент уже есть в базе,
 * речь о правке. Этот признак надёжнее любых слов.
 */

/** Числа вида «30000», «30 000», «30к», «30 тыс» → 30000. */
export function parseMoney(text: string): string {
  const m = String(text ?? "").match(/(\d[\d\s]{0,12})\s*(к|k|тыс[а-яё]*|млн)?/i);
  if (!m) return "";
  const base = parseInt(m[1].replace(/\s/g, ""), 10);
  if (!Number.isFinite(base)) return "";
  const mult = /^(к|k|тыс)/i.test(m[2] ?? "") ? 1000 : /^млн/i.test(m[2] ?? "") ? 1_000_000 : 1;
  return String(base * mult);
}

export interface ClientFields {
  fee?: string;
  budget?: string;
  payDue?: string;
  platforms?: string;
  contact?: string;
  metrikaCounter?: string;
  directLogin?: string;
  notes?: string;
}

/** Человеческие подписи полей — для ответа «что именно поменяли». */
export const CLIENT_FIELD_RU: Record<keyof ClientFields, string> = {
  fee: "ведение",
  budget: "бюджет",
  payDue: "оплата",
  platforms: "площадки",
  contact: "контакт",
  metrikaCounter: "счётчик Метрики",
  directLogin: "логин Директа",
  notes: "заметка",
};

/**
 * Достаёт из фразы поля карточки клиента. Пустой результат означает «ничего
 * узнаваемого не сказано» — тогда фраза идёт дальше обычным путём.
 */
export function parseClientFields(text: string): ClientFields {
  const t = String(text ?? "").replace(/ё/g, "е");
  const out: ClientFields = {};
  let m: RegExpMatchArray | null;

  // Деньги. «ведение 30000», «абонентка 30 тыс», «за ведение — 30к»
  if ((m = t.match(/(?:ведени[ея]|абонентк[ауи]|обслуживани[ея])\D{0,12}?(\d[\d\s]*\s*(?:к|k|тыс[а-я]*|млн)?)/i))) {
    const v = parseMoney(m[1]);
    if (v) out.fee = v;
  }
  if ((m = t.match(/бюджет\D{0,12}?(\d[\d\s]*\s*(?:к|k|тыс[а-я]*|млн)?)/i))) {
    const v = parseMoney(m[1]);
    if (v) out.budget = v;
  }
  // Срок оплаты: «оплата до 5 числа», «платит 10 числа», «оплата 15.08»
  if ((m = t.match(/оплат[аыу]\s*(?:до\s*)?(\d{1,2}\s*числ[а-я]*|\d{1,2}\.\d{1,2}(?:\.\d{2,4})?)/i))
    || (m = t.match(/плат(?:ит|ят|еж[а-я]*)\D{0,8}(\d{1,2}\s*числ[а-я]*|\d{1,2}\.\d{1,2})/i))) {
    out.payDue = m[1].replace(/\s+/g, " ").trim();
  }
  // Площадки и услуги
  if ((m = t.match(/(?:площадк[а-я]*|услуг[а-я]*|канал[а-я]*)\s*[:—-]?\s*([^.;!?]{2,60})/i))) {
    const v = m[1].trim().replace(/\s+/g, " ");
    if (v) out.platforms = v;
  }
  // Счётчик Метрики и логин Директа
  if ((m = t.match(/(?:метрик[а-я]*|счетчик[а-я]*)\D{0,10}(\d{5,12})/i))) out.metrikaCounter = m[1];
  if ((m = t.match(/(?:логин\s+директ[а-я]*|директ[а-я]*\s+логин)\s*[:—-]?\s*([\w.@-]{3,40})/i))) out.directLogin = m[1];
  // Контакт: телефон или почта
  if ((m = t.match(/(\+?\d[\d\s()-]{8,16}\d)/))) out.contact = m[1].trim();
  else if ((m = t.match(/([\w.+-]+@[\w-]+\.[a-z]{2,})/i))) out.contact = m[1];
  // Заметка: всё после слова-указателя
  if ((m = t.match(/(?:заметк[а-я]*|комментари[ий][а-я]*|примечани[ея])\s*[:—-]\s*(.+)$/i))) out.notes = m[1].trim().slice(0, 500);

  return out;
}

export interface TaskFields {
  description?: string;
  priority?: number;
}

/** Поля, которые правят внутри задачи: описание и важность. */
export function parseTaskFields(text: string): TaskFields {
  const t = String(text ?? "").replace(/ё/g, "е");
  const out: TaskFields = {};
  let m: RegExpMatchArray | null;

  if ((m = t.match(/(?:описани[ея]|подробност[а-я]*|детал[а-я]*|пометк[а-я]*)\s*[:—-]?\s*(.+)$/i))) {
    const v = m[1].trim();
    if (v.length >= 2) out.description = v.slice(0, 1000);
  }
  // «сделай важной», «это срочно», «высокий приоритет»
  if (/(важн[а-я]*|срочн[а-я]*|приоритет[а-я]*\s*(?:высок[а-я]*|важн[а-я]*)?|горит)/i.test(t)) {
    out.priority = /(не\s+важн|обычн|низк|не\s+срочн|сними\s+важн)/i.test(t) ? 0 : 1;
  }
  return out;
}

/** Есть ли вообще что применять. */
export function hasFields(f: object): boolean {
  return Object.values(f).some((v) => v !== undefined && v !== "");
}
