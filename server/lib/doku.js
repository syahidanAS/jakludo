// Integrasi Doku Payment Gateway (Jokul Direct API & Checkout) untuk Topup Diamonds / Poin PlayGo
const crypto = require('crypto');
const { loadDotEnv } = require('../migrate');

const DIAMOND_PACKAGES = {
  diamond_50: {
    id: 'diamond_50',
    name: '50 Diamond',
    diamonds: 50,
    price: 5000,
    formattedPrice: 'Rp 5.000',
    subtitle: 'Paket pemula',
    description: 'Paket pemula',
    badge: null,
    icon: 'diamond'
  },
  diamond_120: {
    id: 'diamond_120',
    name: '120 Diamond',
    diamonds: 120,
    price: 10000,
    formattedPrice: 'Rp 10.000',
    subtitle: 'Paket hemat',
    description: 'Paket hemat',
    badge: 'Populer',
    icon: 'diamond'
  },
  diamond_260: {
    id: 'diamond_260',
    name: '260 Diamond',
    diamonds: 260,
    price: 20000,
    formattedPrice: 'Rp 20.000',
    subtitle: 'Paket reguler',
    description: 'Paket reguler',
    badge: null,
    icon: 'diamond'
  },
  diamond_700: {
    id: 'diamond_700',
    name: '700 Diamond',
    diamonds: 700,
    price: 50000,
    formattedPrice: 'Rp 50.000',
    subtitle: 'Paket premium',
    description: 'Paket premium',
    badge: 'Bonus 100',
    icon: 'diamond'
  },
  diamond_1500: {
    id: 'diamond_1500',
    name: '1.500 Diamond',
    diamonds: 1500,
    price: 100000,
    formattedPrice: 'Rp 100.000',
    subtitle: 'Paket besar',
    description: 'Paket besar',
    badge: 'Bonus 250',
    icon: 'crown'
  },
  diamond_3250: {
    id: 'diamond_3250',
    name: '3.250 Diamond',
    diamonds: 3250,
    price: 200000,
    formattedPrice: 'Rp 200.000',
    subtitle: 'Paket sultan',
    description: 'Paket sultan',
    badge: 'Bonus 750',
    icon: 'crown'
  }
};

const PAYMENT_METHODS = [
  {
    id: 'qris',
    category: 'qris',
    name: 'QRIS (Semua E-Wallet & M-Banking)',
    description: 'Scan langsung via GoPay, OVO, DANA, ShopeePay, BCA Mobile, Livin, dll.',
    icon: 'qr',
    badge: 'Instan'
  },
  {
    id: 'bca_va',
    category: 'bank_transfer',
    bank: 'bca',
    name: 'BCA Virtual Account',
    description: 'Transfer otomatis 24 jam via BCA Mobile, myBCA, KlikBCA, atau ATM BCA.',
    icon: 'bank',
    badge: 'Populer'
  },
  {
    id: 'mandiri_va',
    category: 'bank_transfer',
    bank: 'mandiri',
    name: 'Mandiri Virtual Account',
    description: 'Transfer via Livin by Mandiri atau ATM Mandiri.',
    icon: 'bank'
  },
  {
    id: 'bni_va',
    category: 'bank_transfer',
    bank: 'bni',
    name: 'BNI Virtual Account',
    description: 'Transfer via BNI Mobile Banking, Internet Banking, atau ATM BNI.',
    icon: 'bank'
  },
  {
    id: 'bri_va',
    category: 'bank_transfer',
    bank: 'bri',
    name: 'BRI Virtual Account (BRIVA)',
    description: 'Transfer via BRImo, Internet Banking BRI, atau ATM BRI.',
    icon: 'bank'
  },
  {
    id: 'permata_va',
    category: 'bank_transfer',
    bank: 'permata',
    name: 'Permata Virtual Account',
    description: 'Transfer via PermataMobile X atau ATM bersama/ALTO/Prima.',
    icon: 'bank'
  },
  {
    id: 'doku_va',
    category: 'bank_transfer',
    bank: 'doku',
    name: 'Doku Virtual Account (Bank Lain)',
    description: 'Transfer via ATM Bersama, ALTO, Prima dari bank mana saja.',
    icon: 'bank'
  },
  {
    id: 'doku_checkout',
    category: 'checkout',
    name: 'Doku Checkout (Semua Metode)',
    description: 'Buka halaman pembayaran resmi Doku lengkap dengan Kartu Kredit & E-Wallet.',
    icon: 'card'
  }
];

function getDokuConfig() {
  loadDotEnv(true);
  const clientId = (process.env.DOKU_CLIENT_ID || '').trim();
  const secretKey = (process.env.DOKU_SECRET_KEY || '').trim();
  const isProduction =
    process.env.DOKU_IS_PRODUCTION === '1' ||
    process.env.DOKU_IS_PRODUCTION === 'true' ||
    (clientId.startsWith('BRN-') && process.env.DOKU_IS_PRODUCTION !== 'false');

  const baseUrl = isProduction
    ? 'https://api.doku.com'
    : 'https://api-sandbox.doku.com';

  return {
    clientId,
    secretKey,
    isProduction,
    isConfigured: Boolean(clientId && secretKey),
    baseUrl
  };
}

// Menghasilkan header otentikasi Doku (HMAC-SHA256 signature & digest)
function generateDokuHeaders({ clientId, secretKey, requestTarget, body, requestId }) {
  const reqId = requestId || `REQ-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
  const timestamp = new Date().toISOString().slice(0, 19) + 'Z';
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body || {});
  const digest = crypto.createHash('sha256').update(rawBody).digest('base64');

  const component = [
    `Client-Id:${clientId}`,
    `Request-Id:${reqId}`,
    `Request-Timestamp:${timestamp}`,
    `Request-Target:${requestTarget}`,
    `Digest:${digest}`
  ].join('\n');

  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(component);
  const signature = `HMACSHA256=${hmac.digest('base64')}`;

  return {
    'Client-Id': clientId,
    'Request-Id': reqId,
    'Request-Timestamp': timestamp,
    'Digest': digest,
    'Signature': signature,
    'Content-Type': 'application/json'
  };
}

// Charge / buat transaksi pembayaran Doku (QRIS, Virtual Account, atau Checkout)
async function chargeTransaction({ orderId, pkg, user, methodId = 'qris' }) {
  const config = getDokuConfig();

  // Mode mock HANYA diizinkan pada unit test otomatis (NODE_ENV=test)
  if (!config.isConfigured) {
    if (process.env.NODE_ENV === 'test') {
      const isVa = methodId.includes('va') || methodId.includes('bill');
      const isCheckout = methodId === 'doku_checkout';
      return {
        success: true,
        orderId,
        transactionId: `doku_mock_tx_${orderId}`,
        paymentType: isCheckout ? 'doku_checkout' : isVa ? 'virtual_account' : 'qris',
        grossAmount: pkg.price,
        status: 'pending',
        isSimulation: true,
        gateway: 'doku',
        checkoutUrl: isCheckout ? `https://sandbox.doku.com/checkout/mock/${orderId}` : null,
        qrCodeUrl: isCheckout ? null : 'https://api-sandbox.doku.com/qris/mock/qr-code.png',
        qrString: isCheckout ? null : '000201010212mockdokuqris',
        vaNumber: isVa ? '8888012345678901' : null,
        bank: isVa ? (methodId.split('_')[0] || 'doku') : null,
        billKey: null,
        billerCode: null,
        expiryTime: new Date(Date.now() + 60 * 60 * 1000).toISOString()
      };
    }
    throw new Error('Sistem pembayaran Doku belum dikonfigurasi di server. Pastikan DOKU_CLIENT_ID dan DOKU_SECRET_KEY telah diisi di file .env.');
  }

  const selectedMethod = PAYMENT_METHODS.find(m => m.id === methodId) || PAYMENT_METHODS[0];

  // Helper untuk membuat sesi Doku Checkout
  async function createDokuCheckoutSession() {
    const requestTarget = '/checkout/v1/payment';
    const payload = {
      order: {
        invoice_number: orderId,
        amount: pkg.price,
        line_items: [
          {
            name: `${pkg.name} (${pkg.diamonds} Diamonds)`,
            price: pkg.price,
            quantity: 1
          }
        ]
      },
      payment: {
        payment_due_date: 60
      },
      customer: {
        id: String(user.id),
        name: user.name || user.username,
        email: user.email || `${user.username}@playgo.game`
      }
    };

    const headers = generateDokuHeaders({
      clientId: config.clientId,
      secretKey: config.secretKey,
      requestTarget,
      body: payload
    });

    const res = await fetch(`${config.baseUrl}${requestTarget}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.response?.payment?.url) {
      const errorMsg = data?.error?.message || data?.message || `Doku Checkout Error (${res.status})`;
      throw new Error(errorMsg);
    }

    return {
      success: true,
      orderId,
      transactionId: data.response?.order?.invoice_number || orderId,
      paymentType: 'doku_checkout',
      methodId: selectedMethod.id,
      methodName: selectedMethod.name,
      grossAmount: pkg.price,
      status: 'pending',
      gateway: 'doku',
      checkoutUrl: data.response.payment.url,
      expiryTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      qrCodeUrl: null,
      qrString: null,
      vaNumber: null,
      bank: null
    };
  }

  // 1. DOKU CHECKOUT & QRIS (Melalui Checkout URL Resmi Doku)
  if (selectedMethod.id === 'doku_checkout' || selectedMethod.id === 'qris') {
    return await createDokuCheckoutSession();
  }

  // 2. DOKU VIRTUAL ACCOUNT DIRECT (BRI VA, Doku VA / Bank Lain)
  const bank = selectedMethod.bank || 'doku';
  const vaPathMap = {
    bri: '/bri-virtual-account/v2/payment-code',
    doku: '/doku-virtual-account/v2/payment-code'
  };

  const targetPath = vaPathMap[bank] || '/doku-virtual-account/v2/payment-code';
  try {
    const payload = {
      order: {
        invoice_number: orderId,
        amount: pkg.price
      },
      virtual_account_info: {
        expired_time: 60,
        reusable_status: false,
        info1: 'PlayGo Diamonds',
        info2: `${pkg.diamonds} Diamonds`
      },
      customer: {
        name: user.name || user.username,
        email: user.email || `${user.username}@playgo.game`
      }
    };

    const headers = generateDokuHeaders({
      clientId: config.clientId,
      secretKey: config.secretKey,
      requestTarget: targetPath,
      body: payload
    });

    const res = await fetch(`${config.baseUrl}${targetPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));
    if (res.ok && data.virtual_account_info?.virtual_account_number) {
      const vaInfo = data.virtual_account_info;
      return {
        success: true,
        orderId,
        transactionId: data.order?.invoice_number || orderId,
        paymentType: 'virtual_account',
        methodId: selectedMethod.id,
        methodName: selectedMethod.name,
        grossAmount: pkg.price,
        status: 'pending',
        gateway: 'doku',
        vaNumber: vaInfo.virtual_account_number,
        bank: bank === 'bri' ? 'bri' : 'doku',
        howToPayPage: vaInfo.how_to_pay_page || null,
        howToPayApi: vaInfo.how_to_pay_api || null,
        expiryTime: vaInfo.expired_date || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        qrCodeUrl: null,
        qrString: null
      };
    }
  } catch (err) {
    console.warn('[DOKU DIRECT VA WARN]', err.message);
  }

  // Fallback ke Doku Checkout session jika direct VA tidak aktif
  return await createDokuCheckoutSession();
}

// Verifikasi signature webhook notifikasi Doku
function verifyDokuSignature({ headers = {}, rawBody, body }) {
  const config = getDokuConfig();
  if (!config.secretKey) return false;

  const clientId = headers['client-id'] || headers['Client-Id'];
  const requestId = headers['request-id'] || headers['Request-Id'];
  const requestTimestamp = headers['request-timestamp'] || headers['Request-Timestamp'];
  const incomingSignature = headers['signature'] || headers['Signature'];
  const requestTarget = headers['request-target'] || headers['Request-Target'] || '/api/topup/notification';

  if (!incomingSignature) return false;

  const bodyStr = typeof rawBody === 'string' ? rawBody : JSON.stringify(body || {});
  const digest = crypto.createHash('sha256').update(bodyStr).digest('base64');
  const digestHeader = `SHA-256=${digest}`;

  const component = [
    `Client-Id:${clientId}`,
    `Request-Id:${requestId}`,
    `Request-Timestamp:${requestTimestamp}`,
    `Request-Target:${requestTarget}`,
    `Digest:${digestHeader}`
  ].join('\n');

  const hmac = crypto.createHmac('sha256', config.secretKey);
  hmac.update(component);
  const expectedSignature = `HMAC256=${hmac.digest('base64')}`;

  return incomingSignature.toLowerCase() === expectedSignature.toLowerCase();
}

// Cek status pesanan ke Doku Status API
async function checkDokuStatus(orderId) {
  const config = getDokuConfig();
  if (!config.isConfigured) return null;

  const requestTarget = `/orders/v1/status/${encodeURIComponent(orderId)}`;
  const headers = generateDokuHeaders({
    clientId: config.clientId,
    secretKey: config.secretKey,
    requestTarget,
    body: {}
  });

  const res = await fetch(`${config.baseUrl}${requestTarget}`, {
    method: 'GET',
    headers: {
      ...headers,
      'Content-Type': 'application/json'
    }
  }).catch(() => null);

  if (!res || !res.ok) return null;
  return await res.json().catch(() => null);
}

module.exports = {
  DIAMOND_PACKAGES,
  PAYMENT_METHODS,
  getDokuConfig,
  generateDokuHeaders,
  chargeTransaction,
  verifyDokuSignature,
  checkDokuStatus
};

