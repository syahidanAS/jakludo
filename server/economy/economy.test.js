// Automated tests untuk Dual Currency (Coins + Diamonds), Konversi Coins->Diamonds,
// Duitku Top-Up (Webhook & Idempotency), JakLudo Skin Shop & Equip Sync, serta Admin Economy Dashboard.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playgo-econ-test-'));
process.env.JAKLUDO_DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';

const { io: ioClient } = require('socket.io-client');
const { server, rooms, shutdown } = require('../index');
const db = require('../db');
const doku = require('../lib/doku');
const duitku = require('../lib/duitku');

let url;
const clients = [];

test.before(async () => {
  await new Promise(resolve => server.listen(0, resolve));
  url = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  clients.forEach(c => c.close());
  shutdown();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function registerUser(username) {
  const res = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email: `${username}@playgo.test`, password: 'Rahasia#123', name: username })
  });
  const data = await res.json();
  assert.equal(res.status, 200, `Registrasi ${username} gagal: ${JSON.stringify(data)}`);
  return data;
}

async function apiJson(route, { method = 'GET', token = '', body = undefined, headers: extraHeaders = {} } = {}) {
  const headers = { ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const rawBody =
    body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetch(`${url}${route}`, {
    method,
    headers,
    body: rawBody
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function signCallback({ merchantCode, amount, merchantOrderId, apiKey }) {
  return duitku.md5(`${merchantCode}${amount}${merchantOrderId}${apiKey}`);
}

function connectSocket(token) {
  const c = ioClient(url, {
    forceNew: true,
    transports: ['websocket'],
    auth: token ? { token } : undefined
  });
  clients.push(c);
  return new Promise(resolve => c.on('connect', () => resolve(c)));
}

test('Diamonds & Coins: konversi Diamonds ke Coins ditutup, saldo tidak berubah', async () => {
  const aliceAuth = await registerUser('econ_alice');
  const aliceId = aliceAuth.user.id;
  const aliceToken = aliceAuth.token;

  // Beri Alice 50 Diamonds via konversi Coins -> Diamonds (5.000 Coins -> 50 Diamonds)
  db.awardUserPoints(aliceId, 5000);
  const setupConv = await apiJson('/api/economy/convert', {
    method: 'POST',
    token: aliceToken,
    body: { diamonds: 50, direction: 'coins_to_diamonds', idempotencyKey: 'setup-alice-d' }
  });
  assert.equal(setupConv.status, 200);

  // Semua permintaan Diamonds -> Coins ditolak (dengan atau tanpa direction)
  for (const body of [{ diamonds: 20 }, { diamonds: 20, direction: 'diamonds_to_coins' }]) {
    const r = await apiJson('/api/economy/convert', { method: 'POST', token: aliceToken, body });
    assert.equal(r.status, 403);
    assert.equal(r.data.success, false);
  }

  const wallet = await apiJson('/api/economy/wallet', { token: aliceToken });
  assert.equal(wallet.data.wallet.diamonds, 50, 'Diamonds tidak berkurang');
  assert.equal(wallet.data.wallet.coins, 200, 'Coins tidak bertambah');
});

test('Duitku Diamond Top-Up: verifikasi signature ketat, amount mismatch, order tidak ditemukan, idempotency callback, & status gagal/expired/cancelled', async () => {
  const prevGateway = process.env.PAYMENT_GATEWAY;
  const prevDuitkuCode = process.env.DUITKU_MERCHANT_CODE;
  const prevDuitkuKey = process.env.DUITKU_API_KEY;
  process.env.PAYMENT_GATEWAY = 'duitku';

  const userAuth = await registerUser('econ_duitku');
  const token = userAuth.token;

  const pkgRes = await apiJson('/api/economy/packages', { token });
  assert.equal(pkgRes.status, 200);
  assert.equal(pkgRes.data.gateway, 'duitku');
  assert.equal(pkgRes.data.packages.length >= 4, true);
  assert.equal(Array.isArray(pkgRes.data.paymentMethods) && pkgRes.data.paymentMethods.length > 0, true);
  const popularPkg = pkgRes.data.packages.find(p => p.id === 'pkg_popular');
  assert.equal(popularPkg.diamonds, 25);
  assert.equal(popularPkg.priceIdr, 10000);

  const pmRes = await apiJson('/api/economy/payment-methods?amount=10000');
  assert.equal(pmRes.status, 200);
  assert.deepEqual(
    pmRes.data.methods.map(m => m.code),
    ['SP', 'M2', 'BC', 'I1', 'SA', 'DA']
  );

  // Pastikan DUITKU_* kosong saat create agar tidak melakukan panggilan jaringan keluar pada test
  delete process.env.DUITKU_MERCHANT_CODE;
  delete process.env.DUITKU_API_KEY;

  const createRes = await apiJson('/api/economy/topup/create', {
    method: 'POST',
    token,
    body: { packageId: 'pkg_popular', paymentMethod: 'SP', amountIdr: 1, diamonds: 99999 }
  });
  assert.equal(createRes.status, 200);
  const order = createRes.data.order;
  const inv = createRes.data.invoice;
  assert.equal(order.gateway, 'duitku');
  assert.equal(order.status, 'PENDING');
  assert.equal(order.amountIdr, 10000);
  assert.equal(order.totalDiamonds, 25);
  assert.equal(inv.popJsUrl, undefined);
  assert.equal(inv.paymentMethod, 'SP');
  assert.ok(inv.qrString);
  assert.ok(inv.qrCodeUrl);

  const vaRes = await apiJson('/api/economy/topup/create', {
    method: 'POST',
    token,
    body: { packageId: 'pkg_starter', paymentMethod: 'BC' }
  });
  assert.equal(vaRes.status, 200);
  assert.equal(vaRes.data.invoice.paymentMethod, 'BC');
  assert.ok(vaRes.data.invoice.vaNumber);

  // Aktifkan kunci Duitku untuk menguji verifikasi signature kriptografi MD5 sungguhan pada webhook
  const MERCHANT = 'DTEST99';
  const API_KEY = 'secret_key_for_duitku_test';
  process.env.DUITKU_MERCHANT_CODE = MERCHANT;
  process.env.DUITKU_API_KEY = API_KEY;

  try {
    // 1. Tolak signature tidak valid
    const badSig = await apiJson('/api/economy/topup/callback', {
      method: 'POST',
      body: {
        merchantCode: MERCHANT,
        amount: '10000',
        merchantOrderId: order.id,
        resultCode: '00',
        signature: 'deadbeef0000'
      }
    });
    assert.equal(badSig.status, 400);

    // 2. Tolak merchantCode salah meskipun signature dihitung pakai merchant palsu
    const wrongMerchant = await apiJson('/api/economy/topup/callback', {
      method: 'POST',
      body: {
        merchantCode: 'DWRONG',
        amount: '10000',
        merchantOrderId: order.id,
        resultCode: '00',
        signature: signCallback({ merchantCode: 'DWRONG', amount: '10000', merchantOrderId: order.id, apiKey: API_KEY })
      }
    });
    assert.equal(wrongMerchant.status, 400);

    // 3. Tolak nominal tidak sesuai
    const wrongAmt = await apiJson('/api/economy/topup/callback', {
      method: 'POST',
      body: {
        merchantCode: MERCHANT,
        amount: '5000',
        merchantOrderId: order.id,
        resultCode: '00',
        signature: signCallback({ merchantCode: MERCHANT, amount: '5000', merchantOrderId: order.id, apiKey: API_KEY })
      }
    });
    assert.equal(wrongAmt.status, 400);

    // 4. Tolak order tidak dikenal (404)
    const unknownOrd = await apiJson('/api/economy/topup/callback', {
      method: 'POST',
      body: {
        merchantCode: MERCHANT,
        amount: '10000',
        merchantOrderId: 'PGD_UNKNOWN_999',
        resultCode: '00',
        signature: signCallback({ merchantCode: MERCHANT, amount: '10000', merchantOrderId: 'PGD_UNKNOWN_999', apiKey: API_KEY })
      }
    });
    assert.equal(unknownOrd.status, 404);

    // 5. Status PENDING (01) tidak mengkredit Diamonds
    const pendCb = await apiJson('/api/economy/topup/callback', {
      method: 'POST',
      body: {
        merchantCode: MERCHANT,
        amount: '10000',
        merchantOrderId: order.id,
        resultCode: '01',
        signature: signCallback({ merchantCode: MERCHANT, amount: '10000', merchantOrderId: order.id, apiKey: API_KEY })
      }
    });
    assert.equal(pendCb.status, 200);
    assert.equal(pendCb.data.status, 'PENDING');
    let w = await apiJson('/api/economy/wallet', { token });
    assert.equal(w.data.wallet.diamonds, 0);

    // 6. Callback PAID valid (00) mengkredit Diamonds sekali, replay duplikat bersifat idempoten
    const validPayload = {
      merchantCode: MERCHANT,
      amount: '10000',
      merchantOrderId: order.id,
      resultCode: '00',
      reference: 'DUITKU_REF_OK_1',
      signature: signCallback({ merchantCode: MERCHANT, amount: '10000', merchantOrderId: order.id, apiKey: API_KEY })
    };
    const [cb1, cb2, cb3] = await Promise.all([
      apiJson('/api/economy/topup/callback', { method: 'POST', body: validPayload }),
      apiJson('/api/economy/topup/callback', { method: 'POST', body: validPayload }),
      apiJson('/api/economy/topup/callback', { method: 'POST', body: validPayload })
    ]);
    assert.equal(cb1.status, 200);
    assert.equal(cb2.status, 200);
    assert.equal(cb3.status, 200);

    w = await apiJson('/api/economy/wallet', { token });
    assert.equal(w.data.wallet.diamonds, 25);
    assert.equal(w.data.wallet.totalPurchased, 25);

    // 7. Uji order FAILED, EXPIRED, CANCELLED tidak mengkredit Diamonds
    delete process.env.DUITKU_MERCHANT_CODE;
    delete process.env.DUITKU_API_KEY;
    const ordFail = (await apiJson('/api/economy/topup/create', { method: 'POST', token, body: { packageId: 'pkg_starter' } })).data.order;
    const ordExp = (await apiJson('/api/economy/topup/create', { method: 'POST', token, body: { packageId: 'pkg_starter' } })).data.order;
    const ordCancel = (await apiJson('/api/economy/topup/create', { method: 'POST', token, body: { packageId: 'pkg_starter' } })).data.order;
    process.env.DUITKU_MERCHANT_CODE = MERCHANT;
    process.env.DUITKU_API_KEY = API_KEY;

    const failCb = await apiJson('/api/economy/topup/callback', {
      method: 'POST',
      body: {
        merchantCode: MERCHANT,
        amount: '5000',
        merchantOrderId: ordFail.id,
        resultCode: '02',
        statusMessage: 'FAILED',
        signature: signCallback({ merchantCode: MERCHANT, amount: '5000', merchantOrderId: ordFail.id, apiKey: API_KEY })
      }
    });
    assert.equal(failCb.data.status, 'FAILED');

    const expCb = await apiJson('/api/economy/topup/callback', {
      method: 'POST',
      body: {
        merchantCode: MERCHANT,
        amount: '5000',
        merchantOrderId: ordExp.id,
        resultCode: '02',
        statusMessage: 'EXPIRED',
        signature: signCallback({ merchantCode: MERCHANT, amount: '5000', merchantOrderId: ordExp.id, apiKey: API_KEY })
      }
    });
    assert.equal(expCb.data.status, 'EXPIRED');

    const cancelRes = await apiJson('/api/economy/topup/cancel', {
      method: 'POST',
      token,
      body: { orderId: ordCancel.id }
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.data.order.status, 'CANCELLED');

    // Callback telat '00' untuk order CANCELLED harus diabaikan
    const latePaid = await apiJson('/api/economy/topup/callback', {
      method: 'POST',
      body: {
        merchantCode: MERCHANT,
        amount: '5000',
        merchantOrderId: ordCancel.id,
        resultCode: '00',
        signature: signCallback({ merchantCode: MERCHANT, amount: '5000', merchantOrderId: ordCancel.id, apiKey: API_KEY })
      }
    });
    assert.equal(latePaid.data.ignored, true);

    w = await apiJson('/api/economy/wallet', { token });
    assert.equal(w.data.wallet.diamonds, 25);

    // 8. Delegasi callback /api/topup/notification untuk order PGD_*
    const notifHttpRes = await fetch(`${url}/api/topup/notification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchantCode: MERCHANT,
        amount: String(vaRes.data.order.amountIdr),
        merchantOrderId: vaRes.data.order.id,
        resultCode: '00',
        reference: 'DUITKU_VA_REF_1',
        signature: signCallback({
          merchantCode: MERCHANT,
          amount: String(vaRes.data.order.amountIdr),
          merchantOrderId: vaRes.data.order.id,
          apiKey: API_KEY
        })
      })
    });
    assert.equal(notifHttpRes.status, 200);
    assert.equal(await notifHttpRes.text(), 'OK');
    w = await apiJson('/api/economy/wallet', { token });
    assert.equal(w.data.wallet.diamonds, 35);
  } finally {
    if (prevGateway === undefined) delete process.env.PAYMENT_GATEWAY;
    else process.env.PAYMENT_GATEWAY = prevGateway;
    if (prevDuitkuCode === undefined) delete process.env.DUITKU_MERCHANT_CODE;
    else process.env.DUITKU_MERCHANT_CODE = prevDuitkuCode;
    if (prevDuitkuKey === undefined) delete process.env.DUITKU_API_KEY;
    else process.env.DUITKU_API_KEY = prevDuitkuKey;
  }
});

test('DOKU Diamond Top-Up & Switch Gateway (.env): switch DOKU <-> Duitku, header HMACSHA256 webhook, penolakan signature palsu, & idempotency', async () => {
  const prevEnv = {
    PAYMENT_GATEWAY: process.env.PAYMENT_GATEWAY,
    DOKU_CLIENT_ID: process.env.DOKU_CLIENT_ID,
    DOKU_SECRET_KEY: process.env.DOKU_SECRET_KEY,
    DOKU_MERCHANT_CODE: process.env.DOKU_MERCHANT_CODE
  };

  try {
    process.env.PAYMENT_GATEWAY = 'doku';
    const userAuth = await registerUser('econ_doku');
    const token = userAuth.token;

    // 1. Cek katalog & payment methods untuk gateway DOKU
    const pkgDoku = await apiJson('/api/economy/packages', { token });
    assert.equal(pkgDoku.status, 200);
    assert.equal(pkgDoku.data.gateway, 'doku');
    assert.deepEqual(
      pkgDoku.data.paymentMethods.map(m => m.code),
      ['SP', 'M2', 'BC', 'I1', 'SA', 'DA']
    );

    const pmDoku = await apiJson('/api/economy/payment-methods?amount=10000');
    assert.equal(pmDoku.status, 200);
    assert.equal(pmDoku.data.gateway, 'doku');

    // 2. Uji switch dinamis ke Duitku lalu kembali ke DOKU via env PAYMENT_GATEWAY
    process.env.PAYMENT_GATEWAY = 'duitku';
    const pkgDuitku = await apiJson('/api/economy/packages', { token });
    assert.equal(pkgDuitku.data.gateway, 'duitku');

    process.env.PAYMENT_GATEWAY = 'doku';
    const pkgBack = await apiJson('/api/economy/packages', { token });
    assert.equal(pkgBack.data.gateway, 'doku');

    // 3. Create order QRIS & BCA VA via DOKU
    const qrisRes = await apiJson('/api/economy/topup/create', {
      method: 'POST',
      token,
      body: { packageId: 'pkg_popular', paymentMethod: 'SP' }
    });
    assert.equal(qrisRes.status, 200);
    const qrisOrder = qrisRes.data.order;
    const qrisInv = qrisRes.data.invoice;
    assert.equal(qrisOrder.gateway, 'doku');
    assert.equal(qrisInv.gateway, 'doku');
    assert.match(qrisInv.reference, /^doku_ref_/);
    assert.equal(qrisInv.paymentMethod, 'SP');
    assert.ok(qrisInv.qrString);
    assert.ok(qrisInv.qrCodeUrl);

    const vaRes = await apiJson('/api/economy/topup/create', {
      method: 'POST',
      token,
      body: { packageId: 'pkg_starter', paymentMethod: 'BC' }
    });
    assert.equal(vaRes.status, 200);
    assert.equal(vaRes.data.order.gateway, 'doku');
    assert.equal(vaRes.data.invoice.paymentMethod, 'BC');
    assert.ok(vaRes.data.invoice.vaNumber);

    // 4. Aktifkan Client ID & Secret Key DOKU untuk verifikasi HMACSHA256 webhook resmi Jokul
    const CLIENT_ID = 'BRN-TEST-DOKU-01';
    const SECRET_KEY = 'SK-TEST-DOKU-SECRET';
    process.env.DOKU_CLIENT_ID = CLIENT_ID;
    process.env.DOKU_MERCHANT_CODE = CLIENT_ID;
    process.env.DOKU_SECRET_KEY = SECRET_KEY;

    const signDokuWebhook = ({ payloadObj, targetPath, clientId = CLIENT_ID, secretKey = SECRET_KEY, requestId = 'req-doku-1' }) => {
      const rawBody = JSON.stringify(payloadObj);
      const reqTs = new Date().toISOString().slice(0, 19) + 'Z';
      const digest = doku.generateDigest(rawBody);
      const sig = doku.generateDokuSignature({
        clientId,
        requestId,
        requestTimestamp: reqTs,
        requestTarget: targetPath,
        digest,
        secretKey
      });
      return {
        rawBody,
        headers: {
          'Content-Type': 'application/json',
          'Client-Id': clientId,
          'Request-Id': requestId,
          'Request-Timestamp': reqTs,
          Signature: sig
        }
      };
    };

    const jokulSuccessPayload = {
      order: { invoice_number: qrisOrder.id, amount: 10000 },
      transaction: { status: 'SUCCESS', original_request_id: 'ORIG-DOKU-1' },
      channel: { id: 'QRIS' }
    };

    // 4a. Tolak signature palsu
    const badDokuRes = await apiJson('/api/economy/topup/callback', {
      method: 'POST',
      headers: {
        'Client-Id': CLIENT_ID,
        'Request-Id': 'req-bad-1',
        'Request-Timestamp': new Date().toISOString().slice(0, 19) + 'Z',
        Signature: 'HMACSHA256=invalidsignaturebase64=='
      },
      body: jokulSuccessPayload
    });
    assert.equal(badDokuRes.status, 400);

    // 4b. Tolak Client-Id salah meski ditandatangani
    const wrongClientSigned = signDokuWebhook({
      payloadObj: jokulSuccessPayload,
      targetPath: '/api/economy/topup/callback',
      clientId: 'BRN-ATTACKER',
      requestId: 'req-wrong-client'
    });
    const wrongClientRes = await apiJson('/api/economy/topup/callback', {
      method: 'POST',
      headers: wrongClientSigned.headers,
      body: wrongClientSigned.rawBody
    });
    assert.equal(wrongClientRes.status, 400);

    // 4c. Callback SUCCESS valid (concurrent 3x untuk menguji idempotensi kredit Diamonds)
    const validSigned = signDokuWebhook({
      payloadObj: jokulSuccessPayload,
      targetPath: '/api/economy/topup/callback',
      requestId: 'req-valid-1'
    });
    const [cb1, cb2, cb3] = await Promise.all([
      apiJson('/api/economy/topup/callback', { method: 'POST', headers: validSigned.headers, body: validSigned.rawBody }),
      apiJson('/api/economy/topup/callback', { method: 'POST', headers: validSigned.headers, body: validSigned.rawBody }),
      apiJson('/api/economy/topup/callback', { method: 'POST', headers: validSigned.headers, body: validSigned.rawBody })
    ]);
    assert.equal(cb1.status, 200);
    assert.equal(cb2.status, 200);
    assert.equal(cb3.status, 200);

    let w = await apiJson('/api/economy/wallet', { token });
    assert.equal(w.data.wallet.diamonds, 25);
    assert.equal(w.data.wallet.totalPurchased, 25);

    // 5. Delegasi webhook DOKU via /api/topup/notification untuk order VA (PGD_*)
    const vaPayload = {
      order: { invoice_number: vaRes.data.order.id, amount: 5000 },
      transaction: { status: 'SUCCESS', original_request_id: 'ORIG-DOKU-VA-1' },
      channel: { id: 'VIRTUAL_ACCOUNT_BCA' }
    };
    const vaSigned = signDokuWebhook({
      payloadObj: vaPayload,
      targetPath: '/api/topup/notification',
      requestId: 'req-va-notif-1'
    });
    const notifHttpRes = await fetch(`${url}/api/topup/notification`, {
      method: 'POST',
      headers: vaSigned.headers,
      body: vaSigned.rawBody
    });
    assert.equal(notifHttpRes.status, 200);
    assert.equal(await notifHttpRes.text(), 'OK');

    w = await apiJson('/api/economy/wallet', { token });
    assert.equal(w.data.wallet.diamonds, 35);
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('Midtrans Core API Top-Up: sandbox charge, 8 payment methods, SHA512 webhook verify, dan credit Diamonds', async () => {
  const prevEnv = {
    PAYMENT_GATEWAY: process.env.PAYMENT_GATEWAY,
    MIDTRANS_SERVER_KEY: process.env.MIDTRANS_SERVER_KEY,
    MIDTRANS_CLIENT_KEY: process.env.MIDTRANS_CLIENT_KEY
  };

  process.env.PAYMENT_GATEWAY = 'midtrans';
  process.env.MIDTRANS_SERVER_KEY = 'SB-Mid-server-test-key-123';
  process.env.MIDTRANS_CLIENT_KEY = 'SB-Mid-client-test-key-123';

  try {
    const playerAuth = await registerUser('midtrans_player');
    const token = playerAuth.token;

    // 1. Cek paket & katalog 8 payment methods Midtrans
    const pkgRes = await apiJson('/api/economy/packages', { token });
    assert.equal(pkgRes.status, 200);
    assert.equal(pkgRes.data.gateway, 'midtrans');
    assert.equal(pkgRes.data.paymentMethods.length, 8);

    const codes = pkgRes.data.paymentMethods.map(m => m.code);
    assert.ok(codes.includes('bca_va'));
    assert.ok(codes.includes('bni_va'));
    assert.ok(codes.includes('bri_va'));
    assert.ok(codes.includes('qris'));
    assert.ok(codes.includes('gopay'));
    assert.ok(codes.includes('dana'));
    assert.ok(codes.includes('ovo'));
    assert.ok(codes.includes('shopeepay'));

    // 2. Buat order BCA VA via Core API
    const bcaOrderRes = await apiJson('/api/economy/topup/create', {
      method: 'POST',
      token,
      body: { packageId: 'pkg_starter', paymentMethod: 'bca_va' }
    });
    assert.equal(bcaOrderRes.status, 200);
    assert.equal(bcaOrderRes.data.success, true);
    assert.equal(bcaOrderRes.data.order.gateway, 'midtrans');
    assert.equal(bcaOrderRes.data.order.paymentUrl, null, 'Must NOT use Snap paymentUrl');
    assert.ok(bcaOrderRes.data.order.vaNumber, 'Must have VA number for BCA');

    // 3. Buat order GoPay via Core API
    const gopayOrderRes = await apiJson('/api/economy/topup/create', {
      method: 'POST',
      token,
      body: { packageId: 'pkg_starter', paymentMethod: 'gopay' }
    });
    assert.equal(gopayOrderRes.status, 200);
    assert.ok(gopayOrderRes.data.order.deeplinkUrl, 'Must have deeplinkUrl for GoPay');

    // 4. Webhook Notifikasi Midtrans: SHA512(order_id + status_code + gross_amount + server_key)
    const orderId = bcaOrderRes.data.order.id;
    const grossAmount = `${bcaOrderRes.data.order.amountIdr}.00`;
    const statusCode = '200';
    const serverKey = 'SB-Mid-server-test-key-123';
    const validSignature = crypto
      .createHash('sha512')
      .update(`${orderId}${statusCode}${grossAmount}${serverKey}`)
      .digest('hex');

    // Coba kirim signature palsu -> ditolak 400
    const badSigRes = await fetch(`${url}/api/topup/notification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_id: orderId,
        status_code: statusCode,
        gross_amount: grossAmount,
        signature_key: 'palsu_signature',
        transaction_status: 'settlement'
      })
    });
    assert.equal(badSigRes.status, 400);

    // Kirim signature asli -> diterima 200 & Diamonds dikreditkan
    const validWebhookRes = await fetch(`${url}/api/topup/notification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_id: orderId,
        status_code: statusCode,
        gross_amount: grossAmount,
        signature_key: validSignature,
        transaction_status: 'settlement',
        payment_type: 'bank_transfer',
        transaction_id: 'midtrans_trans_001'
      })
    });
    assert.equal(validWebhookRes.status, 200);

    const walletAfter = await apiJson('/api/economy/wallet', { token });
    assert.equal(walletAfter.data.wallet.diamonds, 10);

    // Idempotency: kirim ulang webhook settlement yang sama tidak menduplikasi kredit
    const duplicateRes = await fetch(`${url}/api/topup/notification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_id: orderId,
        status_code: statusCode,
        gross_amount: grossAmount,
        signature_key: validSignature,
        transaction_status: 'settlement'
      })
    });
    assert.equal(duplicateRes.status, 200);

    const walletDuplicate = await apiJson('/api/economy/wallet', { token });
    assert.equal(walletDuplicate.data.wallet.diamonds, 10);
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('JakLudo Skin Shop & Integrasi Bidak: beli skin, validasi kepemilikan, equip/unequip, dan sinkronisasi live di room JakLudo', async () => {
  const playerAuth = await registerUser('econ_skinner');
  const token = playerAuth.token;

  // Konversi 20 Diamonds dari Coins (2.000 Coins -> 20 Diamonds)
  db.awardUserPoints(playerAuth.user.id, 3000);
  await apiJson('/api/economy/convert', {
    method: 'POST',
    token,
    body: { diamonds: 20, direction: 'coins_to_diamonds' }
  });

  const catalogRes = await apiJson('/api/economy/skins', { token });
  assert.equal(catalogRes.status, 200);
  assert.equal(catalogRes.data.skins.length >= 7, true);

  // Gagal equip skin yang belum dimiliki
  const unownedEquip = await apiJson('/api/economy/skins/equip', {
    method: 'POST',
    token,
    body: { skinId: 'ruby_crystal' }
  });
  assert.equal(unownedEquip.status, 403);

  // Gagal beli Legendary Diamond (50 💎) karena saldo hanya 20 💎
  const tooExpensive = await apiJson('/api/economy/skins/purchase', {
    method: 'POST',
    token,
    body: { skinId: 'legendary_diamond' }
  });
  assert.equal(tooExpensive.status, 400);

  // Beli Ruby Crystal (15 💎) sukses -> sisa 5 💎
  const buyRes = await apiJson('/api/economy/skins/purchase', {
    method: 'POST',
    token,
    body: { skinId: 'ruby_crystal' }
  });
  assert.equal(buyRes.status, 200);
  assert.equal(buyRes.data.wallet.diamonds, 5);
  assert.equal(buyRes.data.skin.owned, true);

  // Beli ulang skin yang sudah dimiliki -> ditolak (409)
  const dupBuy = await apiJson('/api/economy/skins/purchase', {
    method: 'POST',
    token,
    body: { skinId: 'ruby_crystal' }
  });
  assert.equal(dupBuy.status, 409);

  // Equip skin Ruby Crystal -> tersimpan di profil & muncul di room JakLudo saat join
  const eqRes = await apiJson('/api/economy/skins/equip', {
    method: 'POST',
    token,
    body: { skinId: 'ruby_crystal' }
  });
  assert.equal(eqRes.status, 200);
  assert.equal(eqRes.data.equippedSkinId, 'ruby_crystal');

  const socket = await connectSocket(token);
  const joinedPromise = new Promise(resolve => socket.once('room:joined', resolve));
  const updatePromise = new Promise(resolve => socket.once('room:update', resolve));
  socket.emit('room:create', { name: 'Skinner', token });
  const joined = await joinedPromise;
  const firstUpdate = await updatePromise;

  assert.equal(firstUpdate.players[0].equippedSkin?.id, 'ruby_crystal');
  assert.equal(rooms.get(joined.code).players[0].equippedSkin?.id, 'ruby_crystal');

  // Lepas skin saat masih di room -> socket room:update langsung menyinkronkan null
  const unequipUpdatePromise = new Promise(resolve => socket.once('room:update', resolve));
  const uneqRes = await apiJson('/api/economy/skins/equip', {
    method: 'POST',
    token,
    body: { skinId: null }
  });
  assert.equal(uneqRes.status, 200);
  const afterUneqUpdate = await unequipUpdatePromise;
  assert.equal(afterUneqUpdate.players[0].equippedSkin, null);
});

test('Admin Economy Dashboard & Keamanan: RBAC, kurs dinamis, CRUD paket/skin, & audit adjustment', async () => {
  const regularAuth = await registerUser('econ_regular_user');
  const adminAuth = await registerUser('econ_admin_user');
  await db.setUserRole(adminAuth.user.id, 'admin');

  // Non-admin dan unauthenticated wajib ditolak
  const unauthAdmin = await apiJson('/api/admin/economy/overview');
  assert.equal(unauthAdmin.status, 401);
  const forbiddenAdmin = await apiJson('/api/admin/economy/overview', { token: regularAuth.token });
  assert.equal(forbiddenAdmin.status, 403);

  // Admin dapat melihat overview
  const adminOverview = await apiJson('/api/admin/economy/overview', { token: adminAuth.token });
  assert.equal(adminOverview.status, 200);
  assert.ok(adminOverview.data.summary);

  // Admin mengubah kurs menjadi 50 Coins = 1 Diamond, min 5, max 25
  const updSettings = await apiJson('/api/admin/economy/settings', {
    method: 'PUT',
    token: adminAuth.token,
    body: { coinsPerDiamond: 50, minConvertDiamonds: 5, maxConvertDiamonds: 25, conversionEnabled: true }
  });
  assert.equal(updSettings.status, 200);
  assert.equal(updSettings.data.settings.coinsPerDiamond, 50);

  // Beri pemain reguler 10 Diamonds lewat admin adjustment lalu uji konversi 5 Diamonds -> +250 Coins (kurs 50)
  const seedAdj = await apiJson('/api/admin/economy/wallets/adjust', {
    method: 'POST',
    token: adminAuth.token,
    body: { userId: regularAuth.user.id, amount: 10, txType: 'ADMIN_ADJUSTMENT', reason: 'Modal uji konversi' }
  });
  assert.equal(seedAdj.status, 200);
  // Konversi Diamonds -> Coins sudah ditutup: kurs baru pun tidak bisa dipakai menukar
  const convNewRate = await apiJson('/api/economy/convert', {
    method: 'POST',
    token: regularAuth.token,
    body: { diamonds: 5 }
  });
  assert.equal(convNewRate.status, 403);

  // Admin menambah paket Diamond & mengedit skin Ludo (harga wajib 10–50 Diamonds)
  const addPkg = await apiJson('/api/admin/economy/packages', {
    method: 'POST',
    token: adminAuth.token,
    body: { id: 'pkg_vip', name: 'VIP Promo', diamonds: 80, bonusDiamonds: 10, priceIdr: 35000, badge: 'VIP', isActive: true }
  });
  assert.equal(addPkg.status, 200);
  assert.equal(addPkg.data.package.totalDiamonds, 90);

  const badSkinPrice = await apiJson('/api/admin/economy/skins', {
    method: 'POST',
    token: adminAuth.token,
    body: { name: 'Cheap Illegal', priceDiamonds: 5, rarity: 'Common' }
  });
  assert.equal(badSkinPrice.status, 400);

  const validSkin = await apiJson('/api/admin/economy/skins', {
    method: 'POST',
    token: adminAuth.token,
    body: { id: 'neon_cyber', name: 'Neon Cyber', priceDiamonds: 35, rarity: 'Epic', assetKey: 'galaxy_purple', accentColor: '#06b6d4' }
  });
  assert.equal(validSkin.status, 200);

  // Admin melakukan adjustment saldo & refund dengan alasan wajib
  const noReasonAdj = await apiJson('/api/admin/economy/wallets/adjust', {
    method: 'POST',
    token: adminAuth.token,
    body: { userId: regularAuth.user.id, amount: 20, reason: '' }
  });
  assert.equal(noReasonAdj.status, 400);

  const negTooMuch = await apiJson('/api/admin/economy/wallets/adjust', {
    method: 'POST',
    token: adminAuth.token,
    body: { userId: regularAuth.user.id, amount: -999, reason: 'Uji batas minus' }
  });
  assert.equal(negTooMuch.status, 400);

  const adjOk = await apiJson('/api/admin/economy/wallets/adjust', {
    method: 'POST',
    token: adminAuth.token,
    body: { userId: regularAuth.user.id, amount: 25, txType: 'REFUND', reason: 'Kompensasi maintenance' }
  });
  assert.equal(adjOk.status, 200);
  // 10 (modal) + 25 (refund); konversi 5 Diamonds di atas ditolak karena fitur ditutup
  assert.equal(adjOk.data.wallet.diamonds, 35);

  // Pastikan endpoint lama Coins shop & topup tetap kompatibel
  const legacyItems = await apiJson('/api/shop/items');
  assert.equal(legacyItems.status, 200);
  assert.equal(legacyItems.data.items.length >= 4, true);
  const legacyTopup = await apiJson('/api/topup/config');
  assert.equal(legacyTopup.status, 200);
  assert.equal(legacyTopup.data.packages.length, 6);
});
