import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environmental variables
dotenv.config();

import { initDatabase } from './database.js';
import authRoutes from './routes/auth.js';
import profileRoutes from './routes/profile.js';
import tradesRoutes from './routes/trades.js';
import chatRoutes from './routes/chat.js';
import paymentRoutes from './routes/payment.js';

// Setup file dirname mapping for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware configurations
app.use(cors({
  origin: true,
  credentials: true
}));

app.use(cookieParser());

// Note: Stripe webhook verification requires the raw request body,
// so we only apply express.json() to non-webhook routes or configure it correctly.
app.use((req, res, next) => {
  if (req.originalUrl === '/api/payment/webhook') {
    next();
  } else {
    express.json({ limit: '10mb' })(req, res, next);
  }
});
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Set up server routes
app.use('/api/auth', authRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/trades', tradesRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/payment', paymentRoutes);

// In-memory cache for news to prevent CORS issues and 429 Rate Limits
let newsCache = null;
let newsCacheTime = 0;
const CACHE_DURATION = 15 * 60 * 1000; // 15 minutes

app.get('/api/forex-news', async (req, res) => {
  const now = Date.now();
  if (newsCache && (now - newsCacheTime < CACHE_DURATION)) {
    return res.json(newsCache);
  }

  try {
    const response = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
    if (!response.ok) {
      throw new Error(`Failed to fetch calendar: ${response.status}`);
    }
    const data = await response.json();
    newsCache = data;
    newsCacheTime = now;
    return res.json(data);
  } catch (error) {
    console.error('Error fetching calendar from faireconomy:', error.message);
    if (newsCache) {
      return res.json(newsCache);
    }
    return res.json({ error: 'Failed to fetch forex news from source', fallback: true });
  }
});

// Root path redirection based on auth cookie
app.get('/', (req, res) => {
  if (req.cookies?.token) {
    res.redirect('/dashboard.html');
  } else {
    res.redirect('/auth.html');
  }
});

// Serve frontend static assets from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Initialize database and start the server
const startServer = async () => {
  try {
    console.log('Initializing database tables...');
    await initDatabase();

    app.listen(PORT, () => {
      console.log(`==================================================`);
      console.log(`Trading Journal Backend Server is running!`);
      console.log(`Server Port: ${PORT}`);
      console.log(`Access URL : http://localhost:${PORT}`);
      console.log(`==================================================`);
    });
  } catch (err) {
    console.error('Fatal error starting the backend server:', err.message);
    process.exit(1);
  }
};

startServer();
