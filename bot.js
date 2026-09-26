import './disable-tls.js';
import 'dotenv/config';
import { Bot } from '@maxhub/max-bot-api';
import { dbOperations } from './db.js';
import { startMiniAppServer, gosuslugiStartUrl } from './miniapp-server.js';
import { ensurePortraitPhoto, processPortraitPhoto, pickBestImageUrl } from './photo.js';
import { formatLaborBook, gosuslugiStatusLine, esiaConfigured, isGosuslugiVerified } from './esia.js';
import { normalizeWebsite, validatePhone } from './phone.js';
import { isValidInn, vacancyGateMessage, verificationLabel, publicVerificationLabel, verifyEmployerRegistry } from './egrul.js';
import { interpretCity, locate, popularCities } from './cities.js';
import {
  formatMatchTitle,
  incomingMatchText,
  matchActionKeyboard,
  matchStatusLabel,
  sharedContactsText,
  workerAcceptedNotice,
  employerAcceptedNotice,
  isVacancyContactLabel
} from './match-flow.js';
import {
  developmentKindLabel,
  developmentOfferNotice,
  developmentActionKeyboard,
  formatEmploymentCard,
  formatStaffCard,
  formatStaffListItem,
  staffJoinedNotice
} from './staff-flow.js';

const bot = new Bot(process.env.BOT_TOKEN);
bot.catch(async (err, ctx) => {
  console.error('[BOT]', err);
  try {
    const userId = ctx.user?.user_id;
    const text = 'Не получилось обработать сообщение. Попробуйте ещё раз.';
    if (userId) await replyRoleMenu(ctx, userId, text);
    else await ctx.reply(text);
  } catch (replyErr) {
    console.error('[BOT reply]', replyErr.message || replyErr);
  }
});
const processedUpdates = new Map();
const userStates = new Map();
const processingUsers = new Set();
const DEDUP_TIMEOUT = 2 * 60 * 1000;

const SORT_LABELS = {
  new: 'Сначала новые',
  salary: 'По зарплате',
  title: 'По названию',
  distance: 'По удалённости'
};

function emptyWorkerFilters() {
  return { specialization: null, city: null, ageMin: null, ageMax: null, skills: null, gosuslugi: false, recommended: false, near: null, sort: null };
}

function getWorkerFilters(userId) {
  return userStates.get(`${userId}_worker_filters`) || emptyWorkerFilters();
}

function setWorkerFilters(userId, filters) {
  userStates.set(`${userId}_worker_filters`, { ...emptyWorkerFilters(), ...filters });
}

function formatAgeFilter(filters) {
  if (filters.ageMin == null && filters.ageMax == null) return 'любой';
  if (filters.ageMin != null && filters.ageMax != null) return `${filters.ageMin}–${filters.ageMax}`;
  if (filters.ageMin != null) return `от ${filters.ageMin}`;
  return `до ${filters.ageMax}`;
}

function originCaption(filters, userId) {
  if (filters.near) return filters.near;
  const home = locate(dbOperations.homePlace(userId));
  return home ? `${home.name} (из профиля)` : 'не задан';
}

function formatWorkerFiltersText(filters, userId) {
  return `Специальность: ${filters.specialization || 'все'}\n` +
    `Город: ${filters.city || 'все'}\n` +
    `Расстояние от: ${originCaption(filters, userId)}\n` +
    `Возраст: ${formatAgeFilter(filters)}\n` +
    `Навыки: ${filters.skills || 'все'}\n` +
    `Госуслуги: ${filters.gosuslugi ? 'только подтверждённые' : 'все'}\n` +
    `Под вакансии: ${filters.recommended ? 'только рекомендуемые' : 'все'}\n` +
    `Сортировка: ${filters.sort === 'distance' ? 'по удалённости' : 'сначала рекомендуемые'}`;
}

function setJobFilters(userId, filters) {
  userStates.set(`${userId}_job_filters`, filters);
}

function getJobFilters(userId) {
  return userStates.get(`${userId}_job_filters`) || { seasonality: null, location: null, keyword: null, sort: 'new', near: null };
}

function formatFiltersText(filters, userId) {
  return `Сезонность: ${filters.seasonality || 'все'}\n` +
    `Город: ${filters.location || 'все'}\n` +
    `Расстояние от: ${originCaption(filters, userId)}\n` +
    `Специальность: ${filters.keyword || 'не задана'}\n` +
    `Сортировка: ${SORT_LABELS[filters.sort] || SORT_LABELS.new}`;
}

function searchFilters(userId, filters) {
  return { ...filters, near: filters.near || dbOperations.homePlace(userId) || null };
}

function distanceReady(userId, filters) {
  if (filters.sort !== 'distance') return true;
  return Boolean(locate(filters.near || dbOperations.homePlace(userId)));
}

function miniAppUrl() {
  return (process.env.MINI_APP_URL || `http://localhost:${process.env.MINI_APP_PORT || 8080}`).replace(/\/$/, '');
}

function isPublicHttpUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
  } catch {
    return false;
  }
}

function miniAppOpenRow() {
  if (process.env.MINI_APP_OPEN_BUTTON !== '1') return [];
  const url = miniAppUrl();
  if (!isPublicHttpUrl(url) || !url.startsWith('https://')) return [];
  return [[{ type: 'open_app', text: 'Открыть приложение', web_app: url }]];
}

function workerMenuKeyboard(includeSwitch = false, userId = null) {
  const buttons = [];
  if (userId && !dbOperations.getWorkerProfile(userId)) {
    buttons.push([{ type: 'callback', text: '📝 Создать анкету', payload: 'create_profile' }]);
  }
  buttons.push(
    [
      { type: 'callback', text: 'Найти работу', payload: 'find_jobs' },
      { type: 'callback', text: 'Мой профиль', payload: 'view_profile' }
    ],
    [
      { type: 'callback', text: '⭐ Избранное', payload: 'view_favorites' },
      { type: 'callback', text: 'Отклики', payload: 'my_matches' }
    ],
    [
      { type: 'callback', text: 'Моя работа', payload: 'my_work' },
      { type: 'callback', text: 'Фильтры', payload: 'job_filters' }
    ],
    ...miniAppOpenRow()
  );
  if (includeSwitch) {
    buttons.push([{ type: 'callback', text: '🔄 Переключить профиль', payload: 'switch_profile' }]);
  }
  return {
    attachments: [{
      type: 'inline_keyboard',
      payload: { buttons }
    }]
  };
}

function employerMenuKeyboard(includeSwitch = false, userId = null) {
  const buttons = [];
  if (userId && !dbOperations.getEmployerProfile(userId)) {
    buttons.push([{ type: 'callback', text: '🏢 Создать профиль компании', payload: 'create_profile' }]);
  }
  if (userId && dbOperations.getVacancyDraft(userId)) {
    buttons.push([{ type: 'callback', text: 'Продолжить вакансию', payload: 'resume_vacancy' }]);
  }
  buttons.push(
    [
      { type: 'callback', text: 'Разместить вакансию', payload: 'post_vacancy' },
      { type: 'callback', text: 'Мои вакансии', payload: 'my_vacancies' }
    ],
    [
      { type: 'callback', text: 'Профиль компании', payload: 'view_employer_profile' },
      { type: 'callback', text: 'Найти работников', payload: 'browse_workers' }
    ],
    [
      { type: 'callback', text: 'Отклики', payload: 'my_matches' },
      { type: 'callback', text: 'Кадры', payload: 'company_staff' }
    ],
    ...miniAppOpenRow()
  );
  if (includeSwitch) {
    buttons.push([{ type: 'callback', text: '🔄 Переключить профиль', payload: 'switch_profile' }]);
  }
  return {
    attachments: [{
      type: 'inline_keyboard',
      payload: { buttons }
    }]
  };
}

async function replyRoleMenu(ctx, userId, text = 'Что дальше?') {
  const user = dbOperations.getUser(userId);
  if (user?.role === 'worker') {
    await safeReply(ctx, text, workerMenuKeyboard(true, userId));
    return;
  }
  if (user?.role === 'employer') {
    await safeReply(ctx, text, employerMenuKeyboard(true, userId));
    return;
  }
  await safeReply(ctx, text, roleChoiceKeyboard());
}

function isSkipPhotoText(text) {
  const value = (text || '').trim().toLowerCase();
  return value === 'пропустить' || value === '-' || value === 'skip';
}

function extractPhotoFromMessage(ctx) {
  const attachments = ctx.message?.body?.attachments || ctx.message?.attachments || [];
  const image = attachments.find(a => a.type === 'image' || a.type === 'photo')
    || attachments.find(a => a.type === 'file' && /\.(jpe?g|png|gif|webp|bmp)$/i.test(a.filename || a.payload?.filename || ''));
  if (!image) return null;
  const payload = image.payload || image;
  let token = payload.token || null;
  if (!token && payload.photos && typeof payload.photos === 'object') {
    const first = Object.values(payload.photos)[0];
    token = first?.token || (typeof first === 'string' ? first : null);
  }
  const url = pickBestImageUrl(payload) || payload.url || null;
  if (!token && !url && !payload.photos) return null;
  return {
    type: image.type === 'file' ? 'file' : 'image',
    token,
    url,
    photos: payload.photos || null,
    photo_id: payload.photo_id || null,
    payload
  };
}

function hasStoredPhoto(photo) {
  if (!photo) return false;
  if (typeof photo === 'object') return Boolean(photo.token || photo.url);
  if (typeof photo === 'string') {
    const value = photo.trim();
    return Boolean(value) && value !== 'нет' && (/^https?:\/\//i.test(value) || value.length > 12);
  }
  return false;
}

function buildPhotoAttachment(photo) {
  if (!hasStoredPhoto(photo) && !photo?.photos) return null;
  if (typeof photo === 'string' && /^https?:\/\//i.test(photo.trim())) {
    return { type: 'image', payload: { url: photo.trim() } };
  }
  if (typeof photo === 'object') {
    if (photo.photos) return { type: 'image', payload: { photos: photo.photos } };
    if (photo.token) return { type: 'image', payload: { token: photo.token } };
    let url = photo.url;
    if (url && url.startsWith('/') && process.env.MINI_APP_URL) {
      url = `${process.env.MINI_APP_URL.replace(/\/$/, '')}${url}`;
    }
    if (url && /^https?:\/\//i.test(url)) return { type: 'image', payload: { url } };
  }
  return null;
}

function photoStatusText(photo) {
  return hasStoredPhoto(photo) || photo?.photos ? 'добавлено (3×4)' : 'нет';
}

async function replyWithPhoto(ctx, text, extra = {}, photo = null, ownerUserId = null) {
  const owner = ownerUserId || ctx.user?.user_id;
  const normalized = await ensurePortraitPhoto(owner, photo, ctx.api);
  const keyboard = extra.attachments || [];
  const image = buildPhotoAttachment(normalized);
  try {
    const attachments = image ? [image, ...keyboard] : keyboard;
    if (attachments.length) {
      return await ctx.reply(text, { ...extra, attachments });
    }
    return await ctx.reply(text, extra);
  } catch (err) {
    console.error('Не удалось отправить анкету вместе с фото:', err.message);
    if (image) {
      try {
        await ctx.reply('Фото профиля:', { attachments: [image] });
      } catch (photoErr) {
        console.error('Не удалось отправить фото:', photoErr.message);
      }
    }
    if (keyboard.length) {
      return ctx.reply(text, { ...extra, attachments: keyboard });
    }
    return ctx.reply(text, extra);
  }
}

async function notifyUser(api, userId, text, extra) {
  const uid = Number(userId);
  const attempts = [{ type: 'user', id: uid }];
  const chatId = dbOperations.getUser(uid)?.chat_id;
  if (chatId) attempts.push({ type: 'chat', id: chatId });
  let lastError = null;
  for (const attempt of attempts) {
    try {
      if (attempt.type === 'user') {
        if (extra === undefined) await api.sendMessageToUser(attempt.id, text);
        else await api.sendMessageToUser(attempt.id, text, extra);
      } else if (extra === undefined) {
        await api.sendMessageToChat(attempt.id, text);
      } else {
        await api.sendMessageToChat(attempt.id, text, extra);
      }
      return true;
    } catch (err) {
      lastError = err;
      console.error(`[NOTIFY ${attempt.type}]`, attempt.id, err.message || err);
    }
  }
  if (lastError) console.error('[NOTIFY] не удалось доставить сообщение пользователю', uid);
  return false;
}

async function deliverAcceptedContacts(ctx, actorId, match) {
  const decorated = dbOperations.decorateMatch(match) || match;
  const forWorker = workerAcceptedNotice(decorated);
  const forEmployer = employerAcceptedNotice(decorated);
  const actorIsEmployer = Number(actorId) === Number(decorated.employer_id);
  await safeReply(ctx, actorIsEmployer ? forEmployer : forWorker);
  const otherId = actorIsEmployer ? decorated.worker_id : decorated.employer_id;
  const otherText = actorIsEmployer ? forWorker : forEmployer;
  const sent = await notifyUser(ctx.api, otherId, otherText);
  if (!sent) {
    await safeReply(ctx, 'Контакты открыты у вас. Вторую сторону сейчас не удалось уведомить — пусть откроет бота и раздел «Отклики».');
  }
  const staff = dbOperations.getCompanyStaff(decorated.employer_id)
    .find((row) => Number(row.worker_id) === Number(decorated.worker_id) && Number(row.vacancy_id) === Number(decorated.vacancy_id));
  if (staff) {
    await notifyUser(ctx.api, decorated.worker_id, staffJoinedNotice(staff));
    await safeReply(ctx, actorIsEmployer
      ? `Сотрудник зачислен в кадры на должность «${staff.position}».`
      : staffJoinedNotice(staff));
  }
}

async function sendToUserWithPhoto(api, userId, text, extra = {}, photo = null, ownerUserId = null) {
  const normalized = await ensurePortraitPhoto(ownerUserId || userId, photo, api);
  const keyboard = extra.attachments || [];
  const image = buildPhotoAttachment(normalized);
  try {
    const attachments = image ? [image, ...keyboard] : keyboard;
    if (attachments.length) {
      return await api.sendMessageToUser(userId, text, { ...extra, attachments });
    }
    return await api.sendMessageToUser(userId, text, extra);
  } catch (err) {
    console.error('Не удалось отправить уведомление с фото:', err.message);
    if (image) {
      try {
        await api.sendMessageToUser(userId, 'Фото кандидата:', { attachments: [image] });
      } catch (photoErr) {
        console.error('Не удалось отправить фото кандидата:', photoErr.message);
      }
    }
    if (keyboard.length) {
      return api.sendMessageToUser(userId, text, { ...extra, attachments: keyboard });
    }
    return api.sendMessageToUser(userId, text, extra);
  }
}

function workerExtras(data) {
  return {
    city: data.city || '',
    education: data.education || '',
    skills: data.skills || '',
    about: data.about || ''
  };
}

function saveWorker(userId, data, photo) {
  dbOperations.addWorkerProfile(
    userId,
    data.full_name || data.fullName,
    data.age,
    data.specialization,
    data.experience,
    data.phone,
    photo,
    workerExtras(data)
  );
}

function saveEmployer(userId, data) {
  dbOperations.addEmployerProfile(
    userId,
    data.company_name || data.companyName,
    data.industry,
    data.description,
    data.contact_person || data.contactPerson,
    data.phone,
    {
      inn: data.inn,
      legal_address: data.legal_address || data.legalAddress,
      director_fio: data.director_fio || data.directorFio,
      website: data.website || ''
    }
  );
}

async function verifyAndStoreEmployer(userId) {
  const profile = dbOperations.getEmployerProfile(userId);
  if (!profile) return { ok: false, error: 'Сначала заполните профиль компании.' };
  try {
    const result = await verifyEmployerRegistry({
      inn: profile.inn,
      directorFio: profile.director_fio,
      legalAddress: profile.legal_address
    });
    dbOperations.setEmployerVerification(userId, result);
    return result;
  } catch (err) {
    console.error('[EGRUL store]', err);
    return { ok: false, error: 'Проверку реестра не удалось выполнить. Профиль сохранён.' };
  }
}

async function finishEmployerProfileCreation(ctx, userId, data) {
  saveEmployer(userId, data);
  clearFillSession(userId);
  dbOperations.clearProfileDraft(userId, 'employer');
  const result = await verifyAndStoreEmployer(userId);
  if (result.ok) {
    const reg = result.registry === 'egrip' ? 'ЕГРИП' : 'ЕГРЮЛ';
    await safeReply(ctx, `✅ Компания подтверждена по ${reg}. Теперь можно размещать вакансии.`);
  } else {
    const errText = String(result.error || 'Данные не совпали с реестром.').slice(0, 400);
    await safeReply(ctx, `Профиль компании сохранён, но компания не подтверждена.\nПроверка ЕГРЮЛ/ЕГРИП: ${errText}\nВакансии размещать можно — соискатели увидят в них пометку «Компания не подтверждена».`);
  }
  await safeReply(ctx, 'Что вы хотите сделать?', {
    attachments: [{
      type: 'inline_keyboard',
      payload: {
        buttons: [[
          { type: 'callback', text: 'Разместить вакансию', payload: 'post_vacancy' },
          { type: 'callback', text: 'Проверить ещё раз', payload: 'verify_egrul' }
        ], [
          { type: 'callback', text: 'Профиль компании', payload: 'view_employer_profile' },
          { type: 'callback', text: 'Назад в меню', payload: 'back_to_menu' }
        ]]
      }
    }]
  });
}

function formatOwnProfileText(profile) {
  const statusText = profile.is_active ? '✅ Активна' : '❌ Скрыта';
  return `Ваш профиль:\n` +
    `1. Имя: ${profile.full_name}\n` +
    `2. Возраст: ${profile.age}\n` +
    `3. Город: ${profile.city || '—'}\n` +
    `4. Специальность: ${profile.specialization}\n` +
    `5. Опыт: ${profile.experience}\n` +
    `6. Образование: ${profile.education || '—'}\n` +
    `7. Навыки: ${profile.skills || '—'}\n` +
    `8. О себе: ${profile.about || '—'}\n` +
    `9. Телефон: ${profile.phone}\n` +
    `10. Фото: ${photoStatusText(profile.photo)}\n` +
    `${gosuslugiStatusLine(profile)}\n` +
    `Статус: ${statusText}\n\n` +
    `Напишите номер пункта, чтобы изменить (1-10), или нажмите «Заменить фото».`;
}

function ownProfileButtons(profile) {
  const statusRow = profile.is_active
    ? [
        { type: 'callback', text: 'Скрыть профиль', payload: 'stop_profile' },
        { type: 'callback', text: 'Удалить профиль', payload: 'delete_profile_confirm' }
      ]
    : [
        { type: 'callback', text: 'Включить профиль', payload: 'activate_profile' },
        { type: 'callback', text: 'Удалить профиль', payload: 'delete_profile_confirm' }
      ];
  const esiaRow = esiaConfigured() && isPublicHttpUrl(gosuslugiStartUrl(profile.user_id))
    ? [[{
        type: 'link',
        text: isGosuslugiVerified(profile) ? 'Обновить данные из Госуслуг' : 'Подтвердить через Госуслуги',
        url: gosuslugiStartUrl(profile.user_id)
      }]]
    : [];
  return [
    ...esiaRow,
    [{ type: 'callback', text: 'Заменить фото', payload: 'replace_photo' }],
    statusRow,
    [{ type: 'callback', text: '🔄 Переключить профиль', payload: 'switch_profile' }],
    [{ type: 'callback', text: 'Назад', payload: 'back_to_menu' }]
  ];
}

function formatCompanyEmploymentLine(jobs) {
  if (!jobs?.length) return '';
  const details = jobs.map((job) =>
    job.job_title && job.job_title !== job.position
      ? `${job.position} (вакансия «${job.job_title}»)`
      : (job.position || job.job_title)
  ).join(', ');
  return `🏢 Этот человек уже работает у вас: ${details}\n`;
}

function formatWorkerCardText(worker, index, total, viewerId = null) {
  const recommended = worker.recommended ? '✅ Рекомендуемый кандидат\n' : '';
  const matchLine = worker.matchedVacancy
    ? `Подходит под вакансию: ${worker.matchedVacancy.job_title}\n`
    : '';
  const showPhone = viewerId && (viewerId === worker.user_id || dbOperations.contactsUnlocked(viewerId, worker.user_id));
  const staffJobs = viewerId && Number(viewerId) !== Number(worker.user_id)
    ? dbOperations.getCompanyEmployment(viewerId, worker.user_id)
    : [];
  return `${formatCompanyEmploymentLine(staffJobs)}${recommended}${matchLine}👤 Анкета работника\n` +
    `${gosuslugiStatusLine(worker)}\n\n` +
    `Имя: ${worker.full_name}\n` +
    `Возраст: ${worker.age}\n` +
    `Город: ${worker.city || 'не указан'}\n` +
    `${worker.distance_label ? `${worker.distance_label}\n` : ''}` +
    `Специальность: ${worker.specialization}\n` +
    `Опыт: ${worker.experience}\n` +
    `Образование: ${worker.education || 'не указано'}\n` +
    `Навыки: ${worker.skills || 'не указаны'}\n` +
    `О себе: ${worker.about || 'не указано'}\n` +
    `Телефон: ${showPhone ? worker.phone : 'скрыт до принятия отклика'}\n` +
    `Фото: ${photoStatusText(worker.photo)}\n` +
    `ЭТК: ${worker.labor_book?.records?.length ? `${worker.labor_book.records.length} запис.` : 'нет'}\n\n` +
    `(${index + 1} из ${total})`;
}

function formatEmployerProfileText(profile) {
  return `Профиль компании:\n` +
    `1. Название: ${profile.company_name}\n` +
    `2. Отрасль: ${profile.industry}\n` +
    `3. О компании: ${profile.description}\n` +
    `4. ИНН: ${profile.inn || '—'}\n` +
    `5. Юридический адрес: ${profile.legal_address || '—'}\n` +
    `6. ФИО руководителя: ${profile.director_fio || '—'}\n` +
    `7. Контактное лицо: ${profile.contact_person}\n` +
    `8. Телефон: ${profile.phone}\n` +
    `9. Сайт: ${profile.website || '—'}\n\n` +
    `${verificationLabel(profile)}\n\n` +
    `Напишите номер пункта, чтобы изменить (1-9).`;
}

function employerProfileButtons() {
  return {
    attachments: [{
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [{ type: 'callback', text: 'Проверить по ЕГРЮЛ/ЕГРИП', payload: 'verify_egrul' }],
          [
            { type: 'callback', text: 'Удалить профиль', payload: 'delete_employer_profile_confirm' },
            { type: 'callback', text: 'Назад', payload: 'back_to_menu' }
          ],
          [{ type: 'callback', text: '🔄 Переключить профиль', payload: 'switch_profile' }]
        ]
      }
    }]
  };
}

async function denyUnverifiedVacancy(ctx, userId) {
  const profile = dbOperations.getEmployerProfile(userId);
  if (!profile) {
    await askToCreateProfile(ctx, userId, 'разместить вакансию');
    return true;
  }
  const message = vacancyGateMessage(profile);
  if (!message) return false;
  await ctx.reply(message, {
    attachments: [{
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [{ type: 'callback', text: 'Проверить по ЕГРЮЛ/ЕГРИП', payload: 'verify_egrul' }],
          [{ type: 'callback', text: 'Профиль компании', payload: 'view_employer_profile' }]
        ]
      }
    }]
  });
  return true;
}

function workerBrowseButtons(employerId, worker) {
  const vacancies = dbOperations.getEmployerVacancies(employerId);
  const offered = worker && vacancies.some((v) => dbOperations.hasOffered(employerId, worker.user_id, v.id));
  return [
    [
      { type: 'callback', text: '◀️ Предыдущий', payload: 'prev_worker' },
      { type: 'callback', text: 'Дальше ▶️', payload: 'next_worker' }
    ],
    [{ type: 'callback', text: offered ? '✓ Отклик отправлен' : 'Откликнуться', payload: 'offer_job' }],
    [{ type: 'callback', text: '📘 Трудовая книжка', payload: 'view_labor' }],
    [
      { type: 'callback', text: 'Фильтры', payload: 'worker_filters' },
      { type: 'callback', text: 'Все анкеты', payload: 'browse_workers' }
    ],
    [{ type: 'callback', text: 'Назад в меню', payload: 'back_to_menu' }]
  ];
}

async function showCurrentWorker(ctx, employerId) {
  const list = userStates.get(`${employerId}_workers_list`) || [];
  const index = userStates.get(`${employerId}_worker_index`) || 0;
  if (!list.length) {
    await ctx.reply('Анкеты не найдены. Сбросьте фильтры или посмотрите все анкеты.', {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [
            [
              { type: 'callback', text: 'Все анкеты', payload: 'browse_workers' },
              { type: 'callback', text: 'Фильтры', payload: 'worker_filters' }
            ],
            [{ type: 'callback', text: 'Назад в меню', payload: 'back_to_menu' }]
          ]
        }
      }]
    });
    return;
  }
  const worker = list[index];
  await replyWithPhoto(ctx, formatWorkerCardText(worker, index, list.length, employerId), {
    attachments: [{ type: 'inline_keyboard', payload: { buttons: workerBrowseButtons(employerId, worker) } }]
  }, worker.photo, worker.user_id);
}

function startWorkerSearch(employerId) {
  const list = dbOperations.getRankedWorkers(employerId, searchFilters(employerId, getWorkerFilters(employerId)));
  userStates.set(employerId, 'browsing_workers');
  userStates.set(`${employerId}_workers_list`, list);
  userStates.set(`${employerId}_worker_index`, 0);
  return list;
}

function workerFiltersKeyboard() {
  return {
    attachments: [{
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [
            { type: 'callback', text: 'Специальность', payload: 'wfilter_spec' },
            { type: 'callback', text: 'Город', payload: 'wfilter_city' }
          ],
          [
            { type: 'callback', text: 'Возраст', payload: 'wfilter_age' },
            { type: 'callback', text: 'Навыки', payload: 'wfilter_skills' }
          ],
          [
            { type: 'callback', text: 'От города', payload: 'wfilter_near' },
            { type: 'callback', text: 'По удалённости', payload: 'wfilter_sort_distance' }
          ],
          [
            { type: 'callback', text: 'Госуслуги', payload: 'wfilter_gosu' },
            { type: 'callback', text: 'Под вакансии', payload: 'wfilter_rec' }
          ],
          [
            { type: 'callback', text: 'Сбросить', payload: 'wfilter_reset' },
            { type: 'callback', text: 'Показать анкеты', payload: 'wfilter_apply' }
          ],
          [{ type: 'callback', text: 'Назад в меню', payload: 'back_to_menu' }]
        ]
      }
    }]
  };
}

async function showWorkerFiltersMenu(ctx, userId) {
  await ctx.reply(`🔎 Фильтры анкет\n\n${formatWorkerFiltersText(getWorkerFilters(userId), userId)}`, workerFiltersKeyboard());
}

async function showOwnProfile(ctx, userId) {
  const profile = dbOperations.getWorkerProfile(userId);
  if (!profile) {
    await ctx.reply('Профиль не найден.');
    return;
  }
  userStates.set(userId, 'editing_profile_choice');
  if (!userStates.has(`${userId}_edit_data`)) {
    userStates.set(`${userId}_edit_data`, { ...profile });
  }
  await replyWithPhoto(ctx, formatOwnProfileText(profile), {
    attachments: [{ type: 'inline_keyboard', payload: { buttons: ownProfileButtons(profile) } }]
  }, profile.photo, userId);
}

function skipKeyboard(payload) {
  return {
    attachments: [{
      type: 'inline_keyboard',
      payload: {
        buttons: [[{ type: 'callback', text: 'Пропустить', payload }]]
      }
    }]
  };
}

function fillActionKeyboard(state) {
  const rows = [];
  if (state === 'worker_asking_about') {
    rows.push([{ type: 'callback', text: 'Пропустить', payload: 'skip_about' }]);
  }
  if (state === 'employer_asking_website') {
    rows.push([{ type: 'callback', text: 'Пропустить', payload: 'skip_website' }]);
  }
  if (state === 'worker_asking_photo') {
    rows.push([{ type: 'callback', text: 'Пропустить', payload: 'skip_photo' }]);
  }
  rows.push([
    { type: 'callback', text: 'Отменить заполнение', payload: 'cancel_fill' },
    { type: 'callback', text: 'Сменить роль', payload: 'switch_profile' }
  ]);
  return {
    attachments: [{
      type: 'inline_keyboard',
      payload: { buttons: rows }
    }]
  };
}

function skipPhotoKeyboard() {
  return skipKeyboard('skip_photo');
}

function skipAboutKeyboard() {
  return skipKeyboard('skip_about');
}

const FACE_PHOTO_PROMPT = 'Пришлите вертикальное фото лица. Снимок должен быть вертикальным, лицо хорошо видно. Оно будет обрезано до формата 3×4. Можно пропустить.';

const WORKER_STEP_PROMPTS = {
  worker_asking_name: '1️⃣ Как вас зовут?',
  worker_asking_age: '2️⃣ Сколько вам лет?',
  worker_asking_city: '3️⃣ В каком городе вы ищете работу?',
  worker_asking_spec: '4️⃣ Ваша специальность?',
  worker_asking_experience: '5️⃣ Опыт работы. Можно коротко: достаточно одного символа.',
  worker_asking_education: '6️⃣ Образование? Учебное заведение, специальность, год.',
  worker_asking_skills: '7️⃣ Ключевые навыки? Перечислите через запятую.',
  worker_asking_about: '8️⃣ Расскажите о себе, если хотите. Можно пропустить.',
  worker_asking_phone: '9️⃣ Ваш реальный номер телефона? Российский (+7 921 123-45-67) или зарубежный (+375 29 123-45-67, +48 501 234 567).',
  worker_asking_photo: FACE_PHOTO_PROMPT
};

const EMPLOYER_STEP_PROMPTS = {
  employer_asking_company: '1️⃣ Как называется ваша компания?',
  employer_asking_industry: '2️⃣ Отрасль/сектор?',
  employer_asking_desc: '3️⃣ Расскажите о компании: чем занимаетесь, сколько человек, какие задачи. Можно коротко, хоть один символ.',
  employer_asking_inn: '4️⃣ ИНН организации или ИП? Для юрлица — 10 цифр, для ИП — 12.',
  employer_asking_address: '5️⃣ Юридический адрес, как в ЕГРЮЛ или ЕГРИП: регион, город, улица, дом.',
  employer_asking_director: '6️⃣ ФИО руководителя (для юрлица) или ФИО ИП — как в реестре.',
  employer_asking_contact: '7️⃣ Контактное лицо для связи с соискателями? Если это руководитель, напишите «тот же».',
  employer_asking_phone: '8️⃣ Телефон компании? Российский или зарубежный, с кодом страны: +7…, +375…, +49…',
  employer_asking_website: '9️⃣ Сайт компании? Отправьте ссылку, например https://company.ru. Можно пропустить.'
};

function setFillState(userId, state, data) {
  userStates.set(userId, state);
  if (data) userStates.set(`${userId}_data`, data);
  const kind = String(state).startsWith('employer_asking') ? 'employer' : 'worker';
  try {
    dbOperations.saveProfileDraft(userId, {
      kind,
      state,
      data: data || userStates.get(`${userId}_data`) || {}
    });
  } catch (err) {
    console.error('[DRAFT]', err);
  }
}

function restoreDraftToSession(userId, draft) {
  userStates.set(userId, draft.state);
  userStates.set(`${userId}_data`, { ...(draft.data || {}) });
}

const VACANCY_STEP_PROMPTS = {
  vacancy_asking_title: 'Создание вакансии.\n1️⃣ Название должности?',
  vacancy_asking_desc: '2️⃣ Описание должности?',
  vacancy_asking_req: '3️⃣ Требования?',
  vacancy_asking_location: '4️⃣ Местоположение?',
  vacancy_asking_salary: '5️⃣ Зарплата?',
  vacancy_asking_seasonality: '6️⃣ Сезонность?',
  vacancy_asking_contact_name: '7️⃣ Имя сотрудника, которому принадлежит телефон для связи?',
  vacancy_asking_contact_position: '8️⃣ Должность этого сотрудника?',
  vacancy_asking_contact_phone: '9️⃣ Телефон этого сотрудника? Российский или зарубежный, с кодом страны.'
};

function setVacancyFillState(userId, state, data) {
  userStates.set(userId, state);
  if (data) userStates.set(`${userId}_data`, data);
  try {
    dbOperations.saveVacancyDraft(userId, {
      state,
      data: data || userStates.get(`${userId}_data`) || {}
    });
  } catch (err) {
    console.error('[VACANCY DRAFT]', err);
  }
}

function vacancyActionKeyboard(state) {
  const rows = [];
  if (state === 'vacancy_asking_seasonality') {
    const seasonRows = seasonalityKeyboard().attachments[0].payload.buttons;
    rows.push(...seasonRows);
  }
  rows.push([{ type: 'callback', text: 'Отменить заполнение', payload: 'cancel_vacancy_fill' }]);
  return {
    attachments: [{
      type: 'inline_keyboard',
      payload: { buttons: rows }
    }]
  };
}

async function promptVacancyStep(ctx, state) {
  const text = VACANCY_STEP_PROMPTS[state];
  if (!text) return;
  await safeReply(ctx, text, vacancyActionKeyboard(state));
}

function hasIncompleteVacancy(userId) {
  const draft = dbOperations.getVacancyDraft(userId);
  if (!draft?.state || !String(draft.state).startsWith('vacancy_asking')) return null;
  return draft;
}

async function offerResumeVacancy(ctx, userId, draft) {
  restoreDraftToSession(userId, draft);
  const title = draft.data?.jobTitle ? ` «${draft.data.jobTitle}»` : '';
  await ctx.reply(`Вакансия${title} заполнена не до конца. Продолжить или начать заново?`, {
    attachments: [{
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [
            { type: 'callback', text: 'Продолжить', payload: 'resume_vacancy' },
            { type: 'callback', text: 'Начать заново', payload: 'restart_vacancy' }
          ],
          [{ type: 'callback', text: 'Отменить заполнение', payload: 'cancel_vacancy_fill' }]
        ]
      }
    }]
  });
}

async function maybeOfferIncompleteVacancy(ctx, userId) {
  const draft = hasIncompleteVacancy(userId);
  if (!draft) return false;
  await offerResumeVacancy(ctx, userId, draft);
  return true;
}

async function resumeVacancyFill(ctx, userId) {
  const draft = hasIncompleteVacancy(userId) || dbOperations.getVacancyDraft(userId);
  if (!draft) {
    await ctx.reply('Черновик вакансии не найден. Можно создать новую.');
    await startVacancyFill(ctx, userId);
    return;
  }
  restoreDraftToSession(userId, draft);
  await ctx.reply('Продолжаем заполнение вакансии.');
  await promptVacancyStep(ctx, draft.state);
}

async function startVacancyFill(ctx, userId, reset = false) {
  if (reset) dbOperations.clearVacancyDraft(userId);
  setVacancyFillState(userId, 'vacancy_asking_title', {});
  await promptVacancyStep(ctx, 'vacancy_asking_title');
}

async function cancelVacancyFill(ctx, userId) {
  dbOperations.clearVacancyDraft(userId);
  clearFillSession(userId);
  await ctx.reply('Заполнение вакансии отменено.', employerMenuKeyboard(true, userId));
}

function stepKeyboard(state) {
  return fillActionKeyboard(state);
}

function withoutOpenApp(extra) {
  if (!extra?.attachments) return extra;
  return {
    ...extra,
    attachments: extra.attachments.map((attachment) => {
      if (attachment.type !== 'inline_keyboard') return attachment;
      const buttons = (attachment.payload?.buttons || []).filter((row) => !row.some((button) => button.type === 'open_app'));
      return { ...attachment, payload: { ...attachment.payload, buttons } };
    })
  };
}

async function safeReply(ctx, text, extra) {
  try {
    if (extra === undefined) return await ctx.reply(text);
    return await ctx.reply(text, extra);
  } catch (err) {
    console.error('[REPLY]', err.message || err);
    if (extra && String(err.message || err).includes('Link not found')) {
      try {
        return await ctx.reply(text, withoutOpenApp(extra));
      } catch (strippedErr) {
        console.error('[REPLY stripped]', strippedErr.message || strippedErr);
      }
    }
    if (extra) {
      try {
        return await ctx.reply(text);
      } catch (retryErr) {
        console.error('[REPLY retry]', retryErr.message || retryErr);
      }
    }
    return null;
  }
}

async function promptProfileStep(ctx, state) {
  const text = WORKER_STEP_PROMPTS[state] || EMPLOYER_STEP_PROMPTS[state];
  if (text) await safeReply(ctx, text, stepKeyboard(state));
}

function hasIncompleteProfile(userId, kind = null) {
  const role = kind || dbOperations.getUser(userId)?.role;
  const draft = dbOperations.getProfileDraft(userId, role) || (!kind ? dbOperations.getProfileDraft(userId) : null);
  if (!draft) return null;
  if (role && draft.kind && draft.kind !== role) return null;
  if (draft.kind === 'worker' && dbOperations.getWorkerProfile(userId)) {
    dbOperations.clearProfileDraft(userId, 'worker');
    return null;
  }
  if (draft.kind === 'employer' && dbOperations.getEmployerProfile(userId)) {
    dbOperations.clearProfileDraft(userId, 'employer');
    return null;
  }
  if (draft.state && String(draft.state).includes('_asking_')) return draft;
  return null;
}

function clearFillSession(userId) {
  userStates.delete(userId);
  userStates.delete(`${userId}_data`);
}

function roleChoiceKeyboard() {
  return {
    attachments: [{
      type: 'inline_keyboard',
      payload: {
        buttons: [[
          { type: 'callback', text: 'Работник', payload: 'worker_change' },
          { type: 'callback', text: 'Работодатель', payload: 'employer_change' }
        ]]
      }
    }]
  };
}

async function cancelProfileFill(ctx, userId) {
  const state = userStates.get(userId);
  const draft = dbOperations.getProfileDraft(userId);
  const kind = String(state || draft?.state || '').startsWith('employer_asking')
    ? 'employer'
    : (draft?.kind || 'worker');
  dbOperations.clearProfileDraft(userId, kind);
  clearFillSession(userId);
  const worker = dbOperations.getWorkerProfile(userId);
  const employer = dbOperations.getEmployerProfile(userId);
  if (kind === 'worker' && !worker) {
    dbOperations.updateUserRole(userId, employer ? 'employer' : null);
  } else if (kind === 'employer' && !employer) {
    dbOperations.updateUserRole(userId, worker ? 'worker' : null);
  }
  const user = dbOperations.getUser(userId);
  if (user?.role === 'worker' && worker) {
    await ctx.reply('Заполнение анкеты работника отменено.', workerMenuKeyboard(true, userId));
    return;
  }
  if (user?.role === 'employer' && employer) {
    await ctx.reply('Заполнение анкеты компании отменено.', employerMenuKeyboard(true, userId));
    return;
  }
  dbOperations.updateUserRole(userId, null);
  await ctx.reply('Заполнение отменено. Кем хотите быть?', roleChoiceKeyboard());
}

async function startProfileCreation(ctx, userId) {
  const user = dbOperations.getUser(userId);
  if (user?.role === 'worker' && dbOperations.getWorkerProfile(userId)) return false;
  if (user?.role === 'employer' && dbOperations.getEmployerProfile(userId)) return false;
  if (await maybeOfferIncompleteProfile(ctx, userId, user?.role)) return true;
  if (user?.role === 'worker') {
    setFillState(userId, 'worker_asking_name', {});
    const esiaHint = esiaConfigured()
      ? '\nМожно заполнить вручную или подтвердить данные через Госуслуги в профиле.'
      : '';
    await ctx.reply(`Создаём анкету работника.${esiaHint}`);
    await promptProfileStep(ctx, 'worker_asking_name');
    return true;
  }
  if (user?.role === 'employer') {
    setFillState(userId, 'employer_asking_company', {});
    await ctx.reply('Создаём профиль компании. После заполнения сверим ИНН, руководителя и адрес с ЕГРЮЛ/ЕГРИП.');
    await promptProfileStep(ctx, 'employer_asking_company');
    return true;
  }
  return false;
}

function createProfileKeyboard(role) {
  return {
    attachments: [{
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [{ type: 'callback', text: role === 'employer' ? '🏢 Создать профиль компании' : '📝 Создать анкету', payload: 'create_profile' }],
          [{ type: 'callback', text: 'Назад в меню', payload: 'back_to_menu' }]
        ]
      }
    }]
  };
}

async function askToCreateProfile(ctx, userId, action) {
  const role = dbOperations.getUser(userId)?.role;
  const what = role === 'employer' ? 'профиль компании' : 'анкету';
  await ctx.reply(`Чтобы ${action}, создайте ${what}. Смотреть ${role === 'employer' ? 'анкеты' : 'вакансии'} можно и без неё.`, createProfileKeyboard(role));
}

function roleWelcomeText(role, hasProfile) {
  if (role === 'employer') {
    return hasProfile
      ? 'Роль: работодатель.'
      : 'Роль: работодатель. Анкеты работников можно смотреть сразу. Чтобы размещать вакансии и приглашать людей, создайте профиль компании.';
  }
  return hasProfile
    ? 'Роль: работник.'
    : 'Роль: работник. Вакансии можно смотреть сразу. Чтобы откликаться, создайте анкету.';
}

async function offerResumeOrRestart(ctx, userId, draft) {
  const kindLabel = draft.kind === 'employer' ? 'компании' : 'работника';
  restoreDraftToSession(userId, draft);
  await ctx.reply(`Анкета ${kindLabel} заполнена не до конца. Продолжить, начать заново или отменить?`, {
    attachments: [{
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [
            { type: 'callback', text: 'Продолжить', payload: 'resume_profile' },
            { type: 'callback', text: 'Начать заново', payload: 'restart_profile' }
          ],
          [
            { type: 'callback', text: 'Отменить заполнение', payload: 'cancel_fill' },
            { type: 'callback', text: 'Сменить роль', payload: 'switch_profile' }
          ]
        ]
      }
    }]
  });
}

async function resumeProfileFill(ctx, userId) {
  const role = dbOperations.getUser(userId)?.role;
  const draft = hasIncompleteProfile(userId, role) || dbOperations.getProfileDraft(userId, role);
  if (!draft) {
    await ctx.reply('Черновик анкеты не найден.');
    return;
  }
  restoreDraftToSession(userId, draft);
  await ctx.reply('Продолжаем заполнение анкеты.');
  await promptProfileStep(ctx, draft.state);
}

async function restartProfileFill(ctx, userId, kind) {
  const draft = dbOperations.getProfileDraft(userId, kind) || dbOperations.getProfileDraft(userId);
  const fillKind = kind || draft?.kind || dbOperations.getUser(userId)?.role || 'worker';
  dbOperations.clearProfileDraft(userId, fillKind);
  clearFillSession(userId);
  if (fillKind === 'employer') {
    dbOperations.updateUserRole(userId, 'employer');
    setFillState(userId, 'employer_asking_company', {});
    await ctx.reply('Начинаем анкету компании заново.');
    await promptProfileStep(ctx, 'employer_asking_company');
    return;
  }
  dbOperations.updateUserRole(userId, 'worker');
  setFillState(userId, 'worker_asking_name', {});
  await ctx.reply('Начинаем анкету работника заново.');
  await promptProfileStep(ctx, 'worker_asking_name');
}

async function maybeOfferIncompleteProfile(ctx, userId, kind = null) {
  const draft = hasIncompleteProfile(userId, kind);
  if (!draft) return false;
  await offerResumeOrRestart(ctx, userId, draft);
  return true;
}

function isSkipText(text) {
  const value = String(text || '').trim().toLowerCase();
  return !value || value === '-' || value === 'пропустить' || value === 'пропуск';
}

function isCancelFillText(text) {
  const value = String(text || '').trim().toLowerCase();
  return value === 'отмена' || value === 'отменить' || value === 'cancel';
}

async function finishWorkerProfileCreation(ctx, userId, photo) {
  const data = userStates.get(`${userId}_data`);
  if (!data) {
    await ctx.reply('Не удалось сохранить профиль. Заполните анкету заново.');
    return;
  }
  let storedPhoto = photo;
  if (photo) {
    try {
      await ctx.reply('Кадрируем фото лица в вертикальный формат 3×4…');
      storedPhoto = await processPortraitPhoto(userId, photo, ctx.api);
      if (!storedPhoto?.portrait) {
        await ctx.reply('Не удалось обрезать фото. Попробуйте отправить снимок ещё раз как изображение.');
        return;
      }
    } catch (err) {
      console.error('[PHOTO] Обработка при создании профиля:', err.message);
      await ctx.reply('Не удалось обработать фото. Отправьте вертикальное фото лица ещё раз.');
      return;
    }
  }
  saveWorker(userId, data, storedPhoto);
  userStates.delete(userId);
  userStates.delete(`${userId}_data`);
  dbOperations.clearProfileDraft(userId, 'worker');
  await showOwnProfile(ctx, userId);
}

async function finishPhotoEdit(ctx, userId, photo, keepExisting = false) {
  const profile = dbOperations.getWorkerProfile(userId);
  const editData = userStates.get(`${userId}_edit_data`) || { ...profile };
  if (!keepExisting) {
    if (photo) {
      try {
        await ctx.reply('Кадрируем фото лица в вертикальный формат 3×4…');
        editData.photo = await processPortraitPhoto(userId, photo, ctx.api);
        if (!editData.photo?.portrait) {
          await ctx.reply('Не удалось обрезать фото. Отправьте вертикальное фото лица ещё раз.');
          return;
        }
      } catch (err) {
        console.error('[PHOTO] Обработка при замене фото:', err.message);
        editData.photo = photo;
      }
    } else {
      editData.photo = photo;
    }
  }
  saveWorker(userId, editData, editData.photo);
  userStates.delete(`${userId}_edit_data`);
  await ctx.reply(keepExisting ? 'Фото оставлено без изменений.' : '✅ Фото обновлено!');
  await showOwnProfile(ctx, userId);
}

async function sendVacancyOffer(ctx, employerId, worker, vacancy) {
  const created = dbOperations.addOffer(employerId, worker.user_id, vacancy.id);
  if (!created?.ok) {
    await ctx.reply(created?.reason === 'accepted'
      ? 'Контакты по этой вакансии уже открыты.'
      : 'Вы уже откликались на эту анкету по этой вакансии.');
    await showCurrentWorker(ctx, employerId);
    return;
  }
  const match = dbOperations.decorateMatch(created.match);
  try {
    await notifyUser(ctx.api, worker.user_id, incomingMatchText(match), matchActionKeyboard(match.id));
    await ctx.reply(`✅ Отклик по вакансии «${vacancy.job_title}» отправлен ${worker.full_name}. Когда соискатель примет его, вы оба получите контакты.`);
  } catch (err) {
    console.error('Ошибка предложения вакансии:', err);
    await ctx.reply('Не удалось отправить предложение работнику. Возможно, он ещё не запускал бота.');
  }
  await showCurrentWorker(ctx, employerId);
}

function formatMatchListItem(match, i) {
  return `${i + 1}. ${formatMatchTitle(match)}\nСтатус: ${matchStatusLabel(match.status)}`;
}

async function showMatchesMenu(ctx, userId) {
  const incoming = dbOperations.getIncomingMatches(userId);
  const outgoing = dbOperations.getOutgoingMatches(userId);
  userStates.set(`${userId}_match_in`, incoming);
  userStates.set(`${userId}_match_out`, outgoing);
  const pendingIn = incoming.filter((m) => m.status === 'pending').length;
  await ctx.reply(
    `📬 Отклики\n\nВходящие: ${incoming.length} (ждут ответа: ${pendingIn})\nИсходящие: ${outgoing.length}\n\n` +
    `Контакты появляются только после того, как вторую сторону приняли.`,
    {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [
            [{ type: 'callback', text: `Входящие (${incoming.length})`, payload: 'match_in' }],
            [{ type: 'callback', text: `Мои отклики (${outgoing.length})`, payload: 'match_out' }],
            [{ type: 'callback', text: 'Назад в меню', payload: 'back_to_menu' }]
          ]
        }
      }]
    }
  );
}

async function showMatchGroup(ctx, userId, group) {
  const list = userStates.get(`${userId}_match_${group}`)
    || (group === 'in' ? dbOperations.getIncomingMatches(userId) : dbOperations.getOutgoingMatches(userId));
  if (!list.length) {
    await ctx.reply(group === 'in' ? 'Входящих откликов пока нет.' : 'Вы ещё ни на кого не откликались.', {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [[{ type: 'callback', text: 'К откликам', payload: 'my_matches' }]]
        }
      }]
    });
    return;
  }
  if (group === 'in') {
    for (const match of list.slice(0, 8)) {
      await showIncomingMatchItem(ctx, userId, match);
    }
    await ctx.reply('Все входящие отклики выше.', {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [[{ type: 'callback', text: 'К откликам', payload: 'my_matches' }]]
        }
      }]
    });
    return;
  }
  const buttons = list.slice(0, 8).map((m, i) => ([{
    type: 'callback',
    text: `${i + 1}. ${matchStatusLabel(m.status)}`,
    payload: `mv_${m.id}`
  }]));
  await ctx.reply(
    'Мои отклики:\n\n' +
    list.slice(0, 8).map((m, i) => formatMatchListItem(m, i)).join('\n\n'),
    {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [
            ...buttons,
            [{ type: 'callback', text: 'К откликам', payload: 'my_matches' }]
          ]
        }
      }]
    }
  );
}

function matchNavButtons(match, userId) {
  const buttons = [];
  const isRecipient = Number(match.initiator_id) !== Number(userId)
    && (match.worker_id === userId || match.employer_id === userId);
  const isEmployer = Number(userId) === Number(match.employer_id);
  const isParty = Number(match.worker_id) === Number(userId) || Number(match.employer_id) === Number(userId);
  if (isRecipient && match.status === 'pending') {
    buttons.push([
      { type: 'callback', text: 'Принять', payload: `acc_${match.id}` },
      { type: 'callback', text: 'Отклонить', payload: `dec_${match.id}` }
    ]);
  }
  if (isParty && match.status === 'accepted') {
    buttons.push([{ type: 'callback', text: 'Контакты', payload: `mc_${match.id}` }]);
    if (isEmployer) {
      buttons.push([{ type: 'callback', text: 'Полная анкета', payload: `ma_${match.id}` }]);
    }
    buttons.push([{ type: 'callback', text: 'Отменить одобрение', payload: `cx_${match.id}` }]);
  }
  buttons.push([{ type: 'callback', text: 'К откликам', payload: 'my_matches' }]);
  return buttons;
}

async function showIncomingMatchItem(ctx, userId, match) {
  const text = `${formatMatchTitle(match)}\nСтатус: ${matchStatusLabel(match.status)}`;
  await ctx.reply(text, {
    attachments: [{ type: 'inline_keyboard', payload: { buttons: matchNavButtons(match, userId) } }]
  });
}

async function showMatchCard(ctx, userId, matchId) {
  const match = dbOperations.decorateMatch(dbOperations.getMatchById(matchId));
  if (!match) {
    await ctx.reply('Отклик не найден.');
    return;
  }
  const isRecipient = Number(match.initiator_id) !== Number(userId)
    && (match.worker_id === userId || match.employer_id === userId);
  let text = `${formatMatchTitle(match)}\nСтатус: ${matchStatusLabel(match.status)}`;
  if (match.status === 'cancelled') {
    text += '\n\nОдобрение отменено. Контакты снова скрыты.';
  } else if (isRecipient && match.status === 'pending') {
    text += `\n\n${incomingMatchText(match)}`;
  } else if (match.status === 'pending') {
    text += '\n\nЖдём, пока вторую сторону примут. Контакты пока скрыты.';
  }
  await ctx.reply(text, {
    attachments: [{ type: 'inline_keyboard', payload: { buttons: matchNavButtons(match, userId) } }]
  });
}

async function showMatchContacts(ctx, userId, matchId) {
  const match = dbOperations.decorateMatch(dbOperations.getMatchById(matchId));
  if (!match) {
    await ctx.reply('Отклик не найден.');
    return;
  }
  const isParty = Number(match.worker_id) === Number(userId) || Number(match.employer_id) === Number(userId);
  if (!isParty) {
    await ctx.reply('Это не ваш отклик.');
    return;
  }
  if (match.status !== 'accepted') {
    await ctx.reply('Контакты откроются после принятия отклика.', {
      attachments: [{ type: 'inline_keyboard', payload: { buttons: matchNavButtons(match, userId) } }]
    });
    return;
  }
  const text = Number(userId) === Number(match.employer_id)
    ? employerAcceptedNotice(match)
    : workerAcceptedNotice(match);
  await ctx.reply(text, {
    attachments: [{ type: 'inline_keyboard', payload: { buttons: matchNavButtons(match, userId) } }]
  });
}

async function showApprovedWorkerAnketa(ctx, userId, matchId) {
  const match = dbOperations.decorateMatch(dbOperations.getMatchById(matchId));
  if (!match) {
    await ctx.reply('Отклик не найден.');
    return;
  }
  if (Number(userId) !== Number(match.employer_id)) {
    await ctx.reply('Полную анкету соискателя может открыть работодатель.');
    return;
  }
  if (match.status !== 'accepted') {
    await ctx.reply('Полную анкету можно открыть после одобрения отклика.');
    return;
  }
  const worker = match.worker || dbOperations.getWorkerProfile(match.worker_id);
  if (!worker) {
    await ctx.reply('Анкета работника не найдена.');
    return;
  }
  await replyWithPhoto(ctx, formatWorkerCardText(worker, 0, 1, userId), {
    attachments: [{
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [{ type: 'callback', text: 'Контакты', payload: `mc_${match.id}` }],
          [{ type: 'callback', text: 'К отклику', payload: `mv_${match.id}` }],
          [{ type: 'callback', text: 'К откликам', payload: 'my_matches' }]
        ]
      }
    }]
  }, worker.photo, worker.user_id);
}

async function handleMatchDecision(ctx, userId, matchId, accept) {
  const result = dbOperations.setMatchStatus(matchId, accept ? 'accepted' : 'declined', userId);
  try {
    if (!result.ok) {
      if (accept && result.match?.status === 'accepted') {
        await deliverAcceptedContacts(ctx, userId, result.match);
      } else {
        await ctx.reply(result.error || 'Не получилось обработать отклик.');
      }
      return;
    }
    const match = dbOperations.decorateMatch(result.match);
    if (accept) {
      await deliverAcceptedContacts(ctx, userId, match);
      return;
    }
    await ctx.reply('Отклик отклонён. Контакты не открывались.');
    const otherId = Number(userId) === Number(match.worker_id) ? match.employer_id : match.worker_id;
    await notifyUser(ctx.api, otherId, `❌ Ваш отклик «${match.vacancy?.job_title || 'вакансия'}» отклонили.`);
  } finally {
    await replyRoleMenu(ctx, userId);
  }
}

async function handleCancelAcceptedMatch(ctx, userId, matchId) {
  const result = dbOperations.cancelAcceptedMatch(matchId, userId);
  try {
    if (!result.ok) {
      await ctx.reply(result.error || 'Не получилось отменить одобрение.');
      return;
    }
    const match = dbOperations.decorateMatch(result.match);
    const job = match.vacancy?.job_title || 'вакансия';
    await ctx.reply(`Одобрение отклика «${job}» отменено. Контакты снова скрыты.`);
    const otherId = Number(userId) === Number(match.worker_id) ? match.employer_id : match.worker_id;
    await notifyUser(ctx.api, otherId, `⚠️ Вторая сторона отменила одобрение отклика «${job}». Контакты больше не открыты.`);
  } finally {
    await replyRoleMenu(ctx, userId);
  }
}

async function showCompanyStaff(ctx, userId) {
  const list = dbOperations.getCompanyStaff(userId);
  const company = dbOperations.getEmployerProfile(userId)?.company_name || 'компании';
  if (!list.length) {
    await ctx.reply(`В штате «${company}» пока никого нет. Сотрудник появится здесь после принятия отклика или приглашения.`, {
      attachments: [{
        type: 'inline_keyboard',
        payload: { buttons: [[{ type: 'callback', text: 'К откликам', payload: 'my_matches' }, { type: 'callback', text: 'В меню', payload: 'back_to_menu' }]] }
      }]
    });
    return;
  }
  userStates.set(`${userId}_staff_list`, list);
  const buttons = list.slice(0, 8).map((row, i) => ([{
    type: 'callback',
    text: `${i + 1}. ${(row.worker?.full_name || 'сотрудник').slice(0, 24)}`,
    payload: `sf_${row.id}`
  }]));
  await ctx.reply(
    `👥 Кадры «${company}»\nВ штате: ${list.length}\n\n` +
    list.slice(0, 8).map((row, i) => formatStaffListItem(row, i)).join('\n\n'),
    {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [
            ...buttons,
            [{ type: 'callback', text: 'В меню', payload: 'back_to_menu' }]
          ]
        }
      }]
    }
  );
}

async function showStaffCard(ctx, userId, staffId) {
  const row = dbOperations.getStaffById(staffId);
  if (!row || Number(row.employer_id) !== Number(userId) || row.status !== 'active') {
    await ctx.reply('Сотрудник не найден в штате.');
    return;
  }
  await ctx.reply(formatStaffCard(row), {
    attachments: [{
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [
            { type: 'callback', text: 'Стажировка', payload: `sfi_${row.id}` },
            { type: 'callback', text: 'Обучение', payload: `sft_${row.id}` }
          ],
          [{ type: 'callback', text: 'Полная анкета', payload: `ma_${row.match_id}` }],
          [{ type: 'callback', text: 'К кадрам', payload: 'company_staff' }]
        ]
      }
    }]
  });
}

async function startStaffDevelopmentOffer(ctx, userId, staffId, kind) {
  const row = dbOperations.getStaffById(staffId);
  if (!row || Number(row.employer_id) !== Number(userId) || row.status !== 'active') {
    await ctx.reply('Сотрудник не найден в штате.');
    return;
  }
  userStates.set(userId, 'staff_offering');
  userStates.set(`${userId}_staff_offer`, { staffId, kind });
  const label = developmentKindLabel(kind);
  await ctx.reply(`Опишите предложение (${label}) для ${row.worker?.full_name || 'сотрудника'}. Или отправьте «-», чтобы оставить стандартную формулировку.`);
}

async function finishStaffDevelopmentOffer(ctx, userId, text) {
  const draft = userStates.get(`${userId}_staff_offer`);
  userStates.delete(userId);
  userStates.delete(`${userId}_staff_offer`);
  if (!draft) {
    await ctx.reply('Предложение не найдено.');
    return;
  }
  const title = (!text || text === '-') ? '' : text;
  const created = dbOperations.createDevOffer({
    staffId: draft.staffId,
    kind: draft.kind,
    title,
    actorId: userId
  });
  if (!created.ok) {
    await ctx.reply(created.error || 'Не получилось отправить предложение.');
    await showStaffCard(ctx, userId, draft.staffId);
    return;
  }
  await notifyUser(
    ctx.api,
    created.offer.worker_id,
    developmentOfferNotice(created.offer, created.staff),
    developmentActionKeyboard(created.offer.id)
  );
  await ctx.reply(`Предложение «${developmentKindLabel(created.offer.kind)}» отправлено ${created.staff.worker?.full_name || 'сотруднику'}.`);
  await showStaffCard(ctx, userId, draft.staffId);
}

async function showMyWork(ctx, userId) {
  const jobs = dbOperations.getWorkerEmployment(userId);
  const offers = dbOperations.getWorkerDevOffers(userId).filter((o) => o.status === 'pending');
  if (!jobs.length) {
    await ctx.reply('Вы ещё не числитесь в штате компании. Это появится, когда работодатель примет ваш отклик или вы примете приглашение.', {
      attachments: [{
        type: 'inline_keyboard',
        payload: { buttons: [[{ type: 'callback', text: 'В меню', payload: 'back_to_menu' }]] }
      }]
    });
    return;
  }
  const offerButtons = offers.slice(0, 6).map((o) => ([{
    type: 'callback',
    text: `${developmentKindLabel(o.kind)}: ответить`,
    payload: `sfv_${o.id}`
  }]));
  await ctx.reply(
    jobs.map(formatEmploymentCard).join('\n\n') +
    (offers.length ? `\n\nОткрытые предложения: ${offers.length}` : ''),
    {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [
            ...offerButtons,
            [{ type: 'callback', text: 'В меню', payload: 'back_to_menu' }]
          ]
        }
      }]
    }
  );
}

async function showWorkerDevOffer(ctx, userId, offerId) {
  const offer = dbOperations.getDevOfferById(offerId);
  if (!offer || Number(offer.worker_id) !== Number(userId)) {
    await ctx.reply('Предложение не найдено.');
    return;
  }
  const staff = dbOperations.getStaffById(offer.staff_id);
  await ctx.reply(developmentOfferNotice(offer, staff), offer.status === 'pending' ? developmentActionKeyboard(offer.id) : undefined);
}

async function handleDevOfferDecision(ctx, userId, offerId, accept) {
  const result = dbOperations.setDevOfferStatus(offerId, accept ? 'accepted' : 'declined', userId);
  if (!result.ok) {
    await ctx.reply(result.error || 'Не получилось ответить.');
    return;
  }
  const kind = developmentKindLabel(result.offer.kind);
  await ctx.reply(accept ? `Вы приняли предложение: ${kind}.` : `Вы отклонили предложение: ${kind}.`);
  const companyName = result.staff?.employer?.company_name || 'компании';
  await notifyUser(
    ctx.api,
    result.offer.employer_id,
    accept
      ? `✅ ${result.staff?.worker?.full_name || 'Сотрудник'} принял ${kind} в «${companyName}».`
      : `❌ ${result.staff?.worker?.full_name || 'Сотрудник'} отклонил ${kind}.`
  );
}

function formatVacancyCard(vacancy, index, total) {
  const employer = dbOperations.getEmployerProfile(vacancy.employer_id);
  const company = employer?.company_name || 'Компания не указана';
  return `💼 Вакансия\n\n` +
    `Должность: ${vacancy.job_title}\n` +
    `Компания: ${company}\n` +
    `${employer?.website ? `Сайт: ${employer.website}\n` : ''}` +
    `${publicVerificationLabel(employer)}\n` +
    `Описание: ${vacancy.description}\n` +
    `Требования: ${vacancy.requirements}\n` +
    `Место: ${vacancy.location}\n` +
    `${vacancy.distance_label ? `${vacancy.distance_label}\n` : ''}` +
    `Зарплата: ${vacancy.salary}\n` +
    `Сезонность: ${vacancy.seasonality}\n` +
    `Контакт компании откроется после принятия отклика обеими сторонами.\n\n` +
    `(${index + 1} из ${total})`;
}

function vacancyKeyboard(userId, vacancy, source = 'search') {
  const isFav = dbOperations.isFavorite(userId, vacancy.id);
  const applied = dbOperations.hasApplied(userId, vacancy.id);
  const extraRow = source === 'favorites'
    ? [[{ type: 'callback', text: 'Назад в меню', payload: 'back_to_menu' }]]
    : [[
        { type: 'callback', text: 'Фильтры', payload: 'job_filters' },
        { type: 'callback', text: 'Назад в меню', payload: 'back_to_menu' }
      ]];
  return {
    attachments: [{
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [
            { type: 'callback', text: isFav ? '★ Убрать из избранного' : '⭐ В избранное', payload: 'job_fav' },
            { type: 'callback', text: applied ? '✓ Отклик отправлен' : 'Откликнуться', payload: 'job_apply' }
          ],
          [
            { type: 'callback', text: '◀️ Назад', payload: 'job_prev' },
            { type: 'callback', text: 'Дальше ▶️', payload: 'job_next' }
          ],
          ...extraRow
        ]
      }
    }]
  };
}

async function showCurrentVacancy(ctx, userId) {
  let list = (userStates.get(`${userId}_jobs_list`) || []).filter(v => v.employer_id !== userId);
  userStates.set(`${userId}_jobs_list`, list);
  let index = userStates.get(`${userId}_job_index`) || 0;
  if (index >= list.length) index = 0;
  userStates.set(`${userId}_job_index`, index);
  const source = userStates.get(`${userId}_job_source`) || 'search';
  if (!list.length) {
    const emptyText = source === 'favorites'
      ? 'В избранном пока нет вакансий.'
      : 'Нет вакансий по выбранным фильтрам.';
    await ctx.reply(emptyText, {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [
            [
              { type: 'callback', text: 'Фильтры', payload: 'job_filters' },
              { type: 'callback', text: 'Назад в меню', payload: 'back_to_menu' }
            ]
          ]
        }
      }]
    });
    return;
  }
  const vacancy = list[index];
  await ctx.reply(formatVacancyCard(vacancy, index, list.length), vacancyKeyboard(userId, vacancy, source));
}

function isEmployerRole(userId) {
  return dbOperations.getUser(userId)?.role === 'employer';
}

async function denyEmployerVacancySearch(ctx) {
  await ctx.reply(
    'Работодатель не просматривает ленту вакансий: чужие объявления скрыты, свои — в разделе «Мои вакансии».',
    employerMenuKeyboard(false, ctx.user?.user_id)
  );
}

function startJobSearch(userId) {
  const list = dbOperations.filterVacancies({
    ...searchFilters(userId, getJobFilters(userId)),
    excludeEmployerId: userId
  });
  userStates.set(userId, 'browsing_jobs');
  userStates.set(`${userId}_jobs_list`, list);
  userStates.set(`${userId}_job_index`, 0);
  userStates.set(`${userId}_job_source`, 'search');
  return list;
}

function filtersKeyboard() {
  return {
    attachments: [{
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [
            { type: 'callback', text: 'Сезонность', payload: 'filter_season' },
            { type: 'callback', text: 'Город', payload: 'filter_location' }
          ],
          [
            { type: 'callback', text: 'От города', payload: 'filter_near' }
          ],
          [
            { type: 'callback', text: 'Специальность', payload: 'filter_spec' },
            { type: 'callback', text: 'Сортировка', payload: 'filter_sort' }
          ],
          [
            { type: 'callback', text: 'Сбросить', payload: 'filter_reset' },
            { type: 'callback', text: 'Показать вакансии', payload: 'find_jobs' }
          ],
          [{ type: 'callback', text: 'Назад в меню', payload: 'back_to_menu' }]
        ]
      }
    }]
  };
}

function cityPickKeyboard(backPayload, clearText) {
  const buttons = [];
  const popular = popularCities();
  for (let i = 0; i < popular.length; i += 2) {
    const row = [{ type: 'callback', text: popular[i].name, payload: `popcity_${i}` }];
    if (popular[i + 1]) row.push({ type: 'callback', text: popular[i + 1].name, payload: `popcity_${i + 1}` });
    buttons.push(row);
  }
  buttons.push([{ type: 'callback', text: clearText, payload: 'popcity_clear' }]);
  buttons.push([{ type: 'callback', text: 'Назад', payload: backPayload }]);
  return {
    attachments: [{
      type: 'inline_keyboard',
      payload: { buttons }
    }]
  };
}

async function askCity(ctx, userId, mode) {
  userStates.set(userId, mode);
  userStates.set(`${userId}_city_mode`, mode);
  const worker = mode.startsWith('worker');
  const near = mode.endsWith('near');
  await ctx.reply(
    near
      ? 'От какого города считать удалённость? Напишите город России или выберите из списка.'
      : 'Какой город России оставить в фильтре? Напишите название или выберите из списка.',
    cityPickKeyboard(worker ? 'worker_filters' : 'job_filters', near ? 'Как в профиле' : 'Все города')
  );
}

function applyChosenCity(userId, mode, cityName) {
  if (mode === 'job_city' || mode === 'job_near') {
    const filters = getJobFilters(userId);
    if (mode === 'job_city') filters.location = cityName;
    else filters.near = cityName;
    setJobFilters(userId, filters);
    return 'jobs';
  }
  const filters = getWorkerFilters(userId);
  if (mode === 'worker_city') filters.city = cityName;
  else filters.near = cityName;
  setWorkerFilters(userId, filters);
  return 'workers';
}

async function finishCityPick(ctx, userId, mode, cityName) {
  const kind = applyChosenCity(userId, mode, cityName);
  userStates.set(userId, kind === 'jobs' ? 'browsing_jobs' : 'browsing_workers');
  if (kind === 'jobs') await showFiltersMenu(ctx, userId);
  else await showWorkerFiltersMenu(ctx, userId);
}

async function acceptCityText(ctx, userId, mode, text) {
  const parsed = interpretCity(text);
  if (!parsed.ok && parsed.choices) {
    userStates.set(`${userId}_city_choices`, parsed.choices.map((city) => city.name));
    await ctx.reply('Уточните город:', {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [
            ...parsed.choices.map((city, i) => ([{ type: 'callback', text: city.name, payload: `cityhit_${i}` }])),
            [{ type: 'callback', text: 'Назад', payload: mode.startsWith('worker') ? 'worker_filters' : 'job_filters' }]
          ]
        }
      }]
    });
    return;
  }
  if (!parsed.ok) {
    await ctx.reply(parsed.error);
    return;
  }
  await finishCityPick(ctx, userId, mode, parsed.city?.name || null);
}

async function showFiltersMenu(ctx, userId) {
  const filters = getJobFilters(userId);
  await ctx.reply(`🔎 Фильтры поиска\n\n${formatFiltersText(filters, userId)}`, filtersKeyboard());
}

function formatOwnVacancyText(vacancy) {
  return `Вакансия:\n` +
    `1. Должность: ${vacancy.job_title}\n` +
    `2. Описание: ${vacancy.description}\n` +
    `3. Требования: ${vacancy.requirements}\n` +
    `4. Город: ${vacancy.location}\n` +
    `5. Зарплата: ${vacancy.salary}\n` +
    `6. Сезонность: ${vacancy.seasonality}\n` +
    `7. Имя сотрудника для связи: ${vacancy.contact_name || '—'}\n` +
    `8. Должность сотрудника: ${vacancy.contact_position || '—'}\n` +
    `9. Телефон сотрудника: ${vacancy.contact_phone || '—'}\n\n` +
    `Напишите номер пункта, чтобы изменить (1-9).`;
}

function ownVacancyButtons(vacancyId) {
  return {
    attachments: [{
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [
            { type: 'callback', text: 'К списку вакансий', payload: 'my_vacancies' },
            { type: 'callback', text: 'Назад в меню', payload: 'back_to_menu' }
          ]
        ]
      }
    }]
  };
}

function seasonalityKeyboard(prefix = 'season') {
  return {
    attachments: [{
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [
            { type: 'callback', text: 'Круглогодично', payload: `${prefix}_year` },
            { type: 'callback', text: 'Весна-осень', payload: `${prefix}_spring` }
          ],
          [
            { type: 'callback', text: 'Лето', payload: `${prefix}_summer` },
            { type: 'callback', text: 'Зима', payload: `${prefix}_winter` }
          ]
        ]
      }
    }]
  };
}

async function showMyVacancies(ctx, userId) {
  const vacancies = dbOperations.getEmployerVacancies(userId);
  if (vacancies.length === 0) {
    await ctx.reply('Вакансии еще не размещены.', {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [
            [{ type: 'callback', text: 'Разместить вакансию', payload: 'post_vacancy' }],
            [{ type: 'callback', text: 'Назад в меню', payload: 'back_to_menu' }]
          ]
        }
      }]
    });
    return;
  }
  userStates.set(`${userId}_my_vacancies`, vacancies);
  let message = 'Ваши вакансии. Нажмите «Изменить», чтобы отредактировать.\n\n';
  vacancies.forEach((v, i) => {
    message += `${i + 1}. ${v.job_title}\n`;
    message += `   ${v.location} · ${v.salary} · ${v.seasonality}\n\n`;
  });
  const editButtons = vacancies.slice(0, 8).map((v) => ([{
    type: 'callback',
    text: `Изменить: ${String(v.job_title).slice(0, 28)}`,
    payload: `editvac_${v.id}`
  }]));
  await ctx.reply(message, {
    attachments: [{
      type: 'inline_keyboard',
      payload: {
        buttons: [
          ...editButtons,
          [
            { type: 'callback', text: 'Разместить ещё', payload: 'post_vacancy' },
            { type: 'callback', text: 'Назад в меню', payload: 'back_to_menu' }
          ]
        ]
      }
    }]
  });
}

async function showEditVacancy(ctx, userId, vacancy) {
  userStates.set(userId, 'editing_vacancy_choice');
  userStates.set(`${userId}_edit_vacancy_id`, vacancy.id);
  userStates.set(`${userId}_edit_vacancy_data`, { ...vacancy });
  await ctx.reply(formatOwnVacancyText(vacancy), ownVacancyButtons(vacancy.id));
}

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of processedUpdates.entries()) {
    if (now - timestamp > DEDUP_TIMEOUT) {
      processedUpdates.delete(key);
    }
  }
}, 60 * 1000);

const welcomeText = `Привет. Здесь можно найти работу или разместить вакансию.
Нажми «Начать».`;

bot.on('bot_started', async (ctx) => {
  const updateId = `${ctx.update?.update_type}:${ctx.update?.timestamp}:${ctx.user?.user_id}`;
  if (processedUpdates.has(updateId)) return;
  processedUpdates.set(updateId, Date.now());
  
  const userId = ctx.user?.user_id;
  const chatId = ctx.chat_id;
  
  dbOperations.addUser(userId, chatId);
  const user = dbOperations.getUser(userId);
  
  if (user?.role) {
    const roleText = user.role === 'worker' ? 'Работник' : 'Работодатель';
    await ctx.reply(`Добро пожаловать! Ваша роль: ${roleText}`, {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [[
            {
              type: 'callback',
              text: 'Продолжить',
              payload: 'continue_with_role'
            },
            {
              type: 'callback',
              text: 'Сменить роль',
              payload: 'edit_role'
            }
          ]]
        }
      }]
    });
  } else {
    await ctx.reply(welcomeText, {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [[{
              type: 'callback',
              text: 'Начать',
              payload: 'start_action'
            }]]
        }
      }]
    });
  }
});

bot.on('message_callback', async (ctx) => {
  const updateId = ctx.callback?.callback_id ?? `${ctx.update?.update_type}:${ctx.update?.timestamp}:${ctx.user?.user_id}`;
  if (processedUpdates.has(updateId)) {
    console.log(`[DEDUP] Пропущен дубликат callback: ${updateId}`);
    return;
  }
  processedUpdates.set(updateId, Date.now());
  
  const userId = ctx.user?.user_id;
  const payload = ctx.callback?.payload;
  dbOperations.addUser(userId, ctx.chat_id);
  
  console.log(`[CALLBACK] User: ${userId}, Payload: ${payload}, UpdateId: ${updateId}`);
  
  if (payload === 'start_action') {
    clearFillSession(userId);
    await ctx.reply('Выберите вашу роль:');
    await ctx.reply('Кто вы?', {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [[
            {
              type: 'callback',
              text: 'Работодатель',
              payload: 'employer'
            },
            {
              type: 'callback',
              text: 'Работник',
              payload: 'worker'
            }
          ]]
        }
      }]
    });
    return;
  }
  
  if (payload === 'create_profile') {
    clearFillSession(userId);
    if (!(await startProfileCreation(ctx, userId))) await replyRoleMenu(ctx, userId, 'Профиль уже создан.');
    return;
  }

  if (payload === 'continue_with_role') {
    const user = dbOperations.getUser(userId);
    if (user?.role === 'worker') {
      await ctx.reply('Что вы хотите сделать?', workerMenuKeyboard(true, userId));
    } else if (user?.role === 'employer') {
      if (await maybeOfferIncompleteVacancy(ctx, userId)) return;
      await ctx.reply('Что вы хотите сделать?', employerMenuKeyboard(true, userId));
    }
    return;
  }

  if (payload === 'resume_profile') {
    await resumeProfileFill(ctx, userId);
    return;
  }

  if (payload === 'restart_profile') {
    await restartProfileFill(ctx, userId);
    return;
  }

  if (payload === 'cancel_fill') {
    await cancelProfileFill(ctx, userId);
    return;
  }

  if (payload === 'employer') {
    dbOperations.updateUserRole(userId, 'employer');
    clearFillSession(userId);
    await safeReply(ctx, roleWelcomeText('employer', Boolean(dbOperations.getEmployerProfile(userId))), employerMenuKeyboard(true, userId));
    return;
  }
  
  if (payload === 'worker') {
    dbOperations.updateUserRole(userId, 'worker');
    clearFillSession(userId);
    await safeReply(ctx, roleWelcomeText('worker', Boolean(dbOperations.getWorkerProfile(userId))), workerMenuKeyboard(true, userId));
    return;
  }
  
  if (payload === 'edit_role') {
    await ctx.reply('Вы хотите сменить роль?', {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [[
            {
              type: 'callback',
              text: 'Оставить',
              payload: 'keep_role'
            },
            {
              type: 'callback',
              text: 'Сменить',
              payload: 'change_role'
            }
          ]]
        }
      }]
    });
    return;
  }
  
  if (payload === 'keep_role') {
    const user = dbOperations.getUser(userId);
    if (user?.role === 'worker') await ctx.reply('Роль сохранена.', workerMenuKeyboard(false, userId));
    else if (user?.role === 'employer') {
      if (await maybeOfferIncompleteVacancy(ctx, userId)) return;
      await ctx.reply('Роль сохранена.', employerMenuKeyboard(false, userId));
    }
    else await ctx.reply('Роль сохранена.');
    return;
  }
  
  if (payload === 'switch_profile' || payload === 'change_role') {
    clearFillSession(userId);
    await ctx.reply('Выберите новую роль. Черновик текущей анкеты сохранён, его можно продолжить позже.', {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [[
            {
              type: 'callback',
              text: 'Работодатель',
              payload: 'employer_change'
            },
            {
              type: 'callback',
              text: 'Работник',
              payload: 'worker_change'
            }
          ]]
        }
      }]
    });
    return;
  }
  
  if (payload === 'employer_change') {
    clearFillSession(userId);
    const existingEmployerProfile = dbOperations.getEmployerProfile(userId);
    if (existingEmployerProfile) {
      await ctx.reply('У вас уже есть профиль работодателя. Что вы хотите сделать?', {
        attachments: [{
          type: 'inline_keyboard',
          payload: {
            buttons: [[
              {
                type: 'callback',
                text: 'Использовать существующий',
                payload: 'use_existing_employer'
              },
              {
                type: 'callback',
                text: 'Создать новый',
                payload: 'create_new_employer'
              }
            ]]
          }
        }]
      });
    } else {
      dbOperations.updateUserRole(userId, 'employer');
      clearFillSession(userId);
      await ctx.reply(roleWelcomeText('employer', false), employerMenuKeyboard(true, userId));
    }
    return;
  }
  
  if (payload === 'worker_change') {
    clearFillSession(userId);
    const existingWorkerProfile = dbOperations.getWorkerProfile(userId);
    if (existingWorkerProfile) {
      await ctx.reply('У вас уже есть профиль работника. Что вы хотите сделать?', {
        attachments: [{
          type: 'inline_keyboard',
          payload: {
            buttons: [[
              {
                type: 'callback',
                text: 'Использовать существующий',
                payload: 'use_existing_worker'
              },
              {
                type: 'callback',
                text: 'Создать новый',
                payload: 'create_new_worker'
              }
            ]]
          }
        }]
      });
    } else {
      dbOperations.updateUserRole(userId, 'worker');
      clearFillSession(userId);
      await ctx.reply(roleWelcomeText('worker', false), workerMenuKeyboard(true, userId));
    }
    return;
  }
  
  if (payload === 'use_existing_employer') {
    clearFillSession(userId);
    dbOperations.updateUserRole(userId, 'employer');
    await ctx.reply('Роль изменена на работодателя. Что вы хотите сделать?', employerMenuKeyboard(true, userId));
    return;
  }
  
  if (payload === 'use_existing_worker') {
    clearFillSession(userId);
    dbOperations.updateUserRole(userId, 'worker');
    await ctx.reply('Роль изменена на работника. Что вы хотите сделать?', workerMenuKeyboard(true, userId));
    return;
  }
  
  if (payload === 'create_new_employer') {
    await restartProfileFill(ctx, userId, 'employer');
    return;
  }
  
  if (payload === 'create_new_worker') {
    await restartProfileFill(ctx, userId, 'worker');
    return;
  }
  
  if (payload === 'post_vacancy') {
    if (await denyUnverifiedVacancy(ctx, userId)) return;
    if (await maybeOfferIncompleteVacancy(ctx, userId)) return;
    await startVacancyFill(ctx, userId, true);
    return;
  }

  if (payload === 'resume_vacancy') {
    await resumeVacancyFill(ctx, userId);
    return;
  }

  if (payload === 'restart_vacancy') {
    await startVacancyFill(ctx, userId, true);
    return;
  }

  if (payload === 'cancel_vacancy_fill') {
    await cancelVacancyFill(ctx, userId);
    return;
  }

  if (payload === 'verify_egrul') {
    const profile = dbOperations.getEmployerProfile(userId);
    if (!profile) {
      await askToCreateProfile(ctx, userId, 'пройти проверку ЕГРЮЛ/ЕГРИП');
      return;
    }
    if (!profile.inn || !profile.director_fio || !profile.legal_address) {
      await ctx.reply('Для проверки нужны ИНН, ФИО руководителя и юридический адрес. Откройте профиль компании и заполните пункты 4–6.');
      return;
    }
    await ctx.reply('Сверяем данные с ЕГРЮЛ/ЕГРИП ФНС…');
    const result = await verifyAndStoreEmployer(userId);
    if (result.ok) {
      const reg = result.registry === 'egrip' ? 'ЕГРИП' : 'ЕГРЮЛ';
      await ctx.reply(`✅ Компания подтверждена по ${reg}.\n${result.fetched_name || ''}\nМожно размещать вакансии.`);
    } else {
      await ctx.reply(`❌ Проверка не пройдена — компания не подтверждена.\n${result.error || 'ФИО руководителя или юридический адрес не совпали с реестром.'}\nВ ваших вакансиях соискатели видят пометку «Компания не подтверждена».`);
    }
    return;
  }
  
  if (payload === 'find_jobs') {
    if (isEmployerRole(userId)) {
      await denyEmployerVacancySearch(ctx);
      return;
    }
    const filters = getJobFilters(userId);
    if (!distanceReady(userId, filters)) {
      await ctx.reply('Чтобы сортировать по удалённости, укажите город России: кнопка «От города». Если город есть в анкете, он подставится сам.');
      await askCity(ctx, userId, 'job_near');
      return;
    }
    const list = startJobSearch(userId);
    if (list.length === 0) {
      await ctx.reply('Нет доступных вакансий по выбранным фильтрам.', {
        attachments: [{
          type: 'inline_keyboard',
          payload: {
            buttons: [
              [
                { type: 'callback', text: 'Фильтры', payload: 'job_filters' },
                { type: 'callback', text: 'Назад в меню', payload: 'back_to_menu' }
              ]
            ]
          }
        }]
      });
      return;
    }
    await showCurrentVacancy(ctx, userId);
    return;
  }

  if (payload === 'view_favorites') {
    if (isEmployerRole(userId)) {
      await denyEmployerVacancySearch(ctx);
      return;
    }
    const list = dbOperations.getFavoriteVacancies(userId);
    userStates.set(userId, 'browsing_jobs');
    userStates.set(`${userId}_jobs_list`, list);
    userStates.set(`${userId}_job_index`, 0);
    userStates.set(`${userId}_job_source`, 'favorites');
    if (list.length === 0) {
      await ctx.reply('В избранном пока нет вакансий.', {
        attachments: [{
          type: 'inline_keyboard',
          payload: {
            buttons: [[{
              type: 'callback',
              text: 'Найти работу',
              payload: 'find_jobs'
            }, {
              type: 'callback',
              text: 'Назад в меню',
              payload: 'back_to_menu'
            }]]
          }
        }]
      });
      return;
    }
    await showCurrentVacancy(ctx, userId);
    return;
  }

  if (payload === 'job_next' || payload === 'job_prev') {
    if (isEmployerRole(userId)) {
      await denyEmployerVacancySearch(ctx);
      return;
    }
    const list = userStates.get(`${userId}_jobs_list`);
    let currentIndex = userStates.get(`${userId}_job_index`) || 0;
    if (!list || list.length === 0) {
      await ctx.reply('Нет доступных вакансий.');
      return;
    }
    if (payload === 'job_next') {
      currentIndex = (currentIndex + 1) % list.length;
    } else {
      currentIndex = (currentIndex - 1 + list.length) % list.length;
    }
    userStates.set(`${userId}_job_index`, currentIndex);
    await showCurrentVacancy(ctx, userId);
    return;
  }

  if (payload === 'job_fav') {
    if (isEmployerRole(userId)) {
      await denyEmployerVacancySearch(ctx);
      return;
    }
    const list = userStates.get(`${userId}_jobs_list`) || [];
    const index = userStates.get(`${userId}_job_index`) || 0;
    const vacancy = list[index];
    if (!vacancy) {
      await ctx.reply('Вакансия не найдена.');
      return;
    }
    const added = dbOperations.toggleFavorite(userId, vacancy.id);
    const source = userStates.get(`${userId}_job_source`);
    if (source === 'favorites' && !added) {
      const updated = dbOperations.getFavoriteVacancies(userId);
      userStates.set(`${userId}_jobs_list`, updated);
      userStates.set(`${userId}_job_index`, Math.min(index, Math.max(updated.length - 1, 0)));
    }
    await ctx.reply(added ? '⭐ Вакансия добавлена в избранное.' : 'Вакансия удалена из избранного.');
    await showCurrentVacancy(ctx, userId);
    return;
  }

  if (payload === 'job_apply') {
    if (isEmployerRole(userId)) {
      await denyEmployerVacancySearch(ctx);
      return;
    }
    const list = userStates.get(`${userId}_jobs_list`) || [];
    const index = userStates.get(`${userId}_job_index`) || 0;
    const vacancy = list[index];
    if (!vacancy) {
      await ctx.reply('Вакансия не найдена.');
      return;
    }
    if (vacancy.employer_id === userId) {
      startJobSearch(userId);
      await showCurrentVacancy(ctx, userId);
      return;
    }
    if (!dbOperations.getWorkerProfile(userId)) {
      await askToCreateProfile(ctx, userId, 'откликнуться на вакансию');
      return;
    }
    if (dbOperations.hasApplied(userId, vacancy.id)) {
      await ctx.reply('Вы уже откликались на эту вакансию. Смотрите раздел «Отклики».');
      await showCurrentVacancy(ctx, userId);
      return;
    }
    const created = dbOperations.addApplication(userId, vacancy.id);
    if (!created?.ok) {
      await ctx.reply('Вы уже откликались на эту вакансию.');
      await showCurrentVacancy(ctx, userId);
      return;
    }
    const match = dbOperations.decorateMatch(created.match);
    try {
      await sendToUserWithPhoto(ctx.api, vacancy.employer_id, incomingMatchText(match), matchActionKeyboard(match.id), dbOperations.getWorkerProfile(userId)?.photo, userId);
      await ctx.reply('✅ Отклик отправлен работодателю. Когда он примет его, вы оба получите контакты.');
    } catch (err) {
      console.error('Ошибка отправки отклика:', err);
      await ctx.reply('Не удалось отправить отклик работодателю. Попробуйте позже.');
    }
    await showCurrentVacancy(ctx, userId);
    return;
  }

  if (payload === 'job_filters') {
    if (isEmployerRole(userId)) {
      await denyEmployerVacancySearch(ctx);
      return;
    }
    await showFiltersMenu(ctx, userId);
    return;
  }

  if (payload === 'filter_season') {
    await ctx.reply('Выберите сезонность:', {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [
            [
              { type: 'callback', text: 'Все', payload: 'filter_season_all' },
              { type: 'callback', text: 'Круглогодично', payload: 'filter_season_year' }
            ],
            [
              { type: 'callback', text: 'Весна-осень', payload: 'filter_season_spring' },
              { type: 'callback', text: 'Лето', payload: 'filter_season_summer' }
            ],
            [
              { type: 'callback', text: 'Зима', payload: 'filter_season_winter' }
            ],
            [{ type: 'callback', text: 'Назад к фильтрам', payload: 'job_filters' }]
          ]
        }
      }]
    });
    return;
  }

  if (payload === 'filter_season_all' || payload === 'filter_season_year' || payload === 'filter_season_spring' || payload === 'filter_season_summer' || payload === 'filter_season_winter') {
    const seasonMap = {
      filter_season_all: null,
      filter_season_year: 'Круглогодично',
      filter_season_spring: 'Весна-осень',
      filter_season_summer: 'Лето',
      filter_season_winter: 'Зима'
    };
    const filters = getJobFilters(userId);
    filters.seasonality = seasonMap[payload];
    setJobFilters(userId, filters);
    await showFiltersMenu(ctx, userId);
    return;
  }

  if (payload === 'filter_location') {
    await askCity(ctx, userId, 'job_city');
    return;
  }

  if (payload === 'filter_near') {
    await askCity(ctx, userId, 'job_near');
    return;
  }

  if (payload === 'popcity_clear' || /^popcity_\d+$/.test(payload || '') || /^cityhit_\d+$/.test(payload || '')) {
    const mode = userStates.get(`${userId}_city_mode`);
    if (!mode) {
      await ctx.reply('Откройте фильтры ещё раз и выберите город.');
      return;
    }
    if (payload === 'popcity_clear') {
      await finishCityPick(ctx, userId, mode, null);
      return;
    }
    if (payload.startsWith('popcity_')) {
      const city = popularCities()[Number(payload.replace('popcity_', ''))];
      if (!city) return;
      await finishCityPick(ctx, userId, mode, city.name);
      return;
    }
    const choices = userStates.get(`${userId}_city_choices`) || [];
    const name = choices[Number(payload.replace('cityhit_', ''))];
    if (!name) return;
    await finishCityPick(ctx, userId, mode, name);
    return;
  }

  if (payload === 'filter_spec') {
    userStates.set(userId, 'job_filter_spec');
    await ctx.reply('Напишите специальность или ключевое слово для поиска.\nЧтобы сбросить, отправьте «-».');
    return;
  }

  if (payload === 'filter_sort') {
    await ctx.reply('Как сортировать вакансии?', {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [
            [
              { type: 'callback', text: 'Сначала новые', payload: 'filter_sort_new' },
              { type: 'callback', text: 'По зарплате', payload: 'filter_sort_salary' }
            ],
            [
              { type: 'callback', text: 'По названию', payload: 'filter_sort_title' },
              { type: 'callback', text: 'По удалённости', payload: 'filter_sort_distance' }
            ],
            [{ type: 'callback', text: 'Назад к фильтрам', payload: 'job_filters' }]
          ]
        }
      }]
    });
    return;
  }

  if (payload === 'filter_sort_new' || payload === 'filter_sort_salary' || payload === 'filter_sort_title' || payload === 'filter_sort_distance') {
    const sortMap = {
      filter_sort_new: 'new',
      filter_sort_salary: 'salary',
      filter_sort_title: 'title',
      filter_sort_distance: 'distance'
    };
    const filters = getJobFilters(userId);
    filters.sort = sortMap[payload];
    setJobFilters(userId, filters);
    if (filters.sort === 'distance' && !distanceReady(userId, filters)) {
      await ctx.reply('Город для расстояния не найден в профиле. Выберите, откуда считать.');
      await askCity(ctx, userId, 'job_near');
      return;
    }
    await showFiltersMenu(ctx, userId);
    return;
  }

  if (payload === 'filter_reset') {
    setJobFilters(userId, { seasonality: null, location: null, keyword: null, sort: 'new', near: null });
    await showFiltersMenu(ctx, userId);
    return;
  }
  
  if (payload === 'view_profile') {
    if (!dbOperations.getWorkerProfile(userId)) {
      await ctx.reply('Анкеты пока нет. Создайте её, чтобы откликаться на вакансии и получать приглашения.', createProfileKeyboard('worker'));
      return;
    }
    await showOwnProfile(ctx, userId);
    return;
  }

  if (payload === 'replace_photo') {
    const profile = dbOperations.getWorkerProfile(userId);
    if (!profile) {
      await ctx.reply('Профиль не найден.');
      return;
    }
    userStates.set(`${userId}_edit_data`, { ...profile });
    userStates.set(userId, 'edit_field_10');
    await ctx.reply(FACE_PHOTO_PROMPT, skipPhotoKeyboard());
    return;
  }
  
  if (payload === 'activate_profile') {
    const profile = dbOperations.getWorkerProfile(userId);
    if (!profile) {
      await ctx.reply('Профиль не найден.');
      return;
    }
    
    dbOperations.toggleWorkerProfileStatus(userId, true);
    await ctx.reply('✅ Ваша анкета активирована! Работодатели смогут вас найти.');
    await ctx.reply('Что вы хотите сделать?', {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [[
            {
              type: 'callback',
              text: 'Найти работу',
              payload: 'find_jobs'
            },
            {
              type: 'callback',
              text: 'Изменить анкету',
              payload: 'edit_profile'
            },
            {
              type: 'callback',
              text: 'Скрыть профиль',
              payload: 'stop_profile'
            }
          ]]
        }
      }]
    });
    return;
  }
  
  if (payload === 'my_vacancies') {
    await showMyVacancies(ctx, userId);
    return;
  }

  if (/^editvac_\d+$/.test(payload || '')) {
    const vacancyId = Number(payload.replace('editvac_', ''));
    const vacancy = dbOperations.getVacancyById(vacancyId);
    if (!vacancy || vacancy.employer_id !== userId) {
      await ctx.reply('Вакансия не найдена.');
      return;
    }
    await showEditVacancy(ctx, userId, vacancy);
    return;
  }
  
  if (payload === 'view_employer_profile') {
    const profile = dbOperations.getEmployerProfile(userId);
    if (!profile) {
      await ctx.reply('Профиля компании пока нет. Создайте его, чтобы размещать вакансии и приглашать работников.', createProfileKeyboard('employer'));
      return;
    }
    
    await ctx.reply(formatEmployerProfileText(profile), employerProfileButtons());
    userStates.set(userId, 'editing_employer_profile_choice');
    return;
  }
  
  if (payload === 'edit_profile') {
    await showOwnProfile(ctx, userId);
    return;
  }
  
  if (payload === 'stop_profile') {
    const profile = dbOperations.getWorkerProfile(userId);
    if (!profile) {
      await ctx.reply('Профиль не найден.');
      return;
    }
    
    dbOperations.toggleWorkerProfileStatus(userId, false);
    await ctx.reply('✅ Ваша анкета скрыта. Работодатели не смогут вас найти.');
    await ctx.reply('Что вы хотите сделать?', {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [[
            {
              type: 'callback',
              text: 'Включить профиль',
              payload: 'activate_profile'
            },
            {
              type: 'callback',
              text: 'Изменить анкету',
              payload: 'edit_profile'
            }
          ]]
        }
      }]
    });
    return;
  }
  
  if (payload === 'browse_workers') {
    setWorkerFilters(userId, emptyWorkerFilters());
    const list = startWorkerSearch(userId);
    if (list.length === 0) {
      await ctx.reply('😔 Активных анкет работников не найдено.', {
        attachments: [{
          type: 'inline_keyboard',
          payload: {
            buttons: [[{
              type: 'callback',
              text: 'Назад в меню',
              payload: 'back_to_menu'
            }]]
          }
        }]
      });
      return;
    }
    const recommendedCount = list.filter(w => w.recommended).length;
    await ctx.reply(`Все анкеты: ${list.length}${recommendedCount ? `. Рекомендуемых под ваши вакансии: ${recommendedCount}` : ''}. Дальше можно сузить фильтрами.`);
    await showCurrentWorker(ctx, userId);
    return;
  }

  if (payload === 'search_workers' || payload === 'worker_filters') {
    userStates.set(userId, 'browsing_workers');
    await showWorkerFiltersMenu(ctx, userId);
    return;
  }

  if (payload === 'wfilter_apply') {
    const filters = getWorkerFilters(userId);
    if (!distanceReady(userId, filters)) {
      await ctx.reply('Чтобы сортировать по удалённости, укажите город России: кнопка «От города».');
      await askCity(ctx, userId, 'worker_near');
      return;
    }
    const list = startWorkerSearch(userId);
    const active = filters.specialization || filters.city || filters.near || filters.sort === 'distance' || filters.ageMin != null || filters.ageMax != null || filters.skills || filters.gosuslugi || filters.recommended;
    if (list.length === 0) {
      await ctx.reply('По выбранным фильтрам анкет нет.', {
        attachments: [{
          type: 'inline_keyboard',
          payload: {
            buttons: [
              [
                { type: 'callback', text: 'Все анкеты', payload: 'browse_workers' },
                { type: 'callback', text: 'Фильтры', payload: 'worker_filters' }
              ]
            ]
          }
        }]
      });
      return;
    }
    await ctx.reply(active
      ? `Найдено анкет: ${list.length}.\n${formatWorkerFiltersText(filters, userId)}`
      : `Все анкеты: ${list.length}.`);
    await showCurrentWorker(ctx, userId);
    return;
  }

  if (payload === 'wfilter_reset') {
    setWorkerFilters(userId, emptyWorkerFilters());
    await showWorkerFiltersMenu(ctx, userId);
    return;
  }

  if (payload === 'wfilter_gosu') {
    const filters = getWorkerFilters(userId);
    filters.gosuslugi = !filters.gosuslugi;
    setWorkerFilters(userId, filters);
    await showWorkerFiltersMenu(ctx, userId);
    return;
  }

  if (payload === 'wfilter_rec') {
    const filters = getWorkerFilters(userId);
    filters.recommended = !filters.recommended;
    setWorkerFilters(userId, filters);
    await showWorkerFiltersMenu(ctx, userId);
    return;
  }

  if (payload === 'wfilter_spec') {
    const specs = dbOperations.getUniqueSpecializations(userId).slice(0, 8);
    userStates.set(`${userId}_wfilter_specs`, specs);
    const specButtons = specs.map((spec, i) => ([{
      type: 'callback',
      text: spec.slice(0, 32),
      payload: `wspec_${i}`
    }]));
    userStates.set(userId, 'wfilter_asking_spec');
    await ctx.reply('Выберите специальность или напишите свою. Имя в поиске не используется. «-» — сбросить.', {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [
            ...specButtons,
            [{ type: 'callback', text: 'Все специальности', payload: 'wspec_all' }],
            [{ type: 'callback', text: 'Назад к фильтрам', payload: 'worker_filters' }]
          ]
        }
      }]
    });
    return;
  }

  if (payload === 'wspec_all' || /^wspec_\d+$/.test(payload || '')) {
    const filters = getWorkerFilters(userId);
    if (payload === 'wspec_all') {
      filters.specialization = null;
    } else {
      const specs = userStates.get(`${userId}_wfilter_specs`) || [];
      filters.specialization = specs[Number(payload.replace('wspec_', ''))] || filters.specialization;
    }
    setWorkerFilters(userId, filters);
    userStates.set(userId, 'browsing_workers');
    await showWorkerFiltersMenu(ctx, userId);
    return;
  }

  if (payload === 'wfilter_city') {
    await askCity(ctx, userId, 'worker_city');
    return;
  }

  if (payload === 'wfilter_near') {
    await askCity(ctx, userId, 'worker_near');
    return;
  }

  if (payload === 'wfilter_sort_distance') {
    const filters = getWorkerFilters(userId);
    filters.sort = filters.sort === 'distance' ? null : 'distance';
    setWorkerFilters(userId, filters);
    if (filters.sort === 'distance' && !distanceReady(userId, filters)) {
      await ctx.reply('Город для расстояния не найден в профиле. Выберите, откуда считать.');
      await askCity(ctx, userId, 'worker_near');
      return;
    }
    await showWorkerFiltersMenu(ctx, userId);
    return;
  }

  if (payload === 'wfilter_age') {
    await ctx.reply('Возраст кандидата:', {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [
            [{ type: 'callback', text: 'Любой', payload: 'wage_all' }],
            [
              { type: 'callback', text: '14–17', payload: 'wage_14' },
              { type: 'callback', text: '18–24', payload: 'wage_18' }
            ],
            [
              { type: 'callback', text: '25–34', payload: 'wage_25' },
              { type: 'callback', text: '35–44', payload: 'wage_35' }
            ],
            [{ type: 'callback', text: '45+', payload: 'wage_45' }],
            [{ type: 'callback', text: 'Назад к фильтрам', payload: 'worker_filters' }]
          ]
        }
      }]
    });
    return;
  }

  if (/^wage_(all|14|18|25|35|45)$/.test(payload || '')) {
    const filters = getWorkerFilters(userId);
    const ranges = {
      wage_all: { ageMin: null, ageMax: null },
      wage_14: { ageMin: 14, ageMax: 17 },
      wage_18: { ageMin: 18, ageMax: 24 },
      wage_25: { ageMin: 25, ageMax: 34 },
      wage_35: { ageMin: 35, ageMax: 44 },
      wage_45: { ageMin: 45, ageMax: 100 }
    };
    Object.assign(filters, ranges[payload]);
    setWorkerFilters(userId, filters);
    await showWorkerFiltersMenu(ctx, userId);
    return;
  }

  if (payload === 'wfilter_skills') {
    userStates.set(userId, 'wfilter_asking_skills');
    await ctx.reply('Напишите навык или ключевое слово. Имя кандидата в поиске не используется. «-» — сбросить.', {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [[{ type: 'callback', text: 'Назад к фильтрам', payload: 'worker_filters' }]]
        }
      }]
    });
    return;
  }

  if (payload === 'next_worker' || payload === 'prev_worker') {
    const workersList = userStates.get(`${userId}_workers_list`);
    let currentIndex = userStates.get(`${userId}_worker_index`) || 0;
    if (!workersList || workersList.length === 0) {
      await ctx.reply('Нет доступных работников.');
      return;
    }
    if (payload === 'next_worker') {
      currentIndex = (currentIndex + 1) % workersList.length;
    } else {
      currentIndex = (currentIndex - 1 + workersList.length) % workersList.length;
    }
    userStates.set(`${userId}_worker_index`, currentIndex);
    await showCurrentWorker(ctx, userId);
    return;
  }

  if (payload === 'view_labor') {
    const list = userStates.get(`${userId}_workers_list`) || [];
    const index = userStates.get(`${userId}_worker_index`) || 0;
    const current = list[index];
    const worker = current ? dbOperations.getWorkerProfile(current.user_id) || current : null;
    if (!worker) {
      await ctx.reply('Анкета не найдена.');
      return;
    }
    await ctx.reply(formatLaborBook(worker), {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [[{ type: 'callback', text: 'К анкете', payload: 'current_worker' }]]
        }
      }]
    });
    return;
  }

  if (payload === 'current_worker') {
    await showCurrentWorker(ctx, userId);
    return;
  }

  if (payload === 'offer_job') {
    const list = userStates.get(`${userId}_workers_list`) || [];
    const index = userStates.get(`${userId}_worker_index`) || 0;
    const worker = list[index];
    if (!worker) {
      await ctx.reply('Анкета не найдена.');
      return;
    }
    if (!dbOperations.getEmployerProfile(userId)) {
      await askToCreateProfile(ctx, userId, 'пригласить работника');
      return;
    }
    const vacancies = dbOperations.getEmployerVacancies(userId);
    if (vacancies.length === 0) {
      await ctx.reply('Сначала разместите вакансию, чтобы предложить её работнику.', {
        attachments: [{
          type: 'inline_keyboard',
          payload: {
            buttons: [[{ type: 'callback', text: 'Разместить вакансию', payload: 'post_vacancy' }]]
          }
        }]
      });
      return;
    }
    userStates.set(`${userId}_offer_worker_id`, worker.user_id);
    userStates.set(`${userId}_offer_vacancies`, vacancies);
    if (vacancies.length === 1) {
      await sendVacancyOffer(ctx, userId, worker, vacancies[0]);
      return;
    }
    const vacancyButtons = vacancies.slice(0, 8).map((v, i) => ([{
      type: 'callback',
      text: v.job_title,
      payload: `offer_v_${i}`
    }]));
    await ctx.reply(`На какую вакансию откликнуться для ${worker.full_name}?`, {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [
            ...vacancyButtons,
            [{ type: 'callback', text: 'Отмена', payload: 'browse_workers' }]
          ]
        }
      }]
    });
    return;
  }

  if (/^offer_v_\d+$/.test(payload || '')) {
    const vacancies = userStates.get(`${userId}_offer_vacancies`) || [];
    const workerId = userStates.get(`${userId}_offer_worker_id`);
    const vacancy = vacancies[Number(payload.replace('offer_v_', ''))];
    const list = userStates.get(`${userId}_workers_list`) || [];
    const worker = list.find(w => w.user_id === workerId) || dbOperations.getWorkerProfile(workerId);
    if (!vacancy || !worker) {
      await ctx.reply('Не удалось предложить вакансию. Откройте анкету ещё раз.');
      return;
    }
    await sendVacancyOffer(ctx, userId, worker, vacancy);
    return;
  }

  if (payload === 'my_matches') {
    await showMatchesMenu(ctx, userId);
    return;
  }

  if (payload === 'company_staff') {
    await showCompanyStaff(ctx, userId);
    return;
  }

  if (payload === 'my_work') {
    await showMyWork(ctx, userId);
    return;
  }

  if (/^sf_\d+$/.test(payload || '')) {
    await showStaffCard(ctx, userId, Number(payload.replace('sf_', '')));
    return;
  }

  if (/^sfi_\d+$/.test(payload || '')) {
    await startStaffDevelopmentOffer(ctx, userId, Number(payload.replace('sfi_', '')), 'internship');
    return;
  }

  if (/^sft_\d+$/.test(payload || '')) {
    await startStaffDevelopmentOffer(ctx, userId, Number(payload.replace('sft_', '')), 'training');
    return;
  }

  if (/^sfv_\d+$/.test(payload || '')) {
    await showWorkerDevOffer(ctx, userId, Number(payload.replace('sfv_', '')));
    return;
  }

  if (/^dya_\d+$/.test(payload || '')) {
    await handleDevOfferDecision(ctx, userId, Number(payload.replace('dya_', '')), true);
    return;
  }

  if (/^dyn_\d+$/.test(payload || '')) {
    await handleDevOfferDecision(ctx, userId, Number(payload.replace('dyn_', '')), false);
    return;
  }

  if (payload === 'match_in' || payload === 'match_out') {
    await showMatchGroup(ctx, userId, payload === 'match_in' ? 'in' : 'out');
    return;
  }

  if (/^mv_\d+$/.test(payload || '')) {
    await showMatchCard(ctx, userId, Number(payload.replace('mv_', '')));
    return;
  }

  if (/^mc_\d+$/.test(payload || '')) {
    await showMatchContacts(ctx, userId, Number(payload.replace('mc_', '')));
    return;
  }

  if (/^ma_\d+$/.test(payload || '')) {
    await showApprovedWorkerAnketa(ctx, userId, Number(payload.replace('ma_', '')));
    return;
  }

  if (/^acc_\d+$/.test(payload || '')) {
    await handleMatchDecision(ctx, userId, Number(payload.replace('acc_', '')), true);
    return;
  }

  if (/^dec_\d+$/.test(payload || '')) {
    await handleMatchDecision(ctx, userId, Number(payload.replace('dec_', '')), false);
    return;
  }

  if (/^cx_\d+$/.test(payload || '')) {
    await handleCancelAcceptedMatch(ctx, userId, Number(payload.replace('cx_', '')));
    return;
  }

  if (/^app_view_\d+$/.test(payload || '')) {
    const workerId = Number(payload.replace('app_view_', ''));
    const ranked = dbOperations.getRankedWorkers(userId);
    const fromRanked = ranked.find(w => w.user_id === workerId);
    const worker = fromRanked || dbOperations.getWorkerProfile(workerId);
    if (!worker) {
      await ctx.reply('Анкета работника не найдена.');
      return;
    }
    userStates.set(userId, 'browsing_workers');
    userStates.set(`${userId}_workers_list`, [worker]);
    userStates.set(`${userId}_worker_index`, 0);
    await showCurrentWorker(ctx, userId);
    return;
  }

  if (payload === 'skip_website') {
    const state = userStates.get(userId);
    if (state === 'employer_asking_website') {
      const data = userStates.get(`${userId}_data`) || {};
      data.website = '';
      await finishEmployerProfileCreation(ctx, userId, data);
      return;
    }
    if (state === 'edit_employer_field_9') {
      const editData = userStates.get(`${userId}_edit_employer_data`);
      if (editData) {
        editData.website = '';
        saveEmployer(userId, editData);
      }
      userStates.delete(userId);
      userStates.delete(`${userId}_edit_employer_data`);
      await ctx.reply('Сайт убран из профиля.');
      const profile = dbOperations.getEmployerProfile(userId);
      await ctx.reply(formatEmployerProfileText(profile), employerProfileButtons());
      userStates.set(userId, 'editing_employer_profile_choice');
      return;
    }
    return;
  }

  if (payload === 'skip_about') {
    const state = userStates.get(userId);
    if (state === 'worker_asking_about') {
      const data = userStates.get(`${userId}_data`) || {};
      data.about = '';
      setFillState(userId, 'worker_asking_phone', data);
      await ctx.reply('Пункт «О себе» пропущен.');
      await promptProfileStep(ctx, 'worker_asking_phone');
      return;
    }
    if (state === 'edit_field_8') {
      const editData = userStates.get(`${userId}_edit_data`);
      if (editData) {
        editData.about = '';
        saveWorker(userId, editData, editData.photo);
      }
      await ctx.reply('Пункт «О себе» оставлен пустым.');
      await showOwnProfile(ctx, userId);
      return;
    }
    return;
  }

  if (payload === 'skip_photo') {
    const state = userStates.get(userId);
    if (state === 'worker_asking_photo') {
      await finishWorkerProfileCreation(ctx, userId, null);
      return;
    }
    if (state === 'edit_field_10') {
      await finishPhotoEdit(ctx, userId, undefined, true);
      return;
    }
    return;
  }
  
  if (payload === 'season_year' || payload === 'season_spring' || payload === 'season_summer' || payload === 'season_winter') {
    const seasonMap = {
      season_year: 'Круглогодично',
      season_spring: 'Весна-осень',
      season_summer: 'Лето',
      season_winter: 'Зима'
    };
    const seasonality = seasonMap[payload];

    if (userStates.get(userId) === 'edit_vacancy_field_6') {
      const vacancyId = userStates.get(`${userId}_edit_vacancy_id`);
      const updated = dbOperations.updateVacancy(vacancyId, userId, { seasonality });
      if (!updated) {
        await ctx.reply('Не удалось обновить вакансию.');
        return;
      }
      await ctx.reply('✅ Сезонность обновлена!');
      await showEditVacancy(ctx, userId, updated);
      return;
    }
    
    let dataVacancy = userStates.get(`${userId}_data`) || dbOperations.getVacancyDraft(userId)?.data;
    if (!dataVacancy) return;
    
    dataVacancy.seasonality = seasonality;
    setVacancyFillState(userId, 'vacancy_asking_contact_name', dataVacancy);
    await promptVacancyStep(ctx, 'vacancy_asking_contact_name');
    return;
  }
  
  if (payload === 'delete_profile_confirm') {
    await ctx.reply('⚠️ Вы уверены, что хотите удалить свой профиль? Это действие необратимо!', {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [[
            {
              type: 'callback',
              text: 'Да, удалить',
              payload: 'delete_worker_profile_yes'
            },
            {
              type: 'callback',
              text: 'Нет, отменить',
              payload: 'back_to_menu'
            }
          ]]
        }
      }]
    });
    return;
  }
  
  if (payload === 'delete_worker_profile_yes') {
    const deleted = dbOperations.deleteWorkerProfile(userId);
    if (deleted) {
      await ctx.reply('✅ Ваш профиль работника успешно удален.');
      dbOperations.updateUserRole(userId, null);
      await ctx.reply('Что вы хотите сделать?', {
        attachments: [{
          type: 'inline_keyboard',
          payload: {
            buttons: [[
              {
                type: 'callback',
                text: 'Стать работником',
                payload: 'worker'
              },
              {
                type: 'callback',
                text: 'Стать работодателем',
                payload: 'employer'
              }
            ]]
          }
        }]
      });
    } else {
      await ctx.reply('❌ Ошибка при удалении профиля.');
    }
    return;
  }
  
  if (payload === 'delete_employer_profile_confirm') {
    await ctx.reply('⚠️ Вы уверены, что хотите удалить профиль компании? Все связанные вакансии также будут удалены! Это действие необратимо!', {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [[
            {
              type: 'callback',
              text: 'Да, удалить',
              payload: 'delete_employer_profile_yes'
            },
            {
              type: 'callback',
              text: 'Нет, отменить',
              payload: 'back_to_menu'
            }
          ]]
        }
      }]
    });
    return;
  }
  
  if (payload === 'delete_employer_profile_yes') {
    const deleted = dbOperations.deleteEmployerProfile(userId);
    if (deleted) {
      await ctx.reply('✅ Ваш профиль компании и все связанные вакансии успешно удалены.');
      dbOperations.updateUserRole(userId, null);
      await ctx.reply('Что вы хотите сделать?', {
        attachments: [{
          type: 'inline_keyboard',
          payload: {
            buttons: [[
              {
                type: 'callback',
                text: 'Стать работником',
                payload: 'worker'
              },
              {
                type: 'callback',
                text: 'Стать работодателем',
                payload: 'employer'
              }
            ]]
          }
        }]
      });
    } else {
      await ctx.reply('❌ Ошибка при удалении профиля.');
    }
    return;
  }
  
  if (payload === 'back_to_menu') {
    const fillState = userStates.get(userId);
    if (String(fillState || '').startsWith('vacancy_asking')) {
      const data = userStates.get(`${userId}_data`);
      if (data) setVacancyFillState(userId, fillState, data);
      clearFillSession(userId);
    }
    const user = dbOperations.getUser(userId);
    if (user?.role === 'worker') {
      await ctx.reply('Что вы хотите сделать?', workerMenuKeyboard(false, userId));
    } else if (user?.role === 'employer') {
      await ctx.reply('Что вы хотите сделать?', employerMenuKeyboard(false, userId));
    }
    return;
  }
});

bot.on('message_created', async (ctx) => {
  const userId = ctx.user?.user_id;
  const text = ctx.message?.body?.text?.trim() || '';
  dbOperations.addUser(userId, ctx.chat_id);
  const state = userStates.get(userId);
  
  console.log(`[MESSAGE] User: ${userId}, State: ${state}, Text: ${text}`);
  if (state === 'staff_offering') {
    await finishStaffDevelopmentOffer(ctx, userId, text);
    return;
  }
  if (!state) return;

  if (state === 'job_city' || state === 'job_near' || state === 'worker_city' || state === 'worker_near') {
    await acceptCityText(ctx, userId, state, text);
    return;
  }

  if (state === 'wfilter_asking_spec' || state === 'wfilter_asking_skills') {
    const filters = getWorkerFilters(userId);
    const value = (!text || text === '-') ? null : text;
    if (state === 'wfilter_asking_spec') filters.specialization = value;
    if (state === 'wfilter_asking_skills') filters.skills = value;
    setWorkerFilters(userId, filters);
    userStates.set(userId, 'browsing_workers');
    await showWorkerFiltersMenu(ctx, userId);
    return;
  }

  if (state === 'job_filter_spec') {
    const filters = getJobFilters(userId);
    filters.keyword = (!text || text === '-') ? null : text;
    setJobFilters(userId, filters);
    userStates.set(userId, 'browsing_jobs');
    await showFiltersMenu(ctx, userId);
    return;
  }

  if (state === 'searching_workers') {
    userStates.set(userId, 'browsing_workers');
    await showWorkerFiltersMenu(ctx, userId);
    return;
  }

  let data = userStates.get(`${userId}_data`);
  if (!data && (state.includes('worker_asking') || state.includes('employer_asking') || state.includes('vacancy_asking'))) {
    data = state.includes('vacancy_asking')
      ? { ...(dbOperations.getVacancyDraft(userId)?.data || {}) }
      : {};
    userStates.set(`${userId}_data`, data);
  }

  if (String(state).startsWith('vacancy_asking') && isCancelFillText(text)) {
    await cancelVacancyFill(ctx, userId);
    return;
  }

  if ((String(state).startsWith('worker_asking') || String(state).startsWith('employer_asking')) && isCancelFillText(text)) {
    await cancelProfileFill(ctx, userId);
    return;
  }
  
  if (state === 'editing_profile_choice') {
    const choice = parseInt(text);
    const profile = dbOperations.getWorkerProfile(userId);
    if (isNaN(choice) || choice < 1 || choice > 10) {
      await ctx.reply('Пожалуйста, введите число от 1 до 10.');
      return;
    }
    if (!userStates.has(`${userId}_edit_data`)) {
      userStates.set(`${userId}_edit_data`, { ...profile });
    }
    const prompts = {
      1: ['edit_field_1', 'Введите новое имя:'],
      2: ['edit_field_2', 'Введите новый возраст:'],
      3: ['edit_field_3', 'Введите город:'],
      4: ['edit_field_4', 'Введите новую специальность:'],
      5: ['edit_field_5', 'Введите новый опыт работы:'],
      6: ['edit_field_6', 'Введите образование:'],
      7: ['edit_field_7', 'Введите навыки:'],
      8: ['edit_field_8', 'Расскажите о себе или нажмите «Пропустить»:'],
      9: ['edit_field_9', 'Введите реальный телефон: +7 921 123-45-67 или зарубежный, например +375 29 123-45-67:'],
      10: ['edit_field_10', FACE_PHOTO_PROMPT]
    };
    const [nextState, prompt] = prompts[choice];
    userStates.set(userId, nextState);
    await ctx.reply(prompt, choice === 10 ? skipPhotoKeyboard() : choice === 8 ? skipAboutKeyboard() : undefined);
    return;
  }

  if (state === 'edit_field_1' || state === 'edit_field_2' || state === 'edit_field_3' || state === 'edit_field_4' || state === 'edit_field_5' || state === 'edit_field_6' || state === 'edit_field_7' || state === 'edit_field_8' || state === 'edit_field_9') {
    const editData = userStates.get(`${userId}_edit_data`);
    if (state === 'edit_field_2') {
      const age = parseInt(text);
      if (isNaN(age) || age < 14 || age > 100) {
        await ctx.reply('Введите корректный возраст (14-100).');
        return;
      }
      editData.age = age;
    } else if (state === 'edit_field_8') {
      editData.about = isSkipText(text) ? '' : text;
    } else if (state === 'edit_field_9') {
      const phone = validatePhone(text);
      if (!phone.ok) {
        await ctx.reply(phone.error);
        return;
      }
      editData.phone = phone.phone;
    } else if (state === 'edit_field_1') editData.full_name = text;
    else if (state === 'edit_field_3') editData.city = text;
    else if (state === 'edit_field_4') editData.specialization = text;
    else if (state === 'edit_field_5') {
      const experienceText = String(text || '').trim();
      if (!experienceText) {
        await ctx.reply('Напишите опыт работы. Достаточно одного символа.');
        return;
      }
      editData.experience = experienceText;
    }
    else if (state === 'edit_field_6') editData.education = text;
    else if (state === 'edit_field_7') editData.skills = text;
    saveWorker(userId, editData, editData.photo);
    await ctx.reply('✅ Поле обновлено!');
    await showOwnProfile(ctx, userId);
    return;
  }

  if (state === 'edit_field_10') {
    const photo = extractPhotoFromMessage(ctx);
    if (isSkipPhotoText(text)) {
      await finishPhotoEdit(ctx, userId, undefined, true);
      return;
    }
    if (!photo) {
      await ctx.reply('Нужно отправить вертикальное фото лица, а не текст. Или нажмите «Пропустить».', skipPhotoKeyboard());
      return;
    }
    await finishPhotoEdit(ctx, userId, photo, false);
    return;
  }
  
  if (state === 'worker_asking_name') {
    if (!data) return;
    data.fullName = text;
    setFillState(userId, 'worker_asking_age', data);
    await promptProfileStep(ctx, 'worker_asking_age');
    return;
  }
  
  if (state === 'worker_asking_age') {
    const age = parseInt(text);
    if (isNaN(age) || age < 14 || age > 100) {
      await ctx.reply('Введите корректный возраст (14-100).');
      return;
    }
    data.age = age;
    setFillState(userId, 'worker_asking_city', data);
    await promptProfileStep(ctx, 'worker_asking_city');
    return;
  }

  if (state === 'worker_asking_city') {
    data.city = text;
    setFillState(userId, 'worker_asking_spec', data);
    await promptProfileStep(ctx, 'worker_asking_spec');
    return;
  }
  
  if (state === 'worker_asking_spec') {
    data.specialization = text;
    setFillState(userId, 'worker_asking_experience', data);
    await promptProfileStep(ctx, 'worker_asking_experience');
    return;
  }
  
  if (state === 'worker_asking_experience') {
    const experienceText = String(text || '').trim();
    if (!experienceText) {
      await ctx.reply('Напишите опыт работы. Достаточно одного символа.');
      return;
    }
    data.experience = experienceText;
    setFillState(userId, 'worker_asking_education', data);
    await promptProfileStep(ctx, 'worker_asking_education');
    return;
  }

  if (state === 'worker_asking_education') {
    data.education = text;
    setFillState(userId, 'worker_asking_skills', data);
    await promptProfileStep(ctx, 'worker_asking_skills');
    return;
  }

  if (state === 'worker_asking_skills') {
    data.skills = text;
    setFillState(userId, 'worker_asking_about', data);
    await promptProfileStep(ctx, 'worker_asking_about');
    return;
  }

  if (state === 'worker_asking_about') {
    data.about = isSkipText(text) ? '' : text;
    setFillState(userId, 'worker_asking_phone', data);
    await promptProfileStep(ctx, 'worker_asking_phone');
    return;
  }
  
  if (state === 'worker_asking_phone') {
    const phone = validatePhone(text);
    if (!phone.ok) {
      await ctx.reply(phone.error);
      return;
    }
    data.phone = phone.phone;
    setFillState(userId, 'worker_asking_photo', data);
    await promptProfileStep(ctx, 'worker_asking_photo');
    return;
  }
  
  if (state === 'worker_asking_photo') {
    const photo = extractPhotoFromMessage(ctx);
    if (isSkipPhotoText(text)) {
      await finishWorkerProfileCreation(ctx, userId, null);
      return;
    }
    if (!photo) {
      await ctx.reply('Нужно отправить вертикальное фото лица, а не текст. Или нажмите «Пропустить».', fillActionKeyboard('worker_asking_photo'));
      return;
    }
    await finishWorkerProfileCreation(ctx, userId, photo);
    return;
  }
  
  if (state === 'employer_asking_company') {
    data.companyName = text;
    setFillState(userId, 'employer_asking_industry', data);
    await promptProfileStep(ctx, 'employer_asking_industry');
    return;
  }
  
  if (state === 'employer_asking_industry') {
    data.industry = text;
    setFillState(userId, 'employer_asking_desc', data);
    await promptProfileStep(ctx, 'employer_asking_desc');
    return;
  }
  
  if (state === 'employer_asking_desc') {
    const description = String(text || '').trim();
    if (!description) {
      await ctx.reply('Напишите о компании. Достаточно одного символа.');
      return;
    }
    data.description = description;
    setFillState(userId, 'employer_asking_inn', data);
    await promptProfileStep(ctx, 'employer_asking_inn');
    return;
  }

  if (state === 'employer_asking_inn') {
    const inn = text.replace(/\D/g, '');
    if (!isValidInn(inn)) {
      await ctx.reply('Укажите ИНН: 10 цифр для юрлица или 12 для ИП.');
      return;
    }
    data.inn = inn;
    setFillState(userId, 'employer_asking_address', data);
    await promptProfileStep(ctx, 'employer_asking_address');
    return;
  }

  if (state === 'employer_asking_address') {
    data.legalAddress = text;
    setFillState(userId, 'employer_asking_director', data);
    await promptProfileStep(ctx, 'employer_asking_director');
    return;
  }

  if (state === 'employer_asking_director') {
    if (text.trim().split(/\s+/).length < 2) {
      await ctx.reply('Укажите фамилию и имя руководителя полностью.');
      return;
    }
    data.directorFio = text.trim();
    setFillState(userId, 'employer_asking_contact', data);
    await promptProfileStep(ctx, 'employer_asking_contact');
    return;
  }
  
  if (state === 'employer_asking_contact') {
    data.contactPerson = /^тот\s*же$/i.test(text.trim()) ? data.directorFio : text;
    setFillState(userId, 'employer_asking_phone', data);
    await promptProfileStep(ctx, 'employer_asking_phone');
    return;
  }
  
  if (state === 'employer_asking_phone') {
    const phone = validatePhone(text);
    if (!phone.ok) {
      await ctx.reply(phone.error);
      return;
    }
    data.phone = phone.phone;
    setFillState(userId, 'employer_asking_website', data);
    await promptProfileStep(ctx, 'employer_asking_website');
    return;
  }

  if (state === 'employer_asking_website') {
    const site = normalizeWebsite(text);
    if (!site.ok) {
      await ctx.reply(site.error);
      return;
    }
    data.website = site.website;
    await finishEmployerProfileCreation(ctx, userId, data);
    return;
  }
  
  if (state === 'editing_employer_profile_choice') {
    const choice = parseInt(text);
    const profile = dbOperations.getEmployerProfile(userId);
    if (isNaN(choice) || choice < 1 || choice > 9) {
      await ctx.reply('Пожалуйста, введите число от 1 до 9.');
      return;
    }
    if (!userStates.has(`${userId}_edit_employer_data`)) {
      userStates.set(`${userId}_edit_employer_data`, { ...profile });
    }
    const prompts = {
      1: ['edit_employer_field_1', 'Введите новое название компании:'],
      2: ['edit_employer_field_2', 'Введите новую отрасль:'],
      3: ['edit_employer_field_3', 'Введите новое описание компании:'],
      4: ['edit_employer_field_4', 'Введите ИНН:'],
      5: ['edit_employer_field_5', 'Введите юридический адрес:'],
      6: ['edit_employer_field_6', 'Введите ФИО руководителя:'],
      7: ['edit_employer_field_7', 'Введите контактное лицо:'],
      8: ['edit_employer_field_8', 'Введите реальный телефон с кодом страны, например +7 921 123-45-67 или +1 415 555 2671:'],
      9: ['edit_employer_field_9', 'Отправьте ссылку на сайт компании, например https://company.ru. «-» — убрать сайт.']
    };
    const [nextState, prompt] = prompts[choice];
    userStates.set(userId, nextState);
    await ctx.reply(prompt, choice === 9 ? skipKeyboard('skip_website') : undefined);
    return;
  }
  
  if (/^edit_employer_field_[1-9]$/.test(state)) {
    const editData = userStates.get(`${userId}_edit_employer_data`);
    if (state === 'edit_employer_field_3' && !String(text || '').trim()) {
      await ctx.reply('Напишите о компании. Достаточно одного символа.');
      return;
    }
    if (state === 'edit_employer_field_4') {
      const inn = text.replace(/\D/g, '');
      if (!isValidInn(inn)) {
        await ctx.reply('Укажите ИНН: 10 цифр для юрлица или 12 для ИП.');
        return;
      }
      editData.inn = inn;
    } else if (state === 'edit_employer_field_8') {
      const phone = validatePhone(text);
      if (!phone.ok) {
        await ctx.reply(phone.error);
        return;
      }
      editData.phone = phone.phone;
    } else if (state === 'edit_employer_field_9') {
      const site = normalizeWebsite(text);
      if (!site.ok) {
        await ctx.reply(site.error);
        return;
      }
      editData.website = site.website;
    } else if (state === 'edit_employer_field_1') editData.company_name = text;
    else if (state === 'edit_employer_field_2') editData.industry = text;
    else if (state === 'edit_employer_field_3') editData.description = String(text || '').trim();
    else if (state === 'edit_employer_field_5') editData.legal_address = text;
    else if (state === 'edit_employer_field_6') editData.director_fio = text;
    else if (state === 'edit_employer_field_7') editData.contact_person = text;

    saveEmployer(userId, editData);
    userStates.delete(userId);
    userStates.delete(`${userId}_edit_employer_data`);
    const legalEdit = ['edit_employer_field_4', 'edit_employer_field_5', 'edit_employer_field_6'].includes(state);
    await ctx.reply('✅ Поле обновлено!');
    if (legalEdit) {
      await ctx.reply('Данные для реестра изменились. Запускаем повторную проверку ЕГРЮЛ/ЕГРИП…');
      const result = await verifyAndStoreEmployer(userId);
      await ctx.reply(result.ok
        ? `✅ Компания снова подтверждена по ${result.registry === 'egrip' ? 'ЕГРИП' : 'ЕГРЮЛ'}.`
        : `❌ Проверка не пройдена.\n${result.error || 'Данные не совпали с реестром.'}`);
    }
    const profile = dbOperations.getEmployerProfile(userId);
    await ctx.reply(formatEmployerProfileText(profile), employerProfileButtons());
    userStates.set(userId, 'editing_employer_profile_choice');
    return;
  }
  
  if (state === 'editing_vacancy_choice') {
    const choice = parseInt(text);
    const vacancyId = userStates.get(`${userId}_edit_vacancy_id`);
    const vacancy = dbOperations.getVacancyById(vacancyId);
    if (!vacancy || vacancy.employer_id !== userId) {
      await ctx.reply('Вакансия не найдена.');
      return;
    }
    if (isNaN(choice) || choice < 1 || choice > 9) {
      await ctx.reply('Введите число от 1 до 9.');
      return;
    }
    userStates.set(`${userId}_edit_vacancy_data`, { ...vacancy });
    const prompts = {
      1: ['edit_vacancy_field_1', 'Введите новое название должности:'],
      2: ['edit_vacancy_field_2', 'Введите новое описание:'],
      3: ['edit_vacancy_field_3', 'Введите новые требования:'],
      4: ['edit_vacancy_field_4', 'Введите новый город:'],
      5: ['edit_vacancy_field_5', 'Введите новую зарплату:'],
      7: ['edit_vacancy_field_7', 'Введите имя сотрудника для связи:'],
      8: ['edit_vacancy_field_8', 'Введите должность этого сотрудника:'],
      9: ['edit_vacancy_field_9', 'Введите телефон сотрудника для связи:']
    };
    if (choice === 6) {
      userStates.set(userId, 'edit_vacancy_field_6');
      await ctx.reply('Выберите сезонность:', seasonalityKeyboard());
      return;
    }
    const [nextState, prompt] = prompts[choice];
    userStates.set(userId, nextState);
    await ctx.reply(prompt);
    return;
  }

  if (/^edit_vacancy_field_[1-5]$/.test(state) || state === 'edit_vacancy_field_7' || state === 'edit_vacancy_field_8') {
    const vacancyId = userStates.get(`${userId}_edit_vacancy_id`);
    const fieldMap = {
      edit_vacancy_field_1: 'job_title',
      edit_vacancy_field_2: 'description',
      edit_vacancy_field_3: 'requirements',
      edit_vacancy_field_4: 'location',
      edit_vacancy_field_5: 'salary',
      edit_vacancy_field_7: 'contact_name',
      edit_vacancy_field_8: 'contact_position'
    };
    if ((state === 'edit_vacancy_field_7' || state === 'edit_vacancy_field_8') && !isVacancyContactLabel(text)) {
      await ctx.reply('Напишите, пожалуйста, понятный текст.');
      return;
    }
    const updated = dbOperations.updateVacancy(vacancyId, userId, { [fieldMap[state]]: text });
    if (!updated) {
      await ctx.reply('Не удалось обновить вакансию.');
      return;
    }
    await ctx.reply('✅ Поле обновлено!');
    await showEditVacancy(ctx, userId, updated);
    return;
  }

  if (state === 'edit_vacancy_field_9') {
    const vacancyId = userStates.get(`${userId}_edit_vacancy_id`);
    const phone = validatePhone(text);
    if (!phone.ok) {
      await ctx.reply(phone.error);
      return;
    }
    const updated = dbOperations.updateVacancy(vacancyId, userId, { contact_phone: phone.phone });
    if (!updated) {
      await ctx.reply('Не удалось обновить вакансию.');
      return;
    }
    await ctx.reply('✅ Поле обновлено!');
    await showEditVacancy(ctx, userId, updated);
    return;
  }

  if (state === 'vacancy_asking_title') {
    if (!data) {
      data = {};
      userStates.set(`${userId}_data`, data);
    }
    data.jobTitle = text;
    setVacancyFillState(userId, 'vacancy_asking_desc', data);
    await promptVacancyStep(ctx, 'vacancy_asking_desc');
    return;
  }
  
  if (state === 'vacancy_asking_desc') {
    if (!data) data = userStates.get(`${userId}_data`) || {};
    data.description = text;
    setVacancyFillState(userId, 'vacancy_asking_req', data);
    await promptVacancyStep(ctx, 'vacancy_asking_req');
    return;
  }
  
  if (state === 'vacancy_asking_req') {
    if (!data) data = userStates.get(`${userId}_data`) || {};
    data.requirements = text;
    setVacancyFillState(userId, 'vacancy_asking_location', data);
    await promptVacancyStep(ctx, 'vacancy_asking_location');
    return;
  }
  
  if (state === 'vacancy_asking_location') {
    if (!data) data = userStates.get(`${userId}_data`) || {};
    data.location = text;
    setVacancyFillState(userId, 'vacancy_asking_salary', data);
    await promptVacancyStep(ctx, 'vacancy_asking_salary');
    return;
  }
  
  if (state === 'vacancy_asking_salary') {
    if (!data) data = userStates.get(`${userId}_data`) || {};
    data.salary = text;
    setVacancyFillState(userId, 'vacancy_asking_seasonality', data);
    await promptVacancyStep(ctx, 'vacancy_asking_seasonality');
    return;
  }

  if (state === 'vacancy_asking_contact_name') {
    if (!data) data = userStates.get(`${userId}_data`) || {};
    if (!isVacancyContactLabel(text)) {
      await ctx.reply('Напишите имя сотрудника, которому принадлежит телефон.');
      return;
    }
    data.contactName = text;
    setVacancyFillState(userId, 'vacancy_asking_contact_position', data);
    await promptVacancyStep(ctx, 'vacancy_asking_contact_position');
    return;
  }

  if (state === 'vacancy_asking_contact_position') {
    if (!data) data = userStates.get(`${userId}_data`) || {};
    if (!isVacancyContactLabel(text)) {
      await ctx.reply('Напишите должность этого сотрудника.');
      return;
    }
    data.contactPosition = text;
    setVacancyFillState(userId, 'vacancy_asking_contact_phone', data);
    await promptVacancyStep(ctx, 'vacancy_asking_contact_phone');
    return;
  }

  if (state === 'vacancy_asking_contact_phone') {
    if (!data) data = userStates.get(`${userId}_data`) || {};
    const phone = validatePhone(text);
    if (!phone.ok) {
      await ctx.reply(phone.error);
      return;
    }
    data.contactPhone = phone.phone;
    if (await denyUnverifiedVacancy(ctx, userId)) return;
    dbOperations.addVacancy(
      userId,
      data.jobTitle,
      data.description,
      data.requirements,
      data.location,
      data.salary,
      data.seasonality,
      {
        contact_name: data.contactName,
        contact_position: data.contactPosition,
        contact_phone: data.contactPhone
      }
    );
    dbOperations.clearVacancyDraft(userId);
    userStates.delete(userId);
    userStates.delete(`${userId}_data`);
    await ctx.reply('✅ Вакансия успешно размещена. Контакт сотрудника откроется соискателю только после взаимного одобрения.');
    await ctx.reply('Что вы хотите сделать?', {
      attachments: [{
        type: 'inline_keyboard',
        payload: {
          buttons: [[
            { type: 'callback', text: 'Разместить ещё', payload: 'post_vacancy' },
            { type: 'callback', text: 'Мои вакансии', payload: 'my_vacancies' }
          ], [
            { type: 'callback', text: 'В главное меню', payload: 'back_to_menu' }
          ]]
        }
      }]
    });
    return;
  }
});

const startBot = () => {
  bot.start().catch((err) => {
    console.error('Connection error, restarting in 5 seconds...', err.message);
    setTimeout(startBot, 5000);
  });
};

const EGRUL_RECHECK_MS = 30 * 60 * 1000;
let egrulRecheckRunning = false;

async function recheckEmployerRegistry() {
  if (egrulRecheckRunning) return;
  egrulRecheckRunning = true;
  try {
    for (const employer of dbOperations.getEmployersAwaitingVerification()) {
      const result = await verifyAndStoreEmployer(employer.user_id);
      if (result.status === 'unavailable') break;
      const text = result.ok
        ? `✅ Компания «${employer.company_name}» подтверждена по ${result.registry === 'egrip' ? 'ЕГРИП' : 'ЕГРЮЛ'}. Пометка в вакансиях обновлена.`
        : `❌ Компания «${employer.company_name}» не подтверждена по ЕГРЮЛ/ЕГРИП.\n${result.error || ''}\nИсправьте данные в профиле компании и нажмите «Проверить по ЕГРЮЛ/ЕГРИП».`;
      await notifyUser(bot.api, employer.user_id, text).catch((err) => console.error('[EGRUL notify]', err.message));
    }
  } finally {
    egrulRecheckRunning = false;
  }
}

startMiniAppServer();
startBot();
setTimeout(recheckEmployerRegistry, 60 * 1000);
setInterval(recheckEmployerRegistry, EGRUL_RECHECK_MS);
