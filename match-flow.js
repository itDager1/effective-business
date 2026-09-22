import { dbOperations } from './db.js';
import { gosuslugiStatusLine } from './esia.js';
import { verificationLabel } from './egrul.js';

export function matchStatusLabel(status) {
  if (status === 'accepted') return 'принят, контакты открыты';
  if (status === 'declined') return 'отклонён';
  if (status === 'cancelled') return 'одобрение отменено';
  return 'ожидает ответа';
}

export function vacancyContact(vacancy, employer) {
  const name = String(vacancy?.contact_name || '').trim() || employer?.contact_person || '';
  const position = String(vacancy?.contact_position || '').trim();
  const phone = String(vacancy?.contact_phone || '').trim() || employer?.phone || '';
  return { name, position, phone };
}

export function isVacancyContactLabel(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  return text.length >= 2 && text.length <= 80;
}

export function formatVacancyContactLines(contact) {
  const positionLine = contact?.position ? `Должность контакта: ${contact.position}\n` : '';
  return `Сотрудник для связи: ${contact?.name || '—'}\n${positionLine}Телефон: ${contact?.phone || '—'}`;
}

export function formatMatchTitle(match) {
  const vacancy = match.vacancy || dbOperations.getVacancyById(match.vacancy_id);
  const worker = match.worker || dbOperations.getWorkerProfile(match.worker_id);
  const employer = match.employer || dbOperations.getEmployerProfile(match.employer_id);
  const job = vacancy?.job_title || 'вакансия';
  if (match.kind === 'application') {
    return `Отклик ${worker?.full_name || 'соискателя'} на «${job}»`;
  }
  return `Отклик «${employer?.company_name || 'компании'}» к ${worker?.full_name || 'соискателю'} по «${job}»`;
}

export function workerCardWithoutContacts(worker) {
  return `${gosuslugiStatusLine(worker)}\n` +
    `Имя: ${worker.full_name}\n` +
    `Возраст: ${worker.age}\n` +
    `Город: ${worker.city || '—'}\n` +
    `Специальность: ${worker.specialization}\n` +
    `Опыт: ${worker.experience}\n` +
    `Образование: ${worker.education || '—'}\n` +
    `Навыки: ${worker.skills || '—'}\n` +
    `О себе: ${worker.about || '—'}\n` +
    `Телефон: скрыт до принятия отклика`;
}

export function incomingMatchText(match) {
  const vacancy = match.vacancy || dbOperations.getVacancyById(match.vacancy_id);
  const worker = match.worker || dbOperations.getWorkerProfile(match.worker_id);
  const employer = match.employer || dbOperations.getEmployerProfile(match.employer_id);
  const job = vacancy?.job_title || 'вакансия';
  if (match.kind === 'application') {
    return `📩 Новый отклик на вакансию «${job}»\n\n` +
      `${worker ? workerCardWithoutContacts(worker) : 'Анкета соискателя'}\n\n` +
      `Контакты откроются, если вы нажмёте «Принять».`;
  }
  return `📩 Компания «${employer?.company_name || 'Работодатель'}» откликнулась на вашу анкету\n` +
    `${verificationLabel(employer)}\n\n` +
    `Вакансия: ${job}\n` +
    `Описание: ${vacancy?.description || '—'}\n` +
    `Требования: ${vacancy?.requirements || '—'}\n` +
    `Место: ${vacancy?.location || '—'}\n` +
    `Зарплата: ${vacancy?.salary || '—'}\n` +
    `Сезонность: ${vacancy?.seasonality || '—'}\n\n` +
    `Контакты компании откроются, если вы нажмёте «Принять».`;
}

export function sharedContactsText(match) {
  const vacancy = match.vacancy || dbOperations.getVacancyById(match.vacancy_id);
  const worker = match.worker || dbOperations.getWorkerProfile(match.worker_id);
  const employer = match.employer || dbOperations.getEmployerProfile(match.employer_id);
  const contact = vacancyContact(vacancy, employer);
  return `✅ Отклик принят. Контакты открыты обеим сторонам.\n\n` +
    `Вакансия: ${vacancy?.job_title || '—'}\n\n` +
    `Соискатель: ${worker?.full_name || '—'}\n${gosuslugiStatusLine(worker)}\nТелефон: ${worker?.phone || '—'}\n\n` +
    `Компания: ${employer?.company_name || '—'}\n${verificationLabel(employer)}\n` +
    formatVacancyContactLines(contact);
}

export function workerAcceptedNotice(match) {
  const vacancy = match.vacancy || dbOperations.getVacancyById(match.vacancy_id);
  const employer = match.employer || dbOperations.getEmployerProfile(match.employer_id);
  const job = vacancy?.job_title || 'вакансия';
  const contact = vacancyContact(vacancy, employer);
  return `✅ Работодатель принял ваш отклик на «${job}».\n\n` +
    `Контакты для связи:\n` +
    `Компания: ${employer?.company_name || '—'}\n` +
    `${verificationLabel(employer)}\n` +
    formatVacancyContactLines(contact);
}

export function employerAcceptedNotice(match) {
  const vacancy = match.vacancy || dbOperations.getVacancyById(match.vacancy_id);
  const worker = match.worker || dbOperations.getWorkerProfile(match.worker_id);
  const job = vacancy?.job_title || 'вакансия';
  return `✅ Вы приняли отклик на «${job}». Контакты соискателя открыты.\n\n` +
    `Имя: ${worker?.full_name || '—'}\n` +
    `${gosuslugiStatusLine(worker)}\n` +
    `Город: ${worker?.city || '—'}\n` +
    `Специальность: ${worker?.specialization || '—'}\n` +
    `Телефон: ${worker?.phone || '—'}`;
}

export function matchActionKeyboard(matchId) {
  return {
    attachments: [{
      type: 'inline_keyboard',
      payload: {
        buttons: [[
          { type: 'callback', text: 'Принять', payload: `acc_${matchId}` },
          { type: 'callback', text: 'Отклонить', payload: `dec_${matchId}` }
        ]]
      }
    }]
  };
}
