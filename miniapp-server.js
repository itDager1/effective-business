import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dbOperations } from './db.js';
import { cropToPortrait34 } from './photo.js';
import { normalizeWebsite, validatePhone } from './phone.js';
import { hasPostalIndex, isValidInn, vacancyGateMessage, verificationLabel, publicVerificationLabel, verifyEmployerRegistry, isEmployerVerified } from './egrul.js';
import {
  buildEsiaAuthUrl,
  takeEsiaState,
  importEsiaPerson,
  notifyWorkerEsia,
  formatLaborBook,
  esiaConfigured,
  signEsiaLink,
  verifyEsiaLink,
  isGosuslugiVerified,
  profileSourceLabel
} from './esia.js';
import { cityNames, interpretCity, locate } from './cities.js';
import {
  incomingMatchText,
  matchActionKeyboard,
  matchStatusLabel,
  sharedContactsText,
  formatMatchTitle,
  workerAcceptedNotice,
  employerAcceptedNotice,
  vacancyContact,
  isVacancyContactLabel
} from './match-flow.js';
import {
  developmentKindLabel,
  developmentStatusLabel,
  developmentOfferNotice,
  developmentActionKeyboard,
  staffJoinedNotice
} from './staff-flow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'miniapp');
const PORT = Number(process.env.MINI_APP_PORT || 8080);
const MINI_APP_URL = (process.env.MINI_APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const botToken = () => String(process.env.BOT_TOKEN || '').trim();
const DEV_USER_ID = process.env.MINIAPP_DEV_USER_ID
  ? Number(process.env.MINIAPP_DEV_USER_ID)
  : 91134101;
const MAX_API = 'https://platform-api2.max.ru';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function signInitData(pairs, token) {
  const launchParams = [...pairs]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  return crypto.createHmac('sha256', secretKey).update(launchParams).digest('hex');
}

let lastInitDataWarning = '';
function warnInitData(reason) {
  if (reason === lastInitDataWarning) return;
  lastInitDataWarning = reason;
  console.warn(`[MINIAPP] initData отклонён: ${reason}`);
}

function validateInitData(rawInitData) {
  const token = botToken();
  if (!rawInitData) {
    warnInitData('клиент не передал initData');
    return null;
  }
  if (!token) {
    warnInitData('BOT_TOKEN не задан');
    return null;
  }
  let initData = String(rawInitData);
  if (!initData.includes('hash=') && initData.includes('hash%3D')) initData = safeDecode(initData);
  const params = initData.split('&').map((pair) => {
    const i = pair.indexOf('=');
    return i === -1 ? [pair, ''] : [pair.slice(0, i), pair.slice(i + 1)];
  });
  if (params.filter(([k]) => k === 'hash').length !== 1) {
    warnInitData(`нет поля hash (ключи: ${params.map(([k]) => k).join(',')})`);
    return null;
  }
  const originalHash = safeDecode(params.find(([k]) => k === 'hash')[1]);
  const rest = params.filter(([k]) => k !== 'hash');
  const pairs = rest.map(([k, v]) => [k, safeDecode(v)]);
  const plusPairs = rest.map(([k, v]) => [k, safeDecode(v.replace(/\+/g, ' '))]);
  if (signInitData(pairs, token) !== originalHash && signInitData(plusPairs, token) !== originalHash) {
    warnInitData(`подпись не совпала (ключи: ${rest.map(([k]) => k).join(',')})`);
    return null;
  }
  let authDate = Number(pairs.find(([k]) => k === 'auth_date')?.[1] || 0);
  if (authDate > 1e12) authDate /= 1000;
  if (authDate && Date.now() / 1000 - authDate > 24 * 60 * 60) {
    warnInitData('initData старше 24 часов');
    return null;
  }
  const userRaw = pairs.find(([k]) => k === 'user')?.[1];
  if (!userRaw) {
    warnInitData('в initData нет user');
    return null;
  }
  try {
    return JSON.parse(userRaw);
  } catch {
    warnInitData('не удалось разобрать user');
    return null;
  }
}

async function savePhotoFromDataUrl(userId, dataUrl) {
  const match = String(dataUrl || '').match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    throw new Error('Выберите изображение JPG, PNG или WEBP');
  }
  const buf = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buf.length) throw new Error('Не удалось прочитать файл');
  if (buf.length > 2.5 * 1024 * 1024) throw new Error('Файл слишком большой (макс. 2.5 МБ)');
  const cropped = await cropToPortrait34(buf);
  const dir = path.join(PUBLIC_DIR, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  for (const oldExt of ['jpg', 'jpeg', 'png', 'webp']) {
    const oldPath = path.join(dir, `${userId}.${oldExt}`);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  fs.writeFileSync(path.join(dir, `${userId}.jpg`), cropped);
  return `/uploads/${userId}.jpg?v=${Date.now()}`;
}

function publicPhoto(photo) {
  if (!photo) return null;
  if (typeof photo === 'string' && /^https?:\/\//i.test(photo)) return { url: photo };
  if (photo.url) return { url: photo.url };
  return null;
}

function publicWorker(worker, viewerId = null) {
  if (!worker) return null;
  const { photo, gosuslugi, labor_book, phone, ...rest } = worker;
  const showPhone = viewerId != null && (viewerId === worker.user_id || dbOperations.contactsUnlocked(viewerId, worker.user_id));
  const companyJobs = viewerId != null && Number(viewerId) !== Number(worker.user_id)
    ? dbOperations.getCompanyEmployment(viewerId, worker.user_id)
    : [];
  return {
    ...rest,
    phone: showPhone ? phone : null,
    phone_hidden: !showPhone,
    in_company: companyJobs.length > 0,
    company_jobs: companyJobs,
    photo: publicPhoto(photo),
    gosuslugi: isGosuslugiVerified(worker)
      ? {
          connected: true,
          verified: Boolean(gosuslugi.verified),
          birthdate: gosuslugi.birthdate || null,
          source: gosuslugi.source
        }
      : null,
    profile_source: isGosuslugiVerified(worker) ? 'gosuslugi' : 'manual',
    profile_source_label: profileSourceLabel(worker),
    phone_verified: Boolean(worker.phone_verified),
    labor_book: isGosuslugiVerified(worker) ? labor_book || null : null
  };
}

function publicStaff(row, viewerId) {
  if (!row) return null;
  return {
    id: row.id,
    employer_id: row.employer_id,
    worker_id: row.worker_id,
    vacancy_id: row.vacancy_id,
    match_id: row.match_id,
    position: row.position,
    status: row.status,
    joined_at: row.joined_at,
    worker: publicWorker(row.worker, viewerId),
    vacancy: row.vacancy ? {
      id: row.vacancy.id,
      job_title: row.vacancy.job_title,
      location: row.vacancy.location,
      seasonality: row.vacancy.seasonality
    } : null,
    employer: row.employer ? {
      company_name: row.employer.company_name,
      industry: row.employer.industry
    } : null,
    offers: (row.offers || []).map((o) => ({
      id: o.id,
      kind: o.kind,
      kind_label: developmentKindLabel(o.kind),
      title: o.title,
      status: o.status,
      status_label: developmentStatusLabel(o.status),
      created_at: o.created_at
    }))
  };
}

function publicMatch(match, viewerId) {
  if (!match) return null;
  const accepted = match.status === 'accepted';
  const worker = match.worker || dbOperations.getWorkerProfile(match.worker_id);
  const employer = match.employer || dbOperations.getEmployerProfile(match.employer_id);
  const vacancy = match.vacancy || dbOperations.getVacancyById(match.vacancy_id);
  const contact = vacancyContact(vacancy, employer);
  return {
    id: match.id,
    kind: match.kind,
    status: match.status,
    status_label: matchStatusLabel(match.status),
    title: formatMatchTitle(match),
    incoming: Number(match.initiator_id) !== Number(viewerId),
    vacancy: publicVacancy(vacancy, viewerId),
    worker: publicWorker(worker, accepted ? viewerId : worker?.user_id === viewerId ? viewerId : -1),
    employer: employer ? {
      company_name: employer.company_name,
      industry: employer.industry,
      verification_label: Number(employer.user_id) === Number(viewerId) ? verificationLabel(employer) : publicVerificationLabel(employer),
      company_verified: isEmployerVerified(employer)
    } : null,
    contacts: accepted ? {
      worker_name: worker?.full_name,
      worker_phone: worker?.phone,
      company_name: employer?.company_name,
      contact_person: contact.name,
      contact_position: contact.position,
      company_phone: contact.phone
    } : null
  };
}

function htmlPage(title, body) {
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>
body{font-family:Segoe UI,system-ui,sans-serif;background:#12131b;color:#f3f5ff;margin:0;padding:32px 18px}
.card{max-width:460px;margin:0 auto;background:#1c2030;border-radius:16px;padding:22px}
a,button{display:block;width:100%;padding:12px;border:0;border-radius:12px;background:#3d8bff;color:#fff;font-weight:600;text-align:center;text-decoration:none;margin-top:12px}
.muted{color:#a8b0c8;font-size:14px;line-height:1.45}
</style></head><body><div class="card">${body}</div></body></html>`;
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

async function handleEsia(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/esia/start') {
    const userId = Number(url.searchParams.get('uid'));
    if (!userId || !verifyEsiaLink(userId, url.searchParams.get('sig'))) {
      sendHtml(res, 400, htmlPage('Госуслуги', '<h2>Ссылка недействительна</h2><p class="muted">Откройте вход через Госуслуги из бота или мини-приложения.</p>'));
      return true;
    }
    if (!esiaConfigured()) {
      sendHtml(res, 503, htmlPage('Госуслуги', '<h2>Вход через Госуслуги недоступен</h2><p class="muted">Подключение к ЕСИА для сервиса ещё не активировано. Заполните анкету вручную — её можно подтвердить через Госуслуги позже.</p>'));
      return true;
    }
    try {
      const target = await buildEsiaAuthUrl(userId);
      res.writeHead(302, { Location: target });
      res.end();
    } catch (err) {
      console.error('[ESIA] start:', err);
      sendHtml(res, 502, htmlPage('Госуслуги', '<h2>Госуслуги сейчас недоступны</h2><p class="muted">Попробуйте ещё раз через несколько минут.</p>'));
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/esia/callback') {
    const state = url.searchParams.get('state');
    const pending = takeEsiaState(state);
    if (!pending?.userId) {
      sendHtml(res, 400, htmlPage('Госуслуги', '<h2>Сессия устарела</h2><p class="muted">Вернитесь в бота и нажмите «Госуслуги» ещё раз.</p>'));
      return true;
    }
    if (url.searchParams.get('error')) {
      sendHtml(res, 400, htmlPage('Госуслуги', '<h2>Вход отменён</h2><p class="muted">Госуслуги не передали данные. Вернитесь в чат с ботом.</p>'));
      return true;
    }
    try {
      const profile = await importEsiaPerson(pending.userId, {
        code: url.searchParams.get('code'),
        state
      });
      await notifyWorkerEsia(
        pending.userId,
        `✅ Госуслуги подключены.\nАнкета подтверждена: ${profile.full_name || '—'}${profile.labor_book?.records?.length ? '\nЭлектронная трудовая книжка загружена.' : ''}\nДопишите специальность и опыт, если их нет.`
      );
      sendHtml(res, 200, htmlPage('Готово', `
        <h2>Данные получены</h2>
        <p class="muted">Анкета обновлена данными из Госуслуг. Вернитесь в чат с ботом — работодатели увидят, что анкета подтверждена.</p>
      `));
    } catch (err) {
      console.error('[ESIA]', err);
      sendHtml(res, 502, htmlPage('Ошибка', '<h2>Не удалось получить данные</h2><p class="muted">Госуслуги не вернули данные. Попробуйте ещё раз позже.</p>'));
    }
    return true;
  }
  return false;
}

export function gosuslugiStartUrl(userId) {
  return `${MINI_APP_URL}/esia/start?uid=${Number(userId)}&sig=${signEsiaLink(userId)}`;
}

function verifyMaxPhone({ phone, authDate, hash }, userId) {
  const token = botToken();
  if (!token || !phone || !authDate || !hash) return null;
  const digits = String(phone).replace(/\D/g, '');
  const variants = [digits, String(phone)];
  for (const value of variants) {
    const data = `authDate=${authDate}\nphone=${value}\nuserId=${userId}`;
    const given = String(hash).toLowerCase();
    const signed = crypto.createHmac('sha256', token).update(data).digest('hex');
    const signedSwapped = crypto.createHmac('sha256', data).update(token).digest('hex');
    if (signed === given || signedSwapped === given) return `+${digits}`;
  }
  return null;
}

function publicVacancy(vacancy, viewerId = null) {
  if (!vacancy) return null;
  const employer = dbOperations.getEmployerProfile(vacancy.employer_id);
  const owned = viewerId != null && Number(vacancy.employer_id) === Number(viewerId);
  const { contact_name, contact_position, contact_phone, ...safe } = vacancy;
  return {
    ...(owned ? vacancy : safe),
    company_name: employer?.company_name || 'Компания не указана',
    company_website: employer?.website || '',
    company_verified: isEmployerVerified(employer),
    verification_label: owned ? verificationLabel(employer) : publicVerificationLabel(employer),
    contacts_hidden: !owned
  };
}

async function sendMaxMessage(userId, text, extra = {}) {
  const uid = Number(userId);
  const targets = [`user_id=${uid}`];
  const chatId = dbOperations.getUser(uid)?.chat_id;
  if (chatId) targets.push(`chat_id=${chatId}`);
  let lastError = null;
  for (const query of targets) {
    const res = await fetch(`${MAX_API}/messages?${query}`, {
      method: 'POST',
      headers: {
        Authorization: botToken(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text, ...extra })
    });
    if (res.ok) return res.json().catch(() => ({}));
    lastError = await res.text();
  }
  throw new Error(lastError || `MAX API failed for ${uid}`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Некорректный JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function isLocalApp() {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(MINI_APP_URL);
}

function isLocalRequest(req) {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function authUser(req) {
  const initData = req.headers['x-max-init-data'] || '';
  const fromMax = validateInitData(initData);
  if (fromMax?.id) return Number(fromMax.id);
  if (isLocalApp() && isLocalRequest(req) && DEV_USER_ID) {
    return DEV_USER_ID;
  }
  return null;
}

function canonicalCity(value) {
  if (!value) return { ok: true, name: null };
  const parsed = interpretCity(value);
  if (!parsed.ok) {
    const extra = parsed.choices?.length ? ` Варианты: ${parsed.choices.map((city) => city.name).join(', ')}.` : '';
    return { ok: false, error: `${parsed.error}${extra}` };
  }
  return { ok: true, name: parsed.city?.name || null };
}

function snapshot(userId) {
  dbOperations.addUser(userId, null);
  const user = dbOperations.getUser(userId);
  return {
    user_id: userId,
    role: user?.role || null,
    worker: publicWorker(dbOperations.getWorkerProfile(userId), userId),
    employer: (() => {
      const profile = dbOperations.getEmployerProfile(userId);
      if (!profile) return null;
      return {
        ...profile,
        verification_label: verificationLabel(profile),
        can_post_vacancies: !vacancyGateMessage(profile)
      };
    })(),
    locations: dbOperations.getUniqueLocations(userId),
    worker_cities: dbOperations.getUniqueWorkerCities(userId),
    worker_specializations: dbOperations.getUniqueSpecializations(userId),
    cities: cityNames(),
    home_city: locate(dbOperations.homePlace(userId))?.name || '',
    esia_available: esiaConfigured()
  };
}

async function handleApi(req, res, url) {
  const userId = authUser(req);
  if (!userId) {
    sendJson(res, 401, { error: isLocalApp()
      ? 'Не удалось войти в локальном режиме. Проверьте, что открыт http://localhost:8080'
      : 'Откройте мини-приложение из чата с ботом в MAX' });
    return;
  }

  const method = req.method;
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/api/me') {
    sendJson(res, 200, snapshot(userId));
    return;
  }

  if (method === 'GET' && pathname === '/api/esia/link') {
    sendJson(res, 200, {
      url: gosuslugiStartUrl(userId),
      configured: esiaConfigured()
    });
    return;
  }

  const laborMatch = pathname.match(/^\/api\/workers\/(\d+)\/labor-book$/);
  if (method === 'GET' && laborMatch) {
    const workerId = Number(laborMatch[1]);
    const viewer = dbOperations.getUser(userId);
    if (viewer?.role !== 'employer' && userId !== workerId) {
      sendJson(res, 403, { error: 'Трудовую книжку может смотреть работодатель или сам работник' });
      return;
    }
    const worker = dbOperations.getWorkerProfile(workerId);
    sendJson(res, 200, {
      text: formatLaborBook(worker),
      labor_book: isGosuslugiVerified(worker) ? worker.labor_book || null : null,
      gosuslugi: isGosuslugiVerified(worker)
    });
    return;
  }

  const body = method === 'GET' ? {} : await readBody(req);

  if (method === 'POST' && pathname === '/api/role') {
    if (!['worker', 'employer'].includes(body.role)) {
      sendJson(res, 400, { error: 'Некорректная роль' });
      return;
    }
    dbOperations.updateUserRole(userId, body.role);
    sendJson(res, 200, snapshot(userId));
    return;
  }

  if (method === 'POST' && pathname === '/api/worker-profile') {
    const { full_name, age, specialization, experience, phone, photo_url, city, education, skills, about } = body;
    const ageNum = Number(age);
    const phoneCheck = validatePhone(phone);
    const experienceText = String(experience || '').trim();
    if (!full_name || !specialization || !experienceText || !phoneCheck.ok || !Number.isFinite(ageNum) || ageNum < 14 || ageNum > 100) {
      sendJson(res, 400, { error: phoneCheck.ok ? 'Заполните имя, возраст 14–100, специальность, опыт (хотя бы один символ) и реальный телефон' : phoneCheck.error });
      return;
    }
    const existing = dbOperations.getWorkerProfile(userId);
    const photo = photo_url
      ? { type: 'image', url: String(photo_url), token: null, photo_id: null }
      : existing?.photo || null;
    dbOperations.addWorkerProfile(userId, full_name, ageNum, specialization, experienceText, phoneCheck.phone, photo, {
      city, education, skills, about
    });
    dbOperations.updateUserRole(userId, 'worker');
    sendJson(res, 200, snapshot(userId));
    return;
  }

  if (method === 'POST' && pathname === '/api/worker-photo') {
    const urlPath = await savePhotoFromDataUrl(userId, body.image);
    const photo = {
      type: 'image',
      url: urlPath,
      token: null,
      photo_id: null,
      portrait: true
    };
    const existing = dbOperations.getWorkerProfile(userId);
    if (existing) {
      dbOperations.updateWorkerPhoto(userId, photo);
    }
    sendJson(res, 200, { ...snapshot(userId), uploaded_photo: photo });
    return;
  }

  if (method === 'POST' && pathname === '/api/worker-phone/verify') {
    if (!dbOperations.getWorkerProfile(userId)) {
      sendJson(res, 404, { error: 'Сначала создайте анкету' });
      return;
    }
    const phone = verifyMaxPhone(body, userId);
    if (!phone) {
      sendJson(res, 400, { error: 'MAX не подтвердил номер телефона' });
      return;
    }
    dbOperations.setWorkerPhoneVerified(userId, phone);
    sendJson(res, 200, snapshot(userId));
    return;
  }

  if (method === 'POST' && pathname === '/api/worker-status') {
    const profile = dbOperations.getWorkerProfile(userId);
    if (!profile) {
      sendJson(res, 404, { error: 'Сначала заполните анкету' });
      return;
    }
    dbOperations.toggleWorkerProfileStatus(userId, Boolean(body.is_active));
    sendJson(res, 200, snapshot(userId));
    return;
  }

  if (method === 'POST' && pathname === '/api/employer-profile') {
    const { company_name, industry, description, contact_person, phone, inn, legal_address, director_fio, website } = body;
    const phoneCheck = validatePhone(phone);
    const site = normalizeWebsite(website);
    if (!site.ok) {
      sendJson(res, 400, { error: site.error });
      return;
    }
    if (!company_name || !industry || !description || !contact_person || !phoneCheck.ok) {
      sendJson(res, 400, { error: phoneCheck.ok ? 'Заполните все поля компании' : phoneCheck.error });
      return;
    }
    const descriptionText = String(description || '').trim();
    if (!descriptionText) {
      sendJson(res, 400, { error: 'Напишите о компании. Достаточно одного символа' });
      return;
    }
    if (!isValidInn(inn) || !director_fio || !legal_address) {
      sendJson(res, 400, { error: 'Укажите корректный ИНН, ФИО руководителя и юридический адрес' });
      return;
    }
    if (!hasPostalIndex(legal_address)) {
      sendJson(res, 400, { error: 'Добавьте почтовый индекс — 6 цифр: индекс, регион, город, улица, дом' });
      return;
    }
    dbOperations.addEmployerProfile(userId, company_name, industry, descriptionText, contact_person, phoneCheck.phone, {
      inn, legal_address, director_fio, website: site.website
    });
    dbOperations.updateUserRole(userId, 'employer');
    const result = await verifyEmployerRegistry({ inn, directorFio: director_fio, legalAddress: legal_address });
    dbOperations.setEmployerVerification(userId, result);
    sendJson(res, 200, { ...snapshot(userId), verification: result });
    return;
  }

  if (method === 'POST' && pathname === '/api/employer-verify') {
    const profile = dbOperations.getEmployerProfile(userId);
    const blocked = vacancyGateMessage(profile);
    if (!profile?.inn || !profile?.director_fio || !profile?.legal_address) {
      sendJson(res, 400, { error: blocked || 'Сначала заполните ИНН, руководителя и юридический адрес' });
      return;
    }
    const result = await verifyEmployerRegistry({
      inn: profile.inn,
      directorFio: profile.director_fio,
      legalAddress: profile.legal_address
    });
    dbOperations.setEmployerVerification(userId, result);
    sendJson(res, 200, { ...snapshot(userId), verification: result });
    return;
  }

  if (method === 'GET' && pathname === '/api/jobs') {
    const user = dbOperations.getUser(userId);
    if (user?.role === 'employer') {
      sendJson(res, 403, { error: 'Работодатель смотрит свои вакансии в разделе «Мои вакансии»' });
      return;
    }
    const location = canonicalCity(url.searchParams.get('location'));
    if (!location.ok) {
      sendJson(res, 400, { error: location.error });
      return;
    }
    const near = canonicalCity(url.searchParams.get('near'));
    if (!near.ok) {
      sendJson(res, 400, { error: near.error });
      return;
    }
    const sort = url.searchParams.get('sort') || 'new';
    const origin = near.name || dbOperations.homePlace(userId);
    if (sort === 'distance' && !locate(origin)) {
      sendJson(res, 400, { error: 'Чтобы сортировать по удалённости, выберите город России в поле «Расстояние от».' });
      return;
    }
    const list = dbOperations.filterVacancies({
      seasonality: url.searchParams.get('seasonality') || null,
      location: location.name,
      keyword: url.searchParams.get('keyword') || null,
      sort,
      near: origin,
      excludeEmployerId: userId
    }).map((v) => ({
      ...publicVacancy(v),
      is_favorite: dbOperations.isFavorite(userId, v.id),
      applied: dbOperations.hasApplied(userId, v.id)
    }));
    sendJson(res, 200, { items: list });
    return;
  }

  if (method === 'GET' && pathname === '/api/favorites') {
    const list = dbOperations.getFavoriteVacancies(userId).map((v) => ({
      ...publicVacancy(v),
      is_favorite: true,
      applied: dbOperations.hasApplied(userId, v.id)
    }));
    sendJson(res, 200, { items: list });
    return;
  }

  const favMatch = pathname.match(/^\/api\/jobs\/(\d+)\/favorite$/);
  if (method === 'POST' && favMatch) {
    const vacancyId = Number(favMatch[1]);
    const vacancy = dbOperations.getVacancyById(vacancyId);
    if (!vacancy || vacancy.employer_id === userId) {
      sendJson(res, 404, { error: 'Вакансия недоступна' });
      return;
    }
    const added = dbOperations.toggleFavorite(userId, vacancyId);
    sendJson(res, 200, { is_favorite: added });
    return;
  }

  const applyMatch = pathname.match(/^\/api\/jobs\/(\d+)\/apply$/);
  if (method === 'POST' && applyMatch) {
    const vacancyId = Number(applyMatch[1]);
    const vacancy = dbOperations.getVacancyById(vacancyId);
    if (!vacancy || vacancy.employer_id === userId) {
      sendJson(res, 404, { error: 'Вакансия недоступна' });
      return;
    }
    if (dbOperations.hasApplied(userId, vacancyId)) {
      sendJson(res, 409, { error: 'Вы уже откликались на эту вакансию' });
      return;
    }
    if (!dbOperations.getWorkerProfile(userId)) {
      sendJson(res, 400, { error: 'Сначала заполните свою анкету' });
      return;
    }
    const created = dbOperations.addApplication(userId, vacancyId);
    if (!created?.ok) {
      sendJson(res, 409, { error: 'Вы уже откликались на эту вакансию' });
      return;
    }
    const match = dbOperations.decorateMatch(created.match);
    try {
      await sendMaxMessage(vacancy.employer_id, incomingMatchText(match), matchActionKeyboard(match.id));
      sendJson(res, 200, { ok: true, match: publicMatch(match, userId) });
    } catch (err) {
      sendJson(res, 502, { error: 'Не удалось отправить уведомление работодателю' });
    }
    return;
  }

  if (method === 'GET' && pathname === '/api/my-vacancies') {
    sendJson(res, 200, { items: dbOperations.getEmployerVacancies(userId).map((v) => publicVacancy(v, userId)) });
    return;
  }

  if (method === 'POST' && pathname === '/api/vacancies') {
    const blocked = vacancyGateMessage(dbOperations.getEmployerProfile(userId));
    if (blocked) {
      sendJson(res, 403, { error: blocked });
      return;
    }
    const { job_title, description, requirements, location, salary, seasonality, contact_name, contact_position, contact_phone } = body;
    const phoneCheck = validatePhone(contact_phone);
    if (!job_title || !description || !requirements || !location || !salary || !seasonality || !isVacancyContactLabel(contact_name) || !isVacancyContactLabel(contact_position) || !phoneCheck.ok) {
      sendJson(res, 400, { error: phoneCheck.ok ? 'Заполните вакансию и контакт сотрудника для связи: имя, должность и телефон' : phoneCheck.error });
      return;
    }
    dbOperations.addVacancy(userId, job_title, description, requirements, location, salary, seasonality, {
      contact_name,
      contact_position,
      contact_phone: phoneCheck.phone
    });
    sendJson(res, 200, { items: dbOperations.getEmployerVacancies(userId).map((v) => publicVacancy(v, userId)) });
    return;
  }

  const vacancyUpdate = pathname.match(/^\/api\/vacancies\/(\d+)$/);
  if (method === 'POST' && vacancyUpdate) {
    const vacancyId = Number(vacancyUpdate[1]);
    const vacancy = dbOperations.getVacancyById(vacancyId);
    if (!vacancy || vacancy.employer_id !== userId) {
      sendJson(res, 404, { error: 'Вакансия не найдена' });
      return;
    }
    const { job_title, description, requirements, location, salary, seasonality, contact_name, contact_position, contact_phone } = body;
    const phoneCheck = validatePhone(contact_phone);
    if (!job_title || !description || !requirements || !location || !salary || !seasonality || !isVacancyContactLabel(contact_name) || !isVacancyContactLabel(contact_position) || !phoneCheck.ok) {
      sendJson(res, 400, { error: phoneCheck.ok ? 'Заполните вакансию и контакт сотрудника для связи: имя, должность и телефон' : phoneCheck.error });
      return;
    }
    dbOperations.updateVacancy(vacancyId, userId, {
      job_title, description, requirements, location, salary, seasonality,
      contact_name: String(contact_name).trim(),
      contact_position: String(contact_position).trim(),
      contact_phone: phoneCheck.phone
    });
    sendJson(res, 200, { items: dbOperations.getEmployerVacancies(userId).map((v) => publicVacancy(v, userId)) });
    return;
  }

  if (method === 'GET' && pathname === '/api/workers') {
    const city = canonicalCity(url.searchParams.get('city'));
    if (!city.ok) {
      sendJson(res, 400, { error: city.error });
      return;
    }
    const near = canonicalCity(url.searchParams.get('near'));
    if (!near.ok) {
      sendJson(res, 400, { error: near.error });
      return;
    }
    const sort = url.searchParams.get('sort') || '';
    const origin = near.name || dbOperations.homePlace(userId);
    if (sort === 'distance' && !locate(origin)) {
      sendJson(res, 400, { error: 'Чтобы сортировать по удалённости, выберите город России в поле «Расстояние от».' });
      return;
    }
    const filters = {
      specialization: url.searchParams.get('specialization') || null,
      city: city.name,
      skills: url.searchParams.get('skills') || null,
      ageMin: url.searchParams.get('ageMin') || null,
      ageMax: url.searchParams.get('ageMax') || null,
      gosuslugi: url.searchParams.get('gosuslugi') === '1',
      recommended: url.searchParams.get('recommended') === '1',
      sort,
      near: origin
    };
    const items = dbOperations.getRankedWorkers(userId, filters).map((w) => ({
      ...publicWorker(w, userId),
      recommended: w.recommended,
      matched_vacancy: w.matchedVacancy ? publicVacancy(w.matchedVacancy) : null,
      offered: dbOperations.getEmployerVacancies(userId).some((v) => dbOperations.hasOffered(userId, w.user_id, v.id))
    }));
    sendJson(res, 200, { items });
    return;
  }

  const offerMatch = pathname.match(/^\/api\/workers\/(\d+)\/offer$/);
  if (method === 'POST' && offerMatch) {
    const workerId = Number(offerMatch[1]);
    const vacancy = dbOperations.getVacancyById(Number(body.vacancy_id));
    const worker = dbOperations.getWorkerProfile(workerId);
    if (!vacancy || vacancy.employer_id !== userId || !worker) {
      sendJson(res, 404, { error: 'Вакансия или анкета не найдены' });
      return;
    }
    if (dbOperations.hasOffered(userId, workerId, vacancy.id)) {
      sendJson(res, 409, { error: 'Вы уже откликались на эту анкету' });
      return;
    }
    const created = dbOperations.addOffer(userId, workerId, vacancy.id);
    if (!created?.ok) {
      sendJson(res, 409, { error: 'Вы уже откликались на эту анкету' });
      return;
    }
    const match = dbOperations.decorateMatch(created.match);
    try {
      await sendMaxMessage(workerId, incomingMatchText(match), matchActionKeyboard(match.id));
      sendJson(res, 200, { ok: true, match: publicMatch(match, userId) });
    } catch {
      sendJson(res, 502, { error: 'Не удалось отправить предложение. Работник должен хотя бы раз открыть бота.' });
    }
    return;
  }

  if (method === 'GET' && pathname === '/api/matches') {
    sendJson(res, 200, {
      incoming: dbOperations.getIncomingMatches(userId).map((m) => publicMatch(m, userId)),
      outgoing: dbOperations.getOutgoingMatches(userId).map((m) => publicMatch(m, userId))
    });
    return;
  }

  const matchAccept = pathname.match(/^\/api\/matches\/(\d+)\/(accept|decline|cancel)$/);
  if (method === 'POST' && matchAccept) {
    const matchId = Number(matchAccept[1]);
    const action = matchAccept[2];
    const result = action === 'cancel'
      ? dbOperations.cancelAcceptedMatch(matchId, userId)
      : dbOperations.setMatchStatus(matchId, action === 'accept' ? 'accepted' : 'declined', userId);
    if (!result.ok) {
      sendJson(res, 400, { error: result.error || 'Не получилось обработать отклик' });
      return;
    }
    const match = dbOperations.decorateMatch(result.match);
    const actorIsEmployer = Number(userId) === Number(match.employer_id);
    const otherId = actorIsEmployer ? match.worker_id : match.employer_id;
    try {
      if (action === 'accept') {
        const otherText = actorIsEmployer ? workerAcceptedNotice(match) : employerAcceptedNotice(match);
        await sendMaxMessage(otherId, otherText);
        const staff = dbOperations.getCompanyStaff(match.employer_id)
          .find((row) => Number(row.worker_id) === Number(match.worker_id) && Number(row.vacancy_id) === Number(match.vacancy_id));
        if (staff) await sendMaxMessage(match.worker_id, staffJoinedNotice(staff));
      } else if (action === 'cancel') {
        const job = match.vacancy?.job_title || 'вакансия';
        await sendMaxMessage(otherId, `⚠️ Вторая сторона отменила одобрение отклика «${job}». Контакты больше не открыты.`);
      } else {
        await sendMaxMessage(otherId, `❌ Ваш отклик «${match.vacancy?.job_title || 'вакансия'}» отклонили.`);
      }
    } catch (err) {
      console.error('[MATCH notify]', err.message || err);
    }
    sendJson(res, 200, { ok: true, match: publicMatch(match, userId) });
    return;
  }

  if (method === 'GET' && pathname === '/api/staff') {
    const employer = dbOperations.getEmployerProfile(userId);
    if (!employer) {
      sendJson(res, 200, { company_name: '', items: [], needs_profile: true });
      return;
    }
    sendJson(res, 200, {
      company_name: employer.company_name,
      items: dbOperations.getCompanyStaff(userId).map((row) => publicStaff(row, userId))
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/my-work') {
    sendJson(res, 200, {
      jobs: dbOperations.getWorkerEmployment(userId).map((row) => publicStaff(row, userId)),
      offers: dbOperations.getWorkerDevOffers(userId).map((o) => ({
        id: o.id,
        kind: o.kind,
        kind_label: developmentKindLabel(o.kind),
        title: o.title,
        status: o.status,
        status_label: developmentStatusLabel(o.status),
        created_at: o.created_at,
        company_name: dbOperations.getEmployerProfile(o.employer_id)?.company_name || 'Компания'
      }))
    });
    return;
  }

  const staffOffer = pathname.match(/^\/api\/staff\/(\d+)\/(internship|training)$/);
  if (method === 'POST' && staffOffer) {
    const created = dbOperations.createDevOffer({
      staffId: Number(staffOffer[1]),
      kind: staffOffer[2],
      title: body.title,
      actorId: userId
    });
    if (!created.ok) {
      sendJson(res, 400, { error: created.error || 'Не получилось отправить предложение' });
      return;
    }
    try {
      await sendMaxMessage(
        created.offer.worker_id,
        developmentOfferNotice(created.offer, created.staff),
        developmentActionKeyboard(created.offer.id)
      );
    } catch (err) {
      console.error('[STAFF notify]', err.message || err);
    }
    sendJson(res, 200, { ok: true, offer: created.offer, staff: publicStaff(created.staff, userId) });
    return;
  }

  const offerAct = pathname.match(/^\/api\/dev-offers\/(\d+)\/(accept|decline)$/);
  if (method === 'POST' && offerAct) {
    const result = dbOperations.setDevOfferStatus(
      Number(offerAct[1]),
      offerAct[2] === 'accept' ? 'accepted' : 'declined',
      userId
    );
    if (!result.ok) {
      sendJson(res, 400, { error: result.error || 'Не получилось ответить' });
      return;
    }
    try {
      const kind = developmentKindLabel(result.offer.kind);
      const name = result.staff?.worker?.full_name || 'Сотрудник';
      await sendMaxMessage(
        result.offer.employer_id,
        offerAct[2] === 'accept' ? `✅ ${name} принял ${kind}.` : `❌ ${name} отклонил ${kind}.`
      );
    } catch (err) {
      console.error('[STAFF notify]', err.message || err);
    }
    sendJson(res, 200, { ok: true, offer: result.offer });
    return;
  }

  sendJson(res, 404, { error: 'Неизвестный метод' });
}

function serveStatic(req, res, url) {
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const abs = path.join(PUBLIC_DIR, filePath);
  if (!abs.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (['.html', '.js', '.css'].includes(ext)) headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    res.end(data);
  });
}

export function startMiniAppServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (await handleEsia(req, res, url)) return;
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      serveStatic(req, res, url);
    } catch (err) {
      console.error('[MINIAPP]', err);
      if (!res.headersSent) sendJson(res, 500, { error: err.message || 'Ошибка сервера' });
    }
  });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[MINIAPP] открывайте в браузере: http://localhost:${PORT}`);
    if (isLocalApp()) {
      console.log(`[MINIAPP] локальный режим, пользователь ${DEV_USER_ID}`);
    } else {
      console.log(`[MINIAPP] публичный URL: ${MINI_APP_URL}`);
    }
  });
  return server;
}
