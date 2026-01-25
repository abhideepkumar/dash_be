-- ============================================
-- Dashboard AI - Test Database Setup Script
-- Run this in PostgreSQL to create sample tables
-- ============================================

-- Create database (run separately if needed)
-- CREATE DATABASE dashboard_test;

-- Connect to the database first, then run the rest

-- ============================================
-- USERS & AUTH
-- ============================================

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100),
    phone VARCHAR(20),
    avatar_url TEXT,
    is_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(500) NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- PRODUCTS & INVENTORY
-- ============================================

CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    parent_id INTEGER REFERENCES categories(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    price DECIMAL(10, 2) NOT NULL,
    compare_at_price DECIMAL(10, 2),
    cost_price DECIMAL(10, 2),
    category_id INTEGER REFERENCES categories(id),
    brand VARCHAR(100),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_images (
    id SERIAL PRIMARY KEY,
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    alt_text VARCHAR(255),
    position INTEGER DEFAULT 0,
    is_primary BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS inventory (
    id SERIAL PRIMARY KEY,
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    warehouse_location VARCHAR(50),
    quantity INTEGER NOT NULL DEFAULT 0,
    reserved_quantity INTEGER DEFAULT 0,
    reorder_point INTEGER DEFAULT 10,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- ORDERS & TRANSACTIONS
-- ============================================

CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    order_number VARCHAR(20) UNIQUE NOT NULL,
    status VARCHAR(30) DEFAULT 'pending',
    subtotal DECIMAL(10, 2) NOT NULL,
    tax_amount DECIMAL(10, 2) DEFAULT 0,
    shipping_amount DECIMAL(10, 2) DEFAULT 0,
    discount_amount DECIMAL(10, 2) DEFAULT 0,
    total_amount DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    shipping_address JSONB,
    billing_address JSONB,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
    id SERIAL PRIMARY KEY,
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id),
    product_name VARCHAR(255) NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price DECIMAL(10, 2) NOT NULL,
    total_price DECIMAL(10, 2) NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES orders(id),
    amount DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    payment_method VARCHAR(30),
    payment_provider VARCHAR(50),
    provider_transaction_id VARCHAR(100),
    status VARCHAR(20) DEFAULT 'pending',
    paid_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- REVIEWS & RATINGS
-- ============================================

CREATE TABLE IF NOT EXISTS reviews (
    id SERIAL PRIMARY KEY,
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    title VARCHAR(200),
    content TEXT,
    is_verified_purchase BOOLEAN DEFAULT FALSE,
    helpful_votes INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- ANALYTICS & LOGS
-- ============================================

CREATE TABLE IF NOT EXISTS page_views (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    session_id VARCHAR(100),
    page_url TEXT NOT NULL,
    referrer_url TEXT,
    device_type VARCHAR(20),
    browser VARCHAR(50),
    country VARCHAR(2),
    viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_views (
    id BIGSERIAL PRIMARY KEY,
    product_id UUID REFERENCES products(id),
    user_id UUID REFERENCES users(id),
    session_id VARCHAR(100),
    viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- SAMPLE DATA
-- ============================================

-- Insert sample categories
INSERT INTO categories (name, slug, description) VALUES
    ('Electronics', 'electronics', 'Electronic devices and gadgets'),
    ('Clothing', 'clothing', 'Apparel and fashion items'),
    ('Home & Garden', 'home-garden', 'Home improvement and garden supplies'),
    ('Sports', 'sports', 'Sports equipment and accessories'),
    ('Books', 'books', 'Physical and digital books');

-- Insert sample users
INSERT INTO users (email, password_hash, full_name, is_verified) VALUES
    ('john@example.com', 'hash123', 'John Doe', true),
    ('jane@example.com', 'hash456', 'Jane Smith', true),
    ('bob@example.com', 'hash789', 'Bob Wilson', false);

-- Insert sample products
INSERT INTO products (sku, name, description, price, cost_price, category_id, brand) VALUES
    ('ELEC-001', 'Wireless Headphones', 'Premium noise-canceling wireless headphones', 149.99, 75.00, 1, 'AudioTech'),
    ('ELEC-002', 'Smart Watch Pro', 'Advanced fitness tracking smartwatch', 299.99, 150.00, 1, 'TechWear'),
    ('CLTH-001', 'Cotton T-Shirt', 'Comfortable 100% cotton t-shirt', 24.99, 8.00, 2, 'BasicWear'),
    ('HOME-001', 'LED Desk Lamp', 'Adjustable LED lamp with USB charging', 45.99, 20.00, 3, 'LightPro'),
    ('SPRT-001', 'Yoga Mat Premium', 'Non-slip exercise yoga mat', 35.99, 12.00, 4, 'FitGear');

-- Insert sample inventory
INSERT INTO inventory (product_id, warehouse_location, quantity, reserved_quantity)
SELECT id, 'MAIN-A1', 100, 5 FROM products WHERE sku = 'ELEC-001'
UNION ALL
SELECT id, 'MAIN-A2', 50, 10 FROM products WHERE sku = 'ELEC-002'
UNION ALL
SELECT id, 'MAIN-B1', 200, 0 FROM products WHERE sku = 'CLTH-001'
UNION ALL
SELECT id, 'MAIN-B2', 75, 3 FROM products WHERE sku = 'HOME-001'
UNION ALL
SELECT id, 'MAIN-C1', 150, 8 FROM products WHERE sku = 'SPRT-001';

-- Insert sample orders
INSERT INTO orders (user_id, order_number, status, subtotal, tax_amount, shipping_amount, total_amount)
SELECT 
    u.id,
    'ORD-' || LPAD(ROW_NUMBER() OVER()::TEXT, 6, '0'),
    CASE (ROW_NUMBER() OVER() % 4)
        WHEN 0 THEN 'completed'
        WHEN 1 THEN 'shipped'
        WHEN 2 THEN 'processing'
        ELSE 'pending'
    END,
    174.98,
    14.00,
    9.99,
    198.97
FROM users u
CROSS JOIN generate_series(1, 3);

-- Insert sample reviews
INSERT INTO reviews (product_id, user_id, rating, title, content, is_verified_purchase)
SELECT 
    p.id,
    u.id,
    4 + (RANDOM() > 0.5)::INT,
    'Great product!',
    'Really happy with this purchase. Would recommend.',
    true
FROM products p
CROSS JOIN users u
LIMIT 10;

-- ============================================
-- DONE! Your test database is ready.
-- ============================================

SELECT 'Database setup complete!' AS status;
SELECT 'Tables created: ' || COUNT(*)::TEXT FROM information_schema.tables WHERE table_schema = 'public';
