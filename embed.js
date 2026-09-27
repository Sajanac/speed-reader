/*
 * Speed Reader embed for your own site.
 *
 * Add to any page:
 *   <script src="https://sajanac.github.io/speed-reader/embed.js" defer></script>
 *   <button type="button" data-speed-read>Speed read this article</button>
 *
 * Clicking the button opens the reader in a new tab with the article loaded.
 * The article is taken from the element marked data-speed-read-content, or
 * else the page's <article>, or else <main>.
 */
(function () {
  var script = document.currentScript;
  var READER = new URL('./', script ? script.src : location.href).href;

  function articleElement() {
    return (
      document.querySelector('[data-speed-read-content]') ||
      document.querySelector('article') ||
      document.querySelector('main') ||
      document.body
    );
  }

  function payload() {
    var source = articleElement();
    var h1 = source.querySelector('h1') || document.querySelector('h1');
    var title = (h1 && h1.textContent.trim()) || document.title;
    var doc = document.implementation.createHTMLDocument(title);
    var article = doc.createElement('article');
    article.appendChild(doc.importNode(source, true));
    article
      .querySelectorAll('script,style,noscript,iframe,svg,template,button,form,nav,[data-speed-read],[data-speed-read-skip]')
      .forEach(function (n) {
        n.remove();
      });
    doc.body.appendChild(article);
    return {
      type: 'rsvp-import',
      url: location.href,
      title: title,
      html: '<!doctype html>' + doc.documentElement.outerHTML,
    };
  }

  function open(e) {
    if (e) e.preventDefault();
    var data = payload();
    var win = window.open(READER + '#import', '_blank');
    if (!win) {
      alert('Please allow pop-ups for this site to use Speed Reader.');
      return;
    }
    // Only the tab we opened can answer. Its origin may differ from the
    // script's if the reader's address redirects (e.g. to a custom domain).
    function onMessage(ev) {
      if (ev.source !== win || !ev.data) return;
      if (ev.data.type === 'rsvp-ready') win.postMessage(data, ev.origin);
      if (ev.data.type === 'rsvp-received') window.removeEventListener('message', onMessage);
    }
    window.addEventListener('message', onMessage);
    setTimeout(function () {
      window.removeEventListener('message', onMessage);
    }, 120000);
  }

  document.addEventListener('click', function (e) {
    var target = e.target.closest && e.target.closest('[data-speed-read]');
    if (target) open(e);
  });

  window.SpeedReader = { open: open };
})();
