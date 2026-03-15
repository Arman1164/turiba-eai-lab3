const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.ORCHESTRATOR_PORT || 3000;
const TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS) || 5000;

const SERVICES = {
  payment: process.env.PAYMENT_URL,
  inventory: process.env.INVENTORY_URL,
  shipping: process.env.SHIPPING_URL,
  notification: process.env.NOTIFICATION_URL
};

const IDEMPOTENCY_STORE = '/data/idempotency-store.json';
const SAGA_STORE = '/data/saga-store.json';

function loadData(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) { return {}; }
}

function saveData(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function callService(name, method, url, data, trace) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  try {
    const response = await axios({
      method,
      url,
      data,
      timeout: TIMEOUT
    });
    const finishedAt = new Date().toISOString();
    trace.push({
      step: name,
      status: 'success',
      startedAt,
      finishedAt,
      durationMs: Date.now() - start
    });
    return { success: true, data: response.data };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const isTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout');
    trace.push({
      step: name,
      status: isTimeout ? 'timeout' : 'failed',
      startedAt,
      finishedAt,
      durationMs: Date.now() - start
    });
    return { success: false, timeout: isTimeout, status: error.response?.status || 500, data: error.response?.data };
  }
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/checkout', async (req, res) => {
  const key = req.header('Idempotency-Key');
  const payload = req.body;
  if (!key) return res.status(400).json({ error: 'Missing Idempotency-Key' });

  const idStore = loadData(IDEMPOTENCY_STORE);
  if (idStore[key]) {
    const existing = idStore[key];
    if (JSON.stringify(existing.payload) !== JSON.stringify(payload)) {
      return res.status(409).json({ code: 'idempotency_payload_mismatch' });
    }
    if (existing.status === 'in_progress') {
      return res.status(409).json({ code: 'idempotency_conflict' });
    }
    return res.status(existing.httpStatus).json(existing.response);
  }

  const orderId = payload.orderId || `ord-${Date.now()}`;
  idStore[key] = { status: 'in_progress', payload, orderId };
  saveData(IDEMPOTENCY_STORE, idStore);

  const trace = [];
  let finalStatus = 'completed';
  let httpStatus = 200;
  let machineCode = null;

  try {
    const pay = await callService('payment', 'POST', `${SERVICES.payment}/payment/authorize`, { orderId, amount: payload.amount }, trace);
    if (!pay.success) throw { step: 'payment', ...pay };

    const inv = await callService('inventory', 'POST', `${SERVICES.inventory}/inventory/reserve`, { orderId, items: payload.items }, trace);
    if (!inv.success) {
      const comp = await callService('payment-refund', 'POST', `${SERVICES.payment}/payment/refund`, { orderId }, trace);
      if (!comp.success) throw { code: 'compensation_failed', status: 422 };
      throw { step: 'inventory', ...inv };
    }

    const ship = await callService('shipping', 'POST', `${SERVICES.shipping}/shipping/create`, { orderId }, trace);
    if (!ship.success) {
      await callService('inventory-release', 'POST', `${SERVICES.inventory}/inventory/release`, { orderId }, trace);
      await callService('payment-refund', 'POST', `${SERVICES.payment}/payment/refund`, { orderId }, trace);
      throw { step: 'shipping', ...ship };
    }

    const notify = await callService('notification', 'POST', `${SERVICES.notification}/notification/send`, { orderId, recipient: payload.recipient }, trace);
    if (!notify.success) {
      await callService('inventory-release', 'POST', `${SERVICES.inventory}/inventory/release`, { orderId }, trace);
      await callService('payment-refund', 'POST', `${SERVICES.payment}/payment/refund`, { orderId }, trace);
      throw { step: 'notification', ...notify };
    }
  } catch (err) {
    finalStatus = err.step === 'payment' ? 'failed' : 'compensated';
    httpStatus = err.timeout ? 504 : 422;
    machineCode = err.timeout ? 'timeout' : (err.code || err.data?.code || 'downstream_error');
  }

  const responseBody = { orderId, status: finalStatus, ...(machineCode && { code: machineCode }), trace };
  idStore[key] = { status: 'finished', payload, httpStatus, response: responseBody };
  saveData(IDEMPOTENCY_STORE, idStore);
  
  const sagaStore = loadData(SAGA_STORE);
  sagaStore[orderId] = { idempotencyKey: key, state: finalStatus, steps: trace, updatedAt: new Date().toISOString() };
  saveData(SAGA_STORE, sagaStore);

  return res.status(httpStatus).json(responseBody);
});

app.listen(PORT, () => console.log(`Orchestrator running on port ${PORT}`));