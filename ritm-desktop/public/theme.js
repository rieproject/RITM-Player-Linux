// Terapkan tema sebelum render agar tidak berkedip (file terpisah karena CSP melarang skrip inline)
try {
  var saved = localStorage.getItem('ritm-theme');
  var dark = saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', dark);
} catch (e) {}
