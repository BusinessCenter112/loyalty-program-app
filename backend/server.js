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
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
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
                email VARCHAR(255) NOT NULL,
                phone_number VARCHAR(20),
                total_dropoffs INTEGER DEFAULT 0,
                rewards_redeemed INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Add phone_number column if it doesn't exist (for existing databases)
        try {
            await client.query(`
                ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20)
            `);
            console.log('Phone number column added/verified');
        } catch (error) {
            console.log('Phone number column already exists or error:', error.message);
        }

        // Add referred_by column if it doesn't exist (for existing databases)
        try {
            await client.query(`
                ALTER TABLE customers ADD COLUMN IF NOT EXISTS referred_by VARCHAR(255)
            `);
            console.log('Referred by column added/verified');
        } catch (error) {
            console.log('Referred by column already exists or error:', error.message);
        }

        // Add tier reward tracking columns
        try {
            await client.query(`
                ALTER TABLE customers ADD COLUMN IF NOT EXISTS bronze_reward_claimed BOOLEAN DEFAULT FALSE
            `);
            await client.query(`
                ALTER TABLE customers ADD COLUMN IF NOT EXISTS silver_reward_claimed BOOLEAN DEFAULT FALSE
            `);
            await client.query(`
                ALTER TABLE customers ADD COLUMN IF NOT EXISTS gold_reward_claimed BOOLEAN DEFAULT FALSE
            `);
            console.log('Tier reward columns added/verified');
        } catch (error) {
            console.log('Tier reward columns already exist or error:', error.message);
        }

        // Remove UNIQUE constraint from email if it exists
        // This allows same email with different name combinations
        try {
            await client.query(`
                ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_email_key
            `);
            console.log('Email UNIQUE constraint removed (allows same email with different names)');
        } catch (error) {
            // Constraint might not exist, ignore error
            console.log('No email constraint to remove or already removed');
        }

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
                ('1157', 'Gary Cooper'),
                ('5600', 'Chris Cooper'),
                ('0725', 'Nika Villalva')
            `);
            console.log('Default staff PINs initialized');
        } else {
            // Update existing staff names
            await client.query(`UPDATE staff SET name = 'Gary Cooper' WHERE pin = '1157'`);
            await client.query(`UPDATE staff SET name = 'Chris Cooper' WHERE pin = '5600'`);
            await client.query(`UPDATE staff SET name = 'Nika Villalva' WHERE pin = '0725'`);
            console.log('Staff names updated');
        }

        // Create index on phone_number for faster lookups
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone_number)
        `);

        console.log('Database tables initialized successfully');
    } catch (error) {
        console.error('Database initialization error:', error);
    } finally {
        client.release();
    }
}

// API Routes

// Health check endpoint - keeps database connection warm
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Customer registration
app.post('/api/customers/register', async (req, res) => {
    const { firstName, lastName, email, phoneNumber, referredBy } = req.body;

    if (!firstName || !lastName || !email || !phoneNumber) {
        return res.status(400).json({ error: 'First name, last name, email, and phone number are required' });
    }

    // Validate phone number format (should be 10 digits)
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    if (cleanPhone.length !== 10) {
        return res.status(400).json({ error: 'Phone number must be 10 digits' });
    }

    try {
        // Check if customer already exists by phone
        const phoneCheck = await pool.query(
            'SELECT * FROM customers WHERE phone_number = $1',
            [cleanPhone]
        );
        if (phoneCheck.rows.length > 0) {
            return res.json({
                success: true,
                message: 'Welcome back!',
                customer: phoneCheck.rows[0]
            });
        }

        // Check if customer already exists (must match first name, last name, AND email)
        const existing = await pool.query(
            `SELECT * FROM customers
             WHERE LOWER(first_name) = LOWER($1)
             AND LOWER(last_name) = LOWER($2)
             AND LOWER(email) = LOWER($3)`,
            [firstName, lastName, email]
        );

        if (existing.rows.length > 0) {
            // Update phone number if not already set
            if (!existing.rows[0].phone_number) {
                await pool.query(
                    'UPDATE customers SET phone_number = $1 WHERE id = $2',
                    [cleanPhone, existing.rows[0].id]
                );
                existing.rows[0].phone_number = cleanPhone;
            }
            return res.json({
                success: true,
                message: 'Welcome back!',
                customer: existing.rows[0]
            });
        }

        // Create new customer
        const result = await pool.query(
            `INSERT INTO customers (first_name, last_name, email, phone_number, total_dropoffs, rewards_redeemed, referred_by)
             VALUES ($1, $2, $3, $4, 0, 0, $5)
             RETURNING *`,
            [firstName, lastName, email, cleanPhone, referredBy || null]
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

// Look up customer by phone number
app.get('/api/customers/phone/:phone', async (req, res) => {
    const { phone } = req.params;

    if (!phone) {
        return res.status(400).json({ error: 'Phone number is required' });
    }

    try {
        const result = await pool.query(
            'SELECT * FROM customers WHERE phone_number = $1',
            [phone]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const customer = result.rows[0];
        const eligibleRewards = Math.floor(customer.total_dropoffs / 10) - customer.rewards_redeemed;

        res.json({
            success: true,
            customer: customer,
            eligibleRewards
        });
    } catch (error) {
        console.error('Phone lookup error:', error);
        res.status(500).json({ error: 'Phone lookup failed', details: error.message });
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
            'SELECT * FROM customers ORDER BY created_at DESC'
        );

        res.json({ customers: result.rows });
    } catch (error) {
        console.error('Fetch customers error:', error);
        res.status(500).json({ error: 'Failed to fetch customers', details: error.message });
    }
});

// Get dashboard stats
app.get('/api/stats', async (req, res) => {
    try {
        // Get first day of current month
        const now = new Date();
        const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];

        // Total customers
        const totalCustomers = await pool.query('SELECT COUNT(*) FROM customers');

        // New customers this month
        const newCustomersThisMonth = await pool.query(
            'SELECT COUNT(*) FROM customers WHERE created_at >= $1',
            [firstOfMonth]
        );

        // Drop-offs this month
        const dropoffsThisMonth = await pool.query(
            'SELECT COALESCE(SUM(quantity), 0) as total FROM dropoffs WHERE date >= $1',
            [firstOfMonth]
        );

        // Total drop-offs all time
        const totalDropoffs = await pool.query(
            'SELECT COALESCE(SUM(quantity), 0) as total FROM dropoffs'
        );

        // Rewards redeemed this month (we need to track this - for now use all time)
        const totalRewardsRedeemed = await pool.query(
            'SELECT COALESCE(SUM(rewards_redeemed), 0) as total FROM customers'
        );

        res.json({
            totalCustomers: parseInt(totalCustomers.rows[0].count),
            newCustomersThisMonth: parseInt(newCustomersThisMonth.rows[0].count),
            dropoffsThisMonth: parseInt(dropoffsThisMonth.rows[0].total),
            totalDropoffs: parseInt(totalDropoffs.rows[0].total),
            totalRewardsRedeemed: parseInt(totalRewardsRedeemed.rows[0].total)
        });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: 'Failed to fetch stats', details: error.message });
    }
});

// Update customer phone number
app.patch('/api/customers/:id/phone', async (req, res) => {
    const { id } = req.params;
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required' });
    }

    // Validate phone number format (should be 10 digits)
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    if (cleanPhone.length !== 10) {
        return res.status(400).json({ error: 'Phone number must be 10 digits' });
    }

    try {
        // Check if phone number already exists for a different customer
        const phoneCheck = await pool.query(
            'SELECT * FROM customers WHERE phone_number = $1 AND id != $2',
            [cleanPhone, parseInt(id)]
        );

        if (phoneCheck.rows.length > 0) {
            return res.status(400).json({ error: 'This phone number is already registered to another customer' });
        }

        // Update customer phone number
        const result = await pool.query(
            'UPDATE customers SET phone_number = $1 WHERE id = $2 RETURNING *',
            [cleanPhone, parseInt(id)]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        res.json({
            success: true,
            message: 'Phone number updated successfully',
            customer: result.rows[0]
        });
    } catch (error) {
        console.error('Update phone error:', error);
        res.status(500).json({ error: 'Failed to update phone number', details: error.message });
    }
});

// Toggle tier reward claimed status
app.patch('/api/customers/:id/reward', async (req, res) => {
    const { id } = req.params;
    const { tier, claimed } = req.body;

    const validTiers = ['bronze', 'silver', 'gold'];
    if (!validTiers.includes(tier)) {
        return res.status(400).json({ error: 'Invalid tier. Must be bronze, silver, or gold' });
    }

    if (typeof claimed !== 'boolean') {
        return res.status(400).json({ error: 'Claimed must be a boolean' });
    }

    try {
        const column = `${tier}_reward_claimed`;
        const result = await pool.query(
            `UPDATE customers SET ${column} = $1 WHERE id = $2 RETURNING *`,
            [claimed, parseInt(id)]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        res.json({
            success: true,
            message: `${tier.charAt(0).toUpperCase() + tier.slice(1)} reward ${claimed ? 'marked as claimed' : 'reset'}`,
            customer: result.rows[0]
        });
    } catch (error) {
        console.error('Update reward error:', error);
        res.status(500).json({ error: 'Failed to update reward status', details: error.message });
    }
});

// Delete customer
app.delete('/api/customers/:id', async (req, res) => {
    const { id } = req.params;

    try {
        // Check if customer exists
        const customerCheck = await pool.query(
            'SELECT * FROM customers WHERE id = $1',
            [parseInt(id)]
        );

        if (customerCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const customer = customerCheck.rows[0];

        // Delete customer (dropoffs will be automatically deleted due to CASCADE)
        await pool.query('DELETE FROM customers WHERE id = $1', [parseInt(id)]);

        res.json({
            success: true,
            message: `Customer ${customer.first_name} ${customer.last_name} has been deleted`,
            customer: customer
        });
    } catch (error) {
        console.error('Delete customer error:', error);
        res.status(500).json({ error: 'Failed to delete customer', details: error.message });
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
