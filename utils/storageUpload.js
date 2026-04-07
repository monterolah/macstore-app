const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Sube un archivo a Cloudinary y devuelve su URL pública.
 */
async function uploadToStorage(fileBuffer, originalname, folder = 'uploads') {
  const buffer = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(String(fileBuffer), 'utf8');

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: `macstore/${folder}`, resource_type: 'image', unique_filename: true },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );
    uploadStream.end(buffer);
  });
}

module.exports = { uploadToStorage };
