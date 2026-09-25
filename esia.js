import crypto from 'crypto';
import { dbOperations } from './db.js';

const pendingStates = new Map();
const STATE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_SCOPE = 'openid fullname birthdate gender snils contacts mobile email';

function esiaBase() {
  return process.env.ESIA_ENV === 'test'
    ? 'https://esia-portal1.test.gosuslugi.ru'
    : 'https://esia.gosuslugi.ru';
}

function esiaScope() {
  return process.env.ESIA_SCOPE || DEFAULT_SCOPE;
}

export function esiaConfigured() {
  return Boolean(
    process.env.ESIA_CLIENT_ID
    && process.env.ESIA_REDIRECT_URI
    && process.env.ESIA_CERT_HASH
    && process.env.ESIA_SIGNER_URL
  );
}

function linkSecret() {
  return String(process.env.BOT_TOKEN || '').trim() || 'esia-link';
}

export function signEsiaLink(userId) {
  return crypto.createHmac('sha256', linkSecret()).update(`esia:${Number(userId)}`).digest('hex').slice(0, 32);
}

export function verifyEsiaLink(userId, sig) {
  if (!userId || !sig) return false;
  const expected = Buffer.from(signEsiaLink(userId));
  const given = Buffer.from(String(sig));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function esiaTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} `
    + `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

async function signForEsia(text) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.ESIA_SIGNER_TOKEN) headers.Authorization = `Bearer ${process.env.ESIA_SIGNER_TOKEN}`;
  const res = await fetch(process.env.ESIA_SIGNER_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ data: Buffer.from(text, 'utf8').toString('base64') })
  });
  if (!res.ok) throw new Error(`Сервис подписи ЕСИА ответил ${res.status}`);
  const json = await res.json();
  const signature = String(json.signature || '');
  if (!signature) throw new Error('Сервис подписи ЕСИА не вернул подпись');
  return signature.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function buildEsiaAuthUrl(userId) {
  if (!esiaConfigured()) return null;
  const state = crypto.randomUUID();
  pendingStates.set(state, { userId: Number(userId), createdAt: Date.now() });
  setTimeout(() => pendingStates.delete(state), STATE_TTL_MS).unref?.();
  const clientId = process.env.ESIA_CLIENT_ID;
  const redirectUri = process.env.ESIA_REDIRECT_URI;
  const scope = esiaScope();
  const timestamp = esiaTimestamp();
  const clientSecret = await signForEsia(`${clientId}${scope}${timestamp}${state}${redirectUri}`);
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    client_certificate_hash: process.env.ESIA_CERT_HASH,
    redirect_uri: redirectUri,
    scope,
    response_type: 'code',
    state,
    timestamp,
    access_type: 'online'
  });
  return `${esiaBase()}/aas/oauth2/v2/ac?${params}`;
}

export function takeEsiaState(state) {
  const pending = pendingStates.get(String(state || ''));
  if (!pending) return null;
  pendingStates.delete(String(state));
  if (Date.now() - pending.createdAt > STATE_TTL_MS) return null;
  return pending;
}

function ageFromBirthdate(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(/(\d{2})\.(\d{2})\.(\d{4})/, '$3-$2-$1'));
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - date.getFullYear();
  const m = now.getMonth() - date.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < date.getDate())) age -= 1;
  return age;
}

function fullNameFromEsia(person = {}) {
  const parts = [person.lastName || person.last_name, person.firstName || person.first_name, person.middleName || person.middle_name];
  return parts.filter(Boolean).join(' ').trim();
}

function experienceFromLabor(records = []) {
  if (!records.length) return '';
  return records.map((row) => {
    const period = `${row.started_at || '?'}${row.ended_at ? ` — ${row.ended_at}` : ' — н.в.'}`;
    return `${row.position || 'Должность'}, ${row.organization || 'организация'} (${period})`;
  }).join('\n');
}

async function esiaRequest(pathname, accessToken) {
  const res = await fetch(`${esiaBase()}${pathname}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error(`ЕСИА ${res.status}`);
  return res.json();
}

async function exchangeEsiaCode(code, state) {
  const clientId = process.env.ESIA_CLIENT_ID;
  const redirectUri = process.env.ESIA_REDIRECT_URI;
  const scope = esiaScope();
  const timestamp = esiaTimestamp();
  const clientSecret = await signForEsia(`${clientId}${scope}${timestamp}${state}${redirectUri}${code}`);
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    grant_type: 'authorization_code',
    client_secret: clientSecret,
    client_certificate_hash: process.env.ESIA_CERT_HASH,
    state,
    redirect_uri: redirectUri,
    scope,
    timestamp,
    token_type: 'Bearer'
  });
  const res = await fetch(`${esiaBase()}/aas/oauth2/v3/te`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Не удалось получить токен ЕСИА: ${res.status} ${text.slice(0, 180)}`);
  }
  return res.json();
}

function oidFromToken(tokenResponse) {
  if (tokenResponse?.oid) return String(tokenResponse.oid);
  const token = tokenResponse?.id_token || tokenResponse?.access_token;
  if (!token) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return String(payload['urn:esia:sbj_id'] || payload['urn:esia:sbj']?.['urn:esia:sbj:oid'] || payload.sub || '') || null;
  } catch {
    return null;
  }
}

async function fetchLaborBook({ snils, accessToken, oid }) {
  const endpoint = process.env.SFR_LABOR_BOOK_URL;
  if (!endpoint) return null;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: process.env.SFR_LABOR_BOOK_TOKEN ? `Bearer ${process.env.SFR_LABOR_BOOK_TOKEN}` : `Bearer ${accessToken || ''}`
    },
    body: JSON.stringify({ snils, oid })
  });
  if (!res.ok) throw new Error(`ЭТК ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.records) ? data.records : (Array.isArray(data) ? data : null);
}

export async function importEsiaPerson(userId, { code, state }) {
  if (!code) throw new Error('Госуслуги не передали код авторизации');
  const tokens = await exchangeEsiaCode(code, state);
  const oid = oidFromToken(tokens);
  if (!oid) throw new Error('ЕСИА не вернула идентификатор пользователя');
  const info = await esiaRequest(`/rs/prns/${oid}`, tokens.access_token);
  let phone = '';
  let email = '';
  try {
    const contacts = await esiaRequest(`/rs/prns/${oid}/ctts?embed=(elements)`, tokens.access_token);
    const list = Array.isArray(contacts?.elements) ? contacts.elements : [];
    phone = list.find((c) => c.type === 'MBT' && c.vrfStu === 'VERIFIED')?.value
      || list.find((c) => c.type === 'MBT' || c.type === 'PHN')?.value || '';
    email = list.find((c) => c.type === 'EML')?.value || '';
  } catch (err) {
    console.error('[ESIA] контакты:', err.message);
  }
  const person = {
    oid,
    full_name: fullNameFromEsia(info),
    birthdate: info.birthDate || info.birth_date,
    age: ageFromBirthdate(info.birthDate || info.birth_date),
    snils: info.snils,
    phone,
    email,
    trusted: Boolean(info.trusted),
    source: 'esia'
  };
  try {
    const labor = await fetchLaborBook({ snils: person.snils, accessToken: tokens.access_token, oid });
    if (labor) {
      person.labor_book = labor;
      person.labor_source = 'gosuslugi-etk';
    }
  } catch (err) {
    console.error('[ESIA] ЭТК:', err.message);
  }
  if (person.labor_book?.length && !person.experience) {
    person.experience = experienceFromLabor(person.labor_book);
  }
  dbOperations.updateUserRole(userId, 'worker');
  return dbOperations.applyGosuslugiProfile(userId, person);
}

export function isGosuslugiVerified(profile) {
  return Boolean(profile?.gosuslugi?.connected && profile.gosuslugi.source === 'esia');
}

export function profileSourceLabel(profile) {
  return isGosuslugiVerified(profile)
    ? '🏛 Анкета подтверждена через Госуслуги'
    : '✍️ Анкета заполнена вручную · Госуслуги не подключены';
}

export function gosuslugiStatusLine(profile) {
  const phone = profile?.phone_verified ? '\n📱 Телефон подтверждён в MAX' : '';
  return `${profileSourceLabel(profile)}${phone}`;
}

export function formatLaborBook(profile) {
  const book = profile?.labor_book;
  if (!book?.records?.length) {
    if (isGosuslugiVerified(profile)) {
      return '📘 Госуслуги подключены, но записей электронной трудовой книжки пока нет.';
    }
    return 'Электронная трудовая книжка не подключена: анкета заполнена вручную.';
  }
  const lines = book.records.map((row, i) => {
    const period = `${row.started_at || '?'}${row.ended_at ? ` — ${row.ended_at}` : ' — по н.в.'}`;
    return `${i + 1}. ${row.position || 'Должность'}\n   ${row.organization || 'Организация'}${row.inn ? ` (ИНН ${row.inn})` : ''}\n   ${period}${row.type ? ` · ${row.type}` : ''}`;
  });
  return `📘 Электронная трудовая книжка (Госуслуги)\nОбновлено: ${book.updated_at || '—'}\n\n${lines.join('\n\n')}`;
}

export async function notifyWorkerEsia(userId, text) {
  const token = String(process.env.BOT_TOKEN || '').trim();
  if (!token) return;
  try {
    await fetch(`https://platform-api2.max.ru/messages?user_id=${userId}`, {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text })
    });
  } catch (err) {
    console.error('[ESIA] уведомление:', err.message);
  }
}
