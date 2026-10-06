// Summarizes the Details screen: title, meta line, facts, audio, seasons/episodes, streams and subtitles.
(() => {
  const main = document.querySelector('main');
  const text = (el) => (el ? el.innerText.replace(/\s+/g, ' ').trim() : null);
  const h1 = main.querySelector('h1');
  const out = {
    title: text(h1),
    meta: text(h1?.previousElementSibling),
    imdb: [...main.querySelectorAll('span, div')].map((e) => e.childElementCount === 0 && /^IMDb\b/.test(e.innerText) ? e.innerText : null).filter(Boolean).slice(0, 3),
    facts: [...main.querySelectorAll('dt')].map((dt) => `${text(dt)}: ${text(dt.nextElementSibling)?.slice(0, 80)}`),
    buttons: [...main.querySelectorAll('button')].map((b) => text(b)).filter((t) => t && t.length < 40).slice(0, 40),
    streams: [...main.querySelectorAll('table tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => text(td)?.slice(0, 70)).join(' | ')),
    streamHead: [...main.querySelectorAll('table thead th')].map((th) => text(th)).join(' | '),
    subtitles: [...main.querySelectorAll('p, div')].map((e) => (e.childElementCount <= 2 && /Subtitles/.test(e.innerText) && e.innerText.length < 400 ? text(e) : null)).filter(Boolean).slice(-1)[0] ?? null,
    seasons: [...main.querySelectorAll('section button')].filter((b) => /^Season \d+$/.test(text(b))).map((b) => `${text(b)}${b.className.includes('bg-screen') || b.getAttribute('aria-pressed') === 'true' ? '*' : ''}`).join(', '),
    episodes: main.querySelectorAll('button[data-nav]').length,
    currentEpisode: text(main.querySelector('button[aria-current=true]')),
    streamsFor: text([...main.querySelectorAll('section')].find((s) => /^STREAMS/i.test(s.innerText))?.querySelector('span.font-mono')),
    errors: [...main.querySelectorAll('[role=alert], .text-red-300, .text-red-400')].map((e) => text(e)).filter(Boolean),
    loading: !!main.querySelector('.skeleton') || /Loading streams|Finding streams|Asking/i.test(main.innerText),
  };
  return out;
})();
