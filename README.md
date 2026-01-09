# Web 2.0 Business Center Rewards Club

A simple loyalty program app for tracking package drop-offs and rewards.

## Features

- Customer registration via QR code
- Track package drop-offs
- Automatic reward calculation (10% off every 10 drop-offs)
- Staff dashboard for managing customers
- Secure PIN-based staff authentication

## Staff PINs

- **PIN 1:** 1157
- **PIN 2:** 5600
- **PIN 3:** 0725

## Setup Instructions

### 1. Install Node.js

Make sure you have Node.js installed on your computer. You can download it from [nodejs.org](https://nodejs.org/)

### 2. Start the Backend Server

Open a terminal/command prompt and run:

```bash
cd loyalty-program-app/backend
npm start
```

You should see:
```
Server running on http://localhost:3001
Staff PINs: 1157, 5600, 0725
```

Keep this terminal window open while using the app.

### 3. Open the Frontend

Open the file `loyalty-program-app/frontend/index.html` in your web browser.

You can also:
- Double-click the `index.html` file
- Right-click and choose "Open with" → Your browser
- Drag and drop the file into your browser window

## How to Use

### For Customers

1. Scan the QR code (or open index.html)
2. Fill in your first name, last name, and email
3. Click "Register"
4. You'll see your total drop-offs and progress toward rewards

### For Staff

1. Click "Staff Login" at the bottom of the customer page
2. Enter your PIN (1157, 5600, or 0725)
3. Search for a customer by name or email
4. Click on the customer card
5. Add drop-offs:
   - Enter the quantity of packages
   - Select the date
   - Click "Add Drop-off"
6. Redeem rewards when available (button appears at 10 drop-offs)

## Reward System

- Customers earn **1 point per package drop-off**
- Every **10 drop-offs** = **10% discount**
- Rewards can be redeemed by staff in the dashboard
- Multiple rewards can accumulate (20 drop-offs = 2 rewards, etc.)

## Generating a QR Code

To create a QR code for customer registration:

1. Get your computer's local IP address:
   - Windows: Run `ipconfig` in Command Prompt (look for IPv4 Address)
   - Mac/Linux: Run `ifconfig` in Terminal

2. Your registration URL will be:
   ```
   http://YOUR_IP_ADDRESS:8080/frontend/index.html
   ```
   (Replace YOUR_IP_ADDRESS with your actual IP)

3. Use a free QR code generator like:
   - [qr-code-generator.com](https://www.qr-code-generator.com/)
   - [qr.io](https://qr.io/)

4. Paste your URL and generate the QR code

5. Print the QR code and display it where customers can scan it

**Note:** For the QR code to work on customer phones, you need to serve the frontend over a local web server. A simple way to do this:

```bash
cd loyalty-program-app/frontend
npx http-server -p 8080
```

Then use the URL: `http://YOUR_IP:8080/` for the QR code.

## Data Storage

All data is stored in JSON files in the `backend/data/` folder:

- `customers.json` - Customer information
- `dropoffs.json` - Drop-off history
- `staff.json` - Staff PIN codes

**Important:** Back up these files regularly to prevent data loss!

## Troubleshooting

### "Unable to connect to server"

Make sure the backend server is running:
```bash
cd loyalty-program-app/backend
npm start
```

### QR Code doesn't work on phones

Make sure:
1. Your computer and phone are on the same WiFi network
2. You're using your computer's IP address, not "localhost"
3. The backend server is running
4. You're serving the frontend with http-server (see QR Code section above)

### Can't find customer in search

- Try searching with just first or last name
- Make sure the customer has registered
- Check `backend/data/customers.json` to see registered customers

## Customization

### Change Staff PINs

Edit `backend/data/staff.json` and restart the server.

### Change Reward Threshold

Currently set to 10 drop-offs. To change, edit line 226 in `backend/server.js`:

```javascript
const eligibleRewards = Math.floor(updatedCustomer.total_dropoffs / 10)
```

Change `10` to your desired number.

### Change Colors

Edit the CSS in the HTML files:
- `frontend/index.html` - Customer page (currently royal blue)
- `frontend/staff-login.html` - Staff login
- `frontend/staff-dashboard.html` - Staff dashboard

## Support

For issues or questions, check the data files in `backend/data/` or restart the server.
