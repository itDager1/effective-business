import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, 'data.json');

let database = {
  users: [],
  workers: [],
  employers: [],
  vacancies: [],
  favorites: [],
  applications: [],
  offers: []
};

function loadDb() {
  try {
    if (fs.existsSync(dbPath)) {
      const data = fs.readFileSync(dbPath, 'utf-8');
      database = JSON.parse(data);
      if (!database.favorites) database.favorites = [];
      if (!database.applications) database.applications = [];
      if (!database.offers) database.offers = [];
      if (!database.profile_drafts) database.profile_drafts = [];
      if (!database.matches) database.matches = [];
      if (!database.staff) database.staff = [];
      if (!database.dev_offers) database.dev_offers = [];
      migrateMatches();
    } else {
      saveDb();
    }
  } catch (e) {
    console.error('Error loading database:', e);
  }
}

function nextEntityId(list) {
  const ids = (list || []).map((row) => Number(row.id) || 0);
  return Math.max(Date.now(), ...(ids.length ? ids : [0])) + 1;
}

function nextMatchId() {
  return nextEntityId(database.matches);
}

function migrateMatches() {
  if (!database.matches) database.matches = [];
  let changed = false;
  for (const a of database.applications || []) {
    if (database.matches.some((m) => m.worker_id === a.worker_id && m.vacancy_id === a.vacancy_id && m.kind === 'application')) {
      continue;
    }
    const vacancy = (database.vacancies || []).find((v) => v.id === a.vacancy_id);
    if (!vacancy) continue;
    database.matches.push({
      id: nextMatchId(),
      kind: 'application',
      worker_id: a.worker_id,
      employer_id: vacancy.employer_id,
      vacancy_id: a.vacancy_id,
      initiator_id: a.worker_id,
      status: 'pending',
      created_at: a.created_at || new Date().toISOString(),
      updated_at: a.created_at || new Date().toISOString()
    });
    changed = true;
  }
  for (const o of database.offers || []) {
    if (database.matches.some((m) => m.worker_id === o.worker_id && m.vacancy_id === o.vacancy_id && m.kind === 'offer')) {
      continue;
    }
    database.matches.push({
      id: nextMatchId(),
      kind: 'offer',
      worker_id: o.worker_id,
      employer_id: o.employer_id,
      vacancy_id: o.vacancy_id,
      initiator_id: o.employer_id,
      status: 'pending',
      created_at: o.created_at || new Date().toISOString(),
      updated_at: o.created_at || new Date().toISOString()
    });
    changed = true;
  }
  if (changed) saveDb();
}

function saveDb() {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(database, null, 2));
  } catch (e) {
    console.error('Error saving database:', e);
  }
}

loadDb();

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9\u0401\u0451\u0410-\u044f]+/i)
    .filter(token => token.length > 2);
}

export const dbOperations = {
  addUser: (userId, chatId) => {
    const existing = database.users.find(u => u.user_id === userId);
    if (!existing) {
      database.users.push({
        user_id: userId,
        chat_id: chatId,
        role: null,
        created_at: new Date().toISOString()
      });
      saveDb();
    } else if (chatId && existing.chat_id !== chatId) {
      existing.chat_id = chatId;
      saveDb();
    }
  },

  getUser: (userId) => {
    return database.users.find(u => u.user_id === userId) || null;
  },

  updateUserRole: (userId, role) => {
    const user = database.users.find(u => u.user_id === userId);
    if (user) {
      user.role = role;
      saveDb();
    }
  },

  addWorkerProfile: (userId, fullName, age, specialization, experience, phone, photo = null, extras = {}) => {
    const existing = database.workers.find(w => w.user_id === userId);
    const extraFields = {
      city: extras.city !== undefined ? extras.city : (existing?.city || ''),
      education: extras.education !== undefined ? extras.education : (existing?.education || ''),
      skills: extras.skills !== undefined ? extras.skills : (existing?.skills || ''),
      about: extras.about !== undefined ? extras.about : (existing?.about || '')
    };
    if (existing) {
      existing.full_name = fullName;
      existing.age = age;
      existing.specialization = specialization;
      existing.experience = experience;
      existing.phone = phone;
      Object.assign(existing, extraFields);
      if (photo !== undefined && photo !== null) existing.photo = photo;
      saveDb();
    } else {
      database.workers.push({
        id: Date.now(),
        user_id: userId,
        full_name: fullName,
        age: age,
        specialization: specialization,
        experience: experience,
        phone: phone,
        photo: photo,
        ...extraFields,
        is_active: true,
        created_at: new Date().toISOString()
      });
      saveDb();
    }
  },

  updateWorkerPhoto: (userId, photo) => {
    const profile = database.workers.find(w => w.user_id === userId);
    if (profile) {
      profile.photo = photo;
      saveDb();
    }
  },

  toggleWorkerProfileStatus: (userId, status) => {
    const profile = database.workers.find(w => w.user_id === userId);
    if (profile) {
      profile.is_active = status;
      saveDb();
    }
  },

  getWorkerProfile: (userId) => {
    return database.workers.find(w => w.user_id === userId) || null;
  },

  applyGosuslugiProfile: (userId, data = {}) => {
    let profile = database.workers.find(w => w.user_id === userId);
    if (!profile) {
      profile = {
        id: Date.now(),
        user_id: userId,
        full_name: data.full_name || '',
        age: data.age || 18,
        specialization: data.specialization || '',
        experience: data.experience || '',
        phone: data.phone || '',
        photo: null,
        is_active: true,
        created_at: new Date().toISOString()
      };
      database.workers.push(profile);
    } else {
      if (data.full_name) profile.full_name = data.full_name;
      if (data.age) profile.age = data.age;
      if (data.phone) profile.phone = data.phone;
      if (data.experience) profile.experience = data.experience;
      if (data.specialization && !profile.specialization) profile.specialization = data.specialization;
      if (data.city && !profile.city) profile.city = data.city;
    }
    profile.gosuslugi = {
      connected: true,
      verified: true,
      oid: data.oid || profile.gosuslugi?.oid || null,
      snils: data.snils || profile.gosuslugi?.snils || null,
      birthdate: data.birthdate || profile.gosuslugi?.birthdate || null,
      email: data.email || profile.gosuslugi?.email || null,
      source: data.source || 'esia',
      connected_at: new Date().toISOString()
    };
    if (Array.isArray(data.labor_book)) {
      profile.labor_book = {
        source: data.labor_source || 'gosuslugi',
        updated_at: new Date().toISOString(),
        records: data.labor_book
      };
    }
    saveDb();
    return profile;
  },

  getLaborBook: (userId) => {
    const profile = database.workers.find(w => w.user_id === userId);
    return profile?.labor_book || null;
  },

  addEmployerProfile: (userId, companyName, industry, description, contactPerson, phone, extras = {}) => {
    const existing = database.employers.find(e => e.user_id === userId);
    const inn = extras.inn !== undefined ? String(extras.inn).replace(/\D/g, '') : (existing?.inn || '');
    const legalAddress = extras.legal_address !== undefined ? extras.legal_address : (existing?.legal_address || '');
    const directorFio = extras.director_fio !== undefined ? extras.director_fio : (existing?.director_fio || '');
    const legalChanged = existing && (
      inn !== (existing.inn || '')
      || legalAddress !== (existing.legal_address || '')
      || directorFio !== (existing.director_fio || '')
    );
    if (existing) {
      existing.company_name = companyName;
      existing.industry = industry;
      existing.description = description;
      existing.contact_person = contactPerson;
      existing.phone = phone;
      existing.inn = inn;
      existing.legal_address = legalAddress;
      existing.director_fio = directorFio;
      if (legalChanged) {
        existing.verification = {
          status: 'pending',
          error: 'Данные компании изменились — нужна повторная проверка ЕГРЮЛ/ЕГРИП'
        };
      }
      saveDb();
    } else {
      database.employers.push({
        id: Date.now(),
        user_id: userId,
        company_name: companyName,
        industry: industry,
        description: description,
        contact_person: contactPerson,
        phone: phone,
        inn,
        legal_address: legalAddress,
        director_fio: directorFio,
        verification: { status: 'pending' },
        created_at: new Date().toISOString()
      });
      saveDb();
    }
  },

  setEmployerVerification: (userId, verification) => {
    const profile = database.employers.find(e => e.user_id === userId);
    if (!profile) return null;
    profile.verification = verification;
    if (verification?.ogrn) profile.ogrn = verification.ogrn;
    if (verification?.fetched_name && !profile.company_name) {
      profile.company_name = verification.fetched_name;
    }
    saveDb();
    return profile;
  },

  getEmployerProfile: (userId) => {
    return database.employers.find(e => e.user_id === userId) || null;
  },

  addVacancy: (employerId, jobTitle, description, requirements, location, salary, seasonality, contact = {}) => {
    const vacancy = {
      id: Date.now(),
      employer_id: employerId,
      job_title: jobTitle,
      description: description,
      requirements: requirements,
      location: location,
      salary: salary,
      seasonality: seasonality,
      contact_name: String(contact.contact_name || contact.contactName || '').trim(),
      contact_position: String(contact.contact_position || contact.contactPosition || '').trim(),
      contact_phone: String(contact.contact_phone || contact.contactPhone || '').trim(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    database.vacancies.push(vacancy);
    saveDb();
    return vacancy;
  },

  updateVacancy: (vacancyId, employerId, fields = {}) => {
    const vacancy = database.vacancies.find(v => v.id === vacancyId && v.employer_id === employerId);
    if (!vacancy) return null;
    const allowed = ['job_title', 'description', 'requirements', 'location', 'salary', 'seasonality', 'contact_name', 'contact_position', 'contact_phone'];
    for (const key of allowed) {
      if (fields[key] !== undefined) vacancy[key] = fields[key];
    }
    vacancy.updated_at = new Date().toISOString();
    saveDb();
    return vacancy;
  },

  getAllVacancies: () => {
    return database.vacancies.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },

  getEmployerVacancies: (employerId) => {
    return database.vacancies
      .filter(v => v.employer_id === employerId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },

  searchVacancies: (specialization) => {
    return database.vacancies.filter(v => 
      v.job_title.toLowerCase().includes(specialization.toLowerCase()) ||
      v.description.toLowerCase().includes(specialization.toLowerCase())
    );
  },

  getVacancyById: (vacancyId) => {
    return database.vacancies.find(v => v.id === vacancyId) || null;
  },

  getUniqueLocations: (excludeEmployerId = null) => {
    const locations = database.vacancies
      .filter(v => excludeEmployerId == null || v.employer_id !== excludeEmployerId)
      .map(v => (v.location || '').trim())
      .filter(Boolean);
    return [...new Set(locations)].sort((a, b) => a.localeCompare(b, 'ru'));
  },

  parseSalary: (value) => {
    if (!value) return 0;
    const s = String(value).toLowerCase().replace(/\s/g, '');
    const match = s.match(/(\d+[.,]?\d*)/);
    if (!match) return 0;
    let n = parseFloat(match[1].replace(',', '.'));
    if ((s.includes('k') || s.includes('\u043a')) && n < 1000) n *= 1000;
    return n;
  },

  filterVacancies: (filters = {}) => {
    let list = [...database.vacancies];
    if (filters.excludeEmployerId != null) {
      list = list.filter(v => v.employer_id !== filters.excludeEmployerId);
    }
    if (filters.onlyEmployerId != null) {
      list = list.filter(v => v.employer_id === filters.onlyEmployerId);
    }
    if (filters.seasonality) {
      list = list.filter(v => v.seasonality === filters.seasonality);
    }
    if (filters.location) {
      const loc = filters.location.toLowerCase();
      list = list.filter(v => (v.location || '').toLowerCase().includes(loc));
    }
    if (filters.keyword) {
      const k = filters.keyword.toLowerCase();
      list = list.filter(v =>
        (v.job_title || '').toLowerCase().includes(k) ||
        (v.description || '').toLowerCase().includes(k) ||
        (v.requirements || '').toLowerCase().includes(k)
      );
    }
    const sort = filters.sort || 'new';
    if (sort === 'title') {
      list.sort((a, b) => (a.job_title || '').localeCompare(b.job_title || '', 'ru'));
    } else if (sort === 'salary') {
      list.sort((a, b) => dbOperations.parseSalary(b.salary) - dbOperations.parseSalary(a.salary));
    } else {
      list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
    return list;
  },

  isFavorite: (userId, vacancyId) => {
    return database.favorites.some(f => f.user_id === userId && f.vacancy_id === vacancyId);
  },

  toggleFavorite: (userId, vacancyId) => {
    const index = database.favorites.findIndex(f => f.user_id === userId && f.vacancy_id === vacancyId);
    if (index !== -1) {
      database.favorites.splice(index, 1);
      saveDb();
      return false;
    }
    database.favorites.push({
      user_id: userId,
      vacancy_id: vacancyId,
      created_at: new Date().toISOString()
    });
    saveDb();
    return true;
  },

  getFavoriteVacancies: (userId) => {
    const ids = database.favorites
      .filter(f => f.user_id === userId)
      .map(f => f.vacancy_id);
    return ids
      .map(id => database.vacancies.find(v => v.id === id))
      .filter(v => v && v.employer_id !== userId);
  },

  hasApplied: (userId, vacancyId) => {
    const match = (database.matches || []).find((m) =>
      m.kind === 'application' && m.worker_id === userId && m.vacancy_id === vacancyId
    );
    if (match) return match.status !== 'declined' && match.status !== 'cancelled';
    return database.applications.some((a) => a.worker_id === userId && a.vacancy_id === vacancyId);
  },

  addApplication: (userId, vacancyId) => {
    const vacancy = database.vacancies.find((v) => v.id === vacancyId);
    if (!vacancy) return null;
    return dbOperations.createMatch({
      kind: 'application',
      worker_id: userId,
      employer_id: vacancy.employer_id,
      vacancy_id: vacancyId,
      initiator_id: userId
    });
  },

  getMatchById: (id) => {
    return (database.matches || []).find((m) => Number(m.id) === Number(id)) || null;
  },

  createMatch: ({ kind, worker_id, employer_id, vacancy_id, initiator_id }) => {
    if (!database.matches) database.matches = [];
    const existing = database.matches.find((m) =>
      m.worker_id === worker_id && m.vacancy_id === vacancy_id && m.kind === kind
    );
    if (existing) {
      if (existing.status === 'pending' || existing.status === 'accepted') {
        return { ok: false, match: existing, reason: existing.status };
      }
      existing.status = 'pending';
      existing.initiator_id = initiator_id;
      existing.updated_at = new Date().toISOString();
      saveDb();
      return { ok: true, match: existing, reopened: true };
    }
    const match = {
      id: nextMatchId(),
      kind,
      worker_id,
      employer_id,
      vacancy_id,
      initiator_id,
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    database.matches.push(match);
    if (kind === 'application' && !dbOperations.hasApplied(worker_id, vacancy_id)) {
      database.applications.push({ worker_id, vacancy_id, created_at: match.created_at });
    }
    if (kind === 'offer') {
      database.offers.push({ employer_id, worker_id, vacancy_id, created_at: match.created_at });
    }
    saveDb();
    return { ok: true, match };
  },

  setMatchStatus: (id, status, actorId) => {
    const match = dbOperations.getMatchById(id);
    if (!match) return { ok: false, error: 'Отклик не найден' };
    if (match.status !== 'pending') {
      return { ok: false, error: match.status === 'accepted' ? 'Контакты уже открыты' : 'Отклик уже закрыт', match };
    }
    const recipientId = match.initiator_id === match.worker_id ? match.employer_id : match.worker_id;
    if (Number(actorId) !== Number(recipientId)) {
      return { ok: false, error: 'Принять или отклонить может только тот, кому отправили отклик', match };
    }
    match.status = status;
    match.updated_at = new Date().toISOString();
    if (status === 'accepted') dbOperations.upsertStaffFromMatch(match, false);
    saveDb();
    return { ok: true, match };
  },

  cancelAcceptedMatch: (id, actorId) => {
    const match = dbOperations.getMatchById(id);
    if (!match) return { ok: false, error: 'Отклик не найден' };
    const isParty = Number(actorId) === Number(match.worker_id) || Number(actorId) === Number(match.employer_id);
    if (!isParty) return { ok: false, error: 'Отменить одобрение может только участник отклика', match };
    if (match.status !== 'accepted') {
      return { ok: false, error: match.status === 'cancelled' ? 'Одобрение уже отменено' : 'Отменить можно только принятый отклик', match };
    }
    match.status = 'cancelled';
    match.cancelled_by = actorId;
    match.updated_at = new Date().toISOString();
    dbOperations.leaveStaffFromMatch(match, false);
    saveDb();
    return { ok: true, match };
  },

  contactsUnlocked: (userA, userB) => {
    return (database.matches || []).some((m) =>
      m.status === 'accepted' &&
      ((m.worker_id === userA && m.employer_id === userB) || (m.worker_id === userB && m.employer_id === userA))
    );
  },

  decorateMatch: (match) => {
    if (!match) return null;
    const vacancy = database.vacancies.find((v) => v.id === match.vacancy_id) || null;
    const worker = database.workers.find((w) => w.user_id === match.worker_id) || null;
    const employer = database.employers.find((e) => e.user_id === match.employer_id) || null;
    return { ...match, vacancy, worker, employer };
  },

  getIncomingMatches: (userId) => {
    return (database.matches || [])
      .filter((m) => Number(m.initiator_id) !== Number(userId) && (m.worker_id === userId || m.employer_id === userId))
      .map(dbOperations.decorateMatch)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  },

  getOutgoingMatches: (userId) => {
    return (database.matches || [])
      .filter((m) => Number(m.initiator_id) === Number(userId))
      .map(dbOperations.decorateMatch)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  },

  deleteWorkerProfile: (userId) => {
    const index = database.workers.findIndex(w => w.user_id === userId);
    if (index !== -1) {
      database.workers.splice(index, 1);
      saveDb();
      return true;
    }
    return false;
  },

  deleteEmployerProfile: (userId) => {
    const index = database.employers.findIndex(e => e.user_id === userId);
    if (index !== -1) {
      const removedIds = database.vacancies
        .filter(v => v.employer_id === userId)
        .map(v => v.id);
      database.vacancies = database.vacancies.filter(v => v.employer_id !== userId);
      database.favorites = (database.favorites || []).filter(f => !removedIds.includes(f.vacancy_id));
      database.applications = (database.applications || []).filter(a => !removedIds.includes(a.vacancy_id));
      database.employers.splice(index, 1);
      saveDb();
      return true;
    }
    return false;
  },

  getAllWorkerProfiles: (userId) => {
    return database.workers.filter(w => w.user_id === userId);
  },

  getAllEmployerProfiles: (userId) => {
    return database.employers.filter(e => e.user_id === userId);
  },

  getDatabase: () => {
    return database;
  },

  addOffer: (employerId, workerId, vacancyId) => {
    return dbOperations.createMatch({
      kind: 'offer',
      worker_id: workerId,
      employer_id: employerId,
      vacancy_id: vacancyId,
      initiator_id: employerId
    });
  },

  hasOffered: (employerId, workerId, vacancyId) => {
    const match = (database.matches || []).find((m) =>
      m.kind === 'offer' &&
      m.employer_id === employerId &&
      m.worker_id === workerId &&
      m.vacancy_id === vacancyId
    );
    if (match) return match.status !== 'declined' && match.status !== 'cancelled';
    return (database.offers || []).some(
      (o) => o.employer_id === employerId && o.worker_id === workerId && o.vacancy_id === vacancyId
    );
  },

  scoreWorkerAgainstVacancies: (worker, vacancies) => {
    const spec = (worker.specialization || '').toLowerCase();
    const workerText = `${worker.specialization || ''} ${worker.experience || ''} ${worker.about || ''} ${worker.skills || ''} ${worker.city || ''}`.toLowerCase();
    const specTokens = tokenize(worker.specialization);
    let bestScore = 0;
    let matchedVacancy = null;
    for (const vacancy of vacancies) {
      const hay = `${vacancy.job_title || ''} ${vacancy.description || ''} ${vacancy.requirements || ''}`.toLowerCase();
      let score = 0;
      if (spec && hay.includes(spec)) score += 5;
      for (const token of specTokens) {
        if (hay.includes(token)) score += 2;
      }
      for (const token of tokenize(vacancy.job_title)) {
        if (workerText.includes(token)) score += 2;
      }
      if (score > bestScore) {
        bestScore = score;
        matchedVacancy = vacancy;
      }
    }
    return {
      score: bestScore,
      matchedVacancy,
      recommended: bestScore >= 2
    };
  },

  getUniqueWorkerCities: (excludeUserId = null) => {
    const cities = database.workers
      .filter(w => w.is_active && (excludeUserId == null || w.user_id !== excludeUserId))
      .map(w => (w.city || '').trim())
      .filter(Boolean);
    return [...new Set(cities)].sort((a, b) => a.localeCompare(b, 'ru'));
  },

  getUniqueSpecializations: (excludeUserId = null) => {
    const specs = database.workers
      .filter(w => w.is_active && (excludeUserId == null || w.user_id !== excludeUserId))
      .map(w => (w.specialization || '').trim())
      .filter(Boolean);
    return [...new Set(specs)].sort((a, b) => a.localeCompare(b, 'ru'));
  },

  workerMatchesFilters: (worker, filters = {}) => {
    if (filters.city) {
      const city = (worker.city || '').toLowerCase();
      if (!city.includes(String(filters.city).toLowerCase())) return false;
    }
    if (filters.specialization) {
      const spec = String(filters.specialization).toLowerCase();
      const hay = `${worker.specialization || ''} ${worker.skills || ''} ${worker.experience || ''} ${worker.education || ''} ${worker.about || ''}`.toLowerCase();
      if (!hay.includes(spec)) return false;
    }
    if (filters.skills) {
      const skills = String(filters.skills).toLowerCase();
      const hay = `${worker.skills || ''} ${worker.experience || ''} ${worker.about || ''} ${worker.specialization || ''}`.toLowerCase();
      if (!hay.includes(skills)) return false;
    }
    const age = Number(worker.age);
    if (filters.ageMin != null && Number.isFinite(Number(filters.ageMin)) && !(age >= Number(filters.ageMin))) return false;
    if (filters.ageMax != null && Number.isFinite(Number(filters.ageMax)) && !(age <= Number(filters.ageMax))) return false;
    if (filters.gosuslugi && !worker.gosuslugi?.connected) return false;
    return true;
  },

  getRankedWorkers: (employerId, filters = {}) => {
    const vacancies = dbOperations.getEmployerVacancies(employerId);
    let workers = database.workers.filter(w => w.is_active && w.user_id !== employerId);
    workers = workers.filter(w => dbOperations.workerMatchesFilters(w, filters || {}));
    let ranked = workers
      .map(worker => {
        const match = dbOperations.scoreWorkerAgainstVacancies(worker, vacancies);
        return { ...worker, ...match };
      })
      .sort((a, b) => {
        if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
        return b.score - a.score;
      });
    if (filters.recommended) {
      ranked = ranked.filter(w => w.recommended);
    }
    return ranked;
  },

  getProfileDraft: (userId, kind = null) => {
    const drafts = database.profile_drafts || [];
    if (kind) return drafts.find((d) => d.user_id === userId && d.kind === kind) || null;
    return drafts.find((d) => d.user_id === userId && d.kind !== 'vacancy') || null;
  },

  saveProfileDraft: (userId, draft = {}) => {
    if (!database.profile_drafts) database.profile_drafts = [];
    const kind = draft.kind || 'worker';
    const existing = database.profile_drafts.find((d) => d.user_id === userId && d.kind === kind);
    const next = {
      user_id: userId,
      kind,
      state: draft.state || existing?.state,
      data: draft.data || existing?.data || {},
      updated_at: new Date().toISOString()
    };
    if (existing) {
      Object.assign(existing, next);
    } else {
      database.profile_drafts.push(next);
    }
    saveDb();
    return next;
  },

  clearProfileDraft: (userId, kind = null) => {
    database.profile_drafts = (database.profile_drafts || []).filter((d) => {
      if (d.user_id !== userId) return true;
      if (kind) return d.kind !== kind;
      return false;
    });
    saveDb();
  },

  getVacancyDraft: (userId) => dbOperations.getProfileDraft(userId, 'vacancy'),

  saveVacancyDraft: (userId, draft = {}) => dbOperations.saveProfileDraft(userId, { ...draft, kind: 'vacancy' }),

  clearVacancyDraft: (userId) => dbOperations.clearProfileDraft(userId, 'vacancy'),

  upsertStaffFromMatch: (match, persist = true) => {
    if (!match || match.status !== 'accepted') return null;
    if (!database.staff) database.staff = [];
    const vacancy = (database.vacancies || []).find((v) => v.id === match.vacancy_id);
    const position = vacancy?.job_title || 'сотрудник';
    let row = database.staff.find((s) =>
      Number(s.employer_id) === Number(match.employer_id)
      && Number(s.worker_id) === Number(match.worker_id)
      && Number(s.vacancy_id) === Number(match.vacancy_id)
    );
    if (row) {
      row.status = 'active';
      row.position = position;
      row.match_id = match.id;
      row.left_at = null;
      row.updated_at = new Date().toISOString();
    } else {
      row = {
        id: nextEntityId(database.staff),
        employer_id: match.employer_id,
        worker_id: match.worker_id,
        vacancy_id: match.vacancy_id,
        match_id: match.id,
        position,
        status: 'active',
        joined_at: match.updated_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      database.staff.push(row);
    }
    if (persist) saveDb();
    return row;
  },

  leaveStaffFromMatch: (match, persist = true) => {
    if (!match || !database.staff) return null;
    const row = database.staff.find((s) =>
      Number(s.employer_id) === Number(match.employer_id)
      && Number(s.worker_id) === Number(match.worker_id)
      && Number(s.vacancy_id) === Number(match.vacancy_id)
      && s.status === 'active'
    );
    if (!row) return null;
    row.status = 'left';
    row.left_at = new Date().toISOString();
    row.updated_at = row.left_at;
    if (persist) saveDb();
    return row;
  },

  decorateStaff: (row) => {
    if (!row) return null;
    const worker = (database.workers || []).find((w) => w.user_id === row.worker_id) || null;
    const vacancy = (database.vacancies || []).find((v) => v.id === row.vacancy_id) || null;
    const employer = (database.employers || []).find((e) => e.user_id === row.employer_id) || null;
    const offers = (database.dev_offers || []).filter((o) => o.staff_id === row.id);
    return { ...row, worker, vacancy, employer, offers };
  },

  getStaffById: (id) => {
    const row = (database.staff || []).find((s) => Number(s.id) === Number(id));
    return dbOperations.decorateStaff(row);
  },

  getCompanyStaff: (employerId) => {
    return (database.staff || [])
      .filter((s) => Number(s.employer_id) === Number(employerId) && s.status === 'active')
      .map(dbOperations.decorateStaff)
      .sort((a, b) => String(b.joined_at || '').localeCompare(String(a.joined_at || '')));
  },

  getWorkerEmployment: (workerId) => {
    return (database.staff || [])
      .filter((s) => Number(s.worker_id) === Number(workerId) && s.status === 'active')
      .map(dbOperations.decorateStaff);
  },

  createDevOffer: ({ staffId, kind, title, actorId }) => {
    const staff = dbOperations.getStaffById(staffId);
    if (!staff || staff.status !== 'active') return { ok: false, error: 'Сотрудник не найден в штате' };
    if (Number(actorId) !== Number(staff.employer_id)) {
      return { ok: false, error: 'Предложить развитие может только работодатель этой компании' };
    }
    if (!['internship', 'training'].includes(kind)) {
      return { ok: false, error: 'Можно предложить стажировку или обучение' };
    }
    if (!database.dev_offers) database.dev_offers = [];
    const pending = database.dev_offers.find((o) =>
      o.staff_id === staff.id && o.kind === kind && o.status === 'pending'
    );
    if (pending) return { ok: false, error: 'Такое предложение уже ожидает ответа', offer: pending };
    const offer = {
      id: nextEntityId(database.dev_offers),
      staff_id: staff.id,
      employer_id: staff.employer_id,
      worker_id: staff.worker_id,
      vacancy_id: staff.vacancy_id,
      kind,
      title: String(title || '').trim() || (kind === 'internship' ? 'Стажировка' : 'Обучение'),
      status: 'pending',
      created_at: new Date().toISOString()
    };
    database.dev_offers.push(offer);
    saveDb();
    return { ok: true, offer, staff: dbOperations.getStaffById(staff.id) };
  },

  getDevOfferById: (id) => {
    return (database.dev_offers || []).find((o) => Number(o.id) === Number(id)) || null;
  },

  setDevOfferStatus: (id, status, actorId) => {
    const offer = dbOperations.getDevOfferById(id);
    if (!offer) return { ok: false, error: 'Предложение не найдено' };
    if (Number(actorId) !== Number(offer.worker_id)) {
      return { ok: false, error: 'Ответить может только сотрудник' };
    }
    if (offer.status !== 'pending') {
      return { ok: false, error: 'Предложение уже обработано', offer };
    }
    if (!['accepted', 'declined'].includes(status)) {
      return { ok: false, error: 'Некорректный ответ' };
    }
    offer.status = status;
    offer.updated_at = new Date().toISOString();
    saveDb();
    return { ok: true, offer, staff: dbOperations.getStaffById(offer.staff_id) };
  },

  getWorkerDevOffers: (workerId) => {
    return (database.dev_offers || [])
      .filter((o) => Number(o.worker_id) === Number(workerId))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  },

  getActiveWorkers: () => {
    return database.workers.filter(w => w.is_active);
  }
};

function syncStaffFromAcceptedMatches() {
  for (const match of database.matches || []) {
    if (match.status === 'accepted') dbOperations.upsertStaffFromMatch(match, false);
  }
  saveDb();
}

syncStaffFromAcceptedMatches();

export default database;
