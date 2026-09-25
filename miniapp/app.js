const app = document.getElementById('app');
const WebApp = window.WebApp;

try { WebApp?.ready?.(); WebApp?.expand?.(); } catch {}

const state = {
  me: null,
  screen: 'home',
  jobs: [],
  jobIndex: 0,
  favorites: [],
  favIndex: 0,
  workers: [],
  workerIndex: 0,
  matches: { incoming: [], outgoing: [] },
  staff: [],
  staffCompany: '',
  staffDetail: null,
  myWork: { jobs: [], offers: [] },
  filters: { seasonality: '', location: '', keyword: '', sort: 'new', near: '' },
  workerFilters: { specialization: '', city: '', skills: '', ageMin: '', ageMax: '', gosuslugi: false, recommended: false, near: '', sort: '' },
  toast: '',
  cropper: null
};

const CROP_W = 270;
const CROP_H = 360;
const CROP_OUT_W = 900;
const CROP_OUT_H = 1200;

const launchInitData = (() => {
  try {
    return new URLSearchParams(window.location.hash.slice(1)).get('WebAppData') || '';
  } catch {
    return '';
  }
})();

function initData() {
  return WebApp?.initData || launchInitData;
}

let pendingRequests = 0;

function setBusy(on) {
  document.body.classList.toggle('is-busy', on);
}

async function api(path, options = {}) {
  pendingRequests += 1;
  setBusy(true);
  try {
    const headers = {
      'Content-Type': 'application/json',
      'X-Max-Init-Data': initData()
    };
    const res = await fetch(path, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Ошибка запроса');
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    pendingRequests = Math.max(0, pendingRequests - 1);
    setBusy(pendingRequests > 0);
  }
}

function toast(text) {
  state.toast = text;
  render();
  setTimeout(() => {
    if (state.toast === text) {
      state.toast = '';
      render();
    }
  }, 2200);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function photoTag(photo) {
  return photo?.url
    ? `<img class="photo" src="${escapeHtml(photo.url)}" alt="Фото профиля">`
    : `<div class="photo-placeholder">Фото пока не добавлено</div>`;
}

function nav(role, current) {
  const items = role === 'employer'
    ? [
        ['home', 'Компания'],
        ['vacancies', 'Вакансии'],
        ['staff', 'Кадры'],
        ['workers', 'Анкеты'],
        ['matches', 'Отклики']
      ]
    : [
        ['home', 'Работа'],
        ['fav', 'Избранное'],
        ['work', 'Штат'],
        ['matches', 'Отклики'],
        ['profile', 'Профиль']
      ];
  return `<nav class="nav">${items.map(([id, label]) =>
    `<button data-go="${id}" class="${current === id ? 'active' : ''}">${label}</button>`
  ).join('')}</nav>`;
}

function isLocalBrowser() {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

function shell(title, badge, body, role, current) {
  return `
    <div class="top">
      <h1>${title}</h1>
      <div class="badge">${escapeHtml(badge)}</div>
    </div>
    ${isLocalBrowser() ? '<div class="content" style="padding-bottom:0"><div class="meta">Локальный режим: http://localhost:8080</div></div>' : ''}
    <div class="content">${noProfileBanner(role)}${body}</div>
    ${nav(role, current)}
    ${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ''}
  `;
}

function hasOwnProfile(role = state.me?.role) {
  return role === 'employer' ? Boolean(state.me?.employer) : Boolean(state.me?.worker);
}

function noProfileBanner(role) {
  if (!role || hasOwnProfile(role)) return '';
  const target = role === 'employer' ? 'home' : 'profile';
  if (state.screen === target) return '';
  const text = role === 'employer'
    ? 'Анкеты можно смотреть без профиля. Чтобы размещать вакансии и приглашать людей, создайте профиль компании.'
    : 'Вакансии можно смотреть без анкеты. Чтобы откликаться, создайте анкету.';
  return `<div class="card cta-card">
    <div class="meta">${text}</div>
    <button class="btn primary" data-go="${target}">${role === 'employer' ? 'Создать профиль компании' : 'Создать анкету'}</button>
  </div>`;
}

function requireProfile(action) {
  if (hasOwnProfile()) return true;
  const isEmployer = state.me?.role === 'employer';
  state.screen = isEmployer ? 'home' : 'profile';
  state.toast = `Чтобы ${action}, создайте ${isEmployer ? 'профиль компании' : 'анкету'}`;
  render();
  setTimeout(() => { state.toast = ''; render(); }, 2600);
  return false;
}

function profileSourceBadge(worker) {
  const fromGosuslugi = worker?.profile_source === 'gosuslugi';
  return `<div class="source-badges">
    <span class="source-badge ${fromGosuslugi ? 'ok' : 'manual'}">${fromGosuslugi ? '🏛 Подтверждено через Госуслуги' : '✍️ Заполнено вручную · Госуслуги не подключены'}</span>
    ${worker?.phone_verified ? '<span class="source-badge ok">📱 Телефон подтверждён в MAX</span>' : ''}
  </div>`;
}

function cityOptions(id) {
  const cities = state.me?.cities || [];
  return `<datalist id="${id}">${cities.map((city) => `<option value="${escapeHtml(city)}">`).join('')}</datalist>`;
}

function jobCard(job, index, total) {
  if (!job) return `<div class="empty">Вакансий пока нет</div>`;
  return `
    <div class="card">
      <div class="meta">${index + 1} из ${total}</div>
      <h2>${escapeHtml(job.job_title)}</h2>
      <div class="${job.company_verified ? 'rec' : 'warn'}">${escapeHtml(job.verification_label || '⚠️ Компания не подтверждена по ЕГРЮЛ/ЕГРИП')}</div>
      <div class="meta">
        ${escapeHtml(job.company_name)} · ${escapeHtml(job.location)} · ${escapeHtml(job.salary)}<br>
        Сезонность: ${escapeHtml(job.seasonality)}
        ${job.distance_label ? `<br>${escapeHtml(job.distance_label)}` : ''}
      </div>
      <p>${escapeHtml(job.description)}</p>
      <div class="meta">Требования: ${escapeHtml(job.requirements)}</div>
      <div class="meta">Контакт компании откроется после принятия отклика обеими сторонами.</div>
      <div class="row">
        <button class="btn" data-act="fav">${job.is_favorite ? '★ В избранном' : '⭐ В избранное'}</button>
        <button class="btn primary" data-act="apply" ${job.applied ? 'disabled' : ''}>${job.applied ? 'Отклик отправлен' : 'Откликнуться'}</button>
      </div>
      <div class="row">
        <button class="btn ghost" data-act="prev">Назад</button>
        <button class="btn ghost" data-act="next">Дальше</button>
      </div>
    </div>
  `;
}

function workerCard(worker, index, total) {
  if (!worker) return `<div class="empty">Анкет не найдено</div>`;
  return `
    <div class="card">
      ${worker.in_company ? `<div class="rec">🏢 Уже работает у вас: ${escapeHtml((worker.company_jobs || []).map((j) => j.position).join(', '))}</div>` : ''}
      ${worker.recommended ? '<div class="rec">Рекомендуемый кандидат</div>' : ''}
      ${photoTag(worker.photo)}
      ${profileSourceBadge(worker)}
      <div class="meta">${index + 1} из ${total}</div>
      <h2>${escapeHtml(worker.full_name)}</h2>
      <div class="meta">
        ${escapeHtml(worker.age)} лет · ${escapeHtml(worker.city || 'город не указан')} · ${escapeHtml(worker.specialization)}<br>
        ${worker.distance_label ? `${escapeHtml(worker.distance_label)}<br>` : ''}
        Опыт: ${escapeHtml(worker.experience)}<br>
        Образование: ${escapeHtml(worker.education || 'не указано')}<br>
        Навыки: ${escapeHtml(worker.skills || 'не указаны')}<br>
        Телефон: ${worker.phone_hidden ? 'скроется после принятия отклика' : escapeHtml(worker.phone || '—')}
        ${worker.about ? `<p>${escapeHtml(worker.about)}</p>` : ''}
        ${worker.matched_vacancy ? `<br>Подходит под: ${escapeHtml(worker.matched_vacancy.job_title)}` : ''}
      </div>
      <div class="row">
        <button class="btn ghost" data-act="wprev">Назад</button>
        <button class="btn ghost" data-act="wnext">Дальше</button>
      </div>
      <div class="row">
        <button class="btn primary" data-act="offer" ${worker.offered ? 'disabled' : ''}>${worker.offered ? 'Отклик отправлен' : 'Откликнуться'}</button>
      </div>
      <div class="row">
        <button class="btn ghost" data-act="labor">Трудовая книжка</button>
      </div>
    </div>
  `;
}

function roleScreen() {
  return `
    <div class="top"><h1>Кто вы?</h1></div>
    <div class="content">
      <div class="card">
        <p class="meta">Один аккаунт может быть и работником, и работодателем. Роль можно сменить в любой момент. Профиль можно создать сразу или позже — смотреть вакансии и анкеты можно и без него.</p>
        <div class="row">
          <button class="btn primary" data-role="worker">Работник</button>
          <button class="btn" data-role="employer">Работодатель</button>
        </div>
      </div>
    </div>
  `;
}

function workerHome() {
  const f = state.filters;
  const job = state.jobs[state.jobIndex];
  return shell('Найти работу', 'Работник', `
    <div class="card">
      <label>Специальность
        <input id="kw" value="${escapeHtml(f.keyword)}" placeholder="аналитик, курьер...">
      </label>
      <div class="chips">
        ${['', 'Круглогодично', 'Весна-осень', 'Лето', 'Зима'].map((s) =>
          `<button class="chip ${f.seasonality === s ? 'active' : ''}" data-season="${s}">${s || 'Все сезоны'}</button>`
        ).join('')}
      </div>
      <label>Город
        <input id="loc" list="ru-cities" value="${escapeHtml(f.location)}" placeholder="Казань">
      </label>
      <label>Расстояние от
        <input id="near" list="ru-cities" value="${escapeHtml(f.near)}" placeholder="${escapeHtml(state.me?.home_city ? `как в профиле: ${state.me.home_city}` : 'Москва')}">
      </label>
      ${cityOptions('ru-cities')}
      <label>Сортировка
        <select id="sort">
          <option value="new" ${f.sort === 'new' ? 'selected' : ''}>Сначала новые</option>
          <option value="salary" ${f.sort === 'salary' ? 'selected' : ''}>По зарплате</option>
          <option value="title" ${f.sort === 'title' ? 'selected' : ''}>По названию</option>
          <option value="distance" ${f.sort === 'distance' ? 'selected' : ''}>По удалённости</option>
        </select>
      </label>
      <div class="row"><button class="btn primary" data-act="search">Показать вакансии</button></div>
    </div>
    ${jobCard(job, state.jobIndex, state.jobs.length)}
  `, 'worker', 'home');
}

function favoritesScreen() {
  const job = state.favorites[state.favIndex];
  return shell('Избранное', 'Работник', jobCard(job, state.favIndex, state.favorites.length), 'worker', 'fav');
}

function matchBlock(m) {
  const isEmployer = state.me.role === 'employer';
  const contacts = m.showContacts && m.contacts
    ? `<div class="rec">Контакты открыты<br>Соискатель: ${escapeHtml(m.contacts.worker_name)}, ${escapeHtml(m.contacts.worker_phone)}<br>Компания: ${escapeHtml(m.contacts.company_name)}<br>Сотрудник: ${escapeHtml(m.contacts.contact_person)}${m.contacts.contact_position ? `, ${escapeHtml(m.contacts.contact_position)}` : ''}<br>Телефон: ${escapeHtml(m.contacts.company_phone)}</div>`
    : '';
  const pending = m.incoming && m.status === 'pending'
    ? `<div class="row">
        <button class="btn primary" data-act="accept" data-id="${m.id}">Принять</button>
        <button class="btn ghost" data-act="decline" data-id="${m.id}">Отклонить</button>
      </div>`
    : '';
  const accepted = m.status === 'accepted'
    ? `<div class="row">
        <button class="btn primary" data-act="show-contacts" data-id="${m.id}">Контакты</button>
        ${isEmployer ? `<button class="btn ghost" data-act="match-anketa" data-id="${m.id}">Полная анкета</button>` : ''}
      </div>
      <div class="row"><button class="btn ghost" data-act="cancel-match" data-id="${m.id}">Отменить одобрение</button></div>`
    : '';
  return `
    <div class="card">
      <div class="meta">${m.incoming ? 'входящий' : 'ваш отклик'}</div>
      <h2>${escapeHtml(m.title)}</h2>
      <div class="meta">Статус: ${escapeHtml(m.status_label)}</div>
      ${m.worker ? profileSourceBadge(m.worker) : ''}
      ${m.employer ? `<div class="${m.employer.company_verified ? 'rec' : 'warn'}">${escapeHtml(m.employer.verification_label || '⚠️ Компания не подтверждена по ЕГРЮЛ/ЕГРИП')}</div>` : ''}
      ${contacts}
      ${pending}
      ${accepted}
    </div>
  `;
}

function matchesScreen() {
  if (state.matchAnketa) {
    const w = state.matchAnketa;
    return shell('Анкета соискателя', 'Одобренный отклик', `
      <div class="card">
        ${photoTag(w.photo)}
        ${profileSourceBadge(w)}
        <h2>${escapeHtml(w.full_name)}</h2>
        <div class="meta">
          ${escapeHtml(w.age)} лет · ${escapeHtml(w.city || 'город не указан')}<br>
          Специальность: ${escapeHtml(w.specialization || '—')}<br>
          Опыт: ${escapeHtml(w.experience || '—')}<br>
          Образование: ${escapeHtml(w.education || '—')}<br>
          Навыки: ${escapeHtml(w.skills || '—')}<br>
          О себе: ${escapeHtml(w.about || '—')}<br>
          Телефон: ${w.phone_hidden ? 'скрыт' : escapeHtml(w.phone || '—')}
        </div>
      </div>
      <div class="row"><button class="btn ghost" data-act="match-anketa-back">К откликам</button></div>
    `, 'employer', 'matches');
  }
  const role = state.me.role;
  const incoming = state.matches.incoming || [];
  const outgoing = state.matches.outgoing || [];
  return shell('Отклики', role === 'employer' ? 'Работодатель' : 'Работник', `
    <div class="card"><h2>Входящие</h2></div>
    ${incoming.length ? incoming.map(matchBlock).join('') : '<div class="empty">Пока никто не откликнулся</div>'}
    <div class="card"><h2>Мои отклики</h2></div>
    ${outgoing.length ? outgoing.map(matchBlock).join('') : '<div class="empty">Вы ещё ни на кого не откликались</div>'}
  `, role, 'matches');
}

function verificationCard(w, exists) {
  const fromGosuslugi = w.profile_source === 'gosuslugi';
  const esia = state.me.esia_available
    ? `<div class="row"><button class="btn ${fromGosuslugi ? 'ghost' : 'primary'}" data-act="esia">${fromGosuslugi ? 'Обновить данные из Госуслуг' : 'Подтвердить через Госуслуги'}</button></div>`
    : '';
  const canVerifyPhone = exists && !w.phone_verified && typeof window.WebApp?.requestContact === 'function';
  return `<div class="card">
    <h2>Подтверждение анкеты</h2>
    ${exists ? profileSourceBadge(w) : ''}
    <div class="meta">${fromGosuslugi
      ? 'ФИО и возраст взяты из Госуслуг — работодатели видят, что анкета подтверждена.'
      : 'Работодатели видят, как создана анкета: через Госуслуги или вручную.'}</div>
    ${esia}
    ${canVerifyPhone ? '<div class="row"><button class="btn" data-act="verify-phone">Подтвердить телефон через MAX</button></div>' : ''}
  </div>`;
}

function profileScreen() {
  const exists = Boolean(state.me.worker);
  const w = state.me.worker || {};
  return shell(exists ? 'Мой профиль' : 'Новая анкета', exists ? (w.is_active ? 'Анкета активна' : 'Анкета скрыта') : 'Не создана', `
    ${exists ? '' : '<div class="card cta-card"><h2>Создайте анкету</h2><div class="meta">После сохранения можно откликаться на вакансии и получать приглашения от работодателей.</div></div>'}
    ${photoTag(w.photo || state.pendingPhoto)}
    ${verificationCard(w, exists)}
    ${w.labor_book?.records?.length ? `<div class="card"><h2>Электронная трудовая книжка</h2><div class="meta">${w.labor_book.records.map((r) => `${escapeHtml(r.position)} · ${escapeHtml(r.organization)} (${escapeHtml(r.started_at)} — ${escapeHtml(r.ended_at || 'н.в.')})`).join('<br>')}</div></div>` : ''}
    <div class="photo-actions">
      <label class="btn primary">
        Выбрать фото из галереи
        <input id="photo-file" type="file" accept="image/*">
      </label>
    </div>
    <form class="card form" id="worker-form">
      <label>Имя <input name="full_name" value="${escapeHtml(w.full_name)}" required></label>
      <label>Возраст <input name="age" type="number" min="14" max="100" value="${escapeHtml(w.age)}" required></label>
      <label>Город <input name="city" value="${escapeHtml(w.city)}" required></label>
      <label>Специальность <input name="specialization" value="${escapeHtml(w.specialization)}" required></label>
      <label>Опыт работы <textarea name="experience" required minlength="20">${escapeHtml(w.experience)}</textarea></label>
      <label>Образование <input name="education" value="${escapeHtml(w.education)}" required></label>
      <label>Навыки <input name="skills" value="${escapeHtml(w.skills)}" required></label>
      <label>О себе <textarea name="about" placeholder="Необязательно. Чем занимаетесь, какой опыт, какие задачи ищете">${escapeHtml(w.about)}</textarea></label>
      <label>Телефон <input name="phone" value="${escapeHtml(w.phone)}" required placeholder="+7 921 123-45-67 или +375 29 123-45-67"></label>
      <input type="hidden" name="photo_url" value="${escapeHtml(w.photo?.url || state.pendingPhoto?.url)}">
      <button class="btn primary" type="submit">${exists ? 'Сохранить' : 'Создать анкету'}</button>
    </form>
    <div class="row">
      ${exists ? `<button class="btn ghost" data-act="toggle">${w.is_active ? 'Скрыть анкету' : 'Включить анкету'}</button>` : ''}
      <button class="btn ghost" data-go="switch">Сменить роль</button>
    </div>
  `, 'worker', 'profile');
}

function employerHome() {
  const exists = Boolean(state.me.employer);
  const e = state.me.employer || {};
  const verified = e.verification?.status === 'verified';
  return shell('Компания', exists ? 'Работодатель' : 'Профиль не создан', `
    ${exists ? '' : '<div class="card cta-card"><h2>Создайте профиль компании</h2><div class="meta">После сохранения сверим ИНН, руководителя и юридический адрес с ЕГРЮЛ/ЕГРИП ФНС. Если данные не совпадут, в ваших вакансиях будет видно, что компания не подтверждена.</div></div>'}
    <form class="card form" id="employer-form">
      ${exists ? `<div class="${verified ? 'rec' : 'warn'}">${escapeHtml(e.verification_label || '⚠️ Компания не подтверждена по ЕГРЮЛ/ЕГРИП')}</div>` : ''}
      <label>Название <input name="company_name" value="${escapeHtml(e.company_name)}" required></label>
      <label>Отрасль <input name="industry" value="${escapeHtml(e.industry)}" required></label>
      <label>О компании <textarea name="description" required minlength="40">${escapeHtml(e.description)}</textarea></label>
      <label>ИНН <input name="inn" value="${escapeHtml(e.inn)}" required placeholder="10 цифр юрлица или 12 ИП"></label>
      <label>Юридический адрес <textarea name="legal_address" required>${escapeHtml(e.legal_address)}</textarea></label>
      <label>ФИО руководителя / ИП <input name="director_fio" value="${escapeHtml(e.director_fio)}" required></label>
      <label>Контактное лицо <input name="contact_person" value="${escapeHtml(e.contact_person)}" required></label>
      <label>Телефон <input name="phone" value="${escapeHtml(e.phone)}" required placeholder="+7 921 123-45-67 или +48 501 234 567"></label>
      <button class="btn primary" type="submit">${exists ? 'Сохранить и проверить' : 'Создать и проверить по ЕГРЮЛ'}</button>
    </form>
    ${exists ? '<div class="row"><button class="btn ghost" data-act="egrul">Проверить по ЕГРЮЛ/ЕГРИП</button></div>' : ''}
    <div class="row"><button class="btn ghost" data-go="switch">Сменить роль</button></div>
  `, 'employer', 'home');
}

function vacancyFields(v = {}, submitLabel) {
  const seasons = ['Круглогодично', 'Весна-осень', 'Лето', 'Зима'];
  return `
      <label>Должность <input name="job_title" value="${escapeHtml(v.job_title)}" required></label>
      <label>Описание <textarea name="description" required>${escapeHtml(v.description)}</textarea></label>
      <label>Требования <textarea name="requirements" required>${escapeHtml(v.requirements)}</textarea></label>
      <label>Город <input name="location" value="${escapeHtml(v.location)}" required></label>
      <label>Зарплата <input name="salary" value="${escapeHtml(v.salary)}" required></label>
      <label>Сезонность
        <select name="seasonality">
          ${seasons.map((s) => `<option ${v.seasonality === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </label>
      <div class="meta">Контакт сотрудника для связи. Соискатель увидит его только после взаимного одобрения.</div>
      <label>Имя сотрудника <input name="contact_name" value="${escapeHtml(v.contact_name)}" required placeholder="Имя и фамилия"></label>
      <label>Должность сотрудника <input name="contact_position" value="${escapeHtml(v.contact_position)}" required placeholder="Кем работает этот сотрудник"></label>
      <label>Телефон сотрудника <input name="contact_phone" value="${escapeHtml(v.contact_phone)}" required placeholder="+7 921 123-45-67"></label>
      <button class="btn primary" type="submit">${submitLabel}</button>`;
}

function formatJoined(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU');
}

function staffScreen() {
  const person = state.staffDetail;
  if (person) {
    const offers = person.offers || [];
    return shell('Сотрудник', person.position || 'в штате', `
      <div class="person-hero">
        ${photoTag(person.worker?.photo)}
        <div class="person-hero-copy">
          <div class="role-pill">${escapeHtml(person.position || 'сотрудник')}</div>
          <h2>${escapeHtml(person.worker?.full_name || 'Сотрудник')}</h2>
          <div class="meta">${escapeHtml(person.worker?.city || 'город не указан')} · ${escapeHtml(person.worker?.specialization || '—')}</div>
        </div>
      </div>
      <div class="card">
        <div class="stat-row">
          <div><span>Вакансия</span><b>${escapeHtml(person.vacancy?.job_title || person.position || '—')}</b></div>
          <div><span>В штате с</span><b>${escapeHtml(formatJoined(person.joined_at))}</b></div>
        </div>
        <div class="meta">${escapeHtml(person.worker?.experience || '')}</div>
      </div>
      <div class="card">
        <h2>Развитие</h2>
        ${offers.length ? offers.map((o) => `<div class="offer-line"><b>${escapeHtml(o.kind_label)}</b> · ${escapeHtml(o.title)}<div class="meta">${escapeHtml(o.status_label)}</div></div>`).join('') : '<div class="meta">Предложений пока нет — отправьте стажировку или обучение.</div>'}
        <div class="row">
          <button class="btn primary" data-act="offer-intern" data-id="${person.id}">Стажировка</button>
          <button class="btn" data-act="offer-train" data-id="${person.id}">Обучение</button>
        </div>
      </div>
      <div class="row"><button class="btn ghost" data-act="staff-back">К кадрам</button></div>
    `, 'employer', 'staff');
  }
  const items = state.staff || [];
  return shell('Кадры', state.staffCompany || 'Штат', `
    <div class="staff-hero">
      <div class="staff-kicker">Учёт кадров</div>
      <h2>${escapeHtml(state.staffCompany || 'Компания')}</h2>
      <div class="staff-metrics">
        <div class="metric"><b>${items.length}</b><span>в штате</span></div>
        <div class="metric"><b>${items.filter((p) => (p.offers || []).some((o) => o.status === 'pending')).length}</b><span>ждут ответ</span></div>
        <div class="metric"><b>${new Set(items.map((p) => p.position)).size}</b><span>ролей</span></div>
      </div>
    </div>
    ${items.length ? items.map((p) => `
      <button class="person-card" data-act="staff-open" data-id="${p.id}">
        ${p.worker?.photo?.url ? `<img src="${escapeHtml(p.worker.photo.url)}" alt="">` : `<div class="person-fallback">${escapeHtml((p.worker?.full_name || '?').slice(0, 1))}</div>`}
        <div class="person-copy">
          <div class="role-pill">${escapeHtml(p.position || 'сотрудник')}</div>
          <strong>${escapeHtml(p.worker?.full_name || 'Сотрудник')}</strong>
          <div class="meta">Вакансия: ${escapeHtml(p.vacancy?.job_title || p.position || '—')}<br>С ${escapeHtml(formatJoined(p.joined_at))}</div>
        </div>
      </button>
    `).join('') : '<div class="empty">После принятия отклика или приглашения человек появится в штате. Отсюда можно предложить стажировку или обучение.</div>'}
  `, 'employer', 'staff');
}

function workScreen() {
  const jobs = state.myWork.jobs || [];
  const offers = (state.myWork.offers || []).filter((o) => o.status === 'pending');
  return shell('Моя работа', jobs.length ? 'В штате' : 'Пока свободно', `
    ${jobs.length ? jobs.map((job) => `
      <div class="work-card">
        <div class="staff-kicker">${escapeHtml(job.employer?.industry || 'компания')}</div>
        <h2>${escapeHtml(job.employer?.company_name || 'Компания')}</h2>
        <div class="role-pill">${escapeHtml(job.position || 'сотрудник')}</div>
        <div class="meta">Вакансия: ${escapeHtml(job.vacancy?.job_title || job.position || '—')}<br>В штате с ${escapeHtml(formatJoined(job.joined_at))}</div>
      </div>
    `).join('') : `<div class="work-card"><div class="staff-kicker">кадры</div><h2>Вы пока свободны</h2><div class="meta">Когда работодатель примет отклик или вы примете приглашение, здесь появится компания, должность и вакансия.</div></div>`}
    ${offers.length ? `<h2 class="section-title">Предложения</h2>` : ''}
    ${offers.map((o) => `
      <div class="card">
        <div class="role-pill">${escapeHtml(o.kind_label)}</div>
        <h2>${escapeHtml(o.title)}</h2>
        <div class="meta">${escapeHtml(o.company_name)}</div>
        <div class="row">
          <button class="btn primary" data-act="dev-accept" data-id="${o.id}">Принять</button>
          <button class="btn ghost" data-act="dev-decline" data-id="${o.id}">Отклонить</button>
        </div>
      </div>
    `).join('')}
  `, 'worker', 'work');
}

function vacanciesScreen() {
  const list = state.myVacancies.map((v) => `
    <form class="card form vacancy-edit-form">
      <input type="hidden" name="id" value="${escapeHtml(v.id)}">
      <h2>Редактирование</h2>
      ${vacancyFields(v, 'Сохранить изменения')}
    </form>
  `).join('') || '<div class="empty">Вакансии ещё не размещены</div>';
  const employer = state.me.employer;
  if (!employer) {
    return shell('Мои вакансии', '0', '', 'employer', 'vacancies');
  }
  const verified = employer.verification?.status === 'verified';
  return shell('Мои вакансии', `${state.myVacancies.length}`, `
    ${verified ? '' : `<div class="card"><div class="warn">${escapeHtml(employer.verification_label || '⚠️ Компания не подтверждена по ЕГРЮЛ/ЕГРИП')}</div><div class="meta">Вакансии публикуются, но соискатели видят пометку «Компания не подтверждена». Исправьте данные на вкладке «Компания» и проверьте снова.</div></div>`}
    <form class="card form" id="vacancy-form">
      <h2>Новая вакансия</h2>
      ${vacancyFields({}, 'Разместить')}
    </form>
    ${list}
  `, 'employer', 'vacancies');
}

function workersScreen() {
  const worker = state.workers[state.workerIndex];
  const f = state.workerFilters;
  const specs = state.me.worker_specializations || [];
  return shell('Анкеты', `${state.workers.length}`, `
    <div class="card form">
      <div class="meta">Сначала показаны все анкеты. Имя в поиске не используется — отсекайте фильтрами.</div>
      <label>Специальность
        <input id="wf-spec" list="wf-specs" value="${escapeHtml(f.specialization)}" placeholder="аналитик, курьер...">
        <datalist id="wf-specs">${specs.map((s) => `<option value="${escapeHtml(s)}">`).join('')}</datalist>
      </label>
      <label>Город
        <input id="wf-city" list="ru-cities" value="${escapeHtml(f.city)}" placeholder="Казань">
      </label>
      <label>Расстояние от
        <input id="wf-near" list="ru-cities" value="${escapeHtml(f.near)}" placeholder="${escapeHtml(state.me?.home_city ? `как в профиле: ${state.me.home_city}` : 'Москва')}">
      </label>
      ${cityOptions('ru-cities')}
      <label>Сортировка
        <select id="wf-sort">
          <option value="" ${f.sort !== 'distance' ? 'selected' : ''}>Сначала рекомендуемые</option>
          <option value="distance" ${f.sort === 'distance' ? 'selected' : ''}>По удалённости</option>
        </select>
      </label>
      <label>Навыки
        <input id="wf-skills" value="${escapeHtml(f.skills)}" placeholder="Excel, вождение, английский">
      </label>
      <div class="row">
        <label>Возраст от <input id="wf-age-min" type="number" min="14" max="100" value="${escapeHtml(f.ageMin)}"></label>
        <label>до <input id="wf-age-max" type="number" min="14" max="100" value="${escapeHtml(f.ageMax)}"></label>
      </div>
      <div class="chips">
        <button class="chip ${f.gosuslugi ? 'active' : ''}" data-act="wf-gosu">Госуслуги</button>
        <button class="chip ${f.recommended ? 'active' : ''}" data-act="wf-rec">Под вакансии</button>
      </div>
      <div class="row">
        <button class="btn primary" data-act="wsearch">Применить фильтры</button>
        <button class="btn ghost" data-act="wreset">Все анкеты</button>
      </div>
    </div>
    ${workerCard(worker, state.workerIndex, state.workers.length)}
  `, 'employer', 'workers');
}

function clampCrop() {
  const c = state.cropper;
  if (!c?.img) return;
  const w = c.img.naturalWidth * c.scale;
  const h = c.img.naturalHeight * c.scale;
  const maxX = Math.max(0, (w - CROP_W) / 2);
  const maxY = Math.max(0, (h - CROP_H) / 2);
  c.offsetX = Math.min(maxX, Math.max(-maxX, c.offsetX));
  c.offsetY = Math.min(maxY, Math.max(-maxY, c.offsetY));
}

function applyCropTransform() {
  const img = app.querySelector('.crop-image');
  const c = state.cropper;
  if (!img || !c?.img) return;
  clampCrop();
  const w = c.img.naturalWidth * c.scale;
  const h = c.img.naturalHeight * c.scale;
  img.style.width = `${w}px`;
  img.style.height = `${h}px`;
  img.style.transform = `translate(calc(-50% + ${c.offsetX}px), calc(-50% + ${c.offsetY}px))`;
}

function cropOverlay() {
  if (!state.cropper?.img) return '';
  return `
    <div class="crop-overlay">
      <h2>Кадрирование 3×4</h2>
      <div class="crop-hint">Перетащите фото и подгоните масштаб. Сохранится только вертикальный кадр 3×4.</div>
      <div class="crop-stage" data-crop-stage>
        <img class="crop-image" alt="Кадрирование" src="${escapeHtml(state.cropper.src)}">
        <div class="crop-frame"></div>
      </div>
      <div class="row" style="width:min(100%,270px)">
        <button class="btn ghost" data-act="crop-zoom-out">−</button>
        <button class="btn ghost" data-act="crop-zoom-in">+</button>
      </div>
      <div class="row" style="width:min(100%,270px)">
        <button class="btn ghost" data-act="crop-cancel">Отмена</button>
        <button class="btn primary" data-act="crop-ok">Сохранить 3×4</button>
      </div>
    </div>
  `;
}

function exportCropDataUrl() {
  const c = state.cropper;
  clampCrop();
  const scale = c.scale;
  const drawX = CROP_W / 2 + c.offsetX - (c.img.naturalWidth * scale) / 2;
  const drawY = CROP_H / 2 + c.offsetY - (c.img.naturalHeight * scale) / 2;
  const sx = (0 - drawX) / scale;
  const sy = (0 - drawY) / scale;
  const sw = CROP_W / scale;
  const sh = CROP_H / scale;
  const canvas = document.createElement('canvas');
  canvas.width = CROP_OUT_W;
  canvas.height = CROP_OUT_H;
  canvas.getContext('2d').drawImage(c.img, sx, sy, sw, sh, 0, 0, CROP_OUT_W, CROP_OUT_H);
  return canvas.toDataURL('image/jpeg', 0.9);
}

function render() {
  if (state.cropper?.img) {
    app.innerHTML = cropOverlay() + (state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : '');
    applyCropTransform();
    return;
  }
  if (!state.me) {
    app.innerHTML = '<div class="boot">Загрузка…</div>';
    return;
  }
  if (!state.me.role || state.screen === 'switch') {
    app.innerHTML = roleScreen();
    return;
  }
  if (state.me.role === 'worker') {
    if (state.screen === 'fav') app.innerHTML = favoritesScreen();
    else if (state.screen === 'matches') app.innerHTML = matchesScreen();
    else if (state.screen === 'work') app.innerHTML = workScreen();
    else if (state.screen === 'profile') app.innerHTML = profileScreen();
    else app.innerHTML = workerHome();
    return;
  }
  if (state.screen === 'vacancies') app.innerHTML = vacanciesScreen();
  else if (state.screen === 'workers') app.innerHTML = workersScreen();
  else if (state.screen === 'staff') app.innerHTML = staffScreen();
  else if (state.screen === 'matches') app.innerHTML = matchesScreen();
  else app.innerHTML = employerHome();
}

async function loadMe() {
  state.me = await api('/api/me');
  const loaders = state.me.role === 'worker'
    ? [loadJobs, loadFavorites, loadMatches, loadMyWork]
    : state.me.role === 'employer'
      ? [loadMyVacancies, loadWorkers, loadMatches, loadStaff]
      : [];
  const results = await Promise.allSettled(loaders.map((load) => load()));
  results
    .filter((r) => r.status === 'rejected')
    .forEach((r) => console.warn('[miniapp]', r.reason?.message || r.reason));
  if (state.me.role === 'employer' && !state.me.employer && state.screen === 'home' && !state.booted) {
    state.screen = 'workers';
  }
  state.booted = true;
  render();
}

async function loadJobs() {
  const q = new URLSearchParams();
  Object.entries(state.filters).forEach(([k, v]) => { if (v) q.set(k, v); });
  const data = await api(`/api/jobs?${q}`);
  state.jobs = data.items || [];
  state.jobIndex = 0;
}

async function loadFavorites() {
  const data = await api('/api/favorites');
  state.favorites = data.items || [];
  if (state.favIndex >= state.favorites.length) state.favIndex = 0;
}

async function loadMatches() {
  const data = await api('/api/matches');
  state.matches = { incoming: data.incoming || [], outgoing: data.outgoing || [] };
}

async function loadStaff() {
  const data = await api('/api/staff');
  state.staff = data.items || [];
  state.staffCompany = data.company_name || '';
  if (state.staffDetail) {
    state.staffDetail = state.staff.find((row) => row.id === state.staffDetail.id) || null;
  }
}

async function loadMyWork() {
  state.myWork = await api('/api/my-work');
}

async function loadMyVacancies() {
  const data = await api('/api/my-vacancies');
  state.myVacancies = data.items || [];
}

async function loadWorkers() {
  const f = state.workerFilters;
  const q = new URLSearchParams();
  if (f.specialization) q.set('specialization', f.specialization);
  if (f.city) q.set('city', f.city);
  if (f.skills) q.set('skills', f.skills);
  if (f.ageMin) q.set('ageMin', f.ageMin);
  if (f.ageMax) q.set('ageMax', f.ageMax);
  if (f.gosuslugi) q.set('gosuslugi', '1');
  if (f.recommended) q.set('recommended', '1');
  if (f.near) q.set('near', f.near);
  if (f.sort) q.set('sort', f.sort);
  const data = await api(`/api/workers?${q}`);
  state.workers = data.items || [];
  state.workerIndex = 0;
}

function readWorkerFiltersFromForm() {
  state.workerFilters = {
    ...state.workerFilters,
    specialization: document.getElementById('wf-spec')?.value.trim() || '',
    city: document.getElementById('wf-city')?.value.trim() || '',
    skills: document.getElementById('wf-skills')?.value.trim() || '',
    ageMin: document.getElementById('wf-age-min')?.value || '',
    ageMax: document.getElementById('wf-age-max')?.value || '',
    near: document.getElementById('wf-near')?.value.trim() || '',
    sort: document.getElementById('wf-sort')?.value || ''
  };
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function fileToJpegDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) {
      reject(new Error('Выберите изображение из галереи'));
      return;
    }
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      const max = 1280;
      let width = img.width;
      let height = img.height;
      if (width > max || height > max) {
        const scale = max / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(objectUrl);
      resolve(canvas.toDataURL('image/jpeg', 0.86));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Не удалось открыть это изображение'));
    };
    img.src = objectUrl;
  });
}

app.addEventListener('click', async (e) => {
  const go = e.target.closest('[data-go]');
  if (go) {
    state.screen = go.dataset.go;
    try {
      if (state.screen === 'matches') await loadMatches();
      if (state.screen === 'staff') {
        state.staffDetail = null;
        await loadStaff();
      }
      if (state.screen === 'work') await loadMyWork();
    } catch (err) { toast(err.message); }
    render();
    return;
  }
  const roleBtn = e.target.closest('[data-role]');
  if (roleBtn) {
    try {
      state.me = await api('/api/role', { method: 'POST', body: JSON.stringify({ role: roleBtn.dataset.role }) });
      state.screen = 'home';
      await loadMe();
    } catch (err) { toast(err.message); }
    return;
  }
  const season = e.target.closest('[data-season]');
  if (season) {
    state.filters.seasonality = season.dataset.season;
    render();
    return;
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  try {
    if (act === 'crop-cancel') {
      if (state.cropper?.src) URL.revokeObjectURL(state.cropper.src);
      state.cropper = null;
      render();
      return;
    }
    if (act === 'crop-zoom-in' && state.cropper) {
      state.cropper.scale *= 1.12;
      applyCropTransform();
      return;
    }
    if (act === 'crop-zoom-out' && state.cropper) {
      state.cropper.scale = Math.max(state.cropper.minScale, state.cropper.scale / 1.12);
      applyCropTransform();
      return;
    }
    if (act === 'crop-ok' && state.cropper) {
      toast('Сохраняем фото…');
      const image = exportCropDataUrl();
      const data = await api('/api/worker-photo', { method: 'POST', body: JSON.stringify({ image }) });
      if (state.cropper.src) URL.revokeObjectURL(state.cropper.src);
      state.cropper = null;
      state.me = data;
      if (data.uploaded_photo && !state.me.worker) state.pendingPhoto = data.uploaded_photo;
      toast(state.me.worker ? 'Фото обновлено' : 'Фото добавится к анкете после сохранения');
      render();
      return;
    }
    if (act === 'esia') {
      const data = await api('/api/esia/link');
      if (!data.configured) {
        toast('Вход через Госуслуги пока недоступен');
        return;
      }
      if (window.WebApp?.openLink) window.WebApp.openLink(data.url);
      else window.location.href = data.url;
      return;
    }
    if (act === 'verify-phone') {
      let contact;
      try {
        contact = await window.WebApp.requestContact();
      } catch {
        toast('MAX не передал номер телефона');
        return;
      }
      if (!contact?.phone || contact.error) {
        toast('Номер не подтверждён: доступ к телефону не выдан');
        return;
      }
      state.me = await api('/api/worker-phone/verify', { method: 'POST', body: JSON.stringify(contact) });
      toast('Телефон подтверждён в MAX');
      render();
      return;
    }
    if (act === 'labor') {
      const worker = state.workers[state.workerIndex];
      const data = await api(`/api/workers/${worker.user_id}/labor-book`);
      toast(data.text.replace(/\n/g, ' · ').slice(0, 180));
      alert(data.text);
      return;
    }
    if (act === 'search') {
      state.filters.keyword = document.getElementById('kw')?.value || '';
      state.filters.location = document.getElementById('loc')?.value || '';
      state.filters.near = document.getElementById('near')?.value || '';
      state.filters.sort = document.getElementById('sort')?.value || 'new';
      await loadJobs();
      toast(`Найдено: ${state.jobs.length}`);
      render();
    } else if (act === 'next' || act === 'prev') {
      const list = state.screen === 'fav' ? state.favorites : state.jobs;
      if (!list.length) return;
      const key = state.screen === 'fav' ? 'favIndex' : 'jobIndex';
      state[key] = act === 'next'
        ? (state[key] + 1) % list.length
        : (state[key] - 1 + list.length) % list.length;
      render();
    } else if (act === 'fav') {
      const list = state.screen === 'fav' ? state.favorites : state.jobs;
      const job = list[state.screen === 'fav' ? state.favIndex : state.jobIndex];
      const res = await api(`/api/jobs/${job.id}/favorite`, { method: 'POST' });
      job.is_favorite = res.is_favorite;
      await loadFavorites();
      toast(res.is_favorite ? 'Добавлено в избранное' : 'Удалено из избранного');
      render();
    } else if (act === 'apply') {
      if (!requireProfile('откликнуться')) return;
      const list = state.screen === 'fav' ? state.favorites : state.jobs;
      const job = list[state.screen === 'fav' ? state.favIndex : state.jobIndex];
      await api(`/api/jobs/${job.id}/apply`, { method: 'POST' });
      job.applied = true;
      toast('Отклик отправлен. Контакты откроются, когда работодатель примет его');
      render();
    } else if (act === 'toggle') {
      const next = !state.me.worker?.is_active;
      state.me = await api('/api/worker-status', { method: 'POST', body: JSON.stringify({ is_active: next }) });
      toast(next ? 'Анкета видна работодателям' : 'Анкета скрыта');
      render();
    } else if (act === 'wsearch') {
      readWorkerFiltersFromForm();
      await loadWorkers();
      toast(state.workers.length ? `Анкет: ${state.workers.length}` : 'По фильтрам анкет нет');
      render();
    } else if (act === 'wreset') {
      state.workerFilters = { specialization: '', city: '', skills: '', ageMin: '', ageMax: '', gosuslugi: false, recommended: false, near: '', sort: '' };
      await loadWorkers();
      toast(`Все анкеты: ${state.workers.length}`);
      render();
    } else if (act === 'wf-gosu') {
      readWorkerFiltersFromForm();
      state.workerFilters.gosuslugi = !state.workerFilters.gosuslugi;
      render();
    } else if (act === 'wf-rec') {
      readWorkerFiltersFromForm();
      state.workerFilters.recommended = !state.workerFilters.recommended;
      render();
    } else if (act === 'wnext' || act === 'wprev') {
      if (!state.workers.length) return;
      state.workerIndex = act === 'wnext'
        ? (state.workerIndex + 1) % state.workers.length
        : (state.workerIndex - 1 + state.workers.length) % state.workers.length;
      render();
    } else if (act === 'offer') {
      if (!requireProfile('пригласить работника')) return;
      const worker = state.workers[state.workerIndex];
      if (!state.myVacancies.length) {
        state.screen = 'vacancies';
        toast('Сначала разместите вакансию');
        return;
      }
      const vacancy = state.myVacancies[0];
      let vacancyId = vacancy.id;
      if (state.myVacancies.length > 1) {
        const names = state.myVacancies.map((v, i) => `${i + 1}. ${v.job_title}`).join('\n');
        const pick = prompt(`Какую вакансию предложить?\n${names}`, '1');
        const idx = Number(pick) - 1;
        if (!state.myVacancies[idx]) return;
        vacancyId = state.myVacancies[idx].id;
      }
      await api(`/api/workers/${worker.user_id}/offer`, { method: 'POST', body: JSON.stringify({ vacancy_id: vacancyId }) });
      worker.offered = true;
      toast('Отклик отправлен. Контакты откроются, когда соискатель примет его');
      render();
    } else if (act === 'accept' || act === 'decline') {
      const id = e.target.closest('[data-id]')?.dataset.id;
      await api(`/api/matches/${id}/${act}`, { method: 'POST', body: '{}' });
      await Promise.all([loadMatches(), state.me?.role === 'employer' ? loadStaff() : loadMyWork()]);
      toast(act === 'accept' ? 'Контакты открыты, сотрудник в штате' : 'Отклик отклонён');
      render();
    } else if (act === 'cancel-match') {
      const id = e.target.closest('[data-id]')?.dataset.id;
      await api(`/api/matches/${id}/cancel`, { method: 'POST', body: '{}' });
      await Promise.all([loadMatches(), state.me?.role === 'employer' ? loadStaff() : loadMyWork()]);
      toast('Одобрение отменено. Контакты скрыты, сотрудник снят со штата');
      render();
    } else if (act === 'show-contacts') {
      const id = e.target.closest('[data-id]')?.dataset.id;
      const match = [...(state.matches.incoming || []), ...(state.matches.outgoing || [])].find((m) => String(m.id) === String(id));
      if (match) match.showContacts = true;
      render();
    } else if (act === 'match-anketa') {
      const id = e.target.closest('[data-id]')?.dataset.id;
      const match = [...(state.matches.incoming || []), ...(state.matches.outgoing || [])].find((m) => String(m.id) === String(id));
      if (!match?.worker) {
        toast('Анкета недоступна');
        return;
      }
      state.matchAnketa = match.worker;
      render();
    } else if (act === 'match-anketa-back') {
      state.matchAnketa = null;
      render();
    } else if (act === 'staff-open') {
      const id = e.target.closest('[data-id]')?.dataset.id;
      state.staffDetail = state.staff.find((row) => String(row.id) === String(id)) || null;
      render();
    } else if (act === 'staff-back') {
      state.staffDetail = null;
      await loadStaff();
      render();
    } else if (act === 'offer-intern' || act === 'offer-train') {
      const id = e.target.closest('[data-id]')?.dataset.id;
      const kind = act === 'offer-intern' ? 'internship' : 'training';
      const label = kind === 'internship' ? 'стажировку' : 'обучение';
      const title = prompt(`Как назвать ${label}?`, kind === 'internship' ? 'Стажировка в компании' : 'Обучение по должности') || '';
      await api(`/api/staff/${id}/${kind}`, { method: 'POST', body: JSON.stringify({ title }) });
      await loadStaff();
      toast(`Предложение отправлено: ${label}`);
      render();
    } else if (act === 'dev-accept' || act === 'dev-decline') {
      const id = e.target.closest('[data-id]')?.dataset.id;
      const accept = act === 'dev-accept';
      await api(`/api/dev-offers/${id}/${accept ? 'accept' : 'decline'}`, { method: 'POST', body: '{}' });
      await loadMyWork();
      toast(accept ? 'Предложение принято' : 'Предложение отклонено');
      render();
    } else if (act === 'egrul') {
      toast('Сверяем данные с ЕГРЮЛ/ЕГРИП…');
      state.me = await api('/api/employer-verify', { method: 'POST', body: '{}' });
      toast(state.me.verification?.ok ? 'Компания подтверждена по реестру ФНС' : `Компания не подтверждена: ${state.me.verification?.error || 'данные не совпали с реестром'}`);
      render();
    }
  } catch (err) {
    toast(err.message);
  }
});

app.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    if (e.target.id === 'worker-form') {
      const created = !state.me.worker;
      state.me = await api('/api/worker-profile', { method: 'POST', body: JSON.stringify(formData(e.target)) });
      state.pendingPhoto = null;
      toast(created ? 'Анкета создана — теперь можно откликаться' : 'Профиль сохранён');
      render();
    } else if (e.target.id === 'employer-form') {
      toast('Сохраняем и сверяем с ЕГРЮЛ/ЕГРИП…');
      state.me = await api('/api/employer-profile', { method: 'POST', body: JSON.stringify(formData(e.target)) });
      toast(state.me.verification?.ok ? 'Профиль сохранён, компания подтверждена по реестру ФНС' : `Профиль сохранён, компания не подтверждена: ${state.me.verification?.error || 'данные не совпали с реестром'}`);
      await Promise.allSettled([loadMyVacancies(), loadStaff()]);
      render();
    } else if (e.target.id === 'vacancy-form') {
      const data = await api('/api/vacancies', { method: 'POST', body: JSON.stringify(formData(e.target)) });
      state.myVacancies = data.items;
      toast('Вакансия размещена');
      e.target.reset();
      render();
    } else if (e.target.classList.contains('vacancy-edit-form')) {
      const payload = formData(e.target);
      const id = payload.id;
      delete payload.id;
      const data = await api(`/api/vacancies/${id}`, { method: 'POST', body: JSON.stringify(payload) });
      state.myVacancies = data.items;
      toast('Вакансия обновлена');
      render();
    }
  } catch (err) {
    toast(err.message);
  }
});

app.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('[data-crop-stage]') || !state.cropper) return;
  state.cropper.drag = { x: e.clientX, y: e.clientY, ox: state.cropper.offsetX, oy: state.cropper.offsetY };
});
app.addEventListener('pointermove', (e) => {
  const c = state.cropper;
  if (!c?.drag) return;
  c.offsetX = c.drag.ox + (e.clientX - c.drag.x);
  c.offsetY = c.drag.oy + (e.clientY - c.drag.y);
  applyCropTransform();
});
app.addEventListener('pointerup', () => {
  if (state.cropper) state.cropper.drag = null;
});
app.addEventListener('pointercancel', () => {
  if (state.cropper) state.cropper.drag = null;
});

app.addEventListener('change', (e) => {
  const input = e.target.closest('#photo-file');
  if (!input?.files?.[0]) return;
  const file = input.files[0];
  if (!file.type.startsWith('image/')) {
    toast('Выберите изображение из галереи');
    return;
  }
  const src = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const minScale = Math.max(CROP_W / img.naturalWidth, CROP_H / img.naturalHeight);
    state.cropper = {
      src,
      img,
      scale: minScale,
      minScale,
      offsetX: 0,
      offsetY: 0,
      drag: null
    };
    render();
  };
  img.onerror = () => {
    URL.revokeObjectURL(src);
    toast('Не удалось открыть это изображение');
  };
  img.src = src;
});

loadMe().catch(showBootError);

function showBootError(err) {
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const localHint = err.status !== 401 ? ''
    : isLocal
      ? ' Откройте именно http://localhost:8080 и перезапустите бота, если сервер не запущен.'
      : '';
  app.innerHTML = `<div class="empty">
    <p>${escapeHtml(err.message)}${escapeHtml(localHint)}</p>
    <button class="btn primary" id="boot-retry" type="button">Повторить</button>
  </div>`;
  document.getElementById('boot-retry')?.addEventListener('click', () => {
    app.innerHTML = '<div class="boot">Загрузка…</div>';
    loadMe().catch(showBootError);
  });
}
