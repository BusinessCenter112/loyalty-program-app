const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../frontend')));

// PostgreSQL connection
if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable is not set.');
    console.error('Set it before starting the server, e.g.:');
    console.error('  DATABASE_URL=postgresql://user:pass@host/dbname node server.js');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

// AWeber setup — new signups who check the email box are added to the AWeber list.
// Staff connect once from the staff dashboard; tokens live in the aweber_connection table and refresh automatically.
const AWEBER_AUTH_URL = 'https://auth.aweber.com/oauth2';
const AWEBER_API_URL = 'https://api.aweber.com/1.0';
const AWEBER_SCOPES = 'account.read list.read subscriber.read subscriber.write';
const AWEBER_LIST_NAME = process.env.AWEBER_LIST_NAME || 'Business Center Rewards Club';
const AWEBER_REDIRECT_URI = process.env.AWEBER_REDIRECT_URI || 'https://loyalty-program-app-xb1v.onrender.com/api/aweber/callback';

function aweberConfigured() {
    return !!(process.env.AWEBER_CLIENT_ID && process.env.AWEBER_CLIENT_SECRET);
}

async function aweberTokenRequest(params) {
    const basic = Buffer.from(`${process.env.AWEBER_CLIENT_ID.trim()}:${process.env.AWEBER_CLIENT_SECRET.trim()}`).toString('base64');
    const res = await fetch(`${AWEBER_AUTH_URL}/token`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
        throw new Error(`AWeber token error ${res.status}: ${data.error_description || data.error || 'no access token'}`);
    }
    return data;
}

async function saveAweberTokens(tokens) {
    const expiresAt = new Date(Date.now() + (tokens.expires_in || 7200) * 1000);
    await pool.query(
        `UPDATE aweber_connection
         SET access_token = $1, refresh_token = COALESCE($2, refresh_token), expires_at = $3, updated_at = NOW()
         WHERE id = 1`,
        [tokens.access_token, tokens.refresh_token || null, expiresAt]
    );
}

async function aweberApi(accessToken, urlPath, options = {}) {
    const res = await fetch(`${AWEBER_API_URL}${urlPath}`, {
        ...options,
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json',
            ...(options.body ? { 'Content-Type': 'application/json' } : {})
        }
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
    return { ok: res.ok, status: res.status, data };
}

// Returns the connection row with a fresh access token, or null if not connected yet.
// Refreshes are shared so two signups at once don't both spend the same refresh token.
let aweberRefreshPromise = null;
async function getAweberConnection() {
    const loadRow = async () => (await pool.query('SELECT * FROM aweber_connection WHERE id = 1')).rows[0];
    const conn = await loadRow();
    if (!conn || !conn.refresh_token || !conn.list_id) return null;
    if (conn.access_token && new Date(conn.expires_at) > new Date(Date.now() + 60000)) return conn;

    if (!aweberRefreshPromise) {
        aweberRefreshPromise = aweberTokenRequest({ grant_type: 'refresh_token', refresh_token: conn.refresh_token })
            .then(saveAweberTokens)
            .finally(() => { aweberRefreshPromise = null; });
    }
    await aweberRefreshPromise;
    return loadRow();
}

async function addToAweber(customer) {
    if (!aweberConfigured()) {
        console.log('[AWeber skipped - not configured]', customer.email);
        return;
    }
    try {
        const conn = await getAweberConnection();
        if (!conn) {
            console.log('[AWeber skipped - not connected yet]', customer.email);
            return;
        }
        const { ok, status, data } = await aweberApi(
            conn.access_token,
            `/accounts/${conn.account_id}/lists/${conn.list_id}/subscribers`,
            {
                method: 'POST',
                body: JSON.stringify({
                    email: customer.email,
                    name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
                    tags: ['rewards-kiosk']
                })
            }
        );
        const alreadySubscribed = status === 400 && /already subscribed/i.test(JSON.stringify(data));
        if (!ok && !alreadySubscribed) {
            console.error('[AWeber error]', status, JSON.stringify(data));
            return;
        }
        await pool.query('UPDATE customers SET aweber_added_at = NOW() WHERE id = $1', [customer.id]);
        console.log(`[AWeber] ${alreadySubscribed ? 'already on list' : 'added'}: ${customer.email}`);
    } catch (err) {
        console.error('[AWeber error]', err.message);
    }
}

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

        // Staff added after launch (safe to run every startup)
        await client.query(`
            INSERT INTO staff (pin, name) VALUES ('2599', 'Tom Buck')
            ON CONFLICT (pin) DO UPDATE SET name = EXCLUDED.name
        `);

        // Create index on phone_number for faster lookups
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone_number)
        `);

        // Redemption log table
        await client.query(`
            CREATE TABLE IF NOT EXISTS redemption_log (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
                redeemed_by VARCHAR(100),
                notes VARCHAR(255),
                redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Email marketing opt-in (unchecked by default at the kiosk) and when the customer was sent to AWeber
        await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_consent BOOLEAN DEFAULT FALSE`);
        await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS aweber_added_at TIMESTAMP`);

        // Single-row table holding the AWeber connection (tokens are never sent to the browser)
        await client.query(`
            CREATE TABLE IF NOT EXISTS aweber_connection (
                id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
                access_token TEXT,
                refresh_token TEXT,
                expires_at TIMESTAMPTZ,
                account_id VARCHAR(50),
                list_id VARCHAR(50),
                list_name VARCHAR(255),
                oauth_state VARCHAR(100),
                connected_at TIMESTAMPTZ,
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await client.query(`INSERT INTO aweber_connection (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

        // December gift card raffle — one spin per customer per day, one winner per week.
        // Winner rows keep a copy of name/email/phone so they survive if the customer is deleted.
        await client.query(`
            CREATE TABLE IF NOT EXISTS raffle_spins (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
                week_number INTEGER NOT NULL,
                spin_date DATE NOT NULL,
                won BOOLEAN DEFAULT FALSE,
                odds NUMERIC,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE (customer_id, spin_date)
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS raffle_winners (
                week_number INTEGER PRIMARY KEY,
                customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
                first_name VARCHAR(255),
                last_name VARCHAR(255),
                email VARCHAR(255),
                phone_number VARCHAR(20),
                method VARCHAR(20) NOT NULL,
                prize_choice VARCHAR(255),
                prize_sent BOOLEAN DEFAULT FALSE,
                won_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        console.log('Database tables initialized successfully');
    } catch (error) {
        console.error('Database initialization error:', error);
    } finally {
        client.release();
    }
}

// API Routes

function calcEligibleRewards(customer) {
    let count = 0;
    if (customer.total_dropoffs >= 10 && !customer.bronze_reward_claimed) count++;
    if (customer.total_dropoffs >= 25 && !customer.silver_reward_claimed) count++;
    if (customer.total_dropoffs >= 50 && !customer.gold_reward_claimed) count++;
    return count;
}

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
    const { firstName, lastName, email, phoneNumber, referredBy, emailConsent } = req.body;

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
            `INSERT INTO customers (first_name, last_name, email, phone_number, total_dropoffs, rewards_redeemed, referred_by, email_consent)
             VALUES ($1, $2, $3, $4, 0, 0, $5, $6)
             RETURNING *`,
            [firstName, lastName, email, cleanPhone, referredBy || null, emailConsent === true]
        );

        // Add to the AWeber email list only if they opted in (not awaited so the kiosk isn't slowed down)
        if (result.rows[0].email_consent) {
            addToAweber(result.rows[0]);
        }

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
                OR REPLACE(phone_number, '-', '') LIKE $1
                OR phone_number LIKE $1
             ORDER BY last_name, first_name`,
            [searchPattern]
        );

        res.json({ customers: result.rows });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'Search failed', details: error.message });
    }
});

// Recent activity for the staff dashboard:
//  - rewardReady: customers with an unclaimed tier reward, most recent visit first (all of them; the page shows 10 until "Show all")
//  - newSignups: newest customers first (?signups=N, default 10)
app.get('/api/recent-activity', async (req, res) => {
    const signupLimit = Math.min(Math.max(parseInt(req.query.signups, 10) || 10, 1), 500);
    try {
        const readyWhere = `
            (c.total_dropoffs >= 10 AND NOT COALESCE(c.bronze_reward_claimed, FALSE))
            OR (c.total_dropoffs >= 25 AND NOT COALESCE(c.silver_reward_claimed, FALSE))
            OR (c.total_dropoffs >= 50 AND NOT COALESCE(c.gold_reward_claimed, FALSE))`;

        const [ready, readyCount, signups, signupCount] = await Promise.all([
            pool.query(`
                SELECT c.*, lv.last_visit
                FROM customers c
                LEFT JOIN (
                    SELECT customer_id, MAX(created_at) AS last_visit
                    FROM dropoffs GROUP BY customer_id
                ) lv ON lv.customer_id = c.id
                WHERE ${readyWhere}
                ORDER BY lv.last_visit DESC NULLS LAST
                LIMIT 500`),
            pool.query(`SELECT COUNT(*) FROM customers c WHERE ${readyWhere}`),
            pool.query(`SELECT * FROM customers ORDER BY created_at DESC LIMIT $1`, [signupLimit]),
            pool.query(`SELECT COUNT(*) FROM customers`)
        ]);

        res.json({
            rewardReady: ready.rows,
            rewardReadyTotal: parseInt(readyCount.rows[0].count, 10),
            newSignups: signups.rows,
            customersTotal: parseInt(signupCount.rows[0].count, 10)
        });
    } catch (error) {
        console.error('Recent activity error:', error);
        res.status(500).json({ error: 'Failed to load recent activity' });
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
        const eligibleRewards = calcEligibleRewards(customer);

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
        const eligibleRewards = calcEligibleRewards(customer);

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
    const { customerId, staffName, notes } = req.body;

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
        const eligibleRewards = calcEligibleRewards(customer);

        if (eligibleRewards <= 0) {
            return res.status(400).json({ error: 'No rewards available to redeem' });
        }

        // Mark reward as redeemed
        const updated = await pool.query(
            'UPDATE customers SET rewards_redeemed = rewards_redeemed + 1 WHERE id = $1 RETURNING *',
            [parseInt(customerId)]
        );

        // Log the redemption
        await pool.query(
            'INSERT INTO redemption_log (customer_id, redeemed_by, notes) VALUES ($1, $2, $3)',
            [parseInt(customerId), staffName || 'Unknown', notes || null]
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

// Get redemption log
app.get('/api/redemptions', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT r.id, r.redeemed_by, r.notes, r.redeemed_at,
                   c.first_name, c.last_name, c.phone_number
            FROM redemption_log r
            JOIN customers c ON c.id = r.customer_id
            ORDER BY r.redeemed_at DESC
            LIMIT 100
        `);
        res.json({ redemptions: result.rows });
    } catch (error) {
        console.error('Redemption log error:', error);
        res.status(500).json({ error: 'Failed to fetch redemption log', details: error.message });
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

// Export customers as CSV (name, email, phone) for SMS platform import
app.get('/api/customers/export/csv', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT first_name, last_name, email, phone_number
             FROM customers
             ORDER BY created_at DESC`
        );

        const escapeCsv = (value) => {
            const str = value === null || value === undefined ? '' : String(value);
            return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
        };

        const header = 'First Name,Last Name,Email,Phone Number';
        const rows = result.rows.map((c) => [
            c.first_name,
            c.last_name,
            c.email,
            c.phone_number
        ].map(escapeCsv).join(','));

        const csv = [header, ...rows].join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="customers.csv"');
        res.send(csv);
    } catch (error) {
        console.error('Export customers CSV error:', error);
        res.status(500).json({ error: 'Failed to export customers', details: error.message });
    }
});

// Get leaderboard (top 10 customers by drop-offs)
app.get('/api/leaderboard', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT first_name, LEFT(last_name, 1) AS last_initial, total_dropoffs
             FROM customers
             WHERE total_dropoffs > 0
             ORDER BY total_dropoffs DESC
             LIMIT 10`
        );

        res.json({ leaderboard: result.rows });
    } catch (error) {
        console.error('Leaderboard error:', error);
        res.status(500).json({ error: 'Failed to fetch leaderboard', details: error.message });
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

        // Active customers this month (had at least one drop-off)
        const activeThisMonth = await pool.query(
            `SELECT COUNT(DISTINCT customer_id) FROM dropoffs WHERE date >= $1`,
            [firstOfMonth]
        );

        const total = parseInt(totalCustomers.rows[0].count);
        const totalDrop = parseInt(totalDropoffs.rows[0].total);

        res.json({
            totalCustomers: total,
            newCustomersThisMonth: parseInt(newCustomersThisMonth.rows[0].count),
            dropoffsThisMonth: parseInt(dropoffsThisMonth.rows[0].total),
            totalDropoffs: totalDrop,
            totalRewardsRedeemed: parseInt(totalRewardsRedeemed.rows[0].total),
            activeCustomersThisMonth: parseInt(activeThisMonth.rows[0].count),
            avgDropoffsPerCustomer: total > 0 ? (totalDrop / total).toFixed(1) : '0.0'
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

// Delete a specific drop-off
app.delete('/api/dropoffs/:id', async (req, res) => {
    const { id } = req.params;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Find the dropoff
        const dropoffResult = await client.query(
            'SELECT * FROM dropoffs WHERE id = $1',
            [parseInt(id)]
        );

        if (dropoffResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Drop-off not found' });
        }

        const dropoff = dropoffResult.rows[0];

        // Delete the dropoff
        await client.query('DELETE FROM dropoffs WHERE id = $1', [parseInt(id)]);

        // Update customer's total_dropoffs
        const customerResult = await client.query(
            'UPDATE customers SET total_dropoffs = total_dropoffs - $1 WHERE id = $2 RETURNING *',
            [dropoff.quantity, dropoff.customer_id]
        );

        await client.query('COMMIT');

        const customer = customerResult.rows[0];
        const eligibleRewards = calcEligibleRewards(customer);

        res.json({
            success: true,
            message: 'Drop-off deleted successfully',
            customer: customer,
            eligibleRewards: eligibleRewards
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Delete dropoff error:', error);
        res.status(500).json({ error: 'Failed to delete drop-off', details: error.message });
    } finally {
        client.release();
    }
});

// Analytics: Drop-offs grouped by day of week
app.get('/api/analytics/dropoffs-by-day', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT EXTRACT(DOW FROM date) AS day, COALESCE(SUM(quantity), 0) AS total
             FROM dropoffs
             GROUP BY day
             ORDER BY day`
        );

        // Build array for Sun(0)–Sat(6), filling missing days with 0
        const days = [0, 1, 2, 3, 4, 5, 6];
        const totals = days.map(d => {
            const row = result.rows.find(r => parseInt(r.day) === d);
            return row ? parseInt(row.total) : 0;
        });

        res.json({ days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], totals });
    } catch (error) {
        console.error('Analytics dropoffs-by-day error:', error);
        res.status(500).json({ error: 'Failed to fetch dropoffs by day', details: error.message });
    }
});

// Analytics: Monthly drop-off trend (last 12 months)
app.get('/api/analytics/monthly-trend', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT DATE_TRUNC('month', date) AS month, COALESCE(SUM(quantity), 0) AS total
             FROM dropoffs
             WHERE date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '11 months'
             GROUP BY month
             ORDER BY month`
        );

        // Build last 12 months array, filling gaps with 0
        const months = [];
        const totals = [];
        const now = new Date();
        for (let i = 11; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const label = d.toLocaleString('default', { month: 'short', year: '2-digit' });
            months.push(label);

            const match = result.rows.find(r => {
                const rowDate = new Date(r.month);
                return rowDate.getFullYear() === d.getFullYear() && rowDate.getMonth() === d.getMonth();
            });
            totals.push(match ? parseInt(match.total) : 0);
        }

        res.json({ months, totals });
    } catch (error) {
        console.error('Analytics monthly-trend error:', error);
        res.status(500).json({ error: 'Failed to fetch monthly trend', details: error.message });
    }
});


// Analytics: Tier distribution
app.get('/api/analytics/tier-distribution', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT
                COUNT(CASE WHEN total_dropoffs >= 50 THEN 1 END) AS gold,
                COUNT(CASE WHEN total_dropoffs >= 25 AND total_dropoffs < 50 THEN 1 END) AS silver,
                COUNT(CASE WHEN total_dropoffs >= 10 AND total_dropoffs < 25 THEN 1 END) AS bronze,
                COUNT(CASE WHEN total_dropoffs < 10 THEN 1 END) AS none
             FROM customers`
        );
        const row = result.rows[0];
        res.json({
            labels: ['No Rank', 'Bronze', 'Silver', 'Gold'],
            counts: [
                parseInt(row.none),
                parseInt(row.bronze),
                parseInt(row.silver),
                parseInt(row.gold)
            ]
        });
    } catch (error) {
        console.error('Tier distribution error:', error);
        res.status(500).json({ error: 'Failed to fetch tier distribution', details: error.message });
    }
});

// Analytics: Top 10 customers by drop-offs
app.get('/api/analytics/top-customers', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT first_name, last_name, total_dropoffs, rewards_redeemed
             FROM customers
             ORDER BY total_dropoffs DESC
             LIMIT 10`
        );
        res.json({ customers: result.rows });
    } catch (error) {
        console.error('Top customers error:', error);
        res.status(500).json({ error: 'Failed to fetch top customers', details: error.message });
    }
});

// Analytics: New customers per month (last 12 months)
app.get('/api/analytics/new-customers-monthly', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT DATE_TRUNC('month', created_at) AS month, COUNT(*) AS total
             FROM customers
             WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '11 months'
             GROUP BY month
             ORDER BY month`
        );

        const months = [];
        const totals = [];
        const now = new Date();
        for (let i = 11; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const label = d.toLocaleString('default', { month: 'short', year: '2-digit' });
            months.push(label);
            const match = result.rows.find(r => {
                const rowDate = new Date(r.month);
                return rowDate.getFullYear() === d.getFullYear() && rowDate.getMonth() === d.getMonth();
            });
            totals.push(match ? parseInt(match.total) : 0);
        }

        res.json({ months, totals });
    } catch (error) {
        console.error('New customers monthly error:', error);
        res.status(500).json({ error: 'Failed to fetch new customers monthly', details: error.message });
    }
});

// Analytics: Top referrers
app.get('/api/analytics/top-referrers', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT INITCAP(LOWER(TRIM(referred_by))) AS name, COUNT(*) AS referral_count
             FROM customers
             WHERE referred_by IS NOT NULL AND TRIM(referred_by) != ''
             GROUP BY LOWER(TRIM(referred_by))
             ORDER BY referral_count DESC
             LIMIT 10`
        );
        res.json({ referrers: result.rows });
    } catch (error) {
        console.error('Top referrers error:', error);
        res.status(500).json({ error: 'Failed to fetch top referrers', details: error.message });
    }
});

// Analytics: Customers referred by a specific person
app.get('/api/analytics/referrals-by/:name', async (req, res) => {
    try {
        const name = req.params.name.trim();
        const result = await pool.query(
            `SELECT first_name, last_name, phone_number, created_at, total_dropoffs
             FROM customers
             WHERE LOWER(TRIM(referred_by)) = LOWER($1)
             ORDER BY created_at DESC`,
            [name]
        );
        res.json({ referrals: result.rows });
    } catch (error) {
        console.error('Referrals by name error:', error);
        res.status(500).json({ error: 'Failed to fetch referrals', details: error.message });
    }
});

// AWeber connection status for the staff dashboard (no tokens returned)
app.get('/api/aweber/status', async (req, res) => {
    try {
        const conn = (await pool.query('SELECT list_name, list_id, refresh_token, connected_at FROM aweber_connection WHERE id = 1')).rows[0] || {};
        const added = await pool.query('SELECT COUNT(*) FROM customers WHERE aweber_added_at IS NOT NULL');
        res.json({
            configured: aweberConfigured(),
            connected: !!(conn.refresh_token && conn.list_id),
            listName: conn.list_name || AWEBER_LIST_NAME,
            connectedAt: conn.connected_at || null,
            addedCount: parseInt(added.rows[0].count, 10)
        });
    } catch (error) {
        console.error('AWeber status error:', error);
        res.status(500).json({ error: 'Failed to get AWeber status' });
    }
});

// Start the one-time AWeber connection (any valid staff PIN) — returns the AWeber login URL to send the browser to
app.post('/api/aweber/connect', async (req, res) => {
    const { pin } = req.body;
    if (!pin) {
        return res.status(401).json({ error: 'Staff PIN is required' });
    }
    try {
        const staffCheck = await pool.query('SELECT id FROM staff WHERE pin = $1', [pin]);
        if (staffCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Invalid staff PIN' });
        }
        if (!aweberConfigured()) {
            return res.status(503).json({ error: 'AWeber is not configured (AWEBER_CLIENT_ID / AWEBER_CLIENT_SECRET missing on Render)' });
        }

        const state = crypto.randomBytes(16).toString('hex');
        await pool.query('UPDATE aweber_connection SET oauth_state = $1 WHERE id = 1', [state]);
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: process.env.AWEBER_CLIENT_ID.trim(),
            redirect_uri: AWEBER_REDIRECT_URI,
            scope: AWEBER_SCOPES,
            state
        });
        res.json({ url: `${AWEBER_AUTH_URL}/authorize?${params}` });
    } catch (error) {
        console.error('AWeber connect error:', error);
        res.status(500).json({ error: 'Failed to start AWeber connection' });
    }
});

// AWeber sends the browser back here after you click Allow
app.get('/api/aweber/callback', async (req, res) => {
    const backTo = (status, reason) =>
        res.redirect(`/staff-dashboard.html?aweber=${status}${reason ? `&reason=${encodeURIComponent(reason)}` : ''}`);
    const { code, state, error, error_description } = req.query;

    if (error) {
        return backTo('error', error_description || error);
    }

    try {
        const conn = (await pool.query('SELECT oauth_state FROM aweber_connection WHERE id = 1')).rows[0];
        if (!code || !state || !conn || conn.oauth_state !== state) {
            return backTo('error', 'Connection link expired. Please click Connect AWeber again.');
        }
        await pool.query('UPDATE aweber_connection SET oauth_state = NULL WHERE id = 1');

        const tokens = await aweberTokenRequest({ grant_type: 'authorization_code', code, redirect_uri: AWEBER_REDIRECT_URI });
        await saveAweberTokens(tokens);

        const accounts = await aweberApi(tokens.access_token, '/accounts');
        const accountId = accounts.ok && accounts.data.entries && accounts.data.entries[0] && accounts.data.entries[0].id;
        if (!accountId) {
            console.error('AWeber accounts error:', accounts.status, JSON.stringify(accounts.data));
            return backTo('error', 'Could not read your AWeber account.');
        }

        const lists = await aweberApi(tokens.access_token, `/accounts/${accountId}/lists?ws.size=100`);
        const wanted = AWEBER_LIST_NAME.trim().toLowerCase();
        const list = (lists.data.entries || []).find(l => (l.name || '').trim().toLowerCase() === wanted);
        await pool.query(
            `UPDATE aweber_connection SET account_id = $1, list_id = $2, list_name = $3, connected_at = NOW() WHERE id = 1`,
            [String(accountId), list ? String(list.id) : null, list ? list.name : null]
        );
        if (!list) {
            const found = (lists.data.entries || []).map(l => l.name).join(', ') || 'none';
            return backTo('error', `Couldn't find a list named "${AWEBER_LIST_NAME}". Lists found: ${found}`);
        }

        console.log(`[AWeber] connected to list "${list.name}" (${list.id})`);
        backTo('connected');
    } catch (err) {
        console.error('AWeber callback error:', err.message);
        backTo('error', err.message);
    }
});

// ── December Gift Card Raffle ─────────────────────────────────
// Every loyalty member who checks in at the kiosk during a raffle week gets one spin per day.
// No purchase necessary — every spin has the same odds. Exactly one winner per week:
//  - Each spin's odds are 1 ÷ (spins we still expect this week), based on the last 8 weeks of visits.
//    Odds rise through the week; on the last day they reach 100% once the usual number of visitors is hit.
//  - After someone wins, everyone else that week gets "not this time".
//  - Each person can win only once all month.
//  - If a week ends with no winner (e.g. closed early), staff click "Draw winner" on the dashboard,
//    which picks randomly from everyone who spun that week.
const RAFFLE_PRIZE = '$25 gift card';
const RAFFLE_WEEKS = [
    { week: 1, start: '2026-12-01', end: '2026-12-04' },
    { week: 2, start: '2026-12-07', end: '2026-12-11' },
    { week: 3, start: '2026-12-14', end: '2026-12-18' },
    { week: 4, start: '2026-12-21', end: '2026-12-24' }
];
const RAFFLE_TZ = 'America/New_York';
const RAFFLE_LOCK_ID = 7312026; // serializes spins so two at once can't both win

// Today's date in the shop's time zone, as YYYY-MM-DD. RAFFLE_FAKE_DATE is for local testing only.
function raffleToday() {
    if (process.env.RAFFLE_FAKE_DATE) return process.env.RAFFLE_FAKE_DATE;
    return new Intl.DateTimeFormat('en-CA', { timeZone: RAFFLE_TZ }).format(new Date());
}

function raffleWeekFor(dateStr) {
    return RAFFLE_WEEKS.find(w => dateStr >= w.start && dateStr <= w.end) || null;
}

function addDays(dateStr, n) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

function dayOfWeek(dateStr) {
    return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

// Staff and test accounts can spin the wheel (handy for testing) but can never win or be drawn.
// Excluded: any customer whose full name matches a staff login name, any customer with the word
// "test" in their first or last name, and any customer ID listed in env RAFFLE_EXCLUDE_IDS (e.g. "212,305").
// Use with a customers table aliased as "c".
function raffleExcludedSql() {
    const ids = (process.env.RAFFLE_EXCLUDE_IDS || '')
        .split(',').map(s => parseInt(s.trim())).filter(n => Number.isInteger(n));
    return `(c.first_name ~* '\\mtest\\M' OR c.last_name ~* '\\mtest\\M'
        OR EXISTS (SELECT 1 FROM staff st
                   WHERE LOWER(TRIM(st.name)) = LOWER(TRIM(c.first_name) || ' ' || TRIM(c.last_name)))
        ${ids.length ? `OR c.id IN (${ids.join(',')})` : ''})`;
}

async function isRaffleExcluded(db, customerId) {
    const r = await db.query(`SELECT ${raffleExcludedSql()} AS excluded FROM customers c WHERE c.id = $1`, [customerId]);
    return r.rows.length > 0 && r.rows[0].excluded === true;
}

// Average customers per weekday over the 8 weeks before the raffle (at least 1 per day)
async function raffleExpectedByWeekday(db) {
    const start = addDays(RAFFLE_WEEKS[0].start, -56);
    const result = await db.query(
        `SELECT EXTRACT(DOW FROM date)::int AS dow, COUNT(DISTINCT (customer_id, date)) AS visits
         FROM dropoffs WHERE date >= $1 AND date < $2 GROUP BY 1`,
        [start, RAFFLE_WEEKS[0].start]
    );
    const expected = [1, 1, 1, 1, 1, 1, 1];
    result.rows.forEach(r => { expected[r.dow] = Math.max(1, Number(r.visits) / 8); });
    return expected;
}

// Kiosk asks this right after a visit is logged: should the wheel be shown? (Nothing is decided or saved yet.)
app.get('/api/raffle/eligible', async (req, res) => {
    if (req.query.preview === '1') return res.json({ active: true, prize: RAFFLE_PRIZE });
    const week = raffleWeekFor(raffleToday());
    const customerId = parseInt(req.query.customerId);
    if (!week || !customerId) return res.json({ active: false });
    try {
        const recentVisit = (await pool.query(
            `SELECT 1 FROM dropoffs WHERE customer_id = $1 AND created_at > NOW() - INTERVAL '15 minutes' LIMIT 1`,
            [customerId]
        )).rows.length > 0;
        if (!recentVisit) return res.json({ active: false });
        const spunToday = (await pool.query(
            'SELECT 1 FROM raffle_spins WHERE customer_id = $1 AND spin_date = $2', [customerId, raffleToday()]
        )).rows.length > 0;
        res.json({ active: true, alreadySpunToday: spunToday, prize: RAFFLE_PRIZE });
    } catch (error) {
        console.error('Raffle eligible error:', error);
        res.json({ active: false });
    }
});

// Kiosk calls this when the customer taps/swipes the wheel. The server decides win/lose; the wheel just shows it.
app.post('/api/raffle/spin', async (req, res) => {
    const { customerId, preview } = req.body;

    // Preview mode (kiosk opened with ?raffletest=1): shows the wheel with a random result, saves nothing
    if (preview) {
        return res.json({ active: true, preview: true, won: Math.random() < 0.34, prize: RAFFLE_PRIZE });
    }

    const today = raffleToday();
    const week = raffleWeekFor(today);
    if (!week) return res.json({ active: false });
    if (!customerId) return res.status(400).json({ error: 'customerId is required' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [RAFFLE_LOCK_ID]);

        // Only customers who just checked in can spin (generous window since the wheel waits for a tap)
        const customer = (await client.query('SELECT * FROM customers WHERE id = $1', [parseInt(customerId)])).rows[0];
        const recentVisit = customer && (await client.query(
            `SELECT 1 FROM dropoffs WHERE customer_id = $1 AND created_at > NOW() - INTERVAL '60 minutes' LIMIT 1`,
            [customer.id]
        )).rows.length > 0;
        if (!customer || !recentVisit) {
            await client.query('ROLLBACK');
            return res.json({ active: false });
        }

        // One spin per customer per day
        const spin = await client.query(
            `INSERT INTO raffle_spins (customer_id, week_number, spin_date) VALUES ($1, $2, $3)
             ON CONFLICT (customer_id, spin_date) DO NOTHING RETURNING id`,
            [customer.id, week.week, today]
        );
        if (spin.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.json({ active: true, alreadySpunToday: true, prize: RAFFLE_PRIZE });
        }
        const spinId = spin.rows[0].id;

        const weekHasWinner = (await client.query('SELECT 1 FROM raffle_winners WHERE week_number = $1', [week.week])).rows.length > 0;
        const alreadyWonBefore = (await client.query('SELECT 1 FROM raffle_winners WHERE customer_id = $1', [customer.id])).rows.length > 0;
        const excluded = await isRaffleExcluded(client, customer.id); // staff/test accounts never win

        let won = false;
        let odds = 0;
        if (!weekHasWinner && !alreadyWonBefore && !excluded) {
            const expected = await raffleExpectedByWeekday(client);
            const spinsBeforeToday = Number((await client.query(
                'SELECT COUNT(*) FROM raffle_spins WHERE spin_date = $1 AND id <> $2', [today, spinId]
            )).rows[0].count);
            let remaining = Math.max(1, expected[dayOfWeek(today)] - spinsBeforeToday);
            for (let d = addDays(today, 1); d <= week.end; d = addDays(d, 1)) {
                remaining += expected[dayOfWeek(d)];
            }
            odds = 1 / remaining;
            won = crypto.randomInt(1000000) < odds * 1000000;
        }

        await client.query('UPDATE raffle_spins SET won = $1, odds = $2 WHERE id = $3', [won, odds, spinId]);
        if (won) {
            await client.query(
                `INSERT INTO raffle_winners (week_number, customer_id, first_name, last_name, email, phone_number, method)
                 VALUES ($1, $2, $3, $4, $5, $6, 'wheel')`,
                [week.week, customer.id, customer.first_name, customer.last_name, customer.email, customer.phone_number]
            );
            console.log(`[Raffle] Week ${week.week} WINNER: ${customer.first_name} ${customer.last_name} (odds ${(odds * 100).toFixed(1)}%)`);
        }
        await client.query('COMMIT');
        res.json({ active: true, won, prize: RAFFLE_PRIZE });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Raffle spin error:', error);
        // Never block the kiosk — just skip the wheel
        res.json({ active: false });
    } finally {
        client.release();
    }
});

// Dashboard: each week's dates, status, spin count and winner
app.get('/api/raffle/status', async (req, res) => {
    try {
        const today = raffleToday();
        const winners = (await pool.query('SELECT * FROM raffle_winners')).rows;
        const counts = (await pool.query(
            'SELECT week_number, COUNT(*) AS spins, COUNT(DISTINCT customer_id) AS people FROM raffle_spins GROUP BY week_number'
        )).rows;
        const weeks = RAFFLE_WEEKS.map(w => {
            const c = counts.find(r => r.week_number === w.week);
            const winner = winners.find(r => r.week_number === w.week) || null;
            const status = today < w.start ? 'upcoming' : today > w.end ? 'ended' : 'live';
            return { ...w, status, spins: c ? Number(c.spins) : 0, people: c ? Number(c.people) : 0, winner };
        });
        res.json({ today, prize: RAFFLE_PRIZE, weeks });
    } catch (error) {
        console.error('Raffle status error:', error);
        res.status(500).json({ error: 'Failed to load raffle status' });
    }
});

// Backup: draw a winner for a finished week that ended without one (staff PIN required)
app.post('/api/raffle/draw', async (req, res) => {
    const { pin, week: weekNumber } = req.body;
    const week = RAFFLE_WEEKS.find(w => w.week === parseInt(weekNumber));
    if (!week) return res.status(400).json({ error: 'Unknown week' });

    const client = await pool.connect();
    try {
        const staff = (await client.query('SELECT name FROM staff WHERE pin = $1', [pin || ''])).rows[0];
        if (!staff) return res.status(403).json({ error: 'Invalid staff PIN — please log in again.' });
        if (raffleToday() <= week.end) return res.status(400).json({ error: 'This week is not over yet.' });

        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [RAFFLE_LOCK_ID]);
        if ((await client.query('SELECT 1 FROM raffle_winners WHERE week_number = $1', [week.week])).rows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'This week already has a winner.' });
        }

        // Everyone who spun that week (one entry each), minus anyone who already won and staff/test accounts
        const pool1 = (await client.query(
            `SELECT DISTINCT c.* FROM raffle_spins s JOIN customers c ON c.id = s.customer_id
             WHERE s.week_number = $1 AND c.id NOT IN (SELECT customer_id FROM raffle_winners WHERE customer_id IS NOT NULL)
               AND NOT ${raffleExcludedSql()}`,
            [week.week]
        )).rows;
        // Nobody spun? Fall back to every member who hasn't won yet
        const entrants = pool1.length ? pool1 : (await client.query(
            `SELECT c.* FROM customers c WHERE c.id NOT IN (SELECT customer_id FROM raffle_winners WHERE customer_id IS NOT NULL)
               AND NOT ${raffleExcludedSql()}`
        )).rows;
        if (!entrants.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'No eligible customers to draw from.' });
        }

        const pick = entrants[crypto.randomInt(entrants.length)];
        const winner = (await client.query(
            `INSERT INTO raffle_winners (week_number, customer_id, first_name, last_name, email, phone_number, method)
             VALUES ($1, $2, $3, $4, $5, $6, 'draw') RETURNING *`,
            [week.week, pick.id, pick.first_name, pick.last_name, pick.email, pick.phone_number]
        )).rows[0];
        await client.query('COMMIT');
        console.log(`[Raffle] Week ${week.week} DRAWN by ${staff.name}: ${pick.first_name} ${pick.last_name} (from ${entrants.length} entrants)`);
        res.json({ success: true, winner, entrants: entrants.length });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Raffle draw error:', error);
        res.status(500).json({ error: 'Failed to draw a winner' });
    } finally {
        client.release();
    }
});

// Dashboard: record which gift card the winner picked and whether it was sent
app.patch('/api/raffle/winners/:week', async (req, res) => {
    const { prizeChoice, prizeSent } = req.body;
    try {
        const result = await pool.query(
            `UPDATE raffle_winners
             SET prize_choice = COALESCE($1, prize_choice), prize_sent = COALESCE($2, prize_sent)
             WHERE week_number = $3 RETURNING *`,
            [prizeChoice === undefined ? null : String(prizeChoice).slice(0, 255),
             typeof prizeSent === 'boolean' ? prizeSent : null,
             parseInt(req.params.week)]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'No winner for that week yet' });
        res.json({ success: true, winner: result.rows[0] });
    } catch (error) {
        console.error('Raffle winner update error:', error);
        res.status(500).json({ error: 'Failed to update winner' });
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
