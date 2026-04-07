# MacStore Firebase

Proyecto Node.js + Express + EJS para catálogo, administración, cotizaciones PDF y Firebase.

## Cambios aplicados en esta versión

- Se eliminó la dependencia obligatoria de `serviceAccountKey.json` cuando existe `FIREBASE_SERVICE_ACCOUNT` en `.env`.
- Mensaje de error de Firebase más claro si falta la credencial.
- La sesión usa un secreto propio y más seguro.
- Se corrigió el middleware de autenticación para no depender de cookies no configuradas.
- Se endureció la validación básica en productos.
- Se bajaron límites de subida de archivos.
- Se protegieron endpoints de cotizaciones con token admin.
- Se desactivó el seed demo automático en producción.

## Instalación

```bash
npm install
cp .env.example .env
```

## Variables mínimas

- `JWT_SECRET`
- `SESSION_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `FIREBASE_SERVICE_ACCOUNT`
- `FIREBASE_STORAGE_BUCKET`

## Desarrollo

```bash
npm run dev
```

## Producción

```bash
npm start
```

## Nota sobre Firebase

Puedes usar una de estas dos opciones:

1. Recomendada: `FIREBASE_SERVICE_ACCOUNT` en `.env` como JSON en una sola línea.
2. Solo desarrollo local: archivo `serviceAccountKey.json` en la raíz del proyecto.
