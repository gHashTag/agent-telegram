#!/usr/bin/env node
/**
 * tg — read-only Telegram for agents, over MTProto (gram.js).
 *
 * The Bot API cannot see a person's own conversations; only a user session can.
 * So this logs in as the account itself, which makes two things non-negotiable.
 *
 * FIRST: it cannot send. Not "does not by default" — there is no send path in
 * this file at all. A user session has full write authority over someone's
 * whole social graph, and an agent holding one should not be one bug away from
 * messaging their contacts.
 *
 * SECOND: the session string and api credentials live in the macOS Keychain
 * under service `telegram-agent`, are read on demand, and are never written to
 * this repo or echoed. `tg whoami` reports state without secrets.
 *
 * The login step is the owner's, always: it needs a phone number, a code sent
 * to their device, and possibly a 2FA password. `tg login` runs interactively
 * for a human at a terminal and stores the resulting session. An agent cannot
 * and must not do that part.
 *
 *   tg login                 one-time, interactive, human only
 *   tg whoami                session state, no secrets
 *   tg dialogs [-n N]        chats, newest activity first
 *   tg unread                only chats with unread messages
 *   tg messages <chat> [-n]  messages in one chat
 *   tg search <query> [-n]   global message search
 *   tg selftest              prove the tool without touching the network
 *
 * Every command prints JSON on stdout. Errors go to stderr with a non-zero
 * exit, so a caller can branch on the code without parsing prose.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";

const SERVICE = "telegram-agent";
const MAX_TEXT = 4000;

function die(msg, code = 1) {
  process.stderr.write(msg.endsWith("\n") ? msg : msg + "\n");
  process.exit(code);
}

/** Keychain read. Absent is a normal answer, not a crash. */
function keychain(account) {
  try {
    return execFileSync("security",
      ["find-generic-password", "-s", SERVICE, "-a", account, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function keychainSet(account, value) {
  execFileSync("security",
    ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", value],
    { stdio: ["ignore", "ignore", "ignore"] });
}

function creds() {
  const apiId = keychain("api_id");
  const apiHash = keychain("api_hash");
  const session = keychain("session");
  return { apiId: apiId ? Number(apiId) : null, apiHash, session };
}

function needCreds() {
  const c = creds();
  const missing = Object.entries({ api_id: c.apiId, api_hash: c.apiHash, session: c.session })
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    die(`not configured: ${missing.join(", ")} missing from the Keychain ` +
        `(service ${SERVICE}).\n` +
        `Run \`tg login\` yourself at a terminal — it needs your phone, the code ` +
        `Telegram sends to your device and, if set, your 2FA password. That step ` +
        `belongs to you, not to an agent.\n` +
        `api_id and api_hash come from https://my.telegram.org → API development tools.`);
  }
  return c;
}

async function connect() {
  const { apiId, apiHash, session } = needCreds();
  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions/index.js");
  const client = new TelegramClient(new StringSession(session), apiId, apiHash,
    { connectionRetries: 3, useWSS: false, baseLogger: undefined });
  client.setLogLevel?.("none");
  await client.connect();
  if (!(await client.checkAuthorization())) {
    die("the stored session is no longer authorized — run `tg login` again");
  }
  return client;
}

const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + "\n");

/** Bodies here can be enormous; an untruncated dump buries the rest of an
 *  agent's context. Report the cut rather than hiding it. */
function clip(text) {
  const s = String(text ?? "");
  if (s.length <= MAX_TEXT) return { text: s, chars: s.length, truncated: false };
  return { text: s.slice(0, MAX_TEXT), chars: s.length, truncated: true };
}

function peerName(e) {
  if (!e) return null;
  return e.title || [e.firstName, e.lastName].filter(Boolean).join(" ") ||
         e.username || String(e.id ?? "");
}

async function cmdWhoami() {
  const c = creds();
  const state = {
    service: SERVICE,
    api_id: c.apiId ? "present" : "MISSING",
    api_hash: c.apiHash ? "present" : "MISSING",
    session: c.session ? `present (${c.session.length} chars)` : "MISSING",
    can_send: false,
    note: "read-only by construction: this file contains no send path",
  };
  if (!c.apiId || !c.apiHash || !c.session) { out(state); return; }
  const client = await connect();
  const me = await client.getMe();
  await client.disconnect();
  out({ ...state, account: { id: String(me.id), username: me.username ?? null,
        name: peerName(me), phone: me.phone ? "present" : null } });
}

async function cmdDialogs(limit, onlyUnread) {
  const client = await connect();
  const dialogs = await client.getDialogs({ limit });
  await client.disconnect();
  const rows = dialogs
    .filter((d) => (onlyUnread ? d.unreadCount > 0 : true))
    .map((d) => ({
      id: String(d.id),
      name: d.title || peerName(d.entity),
      kind: d.isChannel ? "channel" : d.isGroup ? "group" : "user",
      unread: d.unreadCount ?? 0,
      last: d.message?.date ? new Date(d.message.date * 1000).toISOString().slice(0, 16).replace("T", " ") : null,
      preview: (d.message?.message ?? "").slice(0, 160),
    }));
  out(rows);
}

async function cmdMessages(chat, limit) {
  const client = await connect();
  let entity;
  try {
    entity = await client.getEntity(/^-?\d+$/.test(chat) ? BigInt(chat) : chat);
  } catch {
    await client.disconnect();
    die(`no chat matches ${JSON.stringify(chat)} — use an id or @username from \`tg dialogs\``);
  }
  const msgs = await client.getMessages(entity, { limit });
  const me = await client.getMe();
  await client.disconnect();
  out(msgs.map((m) => {
    const c = clip(m.message);
    return {
      id: m.id,
      at: m.date ? new Date(m.date * 1000).toISOString().slice(0, 16).replace("T", " ") : null,
      direction: m.out ? "out" : "in",
      from: m.out ? peerName(me) : peerName(m.sender) ?? null,
      text: c.text, chars: c.chars, truncated: c.truncated,
      has_media: Boolean(m.media),
    };
  }).reverse());
}

async function cmdSearch(query, limit) {
  const client = await connect();
  const res = await client.getMessages(undefined, { search: query, limit });
  await client.disconnect();
  if (!res.length) {
    out([]);
    process.stderr.write(
      "no matches. Telegram's global search covers message TEXT; it does not " +
      "match on sender name, and it does not reach channels you are not in.\n");
    return;
  }
  out(res.map((m) => {
    const c = clip(m.message);
    return {
      id: m.id,
      chat: peerName(m.chat) ?? String(m.chatId ?? ""),
      at: m.date ? new Date(m.date * 1000).toISOString().slice(0, 16).replace("T", " ") : null,
      direction: m.out ? "out" : "in",
      text: c.text, chars: c.chars, truncated: c.truncated,
    };
  }));
}

async function cmdLogin() {
  if (!process.stdin.isTTY) {
    die("`tg login` needs a real terminal: it asks for your phone, the code " +
        "Telegram sends to your device and, if set, your 2FA password.\n" +
        "An agent cannot run this, and should not.");
  }
  const input = (await import("input")).default;
  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions/index.js");

  let apiId = keychain("api_id"), apiHash = keychain("api_hash");
  if (!apiId || !apiHash) {
    console.log("api_id and api_hash come from https://my.telegram.org → API development tools.");
    apiId = String(await input.text("api_id: "));
    apiHash = String(await input.text("api_hash: "));
    keychainSet("api_id", apiId);
    keychainSet("api_hash", apiHash);
    console.log("stored in the Keychain, service " + SERVICE);
  }
  const client = new TelegramClient(new StringSession(""), Number(apiId), apiHash,
    { connectionRetries: 3 });
  await client.start({
    phoneNumber: async () => await input.text("phone (+7…): "),
    phoneCode: async () => await input.text("code from Telegram: "),
    password: async () => await input.password("2FA password (blank if none): "),
    onError: (e) => console.error(String(e)),
  });
  keychainSet("session", client.session.save());
  const me = await client.getMe();
  await client.disconnect();
  console.log(`\nlogged in as ${peerName(me)}${me.username ? " (@" + me.username + ")" : ""}`);
  console.log("session stored in the Keychain. It is not written to this repo.");
  console.log("This tool cannot send: there is no send path in tg.mjs.");
}

/** Controls that need no network and no session. They prove the parts that
 *  silently rot: truncation, the shape of a name, and — the one that matters —
 *  that no send path has crept in. */
function cmdSelftest() {
  let ok = true;
  const check = (name, cond, detail = "") => {
    if (!cond) ok = false;
    console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  };
  // Read this file and grep it for a send path. The check that matters is
  // the one that keeps mattering after someone edits the file in a hurry.
  // Read this file and look for a CALL to a write method, not for the words.
  // The first cut grepped for bare "sendMessage" and failed on its own check
  // text - a self-referential guard that can never pass. Build the pattern from
  // fragments so this line cannot match itself, and require call syntax.
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const writeCall = new RegExp(
    "\\.\\s*(" + ["send" + "Message", "send" + "File", "forward" + "Messages",
                 "delete" + "Messages", "edit" + "Message"].join("|") + ")\\s*\\(");
  check("no write call to Telegram", !writeCall.test(src),
        "a user session has full write authority; this file must not use it");

  const long = clip("x".repeat(MAX_TEXT + 500));
  check("long text is clipped and says so", long.truncated && long.text.length === MAX_TEXT
        && long.chars === MAX_TEXT + 500);
  const short = clip("hello");
  check("short text is untouched", !short.truncated && short.chars === 5);
  check("empty text does not crash", clip(undefined).chars === 0);
  check("peerName prefers title", peerName({ title: "Чат", firstName: "X" }) === "Чат");
  check("peerName falls back to name", peerName({ firstName: "Иван", lastName: "П" }) === "Иван П");
  check("peerName falls back to username", peerName({ username: "ghashtag" }) === "ghashtag");
  const c = creds();
  console.log(`\n  session: ${c.session ? "present" : "absent — run `tg login` yourself"}`);
  console.log(ok ? "\nself-test passed" : "\nSELF-TEST FAILED");
  process.exit(ok ? 0 : 1);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const nFlag = rest.indexOf("-n");
  const limit = nFlag >= 0 ? Number(rest[nFlag + 1]) : 25;
  const args = rest.filter((a, i) => a !== "-n" && rest[i - 1] !== "-n");
  try {
    switch (cmd) {
      case "login": return await cmdLogin();
      case "whoami": return await cmdWhoami();
      case "dialogs": return await cmdDialogs(limit, false);
      case "unread": return await cmdDialogs(Math.max(limit, 100), true);
      case "messages":
        if (!args[0]) die("tg messages <chat id | @username> [-n N]");
        return await cmdMessages(args[0], limit);
      case "search":
        if (!args[0]) die("tg search <query> [-n N]");
        return await cmdSearch(args.join(" "), limit);
      case "selftest": return cmdSelftest();
      default:
        process.stdout.write(
          "tg — read-only Telegram for agents (MTProto). Cannot send by construction.\n\n" +
          "  tg login                 one-time, interactive, human only\n" +
          "  tg whoami                session state, no secrets\n" +
          "  tg dialogs [-n N]        chats, newest activity first\n" +
          "  tg unread                only chats with unread messages\n" +
          "  tg messages <chat> [-n]  messages in one chat\n" +
          "  tg search <query> [-n]   global message search (TEXT only)\n" +
          "  tg selftest              prove the tool without the network\n");
        process.exit(2);
    }
  } catch (e) {
    die(String(e?.message ?? e));
  }
}

main();
