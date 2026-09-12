// Сеть клубов: один сервер обслуживает много клубов, у каждого своя
// база. Главное, что здесь проверяется, — что клубы не видят друг друга
// ни при каких обстоятельствах, и что зарегистрировавшийся владелец
// действительно попадает в работающую программу.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import supertest from "supertest";

import http from "node:http";

import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db.js";
import { createHubDatabase } from "../src/hub/db.js";
import { createMirrors } from "../src/hub/mirrors.js";
import { createNetworkApp } from "../src/network-app.js";
import { saveSettings, enabledFeatures } from "../src/services/settings.js";
import { runSync, syncStatus } from "../src/services/sync.js";
import { createUser } from "../src/services/users.js";
import { createTenants } from "../src/tenants.js";

const PASSWORD = "parol12345";

/** Сеть с базами клубов во временной папке — как в жизни, файлами. */
function makeNetwork(t) {
  const wasNetwork = process.env.WESPRO_NETWORK;
  process.env.WESPRO_NETWORK = "1";
  t.after(() => {
    if (wasNetwork === undefined) delete process.env.WESPRO_NETWORK;
    else process.env.WESPRO_NETWORK = wasNetwork;
  });
  const hubDb = createHubDatabase(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wespro-clubs-"));
  const tenants = createTenants(hubDb, { dir });
  const app = createNetworkApp(hubDb, { tenants });
  t.after(() => {
    tenants.close();
    hubDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { hubDb, app, tenants, dir };
}

/** Регистрирует клуб и возвращает агента, вошедшего в его программу. */
async function registerAndOpen(app, { name, email }) {
  const agent = supertest.agent(app);
  const registered = await agent.post("/account/api/register").send({
    name,
    owner_name: "Иван Иванов",
    email,
    password: PASSWORD,
  });
  if (registered.status !== 201) {
    throw new Error(`register ${name}: ${registered.status} ${registered.text}`);
  }
  const opened = await agent.get("/account/open").redirects(0);
  if (opened.status !== 302) throw new Error(`open ${name}: ${opened.status}`);
  return agent;
}

test("зарегистрировавшийся владелец попадает в свою работающую программу", async (t) => {
  const { app } = makeNetwork(t);
  const owner = await registerAndOpen(app, { name: "Тетрис", email: "tetris@example.com" });

  const me = await owner.get("/api/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, "owner");
  assert.equal(me.body.user.login, "tetris@example.com");
  // Название клуба из регистрации подставлено в программу, а не осталось
  // «Бильярдный клуб» по умолчанию.
  assert.equal(me.body.club_name, "Тетрис");

  // Программа заведена не пустой: работать можно сразу.
  const tables = await owner.get("/api/tables");
  assert.equal(tables.status, 200);
  assert.equal(tables.body.length, 3);
});

test("клубы не видят данные друг друга", async (t) => {
  const { app } = makeNetwork(t);
  const first = await registerAndOpen(app, { name: "Первый", email: "one@example.com" });
  const second = await registerAndOpen(app, { name: "Второй", email: "two@example.com" });

  const created = await first.post("/api/tables").send({ name: "Секретный стол" });
  assert.equal(created.status, 201);

  const theirs = await second.get("/api/tables");
  assert.equal(theirs.status, 200);
  assert.ok(
    !theirs.body.some((table) => table.name === "Секретный стол"),
    "стол одного клуба не должен быть виден в другом"
  );
  assert.equal(theirs.body.length, 3);
  assert.equal((await first.get("/api/tables")).body.length, 4);
});

test("вход с чистого устройства по почте попадает в нужный клуб", async (t) => {
  const { app } = makeNetwork(t);
  await registerAndOpen(app, { name: "Первый", email: "one@example.com" });
  await registerAndOpen(app, { name: "Второй", email: "two@example.com" });

  const guest = supertest.agent(app);
  const login = await guest
    .post("/api/auth/login")
    .send({ login: "two@example.com", password: PASSWORD });
  assert.equal(login.status, 200);
  assert.equal(login.body.club_name, "Второй");

  // Cookie клуба поставлена вместе с cookie сессии — следующий запрос
  // уходит в тот же клуб, повторно почту вводить не нужно.
  const me = await guest.get("/api/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.club_name, "Второй");
});

test("неверный пароль не привязывает устройство к клубу", async (t) => {
  const { app } = makeNetwork(t);
  await registerAndOpen(app, { name: "Первый", email: "one@example.com" });

  const guest = supertest.agent(app);
  const login = await guest
    .post("/api/auth/login")
    .send({ login: "one@example.com", password: "не тот пароль" });
  assert.equal(login.status, 401);

  const me = await guest.get("/api/auth/me");
  assert.equal(me.status, 401, "клуб не выбран — устройство осталось чистым");
});

test("незнакомая почта: понятная подсказка, а не «неверный пароль»", async (t) => {
  const { app } = makeNetwork(t);
  const guest = supertest.agent(app);
  const login = await guest
    .post("/api/auth/login")
    .send({ login: "нет-такого@example.com", password: PASSWORD });
  assert.equal(login.status, 401);
  assert.match(login.body.detail, /коду клуба/);
});

test("неизвестный код клуба возвращает на вход, а не на витрину", async (t) => {
  const { app } = makeNetwork(t);
  const guest = supertest.agent(app);
  // Человек шёл на работу, а не читать описание системы: он должен
  // увидеть, что ошибся кодом, и попробовать ещё раз.
  const res = await guest.get("/login?club=нет-такого-кода").redirects(0);
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /unknown_club/);

  // И устройство не оказалось привязано к чужому клубу.
  const tables = await guest.get("/api/tables");
  assert.equal(tables.status, 401);
});

test("зарегистрированный клуб получает читаемую ссылку по названию", async (t) => {
  const { hubDb, app } = makeNetwork(t);
  await registerAndOpen(app, { name: "Бильярд Тетрис", email: "one@example.com" });

  const { slug } = hubDb.prepare("SELECT slug FROM clubs WHERE email = ?").get("one@example.com");
  assert.equal(slug, "bilyard-tetris");
});

test("клубы, чьи названия дают одинаковый адрес, получают разные адреса", async (t) => {
  const { hubDb, app } = makeNetwork(t);
  // Названия разные (иначе регистрация отклонит вторую как дубликат), но
  // после очистки от знаков препинания превращаются в один и тот же slug.
  await registerAndOpen(app, { name: "Тетрис", email: "one@example.com" });
  await registerAndOpen(app, { name: "Тетрис!", email: "two@example.com" });

  const first = hubDb.prepare("SELECT slug FROM clubs WHERE email = ?").get("one@example.com");
  const second = hubDb.prepare("SELECT slug FROM clubs WHERE email = ?").get("two@example.com");
  assert.equal(first.slug, "tetris");
  assert.equal(second.slug, "tetris-2");
});

test("сотрудник заходит по читаемой ссылке /login/adminpanel/<название>", async (t) => {
  const { hubDb, app } = makeNetwork(t);
  const owner = await registerAndOpen(app, { name: "Тетрис", email: "one@example.com" });
  await owner
    .post("/api/users")
    .send({ login: "kassir", name: "Кассир Иван", password: "1234", role: "cashier" });

  const { slug } = hubDb.prepare("SELECT slug FROM clubs WHERE email = ?").get("one@example.com");
  const cashier = supertest.agent(app);
  const step = await cashier.get(`/login/adminpanel/${slug}`).redirects(0);
  assert.equal(step.status, 302);
  assert.equal(step.headers.location, "/login");

  const login = await cashier.post("/api/auth/login").send({ login: "kassir", password: "1234" });
  assert.equal(login.status, 200);
  assert.equal(login.body.club_name, "Тетрис");
});

test("неизвестная читаемая ссылка возвращает на вход с понятной причиной", async (t) => {
  const { app } = makeNetwork(t);
  const guest = supertest.agent(app);
  const res = await guest.get("/login/adminpanel/net-takogo-kluba").redirects(0);
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /unknown_club/);
});

test("в кабинете показана читаемая ссылка, а не код", async (t) => {
  const { app } = makeNetwork(t);
  const owner = await registerAndOpen(app, { name: "Тетрис", email: "one@example.com" });
  const view = await owner.get("/account/api/account");
  assert.equal(view.body.club.slug, "tetris");
});

test("кассир входит по коду клуба, без ссылки", async (t) => {
  const { hubDb, app } = makeNetwork(t);
  const owner = await registerAndOpen(app, { name: "Первый", email: "one@example.com" });
  await owner
    .post("/api/users")
    .send({ login: "kassir", name: "Кассир Иван", password: "1234", role: "cashier" });

  const { code } = hubDb.prepare("SELECT code FROM clubs WHERE email = ?").get("one@example.com");
  const cashier = supertest.agent(app);
  // Ровно то, что делает страница входа с введённым кодом.
  const step = await cashier.get(`/login?club=${code}`).redirects(0);
  assert.equal(step.headers.location, "/login");

  const login = await cashier.post("/api/auth/login").send({ login: "kassir", password: "1234" });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, "cashier");
  assert.equal(login.body.club_name, "Первый");
});

test("сотрудник заходит по ссылке клуба своим логином и паролем", async (t) => {
  const { hubDb, app } = makeNetwork(t);
  const owner = await registerAndOpen(app, { name: "Первый", email: "one@example.com" });
  await registerAndOpen(app, { name: "Второй", email: "two@example.com" });

  const created = await owner.post("/api/users").send({
    login: "kassir",
    name: "Кассир Иван",
    password: "1234",
    role: "cashier",
  });
  assert.equal(created.status, 201);

  const { code } = hubDb.prepare("SELECT code FROM clubs WHERE email = ?").get("one@example.com");
  const cashier = supertest.agent(app);
  const link = await cashier.get(`/login?club=${code}`).redirects(0);
  assert.equal(link.status, 302);

  const login = await cashier.post("/api/auth/login").send({ login: "kassir", password: "1234" });
  assert.equal(login.status, 200);
  assert.equal(login.body.club_name, "Первый");
});

test("кассир одного клуба не войдёт в другой клуб по его ссылке", async (t) => {
  const { hubDb, app } = makeNetwork(t);
  const owner = await registerAndOpen(app, { name: "Первый", email: "one@example.com" });
  await registerAndOpen(app, { name: "Второй", email: "two@example.com" });
  await owner
    .post("/api/users")
    .send({ login: "kassir", name: "Кассир Иван", password: "1234", role: "cashier" });

  const { code } = hubDb.prepare("SELECT code FROM clubs WHERE email = ?").get("two@example.com");
  const stranger = supertest.agent(app);
  await stranger.get(`/login?club=${code}`).redirects(0);
  const login = await stranger.post("/api/auth/login").send({ login: "kassir", password: "1234" });
  assert.equal(login.status, 401);
});

test("подписка приостановлена: программа закрыта, кабинет открыт", async (t) => {
  const { hubDb, app } = makeNetwork(t);
  const owner = await registerAndOpen(app, { name: "Первый", email: "one@example.com" });
  assert.equal((await owner.get("/api/tables")).status, 200);

  hubDb.prepare("UPDATE clubs SET blocked_manually = 1 WHERE email = ?").run("one@example.com");

  const blocked = await owner.get("/api/tables");
  assert.equal(blocked.status, 402);
  assert.match(blocked.body.detail, /одписк/);

  // Кабинет остаётся доступным — иначе оплатить было бы негде.
  assert.equal((await owner.get("/account/api/account")).status, 200);

  hubDb.prepare("UPDATE clubs SET blocked_manually = 0 WHERE email = ?").run("one@example.com");
  assert.equal((await owner.get("/api/tables")).status, 200);
});

test("смена пароля в кабинете меняет и пароль входа в программу", async (t) => {
  const { app } = makeNetwork(t);
  const owner = await registerAndOpen(app, { name: "Первый", email: "one@example.com" });

  const changed = await owner
    .post("/account/api/password")
    .send({ old_password: PASSWORD, new_password: "noviy-parol" });
  assert.equal(changed.status, 200);

  const oldWay = await supertest
    .agent(app)
    .post("/api/auth/login")
    .send({ login: "one@example.com", password: PASSWORD });
  assert.equal(oldWay.status, 401);

  const newWay = await supertest
    .agent(app)
    .post("/api/auth/login")
    .send({ login: "one@example.com", password: "noviy-parol" });
  assert.equal(newWay.status, 200);
});

test("гость без выбранного клуба видит витрину, а не чужую программу", async (t) => {
  const { app } = makeNetwork(t);
  await registerAndOpen(app, { name: "Первый", email: "one@example.com" });

  const guest = supertest.agent(app);
  const home = await guest.get("/");
  assert.equal(home.status, 200);
  assert.match(home.text, /WesPro/);
  assert.equal((await guest.get("/api/tables")).status, 401);
});

/** Заводит в клубе разработчика и возвращает вошедшего им агента. */
async function developerIn(app, hubDb, { owner, email }) {
  const created = await owner.post("/api/users").send({
    login: "dev",
    name: "Разработчик",
    password: "dev12345",
    role: "developer",
  });
  if (created.status !== 201) throw new Error(`developer: ${created.status} ${created.text}`);
  const { code } = hubDb.prepare("SELECT code FROM clubs WHERE email = ?").get(email);
  const agent = supertest.agent(app);
  await agent.get(`/login?club=${code}`).redirects(0);
  const login = await agent.post("/api/auth/login").send({ login: "dev", password: "dev12345" });
  if (login.status !== 200) throw new Error(`developer login: ${login.status}`);
  return agent;
}

test("журнал запросов клуба не показывает чужие запросы", async (t) => {
  const { hubDb, app } = makeNetwork(t);
  const first = await registerAndOpen(app, { name: "Первый", email: "one@example.com" });
  const second = await registerAndOpen(app, { name: "Второй", email: "two@example.com" });
  await second.get("/api/tables");

  const dev = await developerIn(app, hubDb, { owner: first, email: "one@example.com" });
  await dev.get("/api/tables");
  const log = await dev.get("/api/support/requests");
  assert.equal(log.status, 200);

  const users = log.body.requests.map((r) => r.user ?? "");
  assert.ok(
    users.some((u) => u.includes("dev")),
    "свои запросы в журнале быть должны — иначе проверка ничего не значит"
  );
  assert.ok(
    !users.some((u) => u.includes("two@example.com")),
    "запросы соседнего клуба не должны попадать в журнал"
  );
});

test("клуб не может перезапустить общий сервер сети", async (t) => {
  const { hubDb, app } = makeNetwork(t);
  const owner = await registerAndOpen(app, { name: "Первый", email: "one@example.com" });
  const dev = await developerIn(app, hubDb, { owner, email: "one@example.com" });

  // Перезапуск уронил бы работу всех остальных клубов, поэтому закрыт
  // даже разработчику клуба.
  const restart = await dev.post("/api/system/restart");
  assert.equal(restart.status, 403);
  assert.match(restart.body.detail, /поддержка WesPro/);

  // Общий журнал внутренних ошибок и адреса самой машины — тоже не их.
  assert.equal((await dev.get("/api/diagnostics")).status, 403);
  assert.equal((await dev.get("/api/network")).status, 403);
});

test("кабинет в сети показывает кнопку «Открыть программу»", async (t) => {
  const { app } = makeNetwork(t);
  const owner = await registerAndOpen(app, { name: "Первый", email: "one@example.com" });
  const view = await owner.get("/account/api/account");
  assert.equal(view.body.network, true);
});

test("после регистрации в сети везут сразу в программу", async (t) => {
  const { app } = makeNetwork(t);
  const agent = supertest.agent(app);
  const registered = await agent.post("/account/api/register").send({
    name: "Первый",
    owner_name: "Иван Иванов",
    email: "one@example.com",
    password: PASSWORD,
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.next, "/account/open");

  // И этот адрес действительно открывает программу вошедшим владельцем.
  const opened = await agent.get(registered.body.next).redirects(0);
  assert.equal(opened.status, 302);
  const me = await agent.get("/api/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.club_name, "Первый");
});

test("у каждого клуба свой файл базы", async (t) => {
  const { hubDb, app, dir } = makeNetwork(t);
  await registerAndOpen(app, { name: "Первый", email: "one@example.com" });
  await registerAndOpen(app, { name: "Второй", email: "two@example.com" });

  for (const { id } of hubDb.prepare("SELECT id FROM clubs").all()) {
    assert.ok(
      fs.existsSync(path.join(dir, String(id), "billiards.db")),
      `база клуба ${id} должна лежать отдельным файлом`
    );
  }
});

test("панель сети видит, что происходит в клубах прямо сейчас", async (t) => {
  const { app, hubDb } = makeNetwork(t);
  const { createHubUser } = await import("../src/hub/auth.js");
  createHubUser(hubDb, { login: "boss", name: "Владелец сети", password: "boss12345" });
  const owner = await registerAndOpen(app, { name: "Тетрис", email: "tetris@example.com" });
  await registerAndOpen(app, { name: "Тихий", email: "quiet@example.com" });

  // В «Тетрисе» открыли смену и первый из заведённых при регистрации столов.
  const tables = (await owner.get("/api/tables")).body;
  const tariff = await owner.post("/api/tariffs").send({ name: "Дневной", price_per_hour: 400 });
  assert.equal((await owner.post("/api/shifts/open").send({})).status, 201);
  assert.equal(
    (await owner.post(`/api/tables/${tables[0].id}/open`).send({ tariff_id: tariff.body.id })).status,
    201
  );

  const boss = supertest.agent(app);
  assert.equal(
    (await boss.post("/hub/api/auth/login").send({ login: "boss", password: "boss12345" })).status,
    200
  );
  const clubs = (await boss.get("/hub/api/clubs?status=all")).body;
  const live = (await boss.get("/hub/api/live")).body;
  const tetris = live[clubs.find((c) => c.name === "Тетрис").id];
  assert.equal(tetris.tables_total, tables.length);
  assert.equal(tetris.tables_busy, 1);
  assert.equal(tetris.shift.cashier, "Иван Иванов");
  assert.equal(tetris.revenue_today, 0);
  assert.equal(tetris.relays_total, 0);
  const quiet = live[clubs.find((c) => c.name === "Тихий").id];
  assert.equal(quiet.tables_busy, 0);
  assert.equal(quiet.shift, null);
});

test("панель сети управляет программой клуба: сотрудники, журнал, копия, вход", async (t) => {
  const { app, hubDb } = makeNetwork(t);
  const { createHubUser } = await import("../src/hub/auth.js");
  createHubUser(hubDb, { login: "boss", name: "Владелец сети", password: "boss12345" });
  const owner = await registerAndOpen(app, { name: "Тетрис", email: "tetris@example.com" });
  await owner.post("/api/shifts/open").send({});

  const boss = supertest.agent(app);
  await boss.post("/hub/api/auth/login").send({ login: "boss", password: "boss12345" });
  const club = (await boss.get("/hub/api/clubs?status=all")).body.find((c) => c.name === "Тетрис");
  const base = `/hub/api/clubs/${club.id}/program`;

  const live = await boss.get(`${base}/live`);
  assert.equal(live.status, 200);
  assert.ok(Array.isArray(live.body.tables));
  assert.equal(live.body.shift.cashier, "Иван Иванов");
  assert.equal(live.body.hours_today.length, 24);

  const users = (await boss.get(`${base}/users`)).body;
  const ownerUser = users.find((u) => u.login === "tetris@example.com");
  assert.ok(ownerUser, "владелец клуба виден панели");

  // Новый пароль владельцу — и старый больше не подходит.
  const reset = await boss.put(`${base}/users/${ownerUser.id}`).send({ password: "noviy-parol-1" });
  assert.equal(reset.status, 200);
  const stale = await supertest.agent(app).post("/api/auth/login").send({ login: "tetris@example.com", password: PASSWORD });
  assert.equal(stale.status, 401);
  const fresh = await supertest.agent(app).post("/api/auth/login").send({ login: "tetris@example.com", password: "noviy-parol-1" });
  assert.equal(fresh.status, 200);

  // Забытая смена закрывается из панели.
  const closed = await boss.post(`${base}/shift/close`);
  assert.equal(closed.status, 200);
  assert.equal((await boss.post(`${base}/shift/close`)).status, 409);

  const journal = await boss.get(`${base}/journal`);
  assert.equal(journal.status, 200);
  assert.ok(journal.body.some((e) => e.event === "shift_closed"));

  const backup = await boss.get(`${base}/backup`);
  assert.equal(backup.status, 200);
  assert.match(backup.headers["content-disposition"], /billiards-backup-/);

  // Вход в программу клуба одним кликом — разработчиком поддержки со своим
  // аккаунтом; в журнале сети и клуба остаётся след, а клуб видит, что
  // разработчик внутри.
  assert.equal((await owner.get("/api/support/presence")).body.developer, null);
  const open = await boss.get(`${base}/open`).redirects(0);
  assert.equal(open.status, 302);
  const me = await boss.get("/api/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.user.login, "support:boss");
  assert.equal(me.body.user.role, "developer");
  const hubJournal = (await boss.get("/hub/api/journal")).body.entries;
  assert.ok(hubJournal.some((e) => e.event === "support_login" && /из панели сети/.test(e.message)));
  const presence = (await owner.get("/api/support/presence")).body.developer;
  assert.ok(presence, "клуб видит разработчика");
  assert.match(presence.name, /Владелец сети/);
  assert.ok((await owner.get("/api/auth/me")).body.support);
  const clubJournal = (await boss.get(`${base}/journal`)).body;
  assert.ok(clubJournal.some((e) => e.event === "support_login"));
  // Повторный вход тем же сотрудником панели аккаунт не плодит.
  await boss.get(`${base}/open`).redirects(0);
  const supportAccounts = (await boss.get(`${base}/users`)).body.filter((u) => u.login.startsWith("support:"));
  assert.equal(supportAccounts.length, 1);

  // Клуб без базы и чужой номер — 404, а не падение.
  assert.equal((await boss.get("/hub/api/clubs/999/program/live")).status, 404);
});

test("новшества включаются каждому клубу отдельно, а можно и всем разом", async (t) => {
  const { app, hubDb } = makeNetwork(t);
  const { createHubUser } = await import("../src/hub/auth.js");
  createHubUser(hubDb, { login: "boss", name: "Владелец сети", password: "boss12345" });
  const tetris = await registerAndOpen(app, { name: "Тетрис", email: "tetris@example.com" });
  const nine = await registerAndOpen(app, { name: "Девятка", email: "nine@example.com" });

  // По умолчанию всё включено.
  const me = await tetris.get("/api/auth/me");
  assert.deepEqual(me.body.features, { devices: true, motion: true, board: true });
  assert.equal((await tetris.get("/board")).status, 200);

  const boss = supertest.agent(app);
  await boss.post("/hub/api/auth/login").send({ login: "boss", password: "boss12345" });
  const clubs = (await boss.get("/hub/api/clubs?status=all")).body;
  const tetrisId = clubs.find((c) => c.name === "Тетрис").id;

  // Одному клубу выключили устройства и экран — второй не заметил.
  const off = await boss
    .put(`/hub/api/clubs/${tetrisId}/program/features`)
    .send({ devices: false, board: false });
  assert.equal(off.status, 200);
  assert.deepEqual(off.body.enabled, { devices: false, motion: true, board: false });
  assert.deepEqual((await tetris.get("/api/auth/me")).body.features, { devices: false, motion: true, board: false });
  assert.equal((await tetris.get("/board")).status, 404);
  assert.deepEqual((await nine.get("/api/auth/me")).body.features, { devices: true, motion: true, board: true });

  // Сводка по сети: у скольких включено.
  const summary = (await boss.get("/hub/api/features")).body;
  assert.equal(summary.clubs_total, 2);
  assert.equal(summary.features.find((f) => f.key === "devices").enabled_count, 1);

  // Всем разом.
  const all = await boss.put("/hub/api/features/motion").send({ enabled: false });
  assert.equal(all.body.updated, 2);
  assert.equal((await nine.get("/api/auth/me")).body.features.motion, false);
  assert.equal((await boss.put("/hub/api/features/nope").send({ enabled: true })).status, 404);

  // Версия ступенью: 1.9.0 — только экран для гостей; текущая — всё.
  const step = await boss.put(`/hub/api/clubs/${tetrisId}/program/features`).send({ version: "1.9.0" });
  assert.equal(step.status, 200);
  assert.deepEqual(step.body.enabled, { board: true, devices: false, motion: false });
  assert.equal(step.body.version.version, "1.9.0");
  assert.equal(step.body.version.current, false);
  assert.ok(step.body.versions.some((v) => v.label === "текущая"));
  const bad = await boss.put(`/hub/api/clubs/${tetrisId}/program/features`).send({ version: "9.9.9" });
  assert.equal(bad.status, 409);

  const latest = step.body.current_version;
  const everyone = await boss.put("/hub/api/features/version").send({ version: latest });
  assert.equal(everyone.body.updated, 2);
  const after = (await boss.get(`/hub/api/clubs/${tetrisId}/program/features`)).body;
  assert.equal(after.version.current, true);
  assert.deepEqual(after.enabled, { board: true, devices: true, motion: true });
});

test("офлайн-клуб (exe) присылает снимок базы, и панель видит его как облачный", async (t) => {
  const { app, hubDb, dir } = makeNetwork(t);
  const { createHubUser } = await import("../src/hub/auth.js");
  createHubUser(hubDb, { login: "boss", name: "Владелец сети", password: "boss12345" });
  const mirrorsDir = path.join(dir, "mirrors");
  // Панель слушает настоящий порт: клуб у себя ходит к ней по HTTP.
  const hubApp = createNetworkApp(hubDb, { tenants: createTenants(hubDb, { dir: path.join(dir, "cloud") }), mirrors: createMirrors({ dir: mirrorsDir }) });
  const server = http.createServer(hubApp);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const hubUrl = `http://127.0.0.1:${server.address().port}`;

  const boss = supertest.agent(hubApp);
  await boss.post("/hub/api/auth/login").send({ login: "boss", password: "boss12345" });
  const created = await boss.post("/hub/api/clubs").send({ name: "Офлайн-клуб", city: "Фергана" });
  assert.equal(created.status, 201);
  const club = created.body;

  // Программа клуба у себя: своя база, ключ клуба из панели.
  const clubDb = createDatabase(":memory:");
  createUser(clubDb, { login: "admin", password: "admin1", name: "Админ", role: "admin" });
  saveSettings(clubDb, { wespro_hub_url: hubUrl, wespro_club_key: club.api_key, club_name: "Офлайн-клуб" });
  const clubApp = createApp(clubDb);
  const admin = supertest.agent(clubApp);
  await admin.post("/api/auth/login").send({ login: "admin", password: "admin1" });
  await admin.post("/api/shifts/open").send({});
  await admin.post("/api/tables").send({ name: "Стол у окна" });

  assert.equal(syncStatus(clubDb).pending, true, "снимок ещё не уезжал");
  const status = await runSync(clubDb);
  assert.equal(status.error, null);
  assert.ok(status.last_snapshot_at, "снимок уехал");
  assert.equal(status.pending, false);
  assert.ok(fs.existsSync(path.join(mirrorsDir, String(club.id), "billiards.db")));

  // Панель видит клуб по снимку — как облачный, только с пометкой.
  const live = (await boss.get("/hub/api/live")).body[club.id];
  assert.equal(live.mirror, true);
  assert.ok(live.snapshot_at);
  assert.equal(live.tables_total, 1);
  assert.equal(live.shift.cashier, "Админ");
  const detail = await boss.get(`/hub/api/clubs/${club.id}/program/live`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.tables[0].name, "Стол у окна");
  const users = await boss.get(`/hub/api/clubs/${club.id}/program/users`);
  assert.ok(users.body.some((u) => u.login === "admin"));

  // Снимок — только чтение: сотрудников и смену правят в самом клубе.
  const denied = await boss.put(`/hub/api/clubs/${club.id}/program/users/${users.body[0].id}`).send({ password: "x1234" });
  assert.equal(denied.status, 409);
  assert.equal((await boss.get(`/hub/api/clubs/${club.id}/program/open`).redirects(0)).status, 409);

  // А новшества доходят: панель выключила устройства — клуб применил на следующем ping.
  const off = await boss.put(`/hub/api/clubs/${club.id}/program/features`).send({ devices: false });
  assert.equal(off.status, 200);
  assert.equal(enabledFeatures(clubDb).devices, true, "до ping клуб ещё не знает");
  await runSync(clubDb);
  assert.equal(enabledFeatures(clubDb).devices, false);
  assert.equal((await admin.get("/api/auth/me")).body.features.devices, false);

  // Без изменений снимок повторно не шлётся, с изменениями — шлётся.
  const before = syncStatus(clubDb).last_snapshot_at;
  await runSync(clubDb);
  assert.equal(syncStatus(clubDb).last_snapshot_at, before);
  await admin.post("/api/tables").send({ name: "Стол у двери" });
  await runSync(clubDb);
  assert.notEqual(syncStatus(clubDb).last_snapshot_at, before);
  assert.equal((await boss.get("/hub/api/live")).body[club.id].tables_total, 2);

  // Нет связи — не авария: статус говорит, что не так, программа работает.
  saveSettings(clubDb, { wespro_hub_url: "http://127.0.0.1:1" });
  const offline = await runSync(clubDb);
  assert.ok(offline.error);
  assert.equal((await admin.get("/api/tables")).status, 200);
  // Соединения keep-alive держат сервер — рвём их, иначе close ждёт вечно.
  server.closeAllConnections();
  server.close();
  clubDb.close();
});

test("WesPro.exe: владелец сети загружает в панель, клуб скачивает из настроек", async (t) => {
  const { app, dir, hubDb } = makeNetwork(t);
  const wasDir = process.env.WESPRO_DOWNLOADS_DIR;
  process.env.WESPRO_DOWNLOADS_DIR = path.join(dir, "downloads");
  t.after(() => {
    if (wasDir === undefined) delete process.env.WESPRO_DOWNLOADS_DIR;
    else process.env.WESPRO_DOWNLOADS_DIR = wasDir;
  });
  const club = await registerAndOpen(app, { name: "Exe", email: "exe@x.uz" });

  // Пока ничего не загружено — у клуба кнопки нет, скачивать нечего.
  assert.equal((await club.get("/api/exe")).body.exe, null);
  assert.equal((await supertest(app).get("/download/WesPro.exe")).status, 404);

  const { createHubUser } = await import("../src/hub/auth.js");
  createHubUser(hubDb, { login: "boss", name: "Владелец сети", password: "boss12345" });
  const hub = supertest.agent(app);
  await hub.post("/hub/api/auth/login").send({ login: "boss", password: "boss12345" });
  assert.equal((await hub.get("/hub/api/exe")).body.exe, null);

  // Мелочь и не-exe не принимаем.
  const small = await hub.post("/hub/api/exe").set("Content-Type", "application/octet-stream").send(Buffer.from("MZ tiny"));
  assert.equal(small.status, 409);
  const notExe = Buffer.alloc(21 * 1024 * 1024, 1);
  assert.equal((await hub.post("/hub/api/exe").set("Content-Type", "application/octet-stream").send(notExe)).status, 409);

  const exe = Buffer.alloc(21 * 1024 * 1024, 7);
  exe.write("MZ", 0, "latin1");
  const uploaded = await hub.post("/hub/api/exe").set("Content-Type", "application/octet-stream").set("X-Version", "1.20.0").send(exe);
  assert.equal(uploaded.status, 200, uploaded.text);
  assert.equal(uploaded.body.exe.version, "1.20.0");
  assert.equal(uploaded.body.exe.size, exe.length);
  assert.equal(uploaded.body.exe.by, "Владелец сети");

  const shown = (await club.get("/api/exe")).body.exe;
  assert.equal(shown.version, "1.20.0");
  const download = await supertest(app).get("/download/WesPro.exe").buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });
  assert.equal(download.status, 200);
  assert.match(download.headers["content-disposition"], /WesPro\.exe/);
  assert.equal(download.body.length, exe.length);
  assert.equal(download.body[0], 0x4d);
});
