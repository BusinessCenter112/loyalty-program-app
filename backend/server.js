const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../frontend')));

// PostgreSQL connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://web20businesscenter_user:pM42fzthbgk86ssmFR4Ilv2nxcNjbrIA@dpg-d5gl59q4d50c73b232h0-a/web20businesscenter',
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        // Create customers table
        await client.query(`
            CREATE TABLE IF NOT EXISTS customers (
                id SERIAL PRIMARY KEY,
                first_name VARCHAR(255) NOT NULL,
                last_name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                total_dropoffs INTEGER DEFAULT 0,
                rewards_redeemed INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create dropoffs table
        await client.query(`
            CREATE TABLE IF NOT EXISTS dropoffs (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
                quantity INTEGER NOT NULL,
                date DATE NOT NULL,
                added_by VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create staff table
        await client.query(`
            CREATE TABLE IF NOT EXISTS staff (
                id SERIAL PRIMARY KEY,
                pin VARCHAR(10) UNIQUE NOT NULL,
                name VARCHAR(255) NOT NULL
            )
        `);

        // Insert default staff PINs if table is empty
        const staffCheck = await client.query('SELECT COUNT(*) FROM staff');
        if (parseInt(staffCheck.rows[0].count) === 0) {
            await client.query(`
                INSERT INTO staff (pin, name) VALUES
                ('1157', 'Staff Member 1'),
                ('5600', 'Staff Member 2'),
                ('0725', 'Staff Member 3')
            `);
            console.log('Default staff PINs initialized');
        }

        console.log('Database tables initialized successfully');
    } catch (error) {
        console.error('Database initialization error:', error);
    } finally {
        client.release();
    }
}

// API Routes

// Customer registration
app.post('/api/customers/register', async (req, res) => {
    const { firstName, lastName, email } = req.body;

    if (!firstName || !lastName || !email) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    try {
        // Check if customer already exists
        const existing = await pool.query(
            'SELECT * FROM customers WHERE LOWER(email) = LOWER($1)',
            [email]
        );

        if (existing.rows.length > 0) {
            return res.json({
                success: true,
                message: 'Welcome back!',
                customer: existing.rows[0]
            });
        }

        // Create new customer
        const result = await pool.query(
            `INSERT INTO customers (first_name, last_name, email, total_dropoffs, rewards_redeemed)
             VALUES ($1, $2, $3, 0, 0)
             RETURNING *`,
            [firstName, lastName, email]
        );

        res.json({
            success: true,
            message: 'Registration successful!',
            customer: result.rows[0]
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed', details: error.message });
    }
});

// Staff login
app.post('/api/staff/login', async (req, res) => {
    const { pin } = req.body;

    if (!pin) {
        return res.status(400).json({ error: 'PIN is required' });
    }

    try {
        const result = await pool.query('SELECT * FROM staff WHERE pin = $1', [pin]);

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid PIN' });
        }

        const staffMember = result.rows[0];
        res.json({
            success: true,
            staff: { id: staffMember.id, name: staffMember.name, pin: staffMember.pin }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed', details: error.message });
    }
});

// Search customers
app.get('/api/customers/search', async (req, res) => {
    const { query } = req.query;

    if (!query) {
        return res.status(400).json({ error: 'Search query is required' });
    }

    try {
        const searchPattern = `%${query.toLowerCase()}%`;
        const result = await pool.query(
            `SELECT * FROM customers
             WHERE LOWER(first_name) LIKE $1
                OR LOWER(last_name) LIKE $1
                OR LOWER(email) LIKE $1
                OR LOWER(first_name || ' ' || last_name) LIKE $1
             ORDER BY last_name, first_name`,
            [searchPattern]
        );

        res.json({ customers: result.rows });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'Search failed', details: error.message });
    }
});

// Get customer details with dropoffs
app.get('/api/customers/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const customerResult = await pool.query(
            'SELECT * FROM customers WHERE id = $1',
            [parseInt(id)]
        );

        if (customerResult.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const dropoffsResult = await pool.query(
            'SELECT * FROM dropoffs WHERE customer_id = $1 ORDER BY date DESC',
            [parseInt(id)]
        );

        res.json({
            customer: customerResult.rows[0],
            dropoffs: dropoffsResult.rows
        });
    } catch (error) {
        console.error('Fetch customer error:', error);
        res.status(500).json({ error: 'Failed to fetch customer', details: error.message });
    }
});

// Add dropoff
app.post('/api/dropoffs', async (req, res) => {
    const { customerId, quantity, date, staffPin } = req.body;

    if (!customerId || !quantity || !date) {
        return res.status(400).json({ error: 'Customer ID, quantity, and date are required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Check if customer exists
        const customerCheck = await client.query(
            'SELECT * FROM customers WHERE id = $1',
            [parseInt(customerId)]
        );

        if (customerCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Customer not found' });
        }

        // Create dropoff record
        await client.query(
            'INSERT INTO dropoffs (customer_id, quantity, date, added_by) VALUES ($1, $2, $3, $4)',
            [parseInt(customerId), parseInt(quantity), date, staffPin || 'Unknown']
        );

        // Update customer total dropoffs
        await client.query(
            'UPDATE customers SET total_dropoffs = total_dropoffs + $1 WHERE id = $2',
            [parseInt(quantity), parseInt(customerId)]
        );

        await client.query('COMMIT');

        // Get updated customer
        const updatedCustomer = await client.query(
            'SELECT * FROM customers WHERE id = $1',
            [parseInt(customerId)]
        );

        const customer = updatedCustomer.rows[0];
        const eligibleRewards = Math.floor(customer.total_dropoffs / 10) - customer.rewards_redeemed;

        res.json({
            success: true,
            message: 'Drop-off recorded successfully',
            customer: customer,
            eligibleRewards
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Add dropoff error:', error);
        res.status(500).json({ error: 'Failed to add dropoff', details: error.message });
    } finally {
        client.release();
    }
});

// Redeem reward
app.post('/api/rewards/redeem', async (req, res) => {
    const { customerId } = req.body;

    if (!customerId) {
        return res.status(400).json({ error: 'Customer ID is required' });
    }

    try {
        const customerResult = await pool.query(
            'SELECT * FROM customers WHERE id = $1',
            [parseInt(customerId)]
        );

        if (customerResult.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const customer = customerResult.rows[0];
        const eligibleRewards = Math.floor(customer.total_dropoffs / 10) - customer.rewards_redeemed;

        if (eligibleRewards <= 0) {
            return res.status(400).json({ error: 'No rewards available to redeem' });
        }

        // Mark reward as redeemed
        const updated = await pool.query(
            'UPDATE customers SET rewards_redeemed = rewards_redeemed + 1 WHERE id = $1 RETURNING *',
            [parseInt(customerId)]
        );

        res.json({
            success: true,
            message: 'Reward redeemed! 10% discount applied.',
            customer: updated.rows[0]
        });
    } catch (error) {
        console.error('Redeem reward error:', error);
        res.status(500).json({ error: 'Failed to redeem reward', details: error.message });
    }
});

// Get all customers (for staff dashboard)
app.get('/api/customers', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM customers ORDER BY last_name, first_name'
        );

        res.json({ customers: result.rows });
    } catch (error) {
        console.error('Fetch customers error:', error);
        res.status(500).json({ error: 'Failed to fetch customers', details: error.message });
    }
});

// Initialize database and start server
initializeDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
        console.log(`\nStaff PINs: 1157, 5600, 0725`);
        console.log(`\nFrontend available at: http://localhost:${PORT}`);
        console.log(`Customer registration: http://localhost:${PORT}/index.html`);
        console.log(`Staff login: http://localhost:${PORT}/staff-login.html`);
    });
}).catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
});
