
    (() => {
      const section = document.querySelector('.donation-section');
      if (!section) return;
      const status = section.querySelector('.donation-copy-status');

      function legacyCopy(value) {
        const field = document.createElement('textarea');
        field.value = value;
        field.setAttribute('readonly', '');
        field.setAttribute('aria-hidden', 'true');
        field.style.position = 'fixed';
        field.style.top = '0';
        field.style.left = '0';
        field.style.opacity = '0';
        document.body.append(field);
        field.focus();
        field.select();
        field.setSelectionRange(0, value.length);
        let copied = false;
        try {
          copied = document.execCommand('copy');
        } finally {
          field.remove();
        }
        if (!copied) throw new Error('Copy command was rejected');
      }

      async function copyDonationValue(element) {
        const value = element.dataset.copy;
        status.textContent = 'Копирование...';
        try {
          if (window.isSecureContext && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
          } else {
            legacyCopy(value);
          }
        } catch {
          try {
            legacyCopy(value);
          } catch {
            status.textContent = 'Не удалось скопировать. Выделите реквизиты и скопируйте вручную.';
            return;
          }
        }
        status.textContent = value.startsWith('UQCu')
          ? 'USDT (TON): Адрес скопирован.'
          : 'ЮMoney: Номер ЮMoney скопирован.';
      }

      section.addEventListener('click', (event) => {
        const element = event.target.closest('.donation-copy');
        if (element && section.contains(element)) void copyDonationValue(element);
      });
      section.addEventListener('keydown', (event) => {
        const element = event.target.closest('.donation-copy');
        if (element && section.contains(element) && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          void copyDonationValue(element);
        }
      });
    })();
