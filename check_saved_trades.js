import { dbAll } from './database.js';

async function check() {
  try {
    const users = await dbAll('SELECT * FROM users');
    console.log('Users in DB:', users.map(u => ({ id: u.id, name: u.name, email: u.email })));
    
    const count = await dbAll('SELECT count(*) as cnt FROM trades');
    console.log('Number of trades in DB:', count[0].cnt);
    
    const sample = await dbAll('SELECT * FROM trades LIMIT 5');
    console.log('Sample trades:', sample);
  } catch (err) {
    console.error('Error querying database:', err);
  }
}
check();
