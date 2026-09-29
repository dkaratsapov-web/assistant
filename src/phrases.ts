/**
 * База формулировок: как люди на самом деле говорят с Сарой.
 *
 * Зачем она. Маршрутизатор работает на дешёвой модели, а такие модели гораздо
 * точнее следуют живым примерам, чем описанию правил. Поэтому к подсказке
 * подмешиваются несколько примеров, наиболее похожих на текущую фразу.
 *
 * Правило пополнения: каждая фраза, которую бот понял неправильно, попадает
 * сюда вместе с верным разбором — и заодно становится тестом. Так однажды
 * исправленное недопонимание не возвращается.
 *
 * Все примеры записаны при одном и том же времени — REFERENCE_NOW. В подсказке
 * это сказано отдельно, чтобы модель не путала их даты с настоящим «сейчас».
 */

export const REFERENCE_NOW = "2026-07-31 16:00, четверг";

export interface PhraseExample {
  /** Как сказал человек. */
  text: string;
  /** Что должен вернуть маршрутизатор — ровно та строка, которую мы ждём. */
  json: string;
  /** Чем пример ценен: обычно это разбор реальной ошибки. */
  why?: string;
}

/** Короткая запись примера: остальные поля модель заполняет пустыми. */
const ex = (text: string, obj: Record<string, string>, why?: string): PhraseExample => ({
  text,
  json: JSON.stringify(obj),
  why,
});

export const PHRASES: PhraseExample[] = [
  // ---------- Задачи ----------
  ex("напомни в пятницу отправить отчёт", { action: "task", title: "Отправить отчёт", due: "2026-08-01 10:00", scope: "work" }),
  ex("надо к понедельнику подготовить смету", { action: "task", title: "Подготовить смету", due: "2026-08-03 10:00", scope: "work" }),
  ex("не забыть забрать документы завтра", { action: "task", title: "Забрать документы", due: "2026-08-01 10:00", scope: "personal" }),
  ex("поставь задачу продлить домен до 5 числа", { action: "task", title: "Продлить домен", due: "2026-08-05 10:00", scope: "work" }),
  ex("запиши дело: позвонить в банк", { action: "task", title: "Позвонить в банк", scope: "work" }),
  ex("надо оплатить счёт ромашке", { action: "task", title: "Оплатить счёт", scope: "work", client: "Ромашка" },
     "клиента называют в родительном или дательном падеже — его надо вернуть в client"),
  ex("завтра забрать ребёнка из садика в 18", { action: "task", title: "Забрать ребёнка из садика", due: "2026-08-01 18:00", scope: "personal" }),

  // ---------- Задачи: закрыть и удалить ----------
  ex("отчёт готов", { action: "task_done", title: "Отчёт" }),
  ex("сделал смету", { action: "task_done", title: "Смета" }),
  ex("отметь задачу про домен выполненной", { action: "task_done", title: "Домен" }),
  ex("закрой задачу по лендингу", { action: "task_done", title: "лендинг" }),
  ex("с отчётом закончил", { action: "task_done", title: "отчёт" }),
  ex("созвон с банком провёл", { action: "task_done", title: "банк" }),

  // ---------- Изменение уже созданной задачи ----------
  // Разница с "task" тонкая и модель на ней ошибается: «напомни завтра позвонить» —
  // новая задача, «перенеси звонок на завтра» — правка существующей.
  ex("перенеси задачу по отчёту на пятницу", { action: "task_edit", title: "отчёт", due: "2026-08-01 10:00" },
     "«перенеси» — всегда правка существующей задачи, а не новая"),
  ex("сдвинь смету на понедельник", { action: "task_edit", title: "смета", due: "2026-08-03 10:00" }),
  ex("поменяй срок у домена на 10 число", { action: "task_edit", title: "домен", due: "2026-08-10 10:00" }),
  ex("переименуй задачу отчёт в квартальный отчёт", { action: "task_edit", title: "отчёт", new_name: "Квартальный отчёт" }),
  ex("назови задачу по лендингу «Лендинг под Директ»", { action: "task_edit", title: "лендинг", new_name: "Лендинг под Директ" }),
  ex("взял в работу лендинг", { action: "task_edit", title: "лендинг", status: "in_progress" }),
  ex("начал делать смету", { action: "task_edit", title: "смета", status: "in_progress" },
     "«начал делать» — это статус существующей задачи, а не новая задача"),
  ex("верни отчёт в работу", { action: "task_edit", title: "отчёт", status: "open" }),
  ex("сделай задачу про врача личной", { action: "task_edit", title: "врач", scope: "personal" }),
  ex("привяжи задачу по отчёту к Ромашке", { action: "task_edit", title: "отчёт", client: "Ромашка" }),
  ex("убери срок у задачи про домен", { action: "task_edit", title: "домен" },
     "срок снимается по словам в самой фразе — отдельного поля для этого нет"),

  // ---------- Изменение встречи ----------
  ex("перенеси встречу с Ромашкой на 16:00", { action: "event_edit", title: "Ромашка", at: "2026-07-31 16:00", client: "Ромашка" }),
  ex("сдвинь планёрку на час позже", { action: "event_edit", title: "планёрка" }),
  ex("встреча с банком будет в офисе", { action: "event_edit", title: "банк", location: "офис" }),
  ex("перенеси на пятницу", { action: "task_edit", title: "", due: "2026-08-01 10:00" },
     "без названия — речь о том, о чём говорили только что"),

  // ---------- Вопросы о своих записях ----------
  // Это НЕ "none": на такие вопросы ответ собирается из базы, а не сочиняется.
  ex("что у меня сегодня", { action: "query", title: "что у меня сегодня" }),
  ex("что у меня завтра", { action: "query", title: "что у меня завтра" }),
  ex("какие задачи по Ромашке", { action: "query", title: "какие задачи по Ромашке", client: "Ромашка" }),
  ex("что просрочено", { action: "query", title: "что просрочено" }),
  ex("сколько у меня дел висит", { action: "query", title: "сколько у меня дел висит" }),
  ex("когда встреча с банком", { action: "query", title: "когда встреча с банком" }),
  ex("что я сделал на этой неделе", { action: "query", title: "что я сделал на этой неделе" }),
  ex("покажи клиентов", { action: "query", title: "покажи клиентов" }),

  ex("удали задачу позвонить в банк", { action: "task_delete", title: "Позвонить в банк" }),
  ex("убери из списка смету", { action: "task_delete", title: "Смета" }),

  // ---------- Встречи ----------
  ex("встреча с айпапа завтра в 13:00", { action: "event", title: "Встреча с АйПапа", at: "2026-08-01 13:00", scope: "work", client: "АйПапа" },
     "клиент в названии встречи — реальный случай, раньше встреча создавалась без клиента"),
  ex("созвон с ромашкой в понедельник в 11", { action: "event", title: "Созвон с Ромашкой", at: "2026-08-03 11:00", scope: "work", client: "Ромашка" }),
  ex("запланируй планёрку на завтра на 10 утра", { action: "event", title: "Планёрка", at: "2026-08-01 10:00", scope: "work" }),
  ex("в среду в 15 встреча в офисе на Тверской", { action: "event", title: "Встреча", at: "2026-08-05 15:00", scope: "work", location: "офис на Тверской" }),
  ex("поставь звонок с подрядчиком на пятницу 17:30", { action: "event", title: "Звонок с подрядчиком", at: "2026-08-01 17:30", scope: "work" }),
  ex("отмени встречу с айпапа", { action: "event_delete", title: "Встреча с АйПапа" }),

  // ---------- Клиенты ----------
  ex("добавь клиента Ромашка, директ, бюджет 150000", { action: "client_add", name: "Ромашка", platforms: "direct", budget: "150000" }),
  ex("новый клиент АйПапа, вк и авито, ведение 40000, оплата до 5 числа",
     { action: "client_add", name: "АйПапа", platforms: "vk,avito", fee: "40000", pay_due: "5 число" }),
  ex("удали клиента Ромашка", { action: "client_delete", name: "Ромашка" }),
  ex("переименуй клиента Ромашка в Ромашка Про", { action: "client_edit", name: "Ромашка", new_name: "Ромашка Про" }),
  ex("у айпапа теперь оплата до 10 числа", { action: "client_edit", name: "АйПапа", pay_due: "10 число" }),
  ex("подними бюджет ромашке до 200000", { action: "client_edit", name: "Ромашка", budget: "200000" }),

  // ---------- Контакты ----------
  ex("запиши др Максима 14 марта", { action: "contact", name: "Максим", birthday: "03-14" }),
  ex("добавь контакт Павел, день рождения 2 сентября", { action: "contact", name: "Павел", birthday: "09-02" }),

  // ---------- Заметки ----------
  ex("запомни, что пароль от вайфая на холодильнике", { action: "note_add", title: "Пароль от вайфая на холодильнике" }),
  ex("заметка: идея — запустить рассылку по базе", { action: "note_add", title: "Идея — запустить рассылку по базе" }),

  // ---------- Еда, вода, здоровье: разбирает отдельный слой, маршрутизатор молчит ----------
  ex("добавь в еду - 200 гр риса и 1 куриная котлета", { action: "none" },
     "реальный случай: заводилась задача вместо записи питания"),
  ex("запиши в рацион овсянку с бананом", { action: "none" }),
  ex("посчитай калории: борщ, хлеб, компот", { action: "none" }),
  ex("съел два яйца и тост", { action: "none" }),
  ex("выпил 300 мл воды", { action: "none" }),
  ex("вес 82.5", { action: "none" }),
  ex("прошёл 8000 шагов", { action: "none" }),

  // ---------- Не команда: Сара отвечает сама ----------
  ex("придумай пять заголовков для объявления", { action: "none" },
     "просьба выполнить работу сейчас — это разговор, а не задача"),
  ex("проанализируй, почему упали заявки", { action: "none" }),
  ex("как лучше настроить кампанию в директе?", { action: "none" }),
  ex("сделай контент-план на неделю", { action: "none" },
     "«сделай» звучит как команда, но просят выполнить работу, а не записать дело"),
  ex("что у меня сегодня?", { action: "none" }),
  ex("напиши письмо клиенту с извинениями", { action: "none" }),
];

/** Слова фразы без коротких и служебных — по ним ищем похожие примеры. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .filter((w) => w.length >= 3)
    .map((w) => w.replace(/[аяуюыиеёоэьъ]{1,2}$/i, ""));   // грубая основа: «ромашке» → «ромашк»
}

/**
 * Выбирает примеры, ближе всего похожие на фразу. Берём по общим словам, а
 * дальше добираем разнообразием действий, чтобы модель видела и «не команду».
 */
export function pickExamples(text: string, limit = 6): PhraseExample[] {
  const q = new Set(words(text));
  const scored = PHRASES.map((p) => {
    const pw = words(p.text);
    const common = pw.filter((w) => q.has(w)).length;
    return { p, score: common / Math.sqrt(pw.length || 1) };
  }).sort((a, b) => b.score - a.score);

  const picked: PhraseExample[] = [];
  const actions = new Set<string>();
  for (const { p, score } of scored) {
    if (picked.length >= limit) break;
    if (score <= 0) continue;
    const action = JSON.parse(p.json).action as string;
    // не больше двух примеров на одно действие — иначе подсказка перекосится
    const seen = [...actions].filter((a) => a === action).length;
    if (seen >= 2) continue;
    picked.push(p);
    actions.add(action);
  }
  // «Не команда» нужна всегда: без такого примера модель считает задачей всё
  // подряд. Если мест не осталось — освобождаем самое слабое.
  if (!picked.some((p) => JSON.parse(p.json).action === "none")) {
    const none = PHRASES.find((p) => JSON.parse(p.json).action === "none");
    if (none) {
      if (picked.length >= limit) picked.pop();
      picked.push(none);
    }
  }
  return picked.slice(0, limit);
}

/** Урок от конкретного человека: его фраза и действие, которое он имел в виду. */
export interface Lesson {
  phrase: string;
  action: string;
}

/**
 * Готовый кусок подсказки: сперва то, чему научил сам человек, потом общие
 * примеры. Личные уроки идут первыми — они важнее общих образцов.
 */
export function renderExamples(text: string, limit = 6, lessons: Lesson[] = []): string {
  const parts: string[] = [];

  const mine = pickLessons(text, lessons, 3);
  if (mine.length) {
    parts.push(
      `\nЭтот пользователь уже поправлял тебя на похожих фразах — следуй его разметке:\n` +
        mine.map((l) => `"${l.phrase}" → действие "${l.action}"`).join("\n")
    );
  }

  const picked = pickExamples(text, limit);
  if (picked.length) {
    parts.push(
      `\nПохожие примеры (они записаны при "Сейчас: ${REFERENCE_NOW}", даты в них считай от этого момента, а не от настоящего):\n` +
        picked.map((p) => `"${p.text}" → ${p.json}`).join("\n")
    );
  }
  return parts.join("");
}

/** Уроки, похожие на фразу; если похожих нет — просто самые свежие. */
export function pickLessons(text: string, lessons: Lesson[], limit = 3): Lesson[] {
  if (!lessons.length) return [];
  const q = new Set(words(text));
  const scored = lessons
    .map((l) => {
      const lw = words(l.phrase);
      return { l, score: lw.filter((w) => q.has(w)).length / Math.sqrt(lw.length || 1) };
    })
    .sort((a, b) => b.score - a.score);
  const near = scored.filter((x) => x.score > 0).slice(0, limit).map((x) => x.l);
  return near.length ? near : lessons.slice(0, Math.min(limit, 2));
}
