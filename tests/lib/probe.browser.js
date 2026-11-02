// Выполняется в странице. Прокрутка и покадровое наблюдение за строками ленты.
(() => {
  const JUMP_PX = 2;
  const HOLE_PX = 40;
  const HEADER_PX = 56;

  const rows = () => [...document.querySelectorAll('[data-testid="grid-row"]')];
  // В сетке профиля строка состоит из миниатюр без <section>, и она тоже не пустая.
  const hasContent = row => Boolean(row.querySelector('section, [data-testid="thumb"]'));

  // У обёртки с display: contents нет своего бокса, поэтому берём границы её содержимого.
  const box = row => {
    const rect = row.getBoundingClientRect();
    if (rect.height || !row.firstElementChild) return rect;
    const top = row.firstElementChild.getBoundingClientRect().top;
    const bottom = row.lastElementChild.getBoundingClientRect().bottom;
    return { top, bottom, height: bottom - top };
  };

  const onScreen = () => rows()
    .map(row => ({ row, rect: box(row) }))
    .filter(({ rect }) => rect.height > 0 && rect.bottom > HEADER_PX && rect.top < innerHeight);

  const visiblePart = rect => Math.min(rect.bottom, innerHeight) - Math.max(rect.top, HEADER_PX);

  // Пустое место на экране: строка без карточки, карточка, скрытая стилем, или дыра между строками.
  const blankPx = visible => {
    let blank = 0;
    visible.forEach(({ row, rect }, index) => {
      const hidden = [...row.children].some(child =>
        child.childElementCount && getComputedStyle(child).contentVisibility === 'hidden');
      if (!hasContent(row) || hidden) blank += visiblePart(rect);
      const next = visible[index + 1];
      if (next && row.nextElementSibling === next.row) {
        const hole = next.rect.top - rect.bottom;
        if (hole > HOLE_PX) blank += hole;
      }
    });
    return Math.round(blank);
  };

  const counts = () => ({
    rows: rows().length,
    mounted: rows().filter(hasContent).length,
    doc: document.documentElement.scrollHeight,
    nodes: document.getElementsByTagName('*').length,
    y: Math.round(scrollY),
  });

  window.__dafix = {
    counts,

    // Один шаг прокрутки. Любое движение строк после него сделано не нами и считается скачком.
    step: (dy, settleMs) => new Promise(done => {
      const before = scrollY;
      window.scrollBy({ top: dy, behavior: 'instant' });
      const moved = Math.abs(scrollY - before);
      let previous = new Map(onScreen().map(({ row, rect }) => [row, rect.top]));
      let maxJump = 0;
      let peakBlank = 0;
      let endBlank = 0;
      const started = performance.now();
      const tick = () => {
        const visible = onScreen();
        for (const { row, rect } of visible) {
          if (!previous.has(row)) continue;
          const delta = Math.abs(rect.top - previous.get(row));
          if (delta > JUMP_PX) maxJump = Math.max(maxJump, delta);
        }
        previous = new Map(visible.map(({ row, rect }) => [row, rect.top]));
        endBlank = blankPx(visible);
        peakBlank = Math.max(peakBlank, endBlank);
        if (performance.now() - started < settleMs) requestAnimationFrame(tick);
        else done({ moved: Math.round(moved), maxJump: Math.round(maxJump), peakBlank, endBlank, ...counts() });
      };
      requestAnimationFrame(tick);
    }),

    // Загруженные картинки в строках с одной карточкой должны быть показаны без обрезки.
    layout: () => {
      const images = [...document.querySelectorAll('[data-testid="grid-row"] section:only-child [data-testid="thumb"] img')]
        .filter(image => image.complete && image.naturalWidth);
      const cropped = images.filter(image => {
        const rect = image.getBoundingClientRect();
        return rect.height && Math.abs(rect.height / rect.width - image.naturalHeight / image.naturalWidth) > 0.02;
      });
      // Заглушка аватара без картинки должна остаться размером из инлайн-стиля.
      const avatars = [...document.querySelectorAll('[data-testid="grid-row"] section .user-link [style*="height"]')];
      const stretched = avatars.filter(avatar => {
        const inline = parseFloat(avatar.style.width);
        return inline && avatar.getBoundingClientRect().width > inline + 1;
      });
      return { checked: images.length, cropped: cropped.length, avatars: avatars.length, stretched: stretched.length };
    },

    // Плашка веб-приложения и всё, что ещё закреплено у нижнего края экрана.
    bottomBar: () => {
      const covering = [...document.querySelectorAll('body *')].filter(element => {
        const style = getComputedStyle(element);
        if (style.position !== 'fixed' && style.position !== 'sticky') return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom >= innerHeight - 1 && rect.top < innerHeight;
      });
      return { rendered: Boolean(document.querySelector('body > aside')), covering: covering.length };
    },
  };
})();
