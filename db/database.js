const { getFirestore } = require('./firebase');
const bcrypt = require('bcryptjs');

async function initializeDB() {
  const db = getFirestore();
  const isProd = process.env.NODE_ENV === 'production';

  try {
    await db.collection('_test').limit(1).get();
  } catch (e) {
    throw new Error('No se puede conectar a Firestore: ' + e.message);
  }

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@macstore.com';
  const adminPass = process.env.ADMIN_PASSWORD || 'Admin123!';

  if (isProd && (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD)) {
    throw new Error('En producción debes definir ADMIN_EMAIL y ADMIN_PASSWORD');
  }

  const adminSnap = await db.collection('admins').where('email', '==', adminEmail).limit(1).get();
  if (adminSnap.empty) {
    const hash = bcrypt.hashSync(adminPass, 12);
    await db.collection('admins').add({
      email: adminEmail,
      password: hash,
      name: 'Administrador MacStore',
      createdAt: new Date()
    });
    console.log('✅ Admin creado:', adminEmail);
  }

  const settingsDoc = await db.collection('settings').doc('main').get();
  if (!settingsDoc.exists) {
    await db.collection('settings').doc('main').set({
      store_name: 'MacStore',
      store_tagline: 'Distribuidor Autorizado Apple',
      store_phone: '+503 0000-0000',
      store_email: 'ventas@macstore.com',
      store_address: 'El Salvador',
      store_whatsapp: '50300000000',
      promo_bar_text: 'Hasta 12 cuotas sin intereses · Envío gratis en compras mayores a $500',
      promo_bar_active: true,
      logo_url: ''
    });
    console.log('✅ Settings creados');
  }

  if (!isProd && process.env.SEED_DEMO === 'true') {
    const catsSnap = await db.collection('categories').limit(1).get();
    if (catsSnap.empty) {
      const cats = [
        { name: 'Mac', slug: 'mac', sort_order: 1, active: true },
        { name: 'iPhone', slug: 'iphone', sort_order: 2, active: true },
        { name: 'iPad', slug: 'ipad', sort_order: 3, active: true },
        { name: 'Apple Watch', slug: 'apple-watch', sort_order: 4, active: true },
        { name: 'AirPods', slug: 'airpods', sort_order: 5, active: true },
        { name: 'Accesorios', slug: 'accesorios', sort_order: 6, active: true }
      ];
      for (const c of cats) await db.collection('categories').add(c);
      console.log('✅ Categorías demo creadas');
    }

    const prodsSnap = await db.collection('products').limit(1).get();
    if (prodsSnap.empty) {
      const prods = [
        { name: 'MacBook Pro 14"', slug: 'macbook-pro-14', category: 'mac', price: 1999, original_price: 2199, badge: 'Nuevo', featured: true, active: true, stock: 15, description: 'Chip M3 Pro. Hasta 22 horas de batería.', image_url: '', specs: { Chip: 'Apple M3 Pro', RAM: '18 GB' }, color_variants: [], sort_order: 1, createdAt: new Date() }
      ];
      for (const p of prods) await db.collection('products').add(p);
      console.log('✅ Productos demo creados');
    }
  }

  console.log('✅ Firebase Firestore listo — MacStore');
}

module.exports = { initializeDB };
