const express = require('express');
const router = express.Router();
const { pool } = require('../db');

router.get('/', async (req, res) => {
  const cart = req.session.cart || [];
  let cartItems = [];
  let total = 0;

  for (const item of cart) {
    const result = await pool.query('SELECT * FROM products WHERE id = $1', [item.productId]);
    if (result.rows.length > 0) {
      const product = result.rows[0];
      const subtotal = parseFloat(product.price) * item.quantity;
      total += subtotal;
      cartItems.push({ ...product, quantity: item.quantity, subtotal: subtotal.toFixed(2) });
    }
  }

  res.render('cart', { cartItems, total: total.toFixed(2) });
});

router.post('/add', async (req, res) => {
  const { productId, quantity } = req.body;
  const qty = Math.max(1, parseInt(quantity) || 1);

  const product = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
  if (product.rows.length === 0) return res.redirect('/');
  if (product.rows[0].stock <= 0) return res.redirect('/');

  const cart = req.session.cart || [];
  const existing = cart.find(item => item.productId === parseInt(productId));
  const currentQty = existing ? existing.quantity : 0;
  const maxAllowed = product.rows[0].stock;
  const newQty = Math.min(currentQty + qty, maxAllowed);

  if (existing) {
    existing.quantity = newQty;
  } else {
    cart.push({ productId: parseInt(productId), quantity: Math.min(qty, maxAllowed) });
  }

  req.session.cart = cart;
  res.redirect('/cart');
});

router.post('/update', async (req, res) => {
  const { productId, quantity } = req.body;
  const qty = parseInt(quantity);

  if (qty <= 0) {
    req.session.cart = req.session.cart.filter(item => item.productId !== parseInt(productId));
  } else {
    const product = await pool.query('SELECT stock FROM products WHERE id = $1', [productId]);
    const maxStock = product.rows.length > 0 ? product.rows[0].stock : qty;
    const item = req.session.cart.find(item => item.productId === parseInt(productId));
    if (item) item.quantity = Math.min(qty, maxStock);
  }

  res.redirect('/cart');
});

router.post('/remove', (req, res) => {
  const { productId } = req.body;
  req.session.cart = req.session.cart.filter(item => item.productId !== parseInt(productId));
  res.redirect('/cart');
});

module.exports = router;
