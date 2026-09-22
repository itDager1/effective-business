import crypto from 'crypto';
import { dbOperations } from './db.js';

const pendingStates = new Map();

function esiaBase() {
  return process.env.ESIA_ENV === 'prod'
    ? 'https://esia.gosuslugi.ru'
    : 'https://esia-portal1.test.gosuslugi.ru';
}

export function esiaConfigured() {
  return Boolean(process.env.ESIA_CLIENT_ID && process.env.ESIA_REDIRECT_URI);
}

export function esiaDemoEnabled() {
  return String(process.env.ESIA_DEMO || 'true').toLowerCase() !== 'false';
}

function signState(payload) {
  const secret = process.env.BOT_TOKEN || 'esia-state';
  return crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 24);
}

export function createEsiaState(userId) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const payload = `${userId}.${Date.now()}.${nonce}`;
  const state = `${payload}.${signState(payload)}`;
  const verifier = crypto.randomBytes(32).toString('base64url');
  pendingStates.set(state, { userId: Number(userId), verifier, createdAt: Date.now() });
  setTimeout(() => pendingStates.delete(state), 15 * 60 * 1000);
  return { state, verifier };
}

export function readEsiaState(state) {
  if (!state) return null;
  const parts = String(state).split('.');
  if (parts.length < 4) return null;
  const payload = parts.slice(0, 3).join('.');
  const sig = parts[3];
  if (sig !== signState(payload)) return null;
  const pending = pendingStates.get(state);
  const userId = Number(parts[0]);
  if (!userId) return null;
  return { userId, verifier: pending?.verifier || null };
}

export function buildEsiaAuthUrl(userId) {
  const { state, verifier } = createEsiaState(userId);
  if (!esiaConfigured()) {
    return { url: `/esia/demo?state=${encodeURIComponent(state)}`, state };
  }
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({
    client_id: process.env.ESIA_CLIENT_ID,
    redirect_uri: process.env.ESIA_REDIRECT_URI,
    response_type: 'code',
    scope: process.env.ESIA_SCOPE || 'openid fullname birthdate gender contacts snils id_doc',
    state,
    access_type: 'online',
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });
  return { url: `${esiaBase()}/aas/oauth2/v2/ac?${params}`, state };
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

export async function exchangeEsiaCode(code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: process.env.ESIA_CLIENT_ID,
    client_secret: process.env.ESIA_CLIENT_SECRET || '',
    redirect_uri: process.env.ESIA_REDIRECT_URI,
    code,
    token_type: 'Bearer'
  });
  if (verifier) body.set('code_verifier', verifier);
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
  const idToken = tokenResponse?.id_token;
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return String(payload['urn:esia:sbj_id'] || payload.sub || '');
  } catch {
    return null;
  }
}

export async function fetchLaborBook({ snils, accessToken, oid }) {
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

function demoPerson(userId) {
  return {
    oid: `demo-${userId}`,
    full_name: 'Иванов Иван Иванович',
    age: 24,
    birthdate: '2002-03-12',
    phone: '++1-555-000-1234',
    snils: '000-000-000 00',
    email: 'demo@esia.test',
    source: 'esia-demo',
    labor_source: 'gosuslugi-etk-demo',
    labor_book: [
      {
        organization: 'ООО «Цифровые сервисы»',
        inn: '7700000000',
        position: 'Младший аналитик',
        started_at: '2022-07-01',
        ended_at: '2024-02-29',
        type: 'Основная'
      },
      {
        organization: 'АО «РегионТех»',
        inn: '3900000000',
        position: 'Аналитик данных',
        started_at: '2024-03-01',
        ended_at: null,
        type: 'Основная'
      }
    ]
  };
}

export async function importEsiaPerson(userId, { code, verifier, demo = false } = {}) {
  let person;
  if (demo || !code) {
    if (!esiaDemoEnabled()) throw new Error('Тестовый контур ЕСИА выключен. Укажите ESIA_CLIENT_ID.');
    person = demoPerson(userId);
  } else {
    const tokens = await exchangeEsiaCode(code, verifier);
    const oid = oidFromToken(tokens);
    if (!oid) throw new Error('ЕСИА не вернула идентификатор пользователя');
    const info = await esiaRequest(`/rs/prns/${oid}`, tokens.access_token);
    let phone = '';
    let email = '';
    try {
      const contacts = await esiaRequest(`/rs/prns/${oid}/ctts?embed=true`, tokens.access_token);
      const list = contacts?.elements || contacts || [];
      const arr = Array.isArray(list) ? list : [];
      phone = arr.find((c) => c.type === 'MBT' || c.type === 'PHN')?.value || '';
      email = arr.find((c) => c.type === 'EML')?.value || '';
    } catch {
    }
    person = {
      oid,
      full_name: fullNameFromEsia(info),
      birthdate: info.birthDate || info.birth_date,
      age: ageFromBirthdate(info.birthDate || info.birth_date),
      snils: info.snils,
      phone,
      email,
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
    if (!person.labor_book && esiaDemoEnabled()) {
      person.labor_book = demoPerson(userId).labor_book;
      person.labor_source = 'gosuslugi-etk-demo';
    }
  }
  if (person.labor_book?.length && !person.experience) {
    person.experience = experienceFromLabor(person.labor_book);
  }
  dbOperations.updateUserRole(userId, 'worker');
  return dbOperations.applyGosuslugiProfile(userId, person);
}

export function isGosuslugiVerified(profile) {
  return Boolean(profile?.gosuslugi?.verified || profile?.gosuslugi?.connected);
}

export function gosuslugiStatusLine(profile) {
  return isGosuslugiVerified(profile)
    ? '✅ Данные из Госуслуг подтверждены'
    : '⚠️ Данные из Госуслуг не подтверждены';
}

export function formatLaborBook(profile) {
  const book = profile?.labor_book;
  if (!book?.records?.length) {
    if (profile?.gosuslugi?.connected) {
      return '📘 Электронная трудовая книжка подключена через Госуслуги, но записей пока нет.';
    }
    return 'Электронная трудовая книжка ещё не подключена.';
  }
  const demo = book.source?.includes('demo') ? '\n⚠️ Сведения тестового контура ЕСИА.' : '';
  const lines = book.records.map((row, i) => {
    const period = `${row.started_at || '?'}${row.ended_at ? ` — ${row.ended_at}` : ' — по н.в.'}`;
    return `${i + 1}. ${row.position || 'Должность'}\n   ${row.organization || 'Организация'}${row.inn ? ` (ИНН ${row.inn})` : ''}\n   ${period}${row.type ? ` · ${row.type}` : ''}`;
  });
  return `📘 Электронная трудовая книжка (Госуслуги)\nОбновлено: ${book.updated_at || '—'}${demo}\n\n${lines.join('\n\n')}`;
}

export async function notifyWorkerEsia(userId, text) {
  const token = process.env.BOT_TOKEN;
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
