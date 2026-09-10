// Журнал последних запросов к программе.
//
// Журнал событий отвечает на вопрос «что сделали» (открыли стол, закрыли
// смену), а этот — «что нажимали и чем это кончилось»: метод, адрес, код
// ответа, сколько заняло, кто. Именно его не хватает, когда кассир
// говорит «нажал — и выскочила ошибка», а какая, не помнит.
//
// Живёт только в памяти: кольцевой буфер на 200 записей. В базу не
// пишем намеренно — иначе каждый клик становился бы записью в базу.
//
// Буфер свой у каждой базы. В сети клубов все клубы работают в одном
// процессе, и один общий буфер показывал бы администратору одного клуба
// адреса и логины сотрудников другого.

const CAPACITY = 200;

/** @type {WeakMap<object, Array<{at: string, method: string, path: string, status: number, ms: number, user: string|null}>>} */
const buffers = new WeakMap();

function bufferFor(db) {
  let entries = buffers.get(db);
  if (!entries) {
    entries = [];
    buffers.set(db, entries);
  }
  return entries;
}

/** Что не записываем: частый опрос дашборда забил бы весь журнал. */
const SKIP = [/^\/api\/dashboard$/, /^\/api\/tariffs\/auto$/, /^\/api\/plan$/, /^\/api\/board$/];

/**
 * Express-middleware: замеряет время ответа и складывает запись.
 * Ошибок не бросает — журнал не должен мешать работе.
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function requestLogger(db) {
  return (req, res, next) => {
    if (SKIP.some((re) => re.test(req.path))) return next();
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      try {
        const entries = bufferFor(db);
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        entries.push({
          at: new Date().toISOString(),
          method: req.method,
          path: req.originalUrl.split("?")[0],
          status: res.statusCode,
          ms: Math.round(ms),
          user: req.user ? `${req.user.login} (${req.user.role})` : null,
        });
        if (entries.length > CAPACITY) entries.splice(0, entries.length - CAPACITY);
      } catch {
        // Журнал — вспомогательная вещь, молча пропускаем.
      }
    });
    next();
  };
}

/**
 * Последние запросы, свежие сверху.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{limit?: number, onlyErrors?: boolean}} [options]
 */
export function recentRequests(db, { limit = 200, onlyErrors = false } = {}) {
  const entries = bufferFor(db);
  const list = onlyErrors ? entries.filter((e) => e.status >= 400) : entries;
  return list.slice(-limit).reverse();
}

/** Очистка — нужна в тестах и когда журнал уже не про текущую проблему. */
export function clearRequests(db) {
  bufferFor(db).length = 0;
}
