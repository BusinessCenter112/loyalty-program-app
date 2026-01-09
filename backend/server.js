const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../frontend')));

// Data file paths
const DATA_DIR = path.join(__dirname, 'data');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
const DROPOFFS_FILE = path.join(DATA_DIR, 'dropoffs.json');
const STAFF_FILE = path.join(DATA_DIR, 'staff.json');

// Initialize data directory and files
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
}

// Initialize staff PINs
if (!fs.existsSync(STAFF_FILE)) {
    const staffPins = [
        { id: 1, pin: '1157', name: 'Staff Member 1' },
        { id: 2, pin: '5600', name: 'Staff Member 2' },
        { id: 3, pin: '0725', name: 'Staff Member 3' }
    ];
    fs.writeFileSync(STAFF_FILE, JSON.stringify(staffPins, null, 2));
}

// Initialize customers file
if (!fs.existsSync(CUSTOMERS_FILE)) {
    fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify([], null, 2));
}

// Initialize dropoffs file
if (!fs.existsSync(DROPOFFS_FILE)) {
    fs.writeFileSync(DROPOFFS_FILE, JSON.stringify([], null, 2));
}

// Helper functions to read/write data
function readCustomers() {
    return JSON.parse(fs.readFileSync(CUSTOMERS_FILE, 'utf8'));
}

function writeCustomers(customers) {
    fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify(customers, null, 2));
}

function readDropoffs() {
    return JSON.parse(fs.readFileSync(DROPOFFS_FILE, 'utf8'));
}

function writeDropoffs(dropoffs) {
    fs.writeFileSync(DROPOFFS_FILE, JSON.stringify(dropoffs, null, 2));
}

function readStaff() {
    return JSON.parse(fs.readFileSync(STAFF_FILE, 'utf8'));
}

// API Routes

// Customer registration
app.post('/api/customers/register', (req, res) => {
    const { firstName, lastName, email } = req.body;

    if (!firstName || !lastName || !email) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    try {
        const customers = readCustomers();

        // Check if customer already exists
        const existing = customers.find(c => c.email.toLowerCase() === email.toLowerCase());

        if (existing) {
            return res.json({
                success: true,
                message: 'Welcome back!',
                customer: existing
            });
        }

        // Create new customer
        const newCustomer = {
            id: customers.length > 0 ? Math.max(...customers.map(c => c.id)) + 1 : 1,
            first_name: firstName,
            last_name: lastName,
            email: email,
            total_dropoffs: 0,
            rewards_redeemed: 0,
            created_at: new Date().toISOString()
        };

        customers.push(newCustomer);
        writeCustomers(customers);

        res.json({
            success: true,
            message: 'Registration successful!',
            customer: newCustomer
        });
    } catch (error) {
        res.status(500).json({ error: 'Registration failed', details: error.message });
    }
});

// Staff login
app.post('/api/staff/login', (req, res) => {
    const { pin } = req.body;

    if (!pin) {
        return res.status(400).json({ error: 'PIN is required' });
    }

    try {
        const staff = readStaff();
        const staffMember = staff.find(s => s.pin === pin);

        if (!staffMember) {
            return res.status(401).json({ error: 'Invalid PIN' });
        }

        res.json({
            success: true,
            staff: { id: staffMember.id, name: staffMember.name, pin: staffMember.pin }
        });
    } catch (error) {
        res.status(500).json({ error: 'Login failed', details: error.message });
    }
});

// Search customers
app.get('/api/customers/search', (req, res) => {
    const { query } = req.query;

    if (!query) {
        return res.status(400).json({ error: 'Search query is required' });
    }

    try {
        const customers = readCustomers();
        const searchLower = query.toLowerCase();

        const results = customers.filter(c =>
            c.first_name.toLowerCase().includes(searchLower) ||
            c.last_name.toLowerCase().includes(searchLower) ||
            c.email.toLowerCase().includes(searchLower)
        ).sort((a, b) => {
            const aName = `${a.last_name} ${a.first_name}`;
            const bName = `${b.last_name} ${b.first_name}`;
            return aName.localeCompare(bName);
        });

        res.json({ customers: results });
    } catch (error) {
        res.status(500).json({ error: 'Search failed', details: error.message });
    }
});

// Get customer details with dropoffs
app.get('/api/customers/:id', (req, res) => {
    const { id } = req.params;

    try {
        const customers = readCustomers();
        const customer = customers.find(c => c.id === parseInt(id));

        if (!customer) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const dropoffs = readDropoffs();
        const customerDropoffs = dropoffs
            .filter(d => d.customer_id === parseInt(id))
            .sort((a, b) => new Date(b.date) - new Date(a.date));

        res.json({ customer, dropoffs: customerDropoffs });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch customer', details: error.message });
    }
});

// Add dropoff
app.post('/api/dropoffs', (req, res) => {
    const { customerId, quantity, date, staffPin } = req.body;

    if (!customerId || !quantity || !date) {
        return res.status(400).json({ error: 'Customer ID, quantity, and date are required' });
    }

    try {
        const customers = readCustomers();
        const customerIndex = customers.findIndex(c => c.id === parseInt(customerId));

        if (customerIndex === -1) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        // Create dropoff record
        const dropoffs = readDropoffs();
        const newDropoff = {
            id: dropoffs.length > 0 ? Math.max(...dropoffs.map(d => d.id)) + 1 : 1,
            customer_id: parseInt(customerId),
            quantity: parseInt(quantity),
            date: date,
            added_by: staffPin || 'Unknown',
            created_at: new Date().toISOString()
        };

        dropoffs.push(newDropoff);
        writeDropoffs(dropoffs);

        // Update customer total dropoffs
        customers[customerIndex].total_dropoffs += parseInt(quantity);
        writeCustomers(customers);

        const updatedCustomer = customers[customerIndex];

        // Check if eligible for reward (every 10 dropoffs)
        const eligibleRewards = Math.floor(updatedCustomer.total_dropoffs / 10) - updatedCustomer.rewards_redeemed;

        res.json({
            success: true,
            message: 'Drop-off recorded successfully',
            customer: updatedCustomer,
            eligibleRewards
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to add dropoff', details: error.message });
    }
});

// Redeem reward
app.post('/api/rewards/redeem', (req, res) => {
    const { customerId } = req.body;

    if (!customerId) {
        return res.status(400).json({ error: 'Customer ID is required' });
    }

    try {
        const customers = readCustomers();
        const customerIndex = customers.findIndex(c => c.id === parseInt(customerId));

        if (customerIndex === -1) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        const customer = customers[customerIndex];
        const eligibleRewards = Math.floor(customer.total_dropoffs / 10) - customer.rewards_redeemed;

        if (eligibleRewards <= 0) {
            return res.status(400).json({ error: 'No rewards available to redeem' });
        }

        // Mark reward as redeemed
        customers[customerIndex].rewards_redeemed += 1;
        writeCustomers(customers);

        res.json({
            success: true,
            message: 'Reward redeemed! 10% discount applied.',
            customer: customers[customerIndex]
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to redeem reward', details: error.message });
    }
});

// Get all customers (for staff dashboard)
app.get('/api/customers', (req, res) => {
    try {
        const customers = readCustomers();
        const sorted = customers.sort((a, b) => {
            const aName = `${a.last_name} ${a.first_name}`;
            const bName = `${b.last_name} ${b.first_name}`;
            return aName.localeCompare(bName);
        });

        res.json({ customers: sorted });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch customers', details: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`\nStaff PINs: 1157, 5600, 0725`);
    console.log(`\nFrontend available at: http://localhost:${PORT}`);
    console.log(`Customer registration: http://localhost:${PORT}/index.html`);
    console.log(`Staff login: http://localhost:${PORT}/staff-login.html`);
});
