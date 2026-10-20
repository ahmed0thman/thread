  // ---------- thread workspace ----------

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

