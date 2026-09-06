# Booking System (B2C + B2B)

A simple booking website system made of 3 parts:

1. **server/** – Node.js + Express + MySQL backend (the API that both sites talk to)
2. **b2c/** – the public-facing site where customers browse products and book a date
3. **b2b/** – the company dashboard where companies log in and manage products/bookings

Everything is written in plain HTML/CSS/JS on the frontend (no frameworks), and plain
Express + mysql2 on the backend, so it's easy to read line by line.

---

## 1. Set up the database

1. Make sure MySQL is installed and running.
2. Run the schema file to create the database, tables, and some sample data:

```
mysql -u root -p < server/schema.sql
```

This creates a `booking_system` database with one sample company you can log into:
- **Email:** admin@sunshine.com
- **Password:** 123456

---

## 2. Set up and run the backend server

```
cd server
npm install
```

Open `db.js` and update the `user` / `password` fields to match your own MySQL login.

Then start the server:

```
node server.js
```

You should see: `Server is running on http://localhost:3000`

Keep this terminal window open while you use the site — both the B2C and B2B
frontends talk to this server.

---

## 3. Open the B2C site (customer-facing)

Just open `b2c/index.html` in your browser (double-click it, or use a tool like
VS Code's "Live Server" extension for the best experience with `fetch()`).

- You'll see a carousel of products.
- Click **Book Now** on any product → opens a new tab with images, description,
  and a calendar to pick a date.
- Click **Cancel** → closes that tab.
- Fill in your name/email and click **Book Now** on that page → the booking is
  sent to the server and will show up on the B2B dashboard.

> Note: `b2c/script.js` has a `COMPANY_ID = 1` setting at the top. Since the task
> asked for one B2C site per company, this is hard-coded to company #1 (Sunshine
> Travel Co. from the sample data). If you make another B2C site for a different
> company, just copy the `b2c` folder and change that number.

---

## 4. Open the B2B site (company dashboard)

Open `b2b/login.html` in your browser.

Log in with:
- Email: `admin@sunshine.com`
- Password: `123456`

Any company that exists in the `companies` table can log in from this same page —
that's why the B2B link can be shared between multiple companies.

Once logged in you'll see:
- **Overview / Calendar tab** – shows the next upcoming booking and how many days
  are left, plus a full monthly calendar with every booked date.
- **Products tab** – add new products (with images, price, discount price,
  and details) and see/delete existing ones.
- **Settings tab** – update company name, email, phone, address, and password.

---

## Notes for going further (kept simple on purpose)

- Login here is simplified (plain text password check, no sessions/JWT) so the
  code stays easy to read. For a real live site, add password hashing (bcrypt)
  and proper authentication tokens.
- Uploaded product images are stored in `server/uploads` and served from
  `http://localhost:3000/uploads/...`.
- If you deploy this for real, update `API_URL` in each `.js` file (in `b2c/`
  and `b2b/`) to point to your live server address instead of `localhost`.
