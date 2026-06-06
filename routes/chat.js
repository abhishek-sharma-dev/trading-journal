import express from 'express';
import { dbAll, dbGet } from '../database.js';
import { authenticateToken } from '../middleware/auth.js';
import https from 'https';

const router = express.Router();

// Helper to fetch text from Gemini API
const callGeminiAPI = (apiKey, prompt) => {
  return new Promise((resolve, reject) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const payload = JSON.stringify({
      contents: [{
        parts: [{ text: prompt }]
      }]
    });

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.candidates && parsed.candidates[0]?.content?.parts[0]?.text) {
            resolve(parsed.candidates[0].content.parts[0].text);
          } else {
            console.warn('Gemini API returned unexpected format:', data);
            reject(new Error('Invalid Gemini API response format'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', (err) => { reject(err); });
    req.write(payload);
    req.end();
  });
};

// Chat Endpoint
router.post('/', authenticateToken, async (req, res) => {
  const { message, clientTime } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message content is required.' });
  }

  try {
    // 1. Fetch user trades and profile settings
    const trades = await dbAll(
      'SELECT ticket, open_time, close_time, type, symbol, lots, profit, timeframe, notes FROM trades WHERE user_id = ?',
      [req.user.id]
    );

    const profile = await dbGet(
      'SELECT broker, style, starting_capital FROM profiles WHERE user_id = ?',
      [req.user.id]
    );

    const cap = profile?.starting_capital || 0;
    const totalPnl = trades.reduce((sum, t) => sum + t.profit, 0);
    const wins = trades.filter(t => t.profit > 0);
    const losses = trades.filter(t => t.profit <= 0);
    const wr = trades.length ? (wins.length / trades.length * 100).toFixed(1) : '0';

    // Calculate symbol maps
    const symMap = {};
    trades.forEach(t => {
      symMap[t.symbol] = (symMap[t.symbol] || 0) + t.profit;
    });
    const sortedSyms = Object.entries(symMap).sort((a, b) => b[1] - a[1]);
    const bestSym = sortedSyms[0] ? sortedSyms[0][0] : 'N/A';
    const worstSym = sortedSyms[sortedSyms.length - 1] ? sortedSyms[sortedSyms.length - 1][0] : 'N/A';

    // Format the list of trades compactly for context
    // Sort trades by close_time descending (newest first) and limit to 150 for prompt size efficiency
    const sortedTrades = trades.slice().sort((a, b) => new Date(b.close_time) - new Date(a.close_time));
    const recentTradesList = sortedTrades.slice(0, 150);
    
    const formattedTradesList = recentTradesList.map(t => {
      return `Ticket: #${t.ticket} | Symbol: ${t.symbol.toUpperCase()} | Type: ${t.type} | Lots: ${t.lots} | Open: ${t.open_time} | Close: ${t.close_time} | Profit: $${t.profit.toFixed(2)}${t.timeframe ? ` | TF: ${t.timeframe}` : ''}${t.notes ? ` | Notes: ${t.notes}` : ''}`;
    }).join('\n');

    // Parse user local time
    let localTimeStr = 'Not provided';
    if (clientTime) {
      try {
        localTimeStr = new Date(clientTime).toLocaleString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          timeZoneName: 'short'
        });
      } catch (e) {
        localTimeStr = clientTime;
      }
    }

    // Check Gemini API key in env
    const apiKey = process.env.GEMINI_API_KEY;

    if (apiKey) {
      // DYNAMIC MODE: Build a context-rich prompt and query Gemini API
      const contextPrompt = `
You are a highly experienced professional Trading Mentor and Risk Advisor. Your job is to analyze the user's trading statistics and ledger, and answer their questions directly, concisely, and supportively. Format your response in standard Markdown (using **bold** for emphasis, *italics*, bullet points starting with - or *, and numbered lists). Avoid writing raw HTML tags or code blocks.

User Question: "${message}"

User Current Date/Time: ${localTimeStr}

User Current Profile:
- Broker/Account: ${profile?.broker || 'Not set'}
- Trading Style: ${profile?.style || 'Not set'}
- Starting Capital: $${cap.toLocaleString()}

User Trades Summary Statistics:
- Total Trades: ${trades.length}
- Wins: ${wins.length} (${wr}% Win Rate)
- Losses: ${losses.length} (${(100 - parseFloat(wr)).toFixed(1)}% Loss Rate)
- Net Profit/Loss: $${totalPnl.toFixed(2)}
- Best Performing Symbol: ${bestSym} (Net P&L: $${sortedSyms[0] ? sortedSyms[0][1].toFixed(2) : '0.00'})
- Worst Performing Symbol: ${worstSym} (Net P&L: $${sortedSyms[sortedSyms.length - 1] ? sortedSyms[sortedSyms.length - 1][1].toFixed(2) : '0.00'})
- Average Win Size: $${wins.length ? (wins.reduce((s, t) => s + t.profit, 0) / wins.length).toFixed(2) : '0.00'}
- Average Loss Size: $${losses.length ? Math.abs(losses.reduce((s, t) => s + t.profit, 0) / losses.length).toFixed(2) : '0.00'}

User Ledger - Recent Trades (Newest First):
${formattedTradesList || 'No trades recorded in ledger.'}

Provide a direct, practical, and highly specific answer to the user's question. 
If they ask about "today's trades", "recent trades", or "my last trade", look at the Ledger above and identify the trades matching their query based on the close/open timestamps compared to "User Current Date/Time" (${localTimeStr}), and describe them.
Highlight risk control (risk 1-2% max) and psychological discipline. Do not wrap the response in markdown code block markers (e.g. do not use \`\`\`markdown).
`;

      try {
        const aiResponse = await callGeminiAPI(apiKey, contextPrompt);
        return res.json({ response: aiResponse.trim() });
      } catch (geminiErr) {
        console.error('Gemini API call failed, falling back to rule-based engine:', geminiErr);
        // Fall through to rule-based fallback
      }
    }

    // RULE-BASED FALLBACK ENGINE (Local advisor)
    const text = message.toLowerCase();
    let reply = '';

    if (text.includes('win rate') || text.includes('winrate')) {
      reply = `Your current win rate is <strong>${wr}%</strong> (${wins.length}W / ${losses.length}L). ${
        parseFloat(wr) < 40
          ? 'This is quite low. Focus on improving your entry criteria and avoid overtrading.'
          : parseFloat(wr) < 55
          ? 'Decent, but there is room to improve. Try cutting losers faster.'
          : 'Solid win rate! Make sure your risk/reward justifies the occasional losses.'
      }`;
    } else if (text.includes('profit factor')) {
      const grossProfit = wins.reduce((s, t) => s + t.profit, 0);
      const grossLoss = Math.abs(losses.reduce((s, t) => s + t.profit, 0));
      const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : '0.00';
      reply = `Your Profit Factor is <strong>${pf}</strong>. ${
        parseFloat(pf) < 1
          ? '❌ Losing Money — reduce position sizes and review your strategy.'
          : parseFloat(pf) < 1.3
          ? '⚠️ Break-Even — your wins are not covering losses well enough.'
          : parseFloat(pf) < 1.5
          ? '📉 Weak Edge — needs improvement to be profitable long-term.'
          : parseFloat(pf) < 2
          ? 'Solid Target — good performance, keep refining.'
          : parseFloat(pf) <= 2.5
          ? '🏆 Excellent — strong edge in your strategy.'
          : '🚨 Suspicious — verify data accuracy, this is unusually high.'
      }`;
    } else if (text.includes('symbol') || text.includes('pair') || text.includes('uso') || text.includes('xau') || text.includes('btc') || text.includes('eur') || text.includes('gbp')) {
      reply = `By symbol: <strong>${bestSym}</strong> is your best performer (+$${(symMap[bestSym] || 0).toFixed(
        2
      )}), while <strong>${worstSym}</strong> is your worst ($${(symMap[worstSym] || 0).toFixed(
        2
      )}). Consider focusing on what works and reducing exposure to underperforming symbols.`;
    } else if (text.includes('loss') || text.includes('losing') || text.includes('why')) {
      const avgLoss = losses.length ? (losses.reduce((s, t) => s + t.profit, 0) / losses.length).toFixed(2) : '0.00';
      const worst = trades.length ? Math.min(...trades.map(t => t.profit)).toFixed(2) : '0.00';
      reply = `Your average loss is <strong>$${avgLoss}</strong> per trade, with a worst trade of <strong>$${worst}</strong>. Common reasons for losses:<br>1) No stop loss,<br>2) Revenge trading after a loss,<br>3) Trading against the trend,<br>4) Poor risk management. Review your losing trades — are you cutting them quickly or letting them run?`;
    } else if (text.includes('risk') || text.includes('reward') || text.includes('rr') || text.includes('r:r')) {
      const avgWin = wins.length ? wins.reduce((s, t) => s + t.profit, 0) / wins.length : 0;
      const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.profit, 0) / losses.length) : 0;
      const rr = avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : '0.00';
      reply = `Your Risk:Reward ratio is <strong>1:${rr}</strong>. ${
        parseFloat(rr) < 1
          ? '❌ You risk more than you gain. Aim for at least 1:2 — risk $1 to make $2.'
          : parseFloat(rr) < 1.5
          ? '⚠️ Acceptable, but 1:2 or higher is recommended for long-term profitability.'
          : '🏆 Excellent R:R! Your winners are significantly larger than losers.'
      }`;
    } else if (text.includes('capital') || text.includes('return') || text.includes('roi')) {
      const ret = cap ? (totalPnl / cap * 100) : 0;
      reply = cap
        ? `With a starting capital of <strong>$${cap.toLocaleString()}</strong>, your total return is <strong>${
            ret >= 0 ? '+' : ''
          }${ret.toFixed(2)}%</strong>. ${
            Math.abs(ret) < 5
              ? 'Small moves so far. Focus on consistency.'
              : ret > 20
              ? '🏆 Strong returns! Do not get overconfident — protect profits.'
              : '❌ Significant drawdown. Consider reducing size and reviewing strategy.'
          }`
        : 'Set your starting capital in the sidebar to see return % and personalized advice.';
    } else if (text.includes('psychology') || text.includes('emotion') || text.includes('fear') || text.includes('greed') || text.includes('discipline')) {
      reply = `Trading psychology is 80% of success. Key rules:<br>1. <strong>Never revenge trade</strong> — accept the loss and walk away.<br>2. <strong>Pre-define your risk</strong> — know your max loss before entering.<br>3. <strong>Journal every trade</strong> — note emotions, not just P&L.<br>4. <strong>Take breaks</strong> — after 3 consecutive losses, stop for the day.`;
    } else if (text.includes('hello') || text.includes('hi') || text.includes('hey')) {
      reply = `Hey! 👋 Ready to level up your trading? Ask me about your win rate, profit factor, risk/reward, specific symbols, or trading psychology. I can analyze your real trades database dynamically!`;
    } else {
      reply = `Thanks for your question! Based on your live database (${trades.length} trades, net P&L: <strong>$${totalPnl.toFixed(
        2
      )}</strong>):<br>• Win Rate: <strong>${wr}%</strong><br>• Best Asset: <strong>${bestSym}</strong><br>• Worst Asset: <strong>${worstSym}</strong><br><br>Ask me something more specific like "analyze my risk reward" or "which symbol is my worst?"`;
    }

    return res.json({ response: reply });
  } catch (err) {
    console.error('Chat endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error in AI Mentor.' });
  }
});

export default router;
