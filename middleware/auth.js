import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'trading-journal-secret-key-123';

export const authenticateToken = (req, res, next) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Session expired. Please log in again.' });
    }
    req.user = user;
    next();
  });
};
