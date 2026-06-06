import express from 'express';
import db, { dbAll, dbRun } from '../database.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Get all trades Endpoint
router.get('/', authenticateToken, async (req, res) => {
  try {
    const trades = await dbAll(
      `SELECT ticket, open_time as open, close_time as close, type, symbol, lots, profit, timeframe, notes, screenshot_url as screenshotUrl 
       FROM trades 
       WHERE user_id = ? 
       ORDER BY close_time DESC`,
      [req.user.id]
    );

    return res.json(trades);
  } catch (err) {
    console.error('Fetch trades error:', err);
    return res.status(500).json({ error: 'Internal server error fetching trades.' });
  }
});

// Upload trades batch Endpoint (JSON payload)
router.post('/upload', authenticateToken, async (req, res) => {
  const { trades } = req.body;

  if (!trades || !Array.isArray(trades)) {
    return res.status(400).json({ error: 'Payload must contain a "trades" array.' });
  }

  if (trades.length === 0) {
    return res.json({ message: 'No trades to upload.', count: 0 });
  }

  try {
    // We run the inserts in an SQL Transaction for speed and atomicity
    await dbRun('BEGIN TRANSACTION');

    const insertSql = `
      INSERT OR IGNORE INTO trades (user_id, ticket, open_time, close_time, type, symbol, lots, profit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, ticket, close_time) DO NOTHING
    `;

    let insertedCount = 0;

    for (const trade of trades) {
      const { ticket, open, close, type, symbol, lots, profit } = trade;

      // Validate required fields
      if (!open || !close || !type || !symbol || profit === undefined) {
        continue; // Skip invalid rows
      }

      const result = await dbRun(insertSql, [
        req.user.id,
        String(ticket),
        open,
        close,
        type.toLowerCase(),
        symbol.toUpperCase(),
        parseFloat(lots) || 0.01,
        parseFloat(profit) || 0.0
      ]);

      // If the row was actually inserted (changes > 0), increment count
      // Note: for SQLite, db.run returns the changes via this.changes (exposed as 'changes' in dbRun helper)
      if (result.changes > 0) {
        insertedCount++;
      }
    }

    await dbRun('COMMIT');

    return res.json({
      message: `Trades processed successfully. Imported ${insertedCount} new trades.`,
      count: insertedCount
    });
  } catch (err) {
    console.error('Upload trades error, rolling back:', err);
    try {
      await dbRun('ROLLBACK');
    } catch (rbErr) {
      console.error('Failed to rollback transaction:', rbErr);
    }
    return res.status(500).json({ error: 'Internal server error processing trades.' });
  }
});

// Clear all trades Endpoint
router.delete('/', authenticateToken, async (req, res) => {
  try {
    const result = await dbRun('DELETE FROM trades WHERE user_id = ?', [req.user.id]);
    return res.json({
      message: 'All trades cleared successfully.',
      count: result.changes
    });
  } catch (err) {
    console.error('Clear trades error:', err);
    return res.status(500).json({ error: 'Internal server error clearing trades.' });
  }
});

// Update a trade's timeframe, notes, and/or screenshot Endpoint
router.put('/:ticket', authenticateToken, async (req, res) => {
  const { ticket } = req.params;
  const { timeframe, notes, screenshotUrl } = req.body;

  try {
    const result = await dbRun(
      `UPDATE trades 
       SET timeframe = ?, notes = ?, screenshot_url = ? 
       WHERE user_id = ? AND ticket = ?`,
      [timeframe || '', notes || '', screenshotUrl || '', req.user.id, ticket]
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Trade not found.' });
    }

    return res.json({ message: 'Trade updated successfully.' });
  } catch (err) {
    console.error('Update trade error:', err);
    return res.status(500).json({ error: 'Internal server error updating trade.' });
  }
});

export default router;
