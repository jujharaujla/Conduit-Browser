'use strict';

(() => {
  const api = window.conduit;
  if (!api) return;

  function install() {
    const bookmark = document.querySelector('#bookmark-checkmyip');
    if (bookmark) bookmark.title = 'Open browserleaks.com/ip';
  }

  document.addEventListener('click', (event) => {
    const bookmark = event.target instanceof Element
      ? event.target.closest('#bookmark-checkmyip')
      : null;
    if (!bookmark) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    api.navigate('https://browserleaks.com/ip');
  }, true);

  document.addEventListener('keydown', (event) => {
    const address = document.querySelector('#address');
    if (event.target !== address || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'a') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    address.select();
  }, true);

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
