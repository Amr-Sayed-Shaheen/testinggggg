const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const bcrypt = require('bcryptjs');
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
    const hasAll = keys.every(k => userPerms.includes(k));
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

    // IMPORTANT: use password_hash (not password)
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.render('admin/login', { error: 'Invalid credentials' });
    }

    req.session.isAdmin = true;
    req.session.adminUserId = user.id;
    req.session.adminUsername = user.username;
    req.session.isSuperAdmin = user.is_super_admin || false;

    if (user.role_id) {
      const perms = await pool.query(`
        SELECT p.key FROM permissions p
        JOIN role_permissions rp ON rp.permission_id = p.id
        WHERE rp.role_id = $1
      `, [user.role_id]);
      req.session.permissions = perms.rows.map(r => r.key);
      const roleResult = await pool.query('SELECT name FROM roles WHERE id = $1', [user.role_id]);
      req.session.roleName = roleResult.rows.length > 0 ? roleResult.rows[0].name : 'No Role';
    } else {
      req.session.permissions = [];
      req.session.roleName = 'No Role';
    }

    res.redirect('/admin');
  } catch (err) {
    console.error(err);
    res.render('admin/login', { error: 'Server error' });
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

    const products = await pool.query(`
      SELECT p.*, c.name as category_name
      FROM products p LEFT JOIN categories c ON p.category_id = c.id
      ORDER BY p.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

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
      'INSERT INTO products (name, description, price, category_id, image_url, stock, perk_free_delivery, perk_free_returns, perk_buy_now_pay_later, perk_next_day_riyadh, perk_free_delivery_text, perk_free_returns_text, perk_buy_now_pay_later_text, perk_next_day_riyadh_text) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id',
      [name, description, price, category_id || null, mainImageUrl, stock || 0, perkFreeDelivery, perkFreeReturns, perkBuyNowPayLater, perkNextDayRiyadh, perkFreeDeliveryText, perkFreeReturnsText, perkBuyNowPayLaterText, perkNextDayRiyadhText]
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

router.get('/products/edit/:id', requireAdmin, requirePermission('manage_products'), async (req, res) => {
  try {
    const product = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (product.rows.length === 0) return res.redirect('/admin');
    const categories = await pool.query('SELECT * FROM categories ORDER BY name');
    const images = await pool.query('SELECT * FROM product_images WHERE product_id = $1 ORDER BY sort_order, id', [req.params.id]);
    res.render('admin/product-form', { product: product.rows[0], categories: categories.rows, images: images.rows, error: null });
  } catch (err) {
    console.error(err);
    res.redirect('/admin');
  }
});

router.post('/products/edit/:id', requireAdmin, requirePermission('manage_products'), handleUpload('images', 10), async (req, res) => {
  const { name, description, price, category_id, stock } = req.body;

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

    await client.query(
      'UPDATE products SET name=$1, description=$2, price=$3, category_id=$4, stock=$5, perk_free_delivery=$6, perk_free_returns=$7, perk_buy_now_pay_later=$8, perk_next_day_riyadh=$9, perk_free_delivery_text=$10, perk_free_returns_text=$11, perk_buy_now_pay_later_text=$12, perk_next_day_riyadh_text=$13 WHERE id=$14',
      [name, description, price, category_id || null, stock || 0, perkFreeDelivery, perkFreeReturns, perkBuyNowPayLater, perkNextDayRiyadh, perkFreeDeliveryText, perkFreeReturnsText, perkBuyNowPayLaterText, perkNextDayRiyadhText, req.params.id]
    );

    if (req.files && req.files.length > 0) {
      const maxOrder = await client.query(
        'SELECT COALESCE(MAX(sort_order), -1) as max_order FROM product_images WHERE product_id = $1',
        [req.params.id]
      );
      let nextOrder = maxOrder.rows[0].max_order + 1;

      for (let i = 0; i < req.files.length; i++) {
        const imgUrl = `/images/${req.files[i].filename}`;
        await client.query(
          'INSERT INTO product_images (product_id, image_url, is_main, sort_order) VALUES ($1, $2, FALSE, $3)',
          [req.params.id, imgUrl, nextOrder + i]
        );
      }
    }

    const mainImg = await client.query(
      'SELECT image_url FROM product_images WHERE product_id = $1 AND is_main = TRUE LIMIT 1',
      [req.params.id]
    );

    if (mainImg.rows.length > 0) {
      await client.query('UPDATE products SET image_url = $1 WHERE id = $2', [mainImg.rows[0].image_url, req.params.id]);
    } else {
      const firstImg = await client.query(
        'SELECT image_url FROM product_images WHERE product_id = $1 ORDER BY sort_order, id LIMIT 1',
        [req.params.id]
      );
      if (firstImg.rows.length > 0) {
        await client.query('UPDATE products SET image_url = $1 WHERE id = $2', [firstImg.rows[0].image_url, req.params.id]);
      }
    }

    await client.query('COMMIT');
    res.redirect('/admin/products/edit/' + req.params.id);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.redirect('/admin');
  } finally {
    client.release();
  }
});

router.post('/products/images/main/:imageId', requireAdmin, requirePermission('manage_products'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const img = await client.query('SELECT * FROM product_images WHERE id = $1', [req.params.imageId]);
    if (img.rows.length === 0) { await client.query('ROLLBACK'); return res.redirect('/admin'); }

    const productId = img.rows[0].product_id;

    await client.query('UPDATE product_images SET is_main = FALSE WHERE product_id = $1', [productId]);
    await client.query('UPDATE product_images SET is_main = TRUE WHERE id = $1', [req.params.imageId]);
    await client.query('UPDATE products SET image_url = $1 WHERE id = $2', [img.rows[0].image_url, productId]);

    await client.query('COMMIT');
    res.redirect('/admin/products/edit/' + productId);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.redirect('/admin');
  } finally {
    client.release();
  }
});

router.post('/products/images/delete/:imageId', requireAdmin, requirePermission('manage_products'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const img = await client.query('SELECT * FROM product_images WHERE id = $1', [req.params.imageId]);
    if (img.rows.length === 0) { await client.query('ROLLBACK'); return res.redirect('/admin'); }

    const productId = img.rows[0].product_id;
    const wasMain = img.rows[0].is_main;

    await client.query('DELETE FROM product_images WHERE id = $1', [req.params.imageId]);

    if (wasMain) {
      const nextImg = await client.query(
        'SELECT * FROM product_images WHERE product_id = $1 ORDER BY sort_order, id LIMIT 1',
        [productId]
      );

      if (nextImg.rows.length > 0) {
        await client.query('UPDATE product_images SET is_main = TRUE WHERE id = $1', [nextImg.rows[0].id]);
        await client.query('UPDATE products SET image_url = $1 WHERE id = $2', [nextImg.rows[0].image_url, productId]);
      } else {
        await client.query('UPDATE products SET image_url = $1 WHERE id = $2', ['/images/placeholder.png', productId]);
      }
    }

    await client.query('COMMIT');
    res.redirect('/admin/products/edit/' + productId);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.redirect('/admin');
  } finally {
    client.release();
  }
});

router.post('/products/delete/:id', requireAdmin, requirePermission('manage_products'), async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
  } catch (err) {
    console.error(err);
  }
  res.redirect('/admin');
});

router.get('/orders/:id', requireAdmin, requirePermission('view_orders'), async (req, res) => {
  try {
    const order = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (order.rows.length === 0) return res.redirect('/admin');
    const items = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [req.params.id]);
    res.render('admin/order-detail', { order: order.rows[0], items: items.rows });
  } catch (err) {
    console.error(err);
    res.redirect('/admin');
  }
});

router.post('/orders/:id/status', requireAdmin, requirePermission('manage_orders'), async (req, res) => {
  const newStatus = req.body.status;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderResult = await client.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (orderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.redirect('/admin');
    }

    const oldStatus = orderResult.rows[0].status;
    const confirmedStatuses = ['processing', 'shipped', 'delivered'];
    const wasConfirmed = confirmedStatuses.includes(oldStatus);
    const isNowConfirmed = confirmedStatuses.includes(newStatus);

    const updateResult = await client.query(
      'UPDATE orders SET status = $1 WHERE id = $2 AND status = $3',
      [newStatus, req.params.id, oldStatus]
    );
    if (updateResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.redirect(`/admin/orders/${req.params.id}`);
    }

    if (!wasConfirmed && isNowConfirmed) {
      const items = await client.query('SELECT product_id, quantity FROM order_items WHERE order_id = $1', [req.params.id]);
      for (const item of items.rows) {
        if (item.product_id) {
          const prod = await client.query('SELECT stock FROM products WHERE id = $1 FOR UPDATE', [item.product_id]);
          if (prod.rows.length > 0 && prod.rows[0].stock < item.quantity) {
            await client.query('ROLLBACK');
            return res.redirect(`/admin/orders/${req.params.id}`);
          }
          await client.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [item.quantity, item.product_id]);
        }
      }
    } else if (wasConfirmed && !isNowConfirmed) {
      const items = await client.query('SELECT product_id, quantity FROM order_items WHERE order_id = $1', [req.params.id]);
      for (const item of items.rows) {
        if (item.product_id) {
          await client.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [item.quantity, item.product_id]);
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
  } finally {
    client.release();
  }

  res.redirect(`/admin/orders/${req.params.id}`);
});

router.get('/categories', requireAdmin, requirePermission('manage_categories'), async (req, res) => {
  const categories = await pool.query('SELECT * FROM categories ORDER BY name');
  res.render('admin/categories', { categories: categories.rows, error: null });
});

router.post('/categories/new', requireAdmin, requirePermission('manage_categories'), async (req, res) => {
  const { name } = req.body;
  const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  try {
    await pool.query('INSERT INTO categories (name, slug) VALUES ($1, $2)', [name, slug]);
  } catch (err) {
    console.error(err);
  }
  res.redirect('/admin/categories');
});

router.post('/categories/delete/:id', requireAdmin, requirePermission('manage_categories'), async (req, res) => {
  try {
    await pool.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
  } catch (err) {
    console.error(err);
  }
  res.redirect('/admin/categories');
});

router.get('/roles', requireAdmin, requirePermission('manage_roles'), async (req, res) => {
  try {
    const roles = await pool.query('SELECT * FROM roles ORDER BY name');
    const permissions = await pool.query('SELECT * FROM permissions ORDER BY label');
    res.render('admin/roles', { roles: roles.rows, permissions: permissions.rows, error: null });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

router.post('/roles/new', requireAdmin, requirePermission('manage_roles'), async (req, res) => {
  const { name, description } = req.body;
  try {
    await pool.query('INSERT INTO roles (name, description) VALUES ($1, $2)', [name, description || '']);
    res.redirect('/admin/roles');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/roles');
  }
});

router.get('/roles/edit/:id', requireAdmin, requirePermission('manage_roles'), async (req, res) => {
  try {
    const role = await pool.query('SELECT * FROM roles WHERE id = $1', [req.params.id]);
    if (role.rows.length === 0) return res.redirect('/admin/roles');
    const permissions = await pool.query('SELECT * FROM permissions ORDER BY label');
    const rolePerms = await pool.query('SELECT permission_id FROM role_permissions WHERE role_id = $1', [req.params.id]);
    const assignedPermIds = rolePerms.rows.map(r => r.permission_id);

    res.render('admin/role-edit', {
      role: role.rows[0],
      permissions: permissions.rows,
      assignedPermIds
    });
  } catch (err) {
    console.error(err);
    res.redirect('/admin/roles');
  }
});

router.post('/roles/edit/:id', requireAdmin, requirePermission('manage_roles'), async (req, res) => {
  const { name, description } = req.body;
  let permissionIds = req.body.permissions || [];
  if (!Array.isArray(permissionIds)) permissionIds = [permissionIds];
  permissionIds = permissionIds.map(Number).filter(n => !isNaN(n));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE roles SET name = $1, description = $2 WHERE id = $3', [name, description || '', req.params.id]);
    await client.query('DELETE FROM role_permissions WHERE role_id = $1', [req.params.id]);

    for (const permId of permissionIds) {
      await client.query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)', [req.params.id, permId]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
  } finally {
    client.release();
  }

  res.redirect('/admin/roles');
});

router.post('/roles/delete/:id', requireAdmin, requirePermission('manage_roles'), async (req, res) => {
  try {
    await pool.query('UPDATE admin_users SET role_id = NULL WHERE role_id = $1', [req.params.id]);
    await pool.query('DELETE FROM role_permissions WHERE role_id = $1', [req.params.id]);
    await pool.query('DELETE FROM roles WHERE id = $1', [req.params.id]);
  } catch (err) {
    console.error(err);
  }
  res.redirect('/admin/roles');
});

router.get('/users', requireAdmin, requirePermission('manage_users'), async (req, res) => {
  try {
    const users = await pool.query(`
      SELECT au.*, r.name as role_name
      FROM admin_users au
      LEFT JOIN roles r ON au.role_id = r.id
      ORDER BY au.id
    `);

    const roles = await pool.query('SELECT * FROM roles ORDER BY name');

    res.render('admin/users', { users: users.rows, roles: roles.rows, error: null, success: null });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

router.post('/users/new', requireAdmin, requirePermission('manage_users'), async (req, res) => {
  const { username, password, role_id } = req.body;
  try {
    const existing = await pool.query('SELECT id FROM admin_users WHERE username = $1', [username]);
    if (existing.rows.length > 0) {
      const users = await pool.query(`
        SELECT au.*, r.name as role_name FROM admin_users au LEFT JOIN roles r ON au.role_id = r.id ORDER BY au.id
      `);
      const roles = await pool.query('SELECT * FROM roles ORDER BY name');
      return res.render('admin/users', { users: users.rows, roles: roles.rows, error: 'Username already exists', success: null });
    }

    const hash = await bcrypt.hash(password, 10);

    // IMPORTANT: insert into password_hash (not password)
    await pool.query(
      'INSERT INTO admin_users (username, password_hash, role_id, is_super_admin) VALUES ($1, $2, $3, FALSE)',
      [username, hash, role_id || null]
    );

    res.redirect('/admin/users');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/users');
  }
});

router.post('/users/role/:id', requireAdmin, requirePermission('manage_users'), async (req, res) => {
  const { role_id } = req.body;
  try {
    await pool.query('UPDATE admin_users SET role_id = $1 WHERE id = $2', [role_id || null, req.params.id]);
  } catch (err) {
    console.error(err);
  }
  res.redirect('/admin/users');
});

router.post('/users/delete/:id', requireAdmin, requirePermission('manage_users'), async (req, res) => {
  try {
    await pool.query('DELETE FROM admin_users WHERE id = $1', [req.params.id]);
  } catch (err) {
    console.error(err);
  }
  res.redirect('/admin/users');
});

router.get('/customers', requireAdmin, requirePermission('manage_customers'), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';

    let countQuery = 'SELECT COUNT(*) FROM customers';
    let dataQuery = `
      SELECT c.*,
        (SELECT COUNT(*) FROM orders WHERE customer_id = c.id) as order_count,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE customer_id = c.id AND status IN ('processing', 'shipped', 'delivered')) as total_spent
      FROM customers c
    `;
    const params = [];

    if (search) {
      const whereClause = ' WHERE c.name ILIKE $1 OR c.email ILIKE $1';
      countQuery += whereClause.replace(/c\./g, '');
      dataQuery += whereClause;
      params.push(`%${search}%`);
    }

    dataQuery += ` ORDER BY c.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const countResult = await pool.query(countQuery, search ? [`%${search}%`] : []);
    const totalCustomers = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(totalCustomers / limit);

    const customers = await pool.query(dataQuery, params);

    res.render('admin/customers', {
      customers: customers.rows,
      page,
      totalPages,
      totalCustomers,
      search
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

router.get('/customers/:id', requireAdmin, requirePermission('manage_customers'), async (req, res) => {
  try {
    const customer = await pool.query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
    if (customer.rows.length === 0) return res.redirect('/admin/customers');

    const orders = await pool.query(
      'SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );

    res.render('admin/customer-detail', {
      customer: customer.rows[0],
      orders: orders.rows
    });
  } catch (err) {
    console.error(err);
    res.redirect('/admin/customers');
  }
});

router.post('/customers/delete/:id', requireAdmin, requirePermission('manage_customers'), async (req, res) => {
  try {
    await pool.query('DELETE FROM customers WHERE id = $1', [req.params.id]);
  } catch (err) {
    console.error(err);
  }
  res.redirect('/admin/customers');
});

router.get('/reviews', requireAdmin, requirePermission('manage_reviews'), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const filterRating = req.query.rating || '';

    let whereConditions = [];
    let params = [];
    let paramIndex = 1;

    if (search) {
      whereConditions.push(`(p.name ILIKE $${paramIndex} OR c.name ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }
    if (filterRating) {
      whereConditions.push(`r.rating = $${paramIndex}`);
      params.push(parseInt(filterRating));
      paramIndex++;
    }

    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM product_reviews r JOIN products p ON r.product_id = p.id JOIN customers c ON r.customer_id = c.id ${whereClause}`,
      params
    );
    const totalReviews = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(totalReviews / limit);

    const reviews = await pool.query(
      `SELECT r.*, p.name as product_name, c.name as customer_name
       FROM product_reviews r
       JOIN products p ON r.product_id = p.id
       JOIN customers c ON r.customer_id = c.id
       ${whereClause}
       ORDER BY r.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    res.render('admin/reviews', {
      reviews: reviews.rows,
      page,
      totalPages,
      totalReviews,
      search,
      filterRating
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

router.post('/reviews/delete/:id', requireAdmin, requirePermission('manage_reviews'), async (req, res) => {
  try {
    await pool.query('DELETE FROM product_reviews WHERE id = $1', [req.params.id]);
  } catch (err) {
    console.error(err);
  }
  res.redirect('/admin/reviews');
});

router.post('/orders/delete/:id', requireAdmin, requirePermission('manage_orders'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const order = await client.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (order.rows.length > 0) {
      const confirmedStatuses = ['processing', 'shipped', 'delivered'];
      if (confirmedStatuses.includes(order.rows[0].status)) {
        const items = await client.query('SELECT product_id, quantity FROM order_items WHERE order_id = $1', [req.params.id]);
        for (const item of items.rows) {
          if (item.product_id) {
            await client.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [item.quantity, item.product_id]);
          }
        }
      }

      await client.query('DELETE FROM order_items WHERE order_id = $1', [req.params.id]);
      await client.query('DELETE FROM orders WHERE id = $1', [req.params.id]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
  } finally {
    client.release();
  }

  res.redirect('/admin');
});

module.exports = router;
