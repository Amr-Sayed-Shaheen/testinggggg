const express = require('express');
const router = express.Router();
const { pool } = require('../db');

router.get('/', async (req, res) => {
  try {
    const categories = await pool.query('SELECT * FROM categories ORDER BY name');
    const featured = await pool.query(`
      SELECT p.*, c.name as category_name, c.slug as category_slug
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.stock > 0
      ORDER BY p.created_at DESC
      LIMIT 6
    `);
    res.render('home', {
      categories: categories.rows,
      featured: featured.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

router.get('/shop', async (req, res) => {
  try {
    const categories = await pool.query('SELECT * FROM categories ORDER BY name');
    const categoryFilter = req.query.category || null;
    const search = req.query.search || '';

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 10;
    const offset = (page - 1) * limit;

    let whereClause = ' WHERE 1=1';
    const params = [];

    if (categoryFilter) {
      params.push(categoryFilter);
      whereClause += ` AND c.slug = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      whereClause += ` AND (p.name ILIKE $${params.length} OR p.description ILIKE $${params.length})`;
    }

    const countQuery = `SELECT COUNT(*) FROM products p LEFT JOIN categories c ON p.category_id = c.id ${whereClause}`;
    const countResult = await pool.query(countQuery, params);
    const totalProducts = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(totalProducts / limit);

    params.push(limit);
    params.push(offset);
    const query = `
      SELECT p.*, c.name as category_name, c.slug as category_slug
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      ${whereClause}
      ORDER BY p.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const products = await pool.query(query, params);

    res.render('shop', {
      products: products.rows,
      categories: categories.rows,
      currentCategory: categoryFilter,
      search,
      page,
      totalPages
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

router.get('/product/:id', async (req, res) => {
  try {
    const product = await pool.query(`
      SELECT p.*, c.name as category_name, c.slug as category_slug
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = $1
    `, [req.params.id]);

    if (product.rows.length === 0) return res.status(404).render('404');

    const images = await pool.query(
      'SELECT * FROM product_images WHERE product_id = $1 ORDER BY is_main DESC, sort_order, id',
      [req.params.id]
    );

    const related = await pool.query(`
      SELECT * FROM products
      WHERE category_id = $1 AND id != $2
      LIMIT 4
    `, [product.rows[0].category_id, req.params.id]);

    const reviews = await pool.query(`
      SELECT r.*, c.name as customer_name
      FROM product_reviews r
      JOIN customers c ON r.customer_id = c.id
      WHERE r.product_id = $1
      ORDER BY r.created_at DESC
    `, [req.params.id]);

    const ratingStats = await pool.query(`
      SELECT 
        COUNT(*) as total_reviews,
        COALESCE(AVG(rating), 0) as avg_rating
      FROM product_reviews WHERE product_id = $1
    `, [req.params.id]);

    const loveCount = await pool.query(
      'SELECT COUNT(*) FROM product_loves WHERE product_id = $1',
      [req.params.id]
    );

    const customerId = req.session.customerId || null;
    let customerLoved = false;
    let customerReviewed = false;
    if (customerId) {
      const loved = await pool.query(
        'SELECT 1 FROM product_loves WHERE product_id = $1 AND customer_id = $2',
        [req.params.id, customerId]
      );
      customerLoved = loved.rows.length > 0;
      const reviewed = await pool.query(
        'SELECT 1 FROM product_reviews WHERE product_id = $1 AND customer_id = $2',
        [req.params.id, customerId]
      );
      customerReviewed = reviewed.rows.length > 0;
    }

    res.render('product', {
      product: product.rows[0],
      images: images.rows,
      related: related.rows,
      reviews: reviews.rows,
      totalReviews: parseInt(ratingStats.rows[0].total_reviews),
      avgRating: parseFloat(ratingStats.rows[0].avg_rating).toFixed(1),
      loveCount: parseInt(loveCount.rows[0].count),
      customerLoved,
      customerReviewed
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

router.post('/product/:id/review', async (req, res) => {
  const productId = req.params.id;
  if (!req.session.customerId) {
    return res.redirect('/auth/login?redirect=/product/' + productId);
  }
  try {
    const { rating, review_text } = req.body;
    const existing = await pool.query(
      'SELECT 1 FROM product_reviews WHERE product_id = $1 AND customer_id = $2',
      [productId, req.session.customerId]
    );
    if (existing.rows.length > 0) {
      return res.redirect('/product/' + productId);
    }
    const ratingVal = parseInt(rating);
    if (!ratingVal || ratingVal < 1 || ratingVal > 5) {
      return res.redirect('/product/' + productId);
    }
    await pool.query(
      'INSERT INTO product_reviews (product_id, customer_id, rating, review_text) VALUES ($1, $2, $3, $4)',
      [productId, req.session.customerId, ratingVal, review_text || '']
    );
    res.redirect('/product/' + productId);
  } catch (err) {
    console.error(err);
    res.redirect('/product/' + productId);
  }
});

router.post('/product/:id/love', async (req, res) => {
  const productId = req.params.id;
  if (!req.session.customerId) {
    return res.redirect('/auth/login?redirect=/product/' + productId);
  }
  try {
    const existing = await pool.query(
      'SELECT 1 FROM product_loves WHERE product_id = $1 AND customer_id = $2',
      [productId, req.session.customerId]
    );
    if (existing.rows.length > 0) {
      await pool.query(
        'DELETE FROM product_loves WHERE product_id = $1 AND customer_id = $2',
        [productId, req.session.customerId]
      );
    } else {
      await pool.query(
        'INSERT INTO product_loves (product_id, customer_id) VALUES ($1, $2)',
        [productId, req.session.customerId]
      );
    }
    res.redirect('/product/' + productId);
  } catch (err) {
    console.error(err);
    res.redirect('/product/' + productId);
  }
});

module.exports = router;
