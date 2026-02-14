# StyleVault - Clothes Store

## Overview
A full-featured clothes e-commerce store built with Node.js, Express, EJS, and PostgreSQL.

## Recent Changes
- 2026-02-12: My Account page added - customers can edit profile info (name, email, address) and change password
- 2026-02-12: My Reviews page added - customers can view, edit, and delete their own reviews
- 2026-02-12: Admin reviews management page added - search, filter by rating, and delete customer reviews
- 2026-02-12: Product rating system added - star ratings (1-5), written reviews, love/heart button with counts
- 2026-02-12: Product perks checkboxes added - free delivery, returns, buy now pay later, next day delivery in Riyadh
- 2026-02-12: Home page and shop page separated - home has hero, category cards, and featured products; shop at /shop has full catalog
- 2026-02-12: Admin portal fully separated from storefront - distinct layout, navigation, and styling
- 2026-02-11: Admin customer management - view, search, and delete registered customers from admin portal
- 2026-02-11: Customer sign-in/sign-up system added - customers must sign in before checkout
- 2026-02-11: Orders linked to customer accounts with order history page at /auth/orders
- 2026-02-11: Stock deduction and revenue now deferred until order is confirmed (status set to processing/shipped/delivered)
- 2026-02-11: Deletion protections removed - any record in any table can be deleted
- 2026-02-11: Order deletion restores stock if the order was previously confirmed
- 2026-02-11: Initial build - full store with catalog, cart, checkout, and admin dashboard

## Tech Stack
- **Backend**: Node.js 20 + Express
- **Database**: PostgreSQL (Replit built-in)
- **Views**: EJS server-side rendering
- **Styling**: Vanilla CSS (responsive)
- **Sessions**: express-session with connect-pg-simple

## Project Architecture
```
src/
  server.js          - Main Express server
  db.js              - Database pool and initialization
  routes/
    shop.js          - Product catalog routes
    cart.js          - Shopping cart routes
    orders.js        - Checkout and order routes
    auth.js          - Customer sign-in, sign-up, order history
    admin.js         - Admin dashboard routes
  views/
    partials/        - Header and footer partials
    admin/           - Admin view templates
    home.ejs         - Home/landing page with hero, categories, featured
    shop.ejs         - Product listing page (at /shop)
    product.ejs      - Product detail page
    cart.ejs         - Shopping cart page
    checkout.ejs     - Checkout form
    confirmation.ejs - Order confirmation
    404.ejs          - Not found page
public/
  css/style.css      - All styles
  images/            - Product images
```

## Features
- Product catalog with category filtering and search
- Product detail pages with related products
- Session-based shopping cart (add, remove, update quantities)
- Customer sign-up/sign-in with email and password (bcrypt hashed)
- Customer order history page
- Checkout requires sign-in, orders linked to customer accounts
- Admin dashboard with stats, product CRUD, order management, category management, customer management
- Product rating system with star ratings, written reviews, and love/heart button
- Product perks (free delivery, returns, buy now pay later, next day Riyadh) with editable text per product
- Customer "My Account" page with profile editing and password change
- Customer "My Reviews" page with edit/delete own reviews
- Admin reviews management with search, filter, and delete
- Responsive design for mobile/desktop

## Admin Credentials
- Username: admin
- Password: admin123
- Access at: /admin/login

## Running
- `node src/server.js` on port 5000

## User Preferences
- (None recorded yet)
