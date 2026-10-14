  // ---------- thread workspace ----------

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    try {
      const ta = h('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }
  async function copyOrWarn(text) {
    const ok = await copyText(text);
    if (!ok) showError('Could not copy to the clipboard. Select the text and copy it by hand.');
    return ok;
  }
  function copyBtn(text, what, labelText) {
    const idle = labelText || 'Copy';
    const b = plainBtn(idle, 'small');
    b.setAttribute('aria-label', labelText ? labelText : 'Copy ' + what);
    b.addEventListener('click', async () => {
      const ok = await copyOrWarn(text);
      b.textContent = ok ? 'Copied' : 'Copy failed';
      clearTimeout(b._t);
      b._t = setTimeout(() => { b.textContent = idle; }, 1600);
    });
    return b;
  }

