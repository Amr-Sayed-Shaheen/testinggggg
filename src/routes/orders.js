const express = require('express');
const router = express.Router();
const { pool } = require('../db');

router.get('/checkout', (req, res) => {
  if (!req.session.customerId) {
    return res.redirect('/auth/login');
  }
  if (!req.session.cart || req.session.cart.length === 0) {
    return res.redirect('/cart');
  }
  res.render('checkout');
});

router.post('/checkout', async (req, res) => {
  if (!req.session.customerId) {
    return res.redirect('/auth/login');
  }

  const cart = req.session.cart || [];
  if (cart.length === 0) return res.redirect('/cart');

  const customer = await pool.query('SELECT * FROM customers WHERE id = $1', [req.session.customerId]);
  if (customer.rows.length === 0) return res.redirect('/auth/login');
  const { name, email, address } = customer.rows[0];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let total = 0;
    const items = [];

    for (const cartItem of cart) {
      const result = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [cartItem.productId]);
      if (result.rows.length > 0) {
        const product = result.rows[0];
        if (product.stock < cartItem.quantity) {
          await client.query('ROLLBACK');
          return res.redirect('/cart');
        }
        const subtotal = parseFloat(product.price) * cartItem.quantity;
        total += subtotal;
        items.push({
          productId: product.id,
          productName: product.name,
          quantity: cartItem.quantity,
          price: product.price
        });
      }
    }

    const orderResult = await client.query(
      'INSERT INTO orders (customer_name, customer_email, customer_address, total, customer_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [name, email, req.body.address || address, total.toFixed(2), req.session.customerId]
    );

    const orderId = orderResult.rows[0].id;

    for (const item of items) {
      await client.query(
        'INSERT INTO order_items (order_id, product_id, product_name, quantity, price) VALUES ($1, $2, $3, $4, $5)',
        [orderId, item.productId, item.productName, item.quantity, item.price]
      );
    }

    await client.query('COMMIT');
    req.session.cart = [];
    res.redirect(`/orders/confirmation/${orderId}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).send('Error processing order');
  } finally {
    client.release();
  }
});

router.get('/confirmation/:id', async (req, res) => {
  try {
    const order = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (order.rows.length === 0) return res.status(404).render('404');

    if (req.session.customerId && order.rows[0].customer_id && order.rows[0].customer_id !== req.session.customerId) {
      return res.status(404).render('404');
    }

    const items = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [req.params.id]);

    res.render('confirmation', { order: order.rows[0], items: items.rows });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

module.exports = router;
