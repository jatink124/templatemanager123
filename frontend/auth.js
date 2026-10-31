(() => {
    async function logout() {
        try {
            const response = await fetch('/api/auth/logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
                credentials: 'same-origin'
            });
            if (!response.ok) throw new Error(`Sign-out failed (${response.status})`);
            window.location.replace('/login.html');
        } catch (error) {
            console.error('Could not sign out:', error);
            window.alert('Could not sign out. Please check your connection and try again.');
        }
    }

    window.CodeMarketAuth = { logout };

    const form = document.getElementById('login-form');
    if (!form) return;

    const errorMessage = document.getElementById('login-error');
    const submitButton = form.querySelector('button[type="submit"]');
    if (new URLSearchParams(window.location.search).get('session') === 'expired') {
        errorMessage.textContent = 'Your sign-in session expired. Please sign in again.';
        errorMessage.hidden = false;
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        errorMessage.hidden = true;
        submitButton.disabled = true;
        submitButton.textContent = 'Signing in...';

        try {
            const response = await fetch('/api/auth/login', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: form.elements.username.value,
                    password: form.elements.password.value
                })
            });
            if (!response.ok) {
                const result = await response.json();
                throw new Error(response.status === 503
                    ? 'Admin authentication is not configured. Set ADMIN_USERNAME, ADMIN_PASSWORD, and SESSION_SECRET on the server.'
                    : (result.error || 'Invalid username or password.'));
            }
            window.location.replace('/dashboard.html');
        } catch (error) {
            errorMessage.textContent = error.message || 'Could not sign in. Check your connection and try again.';
            errorMessage.hidden = false;
            submitButton.disabled = false;
            submitButton.textContent = 'Sign in';
        }
    });
})();
