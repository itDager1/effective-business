import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { dbOperations } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, 'miniapp', 'uploads');
const OUT_W = 900;
const OUT_H = 1200;

export function localPortraitPath(userId, ext = 'jpg') {
  return path.join(UPLOADS_DIR, `${userId}.${ext}`);
}

export function findLocalPortrait(userId) {
  for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
    const filePath = localPortraitPath(userId, ext);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

export function publicPortraitUrl(userId) {
  const local = findLocalPortrait(userId);
  if (!local) return null;
  const name = path.basename(local);
  const base = (process.env.MINI_APP_URL || `http://localhost:${process.env.MINI_APP_PORT || 8080}`).replace(/\/$/, '');
  const suffix = `?v=${fs.statSync(local).mtimeMs}`;
  return base ? `${base}/uploads/${name}${suffix}` : `/uploads/${name}${suffix}`;
}

export async function cropToPortrait34(buffer) {
  return sharp(buffer)
    .rotate()
    .resize(OUT_W, OUT_H, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 88 })
    .toBuffer();
}

async function downloadBuffer(url) {
  const headers = {};
  if (process.env.BOT_TOKEN) headers.Authorization = process.env.BOT_TOKEN;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Не удалось скачать фото: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export function collectImageUrls(value, acc = []) {
  if (!value) return acc;
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    acc.push(value);
    return acc;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectImageUrls(item, acc));
    return acc;
  }
  if (typeof value === 'object') {
    if (typeof value.url === 'string') collectImageUrls(value.url, acc);
    Object.values(value).forEach((item) => collectImageUrls(item, acc));
  }
  return acc;
}

function scoreImageUrl(url) {
  const match = String(url).match(/(\d{2,5})x(\d{2,5})/i);
  if (match) return Number(match[1]) * Number(match[2]);
  return url.length;
}

export function pickBestImageUrl(photo) {
  const urls = collectImageUrls(photo);
  if (!urls.length) return null;
  return urls.sort((a, b) => scoreImageUrl(b) - scoreImageUrl(a))[0];
}

async function resolvePhotoBuffer(photo, ownerUserId) {
  if (photo?.buffer) return photo.buffer;
  const urls = [];
  const best = pickBestImageUrl(photo);
  if (best) urls.push(best);
  const sourceUrl = typeof photo === 'string' ? photo : photo?.url;
  if (sourceUrl && /^https?:\/\//i.test(sourceUrl) && !urls.includes(sourceUrl)) urls.push(sourceUrl);
  for (const url of urls) {
    try {
      return await downloadBuffer(url);
    } catch (err) {
      console.error('[PHOTO] Скачивание не удалось:', url, err.message);
    }
  }
  if (sourceUrl && sourceUrl.startsWith('/uploads/')) {
    const name = sourceUrl.split('?')[0].split('/').pop();
    const filePath = path.join(UPLOADS_DIR, name);
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath);
  }
  const local = findLocalPortrait(ownerUserId);
  if (local) return fs.readFileSync(local);
  return null;
}

async function uploadToMax(api, filePath) {
  if (!api?.uploadImage) return {};
  try {
    const uploaded = await api.uploadImage({ source: filePath });
    const json = typeof uploaded?.toJson === 'function' ? uploaded.toJson() : uploaded;
    return {
      token: json?.payload?.token || uploaded?.token || null,
      photos: json?.payload?.photos || uploaded?.photos || json?.photos || uploaded?.photos || null,
      url: json?.payload?.url || uploaded?.url || null
    };
  } catch (err) {
    console.error('[PHOTO] Не удалось загрузить кадр 3×4 в MAX:', err.message);
    return {};
  }
}

export async function processPortraitPhoto(ownerUserId, photo, api) {
  if (!photo && !findLocalPortrait(ownerUserId)) return null;

  const buffer = await resolvePhotoBuffer(photo, ownerUserId);
  if (!buffer) {
    console.error('[PHOTO] Нет исходника для кадрирования 3×4', photo);
    return photo || null;
  }

  const cropped = await cropToPortrait34(buffer);
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  for (const ext of ['jpeg', 'png', 'webp']) {
    const extra = localPortraitPath(ownerUserId, ext);
    if (fs.existsSync(extra)) fs.unlinkSync(extra);
  }
  const filePath = localPortraitPath(ownerUserId, 'jpg');
  fs.writeFileSync(filePath, cropped);

  const maxPayload = await uploadToMax(api, filePath);
  const stored = {
    type: 'image',
    url: publicPortraitUrl(ownerUserId),
    token: maxPayload.token || null,
    photos: maxPayload.photos || null,
    photo_id: null,
    portrait: true
  };
  const existing = dbOperations.getWorkerProfile(ownerUserId);
  if (existing) dbOperations.updateWorkerPhoto(ownerUserId, stored);
  return stored;
}

export async function ensurePortraitPhoto(ownerUserId, photo, api) {
  if (!photo && !findLocalPortrait(ownerUserId)) return null;
  if (photo?.portrait && (photo.photos || photo.token)) {
    return photo;
  }
  const local = findLocalPortrait(ownerUserId);
  if (local && photo?.portrait) {
    const maxPayload = await uploadToMax(api, local);
    const stored = {
      type: 'image',
      url: publicPortraitUrl(ownerUserId),
      token: maxPayload.token || photo.token || null,
      photos: maxPayload.photos || photo.photos || null,
      photo_id: photo.photo_id || null,
      portrait: true
    };
    const existing = dbOperations.getWorkerProfile(ownerUserId);
    if (existing) dbOperations.updateWorkerPhoto(ownerUserId, stored);
    return stored;
  }
  try {
    return await processPortraitPhoto(ownerUserId, photo, api);
  } catch (err) {
    console.error('[PHOTO] Не удалось привести фото к 3×4:', err.message);
    return photo || null;
  }
}
