// src/db.js
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required');
}

// Neon needs SSL
const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

async function colExists(client, table, column) {
  const q = `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1 AND column_name=$2
    LIMIT 1
  `;
  const r = await client.query(q, [table, column]);
  return r.rows.length > 0;
}

async function addColIfMissing(client, table, column, ddlType) {
  const exists = await colExists(client, table, column);
  if (!exists) {
    await client.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
  }
}

async function indexExists(client, indexName) {
  const q = `
    SELECT 1
    FROM pg_indexes
    WHERE schemaname='public' AND indexname=$1
    LIMIT 1
  `;
  const r = await client.query(q, [indexName]);
  return r.rows.length > 0;
}

async function ensureUniqueIndex(client, indexName, table, column) {
  const exists = await indexExists(client, indexName);
  if (!exists) {
    await client.query(`CREATE UNIQUE INDEX ${indexName} ON ${table}(${column})`);
  }
}

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ---- categories
    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // ensure unique slug for ON CONFLICT safety if used later
    await ensureUniqueIndex(client, 'categories_slug_unique', 'categories', 'slug');

    // ---- products
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        price NUMERIC(10,2) NOT NULL DEFAULT 0,
        image_url TEXT DEFAULT '/images/placeholder.png',
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // columns used by code
    await addColIfMissing(client, 'products', 'stock', 'INTEGER NOT NULL DEFAULT 0');

    await addColIfMissing(client, 'products', 'perk_free_delivery', 'BOOLEAN NOT NULL DEFAULT FALSE');
    await addColIfMissing(client, 'products', 'perk_free_returns', 'BOOLEAN NOT NULL DEFAULT FALSE');
    await addColIfMissing(client, 'products', 'perk_buy_now_pay_later', 'BOOLEAN NOT NULL DEFAULT FALSE');
    await addColIfMissing(client, 'products', 'perk_next_day_riyadh', 'BOOLEAN NOT NULL DEFAULT FALSE');

    await addColIfMissing(
      client,
      'products',
      'perk_free_delivery_text',
      "TEXT DEFAULT 'Free Delivery on All Orders'"
    );
    await addColIfMissing(
      client,
      'products',
      'perk_free_returns_text',
      "TEXT DEFAULT 'FREE 15-Day Returns'"
    );
    await addColIfMissing(
      client,
      'products',
      'perk_buy_now_pay_later_text',
      "TEXT DEFAULT 'Buy Now, Pay Later with Tamara & Tabby'"
    );
    await addColIfMissing(
      client,
      'products',
      'perk_next_day_riyadh_text',
      "TEXT DEFAULT 'Free Next Day Delivery in Riyadh'"
    );

    // ---- product_images
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_images (
        id SERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        image_url TEXT NOT NULL,
        is_main BOOLEAN NOT NULL DEFAULT FALSE,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);

    // ---- customers (match your Neon schema)
    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        address TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        password_hash TEXT NOT NULL
      )
    `);

    // if table existed without password_hash in old versions
    await addColIfMissing(client, 'customers', 'password_hash', "TEXT NOT NULL DEFAULT ''");

    // normalize old nulls
    await client.query(`UPDATE customers SET password_hash = '' WHERE password_hash IS NULL`);

    // enforce default/not null safely
    await client.query(`ALTER TABLE customers ALTER COLUMN password_hash SET DEFAULT ''`);
    await client.query(`
      DO $$
      BEGIN
        ALTER TABLE customers ALTER COLUMN password_hash SET NOT NULL;
      EXCEPTION WHEN others THEN
        -- ignore
      END $$;
    `);

    // ---- orders (match your Neon schema)
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        total NUMERIC(10,2) NOT NULL DEFAULT 0,
        status TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        customer_name TEXT,
        customer_email TEXT,
        customer_address TEXT
      )
    `);

    // ensure snapshot columns exist even if older table
    await addColIfMissing(client, 'orders', 'customer_name', 'TEXT');
    await addColIfMissing(client, 'orders', 'customer_email', 'TEXT');
    await addColIfMissing(client, 'orders', 'customer_address', 'TEXT');

    // ---- order_items (match your Neon schema: product_name exists)
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        price NUMERIC(10,2) NOT NULL DEFAULT 0,
        product_name TEXT
      )
    `);

    // if old table exists with different cols, ensure product_name exists
    await addColIfMissing(client, 'order_items', 'product_name', 'TEXT');

    // ---- product_reviews (your Neon schema uses comment, not review_text)
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_reviews (
        id SERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
        rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
        comment TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // ---- roles / permissions (match your Neon schema)
    await client.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT ''
      )
    `);
    await ensureUniqueIndex(client, 'roles_name_unique', 'roles', 'name');

    await client.query(`
      CREATE TABLE IF NOT EXISTS permissions (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        key TEXT,
        label TEXT
      )
    `);

    // IMPORTANT: ON CONFLICT (key) needs a UNIQUE index on permissions.key
    // Your DB might have existed before key was unique -> create unique index now.
    // Note: if there are duplicate keys, this will fail; then you must dedupe once.
    await ensureUniqueIndex(client, 'permissions_key_unique', 'permissions', 'key');

    await client.query(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
        PRIMARY KEY (role_id, permission_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        is_super_admin BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL
      )
    `);
    await ensureUniqueIndex(client, 'admin_users_username_unique', 'admin_users', 'username');

    // ---- seed permissions (safe with ON CONFLICT after unique index)
    const defaultPerms = [
      ['view_dashboard', 'View Dashboard'],
      ['manage_products', 'Manage Products'],
      ['view_orders', 'View Orders'],
      ['manage_orders', 'Manage Orders'],
      ['manage_categories', 'Manage Categories'],
      ['manage_roles', 'Manage Roles'],
      ['manage_users', 'Manage Admin Users'],
      ['manage_customers', 'Manage Customers'],
      ['manage_reviews', 'Manage Reviews'],
    ];

    for (const [key, label] of defaultPerms) {
      await client.query(
        `
        INSERT INTO permissions (key, label, name)
        VALUES ($1, $2, $1)
        ON CONFLICT (key) DO UPDATE SET
          label = EXCLUDED.label
        `,
        [key, label]
      );
    }

    // ---- seed admin user if none exists
    const adminCount = await client.query(`SELECT COUNT(*)::int AS c FROM admin_users`);
    if (adminCount.rows[0].c === 0) {
      const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
      const hash = await bcrypt.hash(adminPassword, 10);
      await client.query(
        `INSERT INTO admin_users (username, password_hash, is_super_admin)
         VALUES ($1, $2, TRUE)`,
        ['admin', hash]
      );
      console.log('✅ Seeded default super admin: admin / (ADMIN_PASSWORD or admin123)');
    }

    await client.query('COMMIT');
    console.log('✅ Database initialized/updated successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ initDB failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
