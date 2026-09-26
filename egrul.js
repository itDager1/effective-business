const FNS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function innChecksum(digits, coeffs) {
  const sum = coeffs.reduce((acc, c, i) => acc + c * Number(digits[i]), 0);
  return (sum % 11) % 10;
}

export function normalizeInn(raw) {
  return String(raw || '').replace(/\D/g, '');
}

export function innChecksumValid(raw) {
  const inn = normalizeInn(raw);
  if (inn.length === 10) {
    return innChecksum(inn, [2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(inn[9]);
  }
  if (inn.length === 12) {
    return innChecksum(inn, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(inn[10])
      && innChecksum(inn, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(inn[11]);
  }
  return false;
}

export function isValidInn(raw) {
  const inn = normalizeInn(raw);
  return inn.length === 10 || inn.length === 12;
}

function normalizeFio(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^а-яa-z.\s-]/g, ' ')
    .replace(/(?:^|\s)(?:ип|индивидуальный|предприниматель|ооо|зао|оао|пао|ано|общество|ограниченной|ответственностью|генеральный|директор|руководитель|управляющий|президент|глава|кфх)(?=\s|$)/g, ' ')
    .replace(/[-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fioTokens(value) {
  const words = normalizeFio(value).split(' ').filter(Boolean);
  const tokens = [];
  for (const word of words) {
    if (/^[а-яa-z](\.[а-яa-z])+\.?$/.test(word)) {
      tokens.push(...word.split('.').filter(Boolean));
    } else {
      tokens.push(word.replace(/\./g, ''));
    }
  }
  return tokens.filter((t) => t.length > 0);
}

function nameTokenMatch(a, b) {
  if (!a || !b) return true;
  if (a.length === 1 || b.length === 1) return a[0] === b[0];
  return a === b;
}

export function fioMatches(claimed, official) {
  const a = fioTokens(claimed);
  const b = fioTokens(official);
  if (a.length < 2 || b.length < 2) return false;
  return nameTokenMatch(a[0], b[0]) && nameTokenMatch(a[1], b[1]) && nameTokenMatch(a[2], b[2]);
}

const ADDR_STOP = new Set([
  'россия', 'рф', 'г', 'гор', 'город', 'ул', 'улица', 'д', 'дом', 'кв', 'квартира',
  'офис', 'оф', 'стр', 'строение', 'корп', 'корпус', 'пом', 'помещение', 'пр',
  'проспект', 'пер', 'переулок', 'обл', 'область', 'край', 'респ', 'республика',
  'рн', 'район', 'индекс', 'литер', 'лит', 'эт', 'этаж', 'ком', 'комната'
]);

function addressTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\d{6}/g, ' ')
    .replace(/[^а-яa-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && t.length > 1 && !ADDR_STOP.has(t));
}

export function hasPostalIndex(address) {
  return /\d{6}/.test(String(address || ''));
}

export function addressMatches(claimed, official) {
  const a = addressTokens(claimed);
  const b = new Set(addressTokens(official));
  if (a.length < 2 || b.size < 2) return false;
  const hit = a.filter((t) => b.has(t)).length;
  return hit >= 2 && hit / a.length >= 0.55;
}

async function fnsSearch(query) {
  const body = new URLSearchParams({
    query,
    vyp3CaptchaToken: '',
    page: '',
    region: '',
    PreventChromeAutocomplete: ''
  });
  const start = await fetch('https://egrul.nalog.ru/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': FNS_UA,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: 'https://egrul.nalog.ru/index.html'
    },
    body
  });
  if (!start.ok) {
    throw new Error(`ФНС недоступна (${start.status})`);
  }
  const tokenJson = await start.json();
  if (tokenJson.captchaRequired) {
    throw new Error('ФНС запросила капчу. Повторите проверку чуть позже.');
  }
  const token = tokenJson.t;
  if (!token) {
    throw new Error('ФНС не вернула результат поиска.');
  }
  await new Promise((resolve) => setTimeout(resolve, 900));
  const result = await fetch(`https://egrul.nalog.ru/search-result/${token}`, {
    headers: {
      'User-Agent': FNS_UA,
      Accept: 'application/json',
      Referer: 'https://egrul.nalog.ru/index.html'
    }
  });
  if (!result.ok) {
    throw new Error(`ФНС недоступна (${result.status})`);
  }
  let data = {};
  try {
    data = await result.json();
  } catch (err) {
    throw new Error(`ФНС вернула не JSON: ${err.message}`);
  }
  return Array.isArray(data.rows) ? data.rows : [];
}

function parseRow(row, inn) {
  if (!row) return null;
  const isIp = inn.length === 12 || /ип|индивидуальн/i.test(`${row.n || ''} ${row.k || ''}`);
  return {
    inn: String(row.i || inn),
    ogrn: String(row.o || row.c || ''),
    name: String(row.n || ''),
    address: String(row.a || ''),
    director: String(row.g || (isIp ? row.n : '') || ''),
    registry: isIp ? 'egrip' : 'egrul'
  };
}

export async function lookupOrganization(inn) {
  const rows = await fnsSearch(inn);
  const match = rows.find((row) => String(row.i || '').replace(/\D/g, '') === inn) || rows[0];
  return parseRow(match, inn);
}

export async function verifyEmployerRegistry({ inn, directorFio, legalAddress }) {
  try {
    return await verifyEmployerRegistryUnsafe({ inn, directorFio, legalAddress });
  } catch (err) {
    console.error('[EGRUL]', err);
    return {
      ok: false,
      status: 'unavailable',
      checked_at: new Date().toISOString(),
      error: 'Сервис ФНС сейчас не ответил. Профиль сохранён, повторите проверку позже.'
    };
  }
}

async function verifyEmployerRegistryUnsafe({ inn, directorFio, legalAddress }) {
  const innNorm = normalizeInn(inn);
  if (!isValidInn(innNorm)) {
    return {
      ok: false,
      status: 'failed',
      error: 'ИНН указан некорректно. Для юрлица — 10 цифр, для ИП — 12.'
    };
  }
  if (!innChecksumValid(innNorm)) {
    return { ok: false, status: 'failed', error: 'ИНН не проходит проверку контрольных цифр — проверьте номер.' };
  }
  if (!normalizeFio(directorFio) || normalizeFio(directorFio).split(' ').length < 2) {
    return { ok: false, status: 'failed', error: 'Укажите ФИО руководителя полностью, как в ЕГРЮЛ или ЕГРИП.' };
  }
  if (!hasPostalIndex(legalAddress) || addressTokens(legalAddress).length < 2) {
    return { ok: false, status: 'failed', error: 'Укажите юридический адрес полностью: индекс, регион, город, улица, дом.' };
  }

  const record = await lookupOrganization(innNorm);
  if (!record) {
    return { ok: false, status: 'failed', error: 'Организация с таким ИНН не найдена в ЕГРЮЛ/ЕГРИП.' };
  }

  const directorOfficial = record.registry === 'egrip' ? `${record.director} ${record.name}` : record.director;
  const directorMatch = fioMatches(directorFio, directorOfficial);
  const addressMatch = addressMatches(legalAddress, record.address);
  const ok = directorMatch && addressMatch;
  return {
    ok,
    status: ok ? 'verified' : 'failed',
    registry: record.registry,
    director_match: directorMatch,
    address_match: addressMatch,
    fetched_name: record.name,
    fetched_address: record.address,
    fetched_director: record.director,
    ogrn: record.ogrn,
    inn: record.inn,
    checked_at: new Date().toISOString(),
    error: ok
      ? null
      : [
          directorMatch ? null : 'ФИО руководителя не совпадает с записью в реестре',
          addressMatch ? null : 'Юридический адрес не совпадает с записью в реестре'
        ].filter(Boolean).join('. ')
  };
}

export function verificationLabel(profile) {
  const v = profile?.verification;
  if (v?.status === 'verified' && v.director_match && v.address_match) {
    const reg = v.registry === 'egrip' ? 'ЕГРИП' : 'ЕГРЮЛ';
    return `✅ Компания подтверждена по ${reg}`;
  }
  if (v?.status === 'failed') return `❌ Компания не подтверждена: ${v.error || 'данные не совпали с реестром ФНС'}`;
  if (v?.status === 'unavailable') return '⚠️ Компания не подтверждена: ФНС не ответила, проверка будет повторена';
  return '⚠️ Компания не подтверждена по ЕГРЮЛ/ЕГРИП';
}

export function publicVerificationLabel(profile) {
  if (isEmployerVerified(profile)) {
    return `✅ Компания подтверждена по ${profile.verification.registry === 'egrip' ? 'ЕГРИП' : 'ЕГРЮЛ'}`;
  }
  return '⚠️ Компания не подтверждена по ЕГРЮЛ/ЕГРИП';
}

export function isEmployerVerified(profile) {
  const v = profile?.verification;
  return Boolean(v && v.status === 'verified' && v.director_match && v.address_match && !v.demo);
}

export function vacancyGateMessage(profile) {
  if (!profile) {
    return 'Сначала заполните профиль компании.';
  }
  return null;
}
