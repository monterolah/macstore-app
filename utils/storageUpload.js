const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getStorage } = require('../db/firebase');

/**
 * Detecta el tipo MIME de imágenes comunes desde el contenido del buffer.
 * @param {Buffer} buffer
 * @returns {string|null}
 */
function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47]))) return 'image/png';
  if (buffer.slice(0, 3).equals(Buffer.from([0xFF, 0xD8, 0xFF]))) return 'image/jpeg';
  if (buffer.slice(0, 6).toString('ascii') === 'GIF89a' || buffer.slice(0, 6).toString('ascii') === 'GIF87a') return 'image/gif';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function getExtensionForMimeType(mime) {
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg'
  };
  return map[mime] || '';
}

/**
 * Sube un archivo al Firebase Storage y devuelve su URL pública.
 * @param {Buffer|string} fileBuffer - buffer del archivo o ruta local
 * @param {string} originalname - nombre original del archivo
 * @param {string} folder - carpeta destino en Storage (ej: 'products', 'banners')
 * @returns {Promise<string>} URL pública del archivo
 */
async function uploadToStorage(fileBuffer, originalname, folder = 'uploads') {
  const bucket = getStorage();
  const buffer = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(String(fileBuffer), 'utf8');
  const actualMime = detectImageMime(buffer);
  const fileExt = path.extname(originalname).toLowerCase() || getExtensionForMimeType(actualMime) || '.bin';
  const finalExt = actualMime ? getExtensionForMimeType(actualMime) || fileExt : fileExt;
  const filename = `${folder}/${uuidv4()}${finalExt}`;
  const contentType = actualMime || getMimeType(finalExt) || 'application/octet-stream';

  const file = bucket.file(filename);
  const token = uuidv4();

  await file.save(buffer, {
    metadata: {
      contentType,
      metadata: { firebaseStorageDownloadTokens: token }
    }
  });

  const bucketName = bucket.name;
  const encodedFilename = encodeURIComponent(filename);
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodedFilename}?alt=media&token=${token}`;
}

function getMimeType(ext) {
  const types = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml'
  };
  return types[ext] || 'application/octet-stream';
}

module.exports = { uploadToStorage };
