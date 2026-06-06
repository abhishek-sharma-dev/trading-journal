import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { dbRun, dbGet } from '../database.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'trading-journal-secret-key-123';
const TOKEN_EXPIRY = '7d';

// Signup Endpoint
router.post('/signup', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Please provide name, email, and password.' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
  }

  try {
    // Check if user already exists
    const existingUser = await dbGet('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert user in DB
    const userResult = await dbRun(
      'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
      [name, email, hashedPassword]
    );
    const userId = userResult.id;

    // Create default profile for the user
    await dbRun(
      'INSERT INTO profiles (user_id, broker, style, starting_capital) VALUES (?, ?, ?, ?)',
      [userId, '', '', 0.0]
    );

    // Create JWT Token
    const token = jwt.sign({ id: userId, email, name }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });

    // Set cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    return res.status(201).json({
      message: 'Account created successfully.',
      user: { id: userId, name, email, isPremium: false }
    });
  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ error: 'Internal server error during registration.' });
  }
});

// Login Endpoint
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Please provide both email and password.' });
  }

  try {
    // Find user
    const user = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    // Compare passwords
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    // Create JWT Token
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });

    // Set cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    return res.json({
      message: 'Login successful.',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        isPremium: Boolean(user.is_premium)
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server error during login.' });
  }
});

// Google Login Endpoint (Simulated)
router.post('/google', async (req, res) => {
  const { email, name } = req.body;

  if (!email || !name) {
    return res.status(400).json({ error: 'Please provide Google email and name.' });
  }

  try {
    // Find or create user
    let user = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
    let userId;

    if (!user) {
      // Hash a random placeholder password
      const hashedPassword = await bcrypt.hash(Math.random().toString(36), 10);
      const userResult = await dbRun(
        'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
        [name, email, hashedPassword]
      );
      userId = userResult.id;

      // Create default profile for the user
      await dbRun(
        'INSERT INTO profiles (user_id, broker, style, starting_capital) VALUES (?, ?, ?, ?)',
        [userId, '', '', 0.0]
      );
    } else {
      userId = user.id;
    }

    // Create JWT Token
    const token = jwt.sign({ id: userId, email, name }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });

    // Set cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    return res.json({
      message: 'Google login successful.',
      user: {
        id: userId,
        name,
        email,
        isPremium: user ? Boolean(user.is_premium) : false
      }
    });
  } catch (err) {
    console.error('Google login error:', err);
    return res.status(500).json({ error: 'Internal server error during Google login.' });
  }
});

// Get Current User Endpoint
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await dbGet('SELECT id, name, email, is_premium FROM users WHERE id = ?', [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    return res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      isPremium: Boolean(user.is_premium)
    });
  } catch (err) {
    console.error('Get user error:', err);
    return res.status(500).json({ error: 'Internal server error fetching user.' });
  }
});

// Get Session Status Endpoint (returns 200 OK even if not logged in to prevent console errors)
router.get('/session', async (req, res) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.json({ authenticated: false });
  }

  jwt.verify(token, JWT_SECRET, async (err, decoded) => {
    if (err) {
      return res.json({ authenticated: false });
    }
    try {
      const user = await dbGet('SELECT id, name, email, is_premium FROM users WHERE id = ?', [decoded.id]);
      if (!user) {
        return res.json({ authenticated: false });
      }
      return res.json({
        authenticated: true,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          isPremium: Boolean(user.is_premium)
        }
      });
    } catch (dbErr) {
      console.error('Session user fetch error:', dbErr);
      return res.json({ authenticated: false });
    }
  });
});

// Logout Endpoint
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  return res.json({ message: 'Logged out successfully.' });
});

export default router;
