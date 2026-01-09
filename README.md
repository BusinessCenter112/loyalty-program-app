# Web 2.0 Business Center Rewards Club

A cloud-based loyalty program app for tracking package drop-offs and rewards. Accessible from any device, anywhere!

## 🌐 Live Application

**Your app is live and ready to use!**

- **Customer Registration:** https://loyalty-program-app-xb1v.onrender.com/
- **Staff Dashboard:** https://loyalty-program-app-xb1v.onrender.com/staff-login.html

Scan the QR code in `qr-code-printable.html` or share the link directly with customers!

## ✨ Features

- **Customer registration via QR code** - Works on any phone, any network
- **Live search** - Results appear as you type (no search button needed!)
- **Full name search** - Search "chris cooper" to find customers by full name
- **Track package drop-offs** - Record customer transactions with date and quantity
- **Automatic reward calculation** - 10% off every 10 drop-offs
- **Smart duplicate prevention** - Only blocks if first name, last name, AND email all match
- **Staff dashboard** - Manage customers, add drop-offs, redeem rewards
- **Secure PIN-based authentication** - Three staff PINs for your team
- **Cloud database** - Data is permanently stored and never lost

## 🔐 Staff PINs

- **PIN 1:** 1157
- **PIN 2:** 5600
- **PIN 3:** 0725

## 📱 QR Code for Customers

A QR code has been generated and is ready to print:

1. Open `qr-code-printable.html` in your browser
2. Click "Print This Page" to print
3. Display it where customers can scan it

The QR code points to: **https://loyalty-program-app-xb1v.onrender.com/**

When customers scan it, they'll be able to register instantly from their phones!

## 👥 How to Use

### For Customers

1. Scan the QR code or visit the registration URL
2. Fill in your first name, last name, and email
3. Click "Register"
4. You'll see your total drop-offs and progress toward rewards
5. Come back anytime using the same details to see your progress!

### For Staff

1. Go to https://loyalty-program-app-xb1v.onrender.com/staff-login.html
2. Enter your PIN (1157, 5600, or 0725)
3. **All customers appear automatically** on the dashboard
4. **Start typing** in the search box to filter customers:
   - Type "chris" to find Chris
   - Type "cooper" to find Cooper
   - Type "chris cooper" to find Chris Cooper
   - Search works on first name, last name, email, or full name
5. Click on a customer card to manage their account
6. Add drop-offs:
   - Enter the quantity of packages
   - Select the date (defaults to today)
   - Click "Add Drop-off"
7. Redeem rewards when the button appears (at 10+ drop-offs)

## 🎁 Reward System

- Customers earn **1 point per package drop-off**
- Every **10 drop-offs** = **10% discount reward**
- Rewards can be redeemed by staff in the dashboard
- Multiple rewards can accumulate (20 drop-offs = 2 rewards, etc.)
- Rewards counter resets after redemption

## 💾 Data Storage

All data is permanently stored in a **PostgreSQL database** hosted on Render:

- **Customers** - Customer information (name, email, drop-offs, rewards)
- **Drop-offs** - Complete history of all package drop-offs
- **Staff** - Staff PIN codes

**Your data is safe:**
- ✅ Never deleted or lost during deployments
- ✅ Automatically backed up by Render
- ✅ Persists forever (even when app restarts)

## 🛠️ Local Development (Optional)

If you want to run the app locally for testing:

### Prerequisites
- Node.js installed ([nodejs.org](https://nodejs.org/))
- PostgreSQL connection string (already configured)

### Steps

1. **Install dependencies:**
   ```bash
   cd loyalty-program-app/backend
   npm install
   ```

2. **Start the server:**
   ```bash
   npm start
   ```

3. **Open in browser:**
   - Customer registration: http://localhost:3001/
   - Staff login: http://localhost:3001/staff-login.html

The app automatically connects to the production database, so any local testing uses real data.

## 🔧 Customization

### Change Staff PINs

Staff PINs are stored in the PostgreSQL database. To change them, you'll need to update the database directly or modify the initialization code in `backend/server.js`.

### Change Reward Threshold

Currently set to 10 drop-offs. To change, edit the reward calculation in `backend/server.js`:

```javascript
const eligibleRewards = Math.floor(customer.total_dropoffs / 10)
```

Change `10` to your desired number.

### Change Colors

Edit the CSS in the HTML files:
- `frontend/index.html` - Customer page (currently royal blue #4169E1)
- `frontend/staff-login.html` - Staff login page
- `frontend/staff-dashboard.html` - Staff dashboard

### Regenerate QR Code

If you ever need a new QR code (e.g., custom URL), edit `generate-qr.js` and run:

```bash
node generate-qr.js
```

Then open `qr-code-printable.html` to print the new code.

## 🐛 Troubleshooting

### App is slow or unresponsive

Render's free tier "spins down" after 15 minutes of inactivity. The first request after inactivity takes 30-60 seconds to wake up. Subsequent requests are fast.

### Customer can't register

- Make sure they have internet connection (wifi or cellular data works)
- Check that they're entering all three fields (first name, last name, email)
- Duplicates are only prevented if ALL three fields match exactly

### Can't find customer in search

- Start typing - results appear automatically as you type
- Try searching by:
  - First name only: "chris"
  - Last name only: "cooper"
  - Full name: "chris cooper"
  - Email: "chris@email.com"
- All customers show when search box is empty

### Data was lost after deployment

This should not happen anymore! Data is now stored in PostgreSQL and persists forever. If you experience data loss, check that the `DATABASE_URL` environment variable is set correctly in Render.

## 📊 Deployment Info

- **Hosting:** Render (Free Tier)
- **Database:** PostgreSQL (Free Tier)
- **Repository:** https://github.com/BusinessCenter112/loyalty-program-app
- **Auto-Deploy:** Enabled (pushes to main branch auto-deploy)

### Redeploying

To deploy changes:

1. Make your code changes locally
2. Commit and push to GitHub:
   ```bash
   git add .
   git commit -m "Your change description"
   git push
   ```
3. Render automatically detects the push and redeploys (takes 2-3 minutes)
4. Your data is safe - it persists across all deployments!

## 📞 Support

For issues or questions:
- Check the Render logs for error messages
- Verify DATABASE_URL environment variable is set
- GitHub Repository: https://github.com/BusinessCenter112/loyalty-program-app

---

**Built with:** Node.js, Express, PostgreSQL, and deployed on Render

**Co-Authored-By:** Claude Sonnet 4.5
