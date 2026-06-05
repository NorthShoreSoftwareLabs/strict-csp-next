// vendor.js — same-origin script loaded via next/script on /third-party.
// This is served from /public so it has src (not inline) and is covered by
// 'self' in script-src. No hash or nonce is needed.
(function () {
  var el = document.getElementById('vendor-result')
  if (el) el.textContent = 'vendor.js loaded and executed successfully'
})()
