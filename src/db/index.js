import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'store.json');

function readStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) return { users: {}, answers: {} };
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { users: {}, answers: {} };
  }
}

function writeStore(store) {
  fs.writeFileSync(DB_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

export function getDb() {
  // JSON store does not require a db object; return noop token
  return {};
}

export function getUserProgress(_db, userId) {
  const store = readStore();
  return store.users[userId] || null;
}

export function upsertUserProgress(_db, userId, fields) {
  const store = readStore();
  const current = store.users[userId] || { user_id: userId };
  const merged = { ...current, ...fields };
  store.users[userId] = merged;
  writeStore(store);
  return merged;
}

export function saveAnswer(_db, userId, questionIndex, optionKey) {
  const store = readStore();
  if (!store.answers[userId]) store.answers[userId] = {};
  store.answers[userId][String(questionIndex)] = { option_key: optionKey, created_at: Date.now() };
  writeStore(store);
}

export function getAnswers(_db, userId) {
  const store = readStore();
  const userAnswers = store.answers[userId] || {};
  return Object.keys(userAnswers).sort((a,b)=>Number(a)-Number(b)).map(k => ({ question_index: Number(k), option_key: userAnswers[k].option_key }));
}

export function getActiveStartMessageForChannel(_db, channelId) {
  const store = readStore();
  const map = (store.meta && store.meta.activeStartMessages) ? store.meta.activeStartMessages : {};
  return map[channelId] || null;
}

export function setActiveStartMessageForChannel(_db, channelId, messageId) {
  const store = readStore();
  if (!store.meta) store.meta = {};
  if (!store.meta.activeStartMessages) store.meta.activeStartMessages = {};
  store.meta.activeStartMessages[channelId] = messageId;
  writeStore(store);
  return messageId;
}


