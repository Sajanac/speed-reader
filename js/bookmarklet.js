// Builds the "Speed Read" bookmarklet. Tapped on any page, it copies the page
// as you currently see it (so logged-in and paywalled pages work), opens the
// reader in a new tab, and hands the page over with postMessage. The reader
// then extracts the article with Readability.
//
// If the site blocks the hand-off (for example with a strict
// Cross-Origin-Opener-Policy), a banner offers to copy the article text so it
// can be pasted into the reader instead.

function source(appUrl) {
  return `(function(){
var A=${JSON.stringify(appUrl)},O=new URL(A).origin;
if(location.origin===O){alert('Open an article first, then tap this bookmark.');return;}
var c=document.documentElement.cloneNode(true);
c.querySelectorAll('script,style,noscript,iframe,svg,template,link,video,audio,canvas,object,embed').forEach(function(n){n.remove();});
var P={type:'rsvp-import',url:location.href,title:document.title,html:'<!doctype html>'+c.outerHTML};
var w=window.open(A+'#import','_blank'),ok=false;
function M(e){if(e.origin!==O||!e.data)return;
if(e.data.type==='rsvp-ready'){ok=true;e.source.postMessage(P,O);}
if(e.data.type==='rsvp-received')window.removeEventListener('message',M);}
window.addEventListener('message',M);
function B(){if(ok)return;
var h=document.createElement('div'),s=h.attachShadow({mode:'open'});
h.style.cssText='position:fixed;top:0;left:0;right:0;z-index:2147483647';
s.innerHTML='<div style="font:15px -apple-system,system-ui,sans-serif;background:#15171a;color:#eee;padding:12px 16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;box-shadow:0 2px 12px #0008"><span id="m" style="flex:1 1 220px">Speed Reader could not receive this page. Copy the article text and paste it into the reader instead.</span><button id="c" style="font:inherit;background:#2ec4b6;color:#000;border:0;border-radius:8px;padding:8px 12px">Copy article text</button><button id="x" style="font:inherit;background:none;color:#aaa;border:0;padding:8px">Close</button></div>';
s.getElementById('x').onclick=function(){h.remove();};
s.getElementById('c').onclick=function(){
var t=(document.querySelector('article')||document.querySelector('main')||document.body).innerText;
function done(){s.getElementById('m').textContent='Copied. Switch to Speed Reader and tap Paste.';}
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(done,F);}else F();
function F(){var a=document.createElement('textarea');a.value=t;a.style.cssText='position:fixed;opacity:0';document.body.appendChild(a);a.select();try{document.execCommand('copy');done();}catch(e){}a.remove();}
};
document.body.appendChild(h);}
if(!w)B();else setTimeout(B,8000);
})();`;
}

export function bookmarkletHref(appUrl) {
  const code = source(appUrl)
    .split('\n')
    .map((l) => l.trim())
    .join('');
  return 'javascript:' + encodeURIComponent(code);
}

// The reader's own URL, without index.html, query or hash.
export function appUrl() {
  const u = new URL(location.href);
  u.hash = '';
  u.search = '';
  u.pathname = u.pathname.replace(/index\.html$/, '');
  return u.href;
}
