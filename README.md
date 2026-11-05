# Bhagath Yoga Center

Responsive website for Bhagath Yoga Center. The existing homepage remains at the repository root. Razorpay checkout pages use the same site styles; payment requests are handled by Node.js functions under `api/` and saved in PostgreSQL.

## Run locally

Use Node.js 22. Copy `.env.example` to `.env.local`, fill in matching Razorpay **Test Mode** credentials and the Neon PostgreSQL connection string, then run:

```powershell
npm install
npm run db:init
npm start
```

Open `http://localhost:3000/` and `http://localhost:3000/payments.html`. The build step copies only public website files into `public/`; backend source, package files and environment files are not included in the website output.

## Payment plans

The server controls the price and plan name for every order:

| Plan | Amount |
|---|---:|
| Monthly Membership | ₹2,500 |
| 3-Month Membership | ₹6,500 |
| 6-Month Membership | ₹12,000 |
| Yearly Membership | ₹18,000 |
| Complete Yoga & Fitness Course | ₹25,000 |

Amounts are sent to Razorpay in paise. The browser cannot supply or override the amount. The server verifies the Razorpay signature and fetches the payment to confirm that it is captured for the expected order, amount and INR currency before storing a successful status.

## Configure Neon and Razorpay

1. Copy `.env.example` to `.env.local`. Set `DATABASE_URL` to the Neon connection string and URL-encode any reserved characters in its password. Use the SSL parameters provided by Neon.
2. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` from the same Razorpay **Test Mode** key pair. The browser receives the public Key ID only; the secret remains server-side.
3. Run `npm run db:init` once to connect and create `payment_orders`. To check the connection without changing the schema, run `node -e "require('dotenv').config({path:'.env.local'}); const {Pool}=require('pg'); const pool=new Pool({connectionString:process.env.DATABASE_URL}); pool.query('SELECT 1').then(()=>console.log('connected')).catch(e=>{console.error(e.code);process.exitCode=1}).finally(()=>pool.end())"` from the project root.
4. Run `npm test` and `npm run build`. To test the API locally, start the server and use the plan buttons. Automated tests use a PostgreSQL emulator and fake Razorpay responses; they do not prove that the configured Neon account or Razorpay credentials work.

## Vercel deployment

The Vercel **Root Directory** is the repository root (`.`). Keep the default Node.js 22 runtime. The configured build command is `npm run build`, with output directory `public`. Vercel serves that directory as static website assets and deploys the separate `api/**` handlers as serverless functions.

Add `DATABASE_URL`, `RAZORPAY_KEY_ID`, and `RAZORPAY_KEY_SECRET` to the Vercel project for the intended environment. Begin with a matching Test Mode key pair. Use the Neon pooled connection string when provided for serverless workloads, confirm its password is current, and redeploy after changing variables. Do not copy secrets into source files or share them in logs. The API logs payment stage and provider/database error codes without logging credentials.

After deployment, check `/api/config` for five plans, `"configured": true`, and `"databaseReady": true`. Then test order creation in Test Mode. A successful browser callback is not itself proof of payment: the result page displays success only after backend verification.

## Security and website behavior

- `api/` exposes only the intended payment operations. The build output contains only the homepage, payment pages, browser scripts, styles and assets.
- `.env`, `.env.local`, dependencies, tests and backend files are not copied into the static deployment.
- Order idempotency is enforced by a transaction-scoped PostgreSQL advisory lock, a unique key and per-process serialization.
- Failed, cancelled, pending, authorized, mismatched and unverified payments are never displayed as successful.
- The homepage contact form continues to prepare a WhatsApp message; it does not store or submit visitor details.
- `bhagath-yoga-fixed/` is an ignored local snapshot and is not the deployment source.
