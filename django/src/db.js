const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(100) UNIQUE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        description TEXT,
        price NUMERIC(10,2) NOT NULL,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        image_url VARCHAR(500) DEFAULT '/images/placeholder.png',
        stock INTEGER DEFAULT 0,
        perk_free_delivery BOOLEAN DEFAULT FALSE,
        perk_free_returns BOOLEAN DEFAULT FALSE,
        perk_buy_now_pay_later BOOLEAN DEFAULT FALSE,
        perk_next_day_riyadh BOOLEAN DEFAULT FALSE,
        perk_free_delivery_text TEXT DEFAULT 'Free Delivery on All Orders',
        perk_free_returns_text TEXT DEFAULT 'FREE 15-Day Returns',
        perk_buy_now_pay_later_text TEXT DEFAULT 'Buy Now, Pay Later with Tamara & Tabby',
        perk_next_day_riyadh_text TEXT DEFAULT 'Free Next Day Delivery in Riyadh',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        customer_name VARCHAR(200) NOT NULL,
        customer_email VARCHAR(200) NOT NULL,
        customer_address TEXT NOT NULL,
        total NUMERIC(10,2) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        product_name VARCHAR(200) NOT NULL,
        quantity INTEGER NOT NULL,
        price NUMERIC(10,2) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS roles (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        description VARCHAR(300),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS permissions (
        id SERIAL PRIMARY KEY,
        key VARCHAR(100) UNIQUE NOT NULL,
        label VARCHAR(200) NOT NULL,
        description VARCHAR(300)
      );

      CREATE TABLE IF NOT EXISTS role_permissions (
        role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
        permission_id INTEGER REFERENCES permissions(id) ON DELETE CASCADE,
        PRIMARY KEY (role_id, permission_id)
      );

      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(200) NOT NULL,
        is_super_admin BOOLEAN DEFAULT FALSE,
        role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL
      );
    `);

    await client.query(`
      ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN DEFAULT FALSE;
      ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        email VARCHAR(200) UNIQUE NOT NULL,
        password VARCHAR(200) NOT NULL,
        address TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS product_reviews (
        id SERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
        rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
        review_text TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(product_id, customer_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS product_loves (
        id SERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(product_id, customer_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS product_images (
        id SERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        image_url VARCHAR(500) NOT NULL,
        is_main BOOLEAN DEFAULT FALSE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    const permCheck = await client.query('SELECT COUNT(*) FROM permissions');
    if (parseInt(permCheck.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO permissions (key, label, description) VALUES
        ('view_dashboard', 'View Dashboard', 'Can see the admin dashboard and stats'),
        ('manage_products', 'Manage Products', 'Can add, edit, and delete products'),
        ('view_orders', 'View Orders', 'Can view order details'),
        ('manage_orders', 'Manage Orders', 'Can update order status'),
        ('manage_categories', 'Manage Categories', 'Can add and delete categories'),
        ('manage_roles', 'Manage Roles', 'Can create and edit roles and permissions'),
        ('manage_users', 'Manage Users', 'Can add admin users and assign roles'),
        ('manage_customers', 'Manage Customers', 'Can view and manage registered customers');
      `);
    }

    const custPermCheck = await client.query("SELECT COUNT(*) FROM permissions WHERE key = 'manage_customers'");
    if (parseInt(custPermCheck.rows[0].count) === 0) {
      const newPerm = await client.query("INSERT INTO permissions (key, label, description) VALUES ('manage_customers', 'Manage Customers', 'Can view and manage registered customers') RETURNING id");
      const superAdminRole = await client.query("SELECT id FROM roles WHERE name = 'Super Admin'");
      if (superAdminRole.rows.length > 0) {
        const exists = await client.query('SELECT 1 FROM role_permissions WHERE role_id = $1 AND permission_id = $2', [superAdminRole.rows[0].id, newPerm.rows[0].id]);
        if (exists.rows.length === 0) {
          await client.query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)', [superAdminRole.rows[0].id, newPerm.rows[0].id]);
        }
      }
    }

    const reviewPermCheck = await client.query("SELECT COUNT(*) FROM permissions WHERE key = 'manage_reviews'");
    if (parseInt(reviewPermCheck.rows[0].count) === 0) {
      const newPerm = await client.query("INSERT INTO permissions (key, label, description) VALUES ('manage_reviews', 'Manage Reviews', 'Can view and delete customer reviews') RETURNING id");
      const superAdminRole = await client.query("SELECT id FROM roles WHERE name = 'Super Admin'");
      if (superAdminRole.rows.length > 0) {
        const exists = await client.query('SELECT 1 FROM role_permissions WHERE role_id = $1 AND permission_id = $2', [superAdminRole.rows[0].id, newPerm.rows[0].id]);
        if (exists.rows.length === 0) {
          await client.query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)', [superAdminRole.rows[0].id, newPerm.rows[0].id]);
        }
      }
    }

    const roleCheck = await client.query("SELECT COUNT(*) FROM roles WHERE name = 'Super Admin'");
    if (parseInt(roleCheck.rows[0].count) === 0) {
      const roleResult = await client.query(
        "INSERT INTO roles (name, description) VALUES ('Super Admin', 'Full access to everything') RETURNING id"
      );
      const superRoleId = roleResult.rows[0].id;
      const allPerms = await client.query('SELECT id FROM permissions');
      for (const perm of allPerms.rows) {
        await client.query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)', [superRoleId, perm.id]);
      }
    }

    const { rows } = await client.query('SELECT COUNT(*) FROM categories');
    if (parseInt(rows[0].count) === 0) {
      await client.query(`
        INSERT INTO categories (name, slug) VALUES
        ('T-Shirts', 't-shirts'),
        ('Shirts', 'shirts'),
        ('Pants', 'pants'),
        ('Dresses', 'dresses'),
        ('Jackets', 'jackets'),
        ('Accessories', 'accessories');
      `);
    }

    const prodCount = await client.query('SELECT COUNT(*) FROM products');
    if (parseInt(prodCount.rows[0].count) === 0) {
      const catRows = await client.query('SELECT id, slug FROM categories ORDER BY name');
      const catMap = {};
      catRows.rows.forEach(c => { catMap[c.slug] = c.id; });
      const tshirts = catMap['t-shirts'] || null;
      const shirts = catMap['shirts'] || null;
      const pants = catMap['pants'] || null;
      const dresses = catMap['dresses'] || null;
      const jackets = catMap['jackets'] || null;
      const accessories = catMap['accessories'] || null;

      await client.query(`
        INSERT INTO products (name, description, price, category_id, image_url, stock) VALUES
        ('Classic White T-Shirt', 'A timeless white cotton t-shirt that goes with everything. Made from 100% organic cotton for ultimate comfort.', 29.99, $1, '/images/placeholder.png', 50),
        ('Graphic Print Tee', 'Bold graphic design on premium quality fabric. Stand out from the crowd with this eye-catching tee.', 34.99, $1, '/images/placeholder.png', 35),
        ('V-Neck Slim Fit', 'Modern v-neck design with a slim fit cut. Perfect for layering or wearing on its own.', 27.99, $1, '/images/placeholder.png', 40),
        ('Oxford Button Down', 'Classic oxford cloth button-down shirt. A wardrobe essential for smart-casual occasions.', 59.99, $2, '/images/placeholder.png', 25),
        ('Flannel Check Shirt', 'Warm flannel shirt with a classic check pattern. Perfect for cooler days.', 49.99, $2, '/images/placeholder.png', 30),
        ('Linen Summer Shirt', 'Lightweight linen shirt ideal for hot summer days. Breathable and stylish.', 54.99, $2, '/images/placeholder.png', 20),
        ('Slim Fit Chinos', 'Versatile slim fit chinos in a classic cut. Dress them up or down.', 64.99, $3, '/images/placeholder.png', 30),
        ('Relaxed Fit Jeans', 'Comfortable relaxed fit jeans in a medium wash. Built to last.', 69.99, $3, '/images/placeholder.png', 25),
        ('Cargo Pants', 'Functional cargo pants with multiple pockets. Durable and practical.', 59.99, $3, '/images/placeholder.png', 20),
        ('Floral Summer Dress', 'Beautiful floral print dress perfect for summer outings. Light and flowy fabric.', 79.99, $4, '/images/placeholder.png', 15),
        ('Little Black Dress', 'The essential little black dress. Elegant and versatile for any occasion.', 89.99, $4, '/images/placeholder.png', 20),
        ('Maxi Wrap Dress', 'Stunning maxi wrap dress with a flattering silhouette. Comfortable all-day wear.', 84.99, $4, '/images/placeholder.png', 15),
        ('Leather Biker Jacket', 'Classic leather biker jacket with a modern twist. Premium quality leather.', 199.99, $5, '/images/placeholder.png', 10),
        ('Denim Jacket', 'Timeless denim jacket that never goes out of style. Versatile layering piece.', 89.99, $5, '/images/placeholder.png', 20),
        ('Puffer Winter Jacket', 'Warm puffer jacket for cold winter days. Water-resistant and insulated.', 149.99, $5, '/images/placeholder.png', 15),
        ('Leather Belt', 'Genuine leather belt with a classic buckle. A wardrobe staple.', 34.99, $6, '/images/placeholder.png', 40),
        ('Wool Scarf', 'Soft wool scarf to keep you warm. Available in classic colors.', 29.99, $6, '/images/placeholder.png', 35),
        ('Canvas Tote Bag', 'Durable canvas tote bag for everyday use. Spacious and practical.', 39.99, $6, '/images/placeholder.png', 25);
      `, [tshirts, shirts, pants, dresses, jackets, accessories]);
    }

    const bcrypt = require('bcryptjs');
    const adminCount = await client.query('SELECT COUNT(*) FROM admin_users');
    if (parseInt(adminCount.rows[0].count) === 0) {
      const hash = await bcrypt.hash('admin123', 10);
      const superRole = await client.query("SELECT id FROM roles WHERE name = 'Super Admin'");
      const roleId = superRole.rows.length > 0 ? superRole.rows[0].id : null;
      await client.query(
        'INSERT INTO admin_users (username, password, is_super_admin, role_id) VALUES ($1, $2, TRUE, $3)',
        ['admin', hash, roleId]
      );
    } else {
      await client.query("UPDATE admin_users SET is_super_admin = TRUE WHERE username = 'admin' AND is_super_admin IS NOT TRUE");
      const superRole = await client.query("SELECT id FROM roles WHERE name = 'Super Admin'");
      if (superRole.rows.length > 0) {
        await client.query("UPDATE admin_users SET role_id = $1 WHERE username = 'admin' AND role_id IS NULL", [superRole.rows[0].id]);
      }
    }

    console.log('Database initialized successfully');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
