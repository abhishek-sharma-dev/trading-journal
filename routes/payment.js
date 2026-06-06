import express from 'express';
import Stripe from 'stripe';
import { dbGet, dbRun } from '../database.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const DOMAIN = process.env.DOMAIN || 'http://localhost:3000';

let stripe = null;
if (STRIPE_SECRET_KEY) {
  stripe = new Stripe(STRIPE_SECRET_KEY, {
    apiVersion: '2023-10-16', // Ensure stable API version
  });
  console.log('Stripe configured successfully.');
} else {
  console.log('Stripe key missing. Using simulated payment gateway.');
}

// 1. Create Checkout Session Endpoint
router.post('/create-checkout-session', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Check if user is already premium
    const user = await dbGet('SELECT is_premium FROM users WHERE id = ?', [userId]);
    if (user && user.is_premium) {
      return res.status(400).json({ error: 'You are already a Premium member.' });
    }

    if (stripe) {
      // REAL STRIPE MODE
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: 'Trading Journal Premium Lifetime Upgrade',
                description: 'Unlock unlimited trades database storage and advanced AI mentor analytics.',
              },
              unit_amount: 999, // $9.99
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        client_reference_id: String(userId),
        success_url: `${DOMAIN}/dashboard.html?payment=success`,
        cancel_url: `${DOMAIN}/dashboard.html?payment=cancel`,
      });

      return res.json({ url: session.url });
    } else {
      // MOCK PAY MODE (No stripe key set)
      // Redirect to our custom mock billing page served locally
      const mockCheckoutUrl = `/api/payment/mock-checkout?userId=${userId}`;
      return res.json({ url: mockCheckoutUrl });
    }
  } catch (err) {
    console.error('Checkout session creation error:', err);
    return res.status(500).json({ error: 'Failed to create payment session.' });
  }
});

// 2. Simulated payment page (served dynamically when Stripe is not set up)
router.get('/mock-checkout', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) {
    return res.status(400).send('Missing user parameter.');
  }

  try {
    const user = await dbGet('SELECT name FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).send('User not found.');
    }

    // Serve a simple beautiful glassmorphic simulated checkout interface
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Simulated Payment Sandbox</title>
        <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
        <style>
          body {
            font-family: 'IBM Plex Sans', sans-serif;
            background: #0F0F0E;
            color: #E8E6E1;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
          }
          .card {
            background: #1A1A18;
            border: 1.5px solid #2A2A28;
            border-radius: 16px;
            padding: 3rem;
            max-width: 400px;
            width: 100%;
            text-align: center;
            box-shadow: 0 8px 32px rgba(0,0,0,0.3);
          }
          h2 { margin-top: 0; color: #2DB37D; }
          p { color: #8A8880; line-height: 1.5; font-size: 14px; margin-bottom: 2rem; }
          .price { font-size: 28px; font-weight: 700; color: #E8E6E1; margin: 1rem 0; font-family: monospace; }
          .btn {
            background: #2DB37D;
            color: white;
            border: none;
            padding: 12px 24px;
            font-size: 14px;
            font-weight: 600;
            border-radius: 8px;
            cursor: pointer;
            width: 100%;
            transition: background 0.15s;
          }
          .btn:hover { background: #1A8F68; }
          .btn-cancel {
            background: transparent;
            color: #8A8880;
            border: 1px solid #2A2A28;
            margin-top: 10px;
          }
          .btn-cancel:hover { background: #2A2A28; color: #E8E6E1; }
          .badge {
            background: rgba(45,179,125,0.15);
            color: #2DB37D;
            border: 1px solid rgba(45,179,125,0.3);
            padding: 4px 10px;
            border-radius: 20px;
            font-size: 12px;
            display: inline-block;
            margin-bottom: 1rem;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="badge">SANDBOX SIMULATOR</div>
          <h2>Upgrade to Premium</h2>
          <p>Hi <strong>${user.name}</strong>! Since no Stripe API keys are configured in .env, you are viewing this payment gateway simulation.</p>
          <div class="price">$9.99 USD</div>
          <form action="/api/payment/mock-pay-success" method="POST">
            <input type="hidden" name="userId" value="${userId}">
            <button class="btn" type="submit">Complete Simulated Payment</button>
          </form>
          <button class="btn btn-cancel" onclick="window.location.href='/dashboard.html?payment=cancel'">Cancel and Return</button>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Internal server error.');
  }
});

// 3. Mock payment completion route (sets is_premium = 1 in SQLite)
router.post('/mock-pay-success', async (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).send('Missing user ID.');
  }

  try {
    await dbRun('UPDATE users SET is_premium = 1 WHERE id = ?', [userId]);
    console.log(`User ID ${userId} upgraded to Premium via sandbox simulation.`);
    res.redirect('/dashboard.html?payment=success');
  } catch (err) {
    console.error('Mock payment error:', err);
    res.status(500).send('Internal server error processing mock payment.');
  }
});

// 4. Stripe Webhook Endpoint (handles real stripe events)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    console.warn('Stripe webhook received but key or webhook secret is not set.');
    return res.status(400).send('Webhook server not active.');
  }

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature validation failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle successful checkout event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id;

    if (userId) {
      try {
        await dbRun('UPDATE users SET is_premium = 1 WHERE id = ?', [userId]);
        console.log(`Stripe Upgrade: User ID ${userId} successfully upgraded to Premium!`);
      } catch (dbErr) {
        console.error('Webhook DB upgrade failure:', dbErr);
        return res.status(500).send('Internal database error');
      }
    } else {
      console.warn('Webhook checkout.session.completed missing client_reference_id.');
    }
  }

  res.json({ received: true });
});

// 5. Get payment status endpoint
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const user = await dbGet('SELECT is_premium FROM users WHERE id = ?', [req.user.id]);
    return res.json({ isPremium: Boolean(user?.is_premium) });
  } catch (err) {
    console.error('Payment status fetch error:', err);
    return res.status(500).json({ error: 'Internal server error checking payment status.' });
  }
});

export default router;
