const FAKE_TAILS = new Set([
  '0000000', '1111111', '2222222', '3333333', '4444444',
  '5555555', '6666666', '7777777', '8888888', '9999999',
  '0000001', '1000000', '1212121', '1010101'
]);

const COUNTRY_CODES = new Set([
  '1', '7',
  '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49',
  '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66',
  '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98',
  '211', '212', '213', '216', '218', '220', '221', '222', '223', '224', '225', '226', '227', '228', '229',
  '230', '231', '232', '233', '234', '235', '236', '237', '238', '239', '240', '241', '242', '243', '244',
  '245', '246', '247', '248', '249', '250', '251', '252', '253', '254', '255', '256', '257', '258',
  '260', '261', '262', '263', '264', '265', '266', '267', '268', '269',
  '290', '291', '297', '298', '299',
  '350', '351', '352', '353', '354', '355', '356', '357', '358', '359',
  '370', '371', '372', '373', '374', '375', '376', '377', '378', '380', '381', '382', '383', '385', '386', '387', '389',
  '420', '421', '423',
  '500', '501', '502', '503', '504', '505', '506', '507', '508', '509',
  '590', '591', '592', '593', '594', '595', '596', '597', '598', '599',
  '670', '672', '673', '674', '675', '676', '677', '678', '679', '680', '681', '682', '683', '685', '686', '687', '688', '689',
  '690', '691', '692',
  '850', '852', '853', '855', '856', '880', '886',
  '960', '961', '962', '963', '964', '965', '966', '967', '968', '970', '971', '972', '973', '974', '975', '976', '977',
  '992', '993', '994', '995', '996', '998'
]);

function extractDigits(raw) {
  const compact = String(raw || '').trim();
  const spaced = compact.replace(/[\s()-]/g, '');
  const hadPlus = spaced.startsWith('+');
  let digits = compact.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  return { compact, hadPlus, digits };
}

function splitCountry(digits) {
  for (const size of [3, 2, 1]) {
    const code = digits.slice(0, size);
    if (COUNTRY_CODES.has(code)) {
      return { code, national: digits.slice(size) };
    }
  }
  return null;
}

export function normalizePhone(raw) {
  const { hadPlus, digits } = extractDigits(raw);
  if (!hadPlus && digits.length === 10 && digits.startsWith('9')) return `7${digits}`;
  if (!hadPlus && digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`;
  return digits;
}

function looksFake(national) {
  const unique = new Set(national);
  if (unique.size < 4) return true;
  if (isSequential(national)) return true;
  if (national.length >= 7 && FAKE_TAILS.has(national.slice(-7))) return true;
  return false;
}

export function formatPhone(raw) {
  const digits = normalizePhone(raw);
  const parsed = splitCountry(digits);
  if (parsed?.code === '7' && digits.length === 11) {
    return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9, 11)}`;
  }
  if (parsed?.national) {
    const n = parsed.national;
    if (n.length >= 8) {
      return `+${parsed.code} ${n.slice(0, n.length - 6)} ${n.slice(-6, -4)}-${n.slice(-4, -2)}-${n.slice(-2)}`.replace(/\s+/g, ' ').trim();
    }
    return `+${parsed.code} ${n}`;
  }
  return digits ? `+${digits}` : String(raw || '').trim();
}

function isSequential(digits) {
  let best = 1;
  let run = 1;
  let dir = 0;
  for (let i = 1; i < digits.length; i += 1) {
    const diff = Number(digits[i]) - Number(digits[i - 1]);
    if (diff === 1 || diff === -1) {
      if (dir === diff || dir === 0) {
        run += 1;
        dir = diff;
      } else {
        run = 2;
        dir = diff;
      }
      if (run > best) best = run;
    } else {
      run = 1;
      dir = 0;
    }
  }
  return best >= 9;
}

function validateRussiaOrKz(digits) {
  if (digits.length !== 11 || !digits.startsWith('7')) return null;
  const national = digits.slice(1);
  if (looksFake(national)) {
    return { ok: false, error: 'Похоже на случайный набор цифр. Укажите реальный номер телефона.' };
  }
  const first = national[0];
  if (!['3', '4', '5', '6', '7', '8', '9'].includes(first)) {
    return { ok: false, error: 'Код оператора или города для номера +7 указан неверно.' };
  }
  return { ok: true, phone: formatPhone(digits), digits };
}

export function validatePhone(raw) {
  const { compact, hadPlus } = extractDigits(raw);
  if (!compact) {
    return { ok: false, error: 'Укажите телефон: +7 921 123-45-67 или зарубежный в формате +375 29 123-45-67' };
  }
  if (/[a-zA-Zа-яА-Я]/.test(compact)) {
    return { ok: false, error: 'В номере не должно быть букв. Укажите реальный телефон.' };
  }

  const digits = normalizePhone(raw);
  if (digits.length < 8 || digits.length > 15) {
    return { ok: false, error: 'Номер должен содержать от 8 до 15 цифр в международном формате, например +48 501 234 567' };
  }

  const ru = validateRussiaOrKz(digits);
  if (ru) return ru;

  const from00 = String(raw || '').trim().replace(/[\s()-]/g, '').startsWith('00');
  if (!hadPlus && !from00) {
    return {
      ok: false,
      error: 'Зарубежный номер укажите с кодом страны: +375 29 123-45-67, +48 501 234 567 или 00 49 151 12345678'
    };
  }
  const parsed = splitCountry(digits);
  if (!parsed || parsed.national.length < 4) {
    return {
      ok: false,
      error: 'Не удалось распознать код страны. Для зарубежного номера начните с +, например +49 151 12345678'
    };
  }
  if (parsed.code === '1' && parsed.national.length !== 10) {
    return { ok: false, error: 'Для США и Канады нужен формат +1 и 10 цифр, например +1 415 555 2671' };
  }
  if (looksFake(parsed.national)) {
    return { ok: false, error: 'Похоже на случайный набор цифр. Укажите реальный номер телефона.' };
  }
  return { ok: true, phone: formatPhone(digits), digits };
}

export function isMeaningfulText(raw, minLen = 40) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (text.length < minLen) return false;
  const letters = text.replace(/[^a-zA-Zа-яА-ЯёЁ]/g, '');
  if (letters.length < Math.max(20, Math.floor(minLen * 0.45))) return false;
  if (new Set(letters.toLowerCase()).size < 8) return false;
  return true;
}
