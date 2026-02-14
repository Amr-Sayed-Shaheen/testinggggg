const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', '..', 'public', 'images'),
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname.replace(/\s/g, '-'));
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) cb(null, true);
    else cb(null, false);
  },
  limits: { fileSize: 10 * 1024 * 1024 }
});

function handleUpload(fieldName, maxCount) {
  return (req, res, next) => {
    const uploader = upload.array(fieldName, maxCount);
    uploader(req, res, (err) => {
      if (err) {
        console.error('Upload error:', err);
        req.uploadError = err.message || 'Upload failed';
      }
      next();
    });
  };
}

function requireAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  res.redirect('/admin/login');
}

function requirePermission(...keys) {
  return (req, res, next) => {
    if (req.session.isSuperAdmin) return next();
    const userPerms = req.session.permissions || [];
    const hasAll = keys.every((k) => userPerms.includes(k));
    if (hasAll) return next();
    res.status(403).render('admin/no-access');
  };
}

router.get('/login', (req, res) => {
  res.render('admin/login', { error: null });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await pool.query('SELECT * FROM admin_users WHERE username = $1', [username]);

    if (result.rows.length === 0) {
      return res.render('admin/login', { error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // IMPORTANT: plain password mode (no hashing)
    const stored = user.password_hash;
    if (typeof stored !== 'string' || stored.length === 0) {
      return res.render('admin/login', { error: 'Invalid credentials' });
    }

    const valid = (password === stored);
    if (!valid) {
      return res.render('admin/login', { error: 'Invalid credentials' });
    }

    req.session.isAdmin = true;
    req.session.adminUserId = user.id;
    req.session.adminUsername = user.username;
    req.session.isSuperAdmin = user.is_super_admin || false;

    // role handling (optional)
    req.session.permissions = [];
    req.session.roleName = 'No Role';

    if (user.role_id) {
      try {
        const perms = await pool.query(
          `
          SELECT p.key FROM permissions p
          JOIN role_permissions rp ON rp.permission_id = p.id
          WHERE rp.role_id = $1
        `,
          [user.role_id]
        );
        req.session.permissions = perms.rows.map((r) => r.key);

        const roleResult = await pool.query('SELECT name FROM roles WHERE id = $1', [user.role_id]);
        req.session.roleName = roleResult.rows.length > 0 ? roleResult.rows[0].name : 'No Role';
      } catch (e) {
        console.error('Role/permissions load failed:', e);
      }
    }

    return res.redirect('/admin');
  } catch (err) {
    console.error(err);
    return res.render('admin/login', { error: 'Server error' });
  }
});

router.get('/logout', (req, res) => {
  req.session.isAdmin = false;
  req.session.adminUserId = null;
  req.session.isSuperAdmin = false;
  req.session.permissions = [];
  req.session.roleName = null;
  res.redirect('/');
});

router.get('/', requireAdmin, requirePermission('view_dashboard'), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 10;
    const offset = (page - 1) * limit;

    const productCount = await pool.query('SELECT COUNT(*) FROM products');
    const totalProducts = parseInt(productCount.rows[0].count);
    const totalPages = Math.ceil(totalProducts / limit);

    const products = await pool.query(
      `
      SELECT p.*, c.name as category_name
      FROM products p LEFT JOIN categories c ON p.category_id = c.id
      ORDER BY p.created_at DESC
      LIMIT $1 OFFSET $2
    `,
      [limit, offset]
    );

    const orders = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 20');
    const categories = await pool.query('SELECT * FROM categories ORDER BY name');

    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM products) as product_count,
        (SELECT COUNT(*) FROM orders) as order_count,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE status IN ('processing', 'shipped', 'delivered')) as total_revenue,
        (SELECT COUNT(*) FROM customers) as customer_count
    `);

    res.render('admin/dashboard', {
      products: products.rows,
      orders: orders.rows,
      categories: categories.rows,
      stats: stats.rows[0],
      page,
      totalPages
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

router.get('/products/new', requireAdmin, requirePermission('manage_products'), async (req, res) => {
  const categories = await pool.query('SELECT * FROM categories ORDER BY name');
  res.render('admin/product-form', { product: null, categories: categories.rows, images: [], error: null });
});

router.post('/products/new', requireAdmin, requirePermission('manage_products'), handleUpload('images', 10), async (req, res) => {
  const { name, description, price, category_id, stock, main_image_index } = req.body;

  const perkFreeDelivery = req.body.perk_free_delivery === 'on';
  const perkFreeReturns = req.body.perk_free_returns === 'on';
  const perkBuyNowPayLater = req.body.perk_buy_now_pay_later === 'on';
  const perkNextDayRiyadh = req.body.perk_next_day_riyadh === 'on';

  const perkFreeDeliveryText = req.body.perk_free_delivery_text || 'Free Delivery on All Orders';
  const perkFreeReturnsText = req.body.perk_free_returns_text || 'FREE 15-Day Returns';
  const perkBuyNowPayLaterText = req.body.perk_buy_now_pay_later_text || 'Buy Now, Pay Later with Tamara & Tabby';
  const perkNextDayRiyadhText = req.body.perk_next_day_riyadh_text || 'Free Next Day Delivery in Riyadh';

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const firstImageUrl = (req.files && req.files.length > 0) ? `/images/${req.files[0].filename}` : '/images/placeholder.png';
    const mainIdx = parseInt(main_image_index) || 0;
    const mainImageUrl = (req.files && req.files[mainIdx]) ? `/images/${req.files[mainIdx].filename}` : firstImageUrl;

    const result = await client.query(
      `INSERT INTO products
       (name, description, price, category_id, image_url, stock,
        perk_free_delivery, perk_free_returns, perk_buy_now_pay_later, perk_next_day_riyadh,
        perk_free_delivery_text, perk_free_returns_text, perk_buy_now_pay_later_text, perk_next_day_riyadh_text)
       VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        name,
        description,
        price,
        category_id || null,
        mainImageUrl,
        stock || 0,
        perkFreeDelivery,
        perkFreeReturns,
        perkBuyNowPayLater,
        perkNextDayRiyadh,
        perkFreeDeliveryText,
        perkFreeReturnsText,
        perkBuyNowPayLaterText,
        perkNextDayRiyadhText
      ]
    );

    const productId = result.rows[0].id;

    if (req.files && req.files.length > 0) {
      for (let i = 0; i < req.files.length; i++) {
        const imgUrl = `/images/${req.files[i].filename}`;
        const isMain = (i === mainIdx);
        await client.query(
          'INSERT INTO product_images (product_id, image_url, is_main, sort_order) VALUES ($1, $2, $3, $4)',
          [productId, imgUrl, isMain, i]
        );
      }
    }

    await client.query('COMMIT');
    res.redirect('/admin');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);

    const categories = await pool.query('SELECT * FROM categories ORDER BY name');
    res.render('admin/product-form', { product: null, categories: categories.rows, images: [], error: 'Failed to create product' });
  } finally {
    client.release();
  }
});

/* باقي الملف كما هو عندك بعد النقطة دي */
module.exports = router;
