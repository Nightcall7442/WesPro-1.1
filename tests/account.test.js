// Личный кабинет владельца клуба: самостоятельная регистрация и вход по
// почте и паролю. Отдельный мир от панели сети (/hub, сотрудники WesPro)
// и от самой программы клуба (/login, сотрудники клуба на месте) — здесь
// проверяется, что эти три входа не путаются друг с другом, а один клуб
// не видит данные другого.

import assert from "node:assert/strict";
import { test } from "node:test";

import supertest from "supertest";

import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db.js";
import { createHubDatabase } from "../src/hub/db.js";
import { createHubUser } from "../src/hub/auth.js";
import { createClub } from "../src/hub/clubs.js";

/** Приложение с пустыми базами клуба и хаба. */
function makeHub() {
  const db = createDatabase(":memory:");
  const hubDb = createHubDatabase(":memory:");
  return { db, hubDb, app: createApp(db, hubDb) };
}

function registration(overrides = {}) {
  return {
    name: "WesPro Чиланзар",
    owner_name: "Азиз Каримов",
    email: "aziz@example.com",
    password: "clubpass123",
    ...overrides,
  };
}

/** Агент, зарегистрировавший и сразу вошедший клуб (или вошедший готовым). */
async function registerAgent(app, overrides = {}) {
  const agent = supertest.agent(app);
  const res = await agent.post("/account/api/register").send(registration(overrides));
  if (res.status !== 201) throw new Error(`register: ${res.status} ${res.text}`);
  return { agent, club: res.body };
}

// --- Регистрация -------------------------------------------------------------

test("регистрация заводит клуб и сразу входит в кабинет", async () => {
  const { app } = makeHub();
  const { agent, club } = await registerAgent(app);

  assert.equal(club.name, "WesPro Чиланзар");
  assert.equal(club.status, "trial", "пробный период начался сразу");
  assert.ok(club.days_left > 0);

  // Сессия уже действует — второй раз логиниться не нужно.
  const me = await agent.get("/account/api/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.name, "WesPro Чиланзар");
});

test("нельзя зарегистрироваться с занятой почтой", async () => {
  const { app } = makeHub();
  await registerAgent(app, { email: "aziz@example.com" });

  const res = await supertest(app)
    .post("/account/api/register")
    .send(registration({ name: "Другой клуб", email: "AZIZ@example.com" }));
  assert.equal(res.status, 409, "почта без учёта регистра всё равно занята");
});

test("клуб с занятым названием не регистрируется, даже с новой почтой", async () => {
  const { app } = makeHub();
  await registerAgent(app, { name: "Единственный", email: "first@example.com" });

  const res = await supertest(app)
    .post("/account/api/register")
    .send(registration({ name: "Единственный", email: "second@example.com" }));
  assert.equal(res.status, 409);
});

test("регистрация проверяет обязательные поля", async () => {
  const { app } = makeHub();
  const cases = [
    { patch: { password: "1234567" }, why: "короткий пароль" },
    { patch: { email: "не-почта" }, why: "неверный формат почты" },
    { patch: { owner_name: "А" }, why: "слишком короткое имя" },
  ];
  for (const { patch, why } of cases) {
    const res = await supertest(app)
      .post("/account/api/register")
      .send(registration(patch));
    assert.equal(res.status, 409, why);
  }
});

// --- Вход ----------------------------------------------------------------

test("вход по почте и паролю работает, неверный пароль — нет", async () => {
  const { app } = makeHub();
  await registerAgent(app);

  const ok = await supertest(app)
    .post("/account/api/login")
    .send({ email: "aziz@example.com", password: "clubpass123" });
  assert.equal(ok.status, 200);

  const bad = await supertest(app)
    .post("/account/api/login")
    .send({ email: "aziz@example.com", password: "неверный" });
  assert.equal(bad.status, 401);
});

test("почта при входе не чувствительна к регистру и пробелам", async () => {
  const { app } = makeHub();
  await registerAgent(app, { email: "aziz@example.com" });

  const res = await supertest(app)
    .post("/account/api/login")
    .send({ email: "  AZIZ@Example.com  ", password: "clubpass123" });
  assert.equal(res.status, 200);
});

test("клуб, заведённый в панели вручную без пароля, по почте не входит", async () => {
  const { app, hubDb } = makeHub();
  createClub(hubDb, { name: "Ручной клуб", email: "manual@example.com" });

  const res = await supertest(app)
    .post("/account/api/login")
    .send({ email: "manual@example.com", password: "любой-пароль" });
  assert.equal(res.status, 401, "пароля ему ещё не задавали — входа нет");
});

test("без входа кабинет недоступен", async () => {
  const { app } = makeHub();
  const res = await supertest(app).get("/account/api/account");
  assert.equal(res.status, 401);
});

// --- Кабинет и изоляция между клубами ----------------------------------------

test("в кабинете видна своя подписка и история оплат, но не чужая", async () => {
  const { app, hubDb } = makeHub();
  const { agent: agentA, club: clubA } = await registerAgent(app, {
    name: "Клуб А",
    email: "a@example.com",
  });
  const { agent: agentB, club: clubB } = await registerAgent(app, {
    name: "Клуб Б",
    email: "b@example.com",
  });

  // Оплату клубу А владелец сервиса отмечает в своей панели — она не
  // должна просочиться в кабинет клуба Б.
  const { addPayment } = await import("../src/hub/clubs.js");
  addPayment(hubDb, clubA.id, { amount: 300000, days: 30 });

  const viewA = await agentA.get("/account/api/account");
  assert.equal(viewA.body.club.status, "active");
  assert.equal(viewA.body.payments.length, 1);
  assert.equal(viewA.body.payments[0].amount, 300000);

  const viewB = await agentB.get("/account/api/account");
  assert.equal(viewB.body.club.status, "trial", "оплата соседа кабинет Б не задела");
  assert.equal(viewB.body.payments.length, 0);
  assert.notEqual(viewB.body.club.api_key, viewA.body.club.api_key);
});

test("смена пароля требует верный старый пароль", async () => {
  const { app } = makeHub();
  const { agent } = await registerAgent(app);

  const wrong = await agent
    .post("/account/api/password")
    .send({ old_password: "неверный", new_password: "newpassword1" });
  assert.equal(wrong.status, 401);

  const ok = await agent
    .post("/account/api/password")
    .send({ old_password: "clubpass123", new_password: "newpassword1" });
  assert.equal(ok.status, 200);

  // Старый пароль больше не подходит, новый — подходит.
  const oldLogin = await supertest(app)
    .post("/account/api/login")
    .send({ email: "aziz@example.com", password: "clubpass123" });
  assert.equal(oldLogin.status, 401);
  const newLogin = await supertest(app)
    .post("/account/api/login")
    .send({ email: "aziz@example.com", password: "newpassword1" });
  assert.equal(newLogin.status, 200);
});

test("в обычной установке после регистрации ведут в кабинет", async () => {
  const { app } = makeHub();
  const registered = await supertest(app).post("/account/api/register").send({
    name: "Клуб Азиза",
    owner_name: "Азиз Ахмедов",
    email: "aziz2@example.com",
    password: "password1",
  });
  assert.equal(registered.status, 201);
  // Программа тут стоит на компьютере клуба — вести в неё с сайта некуда.
  assert.equal(registered.body.next, "/account");
});

test("в обычной установке кабинет не зовёт «Открыть программу»", async () => {
  const { app } = makeHub();
  const { agent } = await registerAgent(app);

  // Программа клуба стоит у него на компьютере, а не на этом сервере:
  // кнопка вела бы в никуда, поэтому кабинет её и не показывает.
  const view = await agent.get("/account/api/account");
  assert.equal(view.body.network, false);
  assert.equal((await agent.get("/account/open")).status, 404);
});

test("выход завершает сессию кабинета", async () => {
  const { app } = makeHub();
  const { agent } = await registerAgent(app);
  assert.equal((await agent.get("/account/api/account")).status, 200);

  await agent.post("/account/api/logout");
  assert.equal((await agent.get("/account/api/account")).status, 401);
});

// --- Три разных входа не путаются друг с другом -------------------------------

test("сессия кабинета клуба не даёт доступа в панель сети", async () => {
  const { app } = makeHub();
  const { agent } = await registerAgent(app);
  const res = await agent.get("/hub/api/clubs");
  assert.equal(res.status, 401, "кабинет клиента — не панель сотрудников WesPro");
});

test("сессия панели сети не даёт доступа в кабинет клуба", async () => {
  const { app, hubDb } = makeHub();
  createHubUser(hubDb, { login: "owner", name: "Владелец сервиса", password: "vladelec123" });
  const staff = supertest.agent(app);
  await staff.post("/hub/api/auth/login").send({ login: "owner", password: "vladelec123" });

  const res = await staff.get("/account/api/account");
  assert.equal(res.status, 401, "у сотрудника WesPro нет своего клуба в кабинете");
});

test("сессия кабинета клуба не открывает саму программу клуба", async () => {
  const { app } = makeHub();
  const { agent } = await registerAgent(app);
  const res = await agent.get("/api/dashboard");
  assert.equal(res.status, 401, "кабинет клиента — не рабочий стол программы клуба");
});
