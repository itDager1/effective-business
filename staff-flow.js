export function developmentKindLabel(kind) {
  if (kind === 'internship') return 'стажировка';
  if (kind === 'training') return 'обучение';
  return kind || 'развитие';
}

export function developmentStatusLabel(status) {
  if (status === 'accepted') return 'принято';
  if (status === 'declined') return 'отклонено';
  return 'ожидает ответа';
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU');
}

export function formatStaffListItem(row, i) {
  const name = row.worker?.full_name || 'Сотрудник';
  const position = row.position || row.vacancy?.job_title || 'должность не указана';
  const pending = (row.offers || []).filter((o) => o.status === 'pending');
  const extra = pending.length
    ? `\n   Развитие: ${pending.map((o) => developmentKindLabel(o.kind)).join(', ')}`
    : '';
  return `${i + 1}. ${name}\n   Кем: ${position}\n   Вакансия: ${row.vacancy?.job_title || position}\n   В штате с ${formatDate(row.joined_at)}${extra}`;
}

export function formatStaffCard(row) {
  const worker = row.worker || {};
  const offers = row.offers || [];
  const offerLines = offers.length
    ? offers.map((o) =>
      `• ${developmentKindLabel(o.kind)} «${o.title}» — ${developmentStatusLabel(o.status)}`
    ).join('\n')
    : 'пока нет';
  return `👤 ${worker.full_name || 'Сотрудник'}\n` +
    `Кем работает: ${row.position || row.vacancy?.job_title || '—'}\n` +
    `Вакансия: ${row.vacancy?.job_title || '—'}\n` +
    `Город: ${worker.city || '—'}\n` +
    `Специальность: ${worker.specialization || '—'}\n` +
    `В штате с ${formatDate(row.joined_at)}\n\n` +
    `Развитие:\n${offerLines}`;
}

export function formatEmploymentCard(row) {
  const company = row.employer?.company_name || 'компания';
  return `Вы в штате «${company}».\n` +
    `Кем: ${row.position || row.vacancy?.job_title || '—'}\n` +
    `Вакансия: ${row.vacancy?.job_title || '—'}\n` +
    `С ${formatDate(row.joined_at)}`;
}

export function staffJoinedNotice(row) {
  const company = row.employer?.company_name || 'компанию';
  const position = row.position || row.vacancy?.job_title || 'сотрудник';
  return `🏢 Вы зачислены в штат «${company}» как ${position}. Работодатель видит вас в разделе «Кадры».`;
}

export function developmentOfferNotice(offer, staff) {
  const company = staff?.employer?.company_name || 'компания';
  const kind = developmentKindLabel(offer.kind);
  return `📘 «${company}» предлагает ${kind}: ${offer.title}\n\nПримите или отклоните предложение.`;
}

export function developmentActionKeyboard(offerId) {
  return {
    attachments: [{
      type: 'inline_keyboard',
      payload: {
        buttons: [[
          { type: 'callback', text: 'Принять', payload: `dya_${offerId}` },
          { type: 'callback', text: 'Отклонить', payload: `dyn_${offerId}` }
        ]]
      }
    }]
  };
}
