const initializeSnippets = () => {
  const initialize = () => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('.ls-snippet button[data-code]')) {
      if (button.dataset.ready !== undefined) continue
      button.dataset.ready = ''
      button.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText((button.dataset.code ?? '').replace(/\u007f/g, '\n'))
          button.textContent = 'Copied'
        } catch {
          button.textContent = 'Copy failed'
        }
      })
    }
    for (const anchor of document.querySelectorAll<HTMLElement>(
      '.ls-snippet .twoslash-hover, .ls-snippet .twoslash-error-hover',
    )) {
      if (anchor.dataset.ready !== undefined) continue
      anchor.dataset.ready = ''
      const popup = anchor.querySelector<HTMLElement>('.twoslash-popup-container')
      if (popup === null) continue
      // The top layer avoids clipping inside horizontally scrollable code blocks.
      popup.setAttribute('popover', 'manual')
      anchor.tabIndex = 0
      const close = () => {
        if (popup.matches(':popover-open') === true) popup.hidePopover()
      }
      const open = () => {
        popup.showPopover()
        const bounds = anchor.getBoundingClientRect()
        popup.style.left = `${Math.max(8, Math.min(bounds.left, innerWidth - popup.offsetWidth - 8))}px`
        popup.style.top = `${Math.max(8, Math.min(bounds.bottom + 4, innerHeight - popup.offsetHeight - 8))}px`
      }
      anchor.addEventListener('pointerenter', open)
      anchor.addEventListener('pointerleave', (event) => {
        if (!(event.relatedTarget instanceof Node) || popup.contains(event.relatedTarget) === false) close()
      })
      popup.addEventListener('pointerleave', close)
      anchor.addEventListener('focus', open)
      anchor.addEventListener('focusout', (event) => {
        if (!(event.relatedTarget instanceof Node) || popup.contains(event.relatedTarget) === false) close()
      })
      anchor.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') close()
      })
    }
  }
  initialize()
  document.addEventListener('astro:page-load', initialize)
}

export const snippetClientModule = `(${initializeSnippets.toString()})();`
