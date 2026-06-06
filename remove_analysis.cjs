const fs = require('fs');
let html = fs.readFileSync('public/dashboard.html', 'utf8');

// Remove Nav Item
const navRegex = /<div class="nav-item"[^>]*id="nav-analysis"[\s\S]*?<\/div>\s*<\/div>/;
// Wait, the nav item is:
//     <div class="nav-item" data-page="analysis" id="nav-analysis" title="Trade Analysis">
//       <span class="nav-icon">
//         <i class="fa-solid fa-chart-simple" style="font-size: 14px;"></i>
//       </span>
//       <span>Trade Analysis</span>
//     </div>
const exactNav = `    <div class="nav-item" data-page="analysis" id="nav-analysis" title="Trade Analysis">
      <span class="nav-icon">
        <i class="fa-solid fa-chart-simple" style="font-size: 14px;"></i>
      </span>
      <span>Trade Analysis</span>
    </div>`;
html = html.replace(exactNav, '');

// Remove Page
const pageStart = html.indexOf('<div class="page" id="page-analysis">');
const pageEnd = html.indexOf('<div class="page" id="page-aimentor">');
if (pageStart !== -1 && pageEnd !== -1) {
  html = html.substring(0, pageStart) + html.substring(pageEnd);
}

// Remove lightbox modal
const lightboxStart = html.indexOf('<!-- Lightbox Popup Modal -->');
const lightboxEnd = html.indexOf('</body>');
if (lightboxStart !== -1 && lightboxEnd !== -1) {
  html = html.substring(0, lightboxStart) + html.substring(lightboxEnd);
}

fs.writeFileSync('public/dashboard.html', html, 'utf8');
console.log('Done removing Trade Analysis HTML.');
