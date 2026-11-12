// --- Small DOM helpers: HTML escaping, focus trapping, toasts, debounce, reduced motion ---

export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Keeps Tab / Shift+Tab inside an open modal. Returns true if the key was handled.
// Radio groups count once (their checked option): arrow keys move within a group.
const FOCUSABLE = 'button, [href], select, textarea, input:not([type="radio"]), input[type="radio"]:checked, [tabindex]:not([tabindex="-1"])';

export function trapFocus(e, modal) {
    if (e.key !== 'Tab' || !modal) return false;
    const focusable = [...modal.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
    if (focusable.length === 0) return false;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!modal.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
    return true;
}

export function debounce(fn, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

export function showToast(message, duration = 2200) {
    const existing = document.querySelector('.app-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'app-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

export function prefersReducedMotion() {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
