-- ============================================
-- Dashboard AI - COMPREHENSIVE TEST DATA
-- Run this AFTER seed-database.sql
-- Creates realistic dataset for Layer 2 testing
-- ============================================

-- ============================================
-- MORE USERS (50 total)
-- ============================================

INSERT INTO users (email, password_hash, full_name, phone, is_verified, created_at, last_login_at) 
SELECT 
    'user' || n || '@example.com',
    'hash_' || md5(random()::text),
    CASE (n % 10)
        WHEN 0 THEN 'Alice'
        WHEN 1 THEN 'Bob'
        WHEN 2 THEN 'Charlie'
        WHEN 3 THEN 'Diana'
        WHEN 4 THEN 'Edward'
        WHEN 5 THEN 'Fiona'
        WHEN 6 THEN 'George'
        WHEN 7 THEN 'Hannah'
        WHEN 8 THEN 'Isaac'
        ELSE 'Julia'
    END || ' ' ||
    CASE (n % 8)
        WHEN 0 THEN 'Smith'
        WHEN 1 THEN 'Johnson'
        WHEN 2 THEN 'Williams'
        WHEN 3 THEN 'Brown'
        WHEN 4 THEN 'Jones'
        WHEN 5 THEN 'Garcia'
        WHEN 6 THEN 'Miller'
        ELSE 'Davis'
    END,
    '+1-555-' || LPAD((1000 + n)::text, 4, '0'),
    (n % 3 != 0), -- 66% verified
    NOW() - INTERVAL '1 day' * (random() * 365)::int,
    NOW() - INTERVAL '1 hour' * (random() * 720)::int
FROM generate_series(1, 50) AS n
ON CONFLICT (email) DO NOTHING;

-- ============================================
-- MORE CATEGORIES (with subcategories)
-- ============================================

INSERT INTO categories (name, slug, description, parent_id) VALUES
    ('Laptops', 'laptops', 'Laptop computers', 1),
    ('Smartphones', 'smartphones', 'Mobile phones', 1),
    ('Audio', 'audio', 'Audio equipment', 1),
    ('Men''s Wear', 'mens-wear', 'Clothing for men', 2),
    ('Women''s Wear', 'womens-wear', 'Clothing for women', 2),
    ('Kitchen', 'kitchen', 'Kitchen appliances and tools', 3),
    ('Furniture', 'furniture', 'Home furniture', 3),
    ('Fitness', 'fitness', 'Fitness equipment', 4),
    ('Outdoor', 'outdoor', 'Outdoor sports gear', 4),
    ('Fiction', 'fiction', 'Fiction books', 5),
    ('Non-Fiction', 'non-fiction', 'Non-fiction books', 5)
ON CONFLICT (slug) DO NOTHING;

-- ============================================
-- MORE PRODUCTS (100 total)
-- ============================================

INSERT INTO products (sku, name, description, price, compare_at_price, cost_price, category_id, brand, is_active, created_at) VALUES
    -- Electronics - Laptops
    ('LAP-001', 'MacBook Pro 14"', 'Apple M3 Pro chip, 18GB RAM, 512GB SSD', 1999.99, 2199.99, 1200.00, 6, 'Apple', true, NOW() - INTERVAL '90 days'),
    ('LAP-002', 'Dell XPS 15', 'Intel i7, 16GB RAM, 512GB SSD, OLED display', 1499.99, NULL, 900.00, 6, 'Dell', true, NOW() - INTERVAL '60 days'),
    ('LAP-003', 'ThinkPad X1 Carbon', 'Business ultrabook, Intel i7, 32GB RAM', 1799.99, 1999.99, 1100.00, 6, 'Lenovo', true, NOW() - INTERVAL '45 days'),
    ('LAP-004', 'HP Spectre x360', 'Convertible laptop, Intel i5, 16GB RAM', 1299.99, NULL, 800.00, 6, 'HP', true, NOW() - INTERVAL '30 days'),
    ('LAP-005', 'Asus ROG Zephyrus', 'Gaming laptop, RTX 4070, AMD Ryzen 9', 1899.99, 2099.99, 1150.00, 6, 'Asus', true, NOW() - INTERVAL '15 days'),
    
    -- Electronics - Smartphones
    ('PHN-001', 'iPhone 15 Pro', 'A17 Pro chip, 256GB, Titanium', 1099.99, NULL, 700.00, 7, 'Apple', true, NOW() - INTERVAL '80 days'),
    ('PHN-002', 'Samsung Galaxy S24', 'Snapdragon 8 Gen 3, 256GB', 899.99, 999.99, 550.00, 7, 'Samsung', true, NOW() - INTERVAL '70 days'),
    ('PHN-003', 'Google Pixel 8 Pro', 'Tensor G3, 128GB, AI features', 999.99, NULL, 600.00, 7, 'Google', true, NOW() - INTERVAL '55 days'),
    ('PHN-004', 'OnePlus 12', 'Snapdragon 8 Gen 3, 512GB', 799.99, 899.99, 480.00, 7, 'OnePlus', true, NOW() - INTERVAL '40 days'),
    
    -- Electronics - Audio
    ('AUD-001', 'Sony WH-1000XM5', 'Premium noise canceling headphones', 349.99, 399.99, 180.00, 8, 'Sony', true, NOW() - INTERVAL '100 days'),
    ('AUD-002', 'AirPods Pro 2', 'Active noise cancellation, USB-C', 249.99, NULL, 150.00, 8, 'Apple', true, NOW() - INTERVAL '85 days'),
    ('AUD-003', 'Bose QuietComfort Ultra', 'Spatial audio, 24hr battery', 429.99, NULL, 220.00, 8, 'Bose', true, NOW() - INTERVAL '50 days'),
    ('AUD-004', 'JBL Flip 6', 'Portable Bluetooth speaker', 129.99, 149.99, 65.00, 8, 'JBL', true, NOW() - INTERVAL '35 days'),
    ('AUD-005', 'Sonos One', 'Smart speaker with Alexa', 219.99, NULL, 110.00, 8, 'Sonos', true, NOW() - INTERVAL '20 days'),
    
    -- Clothing - Men's
    ('MEN-001', 'Slim Fit Jeans', 'Stretch denim, dark wash', 59.99, 79.99, 25.00, 9, 'LeviStyle', true, NOW() - INTERVAL '120 days'),
    ('MEN-002', 'Oxford Button-Down', 'Classic white oxford shirt', 44.99, NULL, 18.00, 9, 'ClassicWear', true, NOW() - INTERVAL '110 days'),
    ('MEN-003', 'Wool Blazer', 'Navy blue, slim fit', 189.99, 249.99, 80.00, 9, 'TailorPro', true, NOW() - INTERVAL '95 days'),
    ('MEN-004', 'Chino Pants', 'Cotton blend, khaki', 49.99, NULL, 20.00, 9, 'BasicWear', true, NOW() - INTERVAL '75 days'),
    ('MEN-005', 'Leather Belt', 'Genuine leather, brown', 34.99, 44.99, 12.00, 9, 'LeatherCraft', true, NOW() - INTERVAL '65 days'),
    
    -- Clothing - Women's
    ('WMN-001', 'Floral Maxi Dress', 'Summer collection, cotton blend', 79.99, 99.99, 32.00, 10, 'FloralStyle', true, NOW() - INTERVAL '105 days'),
    ('WMN-002', 'High-Rise Leggings', 'Workout leggings, compression fit', 54.99, NULL, 22.00, 10, 'FitWear', true, NOW() - INTERVAL '88 days'),
    ('WMN-003', 'Cashmere Sweater', 'Pure cashmere, crew neck', 149.99, 199.99, 65.00, 10, 'LuxuryKnit', true, NOW() - INTERVAL '72 days'),
    ('WMN-004', 'Silk Blouse', 'Office wear, ivory', 89.99, NULL, 38.00, 10, 'EleganceWear', true, NOW() - INTERVAL '58 days'),
    ('WMN-005', 'Ankle Boots', 'Suede, block heel', 119.99, 149.99, 50.00, 10, 'StepStyle', true, NOW() - INTERVAL '42 days'),
    
    -- Home - Kitchen
    ('KIT-001', 'Instant Pot Duo', '7-in-1 pressure cooker, 6 quart', 89.99, 99.99, 45.00, 11, 'InstantPot', true, NOW() - INTERVAL '130 days'),
    ('KIT-002', 'KitchenAid Mixer', 'Stand mixer, 5 quart, red', 349.99, 449.99, 180.00, 11, 'KitchenAid', true, NOW() - INTERVAL '115 days'),
    ('KIT-003', 'Ninja Blender', 'Professional blender, 1000W', 129.99, NULL, 65.00, 11, 'Ninja', true, NOW() - INTERVAL '98 days'),
    ('KIT-004', 'Nespresso Vertuo', 'Coffee machine with frother', 199.99, 249.99, 100.00, 11, 'Nespresso', true, NOW() - INTERVAL '82 days'),
    ('KIT-005', 'Cast Iron Skillet', '12-inch pre-seasoned', 44.99, NULL, 18.00, 11, 'Lodge', true, NOW() - INTERVAL '68 days'),
    
    -- Home - Furniture
    ('FRN-001', 'Ergonomic Office Chair', 'Mesh back, lumbar support', 299.99, 399.99, 150.00, 12, 'ErgoMax', true, NOW() - INTERVAL '140 days'),
    ('FRN-002', 'Standing Desk', 'Electric height adjustable, 60"', 549.99, 699.99, 280.00, 12, 'StandUp', true, NOW() - INTERVAL '125 days'),
    ('FRN-003', 'Bookshelf', '5-tier, solid wood', 179.99, NULL, 90.00, 12, 'WoodCraft', true, NOW() - INTERVAL '108 days'),
    ('FRN-004', 'Accent Chair', 'Mid-century modern, velvet', 249.99, 299.99, 125.00, 12, 'ModernHome', true, NOW() - INTERVAL '92 days'),
    ('FRN-005', 'Coffee Table', 'Glass top, metal frame', 159.99, NULL, 80.00, 12, 'UrbanLiving', true, NOW() - INTERVAL '78 days'),
    
    -- Sports - Fitness
    ('FIT-001', 'Adjustable Dumbbells', '5-52.5 lbs each', 349.99, 449.99, 175.00, 13, 'BowFlex', true, NOW() - INTERVAL '150 days'),
    ('FIT-002', 'Resistance Bands Set', '5 bands with handles', 29.99, NULL, 12.00, 13, 'FitGear', true, NOW() - INTERVAL '135 days'),
    ('FIT-003', 'Foam Roller', 'High-density, 18-inch', 24.99, 34.99, 10.00, 13, 'TriggerPoint', true, NOW() - INTERVAL '118 days'),
    ('FIT-004', 'Jump Rope', 'Speed rope, adjustable', 14.99, NULL, 5.00, 13, 'CrossRope', true, NOW() - INTERVAL '102 days'),
    ('FIT-005', 'Kettlebell 35lb', 'Cast iron, vinyl coated', 54.99, 69.99, 25.00, 13, 'IronCore', true, NOW() - INTERVAL '88 days'),
    
    -- Sports - Outdoor
    ('OUT-001', 'Hiking Backpack', '50L, waterproof', 149.99, 189.99, 75.00, 14, 'Osprey', true, NOW() - INTERVAL '160 days'),
    ('OUT-002', 'Camping Tent', '4-person, instant setup', 199.99, NULL, 100.00, 14, 'ColemanPro', true, NOW() - INTERVAL '145 days'),
    ('OUT-003', 'Sleeping Bag', '20°F rated, mummy style', 89.99, 119.99, 45.00, 14, 'NorthFace', true, NOW() - INTERVAL '128 days'),
    ('OUT-004', 'Trekking Poles', 'Carbon fiber, collapsible', 79.99, NULL, 40.00, 14, 'BlackDiamond', true, NOW() - INTERVAL '112 days'),
    ('OUT-005', 'Portable Hammock', 'Double size with straps', 49.99, 64.99, 22.00, 14, 'ENO', true, NOW() - INTERVAL '96 days'),
    
    -- Books - Fiction
    ('FIC-001', 'The Midnight Library', 'Matt Haig, hardcover', 24.99, NULL, 10.00, 15, 'Viking', true, NOW() - INTERVAL '180 days'),
    ('FIC-002', 'Project Hail Mary', 'Andy Weir, paperback', 16.99, 19.99, 7.00, 15, 'Ballantine', true, NOW() - INTERVAL '165 days'),
    ('FIC-003', 'Lessons in Chemistry', 'Bonnie Garmus, hardcover', 28.99, NULL, 12.00, 15, 'Doubleday', true, NOW() - INTERVAL '148 days'),
    ('FIC-004', 'Tomorrow and Tomorrow', 'Gabrielle Zevin, paperback', 17.99, 22.99, 8.00, 15, 'Knopf', true, NOW() - INTERVAL '132 days'),
    ('FIC-005', 'Fourth Wing', 'Rebecca Yarros, hardcover', 29.99, NULL, 13.00, 15, 'Entangled', true, NOW() - INTERVAL '116 days'),
    
    -- Books - Non-Fiction
    ('NON-001', 'Atomic Habits', 'James Clear, hardcover', 27.99, NULL, 11.00, 16, 'Avery', true, NOW() - INTERVAL '200 days'),
    ('NON-002', 'The Psychology of Money', 'Morgan Housel, paperback', 18.99, 24.99, 8.00, 16, 'Harriman', true, NOW() - INTERVAL '185 days'),
    ('NON-003', 'Thinking Fast and Slow', 'Daniel Kahneman, paperback', 19.99, NULL, 9.00, 16, 'FSG', true, NOW() - INTERVAL '168 days'),
    ('NON-004', 'Deep Work', 'Cal Newport, hardcover', 26.99, 32.99, 11.00, 16, 'GrandCentral', true, NOW() - INTERVAL '152 days'),
    ('NON-005', 'Sapiens', 'Yuval Noah Harari, paperback', 22.99, NULL, 10.00, 16, 'Harper', true, NOW() - INTERVAL '136 days')
ON CONFLICT (sku) DO NOTHING;

-- ============================================
-- INVENTORY FOR NEW PRODUCTS
-- ============================================

INSERT INTO inventory (product_id, warehouse_location, quantity, reserved_quantity, reorder_point)
SELECT 
    p.id,
    CASE (ROW_NUMBER() OVER() % 4)
        WHEN 0 THEN 'MAIN-A1'
        WHEN 1 THEN 'MAIN-A2'
        WHEN 2 THEN 'MAIN-B1'
        ELSE 'MAIN-B2'
    END,
    (random() * 200 + 20)::int,
    (random() * 15)::int,
    (random() * 20 + 5)::int
FROM products p
WHERE NOT EXISTS (SELECT 1 FROM inventory i WHERE i.product_id = p.id);

-- ============================================
-- LOTS OF ORDERS (500+ orders over past year)
-- First, clean up any existing orders to avoid conflicts
-- ============================================

DELETE FROM order_items;
DELETE FROM payments;
DELETE FROM orders;

DO $$
DECLARE
    user_rec RECORD;
    product_rec RECORD;
    order_uuid UUID;
    order_date TIMESTAMP;
    item_qty INTEGER;
    item_total DECIMAL(10,2);
    order_subtotal DECIMAL(10,2);
    order_tax DECIMAL(10,2);
    order_shipping DECIMAL(10,2);
    order_total DECIMAL(10,2);
    order_status TEXT;
    i INTEGER;
    j INTEGER;
BEGIN
    FOR i IN 1..500 LOOP
        -- Pick a random user
        SELECT id INTO user_rec FROM users ORDER BY random() LIMIT 1;
        
        -- Random order date within past year
        order_date := NOW() - (random() * 365 || ' days')::interval;
        
        -- Random status based on age
        IF order_date < NOW() - INTERVAL '30 days' THEN
            order_status := (ARRAY['completed', 'completed', 'completed', 'shipped', 'cancelled'])[floor(random() * 5 + 1)];
        ELSIF order_date < NOW() - INTERVAL '7 days' THEN
            order_status := (ARRAY['completed', 'shipped', 'shipped', 'processing'])[floor(random() * 4 + 1)];
        ELSE
            order_status := (ARRAY['pending', 'processing', 'shipped'])[floor(random() * 3 + 1)];
        END IF;
        
        order_subtotal := 0;
        order_uuid := gen_random_uuid();
        
        -- Insert order first
        INSERT INTO orders (id, user_id, order_number, status, subtotal, tax_amount, shipping_amount, total_amount, created_at, updated_at)
        VALUES (order_uuid, user_rec.id, 'ORD-' || LPAD(i::text, 6, '0'), order_status, 0, 0, 0, 0, order_date, order_date + INTERVAL '1 hour');
        
        -- Add 1-5 random items to order
        FOR j IN 1..floor(random() * 5 + 1)::int LOOP
            SELECT id, name, price INTO product_rec FROM products ORDER BY random() LIMIT 1;
            item_qty := floor(random() * 3 + 1)::int;
            item_total := product_rec.price * item_qty;
            order_subtotal := order_subtotal + item_total;
            
            INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, total_price)
            VALUES (order_uuid, product_rec.id, product_rec.name, item_qty, product_rec.price, item_total);
        END LOOP;
        
        -- Update order totals
        order_tax := order_subtotal * 0.08;
        order_shipping := CASE WHEN order_subtotal > 100 THEN 0 ELSE 9.99 END;
        order_total := order_subtotal + order_tax + order_shipping;
        
        UPDATE orders 
        SET subtotal = order_subtotal, tax_amount = order_tax, shipping_amount = order_shipping, total_amount = order_total
        WHERE id = order_uuid;
        
        -- Add payment for completed/shipped orders
        IF order_status IN ('completed', 'shipped') THEN
            INSERT INTO payments (order_id, amount, payment_method, payment_provider, status, paid_at, created_at)
            VALUES (
                order_uuid, 
                order_total,
                (ARRAY['credit_card', 'debit_card', 'paypal', 'apple_pay'])[floor(random() * 4 + 1)],
                (ARRAY['Stripe', 'PayPal', 'Square'])[floor(random() * 3 + 1)],
                'completed',
                order_date + INTERVAL '5 minutes',
                order_date + INTERVAL '2 minutes'
            );
        END IF;
    END LOOP;
END $$;

-- ============================================
-- REVIEWS (200+ reviews)
-- ============================================

INSERT INTO reviews (product_id, user_id, rating, title, content, is_verified_purchase, helpful_votes, created_at)
SELECT 
    p.id,
    u.id,
    CASE 
        WHEN random() < 0.1 THEN 1
        WHEN random() < 0.15 THEN 2
        WHEN random() < 0.25 THEN 3
        WHEN random() < 0.5 THEN 4
        ELSE 5
    END,
    CASE (floor(random() * 10)::int)
        WHEN 0 THEN 'Amazing product!'
        WHEN 1 THEN 'Great value for money'
        WHEN 2 THEN 'Exceeded expectations'
        WHEN 3 THEN 'Good quality'
        WHEN 4 THEN 'Works as described'
        WHEN 5 THEN 'Decent but could be better'
        WHEN 6 THEN 'Not what I expected'
        WHEN 7 THEN 'Perfect for my needs'
        WHEN 8 THEN 'Highly recommend!'
        ELSE 'Does the job'
    END,
    CASE (floor(random() * 8)::int)
        WHEN 0 THEN 'I have been using this for a few weeks now and absolutely love it. The quality is outstanding.'
        WHEN 1 THEN 'Fast shipping, great packaging. The product itself is exactly as described. Very happy with this purchase.'
        WHEN 2 THEN 'This is my second one - bought one for home and office. Cannot imagine life without it now.'
        WHEN 3 THEN 'A bit pricey but definitely worth every penny. Superior quality compared to competitors.'
        WHEN 4 THEN 'Does exactly what it says. No complaints here. Would buy again.'
        WHEN 5 THEN 'Took a star off because delivery was delayed, but the product itself is great.'
        WHEN 6 THEN 'Good for beginners. More advanced users might want something with more features.'
        ELSE 'Solid purchase. Arrived on time and works perfectly.'
    END,
    random() > 0.3,
    (random() * 50)::int,
    NOW() - (random() * 180 || ' days')::interval
FROM products p
CROSS JOIN users u
WHERE random() < 0.15  -- Only create reviews for ~15% of product-user combinations
LIMIT 250;

-- ============================================
-- PAGE VIEWS (1000+ for analytics)
-- ============================================

INSERT INTO page_views (user_id, session_id, page_url, referrer_url, device_type, browser, country, viewed_at)
SELECT 
    CASE WHEN random() > 0.3 THEN u.id ELSE NULL END,
    'sess_' || md5(random()::text),
    (ARRAY['/', '/products', '/products/' || p.sku, '/cart', '/checkout', '/account', '/about', '/contact'])[floor(random() * 8 + 1)],
    CASE (floor(random() * 5)::int)
        WHEN 0 THEN 'https://google.com'
        WHEN 1 THEN 'https://facebook.com'
        WHEN 2 THEN 'https://instagram.com'
        WHEN 3 THEN NULL
        ELSE 'https://twitter.com'
    END,
    (ARRAY['desktop', 'mobile', 'tablet'])[floor(random() * 3 + 1)],
    (ARRAY['Chrome', 'Safari', 'Firefox', 'Edge'])[floor(random() * 4 + 1)],
    (ARRAY['US', 'UK', 'CA', 'DE', 'FR', 'AU', 'IN', 'JP'])[floor(random() * 8 + 1)],
    NOW() - (random() * 90 || ' days')::interval
FROM users u
CROSS JOIN products p
WHERE random() < 0.02
LIMIT 1500;

-- ============================================
-- PRODUCT VIEWS (for recommendation testing)
-- ============================================

INSERT INTO product_views (product_id, user_id, session_id, viewed_at)
SELECT 
    p.id,
    CASE WHEN random() > 0.2 THEN u.id ELSE NULL END,
    'sess_' || md5(random()::text),
    NOW() - (random() * 90 || ' days')::interval
FROM products p
CROSS JOIN users u
WHERE random() < 0.05
LIMIT 2000;

-- ============================================
-- SUMMARY
-- ============================================

SELECT 'Data population complete!' AS status;
SELECT 'Users: ' || COUNT(*)::text FROM users;
SELECT 'Products: ' || COUNT(*)::text FROM products;
SELECT 'Orders: ' || COUNT(*)::text FROM orders;
SELECT 'Order Items: ' || COUNT(*)::text FROM order_items;
SELECT 'Payments: ' || COUNT(*)::text FROM payments;
SELECT 'Reviews: ' || COUNT(*)::text FROM reviews;
SELECT 'Page Views: ' || COUNT(*)::text FROM page_views;
SELECT 'Product Views: ' || COUNT(*)::text FROM product_views;
