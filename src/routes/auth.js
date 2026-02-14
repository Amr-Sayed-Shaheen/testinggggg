// src/routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

router.get('/login', (req, res) => {
  res.render('auth/login', { error: null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM customers WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.render('auth/login', { error: 'Invalid email or password' });
    }

    const customer = result.rows[0];
    const hash = customer.password_hash || '';
    const match = hash ? await bcrypt.compare(password, hash) : false;

    if (!match) {
      return res.render('auth/login', { error: 'Invalid email or password' });
    }

    req.session.customerId = customer.id;
    req.session.customerName = customer.name;
    req.session.customerEmail = customer.email;
    req.session.customerAddress = customer.address || '';

    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.render('auth/login', { error: 'Something went wrong. Please try again.' });
  }
});

router.get('/register', (req, res) => {
  res.render('auth/register', { error: null });
});

router.post('/register', async (req, res) => {
  const { name, email, password, confirmPassword } = req.body;

  if (!name || !email || !password || !confirmPassword) {
    return res.render('auth/register', { error: 'All fields are required' });
  }
  if (password !== confirmPassword) {
    return res.render('auth/register', { error: 'Passwords do not match' });
  }
  if (password.length < 6) {
    return res.render('auth/register', { error: 'Password must be at least 6 characters' });
  }

  try {
    const existing = await pool.query('SELECT id FROM customers WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.render('auth/register', { error: 'An account with this email already exists' });
    }

    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO customers (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [name, email, hash]
    );

    req.session.customerId = result.rows[0].id;
    req.session.customerName = name;
    req.session.customerEmail = email;
    req.session.customerAddress = '';

    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.render('auth/register', { error: 'Something went wrong. Please try again.' });
  }
});

router.get('/logout', (req, res) => {
  req.session.customerId = null;
  req.session.customerName = null;
  req.session.customerEmail = null;
  req.session.customerAddress = null;
  res.redirect('/');
});

router.get('/account', async (req, res) => {
  if (!req.session.customerId) return res.redirect('/auth/login');
  try {
    const result = await pool.query('SELECT * FROM customers WHERE id = $1', [req.session.customerId]);
    if (result.rows.length === 0) return res.redirect('/auth/login');
    res.render('auth/account', { customer: result.rows[0], success: null, error: null });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

router.post('/account', async (req, res) => {
  if (!req.session.customerId) return res.redirect('/auth/login');
  const { action } = req.body;

  try {
    const custResult = await pool.query('SELECT * FROM customers WHERE id = $1', [req.session.customerId]);
    if (custResult.rows.length === 0) return res.redirect('/auth/login');
    const customer = custResult.rows[0];

    if (action === 'profile') {
      const { name, email, address } = req.body;

      if (!name || !email) {
        return res.render('auth/account', { customer, success: null, error: 'Name and email are required' });
      }

      const existing = await pool.query(
        'SELECT id FROM customers WHERE email = $1 AND id != $2',
        [email, req.session.customerId]
      );

      if (existing.rows.length > 0) {
        return res.render('auth/account', { customer, success: null, error: 'This email is already in use by another account' });
      }

      await pool.query(
        'UPDATE customers SET name = $1, email = $2, address = $3 WHERE id = $4',
        [name, email, address || '', req.session.customerId]
      );

      req.session.customerName = name;
      req.session.customerEmail = email;
      req.session.customerAddress = address || '';

      const updated = await pool.query('SELECT * FROM customers WHERE id = $1', [req.session.customerId]);
      return res.render('auth/account', { customer: updated.rows[0], success: 'Profile updated successfully', error: null });
    }

    if (action === 'password') {
      const { current_password, new_password, confirm_password } = req.body;

      if (!current_password || !new_password || !confirm_password) {
        return res.render('auth/account', { customer, success: null, error: 'All password fields are required' });
      }

      const currentHash = customer.password_hash || '';
      const match = currentHash ? await bcrypt.compare(current_password, currentHash) : false;

      if (!match) {
        return res.render('auth/account', { customer, success: null, error: 'Current password is incorrect' });
      }

      if (new_password !== confirm_password) {
        return res.render('auth/account', { customer, success: null, error: 'New passwords do not match' });
      }

      if (new_password.length < 6) {
        return res.render('auth/account', { customer, success: null, error: 'New password must be at least 6 characters' });
      }

      const hash = await bcrypt.hash(new_password, 10);
      await pool.query('UPDATE customers SET password_hash = $1 WHERE id = $2', [hash, req.session.customerId]);

      return res.render('auth/account', { customer, success: 'Password updated successfully', error: null });
    }

    res.redirect('/auth/account');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

router.get('/reviews', async (req, res) => {
  if (!req.session.customerId) return res.redirect('/auth/login');

  try {
    const reviews = await pool.query(`
      SELECT r.*, p.name as product_name, p.image_url as product_image
      FROM product_reviews r
      JOIN products p ON r.product_id = p.id
      WHERE r.customer_id = $1
      ORDER BY r.created_at DESC
    `, [req.session.customerId]);

    const editId = req.query.edit ? parseInt(req.query.edit) : null;

    res.render('auth/reviews', { reviews: reviews.rows, editingReviewId: editId, success: null, error: null });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

router.post('/reviews/edit/:id', async (req, res) => {
  if (!req.session.customerId) return res.redirect('/auth/login');

  const { rating, review_text } = req.body;
  const ratingVal = parseInt(rating);

  if (!ratingVal || ratingVal < 1 || ratingVal > 5) {
    return res.redirect('/auth/reviews');
  }

  try {
    await pool.query(
      'UPDATE product_reviews SET rating = $1, review_text = $2 WHERE id = $3 AND customer_id = $4',
      [ratingVal, review_text || '', req.params.id, req.session.customerId]
    );
    res.redirect('/auth/reviews');
  } catch (err) {
    console.error(err);
    res.redirect('/auth/reviews');
  }
});

router.post('/reviews/delete/:id', async (req, res) => {
  if (!req.session.customerId) return res.redirect('/auth/login');

  try {
    await pool.query(
      'DELETE FROM product_reviews WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.session.customerId]
    );
    res.redirect('/auth/reviews');
  } catch (err) {
    console.error(err);
    res.redirect('/auth/reviews');
  }
});

router.get('/orders', async (req, res) => {
  if (!req.session.customerId) return res.redirect('/auth/login');

  try {
    const result = await pool.query(
      'SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC',
      [req.session.customerId]
    );
    res.render('auth/orders', { orders: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

module.exports = router;
