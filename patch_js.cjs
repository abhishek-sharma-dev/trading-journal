const fs = require('fs');
let html = fs.readFileSync('public/dashboard.html', 'utf8');

// The best way to prevent addEventListener crashes on missing elements
// is to replace `.addEventListener` with a safe wrapper for the Trade Analysis section.
// But we can also just comment out the specific lines since we know what they are.

html = html.replace("document.getElementById('analysisTradeSelect').addEventListener", "if(document.getElementById('analysisTradeSelect')) document.getElementById('analysisTradeSelect').addEventListener");
html = html.replace("document.getElementById('analysisTimeframe').addEventListener", "if(document.getElementById('analysisTimeframe')) document.getElementById('analysisTimeframe').addEventListener");
html = html.replace("document.getElementById('analysisNotes').addEventListener", "if(document.getElementById('analysisNotes')) document.getElementById('analysisNotes').addEventListener");
html = html.replace("document.getElementById('btnSaveTradeAnalysis').addEventListener", "if(document.getElementById('btnSaveTradeAnalysis')) document.getElementById('btnSaveTradeAnalysis').addEventListener");
html = html.replace("document.getElementById('btnRemoveSetupImage').addEventListener", "if(document.getElementById('btnRemoveSetupImage')) document.getElementById('btnRemoveSetupImage').addEventListener");
html = html.replace("document.getElementById('setupImagePreview').addEventListener", "if(document.getElementById('setupImagePreview')) document.getElementById('setupImagePreview').addEventListener");
html = html.replace("document.getElementById('setupImageUpload').addEventListener", "if(document.getElementById('setupImageUpload')) document.getElementById('setupImageUpload').addEventListener");
html = html.replace("document.getElementById('lightboxClose').addEventListener", "if(document.getElementById('lightboxClose')) document.getElementById('lightboxClose').addEventListener");

// Also there is a click handler for tradesListContainer
html = html.replace("const tradesListContainer = document.getElementById('todayTradesList');\ntradesListContainer.addEventListener", "const tradesListContainer = document.getElementById('todayTradesList');\nif(tradesListContainer) tradesListContainer.addEventListener");

fs.writeFileSync('public/dashboard.html', html, 'utf8');
console.log('Done patching JS event listeners.');
