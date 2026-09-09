// Центральная панель сети клубов: подписки, оплаты, автоблокировка,
// рассылка и связь с программами клубов.
//
// Главное, что здесь проверяется, — деньги и доступ. Клуб, который
// заплатил, обязан работать; клуб, который не заплатил, обязан
// отключиться сам; и ни один клуб не должен видеть чужие данные.

import assert from "node:assert/strict";
import { test } from "node:test";

import supertest from "supertest";

import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db.js";
import { createHubDatabase } from "../src/hub/db.js";
import { createHubUser } from "../src/hub/auth.js";
import { plusDays, refreshStatuses } from "../src/hub/clubs.js";

const OWNER = { login: "owner", name: "Владелец сервиса", password: "vladelec123" };

/** Приложение с пустыми базами клуба и хаба + учётка владельца сервиса. */
function makeHub() {
  const db = createDatabase(":memory:");
  const hubDb = createHubDatabase(":memory:");
  createHubUser(hubDb, OWNER);
  return { db, hubDb, app: createApp(db, hubDb) };
}

/** Агент, вошедший в панель. */
async function hubAgent(app) {
  const agent = supertest.agent(app);
  const res = await agent
    .post("/hub/api/auth/login")
    .send({ login: OWNER.login, password: OWNER.password });
  if (res.status !== 200) throw new Error(`hub login: ${res.status}`);
  return agent;
}

async function makePlan(agent, name = "Базовый", price = 300000, periodDays = 30) {
  const res = await agent
    .post("/hub/api/plans")
    .send({ name, price, period_days: periodDays });
  if (res.status !== 201) throw new Error(`createPlan: ${res.status} ${res.text}`);
  return res.body;
}

async function makeClub(agent, name = "Клуб на Чиланзаре", extra = {}) {
  const res = await agent.post("/hub/api/clubs").send({ name, ...extra });
  if (res.status !== 201) throw new Error(`createClub: ${res.status} ${res.text}`);
  return res.body;
}

/** Сдвигает дату оплаты клуба в прошлое — как будто срок вышел. */
function expirePayment(hubDb, clubId, daysAgo) {
  hubDb
    .prepare("UPDATE clubs SET paid_until = ?, grace_until = NULL WHERE id = ?")
    .run(plusDays(-daysAgo), clubId);
}

// --- Доступ -----------------------------------------------------------------

test("в панель без входа не попасть", async () => {
  const { app } = makeHub();
  const guest = supertest.agent(app);
  for (const url of ["/hub/api/clubs", "/hub/api/overview", "/hub/api/plans"]) {
    const res = await guest.get(url);
    assert.equal(res.status, 401, `${url} закрыт для чужих`);
  }
});

test("сотрудник клуба не попадает в панель сети по своей сессии", async () => {
  const { db, app } = makeHub();
  const { createUser } = await import("../src/services/users.js");
  createUser(db, { login: "admin", password: "admin1", name: "Админ", role: "admin" });
  const agent = supertest.agent(app);
  await agent.post("/api/auth/login").send({ login: "admin", password: "admin1" });

  // Вход в клуб выполнен, но панель сети — отдельный мир.
  const res = await agent.get("/hub/api/clubs");
  assert.equal(res.status, 401, "сессия клуба в панели не работает");
});

test("неверный пароль в панель не пускает", async () => {
  const { app } = makeHub();
  const res = await supertest(app)
    .post("/hub/api/auth/login")
    .send({ login: OWNER.login, password: "не тот" });
  assert.equal(res.status, 401);
});

// --- Клубы и подписки -------------------------------------------------------

test("новый клуб сразу получает пробный период, а не блокировку", async () => {
  const { app } = makeHub();
  const hub = await hubAgent(app);
  const club = await makeClub(hub, "Первый клуб", { city: "Ташкент", phone: "+998901112233" });

  assert.equal(club.status, "trial", "клуб на пробном периоде");
  assert.ok(club.days_left > 0, "пробный период ещё идёт");
  assert.ok(club.api_key.length >= 32, "выдан ключ для программы клуба");
  assert.equal(club.payments_count, 0);
});

test("клуб с одинаковым названием дважды не заводится", async () => {
  const { app } = makeHub();
  const hub = await hubAgent(app);
  await makeClub(hub, "Единственный");
  const res = await hub.post("/hub/api/clubs").send({ name: "Единственный" });
  assert.equal(res.status, 409);
});

test("оплата продлевает подписку и снимает блокировку", async () => {
  const { app, hubDb } = makeHub();
  const hub = await hubAgent(app);
  const plan = await makePlan(hub);
  const club = await makeClub(hub, "Должник", { plan_id: plan.id });

  // Срок вышел давно — клуб заблокирован автоматически.
  expirePayment(hubDb, club.id, 60);
  const blocked = (await hub.get(`/hub/api/clubs/${club.id}`)).body;
  assert.equal(blocked.status, "blocked", "просрочка без отсрочки отключает клуб");

  const paid = await hub
    .post(`/hub/api/clubs/${club.id}/payments`)
    .send({ amount: 300000, days: 30, method: "cash" });
  assert.equal(paid.status, 201);
  assert.equal(paid.body.status, "active", "после оплаты клуб снова работает");
  assert.ok(paid.body.days_left >= 29 && paid.body.days_left <= 30);
  assert.equal(paid.body.paid_total, 300000);

  const payments = (await hub.get(`/hub/api/clubs/${club.id}/payments`)).body;
  assert.equal(payments.length, 1, "оплата попала в историю");
  assert.equal(payments[0].amount, 300000);
  assert.equal(payments[0].created_by_name, OWNER.name, "видно, кто провёл оплату");
});

test("оплата вперёд не съедает уже оплаченные дни", async () => {
  const { app } = makeHub();
  const hub = await hubAgent(app);
  const club = await makeClub(hub, "Платит заранее");
  const before = club.days_left;

  const paid = (
    await hub.post(`/hub/api/clubs/${club.id}/payments`).send({ amount: 100, days: 30 })
  ).body;
  assert.ok(
    paid.days_left >= before + 29,
    `к оставшимся ${before} дн. добавились ещё 30, а не заменили их (стало ${paid.days_left})`
  );
});

test("после просрочки клуб сначала в отсрочке, а отключается позже", async () => {
  const { app, hubDb } = makeHub();
  const hub = await hubAgent(app);
  const club = await makeClub(hub, "Забыл заплатить");
  // Заплатил один раз, чтобы это была не «проба», а настоящая подписка.
  await hub.post(`/hub/api/clubs/${club.id}/payments`).send({ amount: 100, days: 30 });

  // Срок вышел вчера: по умолчанию отсрочка 5 дней — клуб ещё работает.
  expirePayment(hubDb, club.id, 1);
  assert.equal((await hub.get(`/hub/api/clubs/${club.id}`)).body.status, "overdue");

  // Прошло больше отсрочки — блокировка.
  expirePayment(hubDb, club.id, 30);
  assert.equal((await hub.get(`/hub/api/clubs/${club.id}`)).body.status, "blocked");
});

test("отсрочка держит клуб включённым, пока деньги в пути", async () => {
  const { app, hubDb } = makeHub();
  const hub = await hubAgent(app);
  const club = await makeClub(hub, "Обещал оплатить");
  expirePayment(hubDb, club.id, 90);
  assert.equal((await hub.get(`/hub/api/clubs/${club.id}`)).body.status, "blocked");

  const res = await hub.post(`/hub/api/clubs/${club.id}/grace`).send({ days: 7 });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "overdue", "отсрочка вернула клуб в работу");
  assert.ok(res.body.grace_until > new Date().toISOString());
});

test("ручная блокировка сильнее оплаченной подписки", async () => {
  const { app } = makeHub();
  const hub = await hubAgent(app);
  const club = await makeClub(hub, "Нарушитель");
  await hub.post(`/hub/api/clubs/${club.id}/payments`).send({ amount: 100, days: 365 });

  const blocked = (await hub.post(`/hub/api/clubs/${club.id}/block`).send({ blocked: true })).body;
  assert.equal(blocked.status, "blocked", "оплата не спасает от ручной блокировки");

  const back = (await hub.post(`/hub/api/clubs/${club.id}/block`).send({ blocked: false })).body;
  assert.equal(back.status, "active", "разблокировали — снова работает");
});

test("разблокированный должник не блокируется обратно в ту же секунду", async () => {
  const { app, hubDb } = makeHub();
  const hub = await hubAgent(app);
  const club = await makeClub(hub, "Должник с прощением");
  expirePayment(hubDb, club.id, 90);
  await hub.post(`/hub/api/clubs/${club.id}/block`).send({ blocked: true });

  const back = (await hub.post(`/hub/api/clubs/${club.id}/block`).send({ blocked: false })).body;
  assert.notEqual(back.status, "blocked", "снятие блокировки даёт время оплатить");
  assert.ok(back.grace_until, "выдана отсрочка");
});

test("архив и возврат из архива", async () => {
  const { app } = makeHub();
  const hub = await hubAgent(app);
  const club = await makeClub(hub, "Ушёл из сети");

  assert.equal((await hub.post(`/hub/api/clubs/${club.id}/archive`)).body.status, "archived");
  // В обычном списке архивных нет.
  const list = (await hub.get("/hub/api/clubs?status=active")).body;
  assert.equal(list.find((c) => c.id === club.id), undefined);

  const back = (await hub.post(`/hub/api/clubs/${club.id}/restore`)).body;
  assert.notEqual(back.status, "archived", "вернулся в сеть");
});

// --- Тарифы -----------------------------------------------------------------

test("тариф с клубами на нём не удаляется", async () => {
  const { app } = makeHub();
  const hub = await hubAgent(app);
  const plan = await makePlan(hub, "Занятый");
  await makeClub(hub, "Сидит на тарифе", { plan_id: plan.id });

  const res = await hub.delete(`/hub/api/plans/${plan.id}`);
  assert.equal(res.status, 409, "иначе клуб остался бы без тарифа");

  // А неиспользуемый — удаляется.
  const spare = await makePlan(hub, "Лишний");
  assert.equal((await hub.delete(`/hub/api/plans/${spare.id}`)).status, 200);
});

// --- Связь с программой клуба ----------------------------------------------

test("программа клуба отмечается на связи и узнаёт, оплачен ли клуб", async () => {
  const { app } = makeHub();
  const hub = await hubAgent(app);
  const plan = await makePlan(hub, "Базовый", 300000, 30);
  const club = await makeClub(hub, "Живой клуб", { plan_id: plan.id });

  const ping = await supertest(app)
    .post("/hub/api/agent/ping")
    .set("X-Club-Key", club.api_key)
    .send({ version: "1.1.0", tables: 8 });
  assert.equal(ping.status, 200);
  assert.equal(ping.body.blocked, false, "оплаченный клуб работает");
  assert.equal(ping.body.status, "trial");
  assert.equal(ping.body.plan_name, "Базовый");

  const fresh = (await hub.get(`/hub/api/clubs/${club.id}`)).body;
  assert.equal(fresh.offline, false, "клуб теперь на связи");
  assert.equal(fresh.app_version, "1.1.0");
  assert.equal(fresh.tables_count, 8);
});

test("просроченный клуб узнаёт о блокировке при первой же связи", async () => {
  const { app, hubDb } = makeHub();
  const hub = await hubAgent(app);
  const club = await makeClub(hub, "Отключённый");
  expirePayment(hubDb, club.id, 90);

  const ping = await supertest(app)
    .post("/hub/api/agent/ping")
    .set("X-Club-Key", club.api_key)
    .send({});
  assert.equal(ping.body.blocked, true, "клуб сам себя отключит");
  assert.equal(ping.body.status, "blocked");
});

test("чужой ключ ничего не открывает", async () => {
  const { app } = makeHub();
  const hub = await hubAgent(app);
  await makeClub(hub, "Свой клуб");

  const res = await supertest(app)
    .post("/hub/api/agent/ping")
    .set("X-Club-Key", "0000000000000000000000000000000000000000")
    .send({});
  assert.equal(res.status, 401);
});

test("новый ключ отключает старый сразу", async () => {
  const { app } = makeHub();
  const hub = await hubAgent(app);
  const club = await makeClub(hub, "Сменил ключ");
  const oldKey = club.api_key;

  const updated = (await hub.post(`/hub/api/clubs/${club.id}/key`)).body;
  assert.notEqual(updated.api_key, oldKey);

  const res = await supertest(app).post("/hub/api/agent/ping").set("X-Club-Key", oldKey).send({});
  assert.equal(res.status, 401, "старый ключ больше не работает");
});

// --- Сообщения --------------------------------------------------------------

test("рассылка доходит до клуба, который в тот момент был выключен", async () => {
  const { app } = makeHub();
  const hub = await hubAgent(app);
  const club = await makeClub(hub, "Был выключен");

  await hub.post("/hub/api/messages").send({ title: "Обновление", body: "Вышла версия 1.2" });

  // Клуб включился только сейчас — и сразу получил сообщение.
  const ping = await supertest(app)
    .post("/hub/api/agent/ping")
    .set("X-Club-Key", club.api_key)
    .send({});
  assert.equal(ping.body.messages.length, 1);
  assert.equal(ping.body.messages[0].title, "Обновление");

  // Показали гостю — отмечаем прочитанным, второй раз не придёт.
  await supertest(app)
    .post(`/hub/api/agent/messages/${ping.body.messages[0].id}/read`)
    .set("X-Club-Key", club.api_key)
    .send({});
  const again = await supertest(app)
    .post("/hub/api/agent/ping")
    .set("X-Club-Key", club.api_key)
    .send({});
  assert.equal(again.body.messages.length, 0, "прочитанное не повторяется");

  const messages = (await hub.get("/hub/api/messages")).body;
  assert.equal(messages[0].read_count, 1, "в панели видно, кто прочитал");
});

test("личное сообщение видит только свой клуб", async () => {
  const { app } = makeHub();
  const hub = await hubAgent(app);
  const mine = await makeClub(hub, "Кому писали");
  const other = await makeClub(hub, "Кому не писали");

  await hub
    .post("/hub/api/messages")
    .send({ title: "Только вам", body: "по вашей заявке", club_id: mine.id });

  const toMine = await supertest(app)
    .post("/hub/api/agent/ping")
    .set("X-Club-Key", mine.api_key)
    .send({});
  const toOther = await supertest(app)
    .post("/hub/api/agent/ping")
    .set("X-Club-Key", other.api_key)
    .send({});
  assert.equal(toMine.body.messages.length, 1);
  assert.equal(toOther.body.messages.length, 0, "чужое сообщение соседу не показали");
});

// --- Поддержка --------------------------------------------------------------

test("ключ поддержки одноразовый, с причиной и записью в журнал", async () => {
  const { app } = makeHub();
  const hub = await hubAgent(app);
  const club = await makeClub(hub, "Просит помощи");

  const withoutReason = await hub.post(`/hub/api/clubs/${club.id}/support`).send({ reason: "" });
  assert.equal(withoutReason.status, 409, "без причины ключ не выдаётся");

  const issued = await hub
    .post(`/hub/api/clubs/${club.id}/support`)
    .send({ reason: "не печатается чек" });
  assert.equal(issued.status, 201);

  const first = await supertest(app)
    .post("/hub/api/agent/support/redeem")
    .set("X-Club-Key", club.api_key)
    .send({ token: issued.body.token });
  assert.equal(first.status, 200);

  const second = await supertest(app)
    .post("/hub/api/agent/support/redeem")
    .set("X-Club-Key", club.api_key)
    .send({ token: issued.body.token });
  assert.equal(second.status, 409, "второй раз тем же ключом не войти");

  const journal = (await hub.get("/hub/api/journal?event=support_login")).body.entries;
  assert.ok(
    journal.some((e) => e.message.includes("не печатается чек")),
    "причина входа осталась в журнале сети"
  );
});

// --- Сводка и журнал --------------------------------------------------------

test("сводка считает клубов, деньги и тех, кого надо догнать", async () => {
  const { app, hubDb } = makeHub();
  const hub = await hubAgent(app);
  const plan = await makePlan(hub, "Базовый", 300000, 30);
  const paying = await makeClub(hub, "Платит", { plan_id: plan.id });
  await hub.post(`/hub/api/clubs/${paying.id}/payments`).send({ amount: 300000, days: 30 });
  const late = await makeClub(hub, "Просрочил", { plan_id: plan.id });
  await hub.post(`/hub/api/clubs/${late.id}/payments`).send({ amount: 300000, days: 30 });
  expirePayment(hubDb, late.id, 2);
  refreshStatuses(hubDb);

  const { stats, attention } = (await hub.get("/hub/api/overview")).body;
  assert.equal(stats.clubs_living, 2);
  assert.equal(stats.by_status.active, 1);
  assert.equal(stats.by_status.overdue, 1);
  assert.equal(stats.paid_total, 600000, "получено всего — обе оплаты");
  assert.equal(stats.mrr, 600000, "два клуба по 300 000 в месяц");

  assert.ok(
    attention.some((a) => a.kind === "overdue" && a.club_name === "Просрочил"),
    "просрочка попала в «требует внимания»"
  );
  assert.ok(
    attention.some((a) => a.kind === "offline"),
    "клубы, ни разу не выходившие на связь, тоже видны"
  );
});

test("журнал сети пишет всё, что случилось с клубом", async () => {
  const { app } = makeHub();
  const hub = await hubAgent(app);
  const club = await makeClub(hub, "Подопытный");
  await hub.post(`/hub/api/clubs/${club.id}/payments`).send({ amount: 100, days: 30 });
  await hub.post(`/hub/api/clubs/${club.id}/block`).send({ blocked: true });

  const entries = (await hub.get(`/hub/api/journal?club_id=${club.id}`)).body.entries;
  const events = entries.map((e) => e.event);
  assert.ok(events.includes("club_created"), "регистрация записана");
  assert.ok(events.includes("payment_added"), "оплата записана");
  assert.ok(events.includes("club_blocked"), "блокировка записана");
  assert.ok(entries.every((e) => e.club_name === "Подопытный"));
});

test("настройки подписки меняются и сразу действуют", async () => {
  const { app, hubDb } = makeHub();
  const hub = await hubAgent(app);
  await hub.put("/hub/api/settings").send({ grace_days: "30", currency: "сум" });

  const club = await makeClub(hub, "Под новой отсрочкой");
  await hub.post(`/hub/api/clubs/${club.id}/payments`).send({ amount: 100, days: 30 });
  // Просрочка 10 дней: при отсрочке 5 дней был бы «blocked», при 30 — нет.
  expirePayment(hubDb, club.id, 10);
  assert.equal((await hub.get(`/hub/api/clubs/${club.id}`)).body.status, "overdue");
});

test("клубный API не знает про панель, а панель — про столы клуба", async () => {
  const { app } = makeHub();
  const hub = await hubAgent(app);
  // Сессия панели не даёт доступа к кассе клуба.
  const res = await hub.get("/api/dashboard");
  assert.equal(res.status, 401, "владелец сервиса не лезет в кассу клуба своей сессией");
});
