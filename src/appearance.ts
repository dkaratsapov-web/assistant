/**
 * Изменение внешнего вида и поведения приложения словами: «сделай шрифт
 * крупнее», «включи тёмную тему», «спрячь раздел здоровье», «называй меня
 * Дмитрием», «отвечай покороче».
 *
 * Разбор здесь ПОЛНОСТЬЮ локальный, без ИИ. Причина простая: набор настроек
 * конечный и известен заранее, а модель на таких командах любит придумывать
 * значения, которых нет. Свой разбор либо уверенно узнаёт команду, либо честно
 * возвращает null — и фраза идёт дальше обычным путём.
 */
import { AppPrefs, DEFAULT_PREFS } from "./types";
import { WB_END } from "./utils";

export interface PrefsChange {
  changes: Partial<AppPrefs>;
  /** Что сказать человеку — по строке на каждое изменение. */
  said: string[];
}

/** Разделы нижнего меню: как их называют вслух → как они зовутся в коде. */
const SECTIONS: Array<[RegExp, string, string]> = [
  [/главн/, "home", "Главная"],
  [/задач/, "tasks", "Задачи"],
  [/календар|встреч/, "calendar", "Календарь"],
  [/здоров|калори|питани/, "health", "Здоровье"],
  [/клиент/, "clients", "Клиенты"],
  [/сар[ауы]|ассистент|чат|ии/, "ai", "Сара"],
];

const SCALE_MIN = 85;
const SCALE_MAX = 140;
const clampScale = (n: number) => Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(n)));

/** Слова «больше/крупнее» и «меньше/мельче» — направление шага. */
const UP = /(больше|крупн|увелич|повыс|прибав|подним)/;
const DOWN = /(меньше|мельче|уменьш|помельче|пониз|убав|сбав)/;

/**
 * Разбирает команду настройки. `cur` нужен, чтобы шаг «крупнее» считался от
 * текущего значения, а не от стандартного.
 */
export function parseAppearance(text: string, cur: AppPrefs = DEFAULT_PREFS): PrefsChange | null {
  const t = String(text ?? "").trim().toLowerCase().replace(/ё/g, "е");
  if (!t) return null;
  const changes: Partial<AppPrefs> = {};
  const said: string[] = [];

  // ---------- Сброс ----------
  if (/(верни|сбрось|сброс|по умолчанию|как было|стандартн)/.test(t) && /(настройк|вид|оформлен|интерфейс)/.test(t)) {
    return {
      changes: { scale: 100, density: "normal", images: "normal", corners: "normal", theme: "auto", motion: true, hidden: [] },
      said: ["Вернула стандартное оформление"],
    };
  }

  // ---------- Размер шрифта ----------
  const aboutFont = /(шрифт|текст|буквы|надписи|масштаб)/.test(t);
  if (aboutFont) {
    const exact = t.match(/(\d{2,3})\s*%?/);
    if (exact && +exact[1] >= SCALE_MIN && +exact[1] <= SCALE_MAX) {
      changes.scale = clampScale(+exact[1]);
    } else if (UP.test(t)) {
      changes.scale = clampScale(cur.scale + 10);
    } else if (DOWN.test(t)) {
      changes.scale = clampScale(cur.scale - 10);
    }
    if (changes.scale !== undefined) said.push(`Размер текста: ${changes.scale}%`);
  }

  // ---------- Тема и фон ----------
  if (/(темн|черн|ночн)/.test(t) && /(тем[аыу]|фон|режим|оформлен|интерфейс|прилож|сделай|включ|поставь)/.test(t)) {
    changes.theme = "dark";
    said.push("Тема: тёмная");
  } else if (/(светл|бел|дневн)/.test(t) && /(тем[аыу]|фон|режим|оформлен|интерфейс|прилож|сделай|включ|поставь)/.test(t)) {
    changes.theme = "light";
    said.push("Тема: светлая");
  } else if (/(как в системе|системн|авто)/.test(t) && /(тем|фон|режим)/.test(t)) {
    changes.theme = "auto";
    said.push("Тема: как в системе");
  }

  // ---------- Плотность ----------
  // Основы нарочно узкие: «уборка» не должна делать интерфейс компактным,
  // а «я свободен в пятницу» — просторным.
  if (/(простор|побольше воздуха)/.test(t)) {
    changes.density = "roomy";
    said.push("Расстановка: просторно");
  } else if (/(компактн|поплотнее|плотнее)/.test(t) && !/(картинк|фото|изображен)/.test(t)) {
    changes.density = "compact";
    said.push("Расстановка: компактно");
  }

  // ---------- Картинки ----------
  if (/(картинк|фото|изображен|аватарк)/.test(t) && (UP.test(t) || DOWN.test(t))) {
    changes.images = UP.test(t) ? "large" : "small";
    said.push(`Картинки: ${changes.images === "large" ? "крупные" : "мелкие"}`);
  }

  // ---------- Скругление углов ----------
  if (/(угл|скругл|кругл|острые|карточк)/.test(t) && /(кругл|скругл|мягч|остр|прям|резк)/.test(t)) {
    changes.corners = /(остр|прям|резк)/.test(t) ? "sharp" : "soft";
    said.push(`Углы: ${changes.corners === "soft" ? "скруглённые" : "прямые"}`);
  }

  // ---------- Анимации и вибрация ----------
  if (/(анимац|плавност)/.test(t)) {
    const off = /(выключ|отключ|убер|без|не нужн|надоел)/.test(t);
    changes.motion = !off;
    said.push(off ? "Анимации выключены" : "Анимации включены");
  }
  if (/(вибрац|виброоткл|тактильн)/.test(t)) {
    const off = /(выключ|отключ|убер|без|не нужн)/.test(t);
    changes.haptic = !off;
    said.push(off ? "Вибрация выключена" : "Вибрация включена");
  }

  // ---------- Стартовый экран ----------
  if (/(открыва|начина|стартов|сразу показыв|при запуске|первым)/.test(t) && !/(спрячь|скрой|убер)/.test(t)) {
    const hit = SECTIONS.find(([re]) => re.test(t));
    if (hit) {
      changes.startTab = hit[1];
      said.push(`Открывать сразу: ${hit[2]}`);
    }
  }

  // ---------- Спрятать или вернуть раздел ----------
  const hideVerb = /(спрячь|скрой|скрыть|убер[иья]|убрать|не показыв|выключ раздел)/.test(t);
  const showVerb = /(верни|покажи|включи|вернуть|добавь обратно)/.test(t) && /(раздел|вкладк|меню)/.test(t);
  if (hideVerb || showVerb) {
    const hit = SECTIONS.find(([re]) => re.test(t));
    // Прячем только когда речь явно о разделе меню: «убери срок у задачи» — не про это
    const aboutMenu = /(раздел|вкладк|меню|снизу|внизу)/.test(t);
    if (hit && (aboutMenu || (hideVerb && !/(задач|встреч|срок|клиент)/.test(t)))) {
      const set = new Set(cur.hidden ?? []);
      if (showVerb) {
        set.delete(hit[1]);
        said.push(`Раздел «${hit[2]}» снова в меню`);
      } else {
        if (hit[1] === "home") return null;             // без главной приложение осиротеет
        set.add(hit[1]);
        said.push(`Раздел «${hit[2]}» спрятан`);
      }
      changes.hidden = [...set].slice(0, 8);
    }
  }

  // ---------- Как обращаться ----------
  let m: RegExpMatchArray | null;
  if ((m = t.match(new RegExp(`(?:называй|зови|обращайся к)\\s+(?:меня|ко мне)\\s+([а-яa-z-]{2,20})${WB_END}`, "i")))) {
    const word = m[1];
    // «называй меня по имени» — это не имя, а служебные слова
    if (!/^(по|как|так|на|просто|пожалуйста|всегда)$/.test(word)) {
      const name = word.replace(/^./, (c) => c.toUpperCase());
      changes.callMe = name;
      said.push(`Буду обращаться: ${name}`);
    }
  }
  // Граница слова обязательна: без неё «напомни на выходных» переводило бы
  // Сару на «вы», а «перенеси на тысячу» — на «ты».
  if (new RegExp(`(?:на\\s+вы|выкай)${WB_END}`).test(t)) {
    changes.address = "vy";
    said.push("Перехожу на «вы»");
  } else if (new RegExp(`(?:на\\s+ты|тыкай)${WB_END}`).test(t)) {
    changes.address = "ty";
    said.push("Перехожу на «ты»");
  }

  // ---------- Имя ассистента ----------
  if ((m = t.match(new RegExp(`(?:тебя зовут|твое имя|поменяй имя на|переименуйся в|называйся)\\s+([а-яa-z-]{2,20})${WB_END}`, "i")))) {
    const name = m[1].replace(/^./, (c) => c.toUpperCase());
    changes.botName = name;
    said.push(`Теперь меня зовут ${name}`);
  }

  // ---------- Манера общения ----------
  // Манеру меняем только при явном обращении к Саре: «короче» — слово-паразит,
  // само по себе оно ничего переключать не должно.
  const aboutManner = /(отвечай|говори|пиши|будь|манер|стиль|общайся)/.test(t);
  if (aboutManner && /(покороче|кратк|лакони|без воды|по существу|короче)/.test(t)) {
    changes.tone = "brief";
    said.push("Манера: коротко и по делу");
  } else if (aboutManner && /(по-делов|делов|официальн|строже|сдержанн)/.test(t)) {
    changes.tone = "business";
    said.push("Манера: деловая");
  } else if (aboutManner && /(дружелюбн|теплее|живее|попроще|неформальн)/.test(t)) {
    changes.tone = "friendly";
    said.push("Манера: дружелюбная");
  }

  // ---------- Эмодзи ----------
  if (/(эмодзи|смайл)/.test(t)) {
    const off = /(без|выключ|отключ|убер|не нужн|не используй|не ставь)/.test(t);
    changes.emoji = !off;
    said.push(off ? "Эмодзи выключены" : "Эмодзи включены");
  }

  // ---------- Поиск в интернете ----------
  if (/(интернет|в сети|гугл|яндекс)/.test(t) && /(можно|разреш|запрет|выключ|отключ|включ|не\s+ищи|не надо искать|не ищи)/.test(t)) {
    const off = /(не\s+(?:ищ|надо|нужно)|выключ|отключ|запрет|без)/.test(t);
    changes.search = !off;
    said.push(off ? "Поиск в интернете выключен" : "Поиск в интернете включён");
  }

  return said.length ? { changes, said } : null;
}

/**
 * Метка ответа о настройках. По ней приложение понимает, что надо перечитать
 * настройки с сервера и применить их прямо сейчас, не дожидаясь перезапуска.
 */
export const PREFS_MARK = "⚙️";

/** Сводка изменений одной репликой. */
export function renderPrefsChange(change: PrefsChange): string {
  return `${PREFS_MARK} ${change.said.join(`\n${PREFS_MARK} `)}\n\nГотово.`;
}
