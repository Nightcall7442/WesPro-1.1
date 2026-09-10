// Тесты авторизации, ролей, кассовых смен и управления сотрудниками.

import assert from "node:assert/strict";
import { test } from "node:test";
import supertest from "supertest";

import {
  ADMIN,
  CASHIER,
  adminAgent,
  cashierAgent,
  createTable,
  createTariff,
  makeApp,
} from "./helpers.js";

// --- Вход ------------------------------------------------------------------

test("без входа API недоступно, а на корне гостя встречает описание системы", async () => {
  const { app } = makeApp();
  const anon = supertest(app);
  assert.equal((await anon.get("/api/dashboard")).status, 401);

  // Корень открыт: чаще всего туда заходит тот, кто ещё не знает, что
  // это за программа. Данных клуба на этой странице нет — только рассказ
  // о системе и кнопка «Войти».
  const page = await anon.get("/");
  assert.equal(page.status, 200);
  assert.match(page.text, /WesPro/);
  assert.match(page.text, /href="\/login"/, "с лендинга есть вход для сотрудников");
});

test("клуб может вернуть себе прямой вход вместо лендинга", async () => {
  // WESPRO_LANDING_ROOT=0 — для клуба, который поставил программу себе:
  // кассиру витрина на рабочем месте не нужна.
  const previous = process.env.WESPRO_LANDING_ROOT;
  process.env.WESPRO_LANDING_ROOT = "0";
  try {
    const { app } = makeApp();
    const page = await supertest(app).get("/");
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, "/login");
  } finally {
    if (previous === undefined) delete process.env.WESPRO_LANDING_ROOT;
    else process.env.WESPRO_LANDING_ROOT = previous;
  }
});

test("страница о системе открывается по прямой ссылке всегда", async () => {
  const { app } = makeApp();
  const page = await supertest(app).get("/about");
  assert.equal(page.status, 200);
  assert.match(page.text, /WesPro/);
});

test("вход с неверным паролем отклоняется", async () => {
  const { app } = makeApp();
  const res = await supertest(app)
    .post("/api/auth/login")
    .send({ login: ADMIN.login, password: "wrong" });
  assert.equal(res.status, 401);
});

test("вход и /auth/me", async () => {
  const { app } = makeApp();
  // Без смены: тест про вход, а не про кассу.
  const agent = await adminAgent(app, { withShift: false });
  const me = await agent.get("/api/auth/me");
  assert.equal(me.body.user.login, ADMIN.login);
  assert.equal(me.body.user.role, "admin");
  assert.equal(me.body.shift, null);
});

test("выход завершает сессию", async () => {
  const { app } = makeApp();
  const agent = await adminAgent(app);
  await agent.post("/api/auth/logout");
  assert.equal((await agent.get("/api/auth/me")).status, 401);
});

// --- Роли ------------------------------------------------------------------

test("кассиру запрещены админские действия", async () => {
  const { db, app } = makeApp();
  const cashier = await cashierAgent(app, db);

  assert.equal(
    (await cashier.post("/api/tables").send({ name: "Стол X" })).status,
    403
  );
  assert.equal(
    (await cashier.post("/api/tariffs").send({ name: "Т", price_per_hour: 100 }))
      .status,
    403
  );
  assert.equal((await cashier.get("/api/settings")).status, 403);
  assert.equal((await cashier.get("/api/users")).status, 403);
  assert.equal((await cashier.get("/api/stats/tables")).status, 403);
});

test("кассир видит дашборд, историю и тарифы, но не журнал", async () => {
  const { db, app } = makeApp();
  const cashier = await cashierAgent(app, db);
  for (const path of ["/api/dashboard", "/api/history", "/api/tariffs"]) {
    assert.equal((await cashier.get(path)).status, 200, path);
  }
  // Журнал событий кассиру не нужен — убран специально по просьбе владельца.
  assert.equal((await cashier.get("/api/journal")).status, 403);
});

test("журнал событий видят остальные роли, только не кассир", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const cashier = await cashierAgent(app, db);
  assert.equal((await admin.get("/api/journal")).status, 200, "администратору доступен");
  assert.equal((await cashier.get("/api/journal")).status, 403, "кассиру закрыт");
});

// --- Кассовые смены --------------------------------------------------------

test("кассир не может открыть стол без смены", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);
  const cashier = await cashierAgent(app, db);

  const res = await cashier
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: tariff.id });
  assert.equal(res.status, 409);
  assert.match(res.body.detail, /смену/);
});

test("смена: открытие, работа, закрытие с итогами", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);
  const cashier = await cashierAgent(app, db);

  const opened = await cashier.post("/api/shifts/open");
  assert.equal(opened.status, 201);
  assert.equal(opened.body.user_name, CASHIER.name);

  // Повторное открытие — конфликт.
  assert.equal((await cashier.post("/api/shifts/open")).status, 409);

  await cashier.post(`/api/tables/${table.id}/open`).send({ tariff_id: tariff.id });
  const closedSession = await cashier.post(`/api/tables/${table.id}/close`);
  assert.equal(closedSession.status, 200);
  assert.equal(closedSession.body.closed_by_name, CASHIER.name);

  const closed = await cashier.post("/api/shifts/close");
  assert.equal(closed.status, 200);
  assert.equal(closed.body.sessions_count, 1);
  assert.ok(closed.body.closed_at);

  // Закрывать больше нечего.
  assert.equal((await cashier.post("/api/shifts/close")).status, 409);
});

test("кассир видит только свои смены, админ — все", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const cashier = await cashierAgent(app, db);

  await admin.post("/api/shifts/open");
  await cashier.post("/api/shifts/open");

  const cashierView = await cashier.get("/api/shifts");
  assert.equal(cashierView.body.length, 1);
  assert.equal(cashierView.body[0].user_name, CASHIER.name);

  const adminView = await admin.get("/api/shifts");
  assert.equal(adminView.body.length, 2);
});

test("GET /api/shifts: фильтр по кассиру доступен только тому, кто видит все смены", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app, { withShift: false });
  const cashier = await cashierAgent(app, db);

  const adminShift = await admin.post("/api/shifts/open");
  await cashier.post("/api/shifts/open");

  // Админ фильтрует по конкретному кассиру — видит только его смену.
  const filtered = await admin.get(`/api/shifts?user_id=${adminShift.body.user_id}`);
  assert.equal(filtered.body.length, 1);
  assert.equal(filtered.body[0].user_id, adminShift.body.user_id);

  // Кассир не может подсмотреть чужую смену через тот же параметр —
  // сервер игнорирует чужой user_id и всё равно отдаёт только его смену.
  const cashierTryOther = await cashier.get(`/api/shifts?user_id=${adminShift.body.user_id}`);
  assert.equal(cashierTryOther.body.length, 1);
  assert.notEqual(cashierTryOther.body[0].user_id, adminShift.body.user_id);
});

test("GET /api/shifts: фильтр по дате находит смену за конкретный день", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app, { withShift: false });
  const shift = await admin.post("/api/shifts/open");
  const today = shift.body.opened_at.slice(0, 10);

  const hit = await admin.get(`/api/shifts?date_from=${today}&date_to=${today}`);
  assert.equal(hit.body.length, 1);

  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const miss = await admin.get(`/api/shifts?date_from=${yesterday}&date_to=${yesterday}`);
  assert.equal(miss.body.length, 0, "смена не в тот день — в выборку не попала");
});

// --- Отчёты ----------------------------------------------------------------

test("нагруженность столов считает сеансы и выручку", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin);
  await admin.post(`/api/tables/${table.id}/open`).send({ tariff_id: tariff.id });
  await admin.post(`/api/tables/${table.id}/close`);

  const stats = await admin.get("/api/stats/tables?days=7");
  assert.equal(stats.status, 200);
  const row = stats.body.tables.find((t) => t.id === table.id);
  assert.equal(row.sessions_count, 1);
});

// --- Сотрудники ------------------------------------------------------------

test("админ создаёт кассира, кассир может войти", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);

  const created = await admin.post("/api/users").send({
    login: "petya",
    name: "Пётр",
    password: "0000",
    role: "cashier",
  });
  assert.equal(created.status, 201);

  const login = await supertest(app)
    .post("/api/auth/login")
    .send({ login: "petya", password: "0000" });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, "cashier");
});

test("дубликат логина отклоняется", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const res = await admin.post("/api/users").send({
    login: ADMIN.login,
    name: "Клон",
    password: "0000",
    role: "admin",
  });
  assert.equal(res.status, 409);
});

test("нельзя убрать последнего администратора и отключить себя", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const me = (await admin.get("/api/auth/me")).body.user;

  const demote = await admin
    .put(`/api/users/${me.id}`)
    .send({ role: "cashier" });
  assert.equal(demote.status, 409);

  const deactivate = await admin
    .put(`/api/users/${me.id}`)
    .send({ is_active: false });
  assert.equal(deactivate.status, 409);
});

test("отключённый кассир теряет доступ", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const cashier = await cashierAgent(app, db);
  const users = (await admin.get("/api/users")).body;
  const target = users.find((u) => u.login === CASHIER.login);

  await admin.put(`/api/users/${target.id}`).send({ is_active: false });
  assert.equal((await cashier.get("/api/auth/me")).status, 401);
});

test("смена собственного пароля", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);

  const wrong = await admin
    .post("/api/auth/password")
    .send({ old_password: "bad", new_password: "newpass" });
  assert.equal(wrong.status, 409);

  const ok = await admin
    .post("/api/auth/password")
    .send({ old_password: ADMIN.password, new_password: "newpass" });
  assert.equal(ok.status, 200);

  const login = await supertest(app)
    .post("/api/auth/login")
    .send({ login: ADMIN.login, password: "newpass" });
  assert.equal(login.status, 200);
});
