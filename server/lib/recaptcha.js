// Google reCAPTCHA v3 verification service
// Dokumentasi: https://developers.google.com/recaptcha/docs/v3

function getRecaptchaConfig() {
  const siteKey = (process.env.RECAPTCHA_SITE_KEY || '').trim();
  const secretKey = (process.env.RECAPTCHA_SECRET_KEY || '').trim();
  const minScore = Number(process.env.RECAPTCHA_MIN_SCORE || 0.5);

  return {
    siteKey,
    secretKey,
    minScore: isNaN(minScore) ? 0.5 : minScore,
    isConfigured: Boolean(secretKey)
  };
}

/**
 * Memverifikasi token Google reCAPTCHA v3 ke endpoint siteverify
 * @param {Object} options
 * @param {string} options.token Token yang dihasilkan oleh grecaptcha.execute() di frontend
 * @param {string} [options.expectedAction] Nama aksi (misal: 'login', 'register')
 * @param {string} [options.remoteIp] IP address client
 * @returns {Promise<{success: boolean, score?: number, action?: string, error?: string, bypassed?: boolean}>}
 */
async function verifyRecaptchaToken({ token, expectedAction = '', remoteIp = '' }) {
  const config = getRecaptchaConfig();

  // Jika reCAPTCHA belum dikonfigurasi di .env, loloskan secara aman (mode development)
  if (!config.isConfigured) {
    return { success: true, bypassed: true, score: 1.0 };
  }

  // Khusus mode pengujian otomatis (NODE_ENV=test)
  if (process.env.NODE_ENV === 'test') {
    if (!token || token.startsWith('mock_') || token.startsWith('test_')) {
      return { success: true, bypassed: true, score: 1.0 };
    }
  }

  if (!token || typeof token !== 'string' || !token.trim()) {
    return {
      success: false,
      error: 'Verifikasi keamanan reCAPTCHA tidak ditemukan. Pastikan browser Anda mengizinkan skrip Google.'
    };
  }

  try {
    const params = new URLSearchParams();
    params.append('secret', config.secretKey);
    params.append('response', token.trim());
    if (remoteIp) {
      params.append('remoteip', remoteIp);
    }

    const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    if (!res.ok) {
      console.warn('[RECAPTCHA] Google siteverify returned HTTP', res.status);
      return {
        success: false,
        error: `Gagal menghubungi server verifikasi Google reCAPTCHA (${res.status}).`
      };
    }

    const data = await res.json().catch(() => ({}));

    if (!data.success) {
      const errorCodes = Array.isArray(data['error-codes']) ? data['error-codes'].join(', ') : '';
      console.warn('[RECAPTCHA] Verification failed:', errorCodes || 'unknown reason');
      return {
        success: false,
        error: 'Verifikasi Google reCAPTCHA gagal. Terdeteksi aktivitas bot atau token tidak valid.'
      };
    }

    // Validasi action jika ada
    if (expectedAction && data.action && data.action !== expectedAction) {
      console.warn(`[RECAPTCHA] Action mismatch: expected "${expectedAction}", got "${data.action}"`);
      return {
        success: false,
        error: 'Aksi verifikasi reCAPTCHA tidak sesuai.'
      };
    }

    // Validasi skor (reCAPTCHA v3 mengembalikan score 0.0 - 1.0, 1.0 = human, 0.0 = bot)
    const score = typeof data.score === 'number' ? data.score : 1.0;
    if (score < config.minScore) {
      console.warn(`[RECAPTCHA] Low trust score: ${score} (threshold: ${config.minScore})`);
      return {
        success: false,
        score,
        error: 'Skor keamanan verifikasi reCAPTCHA terlalu rendah. Anda terindikasi sebagai bot.'
      };
    }

    return {
      success: true,
      score,
      action: data.action,
      hostname: data.hostname
    };
  } catch (err) {
    console.error('[RECAPTCHA ERROR]', err.message);
    return {
      success: false,
      error: 'Terjadi kesalahan saat memverifikasi keamanan reCAPTCHA.'
    };
  }
}

module.exports = {
  getRecaptchaConfig,
  verifyRecaptchaToken
};

