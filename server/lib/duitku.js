// Integrasi Duitku Payment Gateway (Duitku POP & Callback) untuk Topup Coins / Poin PlayGo
// Dokumentasi: https://docs.duitku.com/api/id/#langkah-awal & https://docs.duitku.com/pop/id/
const crypto = require('crypto');

// 6 Paket Top Up Coins
const DIAMOND_PACKAGES = {
  diamond_50: {
    id: 'diamond_50',
    name: '50 Coins',
    diamonds: 50,
    coins: 50,
    price: 5000,
    formattedPrice: 'Rp 5.000',
    description: 'Paket pemula untuk mencoba item & avatar baru.',
    icon: 'coin'
  },
  diamond_120: {
    id: 'diamond_120',
    name: '120 Coins',
    diamonds: 120,
    coins: 120,
    price: 10000,
    formattedPrice: 'Rp 10.000',
    description: 'Paket hemat paling diminati pemain!',
    badge: 'Populer',
    icon: 'coin'
  },
  diamond_260: {
    id: 'diamond_260',
    name: '260 Coins',
    diamonds: 260,
    coins: 260,
    price: 20000,
    formattedPrice: 'Rp 20.000',
    description: 'Cukup untuk beli dice, emote, dan skin spesial.',
    icon: 'coin'
  },
  diamond_700: {
    id: 'diamond_700',
    name: '700 Coins',
    diamonds: 700,
    coins: 700,
    price: 50000,
    formattedPrice: 'Rp 50.000',
    description: 'Dapatkan 600 + Bonus 100 Coins.',
    badge: 'Bonus 100',
    icon: 'coin'
  },
  diamond_1500: {
    id: 'diamond_1500',
    name: '1.500 Coins',
    diamonds: 1500,
    coins: 1500,
    price: 100000,
    formattedPrice: 'Rp 100.000',
    description: 'Dapatkan 1.250 + Bonus 250 Coins.',
    badge: 'Bonus 250',
    icon: 'coin'
  },
  diamond_3250: {
    id: 'diamond_3250',
    name: '3.250 Coins',
    diamonds: 3250,
    coins: 3250,
    price: 200000,
    formattedPrice: 'Rp 200.000',
    description: 'Paket Sultan! Dapatkan 2.500 + Bonus 750 Coins.',
    badge: 'Bonus 750',
    icon: 'crown'
  }
};

const COIN_PACKAGES = DIAMOND_PACKAGES;

function getDuitkuConfig() {
  const merchantCode = process.env.DUITKU_MERCHANT_CODE || '';
  const apiKey = process.env.DUITKU_API_KEY || '';
  const isProduction =
    process.env.DUITKU_IS_PRODUCTION === 'true' ||
    process.env.DUITKU_IS_PRODUCTION === '1';

  const baseUrl = isProduction
    ? 'https://api-prod.duitku.com/api/merchant'
    : 'https://api-sandbox.duitku.com/api/merchant';

  const popJsUrl = isProduction
    ? 'https://app-prod.duitku.com/lib/js/duitku.js'
    : 'https://app-sandbox.duitku.com/lib/js/duitku.js';

  return {
    merchantCode,
    apiKey,
    isProduction,
    isConfigured: Boolean(merchantCode && apiKey),
    baseUrl,
    createInvoiceUrl: `${baseUrl}/createInvoice`,
    transactionStatusUrl: `${baseUrl}/transactionStatus`,
    popJsUrl,
    callbackUrl: process.env.DUITKU_CALLBACK_URL || '',
    returnUrl: process.env.DUITKU_RETURN_URL || ''
  };
}

// Generate MD5 Hash
function md5(string) {
  return crypto.createHash('md5').update(string).digest('hex');
}

/**
 * Buat transaksi Duitku POP (Create Invoice)
 * Endpoint: /api/merchant/createInvoice
 * Header Signature: sha256(merchantCode + timestamp + apiKey)
 */
async function createInvoice({ orderId, pkg, user, host = '' }) {
  const config = getDuitkuConfig();

  // Mode mock HANYA diizinkan pada unit test otomatis (NODE_ENV=test) jika belum dikonfigurasi
  if (!config.isConfigured) {
    if (process.env.NODE_ENV === 'test') {
      return {
        success: true,
        orderId,
        merchantCode: config.merchantCode || 'DTEST',
        reference: `duitku_ref_${orderId}`,
        paymentUrl: `https://app-sandbox.duitku.com/payment/mock_${orderId}`,
        statusCode: '00',
        statusMessage: 'SUCCESS',
        isSimulation: true,
        popJsUrl: config.popJsUrl
      };
    }
    throw new Error('Sistem pembayaran Duitku belum dikonfigurasi di server. Pastikan DUITKU_MERCHANT_CODE dan DUITKU_API_KEY telah diisi di file .env.');
  }

  const paymentAmount = Number(pkg.price);
  const timestamp = Date.now();
  const signature = crypto
    .createHash('sha256')
    .update(`${config.merchantCode}${timestamp}${config.apiKey}`)
    .digest('hex');

  // Tentukan callback & return URL
  let callbackUrl = config.callbackUrl;
  if (!callbackUrl && host) {
    const proto = host.includes('localhost') ? 'http' : 'https';
    callbackUrl = `${proto}://${host}/api/topup/notification`;
  }
  let returnUrl = config.returnUrl;
  if (!returnUrl && host) {
    const proto = host.includes('localhost') ? 'http' : 'https';
    returnUrl = `${proto}://${host}`;
  }

  const payload = {
    paymentAmount,
    merchantOrderId: orderId,
    productDetails: `${pkg.name} (${pkg.diamonds} Diamonds)`,
    email: user.email || `${user.username || 'player'}@playgo.game`,
    phoneNumber: user.phone || '081234567890',
    customerVaName: (user.name || user.username || 'PlayGo Player').slice(0, 30),
    callbackUrl: callbackUrl || 'https://playgo.game/api/topup/notification',
    returnUrl: returnUrl || 'https://playgo.game',
    expiryPeriod: 1440 // 24 jam
  };

  const res = await fetch(config.createInvoiceUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-duitku-signature': signature,
      'x-duitku-timestamp': String(timestamp),
      'x-duitku-merchantcode': config.merchantCode
    },
    body: JSON.stringify(payload)
  });

  const rawText = await res.text();
  let data = {};
  try {
    data = JSON.parse(rawText);
  } catch {
    data = { statusMessage: rawText };
  }

  if (!res.ok || (data.statusCode && data.statusCode !== '00')) {
    const errorMsg = data.statusMessage || rawText || `Duitku Create Invoice Error (${res.status})`;
    throw new Error(errorMsg);
  }

  return {
    success: true,
    orderId,
    reference: data.reference,
    paymentUrl: data.paymentUrl,
    statusCode: data.statusCode || '00',
    statusMessage: data.statusMessage || 'SUCCESS',
    merchantCode: config.merchantCode,
    popJsUrl: config.popJsUrl,
    grossAmount: pkg.price,
    diamonds: pkg.diamonds,
    status: 'pending'
  };
}

/**
 * Verifikasi signature webhook notifikasi dari Duitku
 * Rumus signature callback: md5(merchantCode + amount + merchantOrderId + apiKey)
 */
function verifyDuitkuCallback(payload) {
  const config = getDuitkuConfig();
  if (!config.apiKey) return true; // jika key belum diisi, allow di mode development

  const { merchantCode, amount, merchantOrderId, signature } = payload || {};
  if (!merchantOrderId || !signature) return false;

  const expectedSignature = md5(`${merchantCode || config.merchantCode}${amount}${merchantOrderId}${config.apiKey}`);
  return signature.toLowerCase() === expectedSignature.toLowerCase();
}

/**
 * Cek status transaksi ke Duitku secara langsung
 * Endpoint: /api/merchant/transactionStatus
 * Signature: md5(merchantCode + merchantOrderId + apiKey)
 */
async function checkDuitkuStatus(orderId) {
  const config = getDuitkuConfig();
  if (!config.isConfigured) return null;

  try {
    const signature = md5(`${config.merchantCode}${orderId}${config.apiKey}`);
    const payload = {
      merchantCode: config.merchantCode,
      merchantOrderId: orderId,
      signature
    };

    const res = await fetch(config.transactionStatusUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data;
  } catch (err) {
    console.error('[DUITKU STATUS CHECK ERROR]', err.message);
    return null;
  }
}

module.exports = {
  DIAMOND_PACKAGES,
  COIN_PACKAGES,
  getDuitkuConfig,
  createInvoice,
  verifyDuitkuCallback,
  checkDuitkuStatus
};

