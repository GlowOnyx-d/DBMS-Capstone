const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// Database connection pool connecting to PostgreSQL database
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Health check endpoint
app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', database: 'connected' });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// GET /products - List all products aggregated with inventory quantities
app.get('/products', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT p.product_id AS id,
                   p.name,
                   p.sku,
                   p.price,
                   COALESCE(SUM(i.quantity), 0)::int AS quantity,
                   p.reorder_threshold AS reorder_level,
                   1 AS category_id,
                   'General' AS category
            FROM products p
            LEFT JOIN inventory i ON i.product_id = p.product_id
            GROUP BY p.product_id, p.name, p.sku, p.price, p.reorder_threshold
            ORDER BY p.product_id
        `);
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Could not fetch products' });
    }
});

// Input validation helper
function isValid({ name, price, reorder_level } = {}) {
    return typeof name === 'string' && name.trim() !== '' &&
        typeof price === 'number' && price >= 0 &&
        Number.isInteger(reorder_level) && reorder_level >= 0;
}

function sendError(res, err) {
    console.error(err.message);
    if (err.code === '23503') {
        return res.status(400).json({ error: 'Foreign key constraint violation' });
    }
    if (err.code === '23505') {
        return res.status(400).json({ error: 'SKU or name already exists' });
    }
    res.status(500).json({ error: err.message || 'Something went wrong' });
}

// POST /products - Add new product with initial inventory
app.post('/products', async (req, res) => {
    const { name, price, reorder_level, sku: customSku } = req.body || {};
    if (!isValid(req.body)) return res.status(400).json({ error: 'Invalid data' });

    // Generate unique SKU if not provided
    const sku = customSku && String(customSku).trim() !== ''
        ? String(customSku).trim()
        : 'WH-' + name.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() + '-' + Math.floor(1000 + Math.random() * 9000);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const prodResult = await client.query(
            `INSERT INTO products (name, sku, price, reorder_threshold)
             VALUES ($1, $2, $3, $4)
             RETURNING product_id AS id, name, sku, price, reorder_threshold AS reorder_level`,
            [name.trim(), sku, price, reorder_level]
        );
        const product = prodResult.rows[0];

        // Ensure default inventory tracking record in first available bin
        const binRes = await client.query('SELECT bin_id FROM bins LIMIT 1');
        const bin_id = binRes.rows[0]?.bin_id || 1;

        await client.query(
            `INSERT INTO inventory (product_id, bin_id, quantity, updated_at)
             VALUES ($1, $2, 0, now())
             ON CONFLICT (product_id, bin_id) DO NOTHING`,
            [product.id, bin_id]
        );

        await client.query('COMMIT');
        product.quantity = 0;
        product.category_id = req.body.category_id || 1;
        product.category = 'General';
        res.status(201).json(product);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        sendError(res, err);
    } finally {
        client.release();
    }
});

// PUT /products/:id - Update product details
app.put('/products/:id', async (req, res) => {
    if (!isValid(req.body)) return res.status(400).json({ error: 'Invalid data' });
    const { name, price, reorder_level } = req.body;
    try {
        const result = await pool.query(
            `UPDATE products
             SET name = $1, price = $2, reorder_threshold = $3
             WHERE product_id = $4
             RETURNING product_id AS id, name, sku, price, reorder_threshold AS reorder_level`,
            [name.trim(), price, reorder_level, req.params.id]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Product not found' });
        
        // Fetch current quantity
        const qtyRes = await pool.query(
            'SELECT COALESCE(SUM(quantity), 0)::int AS quantity FROM inventory WHERE product_id = $1',
            [req.params.id]
        );
        const product = result.rows[0];
        product.quantity = qtyRes.rows[0]?.quantity || 0;
        product.category_id = req.body.category_id || 1;
        product.category = 'General';
        res.json(product);
    } catch (err) {
        sendError(res, err);
    }
});

// DELETE /products/:id - Delete product if no transactions exist
app.delete('/products/:id', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM inventory WHERE product_id = $1', [req.params.id]);
        await client.query('DELETE FROM restock_alerts WHERE product_id = $1', [req.params.id]);
        await client.query('DELETE FROM order_items WHERE product_id = $1', [req.params.id]);
        const result = await client.query('DELETE FROM products WHERE product_id = $1 RETURNING product_id', [req.params.id]);
        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Product not found' });
        }
        await client.query('COMMIT');
        res.json({ message: 'Product deleted' });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err.code === '23503') {
            return res.status(400).json({ error: 'Cannot delete product with recorded transaction history in ledger' });
        }
        sendError(res, err);
    } finally {
        client.release();
    }
});

// POST /stock - Record stock movement (IN/OUT) with atomic ledger update
app.post('/stock', async (req, res) => {
    const { product_id, type, quantity } = req.body || {};
    if (!Number.isInteger(product_id) || !['IN', 'OUT'].includes(type) ||
        !Number.isInteger(quantity) || quantity <= 0) {
        return res.status(400).json({ error: 'Invalid data' });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        if (type === 'IN') {
            // Find bin for product or default to bin 1
            const binRes = await client.query('SELECT bin_id FROM inventory WHERE product_id = $1 LIMIT 1', [product_id]);
            const bin_id = binRes.rows[0]?.bin_id || 1;

            const invRes = await client.query(
                `INSERT INTO inventory (product_id, bin_id, quantity, updated_at)
                 VALUES ($1, $2, $3, now())
                 ON CONFLICT (product_id, bin_id)
                 DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity, updated_at = now()
                 RETURNING quantity`,
                [product_id, bin_id, quantity]
            );
            const quantity_after = invRes.rows[0].quantity;

            await client.query(
                `INSERT INTO inventory_transactions (product_id, bin_id, txn_type, quantity_change, quantity_after, created_at)
                 VALUES ($1, $2, 'RESTOCK', $3, $4, now())`,
                [product_id, bin_id, quantity, quantity_after]
            );
        } else {
            // Find bin with sufficient quantity
            const binRes = await client.query(
                'SELECT bin_id, quantity FROM inventory WHERE product_id = $1 AND quantity >= $2 ORDER BY quantity DESC LIMIT 1',
                [product_id, quantity]
            );
            if (binRes.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'Product not found or not enough stock' });
            }
            const bin_id = binRes.rows[0].bin_id;

            const invRes = await client.query(
                `UPDATE inventory
                 SET quantity = quantity - $1, updated_at = now()
                 WHERE product_id = $2 AND bin_id = $3
                 RETURNING quantity`,
                [quantity, product_id, bin_id]
            );
            const quantity_after = invRes.rows[0].quantity;

            await client.query(
                `INSERT INTO inventory_transactions (product_id, bin_id, txn_type, quantity_change, quantity_after, created_at)
                 VALUES ($1, $2, 'PICK', $3, $4, now())`,
                [product_id, bin_id, -quantity, quantity_after]
            );
        }

        // Fetch updated total quantity for product
        const prodRes = await client.query(`
            SELECT p.product_id AS id,
                   p.name,
                   p.sku,
                   p.price,
                   COALESCE(SUM(i.quantity), 0)::int AS quantity,
                   p.reorder_threshold AS reorder_level
            FROM products p
            LEFT JOIN inventory i ON i.product_id = p.product_id
            WHERE p.product_id = $1
            GROUP BY p.product_id, p.name, p.sku, p.price, p.reorder_threshold
        `, [product_id]);

        await client.query('COMMIT');
        res.json(prodRes.rows[0]);
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        sendError(res, err);
    } finally {
        if (client) client.release();
    }
});

// GET /products/low-stock - Query products at or below reorder threshold
app.get('/products/low-stock', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT p.product_id AS id,
                   p.name,
                   p.sku,
                   p.price,
                   COALESCE(SUM(i.quantity), 0)::int AS quantity,
                   p.reorder_threshold AS reorder_level,
                   1 AS category_id
            FROM products p
            LEFT JOIN inventory i ON i.product_id = p.product_id
            GROUP BY p.product_id, p.name, p.sku, p.price, p.reorder_threshold
            HAVING COALESCE(SUM(i.quantity), 0) <= p.reorder_threshold
            ORDER BY p.product_id
        `);
        res.json(result.rows);
    } catch (err) {
        sendError(res, err);
    }
});

// GET /history - Fetch chronological transaction ledger
app.get('/history', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT t.transaction_id AS id,
                   p.name AS product,
                   CASE WHEN t.quantity_change > 0 THEN 'IN' ELSE 'OUT' END AS type,
                   ABS(t.quantity_change)::int AS quantity,
                   t.created_at
            FROM inventory_transactions t
            JOIN products p ON p.product_id = t.product_id
            ORDER BY t.created_at DESC, t.transaction_id DESC
        `);
        res.json(result.rows);
    } catch (err) {
        sendError(res, err);
    }
});

// Additional warehouse API endpoints
app.get('/warehouses', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM warehouses ORDER BY warehouse_id');
        res.json(result.rows);
    } catch (err) {
        sendError(res, err);
    }
});

app.get('/bins', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT b.*, w.name AS warehouse_name
            FROM bins b
            JOIN warehouses w ON w.warehouse_id = b.warehouse_id
            ORDER BY b.bin_id
        `);
        res.json(result.rows);
    } catch (err) {
        sendError(res, err);
    }
});

app.get('/alerts', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT a.*, p.name AS product_name, b.bin_code
            FROM restock_alerts a
            JOIN products p ON p.product_id = a.product_id
            JOIN bins b ON b.bin_id = a.bin_id
            ORDER BY a.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        sendError(res, err);
    }
});

app.get('/trends', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM daily_stock_trends ORDER BY trend_date DESC');
        res.json(result.rows);
    } catch (err) {
        sendError(res, err);
    }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
