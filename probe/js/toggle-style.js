// Reports geometry and computed styles of the first two toggle switches.
[...document.querySelectorAll('button[role=switch]')].slice(0, 2).map((b) => {
  const k = b.querySelector('span');
  const cs = getComputedStyle(k);
  const bs = getComputedStyle(b);
  const br = b.getBoundingClientRect();
  const kr = k.getBoundingClientRect();
  return {
    checked: b.getAttribute('aria-checked'),
    track: [Math.round(br.left), Math.round(br.width)],
    knob: [Math.round(kr.left), Math.round(kr.width)],
    knobClass: k.className,
    left: cs.left,
    translate: cs.translate,
    transform: cs.transform,
    position: cs.position,
    trackPadding: bs.padding,
    trackDisplay: bs.display,
  };
});
