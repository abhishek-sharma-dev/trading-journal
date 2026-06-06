const http = require('http');

function postJSON(url, data) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const postData = JSON.stringify(data);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: JSON.parse(body || '{}')
        });
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function getWithCookie(url, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'GET',
      headers: {
        'Cookie': cookie
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          body: JSON.parse(body || '[]')
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const jwt = require('jsonwebtoken');

async function run() {
  try {
    const JWT_SECRET = 'trading-journal-secret-key-123';
    console.log('Generating JWT token directly for user ID 1...');
    const token = jwt.sign({ id: 1, email: 'abhisheksharma10520@gmail.com', name: 'Abhishek Sharma' }, JWT_SECRET, { expiresIn: '7d' });
    const tokenCookie = `token=${token}`;
    console.log('Token Cookie:', tokenCookie);

    console.log('Fetching trades...');
    const tradesRes = await getWithCookie('http://localhost:3000/api/trades', tokenCookie);
    console.log('Trades status:', tradesRes.statusCode);
    console.log('Trades retrieved count:', tradesRes.body.length);
    if (tradesRes.body.length > 0) {
      console.log('First trade:', tradesRes.body[0]);
    }
  } catch (err) {
    console.error('Test run failed:', err);
  }
}

run();
