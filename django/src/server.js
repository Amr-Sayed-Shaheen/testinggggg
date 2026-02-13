const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const { pool, initDB } = require('./db');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(session({
  store: new pgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  if (!req.session.cart) req.session.cart = [];
  res.locals.cart = req.session.cart;
  res.locals.cartCount = req.session.cart.reduce((sum, item) => sum + item.quantity, 0);
  res.locals.isAdmin = req.session.isAdmin || false;
  res.locals.isSuperAdmin = req.session.isSuperAdmin || false;
  res.locals.adminUsername = req.session.adminUsername || null;
  res.locals.roleName = req.session.roleName || null;
  res.locals.permissions = req.session.permissions || [];
  res.locals.customerId = req.session.customerId || null;
  res.locals.customerName = req.session.customerName || null;
  res.locals.customerEmail = req.session.customerEmail || null;
  res.locals.customerAddress = req.session.customerAddress || '';
  next();
});

const shopRoutes = require('./routes/shop');
const cartRoutes = require('./routes/cart');
const adminRoutes = require('./routes/admin');
const orderRoutes = require('./routes/orders');
const authRoutes = require('./routes/auth');

app.use('/', shopRoutes);
app.use('/cart', cartRoutes);
app.use('/admin', adminRoutes);
app.use('/orders', orderRoutes);
app.use('/auth', authRoutes);

app.use((req, res) => {
  res.status(404).render('404');
});

const PORT = process.env.PORT || 5000;

initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Clothes store running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
