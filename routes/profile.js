import express from 'express';
import { dbGet, dbRun } from '../database.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Get profile & user info Endpoint
router.get('/', authenticateToken, async (req, res) => {
  try {
    const user = await dbGet('SELECT name, email FROM users WHERE id = ?', [req.user.id]);
    const profile = await dbGet(
      'SELECT broker, style, starting_capital, daily_loss_limit, daily_profit_target, daily_loss_type FROM profiles WHERE user_id = ?',
      [req.user.id]
    );

    if (!profile) {
      await dbRun(
        'INSERT INTO profiles (user_id, broker, style, starting_capital, daily_loss_limit, daily_profit_target, daily_loss_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [req.user.id, '', '', 0.0, 0.0, 0.0, 'usd']
      );
      return res.json({
        name: user?.name || '',
        email: user?.email || '',
        broker: '',
        style: '',
        startingCapital: 0.0,
        dailyLossLimit: 0.0,
        dailyProfitTarget: 0.0,
        dailyLossType: 'usd'
      });
    }

    return res.json({
      name: user?.name || '',
      email: user?.email || '',
      broker: profile.broker || '',
      style: profile.style || '',
      startingCapital: profile.starting_capital || 0.0,
      dailyLossLimit: profile.daily_loss_limit || 0.0,
      dailyProfitTarget: profile.daily_profit_target || 0.0,
      dailyLossType: profile.daily_loss_type || 'usd'
    });
  } catch (err) {
    console.error('Fetch profile error:', err);
    return res.status(500).json({ error: 'Internal server error fetching profile.' });
  }
});

// Update profile & user info Endpoint
router.post('/', authenticateToken, async (req, res) => {
  const { name, email, broker, style, startingCapital, dailyLossLimit, dailyProfitTarget, dailyLossType } = req.body;

  const parsedCapital = parseFloat(startingCapital);
  const capital = isNaN(parsedCapital) ? 0.0 : Math.max(0, parsedCapital);

  const parsedLoss = parseFloat(dailyLossLimit);
  const lossLimit = isNaN(parsedLoss) ? 0.0 : Math.max(0, parsedLoss);

  const parsedProfit = parseFloat(dailyProfitTarget);
  const profitTarget = isNaN(parsedProfit) ? 0.0 : Math.max(0, parsedProfit);

  const lossType = dailyLossType || 'usd';

  try {
    // 1. Update user table if name or email supplied
    if (name) {
      await dbRun('UPDATE users SET name = ? WHERE id = ?', [name.trim(), req.user.id]);
    }
    if (email) {
      const emailLower = email.trim().toLowerCase();
      // Check for email collision
      const collision = await dbGet('SELECT id FROM users WHERE email = ? AND id != ?', [emailLower, req.user.id]);
      if (collision) {
        return res.status(400).json({ error: 'This email is already in use by another user.' });
      }
      await dbRun('UPDATE users SET email = ? WHERE id = ?', [emailLower, req.user.id]);
    }

    // 2. Update profiles table
    const existing = await dbGet('SELECT user_id, broker, style, starting_capital, daily_loss_limit, daily_profit_target, daily_loss_type FROM profiles WHERE user_id = ?', [req.user.id]);

    const finalBroker = broker !== undefined ? (broker || '') : (existing ? (existing.broker || '') : '');
    const finalStyle = style !== undefined ? (style || '') : (existing ? (existing.style || '') : '');
    
    const finalCapital = startingCapital !== undefined 
      ? (isNaN(parseFloat(startingCapital)) ? 0.0 : Math.max(0, parseFloat(startingCapital)))
      : (existing ? (existing.starting_capital || 0.0) : 0.0);

    const finalLossLimit = dailyLossLimit !== undefined
      ? (isNaN(parseFloat(dailyLossLimit)) ? 0.0 : Math.max(0, parseFloat(dailyLossLimit)))
      : (existing ? (existing.daily_loss_limit || 0.0) : 0.0);

    const finalProfitTarget = dailyProfitTarget !== undefined
      ? (isNaN(parseFloat(dailyProfitTarget)) ? 0.0 : Math.max(0, parseFloat(dailyProfitTarget)))
      : (existing ? (existing.daily_profit_target || 0.0) : 0.0);

    const finalLossType = dailyLossType !== undefined
      ? (dailyLossType || 'usd')
      : (existing ? (existing.daily_loss_type || 'usd') : 'usd');

    if (existing) {
      await dbRun(
        'UPDATE profiles SET broker = ?, style = ?, starting_capital = ?, daily_loss_limit = ?, daily_profit_target = ?, daily_loss_type = ? WHERE user_id = ?',
        [finalBroker, finalStyle, finalCapital, finalLossLimit, finalProfitTarget, finalLossType, req.user.id]
      );
    } else {
      await dbRun(
        'INSERT INTO profiles (user_id, broker, style, starting_capital, daily_loss_limit, daily_profit_target, daily_loss_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [req.user.id, finalBroker, finalStyle, finalCapital, finalLossLimit, finalProfitTarget, finalLossType]
      );
    }

    return res.json({
      message: 'Profile updated successfully.',
      name: name || '',
      email: email || '',
      broker: finalBroker,
      style: finalStyle,
      startingCapital: finalCapital,
      dailyLossLimit: finalLossLimit,
      dailyProfitTarget: finalProfitTarget,
      dailyLossType: finalLossType
    });
  } catch (err) {
    console.error('Update profile error:', err);
    return res.status(500).json({ error: 'Internal server error updating profile.' });
  }
});

export default router;
