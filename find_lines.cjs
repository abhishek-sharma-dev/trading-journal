const fs = require('fs');
const lines = fs.readFileSync('public/dashboard.html', 'utf8').split('\n');
lines.forEach((l, i) => {
  if (l.includes('id="profileBroker"') || l.includes('id="profileStyle"')) {
    console.log(i, l.trim());
  }
});
